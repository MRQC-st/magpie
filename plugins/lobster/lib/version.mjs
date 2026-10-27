// 客户端版本号必须跟着客户端走：服务端可能按版本做兼容判定，写死必然腐化
// （参考插件写死 2026.9.23、mrv 写死 2026.9.15，实测真版本已经是 2026.10.16）。
// 首选从客户端 asar 的 package.json 里读，读不到才回退常量并打一条 warn ——
// 静默回退等于下次静默复发。
//
// asar 有 669MB，**只能分段读**：整读会把它整个拽进内存。
// 布局：[u32 headerPickleLen][u32 headerJsonLen][header JSON][对齐][文件数据…]
// 数据区起点 = 16 + headerJsonLen，package.json 的位置由 header 里的 entry.offset/size 给出。

import { closeSync, openSync, readSync } from "node:fs"
import { join } from "node:path"

// 实测到的客户端版本（2026-10-16）；读不到 asar 时的兜底
export const FALLBACK_CLIENT_VERSION = "2026.10.16"

const HEADER_BYTES = 16
const MAX_HEADER = 64 * 1024 * 1024

export function versionFromAsar(asarPath) {
  let fd = -1
  try {
    fd = openSync(asarPath, "r")
    const head = Buffer.alloc(HEADER_BYTES)
    if (readSync(fd, head, 0, HEADER_BYTES, 0) < HEADER_BYTES) return null
    const headerJsonLen = head.readUInt32LE(12)
    if (!headerJsonLen || headerJsonLen > MAX_HEADER) return null
    const raw = Buffer.alloc(headerJsonLen)
    if (readSync(fd, raw, 0, headerJsonLen, HEADER_BYTES) < headerJsonLen) return null
    const header = JSON.parse(raw.toString("utf8"))
    const entry = header?.files?.["package.json"]
    if (!entry?.size) return null
    const size = Number(entry.size)
    const from = HEADER_BYTES + headerJsonLen + Number(entry.offset || 0)
    // 多读一点：数据区起点后有 NUL 对齐填充，package.json 的第一个非零字节才是 '{'
    const buf = Buffer.alloc(size + 16)
    if (readSync(fd, buf, 0, buf.length, from) < size) return null
    const at = buf.indexOf(0x7b) // '{'
    if (at < 0) return null
    // 按 entry.size 精确切出：多切会带上下一个文件的字节 → JSON.parse 尾部报错
    const pkg = JSON.parse(buf.subarray(at, at + size).toString("utf8"))
    const v = pkg?.version
    return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null
  } catch {
    return null
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch {} }
  }
}

export function asarCandidates(env = process.env) {
  const list = []
  if (env.LOBSTER_ASAR_PATH) list.push(String(env.LOBSTER_ASAR_PATH))
  const home = env.HOME || env.USERPROFILE || ""
  if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, "Programs", "LobsterAI", "resources", "app.asar"))
  if (env.APPDATA) list.push(join(env.APPDATA, "LobsterAI", "resources", "app.asar"))
  list.push("D:/Software/Labsterai/LobsterAI/resources/app.asar")
  if (home) list.push(join(home, ".local", "share", "LobsterAI", "resources", "app.asar"))
  list.push("/Applications/LobsterAI.app/Contents/Resources/app.asar")
  return list
}

// 懒求值 + 缓存：每个进程只读一次 asar
let cached = null
let warned = false

export function clientVersion({ log, env = process.env, reset = false } = {}) {
  if (reset) { cached = null; warned = false }
  if (cached) return cached
  const forced = env.LOBSTER_CLIENT_VERSION
  if (forced) { cached = String(forced); return cached }
  for (const p of asarCandidates(env)) {
    const v = versionFromAsar(p)
    if (v) { cached = v; return v }
  }
  if (!warned) {
    warned = true
    try { log?.("warn", `LobsterAI 客户端版本读不到 → 回退常量 ${FALLBACK_CLIENT_VERSION}`) } catch {}
  }
  cached = FALLBACK_CLIENT_VERSION
  return cached
}

// magpie 的 client.app.log 有两种可能形状（对象式 / 位置参数），
// 哪种能用就用哪种 —— 日志写不进去绝不能把插件带崩。
export function makeLogger(client) {
  const log = client?.app?.log
  if (typeof log !== "function") return null
  return (level, message) => {
    try { log({ type: level, message: String(message), service: "lobster" }) }
    catch { try { log(level, String(message)) } catch {} }
  }
}
