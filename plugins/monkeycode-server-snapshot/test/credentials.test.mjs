import { test, expect } from "./harness.mjs"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  credentialOf,
  normalizeCookie,
  stripBearer,
  cookieValue,
  readCookieFile,
  accountOf,
  isChannelB,
  accountDirs,
  findAccountCookie,
  settingsPaths,
} from "../lib/credentials.mjs"
import { saveSecret, loadSecret, removeSecret, listSecrets, credentialsPath } from "../lib/store.mjs"

const tmp = () => mkdtempSync(join(tmpdir(), "mc-cred-"))

test("credentialOf reads the record magpie stores", () => {
  const c = credentialOf({
    type: "oauth",
    key: "oma_abc",
    metadata: { secret: "omas_x", cookie: "monkeycode_ai_session=sess", base: "https://p/v1" },
  })
  expect(c.key).toBe("oma_abc")
  expect(c.secret).toBe("omas_x")
  expect(c.cookie).toBe("sess")
  expect(c.base).toBe("https://p/v1")
})

test("credentialOf accepts the old colon-joined form", () => {
  const c = credentialOf({ type: "api", key: "oma_k:omas_s:sessioncookie" })
  expect(c.key).toBe("oma_k")
  expect(c.secret).toBe("omas_s")
  expect(c.cookie).toBe("sessioncookie")
})

test("credentialOf never lets a missing secret look present", () => {
  const c = credentialOf({ type: "oauth", key: "oma_abc", metadata: {} })
  expect(c.secret).toBe("")
  expect(c.cookie).toBe("")
})

test("credentialOf reads an oauth record, whose key lives in refresh", async () => {
  // magpie 的 save()：结果里带 `refresh` ⇒ 存成 {type:"oauth", refresh, access, expires}
  // ⚠️ 只读 auth.key 的话 key 会是空串 ⇒ loader 返回 {} ⇒ 请求没有 baseURL。
  const c = credentialOf({
    type: "oauth",
    refresh: "oma_abc",
    access: "omas_xyz",
    expires: 1793865864129,
    metadata: { base: "https://proxy.monkeycode-ai.com/v1", cookie: "sess-1" },
  })
  expect(c.key).toBe("oma_abc")
  expect(c.secret).toBe("omas_xyz")
  expect(c.cookie).toBe("sess-1")
  expect(c.base).toBe("https://proxy.monkeycode-ai.com/v1")
})

test("credentialOf prefers metadata.secret over access", () => {
  const c = credentialOf({
    type: "oauth",
    refresh: "oma_abc",
    access: "omas_from_access",
    metadata: { secret: "omas_from_metadata" },
  })
  expect(c.secret).toBe("omas_from_metadata")
})

test("normalizeCookie takes a bare value, a pair or a whole header", () => {
  expect(normalizeCookie("abc")).toBe("abc")
  expect(normalizeCookie("monkeycode_ai_session=abc")).toBe("abc")
  expect(normalizeCookie("Cookie: monkeycode_ai_session=abc")).toBe("abc")
  expect(normalizeCookie("other=1; monkeycode_ai_session=abc; more=2")).toBe("abc")
  expect(normalizeCookie("-")).toBe("")
  expect(normalizeCookie("")).toBe("")
})

test("stripBearer removes the Bearer prefix", () => {
  expect(stripBearer("Bearer oma_abc")).toBe("oma_abc")
  expect(stripBearer("bearer oma_abc")).toBe("oma_abc")
  expect(stripBearer("oma_abc")).toBe("oma_abc")
})

test("an expired cookie reads as absent", () => {
  const past = new Date(Date.now() - 1000).toISOString()
  const items = [{ name: "monkeycode_ai_session", value: "old", expires: past }]
  expect(cookieValue(items, "monkeycode_ai_session", { expired: "drop" })).toBe("")
  expect(cookieValue(items, "monkeycode_ai_session", { expired: "skip" })).toBe("old")
})

test("a cookie file may be an array or an accounts object", () => {
  const dir = tmp()
  try {
    const a = join(dir, "a.json")
    writeFileSync(a, JSON.stringify([{ name: "x", value: "1" }]))
    expect(readCookieFile(a).length).toBe(1)
    const b = join(dir, "b.json")
    writeFileSync(b, JSON.stringify({ accounts: [{ name: "x", value: "2" }] }))
    expect(readCookieFile(b).length).toBe(1)
    // 坏文件当作没有
    const c = join(dir, "c.json")
    writeFileSync(c, "{not json")
    expect(readCookieFile(c).length).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the model key tells which channel and which account", () => {
  expect(accountOf("monkeycode-basic/deepseek-flash@monkeycode#uuid-1")).toBe("uuid-1")
  expect(accountOf("monkeycode-basic/deepseek-flash@baizhi")).toBe("baizhi")
  expect(isChannelB("monkeycode-basic/x@monkeycode#u")).toBe(true)
  expect(isChannelB("monkeycode-basic/x@baizhi")).toBe(false)
})

test("accountDirs finds every account's config directory", () => {
  const dir = tmp()
  try {
    // 第二个账号的目录是根目录的**兄弟**（客户端的规矩），不是子目录
    const root = join(dir, "com.chaitin.baizhi.monkeycode")
    mkdirSync(join(root, "ohmyagent"), { recursive: true })
    writeFileSync(join(root, "ohmyagent", "settings.json"), "{}")
    const second = join(dir, "com.chaitin.baizhi.monkeycode-second")
    mkdirSync(join(second, "ohmyagent"), { recursive: true })
    writeFileSync(join(second, "ohmyagent", "settings.json"), "{}")
    const dirs = accountDirs({ MONKEYCODE_ACCOUNT_ROOT: root })
    expect(dirs.length).toBe(2)
    // 每个目录都是 `<账号目录>/ohmyagent`
    expect(dirs.every((d) => d.endsWith(join("ohmyagent")))).toBe(true)
    expect(dirs.some((d) => d.includes("monkeycode-second"))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("findAccountCookie locates the baizhi session for the A channel", () => {
  const dir = tmp()
  try {
    const root = join(dir, "com.chaitin.baizhi.monkeycode")
    mkdirSync(join(root, "ohmyagent"), { recursive: true })
    writeFileSync(join(root, "ohmyagent", "settings.json"), "{}")
    writeFileSync(
      join(root, "baizhi-cookies.json"),
      JSON.stringify([{ name: "baizhi_session", value: "bz-value", expires: new Date(Date.now() + 86400000).toISOString() }]),
    )
    const hit = findAccountCookie({ MONKEYCODE_ACCOUNT_ROOT: root })
    expect(hit.value).toBe("bz-value")
    expect(hit.path).toContain("baizhi-cookies.json")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("settingsPaths honours the override", () => {
  const paths = settingsPaths({ MONKEYCODE_CONFIG_DIR: "/tmp/mc" })
  expect(paths[0]).toBe(join("/tmp/mc", "settings.json"))
})

test("the secret store keeps one password per account", () => {
  const dir = tmp()
  try {
    const file = join(dir, "creds.json")
    const env = { MONKEYCODE_CREDENTIALS_FILE: file }
    expect(saveSecret({ email: "a@b.com", uid: "u1" }, { email: "a@b.com", password: "pw1" }, env).ok).toBe(true)
    expect(saveSecret({ email: "c@d.com", uid: "u2" }, { email: "c@d.com", password: "pw2" }, env).ok).toBe(true)
    expect(loadSecret({ email: "a@b.com", uid: "u1" }, env).password).toBe("pw1")
    // uid 变了也能按 email 找回
    expect(loadSecret({ email: "a@b.com", uid: "u9" }, env).password).toBe("pw1")
    expect(loadSecret({ email: "zz@b.com" }, env)).toBeNull()
    expect(listSecrets(env).length).toBe(2)
    expect(removeSecret({ uid: "u2" }, env)).toBe(true)
    expect(listSecrets(env).length).toBe(1)
    expect(credentialsPath(env)).toBe(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the secret store never lists a password", () => {
  const dir = tmp()
  try {
    const env = { MONKEYCODE_CREDENTIALS_FILE: join(dir, "creds.json") }
    saveSecret({ email: "a@b.com" }, { email: "a@b.com", password: "super-secret" }, env)
    const listed = listSecrets(env)
    expect(JSON.stringify(listed)).not.toContain("super-secret")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
