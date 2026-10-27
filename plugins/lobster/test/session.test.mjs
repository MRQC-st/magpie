// 会话层补测：T16 登录方式顺序 / T17 服务器副本换 token / T18 续期归因字段 /
// T19 回写守卫 / T25 三键读取。
// 只新增测试：实现（lib/、index.mjs）一行不动。
import { test, expect } from "./harness.mjs"
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { LobsterAuthPlugin as plugin, _internal } from "../index.mjs"
import { dbPath } from "../lib/auth-import.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
// 占位 token：不是真凭据，只为让 jwtExp / accountOf 有东西可解析
const ACCESS = `h.${b64({ sub: 67097, yid: "urs-test@example.invalid", exp: 1793152423 })}.s`
const UUID = "uuid-plain-0000"
const lit = (v) => "'" + String(v).replace(/'/g, "''") + "'"

// kv 夹具：两种 schema 都造（客户端 2026.10 起给 kv 加了 updated_at NOT NULL）
// 写用 exec() 不用 prepare()：Bun 的 node:sqlite 里 prepare() 会把句柄留到 GC，
// Windows 上临时目录就删不掉（EBUSY）。
function makeDb({ schema = "updated-at", tokens = true, user = true, uuid = UUID, userValue } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobster-sess-"))
  const file = join(dir, "lobsterai.sqlite")
  const db = new DatabaseSync(file)
  db.exec(schema === "updated-at"
    ? "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    : "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const put = (k, v) => db.exec(schema === "updated-at"
    ? `INSERT INTO kv (key, value, updated_at) VALUES (${lit(k)}, ${lit(v)}, 0)`
    : `INSERT INTO kv (key, value) VALUES (${lit(k)}, ${lit(v)})`)
  if (tokens) put("auth_tokens", JSON.stringify({ accessToken: ACCESS, refreshToken: "refresh-plain" }))
  if (user) put("auth_user", JSON.stringify(userValue ?? { yid: "urs-test@example.invalid", id: 67097, nickname: "T" }))
  if (uuid) put("installation_uuid", uuid) // 裸字符串，不是 JSON
  db.close()
  return { dir, file }
}

test("T16 三个登录方式的下标顺序是契约", async () => {
  const hooks = await plugin({})
  const labels = hooks.auth.methods.map((m) => m.label)
  expect(hooks.auth.methods.length).toBe(3)
  expect(new Set(labels).size).toBe(3)
  expect(labels[0]).toContain("浏览器")
  expect(labels[1]).toContain("本机")
  expect(labels[2]).toContain("服务器副本")
})

test("T17 method 2 用服务器副本的 refreshToken 零交互换 token", async () => {
  const { dir, file } = makeDb()
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") })
    return {
      status: 200,
      text: async () => JSON.stringify({
        code: 0, message: "OK",
        data: { accessToken: ACCESS, refreshToken: "refresh-new" },
      }),
    }
  }
  try {
    const env = { LOBSTER_SERVER_COPY_DB: file, LOBSTER_API_BASE: "http://127.0.0.1:9/api" }
    const out = await _internal.serverCopySignIn({ env, fetchImpl })
    expect(seen[0].url.endsWith("/auth/refresh")).toBe(true)
    expect(seen[0].body.refreshToken).toBe("refresh-plain")
    expect(seen[0].body.firstKeyfrom).toBe("official")
    expect(seen[0].body.latestKeyfrom).toBe("official")
    expect(typeof seen[0].body.version === "string" && seen[0].body.version.length > 0).toBe(true)
    expect(out.type).toBe("success")
    expect(out.access).toBe(ACCESS)
    expect(out.refresh).toBe("refresh-new")
    expect(out.expires).toBe(1793152423000)
    expect(out.accountId).toBe("urs-test@example.invalid")
    expect(out.uid).toBe(67097)
    expect(out.source).toBe("server-copy")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T18 续期体只在归因字段存在时才带上它们", async () => {
  const withAttrs = makeDb()
  const noAttrs = makeDb({ user: false, uuid: null })
  const empty = mkdtempSync(join(tmpdir(), "lobster-empty-"))
  try {
    // APPDATA 指到空目录 ⇒ 本机桌面端库里什么都没有，归因字段只能来自副本
    const env = { APPDATA: empty, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty }
    const b1 = _internal.refreshBody({ refreshToken: "r", auth: { copyPath: withAttrs.file }, env })
    expect(b1.uuid).toBe(UUID)
    expect(b1.userId).toBe(67097)
    const b2 = _internal.refreshBody({ refreshToken: "r", auth: { copyPath: noAttrs.file }, env })
    // 键**不存在**，不是「值为 undefined 的键」
    expect(Object.keys(b2)).toEqual(["refreshToken", "firstKeyfrom", "latestKeyfrom", "version"])
    expect(b2.uuid).toBeUndefined()
  } finally {
    rmSync(withAttrs.dir, { recursive: true, force: true })
    rmSync(noAttrs.dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test("T19 回写只写服务器副本，桌面端目录一律拒绝", async () => {
  const desktop = mkdtempSync(join(tmpdir(), "lobster-desktop-"))
  const copy = makeDb({ schema: "plain" })
  try {
    const env = { APPDATA: desktop, HOME: desktop, USERPROFILE: desktop, XDG_CONFIG_HOME: desktop }
    const blocked = _internal.writeBackToCopy({
      path: dbPath(env),
      next: { accessToken: "new-access", refreshToken: "new-refresh" },
      prev: { refreshToken: "refresh-plain" },
      env,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/desktop/)
    const ok = _internal.writeBackToCopy({
      path: copy.file,
      next: { accessToken: "new-access", refreshToken: "new-refresh" },
      prev: { refreshToken: "refresh-plain" },
      env,
    })
    expect(ok.ok).toBe(true)
    const after = _internal.readCredentials(copy.file)
    expect(after.accessToken).toBe("new-access")
  } finally {
    rmSync(desktop, { recursive: true, force: true })
    rmSync(copy.dir, { recursive: true, force: true })
  }
})

test("T25 一次读出三个键，installation_uuid 是裸字符串", async () => {
  const { dir, file } = makeDb({ schema: "plain" })
  try {
    const c = _internal.readCredentials(file)
    // auth_tokens
    expect(c.accessToken).toBe(ACCESS)
    expect(c.refreshToken).toBe("refresh-plain")
    // auth_user
    expect(c.userId).toBe(67097)
    expect(c.yid).toBe("urs-test@example.invalid")
    // installation_uuid：裸字符串没被「必须是对象」的守卫丢掉
    expect(c.installationUuid).toBe(UUID)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 插件级装配（T17 / T18 / T25）────────────────────────────────────
// ⚠️ 装配签名是 LobsterAuthPlugin(input, options)：env 与 fetch 都走**第二个参数**。
//    fetch 放到第一个参数 ⇒ 真打网络 ⇒ 401 ⇒ signIn:expired。
const PLUGIN_ENV = { LOBSTER_API_BASE: "http://127.0.0.1:9/api" }

test("T17 插件 method 2 用注入的 fetch 零交互换 token", async () => {
  const { dir, file } = makeDb()
  const seen = []
  try {
    const hooks = await plugin({}, {
      env: { ...PLUGIN_ENV, LOBSTER_SERVER_COPY_DB: file },
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") })
        return {
          status: 200,
          text: async () => JSON.stringify({
            code: 0, message: "OK",
            data: { accessToken: ACCESS, refreshToken: "refresh-new" },
          }),
        }
      },
    })
    const auth = await hooks.auth.methods[2].authorize()
    const out = await auth.callback()
    expect(out.type).toBe("success")
    expect(out.source).toBe("server-copy")
    expect(seen.length).toBe(1)
    expect(seen[0].url.endsWith("/auth/refresh")).toBe(true)
    expect(seen[0].body.refreshToken).toBe("refresh-plain")
    // T25：换 token 时也把 installation_uuid 带出去
    expect(out.installationUuid).toBe(UUID)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── W2-C：auth_user 的用户 id 字段名是 userId（客户端真实字段），旧代码读的是 id ──
test("W2C 归因字段读 auth_user.userId（客户端真实字段名）", async () => {
  const clientStyle = makeDb({ userValue: { userId: "94951", yid: "x@y.z" } })
  const empty = mkdtempSync(join(tmpdir(), "lobster-empty-"))
  try {
    const env = { APPDATA: empty, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty }
    // 客户端真实字段名：userId（auth_user 里根本没有 id 键）
    expect(_internal.attributionFromPath(clientStyle.file).userId).toBe("94951")
    expect(_internal.attributionFor({ copyPath: clientStyle.file }, env).userId).toBe("94951")
  } finally {
    rmSync(clientStyle.dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test("W2C 归因字段兼容旧的 auth_user.id 键", async () => {
  const legacyStyle = makeDb({ userValue: { id: 123 } })
  const empty = mkdtempSync(join(tmpdir(), "lobster-empty-"))
  try {
    const env = { APPDATA: empty, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty }
    expect(_internal.attributionFromPath(legacyStyle.file).userId).toBe(123)
    expect(_internal.attributionFor({ copyPath: legacyStyle.file }, env).userId).toBe(123)
  } finally {
    rmSync(legacyStyle.dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test("T18 插件续期把归因字段 uuid/userId 写进请求体", async () => {
  const { dir, file } = makeDb()
  const empty = mkdtempSync(join(tmpdir(), "lobster-empty-"))
  const seen = []
  try {
    const hooks = await plugin({}, {
      env: {
        ...PLUGIN_ENV,
        LOBSTER_SERVER_COPY_DB: file,
        APPDATA: empty, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty,
      },
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") })
        return {
          status: 200,
          text: async () => JSON.stringify({
            code: 0, message: "OK",
            data: { accessToken: ACCESS, refreshToken: "refresh-new" },
          }),
        }
      },
    })
    const out = await hooks.auth.refresh({
      type: "oauth", access: "old-access", refresh: "refresh-plain",
      expires: 0, copyPath: file,
    })
    expect(seen.length).toBe(1)
    expect(seen[0].body.uuid).toBe(UUID)
    expect(seen[0].body.userId).toBe(67097)
    expect(out.access).toBe(ACCESS)
    expect(out.refresh).toBe("refresh-new")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

// ── W2-D：服务器副本被误判为桌面端库 ⇒ 副本永远回写不了 ─────────────
//
// 缺陷（服务器实测）：dbPath(env) 与 serverCopyPath(env) 在 Linux 上是**同一个路径**
// （~/.config/LobsterAI/lobsterai.sqlite），isDesktopPath() 一律返回 true，
// writeBackToCopy() 于是永远 early-return「desktop-readonly」。
//
// 修复后的判据：显式声明优先 + 平台判据。
//   - win32：桌面端客户端真实存在（可能正在运行）⇒ 桌面端库禁写，
//             除非它被**显式声明**成 serverCopyDb（那是故意的）。
//   - darwin/linux：dbPath() 指向的位置是服务器副本的默认位置，
//             未被显式声明成副本时才当作桌面端。

// 在**指定路径**造一份 kv 库（makeDb 只会造在临时目录的固定文件名上）
function makeDbAt(file, { schema = "updated-at" } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(schema === "updated-at"
    ? "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    : "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const put = (k, v) => db.exec(schema === "updated-at"
    ? `INSERT INTO kv (key, value, updated_at) VALUES (${lit(k)}, ${lit(v)}, 0)`
    : `INSERT INTO kv (key, value) VALUES (${lit(k)}, ${lit(v)})`)
  put("auth_tokens", JSON.stringify({ accessToken: ACCESS, refreshToken: "refresh-plain" }))
  put("auth_user", JSON.stringify({ yid: "urs-test@example.invalid", id: 67097, nickname: "T" }))
  put("installation_uuid", UUID) // 裸字符串，不是 JSON
  db.close()
  return file
}

const NEXT = { accessToken: "new-access", refreshToken: "new-refresh" }
const PREV = { refreshToken: "refresh-plain" }

test("W2D Windows 桌面端库被拒写（安全边界不许放宽）", async () => {
  const desktop = mkdtempSync(join(tmpdir(), "lobster-win-"))
  const winEnv = { APPDATA: join(desktop, "Roaming"), HOME: desktop, USERPROFILE: desktop }
  const p = dbPath(winEnv, "win32")
  try {
    // 判据本身：桌面端库仍然被认成桌面端
    expect(_internal.isDesktopPath(p, winEnv, "win32")).toBe(true)
    // 回写必须被挡下
    const r = _internal.writeBackToCopy({ path: p, next: NEXT, prev: PREV, env: winEnv, platform: "win32" })
    expect(r.reason).toMatch(/desktop/)
  } finally {
    rmSync(desktop, { recursive: true, force: true })
  }
})

test("W2D 显式声明为 serverCopyDb 后可写（显式声明优先）", async () => {
  const desktop = mkdtempSync(join(tmpdir(), "lobster-win2-"))
  const winEnv = { APPDATA: join(desktop, "Roaming"), HOME: desktop, USERPROFILE: desktop }
  // 桌面端库本身被**显式声明**成服务器副本 ⇒ 用户就是故意要写它 ⇒ 放行
  const p = dbPath(winEnv, "win32")
  makeDbAt(p)
  winEnv.LOBSTER_SERVER_COPY_DB = p
  try {
    const r = _internal.writeBackToCopy({ path: p, next: NEXT, prev: PREV, env: winEnv, platform: "win32" })
    expect(r.ok).toBe(true)
    expect(_internal.readCredentials(p).accessToken).toBe("new-access")
  } finally {
    rmSync(desktop, { recursive: true, force: true })
  }
})

test("W2D Linux 上 serverCopyDb 与 dbPath 同路径时可写（服务器场景）", async () => {
  const home = mkdtempSync(join(tmpdir(), "lobster-linux-"))
  const linuxEnv = { HOME: home, XDG_CONFIG_HOME: home }
  // Linux 上 dbPath() 与服务器副本的默认路径**完全重合**
  const p = dbPath(linuxEnv, "linux")
  makeDbAt(p)
  linuxEnv.LOBSTER_SERVER_COPY_DB = p
  try {
    // 前提：Linux 上 dbPath() 与服务器副本路径**完全重合**（这正是缺陷的根因）
    expect(p).toBe(_internal.serverCopyPath(linuxEnv))
    const r = _internal.writeBackToCopy({ path: p, next: NEXT, prev: PREV, env: linuxEnv, platform: "linux" })
    expect({ ok: r.ok, token: _internal.readCredentials(p).accessToken })
      .toEqual({ ok: true, token: "new-access" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

