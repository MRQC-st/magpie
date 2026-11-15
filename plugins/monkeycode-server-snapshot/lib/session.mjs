// 会话与续期：**服务器端自主续期**的核心。
//
// 问题的由来：
//   `monkeycode_ai_session` 只有 **7 天**有效期。社区插件没有 `auth.refresh`，
//   凭据是 `plugin login` 那一刻拷进 plugin-auth.json 的**快照**，
//   所以「服务器上的文件更新了」≠「插件生效」。
//
// 本模块的做法（**不需要本机电脑**）：
//   服务器只要有控制台会话 cookie，就能自己在控制台上**铸造一把新的
//   oma_ key + 签名密钥**（POST /api/v1/users/ohmyagent/api-keys）。
//   凭据是账号级的 —— 换一把 key，推理、查额度、签到全都还是这个账号的。
//
// 于是续期链路是：
//   控制台 cookie 有效 → mintApiKey() → 新 key + 新签名密钥 → 写回凭据文件
//   → magpie 的 auth.refresh 收到新凭据，插件立刻生效。
//
// 控制台 cookie 本身只有 7 天，它怎么续？
//   两条路，本模块都会试：
//     ① 账密登录（POST /api/v1/users/password-login）—— 口令存在服务器上，
//        国际版也走这条（官方 UI 的国际版只给邮箱登录）。
//     ② OAuth 桥（百智云账号站 → MonkeyCode）—— 仅国内版，
//        用 `baizhi_session`（30 天）换一个 MonkeyCode 会话。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  consoleFetch,
  fetchStatus,
  fetchWallet,
  mintApiKey,
  deleteApiKey,
  passwordLogin,
  bridgeLogin,
  sessionCookie,
  userIdentity,
} from "./console.mjs"
import {
  readCookieFile,
  cookieValue,
  accountCookieFile,
  sessionFromEnv,
  findAccountCookie,
  isChannelB,
  ACCOUNT_COOKIE,
} from "./credentials.mjs"
import { SESSION_COOKIE } from "./constants.mjs"
import { loadSecret } from "./store.mjs"

// SESSION_TTL_MS 官方云的会话 cookie 有效期：7 天。
// 取 6.5 天当续期后的到期时间 —— 比真实到期早一点，留出余量，
// 这样 magpie 的 refreshLead（24 小时）能提前把它换掉。
export const SESSION_TTL_MS = 6.5 * 24 * 3600 * 1000

// ---- cookie 文件 ------------------------------------------------------------

// writeSessionCookie 把会话 cookie 写回 cookie 文件（**只写服务器副本**）。
//
// ⚠️ 绝不写客户端自己的目录 —— 那会和桌面端抢文件。
export function writeSessionCookie(path, session, { domain = "monkeycode-ai.com", expires } = {}) {
  const items = readCookieFile(path)
  const out = []
  let replaced = false
  const at = expires ?? new Date(Date.now() + SESSION_TTL_MS).toISOString()
  for (const item of items) {
    if (item?.name === SESSION_COOKIE) {
      out.push({ ...item, value: session, expires: at })
      replaced = true
    } else {
      out.push(item)
    }
  }
  if (!replaced) out.push({ name: SESSION_COOKIE, value: session, domain, path: "/", expires: at })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(out, null, 2), { mode: 0o600 })
  return path
}

// readSessionCookie 从 cookie 文件读会话 cookie（过期的当没有）。
//
// ⚠️ `domain` 给了就只认**那个域名**的会话 cookie：国内版与国际版的
//    会话是不同的两套（`monkeycode_ai_session` 在 monkeycode-ai.com 与
//    monkeycode-ai.net 上是两回事），拿错地区的那一个去问控制台只会 401。
export function readSessionCookie(path, { expired = "drop", domain } = {}) {
  const items = readCookieFile(path)
  if (domain) {
    const want = String(domain).toLowerCase()
    const mine = items.filter((it) => {
      const d = String(it?.domain ?? "").toLowerCase()
      return !d || d === want || want.endsWith(d) || d.endsWith(want)
    })
    return cookieValue(mine.length ? mine : items, SESSION_COOKIE, { expired })
  }
  return cookieValue(items, SESSION_COOKIE, { expired })
}

// sessionFor 取这个环境的官方云会话：env 注入的优先，其次 cookie 文件。
export function sessionFor(env = process.env, { domain } = {}) {
  const injected = sessionFromEnv(env, SESSION_COOKIE)
  if (injected) return injected
  const file = String(env.MONKEYCODE_COOKIE_FILE ?? "").trim()
  if (file) return readSessionCookie(file, { domain })
  return ""
}

// ---- 拿一把新会话 ----------------------------------------------------------

// newSession 走账密登录换一个会话 cookie。
export async function newSession(site, identity, secret, { fetchImpl = fetch } = {}) {
  const r = await passwordLogin(site.console, identity.email || secret.email, secret.password, { fetchImpl })
  if (!r.ok) {
    const err = new Error(`账密登录失败：${r.message || `HTTP ${r.http}`}`)
    err.http = r.http
    err.code = r.code
    throw err
  }
  return r.session
}

// newSessionViaBridge 走百智云的 OAuth 桥换会话（仅国内版）。
export async function newSessionViaBridge(site, accountCookieValue, { fetchImpl = fetch } = {}) {
  const r = await bridgeLogin(site.console, site.account, accountCookieValue, { fetchImpl })
  return r.session
}

// ---- 续期主流程 ------------------------------------------------------------

// renewAccount 续一个账号：换会话 → 铸造新 key → 交回 magpie。
//
// 返回 magpie 的 auth.refresh 要的形状：
//   { type?, key, metadata:{ secret, cookie, base, email, uid }, expires }
//
// ⚠️ 返回的 `expires` **必须非 0** —— magpie 把 expires=0 当「永不续期」，
//    那样过期后就静默失效了。
export async function renewAccount(site, { auth, env = process.env, fetchImpl = fetch, log } = {}) {
  const md = auth?.metadata ?? {}
  const email = String(md.email ?? "").trim()
  const uid = String(md.uid ?? "").trim()

  // 1) 先看现有的控制台会话还能不能用 —— 能用就直接换一把 key，最省事。
  //
  //    顺序：账号记录里的 cookie → env 注入的会话 → cookie 文件。
  let session = String(md.cookie ?? "").trim()
  let usedPassword = false

  if (session) {
    try {
      await fetchStatus(site.console, session, { fetchImpl })
    } catch (e) {
      if (e?.status === 401) session = ""
      else log?.("warn", `MonkeyCode 会话检查失败：${e?.message ?? e}`)
    }
  }
  if (!session) {
    // 会话可能只是没记进账号记录（运维手工注入的、cookie 文件里的）。
    // ⚠️ 按**本供应商的地区**找：cookie 文件里国内版与国际版的会话混着，
    //    拿错地区的那一个去问控制台只会 401。
    const domain = hostOf(site.console)
    const fallback = sessionFor(env, { domain })
    if (fallback) {
      try {
        await fetchStatus(site.console, fallback, { fetchImpl })
        session = fallback
      } catch (e) {
        if (e?.status !== 401) log?.("warn", `MonkeyCode 会话检查失败：${e?.message ?? e}`)
      }
    }
  }

  // 2) 会话没了（或压根没有）→ 重新登录。
  if (!session) {
    const secret = loadSecret({ email, uid }, env)
    if (secret?.password) {
      session = await newSession(site, { email }, secret, { fetchImpl })
      usedPassword = true
    } else if (site.id === "monkeycode") {
      // 国内版还有 OAuth 桥这条路：用 30 天的百智云账号会话换一个 MonkeyCode 会话。
      const bzValue = findAccountCookie(env).value
      if (bzValue) {
        session = await newSessionViaBridge(site, bzValue, { fetchImpl })
        usedPassword = false
      }
    }
    if (!session) {
      throw Object.assign(
        new Error(
          "没有可用的会话：控制台 cookie 已过期，且服务器上没有该账号的口令。" +
            "请在 magpie 里重新登录一次（会提示保存口令），之后服务器就能自己续期。",
        ),
        { signIn: "expired" },
      )
    }
  }

  // 3) 会话有了 → 铸造一把新的 oma_ key + 签名密钥。
  const minted = await mintApiKey(site.console, session, { fetchImpl })

  // 4) 落盘：会话写回 cookie 文件（新 key 不落盘 —— 它只在 magpie 的
  //    plugin-auth.json 里，那才是插件实际读的地方）。
  const cookieFile = String(env.MONKEYCODE_COOKIE_FILE ?? "").trim()
  if (cookieFile) {
    try {
      writeSessionCookie(cookieFile, session, { domain: hostOf(site.console) })
    } catch (e) {
      log?.("warn", `MonkeyCode 会话写回失败：${e?.message ?? e}`)
    }
  }

  // 5) 账号身份（给 magpie 用来区分账号 & 显示名字）。
  let identity = { email, uid, name: "" }
  try {
    const st = await fetchStatus(site.console, session, { fetchImpl })
    const u = userIdentity(st)
    identity = { email: u.email || email, uid: u.id || uid, name: u.name }
  } catch {
    /* 拿不到就算了，用原来的 */
  }

  return {
    type: "api",
    key: minted.key,
    metadata: {
      secret: minted.secret,
      cookie: session,
      base: site.proxy,
      email: identity.email,
      uid: identity.uid,
    },
    // 非 0 ⇒ magpie 会在到期前自动调用 refresh
    expires: Date.now() + SESSION_TTL_MS,
    ...(usedPassword ? {} : {}),
  }
}

// hostOf 从控制台基址取出主机名（cookie 的 domain 用）。
export function hostOf(base) {
  try {
    return new URL(String(base)).hostname
  } catch {
    return "monkeycode-ai.com"
  }
}

// ---- 只读凭据：登录时用 -----------------------------------------------------

// localCredentialFor 取一个账号的本地凭据（服务器上的客户端配置目录）。
//
// 返回的形状与 renewAccount 的返回对齐，只是 `key`/`secret` 来自文件。
//
// ⚠️ `site` 给了就**只认那个地区**的条目：客户端的 settings.json 里
//    国内版与国际版的条目混在一个文件里（base_url 不同），不挑就会把
//    国内版的 base_url 配给国际版账号 ⇒ 请求打到别的网关 ⇒ 403/401。
export function localCredentialFor(dir, { env = process.env, site } = {}) {
  const settingsFile = join(dir, "settings.json")
  if (!existsSync(settingsFile)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(settingsFile, "utf8"))
  } catch {
    return null
  }
  const secret = String(raw?.signing_secret ?? "").trim()
  const models = raw?.models && typeof raw.models === "object" ? raw.models : {}
  let bKeys = Object.keys(models).filter((k) => isChannelB(k))
  if (!secret || !bKeys.length) return null
  // ⚠️ 别拿 bKeys[0]：键按字母序排，第一条**未必**是 B 通道
  //    （`monkeycode-basic/…@baizhi` 排在 `…@monkeycode#…` 前面）。
  const entries = bKeys.map((k) => models[k] ?? {})
  const wanted = site ? hostOf(site.proxy) : ""
  const pick = wanted
    ? entries.find((e) => hostOf(e?.base_url) === wanted && String(e?.api_key ?? "").trim())
    : undefined
  const first = pick ?? entries.find((e) => String(e?.api_key ?? "").trim()) ?? {}
  // 给了 site 却没有匹配的条目 ⇒ 这个配置目录不属于这个地区。
  if (site && wanted && hostOf(first?.base_url) !== wanted) return null
  const key = String(first?.api_key ?? "").trim()
  if (!key) return null

  const cookieFile = accountCookieFile(dir, "monkeycode")
  const cookie = sessionFor(env, { domain: wanted ? hostOf(site?.console) : undefined }) ||
    readSessionCookie(cookieFile, { domain: wanted ? hostOf(site?.console) : undefined })

  return {
    type: "api",
    key,
    metadata: {
      secret,
      cookie,
      base: String(first?.base_url ?? "").trim(),
    },
    cookieFile,
    dir,
  }
}

// usageOf 取账号的额度（钱包 + 会员档位）。
export async function usageOf(site, cookie, { fetchImpl = fetch } = {}) {
  if (!cookie) {
    return {
      plan: site.short,
      error: "未保存控制台 Cookie，无法查询积分。重新登录时填写 monkeycode_ai_session。",
      signIn: "kept",
    }
  }
  try {
    const [wallet, sub] = await Promise.all([
      fetchWallet(site.console, cookie, { fetchImpl }),
      consoleFetch(site.console, "/api/v1/users/subscription", { cookie, fetchImpl })
        .then(async (r) => {
          const { payload } = await r.json().then((v) => ({ payload: v })).catch(() => ({ payload: null }))
          return payload?.data ?? {}
        })
        .catch(() => ({})),
    ])
    const { walletToUsage } = await import("./console.mjs")
    const plan = sub?.plan ? String(sub.plan) : ""
    return { ...walletToUsage(wallet, { plan }), signIn: "kept" }
  } catch (e) {
    const expired = e?.status === 401
    return {
      plan: site.short,
      error: expired
        ? "控制台会话已过期：请重新登录 MonkeyCode。"
        : (e?.message ?? String(e)),
      signIn: expired ? "expired" : "kept",
    }
  }
}
