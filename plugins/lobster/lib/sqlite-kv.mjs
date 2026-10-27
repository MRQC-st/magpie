// node:sqlite 的最小封装：**只读连接与可写连接严格分离**。
//
// 为什么不用 bun:sqlite：插件宿主是 Bun，但测试与部分运行环境是 node v24，
// node:sqlite 在 Bun 1.4.2 与 node v24 双端都可用（DatabaseSync + exec）。
// bun:sqlite 在 node 下根本 import 不了 ⇒ 一旦被 import 进去，整个入口在 node 下都加载失败。
//
// 🔴 为什么**不用 prepare()**：Bun 的 node:sqlite 实现里，一个 prepare() 出来的
//    语句会把 sqlite 句柄留到 GC 才释放 ⇒ 即使 db.close() 了，Windows 上文件
//    仍被锁着（EBUSY），临时目录删不掉、桌面端的库也一直占着文件句柄。
//    实测：Bun 下 prepare() → close() → rmSync 报 EBUSY；只用 exec() 则干净。
//    node v24 没有这个问题，但两端走同一条路最省事。
//    ⇒ 这里所有读走 exec() + db.function() 回调取行，所有写走 exec() 拼字面量。
//
// 只读连接：new DatabaseSync(path, { readOnly: true })
// 可写连接：new DatabaseSync(path)      —— 必须是另开的一个连接
//
// ⚠️ 值是**双层 JSON 字符串**：sqlite 里存的是 JSON.stringify(JSON.stringify(obj))。
//    一次 parse 只得到一个字符串，得再 parse 一次；而 installation_uuid 是**裸字符串**，
//    JSON.parse 会失败 —— 原样返回才是对的（不能被「必须是对象」的守卫丢掉）。

import { DatabaseSync } from "node:sqlite"
import { existsSync } from "node:fs"

export function openReadonly(path) {
  if (!path || !existsSync(path)) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

export function openWritable(path) {
  if (!path || !existsSync(path)) return null
  try {
    return new DatabaseSync(path)
  } catch {
    return null
  }
}

export function closeDb(db) {
  try { db?.close() } catch { /* 已关闭就算了 */ }
}

// SQL 字面量：单引号加倍转义。值只来自插件内部（token / uuid / 表结构），
// 不接受外部输入拼进 SQL。
export function sqlText(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

// 值的归一化：双层 JSON → 对象；裸字符串 → 原样
export function normalizeValue(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string") return raw
  let v
  try { v = JSON.parse(raw) } catch { return raw } // 裸值（installation_uuid）
  if (typeof v === "string") {
    try { v = JSON.parse(v) } catch { return v } // 双层的第二层不是 JSON：仍按字符串用
  }
  return v
}

// 只在值确实是对象时返回它（auth_tokens / auth_user 用）
export function jsonOf(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null
}

// 一次 SELECT 取多个键（auth_tokens / auth_user / installation_uuid）
// 走 exec + 自定义函数收集行：不用 prepare()，避免 Bun 下的文件句柄泄漏。
export function readKvMap(db, keys) {
  const out = {}
  if (!db || !Array.isArray(keys) || keys.length === 0) return out
  const list = keys.map(sqlText).join(",")
  const rows = []
  try {
    db.function("__lobster_kv_row", (k, v) => {
      rows.push([k, v])
      return null
    })
    db.exec(
      "SELECT __lobster_kv_row(key, value) FROM kv WHERE key IN (" + list + ")",
    )
  } catch {
    return out
  }
  for (const [k, v] of rows) out[k] = normalizeValue(v)
  return out
}

// 单键裸值读取
export function readKv(db, key) {
  const v = readKvMap(db, [key])[key]
  return v === undefined ? null : v
}

// kv 表有没有 updated_at 列（客户端 2026.10 起加了它，且是 NOT NULL 无默认值）
// pragma_table_info 是表值函数，用它就不用 prepare() 了。
export function hasUpdatedAt(db) {
  try {
    const cols = []
    db.function("__lobster_kv_col", (n) => {
      cols.push(n)
      return null
    })
    db.exec("SELECT __lobster_kv_col(name) FROM pragma_table_info('kv')")
    return cols.includes("updated_at")
  } catch {
    return false
  }
}

// 写一个 kv 对象。**必须显式 writable** —— 默认不写。
export function writeKvObject(path, key, obj, { writable = false } = {}) {
  if (!writable) return { ok: false, reason: "write-disabled" }
  if (!path || !existsSync(path)) return { ok: false, reason: "missing-file" }
  const db = openWritable(path)
  if (!db) return { ok: false, reason: "open-failed" }
  try {
    // 双层 stringify：客户端写进去的就是这个形状，抄别的形状客户端会读到坏 JSON
    const value = sqlText(JSON.stringify(JSON.stringify(obj)))
    if (hasUpdatedAt(db)) {
      db.exec(
        "INSERT INTO kv (key, value, updated_at) VALUES (" +
          sqlText(key) + ", " + value + ", " + Date.now() + ") " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
    } else {
      db.exec(
        "INSERT INTO kv (key, value) VALUES (" + sqlText(key) + ", " + value + ") " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) }
  } finally {
    closeDb(db)
  }
}

// 回写 token（accessToken + refreshToken 合并）
export function persistTokens(path, next, prev, opts = {}) {
  const merged = {
    accessToken: String(next?.accessToken ?? ""),
    refreshToken: String(next?.refreshToken || prev?.refreshToken || ""),
  }
  const r = writeKvObject(path, "auth_tokens", merged, opts)
  return r.ok ? { ok: true, merged } : { ok: false, reason: r.reason, merged }
}
