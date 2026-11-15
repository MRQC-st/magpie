// 站点常量：国内版 / 国际版各一份，以及共享的签名与协议常量。
//
// 一个包两个供应商（社区惯例，见 magicrew 插件）：
//   monkeycode       国内版 monkeycode-ai.com  / proxy.monkeycode-ai.com/v1
//   monkeycode-intl  国际版 monkeycode-ai.net   / proxy.monkeycode-ai.net/v1
//
// 两版的**端点路径逐字相同**，只有主机名不同 —— 上游客户端里
// `mc_call()` 把 `/api/v1/users/*` 直接拼在 svc.ep.monkeycode 后面，
// 没有任何按地区分支的路径逻辑。所以这里只切主机，不切路径。

export const SITES = {
  cn: {
    id: "monkeycode",
    label: "MonkeyCode 国内版",
    short: "MonkeyCode",
    console: "https://monkeycode-ai.com",
    proxy: "https://proxy.monkeycode-ai.com/v1",
    // 账号站（百智云）只有国内版 —— 上游 `MC_DESKTOP_BAIZHI_URL`
    // 的默认值是 https://baizhi.cloud，不随地区变。
    account: "https://baizhi.cloud",
  },
  intl: {
    id: "monkeycode-intl",
    label: "MonkeyCode 国际版",
    short: "MonkeyCode Intl",
    console: "https://monkeycode-ai.net",
    proxy: "https://proxy.monkeycode-ai.net/v1",
    account: "https://baizhi.cloud",
  },
}

// 签名的 system 文本。**必须逐字节不变**：改了这里，
// 本插件算出的每个签名都失效。
export const SIGN_PROMPT = "You are a helpful assistant."

export const AGENT_UA = "ohmyagent f6b21ad"
export const ANTHROPIC_VERSION = "2023-06-01"
export const DEFAULT_MAX_TOKENS = 16384
export const MAX_TOKENS_CAP = 32000

export const CONTEXT_WINDOW = 200000
export const MAX_OUTPUT = 32000

export const ANTHROPIC_NPM = "@ai-sdk/anthropic"
export const RESPONSES_NPM = "@ai-sdk/openai"

// 提前多久续期。官方云的会话 cookie 只有 7 天，所以留 24 小时余量。
export const REFRESH_LEAD_MS = 24 * 3600 * 1000

// 渠道前缀（magpie 的 model id 形如 `monkeycode/basic/deepseek-flash`）
export const CHANNEL_PREFIX = "monkeycode/"
export const TIERS = ["basic", "pro", "ultra"]

// 官方客户端 settings.json 里列出的托管模型。
// 与上游社区插件 0.1.1 的表一致（2026-10-23 对过控制台可见集合）。
export const MODEL_IDS = [
  "basic/deepseek-flash",
  "basic/glm-5.3-flash",
  "basic/kimi-k2.5",
  "basic/minimax-m2.5",
  "basic/qwen3.5-plus",
  "basic/qwen3.8-flash",
  "pro/deepseek-flash",
  "pro/glm-5",
  "pro/hy3",
  "pro/kimi-k2.6",
  "pro/minimax-m3",
  "pro/qwen3.6-plus",
  "pro/gpt-5.6-terra",
  "ultra/glm-5.1",
  "ultra/qwen3.7-max",
  "ultra/gpt-5.6-sol",
  "ultra/gpt-6-astra",
  "deepseek-flash",
  "glm-5.1",
  "glm-5",
  "kimi-k2.6",
  "minimax-m2.5",
  "minimax-m3",
  "qwen3.6-plus",
  "qwen3.7-max",
]

// 这些模型走 Responses 端点（`/v1/responses`），走 /messages 会 404。
export const RESPONSES_MODELS = new Set([
  "basic/qwen3.8-flash",
  "pro/gpt-5.6-terra",
  "ultra/gpt-5.6-sol",
  "ultra/gpt-6-astra",
])

// Responses 请求里 MonkeyCode 不认的字段。
export const RESPONSES_DROP = [
  "store",
  "include",
  "prompt_cache_key",
  "metadata",
  "service_tier",
  "parallel_tool_calls",
  "truncation",
  "user",
  "previous_response_id",
  "background",
  "max_tool_calls",
  "top_logprobs",
  "stream_options",
]

export const MODEL_LABELS = {
  "pro/gpt-5.6-terra": "专业模型 5.6 terra",
  "ultra/gpt-5.6-sol": "极致模型 5.6 sol",
  "ultra/gpt-6-astra": "极致模型 6 astra",
}

export const TIER_LABELS = { basic: "Basic", pro: "Pro", ultra: "Ultra" }

// MonkeyCode 没有「倍率」字段。它控制台给每个模型一个 `input_price`，
// 实际扣的积分正好跟着这个价走（2026-10-23 实测：197 token 的请求
// 在价 100/200/400/600/800 时分别扣 4/8/15/23/30 积分）。
// basic 档的牌价就是天然的 1×，所以倍率 = 价格 / 200。
export const RATE_BASE = 200
export const RATE_TTL_MS = 10 * 60 * 1000

// 签到会话 cookie 的名字。国内版与国际版同名，
// 但**域名不同**（monkeycode-ai.com / monkeycode-ai.net），
// 所以两个 provider 各存各的 —— magpie 的 provider id 天然给了这个隔离。
export const SESSION_COOKIE = "monkeycode_ai_session"
export const ACCOUNT_COOKIE = "baizhi_session"
