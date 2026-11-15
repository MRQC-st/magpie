// 服务器端长期凭据库（口令等）。
//
// 为什么单独一个文件，而不是塞进 plugin-auth.json：
//   plugin-auth.json 能被 magpie 的**网页界面**读到（magpie.sunfolower.cn），
//   里面放口令等于把口令暴露给任何能开网页的人。
//   这个文件 600 权限，只有服务器上的进程读得到。
//
// 形状：
//   { "accounts": { "<uid 或 email>": { "email": "...", "password": "..." } } }

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// credentialsPath 凭据库路径。
export function credentialsPath(env = process.env) {
  const override = String(env.MONKEYCODE_CREDENTIALS_FILE ?? "").trim()
  if (override) return override
  const home = homedir()
  if (process.platform === "win32") {
    const appData = String(env.APPDATA ?? "").trim()
    if (appData) return join(appData, "magpie", "monkeycode-credentials.json")
    return join(home, "AppData", "Roaming", "magpie", "monkeycode-credentials.json")
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "magpie", "monkeycode-credentials.json")
  }
  return join(home, ".config", "magpie", "monkeycode-credentials.json")
}

// readStore 读凭据库，坏了就当空的（**不**抛：凭据库坏了不该让插件整个挂掉）。
export function readStore(env = process.env) {
  const p = credentialsPath(env)
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"))
    const accounts = raw && typeof raw.accounts === "object" && raw.accounts ? raw.accounts : {}
    return { path: p, accounts }
  } catch {
    return { path: p, accounts: {} }
  }
}

// writeStore 写凭据库：临时文件 + rename（原子），权限 600。
export function writeStore(accounts, env = process.env) {
  const p = credentialsPath(env)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
  try {
    // rename 保留原文件的权限位；显式再 chmod 一次，确保是 600。
    chmodSync(p, 0o600)
  } catch {
    /* 权限改不了就算了（Windows 上没有 600 的概念） */
  }
  return p
}

// accountKeyOf 取账号在凭据库里的键：优先 uid，其次 email。
export function accountKeyOf(identity) {
  const uid = String(identity?.uid ?? "").trim()
  if (uid) return uid
  const email = String(identity?.email ?? "").trim().toLowerCase()
  return email
}

// saveSecret 存一个账号的口令。
export function saveSecret(identity, secret, env = process.env) {
  const key = accountKeyOf(identity)
  if (!key) return { ok: false, reason: "no-identity" }
  const email = String(identity?.email ?? secret?.email ?? "").trim()
  const password = String(secret?.password ?? "")
  if (!password) return { ok: false, reason: "no-password" }
  const store = readStore(env)
  store.accounts[key] = { email, password }
  writeStore(store.accounts, env)
  return { ok: true, key }
}

// loadSecret 读一个账号的口令。
export function loadSecret(identity, env = process.env) {
  const key = accountKeyOf(identity)
  if (!key) return null
  const store = readStore(env)
  const hit = store.accounts[key]
  if (hit) return { email: hit.email ?? identity?.email ?? "", password: hit.password ?? "" }
  // uid 变了（换账号）时按 email 兜底找一次
  const email = String(identity?.email ?? "").trim().toLowerCase()
  if (email) {
    for (const [k, v] of Object.entries(store.accounts)) {
      if (k === email || String(v?.email ?? "").trim().toLowerCase() === email) {
        return { email: v.email ?? identity?.email ?? "", password: v.password ?? "" }
      }
    }
  }
  return null
}

// removeSecret 删一个账号的口令。
export function removeSecret(identity, env = process.env) {
  const key = accountKeyOf(identity)
  const store = readStore(env)
  if (store.accounts[key]) {
    delete store.accounts[key]
    writeStore(store.accounts, env)
    return true
  }
  return false
}

// listSecrets 列出凭据库里的账号（**只出身份，不出口令**）。
export function listSecrets(env = process.env) {
  const store = readStore(env)
  return Object.entries(store.accounts).map(([key, v]) => ({ key, email: v?.email ?? "" }))
}

// exists 凭据库文件在不在。
export function exists(env = process.env) {
  return existsSync(credentialsPath(env))
}
