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
  onlyBilled,
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
  requestPasswordReset,
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
import { startWechatLogin, pollWechatLogin } from "./lib/wechat-login.mjs"
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

    const methods = [
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
                "若你是国际版账号，请用「浏览器登录后粘贴会话 Cookie」方式（方式 5）。",
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
        label: "服务器端登录（邮箱 + 口令；仅限设过密码的账号，可自动续期）",
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
              return {
                type: "failed",
                error:
                  `登录失败：${r.message || `HTTP ${r.http}`}。` +
                  (s.id === "monkeycode"
                    ? "微信绑定的账号可能没设过口令 —— 用「微信扫码登录」更省事。"
                    : "国际版没有注册接口，也没有默认口令 —— 若你还没注册，请先在浏览器打开 " +
                      `${s.console}/login 注册/登录，再用「浏览器登录后粘贴会话 Cookie」（方式 5）。`),
              }
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
        // 方式 3（仅国际版）：发一封「设置密码」邮件，然后用粘贴的**新口令**
        // 直接登录（magpie 原生 oauth 的 `method:"code"` 两段式）。
        //
        // 国际版的账号多用 GitHub/Google OAuth 注册，注册流程从不设口令，
        // 账密登录对它永远失败。官方 UI 的「Forgot password」就是这封邮件。
        //
        // 第一版这里发完邮件就返回 { type: "failed", error: "重置邮件已发到…" }
        // —— 邮件明明发出去了，UI 却渲染成红字「sign-in failed」，用户
        // 误以为登录失败（假失败）。改成 magpie 原生的 code 两段式：
        //   authorize() 发邮件 → 返回 { url, instructions, method:"code", callback }
        //   magpie UI 弹一个「粘贴 code」输入框（我们的 instructions 会
        //   覆盖默认文案），用户把邮件链接里设好的**新口令**填回来；
        //   callback(口令) 里 passwordLogin 验证 → 铸 key → 存口令 → 存槽，
        //   一步到「success」，不再出现假失败，之后续期全自动。
        type: "oauth",
        label: "第一次用：发送「设置密码」邮件并用新口令登录（GitHub/Google 注册的账号）",
        prompts: [
          {
            type: "text",
            key: "email",
            message:
              "注册用的邮箱（GitHub/Google 的邮箱）。发一封「设置密码」邮件过去，" +
              "点邮件里的链接设一个新口令，把新口令填回来即完成登录。",
            placeholder: "you@example.com",
            validate: (v) => (String(v ?? "").includes("@") ? undefined : "需要一个邮箱地址"),
          },
        ],
        authorize: async (inputs) => {
          const email = String(inputs?.email ?? "").trim()
          if (!email.includes("@")) return { type: "failed", error: "缺邮箱地址。" }
          await requestPasswordReset(s.console, email, { fetchImpl })
          log("info", `重置邮件已发到 ${email}（若该邮箱注册过）。等用户从邮件回来填新口令…`)
          return {
            url: `${s.console}/login`,
            instructions:
              `重置邮件已发到 ${email}（若该邮箱注册过，2 分钟内到，注意垃圾箱）。` +
              "到邮箱点「设置密码」链接设一个**新口令**，然后把新口令粘贴到下面的输入框" +
              "（这里就是登录：粘贴后 magpie 会用它登录并自动铸造 API key）。",
            method: "code",
            callback: async (pasted) => {
              const password = String(pasted ?? "").trim()
              if (!password) return { type: "failed", error: "口令为空 —— 把邮件里设置的新口令粘贴进来。" }
              try {
                const r = await passwordLogin(s.console, email, password, { fetchImpl })
                if (!r.ok) {
                  return {
                    type: "failed",
                    error:
                      `用你粘贴的口令登录失败：${r.message || `HTTP ${r.http}`}。` +
                      "若还没点邮件里的链接设口令，请先设好再回来重试。",
                  }
                }
                const session = r.session
                const minted = await mintApiKey(s.console, session, { fetchImpl })
                const st = await fetchStatus(s.console, session, { fetchImpl }).catch(() => null)
                const u = st ? userIdentity(st) : { email, id: "" }

                // 存口令，供以后自动续期用（与方式 2 同一槽位）。
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
                    source: "reset-email-code",
                  },
                }
              } catch (e) {
                return { type: "failed", error: e?.message ?? String(e) }
              }
            },
          }
        },
      },
      {
        // 方式 3：微信扫码登录（**仅国内版，不需要口令，不需要本机电脑**）。
        //
        // 链路（上游 desktop/src/baizhi/wechat.rs 的同款协议）：
        //   百智云出微信授权页 → 用户手机扫码确认 → wx_code → 百智云回调
        //   → 30 天的 baizhi_session → OAuth 桥（bridgeLogin）换 MonkeyCode 会话
        //   → 铸造 oma_ key + 签名密钥 → 存成 oauth 型账号。
        //
        // 为什么要有这条：国际版外的国内版用户往往只有微信绑定的账号，
        // 没设过口令 —— 账密登录帮不了他，粘贴 Cookie 又要 F12。
        // 扫码是「给个码扫一下就完事」的零口令登录，扫完之后服务器上
        // 有了 30 天的百智云会话，续期也顺带能走 OAuth 桥。
        // magpie 原生 oauth 形状：authorize() 先开出微信授权页，把网址交给
        // magpie 的界面直接展示给用户（不用从日志里翻链接），用户扫码确认后
        // callback() 里轮询到 wx_code，走完 桥接 → 铸 key 全链。
        type: "oauth",
        label: "微信扫码登录（手机扫一下，不要口令）",
        async authorize(_inputs, { signal } = {}) {
          if (!s.account) throw new Error("微信扫码登录仅国内版可用。")
          // 开扫码会话：出二维码，把授权页网址交给 magpie 展示。
          const login = await startWechatLogin(s.account, { fetchImpl })
          log(
            "info",
            `微信扫码登录：浏览器将打开二维码图片，用手机微信扫码并确认（约 5 分钟内有效）`,
          )
          return {
            // 🔴 关键：给 magpie UI 打开的必须是**二维码图片直链**（同一 uuid），
            // 不能是授权页 authUrl —— qrconnect 页面每次加载都会生成**新的**
            // uuid 并重绘二维码，用户扫「他自己浏览器加载出来的码」，插件轮询
            // 的却是 startWechatLogin 的 uuid ⇒ 两者永远错位，用户侧「扫描
            // 成功」、服务器侧永远 waiting（2026-11-16 实测踩坑）。
            // 图片直链 https://open.weixin.qq.com/connect/qrcode/<uuid> 是
            // startWechatLogin 里抓到的**同一个 uuid**，扫它必然命中。
            url: login.qrUrl,
            instructions:
              "浏览器已打开微信登录二维码图片：用手机微信「扫一扫」扫这张图，并在手机上点「确认登录」。" +
              "确认后这里会自动完成（约 5 分钟内有效）。若浏览器没有自动打开，手动访问上面的图片链接。",
            method: "auto",
            callback: async () => {
              // 轮询到出结果为止（微信授权页的二维码约 5 分钟过期）。
              const deadline = Date.now() + 6 * 60_000
              let scanned = false
              while (Date.now() < deadline) {
                if (signal?.aborted) throw new DOMException("the sign-in was cancelled", "AbortError")
                await new Promise((r) => setTimeout(r, 2000))
                const r = await pollWechatLogin(login, { fetchImpl }).catch((e) => {
                  log("warn", `扫码状态查询失败：${e?.message ?? e}`)
                  return "waiting"
                })
                if (r === "waiting") continue
                if (r === "scanned") {
                  if (!scanned) {
                    scanned = true
                    log("info", "微信扫码登录：已扫码，等待手机确认…")
                  }
                  continue
                }
                if (r === "canceled") return { type: "failed", error: "你取消了扫码登录。" }
                if (r === "expired") {
                  return { type: "failed", error: "二维码已过期，请重新发起微信扫码登录。" }
                }
                // r = { session }：百智云会话到手 → 走完桥接 + 铸 key。
                return await finishWechatSignIn(r.session)
              }
              return { type: "failed", error: "等待扫码超时（6 分钟），请重新发起。" }
            },
          }

          // finishWechatSignIn 百智云会话 → MonkeyCode 会话 → 铸 key → 存盘。
          async function finishWechatSignIn(bzValue) {
            const bridged = await bridgeLogin(s.console, s.account, bzValue, { fetchImpl })
            const st = await fetchStatus(s.console, bridged.session, { fetchImpl })
            const u = userIdentity(st)
            const minted = await mintApiKey(s.console, bridged.session, { fetchImpl })
            // 会话落盘：续期链路用得上（OAuth 桥那条路要百智 cookie，
            // 所以百智会话也一起写进 baizhi-cookies.json）。
            const cookieFile = String(env.MONKEYCODE_COOKIE_FILE ?? "").trim()
            if (cookieFile) {
              try {
                writeSessionCookie(cookieFile, bridged.session, { domain: hostOf(s.console) })
              } catch (e) {
                log("warn", `会话写回失败：${e?.message ?? e}`)
              }
            }
            const acctFile = accountCookieFile(env)
            if (acctFile) {
              try {
                writeAccountCookie(acctFile, bzValue)
              } catch (e) {
                log("warn", `百智云会话写回失败：${e?.message ?? e}`)
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
                cookie: bridged.session,
                base: s.proxy,
                email: u.email,
                uid: u.id,
                keyId: minted.id,
                source: "wechat-scan",
              },
            }
          }
        },
      },
      {
        // 方式 4：手动粘贴（客户端导出的 key / 签名密钥 / 会话 cookie）。
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
      {
        // 方式 5：**浏览器登录后粘贴会话 Cookie** —— 不需要口令，也不依赖注册接口。
        //
        // 为什么要这条：国际版（以及国内版）**没有可调用的注册 API** —— 注册/登录
        // 都在网页端完成（百智云 / Google / GitHub / 账号密码 / 快速注册）。
        // 所以插件不猜口令，而是把「网页登录后的会话」接过来：
        //   校验会话 → 在控制台**自动铸造**一把 oma_ key + 签名密钥 → 存成账号。
        // 之后推理、查额度、签到都能用；会话到期再粘一次即可（口令登录可自动续期）。
        type: "api",
        keyless: true,
        label: "浏览器注册/登录后粘贴会话 Cookie（GitHub/Google 登录，国际版推荐）",
        prompts: [
          {
            type: "password",
            key: "cookie",
            message:
              `会话 Cookie。步骤：浏览器打开 ${s.console}/login` +
              (s.id === "monkeycode-intl"
                ? ` → 用 GitHub Sign-in（或 Google）注册/登录`
                : ` → 登录`) +
              ` → F12 → Application → Cookies → 复制 ${SESSION_COOKIE} 的值`,
            placeholder: `${SESSION_COOKIE} 的值`,
            validate: (v) => (String(v ?? "").trim() ? undefined : "不能为空"),
          },
        ],
        authorize: async (inputs) => {
          const cookie = normalizeCookie(inputs?.cookie)
          if (!cookie) return { type: "failed", error: "缺会话 Cookie。" }
          try {
            const st = await fetchStatus(s.console, cookie, { fetchImpl })
            const u = userIdentity(st)
            const minted = await mintApiKey(s.console, cookie, { fetchImpl })
            const cookieFile = String(env.MONKEYCODE_COOKIE_FILE ?? "").trim()
            if (cookieFile) {
              try {
                writeSessionCookie(cookieFile, cookie, { domain: hostOf(s.console) })
              } catch (e) {
                log("warn", `会话写回失败：${e?.message ?? e}`)
              }
            }
            return {
              type: "success",
              refresh: minted.key,
              access: minted.secret,
              expires: Date.now() + 6 * 24 * 3600 * 1000,
              uid: u.id,
              metadata: {
                secret: minted.secret,
                cookie,
                base: s.proxy,
                email: u.email,
                uid: u.id,
                keyId: minted.id,
                source: "cookie",
              },
            }
          } catch (e) {
            return {
              type: "failed",
              error:
                `会话无效或铸造 key 失败：${e?.message ?? e}。` +
                `请确认复制的是 ${s.console} 登录后的 ${SESSION_COOKIE}，且没有过期。`,
            }
          }
        },
      },
    ]

    // 按地区裁剪方法表：微信扫码（百智账号站）只有国内版有；
    // 「设置密码」邮件是给 GitHub/Google 注册的国际版账号的，国内版去掉它。
    const drop = (needle) => {
      const at = methods.findIndex((m) => m.label?.includes(needle))
      if (at >= 0) methods.splice(at, 1)
    }
    if (s.id !== "monkeycode") drop("微信扫码")
    if (s.id === "monkeycode") drop("设置密码」邮件")

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
      let cred = credentialOf(auth)
      if (!cred.cookie) {
        // 账号记录里没有会话（历史记录 / 手填时没填 / 会话过期被静默丢弃）——
        // 先试着把会话要回来，再判「不可签」。会话有效就铸新 key，
        // 过期就用服务器上存的口令或百智云 OAuth 桥重建。
        try {
          const next = await renewAccount(s, { auth, env, fetchImpl, log })
          cred = {
            ...cred,
            cookie: String(next?.metadata?.cookie ?? ""),
            key: next?.key || cred.key,
            secret: String(next?.metadata?.secret ?? "") || cred.secret,
          }
        } catch (e) {
          return {
            outcome: "ineligible",
            message: `未保存控制台 Cookie，且自动续期失败：${e?.message ?? e}`,
          }
        }
        if (!cred.cookie) {
          return { outcome: "ineligible", message: "未保存控制台 Cookie，无法查询签到状态。" }
        }
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
          // A 通道没领到（已领过 / 会话过期 / 上游报错）也要说出来，
          // 否则界面上只剩 B 的一句「今日已签到」，看着像 A 根本没跑。
          return {
            outcome: b.outcome,
            message: `${b.message}；百智云：${a.message || a.outcome}`,
          }
        } catch (e) {
          log("warn", `A 通道每日临时额度领取失败：${e?.message ?? e}`)
          return { outcome: b.outcome, message: `${b.message}；百智云领取失败：${e?.message ?? e}` }
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
      const filtered = onlyBilled(filterByPlan(base, plan), rates)
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

        methods,
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
