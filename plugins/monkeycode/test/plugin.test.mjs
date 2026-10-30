import { test, expect } from "./harness.mjs"
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

test("three sign-in methods are offered, all keyless", async () => {
  const cn = await cnPlugin({})
  expect(cn.auth.methods.length).toBe(3)
  for (const m of cn.auth.methods) {
    // keyless ⇒ magpie 不从 stdin 要 API key
    expect(m.type).toBe("api")
    expect(m.keyless).toBe(true)
    expect(typeof m.authorize).toBe("function")
  }
  // 下标是契约：1 读客户端配置 / 2 服务器端账密登录 / 3 手动填写
  expect(cn.auth.methods[0].label).toContain("客户端登录态")
  expect(cn.auth.methods[1].label).toContain("服务器端登录")
  expect(cn.auth.methods[2].label).toContain("手动填写")
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

test("checkin without a cookie is ineligible, not a failure", async () => {
  const cn = await cnPlugin({})
  const r = await cn.auth.checkin(async () => ({ type: "oauth", key: "oma_k", metadata: {} }))
  expect(r.outcome).toBe("ineligible")
})

test("models() keeps the list magpie built when the console is unreachable", async () => {
  const hooks = await cnPlugin({}, { fetch: async () => new Response("nope", { status: 500 }) })
  const provider = { id: "monkeycode", models: { "basic/deepseek-flash": { id: "basic/deepseek-flash" } } }
  const out = await hooks.provider.models(provider, { auth: undefined })
  expect(Object.keys(out)).toEqual(["basic/deepseek-flash"])
})
