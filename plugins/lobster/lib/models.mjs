// /api/models/available 的条目 → magpie 的运行时模型。
// 运行时模型用嵌套的 capabilities；config 钩子用扁平字段（见 constants.configModel）。

import { NPM, DEFAULT_OUTPUT, DEFAULT_CONTEXT, configModel } from "./constants.mjs"
import { variantsOf } from "./thinking.mjs"

export function runtimeModel(entry, base = {}) {
  const id = String(entry.modelId ?? "")
  const image = !!entry.supportsImage
  const profile = entry.thinkingConfig
  const hasThinking = !!entry.supportsThinking && Array.isArray(profile?.options) && profile.options.length > 0

  return {
    ...base,
    id,
    providerID: base.providerID,
    name: String(entry.modelName ?? id),
    api: { id, url: "", npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: Number(entry.contextWindow) || DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: hasThinking,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: hasThinking ? variantsOf(profile) : {},
    // magpie 自己的字段：一次请求消耗的点数倍率
    rate: Number(entry.costMultiplier) || 0,
  }
}

export function modelsFromCatalog(list, provider) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || entry.accessible === false) continue
    const id = String(entry.modelId ?? "")
    if (!id) continue
    const was = provider?.models?.[id] ?? {}
    out[id] = runtimeModel(entry, { ...was, providerID: provider?.id })
  }
  return out
}

export function profileOfFrom(list) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry?.modelId ?? "")
    if (id && entry.thinkingConfig) out[id] = entry.thinkingConfig
  }
  return out
}


// ── openclaw 托管目录 → magpie 的运行时模型 ──────────────────────────
// 云端没有 /models 路径（实测 404），目录由客户端 openclaw 托管配置同步到本地。
// 这一层是**正常降级**：读不到就返回 null，绝不抛异常。
//
// openclaw 条目形状：{ id, name(上游真名), input[], contextWindow, reasoning }
// → magpie 形状：id+api.id / name / limit.context / capabilities.input+attachment / capabilities.reasoning
export function managedModel(entry, base = {}) {
  const id = String(entry?.id ?? "")
  if (!id) return null
  const input = Array.isArray(entry.input) && entry.input.length ? entry.input : ["text"]
  const image = input.includes("image")
  const reasoning = entry.reasoning === true
  return {
    ...base,
    id,
    providerID: base.providerID,
    name: String(entry.name ?? id),
    api: { id, url: "", npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: Number(entry.contextWindow) || DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    // 托管目录不带 thinkingConfig ⇒ 不给档位（宁可不发，也别发错档位表）
    variants: {},
    rate: 0,
  }
}

export function modelsFromManaged(list, provider) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    const m = managedModel(entry, { providerID: provider?.id })
    if (!m) continue
    out[m.id] = m
  }
  return out
}


// 扁平 config 形状（constants.configModel 产出的）→ magpie 的运行时模型。
// 静态兜底表是扁平形状，但 provider.models 要的是运行时形状 ⇒ 这里做一次转换。
export function modelsFromConfig(map, provider) {
  const out = {}
  for (const [id, m] of Object.entries(map ?? {})) {
    if (!id || !m) continue
    const input = Array.isArray(m.modalities?.input) ? m.modalities.input : ["text"]
    const image = input.includes("image")
    out[id] = {
      id,
      providerID: provider?.id,
      name: String(m.name ?? id),
      api: { id, url: "", npm: NPM },
      status: "active",
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: Number(m.limit?.context) || DEFAULT_CONTEXT, output: Number(m.limit?.output) || DEFAULT_OUTPUT },
      capabilities: {
        temperature: true,
        reasoning: !!m.reasoning,
        attachment: image,
        toolcall: m.tool_call !== false,
        input: { text: true, image, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      rate: 0,
    }
  }
  return out
}

// 未登录时 config 钩子用的扁平形状
export function configModels(list) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || entry.accessible === false) continue
    const id = String(entry.modelId ?? "")
    if (!id) continue
    out[id] = configModel({
      name: String(entry.modelName ?? id),
      context: Number(entry.contextWindow) || DEFAULT_CONTEXT,
      output: DEFAULT_OUTPUT,
      reasoning: !!entry.supportsThinking,
      image: !!entry.supportsImage,
    })
  }
  return out
}
