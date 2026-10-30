import { test, expect } from "./harness.mjs"
import { createHash, createHmac } from "node:crypto"

import {
  bareModelID,
  upstreamModelID,
  labelOf,
  modelEntry,
  modelsConfig,
  withRates,
  applyAnthropic,
  applyResponses,
  isResponsesURL,
  signatureOf,
  rateFromPrice,
  hashOf,
} from "../lib/models.mjs"
import { capPRNG, capSolve, walletToUsage, formatTokens, sessionCookie, vendorMessage } from "../lib/console.mjs"
import { SIGN_PROMPT, MODEL_IDS } from "../lib/constants.mjs"

test("bareModelID strips the prefixes magpie and the client add", () => {
  expect(bareModelID("monkeycode/basic/deepseek-flash")).toBe("basic/deepseek-flash")
  expect(bareModelID("monkeycode-basic/deepseek-flash")).toBe("basic/deepseek-flash")
  expect(bareModelID("basic/deepseek-flash")).toBe("basic/deepseek-flash")
  expect(bareModelID("deepseek-flash")).toBe("deepseek-flash")
})

test("upstreamModelID gives the vendor the tiered name", () => {
  expect(upstreamModelID("basic/deepseek-flash")).toBe("monkeycode-basic/deepseek-flash")
  expect(upstreamModelID("pro/gpt-5.6-terra")).toBe("monkeycode-pro/gpt-5.6-terra")
  // 裸名照发（客户端的 settings.json 里裸名就是裸名）
  expect(upstreamModelID("deepseek-flash")).toBe("deepseek-flash")
})

test("the model table covers the client's catalogue", () => {
  const cfg = modelsConfig()
  expect(Object.keys(cfg).length).toBe(MODEL_IDS.length)
  expect(cfg["basic/deepseek-flash"].id).toBe("monkeycode-basic/deepseek-flash")
  expect(cfg["basic/deepseek-flash"].limit.context).toBe(200000)
  expect(cfg["basic/deepseek-flash"].limit.output).toBe(32000)
})

test("a model on the Responses endpoint gets the openai npm", () => {
  const cfg = modelsConfig()
  expect(cfg["ultra/gpt-6-astra"].provider.npm).toBe("@ai-sdk/openai")
  expect(cfg["basic/deepseek-flash"].provider).toBeUndefined()
})

test("withRates only marks models the console priced", () => {
  const cfg = modelsConfig()
  const rates = new Map([["basic/deepseek-flash", 1.5]])
  const out = withRates(cfg, rates)
  expect(out["basic/deepseek-flash"].rate).toBe(1.5)
  // 没标价的模型**保留没有倍率**，magpie 于是不画徽章，而不是画个编出来的数
  expect(out["basic/glm-5.3-flash"].rate).toBeUndefined()
})

test("applyAnthropic puts the signed sentence first", () => {
  const b = applyAnthropic({ system: [{ type: "text", text: "you are an agent" }], max_tokens: 5 })
  expect(b.system[0].text).toBe(SIGN_PROMPT)
  expect(b.system[1].text).toBe("you are an agent")
  expect(b.max_tokens).toBe(5)
})

test("applyAnthropic does not shape the same body twice", () => {
  const b = applyAnthropic({ system: "hi" })
  const again = applyAnthropic(b)
  expect(again.system.length).toBe(2)
  expect(again.system[0].text).toBe(SIGN_PROMPT)
  expect(again.system[1].text).toBe("hi")
})

test("applyAnthropic caps max_tokens at the vendor's limit", () => {
  expect(applyAnthropic({ max_tokens: 999999 }).max_tokens).toBe(32000)
  expect(applyAnthropic({}).max_tokens).toBe(16384)
  expect(applyAnthropic({ max_tokens: 0 }).max_tokens).toBe(16384)
})

test("applyAnthropic drops the metadata the official client never sends", () => {
  expect(applyAnthropic({ metadata: { user_id: "x" } }).metadata).toBeUndefined()
})

test("applyResponses signs input[0] and renames developer to system", () => {
  const b = applyResponses({
    instructions: "be brief",
    input: [{ role: "developer", content: "you are an agent" }],
    max_tokens: 100,
    store: true,
    metadata: { x: 1 },
  })
  expect(b.input[0].role).toBe("system")
  expect(b.input[0].content).toBe(SIGN_PROMPT)
  expect(b.input[1].role).toBe("system")
  expect(b.input[1].content).toBe("be brief")
  expect(b.input[2].role).toBe("system")
  expect(b.max_output_tokens).toBe(100)
  expect(b.max_tokens).toBeUndefined()
  expect(b.store).toBeUndefined()
  expect(b.metadata).toBeUndefined()
  expect(b.instructions).toBeUndefined()
})

test("isResponsesURL tells the two endpoints apart", () => {
  expect(isResponsesURL("https://proxy.monkeycode-ai.com/v1/responses")).toBe(true)
  expect(isResponsesURL("https://proxy.monkeycode-ai.com/v1/messages")).toBe(false)
})

test("the signature is a stable HMAC of the fixed sentence", () => {
  const sig = signatureOf("omas_secret")
  const want = "v1=" + createHmac("sha256", "omas_secret").update(SIGN_PROMPT, "utf8").digest("hex")
  expect(sig).toBe(want)
  // 同一把密钥两次算出来一样
  expect(signatureOf("omas_secret")).toBe(sig)
  expect(signatureOf("other")).not.toBe(sig)
  expect(signatureOf("")).toBe("")
})

test("rateFromPrice turns the console's price into a multiplier", () => {
  expect(rateFromPrice(200)).toBe(1)
  expect(rateFromPrice(400)).toBe(2)
  expect(rateFromPrice(0)).toBe(0)
  expect(rateFromPrice("nope")).toBe(0)
})

test("hashOf is a short fingerprint, not the secret", () => {
  const h = hashOf("oma_secret_value")
  expect(h.length).toBe(8)
  expect(h).not.toContain("secret")
})

test("the PoW prng is the vendor's FNV-1a over xorshift32", () => {
  // 定长输出，且同一 seed 每次一样
  const a = capPRNG("seed", 32)
  expect(a.length).toBe(32)
  expect(capPRNG("seed", 32)).toBe(a)
  expect(capPRNG("other", 32)).not.toBe(a)
})

test("the PoW solver finds the nonce the server wants", async () => {
  // 自己当一次服务端：算 target，然后验证解出来的 nonce 真的命中前缀
  const token = "tok-abc"
  const s = 4
  const d = 2
  const salt = capPRNG(token + "1", s)
  const target = capPRNG(token + "1d", d)
  const solutions = await capSolve(token, 1, s, d)
  expect(solutions.length).toBe(1)
  const nonce = solutions[0]
  expect(createHash("sha256").update(salt + nonce).digest("hex").startsWith(target)).toBe(true)
})

test("the PoW solver rejects an unsupported challenge", async () => {
  // capSolve 是 async —— 参数不对是**拒���的 promise**，不是同步抛
  await expect(() => capSolve("tok", 0, 4, 2)).toThrow()
  await expect(() => capSolve("", 1, 4, 2)).toThrow()
  await expect(() => capSolve("tok", 1, 4, 9)).toThrow()
})

test("the wallet turns into a usage card", () => {
  const u = walletToUsage({ balance: 9611688, daily_token_limit: 100000, daily_token_balance: 40000 })
  expect(u.balance).toBe("9612 积分")
  expect(u.windows.length).toBe(1)
  expect(u.windows[0].limit).toBe(100000)
  expect(u.windows[0].amount).toBe(60000)
  expect(u.windows[0].used).toBe(60)
})

test("a wallet with no daily limit reports no window rather than a fake one", () => {
  const u = walletToUsage({ balance: 1000 })
  expect(u.windows.length).toBe(0)
})

test("formatTokens is short", () => {
  expect(formatTokens(500)).toBe("500")
  expect(formatTokens(1500)).toBe("1.5K")
  expect(formatTokens(2000000)).toBe("2M")
})

test("sessionCookie picks the session out of Set-Cookie", () => {
  expect(
    sessionCookie([
      "other=1; Path=/",
      "monkeycode_ai_session=sess-1; Path=/; HttpOnly",
    ]),
  ).toBe("sess-1")
  expect(sessionCookie([])).toBe("")
})

test("vendorMessage finds the vendor's own wording", () => {
  expect(vendorMessage({ message: "余额不足" }, "fallback")).toBe("余额不足")
  expect(vendorMessage({ error: { message: "boom" } }, "fallback")).toBe("boom")
  expect(vendorMessage({}, "fallback")).toBe("fallback")
})
