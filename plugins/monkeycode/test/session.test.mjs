import { test, expect } from "./harness.mjs"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { renewAccount, readSessionCookie, writeSessionCookie, localCredentialFor, sessionFor } from "../lib/session.mjs"
import { saveSecret } from "../lib/store.mjs"
import { SITES } from "../lib/constants.mjs"

const tmp = () => mkdtempSync(join(tmpdir(), "mc-sess-"))

// 一个假控制台：把该走的端点都应上，其余 404。
function fakeConsole({ session = "sess-1", status = 200, mint = true, login = true } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(SITES.cn.console, "")
    calls.push({ path, method: init.method ?? "GET", body: init.body })
    const json = (payload, st = 200, headers = {}) =>
      new Response(JSON.stringify(payload), {
        status: st,
        headers: { "Content-Type": "application/json", ...headers },
      })
    // PoW：给一个 d=1 的挑战（解得动，不必真算）
    if (path === "/api/v1/public/captcha/challenge") {
      return json({ token: "tok", challenge: { c: 1, s: 4, d: 1 }, expires: Date.now() + 60000 })
    }
    if (path === "/api/v1/public/captcha/redeem") {
      return json({ success: true, token: "captcha-ok" })
    }
    if (path === "/api/v1/users/status") {
      if (session === "" ) return json({ code: 401, message: "expired" }, 401)
      return json({ code: 0, data: { user: { email: "a@b.com", id: "uid-1", name: "Ada" } } })
    }
    if (path === "/api/v1/users/ohmyagent/api-keys" && (init.method ?? "GET") === "POST") {
      if (!mint) return json({ code: 1, message: "no" }, 500)
      return json({ code: 0, data: { id: "key-1", api_key: "oma_new", signing_secret: "omas_new" } })
    }
    if (path === "/api/v1/users/password-login") {
      if (!login) return json({ code: 7, message: "bad password" }, 401)
      return json({ code: 0, data: {} }, 200, {
        "Set-Cookie": `monkeycode_ai_session=sess-2; Path=/`,
      })
    }
    return json({ code: 404, message: "no" }, 404)
  }
  return { fetchImpl, calls }
}

test("renewAccount mints a fresh key from a live session", async () => {
  const { fetchImpl } = fakeConsole()
  const out = await renewAccount(SITES.cn, {
    auth: { type: "oauth", metadata: { cookie: "sess-1", email: "a@b.com", uid: "uid-1" } },
    env: {},
    fetchImpl,
  })
  expect(out.key).toBe("oma_new")
  expect(out.metadata.secret).toBe("omas_new")
  expect(out.metadata.email).toBe("a@b.com")
  expect(out.metadata.uid).toBe("uid-1")
  // expires 必须非 0 —— magpie 把 expires=0 当「永不续期」
  expect(out.expires).toBeGreaterThan(Date.now())
})

test("renewAccount falls back to the password when the session lapsed", async () => {
  const dir = tmp()
  try {
    const env = { MONKEYCODE_CREDENTIALS_FILE: join(dir, "creds.json") }
    saveSecret({ email: "a@b.com", uid: "uid-1" }, { email: "a@b.com", password: "pw" }, env)
    // 会话 401（过期），账密登录可用
    const { fetchImpl, calls } = fakeConsole({ session: "" })
    const out = await renewAccount(SITES.cn, {
      auth: { type: "oauth", metadata: { cookie: "expired", email: "a@b.com", uid: "uid-1" } },
      env,
      fetchImpl,
    })
    expect(calls.some((c) => c.path === "/api/v1/users/password-login")).toBe(true)
    expect(out.key).toBe("oma_new")
    expect(out.metadata.cookie).toBe("sess-2")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renewAccount reports a lapsed sign-in when there is nothing to renew with", async () => {
  const { fetchImpl } = fakeConsole({ session: "" })
  let err = null
  try {
    await renewAccount(SITES.cn, {
      auth: { type: "oauth", metadata: { cookie: "expired", email: "a@b.com" } },
      env: {},
      fetchImpl,
    })
  } catch (e) {
    err = e
  }
  expect(err).toBeTruthy()
  expect(err.signIn).toBe("expired")
})

test("renewAccount picks up a session injected by the environment", async () => {
  const { fetchImpl } = fakeConsole()
  const out = await renewAccount(SITES.cn, {
    auth: { type: "oauth", metadata: { email: "a@b.com" } },
    env: { MONKEYCODE_SESSION: "sess-1" },
    fetchImpl,
  })
  expect(out.key).toBe("oma_new")
  expect(out.metadata.cookie).toBe("sess-1")
})

test("the session is written back to the cookie file", async () => {
  const dir = tmp()
  try {
    const file = join(dir, "monkeycode-cookies.json")
    writeSessionCookie(file, "sess-9", { domain: "monkeycode-ai.com" })
    expect(readSessionCookie(file)).toBe("sess-9")
    // 再写一次是替换，不是追加
    writeSessionCookie(file, "sess-10", { domain: "monkeycode-ai.com" })
    expect(readSessionCookie(file)).toBe("sess-10")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sessionFor prefers the injected session over the file", () => {
  const dir = tmp()
  try {
    const file = join(dir, "c.json")
    writeSessionCookie(file, "from-file")
    expect(sessionFor({ MONKEYCODE_COOKIE_FILE: file })).toBe("from-file")
    expect(sessionFor({ MONKEYCODE_COOKIE_FILE: file, MONKEYCODE_SESSION: "from-env" })).toBe("from-env")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("localCredentialFor reads the B-channel key, not the A-channel one", () => {
  const dir = tmp()
  try {
    const root = join(dir, "com.chaitin.baizhi.monkeycode")
    mkdirSync(join(root, "ohmyagent"), { recursive: true })
    // 键按字母序排：第一条是 A 通道（@baizhi），B 通道在后面
    writeFileSync(
      join(root, "ohmyagent", "settings.json"),
      JSON.stringify({
        signing_secret: "omas_s",
        models: {
          "monkeycode-basic/deepseek-flash@baizhi": {
            api_key: "sk-baizhi", base_url: "https://ai-models.app.baizhi.cloud/api", model: "deepseek-flash", type: "anthropic",
          },
          "monkeycode-basic/deepseek-flash@monkeycode#uid-1": {
            api_key: "oma_b", base_url: "https://proxy.monkeycode-ai.com/v1", model: "monkeycode-basic/deepseek-flash", type: "anthropic",
          },
        },
      }),
    )
    const cred = localCredentialFor(join(root, "ohmyagent"), { env: {} })
    expect(cred).toBeTruthy()
    expect(cred.key).toBe("oma_b")
    expect(cred.metadata.secret).toBe("omas_s")
    expect(cred.metadata.base).toBe("https://proxy.monkeycode-ai.com/v1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("localCredentialFor ignores a settings.json with no B-channel key", () => {
  const dir = tmp()
  try {
    const root = join(dir, "com.chaitin.baizhi.monkeycode")
    mkdirSync(join(root, "ohmyagent"), { recursive: true })
    writeFileSync(
      join(root, "ohmyagent", "settings.json"),
      JSON.stringify({
        signing_secret: "omas_s",
        models: { "deepseek-flash@baizhi": { api_key: "sk-baizhi", base_url: "https://x" } },
      }),
    )
    expect(localCredentialFor(join(root, "ohmyagent"), { env: {} })).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("localCredentialFor picks the entry of the requested region", () => {
  const dir = tmp()
  try {
    const root = join(dir, "com.chaitin.baizhi.monkeycode")
    mkdirSync(join(root, "ohmyagent"), { recursive: true })
    // 同一个 settings.json 里，国内版与国际版各有一条条目
    writeFileSync(
      join(root, "ohmyagent", "settings.json"),
      JSON.stringify({
        signing_secret: "omas_s",
        models: {
          "a@monkeycode#cn": { api_key: "oma_cn", base_url: "https://proxy.monkeycode-ai.com/v1" },
          "b@monkeycode#intl": { api_key: "oma_intl", base_url: "https://proxy.monkeycode-ai.net/v1" },
        },
      }),
    )
    const dirPath = join(root, "ohmyagent")
    const cn = localCredentialFor(dirPath, { env: {}, site: SITES.cn })
    expect(cn.key).toBe("oma_cn")
    expect(cn.metadata.base).toBe("https://proxy.monkeycode-ai.com/v1")
    const intl = localCredentialFor(dirPath, { env: {}, site: SITES.intl })
    expect(intl.key).toBe("oma_intl")
    expect(intl.metadata.base).toBe("https://proxy.monkeycode-ai.net/v1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("localCredentialFor finds nothing when the region has no entry", () => {
  const dir = tmp()
  try {
    const root = join(dir, "com.chaitin.baizhi.monkeycode")
    mkdirSync(join(root, "ohmyagent"), { recursive: true })
    writeFileSync(
      join(root, "ohmyagent", "settings.json"),
      JSON.stringify({
        signing_secret: "omas_s",
        models: {
          "a@monkeycode#cn": { api_key: "oma_cn", base_url: "https://proxy.monkeycode-ai.com/v1" },
        },
      }),
    )
    // 只有国内版的条目 ⇒ 国际版登录不该捡它
    expect(localCredentialFor(join(root, "ohmyagent"), { env: {}, site: SITES.intl })).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readSessionCookie only reads the cookie of the requested domain", () => {
  const dir = tmp()
  try {
    const file = join(dir, "c.json")
    // 一个文件里两套会话（不同域）
    writeFileSync(
      file,
      JSON.stringify([
        { name: "monkeycode_ai_session", value: "cn-session", domain: "monkeycode-ai.com" },
        { name: "monkeycode_ai_session", value: "intl-session", domain: "monkeycode-ai.net" },
      ]),
    )
    expect(readSessionCookie(file, { domain: "monkeycode-ai.com" })).toBe("cn-session")
    expect(readSessionCookie(file, { domain: "monkeycode-ai.net" })).toBe("intl-session")
    // 不指定域名 ⇒ 取第一个
    expect(readSessionCookie(file)).toBe("cn-session")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
