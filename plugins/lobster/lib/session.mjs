// 账号会话层：归因字段、续期请求体、服务器副本换 token、回写副本。
//
// 这些函数放在 lib/ 下而不是 index.mjs，是因为**入口禁止导出辅助函数** ——
// magpie 把每个导出的函数都当成一个独立插件加载。

import { apiUrl, clientVersion, PROVIDER, FALLBACK_MODELS } from "./constants.mjs"
import { readCredentials, readKvFromPath, serverCopyPath, isDesktopPath, localAttribution, userIdOf } from "./auth-import.mjs"
import { jwtExp } from "./jwt.mjs"
import { persistTokens } from "./sqlite-kv.mjs"
import { readManagedModels } from "./managed-models.mjs"
import { modelsFromManaged, modelsFromConfig } from "./models.mjs"

// 归因字段：uuid（installation_uuid）/ userId（auth_user.userId，兼容旧的 id）。
// ⚠️ installation_uuid 是**裸字符串**，不能用「必须是对象」的守卫去取 ——
//    守卫会把它直接丢掉，续期请求就永远拿不到 uuid。
export function attributionFromPath(path) {
  const out = { uuid: "", userId: undefined }
  if (!path) return out
  const uuidRaw = readKvFromPath(path, "installation_uuid")
  if (uuidRaw !== null && uuidRaw !== undefined && uuidRaw !== "") out.uuid = String(uuidRaw)
  const userRaw = readKvFromPath(path, "auth_user")
  const user = userRaw && typeof userRaw === "object" && !Array.isArray(userRaw) ? userRaw : null
  // 客户端的 auth_user 里字段名是 userId（没有 id）；旧代码读的是 id —— 两个都认
  const uid = userIdOf(user)
  if (uid !== undefined) out.userId = uid
  return out
}

// 归因字段的取值顺序：账号自带的副本路径 → env 指定的副本 → 只读的桌面端库
export function attributionFor(auth, env = process.env) {
  const paths = []
  if (auth?.copyPath) paths.push(auth.copyPath)
  const sc = serverCopyPath(env)
  if (sc) paths.push(sc)
  let out = { uuid: "", userId: undefined }
  for (const p of paths) {
    const a = attributionFromPath(p)
    if (!out.uuid && a.uuid) out.uuid = a.uuid
    if (out.userId === undefined && a.userId !== undefined) out.userId = a.userId
  }
  if (!out.uuid || out.userId === undefined) {
    const loc = localAttribution(env)
    if (!out.uuid) out.uuid = loc.uuid
    if (out.userId === undefined) out.userId = loc.userId
  }
  return out
}

// 续期请求体：客户端 authSessionManager + withKeyfromBody 的逐字复刻
//   { refreshToken, firstKeyfrom:'official', latestKeyfrom:'official', uuid?, userId?, version }
export function refreshBody({ refreshToken, auth, env = process.env }) {
  const a = attributionFor(auth, env)
  return {
    refreshToken: String(refreshToken ?? ""),
    firstKeyfrom: "official",
    latestKeyfrom: "official",
    ...(a.uuid ? { uuid: a.uuid } : {}),
    ...(a.userId !== undefined ? { userId: a.userId } : {}),
    version: clientVersion(env),
  }
}

// 回写服务器副本。**只写 server-copy，绝不写本机桌面端库**。
// 失败不影响主流程（续期本身已经成功了）。
export function writeBackToCopy({ path, next, prev, env = process.env, log, platform = process.platform }) {
  if (!path) return { ok: false, reason: "no-path" }
  // 桌面端判据在 lib/auth-import.mjs：显式声明的服务器副本优先，其余按平台判。
  if (isDesktopPath(path, env, platform)) return { ok: false, reason: "desktop-readonly" }
  try {
    const r = persistTokens(path, next, prev, { writable: true })
    if (!r.ok) log?.("warn", `LobsterAI 回写服务器副本失败：${r.reason}`)
    return r
  } catch (e) {
    log?.("warn", `LobsterAI 回写服务器副本失败：${e?.message ?? e}`)
    return { ok: false, reason: e?.message ?? String(e) }
  }
}

// 服务器副本导入：读副本的 auth_tokens（双层解析）取 refreshToken，
// POST {API}/auth/refresh 换一对新 token（零交互）。
export async function serverCopySignIn({ env = process.env, fetchImpl = fetch } = {}) {
  const path = serverCopyPath(env)
  if (!path) {
    throw new Error(
      "没有配置 LobsterAI 的服务器凭据副本路径（env LOBSTER_SERVER_COPY_DB）。" +
      "没有它就没有可导入的账号。",
    )
  }
  const c = readCredentials(path)
  if (!c) throw new Error(`服务器副本里没有可用的登录信息（${path}）。`)
  const refreshToken = String(c.refreshToken ?? "")
  if (!refreshToken) throw new Error("服务器副本里没有 refreshToken，无法换取 token。")

  const body = refreshBody({ refreshToken, auth: { copyPath: path }, env })
  const res = await fetchImpl(apiUrl(env) + "/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let v
  try { v = JSON.parse(text) } catch { throw new Error("LobsterAI 换 token：响应无法解析") }
  if (v?.code !== 0 || !v?.data?.accessToken) {
    throw new Error(`LobsterAI 换 token 失败：${v?.message || `code ${v?.code}`}`)
  }
  const d = v.data
  const access = String(d.accessToken)
  const next = { accessToken: access, refreshToken: String(d.refreshToken ?? refreshToken) }
  return {
    type: "success",
    access,
    refresh: next.refreshToken,
    // expires 用 jwtExp 从 accessToken 里读；读不到（JWT 没有 exp）时给一个
    // 保守的默认值，否则 magpie 把 expires=0 当成「永不续期」，
    // 服务器副本换来的 token 会在过期后静默失效。
    expires: jwtExp(access) || Date.now() + 30 * 24 * 3600 * 1000,
    accountId: c.yid ?? (c.id !== undefined ? String(c.id) : undefined),
    uid: c.id,
    source: "server-copy",
    copyPath: path,
    installationUuid: attributionFromPath(path).uuid,
  }
}

// 模型三级降级：云端 → openclaw 托管目录 → 静态兜底表。
// openclaw 与静态表都是**正常降级**，绝不抛异常。
//
// ⚠️ 返回自己的列表时必须打上 magpie 的降级标记：
//    list[Symbol.for("magpie.fellBack")] = true
//    —— 官方文档：「返回自己的列表，并设置 list[Symbol.for("magpie.fellBack")] = true」，
//    否则 magpie 不知道这是降级来的列表，会当成权威结果。
export const FELL_BACK = Symbol.for("magpie.fellBack")

export function markFellBack(list) {
  try {
    if (list && typeof list === "object") list[FELL_BACK] = true
  } catch {
    /* 冻结对象之类打不上就算了，不影响功能 */
  }
  return list
}

export function fallbackModels(provider, env = process.env) {
  const managed = readManagedModels(env)
  if (Array.isArray(managed) && managed.length > 0) {
    const out = modelsFromManaged(managed, { ...provider, id: PROVIDER })
    if (Object.keys(out).length > 0) return markFellBack(out)
  }
  const out = modelsFromConfig(FALLBACK_MODELS, { ...provider, id: PROVIDER })
  if (Object.keys(out).length > 0) return markFellBack(out)
  return provider?.models ?? {}
}
