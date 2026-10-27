// LobsterAI（有道龙虾）的固定事实：地址、客户端标识、未登录时的兜底模型表。
// 兜底表只在没登录时显示；登录后由 /api/models/available 的实时结果替换。
//
// ⚠️ 版本号不写死：clientVersion() 走 lib/version.mjs，跟着客户端 asar 里的真版本走。
//    写死必然腐化 —— 参考插件写死 2026.9.23、mrv 写死 2026.9.15，实测真版本已是 2026.10.16。
//
// ⚠️ 出站地址全部可注入：env LOBSTER_API_BASE 指向 API 根（默认 .../api），
//    离线测试把它指到 mock 即可，不必改代码。

import { clientVersion as resolveClientVersion } from "./version.mjs"

export const PROVIDER = "lobster"
export const NAME = "LobsterAI"

export const DEFAULT_BASE = "https://lobsterai-server.youdao.com"
export const DEFAULT_API = DEFAULT_BASE + "/api"
export const DEFAULT_CHAT_BASE = DEFAULT_BASE + "/api/proxy/v1"

// 这三个是「默认值」；运行时一律走下面那几个可注入的函数
export const BASE = DEFAULT_BASE
export const API = DEFAULT_API
export const CHAT_BASE = DEFAULT_CHAT_BASE

export const NPM = "@ai-sdk/openai-compatible"

export const LOGIN_URL = "https://lobsterai.youdao.com/portal#/login"
export const ICON = "https://lobsterai.youdao.com/portal/lobsterai-logo.png"

export const CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1"

// 接口不提供输出上限，取一个保守值（见设计文档 §8）
export const DEFAULT_OUTPUT = 32000
export const DEFAULT_CONTEXT = 1000000

// API 根：env LOBSTER_API_BASE 优先，默认 https://lobsterai-server.youdao.com/api
export function apiUrl(env = process.env) {
  const v = env?.LOBSTER_API_BASE
  if (typeof v === "string" && v.trim()) return v.trim().replace(/\/+$/, "")
  return DEFAULT_API
}

// 对话端点（OpenAI 兼容）在 API 根下面
export function chatBaseUrl(env = process.env) {
  return apiUrl(env) + "/proxy/v1"
}

// 服务器根（去掉尾部的 /api）
export function serverBaseUrl(env = process.env) {
  return apiUrl(env).replace(/\/api$/, "")
}

// 浏览器登录页：env LOBSTER_LOGIN_URL 可覆盖（离线测试用）
export function loginUrl(env = process.env) {
  const v = env?.LOBSTER_LOGIN_URL
  if (typeof v === "string" && v.trim()) return v.trim()
  return LOGIN_URL
}

// 客户端版本：动态求值（每个进程读一次 asar 后缓存）
export function clientVersion(env = process.env, log = null) {
  return resolveClientVersion({ env, log })
}

export function configModel({ name, context, output, reasoning, image }) {
  const input = ["text"]
  if (image) input.push("image")
  return {
    name,
    limit: { context: context || DEFAULT_CONTEXT, output: output || DEFAULT_OUTPUT },
    reasoning: !!reasoning,
    tool_call: true,
    modalities: { input, output: ["text"] },
  }
}

// 静态兜底表：mrv 的 7 个 ∪ 参考插件的 5 个（并集 8 个）。
// ⚠️ kimi-k3 不在云端 /api/models/available 的 29 个里，但实际可用
//    ⇒ 必须留在这张表里，否则登录后也看不到它。
export const FALLBACK_MODELS = {
  "deepseek-flash": configModel({ name: "DeepSeek Flash", reasoning: true }),
  "deepseek-v4-pro": configModel({ name: "DeepSeek V4 Pro", reasoning: true }),
  "glm-5.3": configModel({ name: "GLM-5.3", reasoning: true }),
  "glm-5.3-flash": configModel({ name: "GLM-5.3 Flash", reasoning: true }),
  "glm-5.3-flashx": configModel({ name: "GLM-5.3 FlashX", reasoning: true }),
  "MiniMax-M3": configModel({ name: "MiniMax M3", reasoning: true }),
  "qwen3.8-max": configModel({ name: "Qwen3.8 Max", reasoning: true }),
  "kimi-k3": configModel({ name: "Kimi K3", reasoning: true, image: true }),
}
