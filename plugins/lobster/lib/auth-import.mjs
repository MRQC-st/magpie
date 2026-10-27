// 从 LobsterAI 桌面端（或服务器上的副本）的 sqlite 里读出登录信息。
// 表：CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)
//   auth_tokens       -> {"accessToken":"…","refreshToken":"…"}（**双层** JSON 字符串）
//   auth_user         -> {"yid","userId","nickname",...}（userId 也可能叫 id，见 userIdOf）
//   installation_uuid -> 纯字符串（**不是** JSON 对象）
//
// 🔴 为什么是 node:sqlite 而不是 bun:sqlite：
//    插件宿主是 Bun，但 node:sqlite 在 Bun 1.4.2 与 node v24 双端都可用；
//    bun:sqlite 在 node 下 import 不了 ⇒ 整个入口在 node 下都加载失败。
//
// 🔴 桌面端库**只读**：桌面端可能正在运行，插件绝不写入它的库。
//    写只发生在「服务器副本」上（server-copy），而且必须显式 writable=true，默认不写。
//
// 🔴 桌面端判据**按平台走**（详见 isDesktopPath）：
//    - win32：桌面端客户端真实存在（可能正在运行）⇒ 桌面端路径一律禁写。
//    - darwin/linux：dbPath() 指向的路径与**服务器副本**的默认路径重合，
//      所以它只有在「未被显式声明为服务器副本」时才当作桌面端。
//    - env.LOBSTER_SERVER_COPY_DB 显式声明的路径永远可写（运维指定的可写副本）。

import { existsSync } from "node:fs"
import { win32, posix } from "node:path"
import { jwtExp, accountOf } from "./jwt.mjs"
import { openReadonly, closeDb, readKvMap, readKv, jsonOf } from "./sqlite-kv.mjs"

// 一次要取的三个键：少了 installation_uuid，续期请求的归因字段永远拿不到 uuid
export const KV_KEYS = ["auth_tokens", "auth_user", "installation_uuid"]

// 桌面端库路径。platform 可注入（默认 process.platform）。
// ⚠️ join 用**平台对应**的实现（win32.join / posix.join）：
//    node:path 的 join 是宿主平台相关的，测试要能在 Windows 上模拟 Linux 布局，
//    就不能跟着宿主走。真实平台上 win32→win32.join、darwin/linux→posix.join，
//    与原生 join 逐字相同 ⇒ 生产行为不变。
export function dbPath(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || ""
  const join = platform === "win32" ? win32.join : posix.join
  if (platform === "win32") {
    const appdata = env.APPDATA || (home ? join(home, "AppData", "Roaming") : "")
    return join(appdata, "LobsterAI", "lobsterai.sqlite")
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "LobsterAI", "lobsterai.sqlite")
  }
  const cfg = env.XDG_CONFIG_HOME || join(home, ".config")
  return join(cfg, "LobsterAI", "lobsterai.sqlite")
}

// 服务器上的副本：路径由 env 指定，**没有默认** —— 没有它就不写任何东西
export function serverCopyPath(env = process.env) {
  const v = env?.LOBSTER_SERVER_COPY_DB
  if (typeof v === "string" && v.trim()) return v.trim()
  return null
}

// 桌面端路径的候选集合。
// 判据不能只比一条路径：env 里的 APPDATA 可能缺失或被改写，
// 因此把「可能的桌面端路径」都算出来再比。
// ⚠️ platform 可注入：桌面端路径布局随平台不同（%APPDATA% / ~/Library / ~/.config），
//    测试要能同时验 Windows 与 Linux 两套布局，不必真的换机器。
export function desktopPathCandidates(env = process.env, platform = process.platform) {
  const list = new Set()
  const add = (e) => { try { list.add(dbPath(e, platform)) } catch { /* 忽略 */ } }
  add(env)
  // APPDATA 缺失时的两种退化形态
  const noAppdata = { ...env }
  delete noAppdata.APPDATA
  add(noAppdata)
  const noCfg = { ...noAppdata }
  delete noCfg.XDG_CONFIG_HOME
  add(noCfg)
  return [...list]
}

// 路径归一：分隔符统一成 /，去掉结尾的 /，再把 . 与 .. 段折叠掉
//   - normPath：保留大小写（Linux/macOS 上路径**区分**大小写）
//   - normLoose：再折大小写（Windows 上路径不区分大小写）
const normPath = (p) => {
  const raw = String(p).replace(/\\/g, "/").replace(/\/+$/, "")
  const abs = raw.startsWith("/")
  const parts = []
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") { parts.pop(); continue }
    parts.push(seg)
  }
  return (abs ? "/" : "") + parts.join("/")
}
const normLoose = (p) => normPath(p).toLowerCase()

// 同一路径的相等判断：win32 不区分大小写，其它平台区分
const samePath = (a, b, platform) =>
  platform === "win32" ? normLoose(a) === normLoose(b) : normPath(a) === normPath(b)

// 桌面端库永远只读 —— 但「桌面端库」这个判据要**分平台**：
//
// 🔴 为什么不能一刀切：
//    dbPath() 在 Linux 上返回 ~/.config/LobsterAI/lobsterai.sqlite，
//    与**服务器副本**的默认路径完全一样。无头服务器上没有正在运行的桌面客户端，
//    那里同一路径就是「服务器副本」；一刀切会让副本永远回写不了（token 不保鲜）。
//
// 判据（两条，顺序不能反）：
//   1) **显式声明优先**：env.LOBSTER_SERVER_COPY_DB 指向的路径是运维明确指定的
//      可写副本 —— 桌面端判据对其它路径生效，对它不生效。
//   2) **平台判据**：win32 上桌面端客户端真实存在（可能正在运行）⇒ 桌面端数据
//      目录里的任何文件都禁写；darwin/linux 上没有正在运行的桌面客户端，
//      dbPath() 指向的位置是**服务器副本**的默认位置 ⇒ 它只有在「未被显式声明
//      为服务器副本」时才当作桌面端。
export function isDesktopPath(path, env = process.env, platform = process.platform) {
  if (!path) return false
  const copy = serverCopyPath(env)
  // 1) 显式声明的服务器副本：永远可写
  if (copy && samePath(copy, path, platform)) return false
  // 2) 桌面端路径：禁写
  const target = normLoose(path)
  return desktopPathCandidates(env, platform).some((p) => {
    const c = normLoose(p)
    if (c === target) return true
    // 桌面端数据目录里的**任何**文件都不写（不只是那一个 .sqlite）
    const dir = c.slice(0, c.lastIndexOf("/"))
    return dir.length > 0 && target.startsWith(dir + "/")
  })
}

// 兼容双层 JSON 的 parse：一次 parse 后若仍是字符串再 parse 一次。
// 只对「确实是对象」的结果返回它；裸字符串交给 readKv 这类裸值读取器。
export function parse(raw) {
  const v = jsonOf(readKvValue(raw))
  return v
}

// 单值的归一化（双层 JSON → 对象；裸字符串 → 原样）
export function readKvValue(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string") return raw
  let v
  try { v = JSON.parse(raw) } catch { return raw } // 裸值
  if (typeof v === "string") {
    try { v = JSON.parse(v) } catch { return v }
  }
  return v
}

// 裸值读取器：直接读任意路径的某个 kv 键。
// ⚠️ installation_uuid 是纯字符串 —— 用「typeof === object」的守卫读它会直接丢掉。
export function readKvFromPath(path, key) {
  const db = openReadonly(path)
  if (!db) return null
  try {
    return readKv(db, key)
  } finally {
    closeDb(db)
  }
}

// auth_user 里的用户 id：客户端的字段名是 **userId**（实测 auth_user 的键是
// yid/phone/avatarUrl/nickname/enterpriseId/userId/accountMode，**没有 id**），
// 但 mrv 的旧实现读的是 id —— 两个键名都认，客户端改字段名也不会瞎。
export function userIdOf(user) {
  if (!user || typeof user !== "object") return undefined
  const pick = (v) => (v === undefined || v === null || v === "" ? undefined : v)
  return pick(user.userId) ?? pick(user.id)
}

// 读任意路径的凭据副本。路径可以是桌面端库，也可以是服务器副本。
// writable 只是**记录**这个副本是否被声明为可写（写权限在写函数里再判一次）。
export function readCredentials(path, { writable = false } = {}) {
  if (!path || !existsSync(path)) return null
  const db = openReadonly(path)
  if (!db) return null
  try {
    const map = readKvMap(db, KV_KEYS)
    const tokens = jsonOf(map.auth_tokens)
    const accessToken = String(tokens?.accessToken ?? "")
    if (!accessToken) return null
    const user = jsonOf(map.auth_user) ?? {}
    const claims = accountOf(accessToken)
    // installation_uuid 是裸字符串：原样取出，不做对象守卫
    const uuidRaw = map.installation_uuid
    const installationUuid =
      uuidRaw === null || uuidRaw === undefined ? "" : String(uuidRaw)
    return {
      accessToken,
      refreshToken: String(tokens?.refreshToken ?? ""),
      yid: user.yid ?? claims.yid,
      id: userIdOf(user) ?? claims.id,
      nickname: user.nickname,
      expires: jwtExp(accessToken),
      installationUuid,
      userId: userIdOf(user) ?? claims.id,
      path,
      writable: !!writable,
    }
  } catch {
    return null
  } finally {
    closeDb(db)
  }
}

// 桌面端这条路只借一个身份，**不存 token**：
//   access/refresh 都留空，expires 为 0，靠 source:"desktop" 标记来源。
// token 每次用的时候现读（desktopToken），所以桌面端续期后插件自动跟着用新的。
//
// 为什么不把 token 抄一份：抄下来的 refreshToken 会是桌面端和插件共用的，
// 谁先续期谁就把对方踢下线。留空则 magpie 永不续期（expires 为 0），
// 桌面端的会话不受任何影响。
export function desktopSignIn(env = process.env) {
  const path = dbPath(env)
  const c = readCredentials(path)
  if (!c) {
    throw new Error(
      `没有在本机找到 LobsterAI 的登录信息（${path}）。` +
      "请先在 LobsterAI 桌面端登录，或改用「浏览器登录」。",
    )
  }
  return {
    type: "success",
    refresh: "",
    access: "",
    expires: 0,
    source: "desktop",
    accountId: c.yid ?? (c.id !== undefined ? String(c.id) : undefined),
    uid: c.id,
  }
}

// 桌面端账号的 token：每次现读，桌面端换了 token 插件立刻跟上。
// 读不到就是账号不可用（桌面端退出登录、库被删、文件被加密），
// 报 signIn:"expired" 让 magpie 给账号打上失效标记，提示用户重新登录。
export function desktopToken(env = process.env) {
  const c = readCredentials(dbPath(env))
  if (!c) {
    throw Object.assign(
      new Error("LobsterAI 桌面端未登录，或它的登录信息已不可读"),
      { signIn: "expired" },
    )
  }
  return c.accessToken
}

// 归因字段（uuid / userId）：续期请求要带上。
// 只从**只读**连接里取，不碰桌面端的写路径。
export function localAttribution(env = process.env) {
  const out = { uuid: "", userId: undefined }
  const db = openReadonly(dbPath(env))
  if (!db) return out
  try {
    const map = readKvMap(db, KV_KEYS)
    const uuid = map.installation_uuid
    if (uuid !== null && uuid !== undefined && uuid !== "") out.uuid = String(uuid)
    const user = jsonOf(map.auth_user)
    const uid = userIdOf(user)
    if (uid !== undefined) out.userId = uid
  } catch {
    /* 读不到就没有归因字段，不阻断续期 */
  } finally {
    closeDb(db)
  }
  return out
}
