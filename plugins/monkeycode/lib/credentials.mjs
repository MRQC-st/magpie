// 凭据读取层：**只读**，从服务器上的客户端配置目录取凭据。
//
// 为什么读「文件」而不是让用户粘贴：
//   MonkeyCode 官方客户端把凭据明文写在配置里，服务器上有一份拷贝，
//   插件每次请求现读 —— 文件更新了插件就跟上，不存在快照过期的问题。
//
// ⚠️ 只读：**绝不回写**客户端的 settings.json / cookies 文件。
//   上游插件也这么做，写回去会和客户端抢文件。

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

import { SESSION_COOKIE, ACCOUNT_COOKIE } from "./constants.mjs"

// settingsPaths 列出客户端把 settings.json 放在哪。
//
// 服务端（Linux）：~/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json
// 本机（Windows）：%APPDATA%\com.chaitin.baizhi.monkeycode\ohmyagent\settings.json
//
// env MONKEYCODE_CONFIG_DIR 可整体覆盖（测试与运维用）。
export function settingsPaths(env = process.env) {
  const out = []
  const override = String(env.MONKEYCODE_CONFIG_DIR ?? "").trim()
  if (override) out.push(join(override, "settings.json"))

  const home = homedir()
  if (process.platform === "win32") {
    const appData = String(env.APPDATA ?? "").trim()
    if (appData) out.push(join(appData, "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
    const local = String(env.LOCALAPPDATA ?? "").trim()
    if (local) {
      out.push(join(local, "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
      out.push(join(local, "MonkeyCode", "ohmyagent", "settings.json"))
    }
  } else if (process.platform === "darwin") {
    out.push(join(home, "Library", "Application Support", "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
  } else {
    out.push(join(home, ".config", "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
  }
  return out
}

// cookiePaths 列出客户端的 cookie 文件（它们在 ohmyagent 目录的**上一层**）。
export function cookiePaths(env = process.env) {
  const out = []
  for (const p of settingsPaths(env)) {
    out.push(join(dirname(dirname(p)), "monkeycode-cookies.json"))
    out.push(join(dirname(dirname(p)), "baizhi-cookies.json"))
  }
  // env 直接指定（运维最常用）：两个文件各自一个变量
  const mc = String(env.MONKEYCODE_COOKIE_FILE ?? "").trim()
  if (mc) out.unshift(mc)
  const bz = String(env.BAIZHI_COOKIE_FILE ?? "").trim()
  if (bz) out.unshift(bz)
  return [...new Set(out)]
}

// readCookieFile 读一个 cookie 文件，返回 [{name, value, domain, expires}]。
//
// 文件可能是数组，也可能是 {"accounts":[...]}（本仓库的 import 脚本写过这种）。
export function readCookieFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    if (Array.isArray(raw)) return raw
    if (raw && Array.isArray(raw.accounts)) return raw.accounts
    return []
  } catch {
    return []
  }
}

// cookieValue 从 cookie 文件里取一个 cookie 的值。
//
// `expired` 控制过期怎么算：
//   "skip"  —— 过期也返回（我们自己写进去的会话，expires 可能是我们自己填的）
//   "drop"  —— 过期返回空（客户端写的文件，expires 可信）
export function cookieValue(items, name, { expired = "drop", now = Date.now() } = {}) {
  for (const item of items) {
    if (item?.name !== name) continue
    const expires = String(item?.expires ?? "")
    if (expires && expired === "drop") {
      const at = Date.parse(expires)
      if (Number.isFinite(at) && now >= at) return ""
    }
    const value = String(item?.value ?? "").trim()
    if (value) return value
  }
  return ""
}

// sessionFromEnv 从环境变量里取会话（运维手工注入时的后门）。
//
//   MONKEYCODE_SESSION → 官方云的会话 cookie
//   BAIZHI_SESSION    → 百智云（A 通道）的账号会话
//
// 与本仓库的 scripts/baizhi-checkin.py、scripts/monkeycode-login.py 用的是
// 同一套变量名 —— 那些脚本注入的会话，插件直接就能用。
export function sessionFromEnv(env = process.env, name = SESSION_COOKIE) {
  const key =
    name === ACCOUNT_COOKIE ? "BAIZHI_SESSION"
    : name === SESSION_COOKIE ? "MONKEYCODE_SESSION"
    : ""
  if (!key) return ""
  return String(env[key] ?? "").trim()
}

// findCookieFile 找到第一个含指定 cookie 的文件，返回 {path, value}。
export function findCookieFile(name, { env = process.env, expired = "drop" } = {}) {
  for (const file of cookiePaths(env)) {
    if (!existsSync(file)) continue
    const value = cookieValue(readCookieFile(file), name, { expired })
    if (value) return { path: file, value }
  }
  return { path: "", value: "" }
}

// ---- settings.json 的模型表 -------------------------------------------------

// 模型键的形状：`monkeycode-basic/deepseek-flash@monkeycode#<uuid>`
//   —— 客户端给**每个账号**的每个模型生成一个带 uuid 后缀的条目。
// `@baizhi` 后缀的是 A 通道（百智云 SK），`@monkeycode#<uuid>` 的是 B 通道。
//
// 这正是「一个客户端配置里同时躺着多个账号」的证据：
// 25 个 B 通道条目分属 **25 个不同的 uuid**，但共用同一把 api_key。

// accountOf 从模型键里取出账号后缀。
export function accountOf(modelKey) {
  const s = String(modelKey ?? "")
  const at = s.lastIndexOf("@")
  if (at < 0) return ""
  const suffix = s.slice(at + 1)
  const hash = suffix.indexOf("#")
  return hash < 0 ? suffix : suffix.slice(hash + 1)
}

// isChannelB 判断一个模型键是不是 B 通道（monkeycode 订阅网关）。
//
// 判据是**后缀**，不是前缀：
//   `…@monkeycode#<uuid>`  → B 通道
//   `…@baizhi`             → A 通道（百智云）
// 没有后缀但以 `monkeycode-` 开头的老写法也算 B。
//
// ⚠️ 不能只看前缀：`monkeycode-basic/x@baizhi` 这种（A 通道也用带档位的
//    名字）会被误判成 B ⇒ 插件会拿 A 通道的 key 去打 B 通道的端点。
export function isChannelB(modelKey) {
  const s = String(modelKey ?? "")
  const at = s.lastIndexOf("@")
  if (at >= 0) {
    const suffix = s.slice(at + 1)
    return suffix === "monkeycode" || suffix.startsWith("monkeycode#")
  }
  return s.startsWith("monkeycode-")
}

// readSettings 读客户端 settings.json，失败返回 null。
export function readSettings(env = process.env) {
  for (const path of settingsPaths(env)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"))
      if (raw && typeof raw === "object") return { path, raw }
    } catch {
      continue
    }
  }
  return null
}

// readLocalCredential 读出「一把 api_key + 一个签名密钥 + 可选的控制台 cookie」。
//
// 多账号怎么处理的：
//   B 通道的所有条目**共用同一把 api_key**（实测 25 个条目同 key），
//   差别在 `@monkeycode#<uuid>` 这个账号后缀上。所以：
//     - 签名密钥是**账号级**的（settings.json 顶层只有一个 signing_secret）
//     - api_key 也是账号级的
//   ⇒ 一个 settings.json 只描述**一个账号**（一个客户端登录态）。
//   多个账号要多个 settings.json（多个配置目录）。
//
// `dirs` 允许一次读多个配置目录，逐一返回 —— 多账号就靠它。
export function readLocalCredential({ env = process.env, dirs = null } = {}) {
  const found = []
  const list = dirs ?? settingsPaths(env)
  for (const path of list) {
    let raw
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      continue
    }
    if (!raw || typeof raw !== "object") continue
    const secret = String(raw.signing_secret ?? "").trim()
    const models = raw.models && typeof raw.models === "object" ? raw.models : {}
    const bKeys = Object.keys(models).filter((k) => isChannelB(k))
    if (!secret || !bKeys.length) continue

    // 同一把 api_key 只有一个（多账号会各写一个 settings.json）。
    //
    // ⚠️ 别拿 bKeys[0]：键是按字母序排的，第一条**未必**是 B 通道
    //    （`monkeycode-basic/…@baizhi` 排在 `…@monkeycode#…` 前面）。
    //    挑一个后缀是 @monkeycode 的条目。
    const first = bKeys.map((k) => models[k] ?? {}).find((e) => String(e.api_key ?? "").trim()) ?? {}
    const key = String(first.api_key ?? "").trim()
    if (!key) continue

    const cookieFile = join(dirname(dirname(path)), "monkeycode-cookies.json")
    const cookie = cookieValue(readCookieFile(cookieFile), SESSION_COOKIE, { expired: "drop" })

    found.push({
      key,
      secret,
      base: String(first.base_url ?? "").trim(),
      cookie,
      cookieFile,
      path,
      // 账号身份：这个配置目录里出现过的所有 uuid 后缀
      accounts: [...new Set(bKeys.map(accountOf).filter(Boolean))],
      models: bKeys.map((k) => ({
        id: String(models[k]?.model ?? "").trim(),
        key: k,
        type: String(models[k]?.type ?? "anthropic"),
        supportsImages: !!models[k]?.supports_images,
      })),
    })
  }
  return found
}

// normalizeCookie 接受裸值、`name=value`、或整条 Cookie 头，返回会话值。
export function normalizeCookie(value) {
  let s = String(value ?? "").trim()
  if (!s || s === "-" || s === "none" || s === "skip") return ""
  if (s.toLowerCase().startsWith("cookie:")) s = s.slice(7).trim()
  for (const part of s.split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim()
    }
  }
  const eq = s.indexOf("=")
  if (eq > 0 && !s.includes(";")) return s.slice(eq + 1).trim()
  return s
}

// stripBearer 去掉 `Bearer ` 前缀。
export function stripBearer(value) {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "").trim()
}

// credentialOf 从 magpie 的登录记录里取出请求要用的凭据。
//
// 记录形状（magpie 的 plugin-auth.json）—— **两种都有**：
//   { type:"api",   key:"oma_…",  metadata:{ secret, cookie, base, email, uid } }
//   { type:"oauth", refresh:"oma_…", access:"omas_…", expires, metadata:{…} }
//
// ⚠️ oauth 型的 key 叫 `refresh`、签名密钥叫 `access`（magpie 的 save()：
//    结果里带 `refresh` 就存成 `{type:"oauth", refresh, access, expires}`）。
//    只读 `auth.key` 的话 oauth 记录会**取不到 key**（实测：key 成了空串，
//    loader 于是返回 {}，请求直接没有 baseURL/apiKey）。
//
// 也接受把三样塞进 key 里（`oma_…:omas_…[:cookie]`）的老写法。
export function credentialOf(auth) {
  const md = auth?.metadata ?? {}
  // oauth 型：key 在 refresh、密钥在 access；api 型：key 在 key。
  let key = stripBearer(auth?.key ?? auth?.refresh)
  let secret = String(
    md.secret ?? md.signing_secret ?? md.signingSecret ?? auth?.access ?? "",
  ).trim()
  let cookie = String(md.cookie ?? md.console_cookie ?? md.consoleCookie ?? "").trim()
  let base = String(md.base ?? md.base_url ?? "").trim()
  if (!secret && key.includes(":")) {
    const parts = key.split(":")
    key = stripBearer(parts[0])
    secret = String(parts[1] ?? "").trim()
    if (!cookie) cookie = String(parts[2] ?? "").trim()
  }
  return {
    key,
    secret,
    cookie: normalizeCookie(cookie),
    base: base ? base.replace(/\/+$/, "") : "",
    email: String(md.email ?? auth?.email ?? "").trim(),
    uid: String(md.uid ?? auth?.uid ?? "").trim(),
  }
}

// 列出服务器上所有可用的配置目录（多账号）。
//
// magpie 部署里每个账号一个目录：
//   ~/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json   ← 主账号
//   ~/.config/com.chaitin.baizhi.monkeycode-<slug>/ohmyagent/…      ← 第二个账号
//
// ⚠️ 第二个账号的目录是**根目录的兄弟**，不是它的子目录 —— 所以要找的
//    是 `~/.config/` 下所有 `com.chaitin.baizhi.monkeycode*` 目录。
export function accountDirs(env = process.env) {
  const base = String(env.MONKEYCODE_ACCOUNT_ROOT ?? "").trim()
  const roots = []
  if (base) roots.push(base)
  const home = homedir()
  if (process.platform === "win32") {
    const appData = String(env.APPDATA ?? "").trim()
    if (appData) roots.push(join(appData, "com.chaitin.baizhi.monkeycode"))
  } else if (process.platform === "darwin") {
    roots.push(join(home, "Library", "Application Support", "com.chaitin.baizhi.monkeycode"))
  } else {
    roots.push(join(home, ".config", "com.chaitin.baizhi.monkeycode"))
  }

  const candidates = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    candidates.push(root)
    // 根目录**的上一层**里所有同前缀的兄弟目录（第二个账号在那儿）
    const parent = dirname(root)
    try {
      for (const name of readdirSync(parent, { withFileTypes: true })) {
        if (!name.isDirectory()) continue
        if (!name.name.startsWith("com.chaitin.baizhi.monkeycode")) continue
        const p = join(parent, name.name)
        if (!candidates.includes(p)) candidates.push(p)
      }
    } catch {
      /* 读不到就算了 */
    }
  }
  // env 指的目录本身（运维放账号目录的地方）
  for (const extra of String(env.MONKEYCODE_ACCOUNT_DIRS ?? "")
    .split(/[;:\s]+/)
    .filter(Boolean)) {
    if (!candidates.includes(extra)) candidates.push(extra)
  }

  // 每个目录都去找它的 ohmyagent/settings.json
  const seen = new Set()
  const dirs = []
  for (const root of candidates) {
    const p = join(root, "ohmyagent")
    if (seen.has(p)) continue
    seen.add(p)
    if (existsSync(join(p, "settings.json"))) dirs.push(p)
  }
  return dirs
}

// accountCookie 取某个配置目录对应的账号 cookie（会话 + 百智云账号站）。
export function accountCookie(dir, name, opts = {}) {
  const root = dirname(dir)
  return cookieValue(readCookieFile(join(root, "monkeycode-cookies.json")), name, opts)
}

// accountCookieFile 取某个配置目录的 cookie 文件路径。
export function accountCookieFile(dir, which = "monkeycode") {
  const root = dirname(dir)
  return which === "baizhi"
    ? join(root, "baizhi-cookies.json")
    : join(root, "monkeycode-cookies.json")
}

// findAccountCookie 在所有已知的 cookie 文件里找**百智云账号站**的会话
// （A 通道用）。
//
// 为什么单独找：百智云会话的 cookie 名（baizhi_session）与官方云的
// （monkeycode_ai_session）不同，文件也不同（baizhi-cookies.json）。
// 客户端导出的那份可能在任何配置目录里，不一定与当前登录的账号同目录。
export function findAccountCookie(env = process.env, name = ACCOUNT_COOKIE) {
  // 运维直接注入的环境变量优先（脚本注入的就是这个）
  const injected = sessionFromEnv(env, name)
  if (injected) return { path: "env", value: injected }
  const seen = new Set()
  const dirs = accountDirs(env)
  for (const dir of dirs) {
    const file = accountCookieFile(dir, "baizhi")
    if (seen.has(file)) continue
    seen.add(file)
    const value = cookieValue(readCookieFile(file), name, { expired: "drop" })
    if (value) return { path: file, value }
  }
  // 再看 env 指的文件与通用候选
  for (const file of cookiePaths(env)) {
    if (seen.has(file)) continue
    seen.add(file)
    const value = cookieValue(readCookieFile(file), name, { expired: "drop" })
    if (value) return { path: file, value }
  }
  return { path: "", value: "" }
}

export { ACCOUNT_COOKIE }
