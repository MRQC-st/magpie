import { test, expect } from "./harness.mjs"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MonkeyCodeAuthPlugin as cnPlugin,
  MonkeyCodeIntlAuthPlugin as intlPlugin,
  _internal,
} from "../index.mjs"

const { SITES } = _internal

test("the module exports exactly two plugin functions", async () => {
  // magpie 把每个导出的**函数**都当成一个独立插件加载；
  // 多导出一个就会多出一个 provider id。
  const mod = await import("../index.mjs")
  const fns = Object.values(mod).filter((v) => typeof v === "function")
  expect(fns.length).toBe(2)
  expect(typeof cnPlugin).toBe("function")
  expect(typeof intlPlugin).toBe("function")
})

test("the two plugins serve two different provider ids", async () => {
  const cn = await cnPlugin({})
  const intl = await intlPlugin({})
  expect(cn.auth.provider).toBe("monkeycode")
  expect(intl.auth.provider).toBe("monkeycode-intl")
  expect(cn.provider.id).toBe("monkeycode")
  expect(intl.provider.id).toBe("monkeycode-intl")
})

test("the two plugins point at different hosts", async () => {
  const cn = await cnPlugin({})
  const intl = await intlPlugin({})
  const cfg = {}
  await cn.config(cfg)
  await intl.config(cfg)
  expect(cfg.provider["monkeycode"].api).toContain("monkeycode-ai.com")
  expect(cfg.provider["monkeycode-intl"].api).toContain("monkeycode-ai.net")
  // 路径两版一致，只差主机
  expect(cfg.provider["monkeycode"].api.endsWith("/v1")).toBe(true)
  expect(cfg.provider["monkeycode-intl"].api.endsWith("/v1")).toBe(true)
})

test("neither plugin sets single, so accounts can coexist", async () => {
  const cn = await cnPlugin({})
  const intl = await intlPlugin({})
  // `single: true` 会让 magpie 的 signInKey() 把每次登录都写进第一个账号槽
  expect(cn.auth.single).toBeUndefined()
  expect(intl.auth.single).toBeUndefined()
})

test("config does not clobber the user's own settings", async () => {
  const cn = await cnPlugin({})
  const cfg = { provider: { monkeycode: { name: "mine" } } }
  await cn.config(cfg)
  expect(cfg.provider.monkeycode.name).toBe("mine")
  expect(Object.keys(cfg.provider.monkeycode.models).length).toBeGreaterThan(0)
})

test("config declares the provider when absent", async () => {
  const cn = await cnPlugin({})
  const cfg = {}
  await cn.config(cfg)
  expect(cfg.provider.monkeycode.name).toBe(SITES.cn.label)
  expect(cfg.provider.monkeycode.npm).toBe("@ai-sdk/anthropic")
})

test("five sign-in methods are offered, all keyless", async () => {
  const cn = await cnPlugin({})
  expect(cn.auth.methods.length).toBe(5)
  for (const m of cn.auth.methods) {
    // 微信扫码是 magpie 原生 oauth 形状（界面直接给网址），其余是 api+keyless
    if (m.label.includes("微信扫码")) {
      expect(m.type).toBe("oauth")
    } else {
      expect(m.type).toBe("api")
      expect(m.keyless).toBe(true)
    }
    expect(typeof m.authorize).toBe("function")
  }
  // 下标是契约：1 读客户端配置 / 2 服务器端账密登录 / 3 微信扫码 / 4 手动填写 / 5 粘会话 Cookie
  expect(cn.auth.methods[0].label).toContain("客户端登录态")
  expect(cn.auth.methods[1].label).toContain("服务器端登录")
  expect(cn.auth.methods[2].label).toContain("微信扫码")
  expect(cn.auth.methods[3].label).toContain("手动填写")
  expect(cn.auth.methods[4].label).toContain("会话 Cookie")
  // 微信扫码只要百智云账号站，国际版的方法表里没有它；
  // 「设置密码」邮件是给 GitHub/Google 注册的国际版账号的，国内版没有它。
  const intl = await intlPlugin({})
  expect(intl.auth.methods.length).toBe(5)
  expect(intl.auth.methods.some((m) => m.label.includes("微信扫码"))).toBe(false)
  expect(intl.auth.methods.some((m) => m.label.includes("设置密码」邮件"))).toBe(true)
})

test("the intl reset-email method sends a reset-request and returns a code sign-in", async () => {
  const seen = []
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
  const fakeFetch = async (url, init) => {
    const u = String(url)
    seen.push({ u, body: init?.body })
    if (u.includes("/captcha/challenge"))
      return json({ token: "tok-1", challenge: { c: 1, s: 1, d: 1 }, expires: Date.now() + 60_000 })
    if (u.includes("/captcha/redeem")) return json({ success: true, token: "captcha-ok" })
    if (u.includes("/api/v1/users/passwords/reset-request"))
      return json({ code: 0, message: "success" })
    return json({ code: 0, data: {} })
  }
  const intl = await intlPlugin({}, { fetch: fakeFetch })
  const m = intl.auth.methods.find((x) => x.label.includes("设置密码」邮件"))
  const out = await m.authorize({ email: "someone@example.com" })
  // 新形状：oauth 两段式（method:"code"）。authorize 发完邮件**不报失败**，
  // 交给 magpie UI 弹粘贴框，callback(口令) 里完成登录 —— 修掉「假失败」。
  expect(out.method).toBe("code")
  expect(out.type).toBeUndefined()
  expect(out.instructions).toContain("someone@example.com")
  expect(typeof out.callback).toBe("function")
  const hit = seen.find((s) => s.u.includes("reset-request"))
  expect(hit).toBeTruthy()
  const body = JSON.parse(hit.body)
  expect(body.emails).toEqual(["someone@example.com"])
  expect(body.captcha_token).toBeTruthy()
})

test("the intl reset-email callback logs in with the pasted password and mints a key", async () => {
  const seen = []
  const json = (obj, status = 200, headers) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } })
  const fakeFetch = async (url, init) => {
    const u = String(url)
    seen.push({ u, body: init?.body })
    if (u.includes("/captcha/challenge"))
      return json({ token: "tok-1", challenge: { c: 1, s: 1, d: 1 }, expires: Date.now() + 60_000 })
    if (u.includes("/captcha/redeem")) return json({ success: true, token: "captcha-ok" })
    if (u.includes("/api/v1/users/password-login")) {
      // 成功：Set-Cookie 种会话（passwordLogin 从这里拿 session）
      return json({ code: 0, message: "success", data: {} }, 200, {
        "Set-Cookie": "monkeycode_ai_session=sess-ok; Path=/; HttpOnly",
      })
    }
    if (u.includes("/api/v1/users/status")) return json({ code: 0, data: { email: "someone@example.com", id: "u-1" } })
    if (u.includes("/api/v1/users/ohmyagent/api-keys"))
      return json({ code: 0, data: { id: "k-1", api_key: "oma_key123", signing_secret: "omas_sec456" } })
    return json({ code: 0, data: {} })
  }
  const intl = await intlPlugin({}, { fetch: fakeFetch })
  const m = intl.auth.methods.find((x) => x.label.includes("设置密码」邮件"))
  const out = await m.authorize({ email: "someone@example.com" })
  // 口令为空：明确报错（不是假失败，用户能看懂）
  const empty = await out.callback("")
  expect(empty.type).toBe("failed")
  // 粘贴口令 → 登录 → 铸 key → success（oauth 型账号，magpie 会自动续期）
  const done = await out.callback("NewPass-2026!")
  expect(done.type).toBe("success")
  expect(done.refresh).toBe("oma_key123")
  expect(done.access).toBe("omas_sec456")
  expect(done.metadata.cookie).toBe("sess-ok")
  expect(done.metadata.source).toBe("reset-email-code")
  const login = seen.find((s) => s.u.includes("password-login"))
  expect(login).toBeTruthy()
  expect(JSON.parse(login.body).password).toBe("NewPass-2026!")
})

test("the server-login method asks for an email and a password", async () => {
  const cn = await cnPlugin({})
  const keys = cn.auth.methods[1].prompts.map((p) => p.key)
  expect(keys).toEqual(["email", "password"])
  // 口令框的校验：太短要拦
  expect(cn.auth.methods[1].prompts[0].validate("nope")).toBeTruthy()
  expect(cn.auth.methods[1].prompts[0].validate("a@b.com")).toBeUndefined()
  expect(cn.auth.methods[1].prompts[1].validate("123")).toBeTruthy()
  expect(cn.auth.methods[1].prompts[1].validate("123456")).toBeUndefined()
})

test("the cookie method mints a key from a pasted console session", async () => {
  // 国际版没有注册 API：用户在网页端注册/登录后把会话粘进来，
  // 插件自己校验会话并在控制台铸一把 key —— 不需要口令。
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
  const seen = []
  const fakeFetch = async (url, init) => {
    const u = String(url)
    seen.push({ u, init })
    if (u.endsWith("/api/v1/users/status"))
      return json({ code: 0, data: { user: { email: "intl@example.com", id: "u9" } } })
    if (u.endsWith("/api/v1/users/ohmyagent/api-keys"))
      return json({ code: 0, data: { id: "k9", api_key: "oma_9", signing_secret: "omas_9" } })
    return json({ code: 0, data: {} })
  }
  const intl = await intlPlugin({}, { fetch: fakeFetch })
  const out = await intl.auth.methods.find((x) => x.label.includes("会话 Cookie")).authorize({ cookie: "sess-intl" })
  expect(out.type).toBe("success")
  expect(out.refresh).toBe("oma_9")
  expect(out.access).toBe("omas_9")
  expect(out.metadata.cookie).toBe("sess-intl")
  expect(out.metadata.email).toBe("intl@example.com")
  expect(out.metadata.base).toContain("monkeycode-ai.net")
  expect(out.expires).toBeGreaterThan(Date.now())
})

test("the cookie method rejects a session the console will not accept", async () => {
  const fakeFetch = async () => new Response("Unauthorized", { status: 401 })
  const intl = await intlPlugin({}, { fetch: fakeFetch })
  const out = await intl.auth.methods.find((x) => x.label.includes("会话 Cookie")).authorize({ cookie: "bogus" })
  expect(out.type).toBe("failed")
  expect(out.error).toContain("会话")
})

test("refreshLead is set so magpie renews before the session lapses", async () => {
  const cn = await cnPlugin({})
  expect(cn.auth.refreshLead).toBeGreaterThan(0)
  // 官方云的会话只有 7 天 ⇒ 提前量不能超过 24 小时（magpie 会把上限压到 24h）
  expect(cn.auth.refreshLead).toBeLessThanOrEqual(24 * 3600 * 1000)
})

test("all four hooks are wired", async () => {
  const cn = await cnPlugin({})
  expect(typeof cn.auth.refresh).toBe("function")
  expect(typeof cn.auth.loader).toBe("function")
  expect(typeof cn.auth.usage).toBe("function")
  expect(typeof cn.auth.checkin).toBe("function")
})

test("the loader without credentials returns nothing to send", async () => {
  const cn = await cnPlugin({})
  expect(await cn.auth.loader(async () => ({ type: "oauth", key: "", metadata: {} }))).toEqual({})
})

test("the loader without a signing secret refuses plainly", async () => {
  const cn = await cnPlugin({})
  const opts = await cn.auth.loader(async () => ({
    type: "oauth",
    key: "oma_abc",
    metadata: { secret: "" },
  }))
  expect(opts.apiKey).toBe("oma_abc")
  const res = await opts.fetch("https://example.invalid/v1/messages", { method: "POST" })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
})

test("the loader signs the request with the account's own secret", async () => {
  const cn = await cnPlugin({})
  const seen = []
  const fakeFetch = async (url, init) => {
    seen.push({ url, init })
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  }
  const hooks = await cnPlugin({}, { fetch: fakeFetch })
  const opts = await hooks.auth.loader(async () => ({
    type: "oauth",
    key: "oma_key1",
    metadata: { secret: "omas_secret1" },
  }))
  await opts.fetch("https://proxy.example.invalid/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-flash", max_tokens: 10, messages: [] }),
  })
  const h = seen[0].init.headers
  expect(h.get("X-Api-Key")).toBe("oma_key1")
  expect(h.get("Authorization")).toBe("Bearer oma_key1")
  expect(h.get("X-Ohmyagent-Signature")).toMatch(/^v1=[0-9a-f]{64}$/)
  expect(h.get("User-Agent")).toBe("ohmyagent f6b21ad")
  expect(h.get("Anthropic-Version")).toBe("2023-06-01")
  // 签名句进了 system 首位
  const body = JSON.parse(seen[0].init.body)
  expect(body.system[0].text).toBe("You are a helpful assistant.")
})

test("usage without a cookie says so instead of guessing", async () => {
  const cn = await cnPlugin({})
  const u = await cn.auth.usage(async () => ({ type: "oauth", key: "oma_k", metadata: {} }))
  expect(u.error).toContain("Cookie")
  expect(u.signIn).toBe("kept")
})

test("checkin is ineligible when there is no cookie and renewal cannot help", async () => {
  // 账号记录里没有会话、也没有口令/百智云会话 ⇒ 只能报「不可签」。
  // 必须隔离环境：否则会读到本机真实的 cookie 文件（测试就不再是单测了）。
  const tmp = mkdtempSync(join(tmpdir(), "mc-checkin-"))
  const cn = await cnPlugin({}, {
    env: {
      APPDATA: tmp,
      MONKEYCODE_COOKIE_FILE: join(tmp, "none.json"),
      MONKEYCODE_CREDENTIALS_FILE: join(tmp, "cred.json"),
      BAIZHI_COOKIE_FILE: join(tmp, "bz.json"),
    },
    fetch: async () => new Response("Unauthorized", { status: 401 }),
  })
  const r = await cn.auth.checkin(async () => ({ type: "oauth", key: "oma_k", metadata: {} }))
  expect(r.outcome).toBe("ineligible")
})

test("checkin renews a missing session before giving up", async () => {
  // 账号记录里没有会话，但服务器上的 cookie 文件里有 ⇒ 先续期（换新 key）再签到。
  const tmp = mkdtempSync(join(tmpdir(), "mc-checkin-"))
  const cookieFile = join(tmp, "cookies.json")
  writeFileSync(
    cookieFile,
    JSON.stringify([
      {
        name: "monkeycode_" + "ai_session",
        value: "sess-1",
        domain: "monkeycode-ai.com",
        path: "/",
        expires: new Date(Date.now() + 86400000).toISOString(),
      },
    ]),
  )
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
  const fakeFetch = async (url) => {
    const u = String(url)
    if (u.endsWith("/api/v1/users/status"))
      return json({ code: 0, data: { user: { email: "a@b.c", id: "u1" } } })
    if (u.endsWith("/api/v1/users/ohmyagent/api-keys"))
      return json({ code: 0, data: { id: "k1", api_key: "oma_new", signing_secret: "omas_new" } })
    if (u.endsWith("/api/v1/users/wallet"))
      return json({ code: 0, data: { balance: 1000, daily_token_balance: 10, daily_token_limit: 10 } })
    if (u.endsWith("/api/v1/users/subscription")) return json({ code: 0, data: { plan: "basic" } })
    if (u.includes("/wallet/checkin")) return json({ code: 0, data: { checked_in: true } })
    return json({ code: 0, data: {} })
  }
  const cn = await cnPlugin({}, {
    env: {
      APPDATA: tmp,
      MONKEYCODE_COOKIE_FILE: cookieFile,
      MONKEYCODE_CREDENTIALS_FILE: join(tmp, "cred.json"),
      BAIZHI_COOKIE_FILE: join(tmp, "bz.json"),
    },
    fetch: fakeFetch,
  })
  const r = await cn.auth.checkin(async () => ({
    type: "oauth",
    key: "oma_k",
    metadata: { email: "a@b.c", uid: "u1" },
  }))
  expect(r.outcome).toBe("done")
})

test("models() keeps the list magpie built when the console is unreachable", async () => {
  const hooks = await cnPlugin({}, { fetch: async () => new Response("nope", { status: 500 }) })
  const provider = { id: "monkeycode", models: { "basic/deepseek-flash": { id: "basic/deepseek-flash" } } }
  const out = await hooks.provider.models(provider, { auth: undefined })
  expect(Object.keys(out)).toEqual(["basic/deepseek-flash"])
})
