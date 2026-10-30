// magpie provider 插件：MonkeyCode（长亭 · ohmyagent）。
//
// ═══ 一个包，两个供应商 ═════════════════════════════════════════════════
//
//   export const MonkeyCodeAuthPlugin     = buildPlugin(SITES.cn)
//   export const MonkeyCodeIntlAuthPlugin = buildPlugin(SITES.intl)
//
// magpie 把包里每个具名导出当成一个独立插件，所以国内版（monkeycode）
// 与国际版（monkeycode-intl）在供应商列表、用量概览、模型目录里**各占一行**，
// 登录态、账号池、续期互不干扰。
//
// ═══ 与社区插件（opencode-monkeycode-auth 0.1.1）的三处不同 ══════════════
//
// 1. **不设 `single: true`** —— 上游那个字段让「再登录一次」直接覆盖
//    第一个账号（magpie 的 signInKey：single 为真时永远写进第一个账号槽），
//    多账号根本存不下。去掉它，magpie 会为第二个账号自己开
//    `monkeycode#xxxxxx` 槽位；magpie 的 loader/usage/checkin/refresh 本来
//    就是**按账号槽**跑的（AsyncLocalStorage scope），不需要额外改动。
//
// 2. **有 `auth.refresh`** —— 上游没有。凭据是 plugin login 那一刻的快照，
//    `monkeycode_ai_session` 只有 7 天，过期就静默失效。这里实现了
//    **服务器端自主续期**：会话还在就自己铸造一把新的 oma_ key + 签名密钥
//    （POST /api/v1/users/ohmyagent/api-keys），会话过期就用服务器上保存的
//    口令重新登录（国内版还有百智云 OAuth 桥那条路）。
//    ⇒ **不再需要本机电脑开机、不需要桌面端客户端。**
//
// 3. **A 通道的签到也做了** —— MonkeyCode 有两条计费通道，余额来自两个
//    不同的钱包：A 通道的余额在百智云（baizhi.cloud）的「每日临时额度」，
//    不领就是 0 ⇒ 上游回 `400 余额不足`。上游插件只管 B 通道。
//
// 入口只装配钩子；逻辑都在 lib/ 下，通过 _internal 暴露给测试。
// ⚠️ 入口**只**导出这两个插件函数和 _internal（对象）：magpie 把每个导出的
//    **函数**都当成一个独立插件加载。

import {
  SITES,
  SIGN_PROMPT,
  AGENT_UA,
  ANTHROPIC_VERSION,
  ANTHROPIC_NPM,
  MODEL_IDS,
  REFRESH_LEAD_MS,
  CHANNEL_PREFIX,
  TIERS,
  SESSION_COOKIE,
} from "./lib/constants.mjs"
import {
  credentialOf,
  readLocalCredential,
  normalizeCookie,
  stripBearer,
  settingsPaths,
  cookiePaths,
  readCookieFile,
  cookieValue,
  accountDirs,
  accountCookieFile,
  accountOf,
  isChannelB,
  findAccountCookie,
} from "./lib/credentials.mjs"
import {
  modelsConfig,
  withRates,
  bareModelID,
  upstreamModelID,
  labelOf,
  modelEntry,
  applyAnthropic,
  applyResponses,
  isResponsesURL,
  signatureOf,
  rateFromPrice,
  hashOf,
} from "./lib/models.mjs"
import {
  fetchRates,
  fetchWallet,
  fetchSubscription,
  fetchStatus,
  userIdentity,
  walletToUsage,
  checkinFor,
  performCheckin,
  mintApiKey,
  passwordLogin,
  consoleFetch,
} from "./lib/console.mjs"
import {
  renewAccount,
  readSessionCookie,
  localCredentialFor,
  hostOf,
  writeSessionCookie,
} from "./lib/session.mjs"
import {
  claimBaizhiDailyCredit,
  fetchBaizhiBalance,
  baizhiCookieFrom,
  baizhiBalanceToUsage,
} from "./lib/baizhi.mjs"
import { saveSecret, loadSecret } from "./lib/store.mjs"

// ---- 会员档位可见性 ---------------------------------------------------------

// planAllowsModel 按会员档位过滤模型。
//
// 上游 `plan_allows_model`（desktop/src/baizhi/monkeycode.rs）的规则：
//   monkeycode-ultra 前缀 → 需要 flagship / ultra 档
//   monkeycode-pro  前缀 → 需要 pro / flagship / ultra 档
//   其余（含 basic 与裸名）→ 恒可用
//
// 这解释了为什么 pro/ultra 模型会 403：不是「模型名要带档位」那个坑，
// 是**账号的套餐够不着**。这里按档位直接不显示，免得用户点了才报错。
//
// ⚠️ 传进来的是**厂商名**（monkeycode-pro/…），上游就是这么判的。
function planAllowsModel(model, plan) {
  const n = String(model ?? "").toLowerCase()
  if (n.startsWith("monkeycode-ultra")) return plan === "flagship" || plan === "ultra"
  if (n.startsWith("monkeycode-pro")) return plan === "pro" || plan === "flagship" || plan === "ultra"
  return true
}

// filterByPlan 按档位过滤模型表（plan 为空 = 读不到套餐 → 不过滤）。
function filterByPlan(models, plan) {
  if (!plan) return models
  const out = {}
  for (const [id, m] of Object.entries(models)) {
    if (planAllowsModel(upstreamModelID(id), plan)) out[id] = m
  }
  return out
}

// ---- 环境变量 ---------------------------------------------------------------

// envOf 把 plugins.json 的 options 变成运行期 env 覆盖。
//
// ⚠️ process.env 要**现读**，不能在建插件时快照一份 —— 调用方
//    （测试、运维脚本）可能在插件装配之后才改环境变量。
function envOf(options) {
  const o = options ?? {}
  const over = {}
  if (o.env && typeof o.env === "object") {
    for (const [k, v] of Object.entries(o.env)) {
      if (typeof v === "string") over[k] = v
    }
  }
  if (typeof o.apiBase === "string" && o.apiBase.trim()) over.MONKEYCODE_API_BASE = o.apiBase.trim()
  if (typeof o.consoleBase === "string" && o.consoleBase.trim())
    over.MONKEYCODE_CONSOLE_BASE = o.consoleBase.trim()
  return new Proxy(over, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return process.env[prop]
    },
    has(target, prop) {
      return prop in target || prop in process.env
    },
  })
}

// siteOf 把站点常量套上 env 覆盖（测试与私有化部署用）。
function siteOf(site, env) {
  const api = String(env.MONKEYCODE_API_BASE ?? "").trim()
  const con = String(env.MONKEYCODE_CONSOLE_BASE ?? "").trim()
  return {
    ...site,
    proxy: api ? api.replace(/\/+$/, "") : site.proxy,
    console: con ? con.replace(/\/+$/, "") : site.console,
  }
}

// ---- 一个站点进，一个完整插件出 ---------------------------------------------

function buildPlugin(site) {
  return async (input, options) => {
    const env = envOf(options)
    const s = siteOf(site, env)
    const fetchImpl = typeof options?.fetch === "function" ? options.fetch : fetch

    const log = (level, message) => {
      try {
        input?.client?.app?.log?.({ level, message: `[monkeycode] ${message}` })
      } catch {
        /* 日志失败不该影响主流程 */
      }
    }

    // ---- 请求接管 ----------------------------------------------------------

    // makeLoader 每个账号调一次（magpie 按账号槽缓存它的返回值），
    // 拿到的是**该账号自己的**凭据（magpie 的 inScope 保证）。
    const makeLoader = () => async (getAuth) => {
      const auth = await getAuth()
      const cred = credentialOf(auth)
      if (!cred.key) return {}

      if (!cred.secret) {
        // 没有签名密钥，上游不会认任何请求 —— 明确报错，别让它变成
        // 一个看不懂的 403。
        return {
          baseURL: cred.base || s.proxy,
          apiKey: cred.key,
          async fetch() {
            return new Response(
              JSON.stringify({
                error: {
                  message:
                    "MonkeyCode 缺少 signing secret（omas_…）。请重新登录，或在服务器上" +
                    "提供客户端 settings.json 的拷贝。",
                  type: "authentication_error",
                },
              }),
              {
                status: 401,
                headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
              },
            )
          },
        }
      }

      const signature = signatureOf(cred.secret)

      return {
        baseURL: cred.base || s.proxy,
        apiKey: cred.key,
        headers: { "User-Agent": AGENT_UA },

        async fetch(input_, init = {}) {
          const url = typeof input_ === "string" ? input_ : (input_?.url ?? String(input_))
          const method = init?.method ?? (input_ instanceof Request ? input_.method : "POST")
          const responses = isResponsesURL(url)

          let bodyText = init?.body
          if (bodyText == null && input_ instanceof Request) bodyText = await input_.clone().text()

          if (typeof bodyText === "string" && bodyText) {
            let body = null
            try {
              body = JSON.parse(bodyText)
            } catch {
              body = null
            }
            if (body && typeof body === "object") {
              bodyText = JSON.stringify(responses ? applyResponses(body) : applyAnthropic(body))
            }
          }

          const headers = new Headers(
            init?.headers ?? (input_ instanceof Request ? input_.headers : undefined),
          )
          headers.delete("content-length")
          headers.set("Content-Type", "application/json")
          headers.set("Accept", "application/json, text/event-stream")
          headers.set("User-Agent", AGENT_UA)
          headers.set("X-Api-Key", cred.key)
          headers.set("Authorization", `Bearer ${cred.key}`)
          headers.set("X-Ohmyagent-Signature", signature)
          if (responses) headers.delete("anthropic-version")
          else headers.set("Anthropic-Version", ANTHROPIC_VERSION)

          return fetchImpl(url, { ...init, method, headers, body: bodyText })
        },
      }
    }

    // ---- 登录方式 ----------------------------------------------------------

    const makeMethods = () => [
      {
        // 方式 1（推荐，零交互）：读服务器上的客户端登录态。
        //
        // keyless ⇒ magpie 不从 stdin 要 API key。
        // 返回值里带 `refresh` ⇒ magpie 把它存成 **oauth 型**账号，
        // 这样 auth.refresh 才会被调用（magpie 只续期 oauth 型账号）。
        type: "api",
        keyless: true,
        label: "读取服务器上的客户端登录态（推荐）",
        authorize: async () => {
          const dirs = accountDirs(env)
          if (!dirs.length) {
            return {
              type: "failed",
              error:
                "服务器上没有 MonkeyCode 客户端的配置。请用「服务器端登录」方式，\n" +
                "或在服务器上放一份客户端的 settings.json。",
            }
          }
          // ⚠️ **按地区挑**：客户端的 settings.json 里只有**当前地区**那一版的
          //    base_url。国内版与国际版共用一个配置目录的话，国际版登录时
          //    会捡到国内版的 base_url ⇒ 请求打到 proxy.monkeycode-ai.com
          //    （国内版的网关），拿国际版的 key 去问它 —— 403/401。
          //    所以这里只接受**本供应商这个地区**的配置。
          const mine = dirs.filter((dir) => localCredentialFor(dir, { env, site: s }))
          if (!mine.length) {
            return {
              type: "failed",
              error:
                `服务器上的客户端配置里没有 **${s.label}** 的凭据` +
                `（要找的端点是 ${s.proxy}）。\n` +
                "若你是国际版账号，请用「服务器端登录」方式（邮箱 + 口令）。",
            }
          }
          for (const dir of mine) {
            const local = localCredentialFor(dir, { env, site: s })
            if (!local) continue
            if (!local.metadata.cookie) {
              // 有 key 但没会话：推理能用，签到/额度不能用。
              log("warn", `客户端配置 ${dir} 没有 ${SESSION_COOKIE}`)
            }
            // 补账号身份（邮箱 / id）：magpie 用它区分两个账号，
            // 也能在界面上显示「signed in as …」。
            let email = ""
            let uid = ""
            if (local.metadata.cookie) {
              try {
                const st = await fetchStatus(s.console, local.metadata.cookie, { fetchImpl })
                const u = userIdentity(st)
                email = u.email
                uid = u.id
              } catch {
                /* 拿不到就空着 */
              }
            }
            return {
              type: "success",
              refresh: local.key,
              access: local.metadata.secret,
              expires: Date.now() + 6 * 24 * 3600 * 1000,
              uid,
              metadata: {
                ...local.metadata,
                email,
                uid,
                base: local.metadata.base || s.proxy,
                source: "local-client",
              },
            }
          }
          return { type: "failed", error: "服务器上的客户端配置里没有可用的 B 通道凭据。" }
        },
      },
      {
        // 方式 2：服务器端账密登录（**不需要本机电脑**）。
        //
        // 换取会话 → 在控制台上铸造一把 oma_ key + 签名密钥 → 存成账号。
        // 口令存到服务器上（600 权限的文件，**不进 plugin-auth.json** ——
        // 那个文件网页界面读得到），之后 magpie 的 auth.refresh 自己就能续期。
        type: "api",
        keyless: true,
        label: "服务器端登录（邮箱 + 口令，可自动续期）",
        prompts: [
          {
            type: "text",
            key: "email",
            message: "MonkeyCode 账号邮箱",
            placeholder: "you@example.com",
            validate: (v) => (String(v ?? "").includes("@") ? undefined : "需要一个邮箱地址"),
          },
          {
            type: "password",
            key: "password",
            message: "口令（会存在服务器上用于自动续期，不进 magpie 的凭据库）",
            placeholder: "••••••••",
            validate: (v) => (String(v ?? "").length >= 6 ? undefined : "太短了"),
          },
        ],
        authorize: async (inputs) => {
          const email = String(inputs?.email ?? "").trim()
          const password = String(inputs?.password ?? "")
          if (!email || !password) return { type: "failed", error: "缺邮箱或口令。" }
          try {
            const r = await passwordLogin(s.console, email, password, { fetchImpl })
            if (!r.ok) {
              return { type: "failed", error: `登录失败：${r.message || `HTTP ${r.http}`}` }
            }
            const session = r.session
            const minted = await mintApiKey(s.console, session, { fetchImpl })
            const st = await fetchStatus(s.console, session, { fetchImpl }).catch(() => null)
            const u = st ? userIdentity(st) : { email, id: "" }

            // 存口令，供以后自动续期用。
            try {
              saveSecret(
                { email: u.email || email, uid: u.id },
                { email: u.email || email, password },
                env,
              )
            } catch (e) {
              log("warn", `口令保存失败（不影响本次登录）：${e?.message ?? e}`)
            }

            // 会话落盘（插件续期时要用）。
            const cookieFile = String(env.MONKEYCODE_COOKIE_FILE ?? "").trim()
            if (cookieFile) {
              try {
                writeSessionCookie(cookieFile, session, { domain: hostOf(s.console) })
              } catch (e) {
                log("warn", `会话写回失败：${e?.message ?? e}`)
              }
            }

            return {
              type: "success",
              refresh: minted.key,
              access: minted.secret,
              expires: Date.now() + 6.5 * 24 * 3600 * 1000,
              uid: u.id,
              metadata: {
                secret: minted.secret,
                cookie: session,
                base: s.proxy,
                email: u.email || email,
                uid: u.id,
                keyId: minted.id,
                source: "server-login",
              },
            }
          } catch (e) {
            return { type: "failed", error: e?.message ?? String(e) }
          }
        },
      },
      {
        // 方式 3：手动粘贴（客户端导出的 key / 签名密钥 / 会话 cookie）。
        type: "api",
        keyless: true,
        label: "手动填写（oma_ key + omas_ 签名密钥 + 会话 cookie）",
        prompts: [
          {
            type: "text",
            key: "key",
            message: "API key（oma_…）",
            placeholder: "oma_…",
            validate: (v) =>
              String(v ?? "").trim().startsWith("oma_") ? undefined : "应以 oma_ 开头",
          },
          {
            type: "password",
            key: "secret",
            message: "Signing secret（omas_…）",
            placeholder: "omas_…",
            validate: (v) =>
              String(v ?? "").trim().startsWith("omas_") ? undefined : "应以 omas_ 开头",
          },
          {
            type: "password",
            key: "cookie",
            message: "控制台会话 cookie（可选，用于查积分与签到；没有就填 -）",
            placeholder: `${SESSION_COOKIE} 的值`,
          },
        ],
        authorize: async (inputs) => {
          const key = stripBearer(inputs?.key)
          const secret = String(inputs?.secret ?? "").trim()
          const cookie = normalizeCookie(inputs?.cookie)
          if (!key || !secret) return { type: "failed", error: "缺 API key 或签名密钥。" }
          return {
            type: "success",
            refresh: key,
            access: secret,
            expires: Date.now() + 6 * 24 * 3600 * 1000,
            metadata: {
              secret,
              cookie,
              base: s.proxy,
              email: "",
              uid: "",
              source: "manual",
            },
          }
        },
      },
    ]

    // ---- 续期 --------------------------------------------------------------

    // makeRefresh 让 magpie 在会话到期前自己换掉凭据。
    //
    // 只有 **oauth 型**账号会被续期（magpie 的 renewAt：stored.type === "oauth"），
    // 所以三个登录方式都存成 oauth 型（返回里带 refresh/access/expires）。
    const makeRefresh = () => async (auth) => {
      try {
        const next = await renewAccount(s, { auth, env, fetchImpl, log })
        return {
          refresh: next.key,
          access: next.metadata.secret,
          expires: next.expires,
          uid: next.metadata.uid,
          metadata: next.metadata,
        }
      } catch (e) {
        // signIn:"expired" ⇒ magpie 把这个账号标记为「需要重新登录」。
        if (e?.signIn === "expired") throw e
        throw Object.assign(new Error(e?.message ?? String(e)), { signIn: "expired" })
      }
    }

    // ---- 额度 --------------------------------------------------------------

    const makeUsage = () => async (getAuth) => {
      const auth = await getAuth()
      const cred = credentialOf(auth)
      if (!cred.cookie) {
        return {
          plan: s.short,
          error: "未保存控制台 Cookie，无法查询积分。重新登录时填写 " + SESSION_COOKIE + "。",
          signIn: "kept",
        }
      }
      try {
        const [wallet, sub] = await Promise.all([
          fetchWallet(s.console, cred.cookie, { fetchImpl }),
          fetchSubscription(s.console, cred.cookie, { fetchImpl }),
        ])
        const plan = sub?.plan ? String(sub.plan) : ""
        const out = { ...walletToUsage(wallet, { plan: plan || s.short }), signIn: "kept" }
        if (plan) out.plan = `${s.short} · ${plan}`
        // A 通道的余额也报出来（另一个钱包）。
        const bz = baizhiCookieOf(env)
        if (bz) {
          try {
            const bal = await fetchBaizhiBalance(bz, { fetchImpl })
            const a = baizhiBalanceToUsage(bal)
            if (a.windows?.length) out.windows = [...(out.windows ?? []), ...a.windows]
          } catch {
            /* A 通道读不到就不报，不影响 B */
          }
        }
        return out
      } catch (e) {
        const expired = e?.status === 401
        return {
          plan: s.short,
          error: expired
            ? "控制台会话已过期：请重新登录 MonkeyCode。"
            : (e?.message ?? String(e)),
          signIn: expired ? "expired" : "kept",
        }
      }
    }

    // ---- 签到 --------------------------------------------------------------

    const makeCheckin = () => async (getAuth) => {
      const auth = await getAuth()
      const cred = credentialOf(auth)
      if (!cred.cookie) {
        return { outcome: "ineligible", message: "未保存控制台 Cookie，无法查询签到状态。" }
      }
      // B 通道（官方云）：领每日积分。
      let b
      try {
        b = await checkinFor(s.console, cred.cookie, { fetchImpl })
      } catch (e) {
        return { outcome: "failed", message: e?.message ?? String(e) }
      }
      // A 通道（百智云）：领每日临时额度。两条通道的余额来自两个钱包，
      // 不领 A 的话 A 通道会一直 `400 余额不足`。
      const bz = baizhiCookieOf(env)
      if (bz) {
        try {
          const a = await claimBaizhiDailyCredit(bz, { fetchImpl })
          if (a.outcome === "claimed") {
            return { outcome: b.outcome, message: `${b.message}；${a.message}` }
          }
        } catch (e) {
          log("warn", `A 通道每日临时额度领取失败：${e?.message ?? e}`)
        }
      }
      return b
    }

    // ---- 模型目录 ----------------------------------------------------------

    const makeModels = () => async (provider, { auth } = {}) => {
      const cred = credentialOf(auth)
      let rates = new Map()
      let plan = ""
      if (cred.cookie) {
        try {
          const [r, sub] = await Promise.all([
            fetchRates(s.console, cred.cookie, { fetchImpl }),
            fetchSubscription(s.console, cred.cookie, { fetchImpl }),
          ])
          rates = r.rates ?? new Map()
          plan = sub?.plan ? String(sub.plan) : ""
        } catch {
          /* 控制台读不到就用默认表 */
        }
      }
      // ⚠️ provider.models 是 magpie 已经建好的模型信息（含 api.id / api.npm），
      //    只能往上贴东西，不能拿配置表把它换掉 —— 换掉就丢了厂商端点。
      const given = provider?.models ?? {}
      const base = Object.keys(given).length ? given : modelsConfig()
      const filtered = filterByPlan(base, plan)
      return withRates(filtered, rates)
    }

    // ---- 装配 --------------------------------------------------------------

    return {
      config: async (cfg) => {
        cfg.provider ??= {}
        const was = cfg.provider[s.id] ?? {}
        cfg.provider[s.id] = {
          name: s.label,
          npm: ANTHROPIC_NPM,
          api: s.proxy,
          ...was,
          models: { ...modelsConfig(), ...(was.models ?? {}) },
        }
      },

      auth: {
        provider: s.id,
        refreshLead: REFRESH_LEAD_MS,
        // ⚠️ **故意不设 `single: true`** —— 那是社区插件的毛病：
        //    它让「再登录一次」直接覆盖第一个账号，多账号存不下。
        //    不设它，magpie 会为第二个账号开 `monkeycode#xxxxxx` 槽位。

        methods: makeMethods(),
        refresh: makeRefresh(),
        loader: makeLoader(),
        usage: makeUsage(),
        checkin: makeCheckin(),
      },

      provider: {
        id: s.id,
        models: makeModels(),
      },
    }
  }
}

// ═══ 两个供应商，各占一行 ═════════════════════════════════════════════════

export const MonkeyCodeAuthPlugin = buildPlugin(SITES.cn)
export const MonkeyCodeIntlAuthPlugin = buildPlugin(SITES.intl)

// 供测试引用（⚠ 入口文件不要导出别的「像插件的对象」，否则会被 magpie 当插件加载）
export const _internal = {
  buildPlugin,
  SITES,
  planAllowsModel,
  filterByPlan,
  credentialOf,
  readLocalCredential,
  normalizeCookie,
  stripBearer,
  settingsPaths,
  cookiePaths,
  readCookieFile,
  cookieValue,
  accountDirs,
  accountCookieFile,
  accountOf,
  isChannelB,
  findAccountCookie,
  modelsConfig,
  withRates,
  bareModelID,
  upstreamModelID,
  labelOf,
  modelEntry,
  applyAnthropic,
  applyResponses,
  isResponsesURL,
  signatureOf,
  rateFromPrice,
  hashOf,
  fetchRates,
  fetchWallet,
  fetchSubscription,
  fetchStatus,
  userIdentity,
  walletToUsage,
  checkinFor,
  performCheckin,
  mintApiKey,
  passwordLogin,
  consoleFetch,
  renewAccount,
  readSessionCookie,
  writeSessionCookie,
  localCredentialFor,
  claimBaizhiDailyCredit,
  fetchBaizhiBalance,
  baizhiCookieFrom,
  baizhiBalanceToUsage,
  saveSecret,
  loadSecret,
  SIGN_PROMPT,
  MODEL_IDS,
  CHANNEL_PREFIX,
  TIERS,
  SESSION_COOKIE,
}

// baizhiCookieOf 取这个环境的百智云账号会话（A 通道用）。
//
// 优先 env BAIZHI_COOKIE_FILE，其次在插件已知的 cookie 文件里找
// baizhi_session（客户端导出的那份）。
function baizhiCookieOf(env) {
  const file = String(env.BAIZHI_COOKIE_FILE ?? "").trim()
  if (file) return baizhiCookieFrom(file)
  return findAccountCookie(env).value
}
