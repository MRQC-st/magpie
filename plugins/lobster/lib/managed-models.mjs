// 客户端 openclaw 托管配置里的模型目录（云端没有 /models 路径，目录由客户端同步到这里）。
// 路径：%APPDATA%/LobsterAI/openclaw/state/openclaw.json（env LOBSTER_OPENCLAW_PATH 可覆盖）。
//
// 条目形状：{ id, name(上游真名), input[], contextWindow, reasoning }
// ⚠️ id 是客户端别名，name 才是真名（如 deepseek-flash = DeepSeek-V4.1-Flash）。
// ⚠️ 快照会增长（实测 7 个 → 34 个），所以按 mtime 缓存，不写死条目。

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export function openclawPath(env = process.env) {
  const v = env?.LOBSTER_OPENCLAW_PATH
  if (typeof v === "string" && v.trim()) return v.trim()
  const home = env?.HOME || env?.USERPROFILE || ""
  const appdata = env?.APPDATA || (home ? join(home, "AppData", "Roaming") : "")
  return join(appdata, "LobsterAI", "openclaw", "state", "openclaw.json")
}

let cache = { path: "", mtime: -1, list: null }

export function resetManagedModelsCache() {
  cache = { path: "", mtime: -1, list: null }
}

// 读不到 / 结构不对 → null（这是**正常降级**，不是错误）
export function readManagedModels(env = process.env) {
  const path = openclawPath(env)
  let st
  try { st = statSync(path) } catch { return null }
  const mtime = st.mtimeMs
  if (cache.path === path && cache.mtime === mtime && cache.list) return cache.list

  let cfg
  try { cfg = JSON.parse(readFileSync(path, "utf8")) } catch { return null }
  const providers = cfg?.models?.providers
  if (!providers || typeof providers !== "object") return null
  // 首选 lobsterai-server；provider 键名变了就退而取唯一一个带 models 的 provider
  const raw =
    providers["lobsterai-server"]?.models ??
    Object.values(providers).find((p) => Array.isArray(p?.models) && p.models.length)?.models
  if (!Array.isArray(raw) || raw.length === 0) return null

  const list = raw
    .filter((m) => typeof m?.id === "string" && m.id)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      input: Array.isArray(m.input) && m.input.length ? m.input.map(String) : ["text"],
      contextWindow: Number(m.contextWindow) || undefined,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
    }))
  if (!list.length) return null
  cache = { path, mtime, list }
  return list
}
