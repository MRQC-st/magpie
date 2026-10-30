// 模型目录、签名、请求整形。
//
// 这一层全是纯函数（不碰网络），所以能离线测。

import { createHash, createHmac } from "node:crypto"

import {
  SIGN_PROMPT,
  CHANNEL_PREFIX,
  TIERS,
  MODEL_IDS,
  MODEL_LABELS,
  TIER_LABELS,
  RESPONSES_MODELS,
  RESPONSES_DROP,
  CONTEXT_WINDOW,
  MAX_OUTPUT,
  ANTHROPIC_NPM,
  RESPONSES_NPM,
  RATE_BASE,
} from "./constants.mjs"

// ---- 模型 id ----------------------------------------------------------------

// bareModelID 把各种写法归一成 MODEL_IDS 里的一项。
export function bareModelID(id) {
  let s = String(id ?? "").trim()
  if (s.startsWith(CHANNEL_PREFIX)) s = s.slice(CHANNEL_PREFIX.length)
  if (s.startsWith("monkeycode-")) s = s.slice("monkeycode-".length)
  return s
}

// upstreamModelID 是厂商要的名字：带档位的补 `monkeycode-` 前缀，裸名照发。
export function upstreamModelID(id) {
  const bare = bareModelID(id)
  const slash = bare.indexOf("/")
  if (slash > 0 && TIERS.includes(bare.slice(0, slash))) return "monkeycode-" + bare
  return bare
}

export function labelOf(id) {
  if (MODEL_LABELS[id]) return MODEL_LABELS[id]
  const slash = id.indexOf("/")
  if (slash > 0) {
    const tier = id.slice(0, slash)
    if (TIER_LABELS[tier]) return `${TIER_LABELS[tier]} · ${id.slice(slash + 1)}`
  }
  return id
}

export function isResponsesModel(id) {
  return RESPONSES_MODELS.has(bareModelID(id))
}

// modelEntry 一个模型在 magpie 里的条目。
export function modelEntry(id, rate = 0) {
  const entry = {
    name: labelOf(id),
    id: upstreamModelID(id),
    limit: { context: CONTEXT_WINDOW, output: MAX_OUTPUT },
    tool_call: true,
    reasoning: true,
  }
  // magpie 在模型名旁边显示积分倍率；OpenCode 不看这个字段。
  if (rate > 0) entry.rate = rate
  // 走 Responses 端点的模型要换 npm 包（协议不同）。
  if (isResponsesModel(id)) entry.provider = { npm: RESPONSES_NPM }
  return entry
}

// modelsConfig 生成整张模型表。
export function modelsConfig(rates) {
  return Object.fromEntries(MODEL_IDS.map((id) => [id, modelEntry(id, rates?.get(id) ?? 0)]))
}

// withRates 把积分倍率贴到模型上。
// 控制台没标价的模型**保留没有倍率** —— magpie 于是不画徽章，
// 而不是画一个编出来的数字。
export function withRates(models, rates) {
  if (!rates?.size) return models
  const out = {}
  for (const [id, model] of Object.entries(models)) {
    const rate = rates.get(bareModelID(id)) ?? 0
    out[id] = rate > 0 ? { ...model, rate } : model
  }
  return out
}

// ---- 签名 ------------------------------------------------------------------

// signatureCache 按签名密钥缓存签名。签的是常量文本，所以签名不会过期。
const signatureCache = new Map()

export function signatureOf(secret) {
  const s = String(secret ?? "").trim()
  if (!s) return ""
  const hit = signatureCache.get(s)
  if (hit) return hit
  const value = "v1=" + createHmac("sha256", s).update(SIGN_PROMPT, "utf8").digest("hex")
  signatureCache.set(s, value)
  return value
}

// ---- 请求整形 --------------------------------------------------------------

// applyAnthropic 把签名句放在 system 首位，agent 自己的 system 跟在后面。
// 只有 system[0] 被签名，所以 system[1] 之后可以是动态内容。
export function applyAnthropic(body) {
  const system = body.system
  if (Array.isArray(system) && system[0]?.type === "text" && system[0]?.text === SIGN_PROMPT) {
    // 已经整形过了
  } else if (Array.isArray(system)) {
    body.system = [{ type: "text", text: SIGN_PROMPT }, ...system]
  } else if (typeof system === "string" && system.trim()) {
    body.system = [{ type: "text", text: SIGN_PROMPT }, { type: "text", text: system }]
  } else {
    body.system = [{ type: "text", text: SIGN_PROMPT }]
  }

  const max = Number(body.max_tokens)
  if (!Number.isFinite(max) || max <= 0) body.max_tokens = 16384
  else body.max_tokens = Math.min(Math.trunc(max), 32000)

  delete body.metadata
  return body
}

// applyResponses 做同样的事，但 Responses 端点上被签的是 input[0].content，
// system 提示可能以 `instructions` 或开头的 system/developer 条目出现。
export function applyResponses(body) {
  let input = body.input
  if (typeof input === "string") input = [{ role: "user", content: input }]
  if (!Array.isArray(input)) input = []

  const signed = Array.isArray(input) && input[0]?.role === "system" && input[0]?.content === SIGN_PROMPT
  if (!signed) {
    const rest = input.filter((item) => !(item && item.role === "system" && item.content === SIGN_PROMPT))
    for (const item of rest) {
      if (item && item.role === "developer") item.role = "system"
    }
    const prefix = []
    if (typeof body.instructions === "string" && body.instructions.trim()) {
      prefix.push({ role: "system", content: body.instructions })
    }
    delete body.instructions
    body.input = [{ role: "system", content: SIGN_PROMPT }, ...prefix, ...rest]
  }

  if (body.max_tokens != null) {
    if (body.max_output_tokens == null) body.max_output_tokens = body.max_tokens
    delete body.max_tokens
  }
  const out = Number(body.max_output_tokens)
  if (!Number.isFinite(out) || out <= 0) body.max_output_tokens = 16384
  else body.max_output_tokens = Math.min(Math.trunc(out), 32000)

  for (const field of RESPONSES_DROP) delete body[field]
  return body
}

// pathOf / isResponsesURL 判请求打的是哪个端点。
export function pathOf(url) {
  try {
    return new URL(String(url)).pathname
  } catch {
    return String(url ?? "")
  }
}

export function isResponsesURL(url) {
  return /\/responses\/?$/.test(pathOf(url))
}

// ---- 倍率 ------------------------------------------------------------------

// rateFromPrice 把控制台的 input_price 折成倍率。
export function rateFromPrice(price) {
  const p = Number(price)
  if (!Number.isFinite(p) || p <= 0) return 0
  return p / RATE_BASE
}

// hashOf 是给日志用的短指纹（**不**打印凭据本身）。
export function hashOf(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 8)
}
