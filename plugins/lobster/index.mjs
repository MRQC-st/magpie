// magpie provider 插件：LobsterAI（有道龙虾）。
//
// 入口只装配钩子；逻辑都在 lib/ 下，通过 _internal 暴露给测试。
// ⚠️ 入口**禁止**导出别的函数：magpie 把每个导出的函数都当成一个独立插件加载。
//
// 登录方式固定三条，顺序固定（下标是契约）：
//   0 浏览器登录（有道账号）
//   1 从本机桌面端导入（只读，不存 token）
//   2 从服务器副本导入（换 token，可续期）
//
// 出站地址全部可注入：env LOBSTER_API_BASE（API 根），
// 离线测试把它指向 mock 即可；其余 env 见 lib/constants.mjs。

import {
  PROVIDER,
  NAME,
  NPM,
  FALLBACK_MODELS,
  apiUrl,
  chatBaseUrl,
  clientVersion,
} from "./lib/constants.mjs"
import { makeFetch } from "./lib/proxy.mjs"
import { modelsFromCatalog, profileOfFrom, modelsFromManaged, modelsFromConfig } from "./lib/models.mjs"
import { usageFrom } from "./lib/usage.mjs"
import {
  desktopSignIn,
  desktopToken,
  serverCopyPath,
  readCredentials,
  readKvFromPath,
  isDesktopPath,
  desktopPathCandidates,
  localAttribution,
  dbPath,
} from "./lib/auth-import.mjs"
import { beginSignIn } from "./lib/auth-login.mjs"
import { runCheckin } from "./lib/checkin.mjs"
import { readManagedModels, openclawPath } from "./lib/managed-models.mjs"
import { jwtExp } from "./lib/jwt.mjs"
import { makeLogger } from "./lib/version.mjs"
import {
  refreshBody,
  writeBackToCopy,
  serverCopySignIn,
  fallbackModels,
  markFellBack,
  FELL_BACK,
  attributionFor,
  attributionFromPath,
} from "./lib/session.mjs"

const REFRESH_LEAD = 6 * 3600 * 1000

// 每个账号的模型 → 思考档位，供请求管线查表
const profiles = new Map()

// plugins.json 的 options 字段 → 运行期 env 覆盖。
//
// ⚠️ process.env 要**现读**，不能在建插件时快照一份：调用方（测试、运维脚本）
//    可能在插件装配之后才改环境变量。快照会让改动看不见。
//    ⇒ 用 Proxy：覆盖项优先，其余回落到实时的 process.env。
function envOf(options) {
  const o = options ?? {}
  const over = {}
  if (o.env && typeof o.env === "object") {
    for (const [k, v] of Object.entries(o.env)) {
      if (typeof v === "string") over[k] = v
    }
  }
  if (typeof o.apiBase === "string" && o.apiBase.trim()) over.LOBSTER_API_BASE = o.apiBase.trim()
  if (typeof o.serverCopyDb === "string" && o.serverCopyDb.trim()) over.LOBSTER_SERVER_COPY_DB = o.serverCopyDb.trim()
  if (typeof o.openclawPath === "string" && o.openclawPath.trim()) over.LOBSTER_OPENCLAW_PATH = o.openclawPath.trim()
  if (typeof o.loginUrl === "string" && o.loginUrl.trim()) over.LOBSTER_LOGIN_URL = o.loginUrl.trim()
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

async function apiGet(path, token, { env = process.env, timeout = 20_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(apiUrl(env) + path, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let v
  try { v = JSON.parse(text) } catch { throw new Error(`LobsterAI ${path}: 响应无法解析`) }
  if (res.status === 401) {
    throw Object.assign(new Error("LobsterAI 的登录已过期，请重新登录"), { signIn: "expired" })
  }
  if (v?.code !== 0) throw new Error(`LobsterAI ${path}: ${v?.message || `code ${v?.code}`}`)
  return v.data
}

// 取这次请求要用的 token。
// 桌面端导入的账号自己不存 token（见 lib/auth-import.mjs），每次现读 ——
// 桌面端续期后插件自动跟上。读不到就抛 signIn:"expired"。
async function tokenOf(auth, env = process.env) {
  if (!auth) return ""
  if (auth.source === "desktop") return desktopToken(env)
  return auth.type === "oauth" ? (auth.access ?? "") : (auth.key ?? "")
}

export const LobsterAuthPlugin = async (input, options) => {
  const env = envOf(options)
  const log = makeLogger(input)
  const fetchImpl = typeof options?.fetch === "function" ? options.fetch : fetch

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: NAME,
        npm: NPM,
        api: chatBaseUrl(env),
        models: FALLBACK_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,
      refreshLead: REFRESH_LEAD,

      methods: [
        {
          type: "oauth",
          label: "浏览器登录（有道账号）",
          async authorize() {
            // 由 magpie 打开这个 url；插件不再自己开一次，否则会开两个标签页
            const pending = await beginSignIn({ env })
            return {
              url: pending.url,
              instructions: "在浏览器里用有道账号登录，完成后回到这里。",
              method: "auto",
              callback: () => pending.finish(),
            }
          },
        },
        {
          // 必须是 oauth：api 类型会让 magpie 强制从 stdin 读一个 key，
          // 而这条路根本不需要用户输入任何东西（见设计文档 §4.3）。
          type: "oauth",
          label: "从本机 LobsterAI 导入登录",
          async authorize() {
            // url 留空：magpie 不打开任何页面，直接走 callback
            return {
              url: "",
              instructions: "直接使用本机 LobsterAI 桌面端已登录的账号。",
              method: "auto",
              async callback() {
                try {
                  return desktopSignIn(env)
                } catch (e) {
                  return { type: "failed", error: e.message }
                }
              },
            }
          },
        },
        {
          // 下标 2：服务器副本导入 —— 读副本里的 refreshToken 换一对新 token。
          // 这条路**能续期**（有 refresh + expires），因此会落盘成 oauth 账号。
          type: "oauth",
          label: "从服务器副本导入（换 token）",
          async authorize() {
            return {
              url: "",
              instructions: "从服务器上的 LobsterAI 凭据副本换取 token（零交互）。",
              method: "auto",
              async callback() {
                try {
                  return await serverCopySignIn({ env, fetchImpl })
                } catch (e) {
                  return { type: "failed", error: e.message }
                }
              },
            }
          },
        },
      ],

      // 只对带 refresh 的 oauth 账号生效。
      // 桌面端导入的账号 refresh 是空串、expires 为 0，magpie 不会调用这里，
      // 桌面端的会话因此不会被搅动（auth.source === 'desktop' 的早退保留）。
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.refresh) return {}
        // body 带归因字段：uuid（installation_uuid）/ userId（auth_user.id）/ version
        const body = refreshBody({ refreshToken: auth.refresh, auth, env })
        const res = await fetchImpl(apiUrl(env) + "/auth/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await res.text()
        let v
        try { v = JSON.parse(text) } catch { throw new Error("LobsterAI 续期：响应无法解析") }
        if (v?.code !== 0 || !v?.data?.accessToken) {
          throw Object.assign(new Error(`LobsterAI 续期失败：${v?.message || `code ${v?.code}`}`), { signIn: "expired" })
        }
        const d = v.data
        const access = String(d.accessToken)
        const refresh = String(d.refreshToken ?? auth.refresh)
        // 回写服务器副本（**本机桌面端库绝不写**）；失败不影响主流程
        writeBackToCopy({
          path: auth.copyPath ?? serverCopyPath(env),
          next: { accessToken: access, refreshToken: refresh },
          prev: { refreshToken: auth.refresh },
          env,
          log,
        })
        return {
          access,
          refresh,
          // 上游可能不给新 token 的 exp；读不到就沿用旧的到期时间
          expires: jwtExp(access) || auth.expires || 0,
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        // 这里只是给 magpie 一个「看起来已登录」的信号；真正的 token
        // 由下面的 fetch 每次请求现取（桌面端账号尤其需要）。
        let token = ""
        try { token = await tokenOf(auth, env) } catch { return {} }
        if (!token) return {}
        return {
          baseURL: chatBaseUrl(env),
          apiKey: token,
          headers: {},
          fetch: makeFetch({
            getAuth,
            tokenOf: (a) => tokenOf(a, env),
            profileOf: (id) => profiles.get(String(id)),
            call: (input, init) => fetchImpl(input, init),
            version: clientVersion(env, log),
            env,
          }),
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        let token = ""
        try { token = await tokenOf(auth, env) } catch (e) {
          return { error: e.message, windows: [], signIn: e.signIn === "expired" ? "expired" : "kept" }
        }
        if (!token) return { error: "尚未登录", windows: [] }
        try {
          const [quota, profile] = await Promise.all([
            apiGet("/user/quota", token, { env, fetchImpl }),
            apiGet("/user/profile-summary", token, { env, fetchImpl }),
          ])
          // 插件自己不续期（交给 magpie 的 auth.refresh），所以这次请求用的
          // 就是存下来的 token —— 如实报 kept。社区插件报 renewed 是因为它们
          // 自己维护续期表，这里没有那张表，不该照抄。
          return usageFrom(quota, profile, "kept")
        } catch (e) {
          return {
            error: e.message,
            windows: [],
            signIn: e.signIn === "expired" ? "expired" : "kept",
          }
        }
      },

      // 每日签到。token 来源分叉：
      //   source === 'desktop' → 现读桌面端库（桌面端自己续期后的新 token）
      //   oauth                → auth.access（magpie 续期后的新 token）
      async checkin(getAuth) {
        const auth = await getAuth()
        let token = ""
        try {
          token = await tokenOf(auth, env)
        } catch (e) {
          throw new Error(e?.message ?? "LobsterAI 登录信息不可用")
        }
        if (!token) throw new Error("尚未登录，无法签到")
        // 签到请求用**动态**的客户端版本号
        return await runCheckin({
          token,
          version: clientVersion(env, log),
          env,
          fetchImpl,
        })
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        let token = ""
        try { token = await tokenOf(auth, env) } catch (e) {
          if (e.signIn === "expired") throw e
          return provider.models
        }
        if (!token) return provider.models
        try {
          const list = await apiGet(
            "/models/available?firstKeyfrom=official&latestKeyfrom=official",
            token,
            { env, fetchImpl },
          )
          // 云端没给可用目录 → 降级（openclaw → 静态表）
          if (!Array.isArray(list) || list.length === 0) return fallbackModels(provider, env)
          for (const [id, p] of Object.entries(profileOfFrom(list))) profiles.set(id, p)
          const out = modelsFromCatalog(list, { ...provider, id: PROVIDER })
          return Object.keys(out).length > 0 ? out : fallbackModels(provider, env)
        } catch (e) {
          // 登录失效要标记账号；其余情况走降级（openclaw → 静态表）
          if (e.signIn === "expired") throw e
          return fallbackModels(provider, env)
        }
      },
    },
  }
}

// 唯一允许的函数导出：magpie 会把每个导出的函数都当成一个插件加载。
// 新模块的可测部分全部挂在这里。
export const _internal = {
  // 身份与常量
  PROVIDER,
  FALLBACK_MODELS,
  usageFrom,
  // 模型
  modelsFromCatalog,
  modelsFromManaged,
  modelsFromConfig,
  profileOfFrom,
  fallbackModels,
  markFellBack,
  FELL_BACK,
  readManagedModels,
  openclawPath,
  // 签到
  runCheckin,
  // 出站与版本
  clientVersion,
  apiUrl,
  chatBaseUrl,
  makeFetch,
  envOf,
  // 凭据读取（只读）
  desktopSignIn,
  desktopToken,
  desktopTokenOnly: desktopToken,
  readCredentials,
  readKvFromPath,
  dbPath,
  serverCopyPath,
  isDesktopPath,
  desktopPathCandidates,
  localAttribution,
  // 会话与续期
  serverCopySignIn,
  refreshBody,
  writeBackToCopy,
  attributionFor,
  attributionFromPath,
}
