// 模型目录降级补测：T21 三级降级 / T22 magpie.fellBack 标记 / T21 signIn 路径。
//
// ⚠️ 插件的装配方式是 LobsterAuthPlugin(input, options)：
//    env 与 fetch 都从**第二个参数 options** 来 —— input 只有 client/directory/project。
//    fetch 传错位置 ⇒ fetchImpl 落到全局 fetch ⇒ 真打网络拿 401 ⇒ apiGet 抛 signIn:expired。
//    options.env 的值必须是**字符串**（实现只收 typeof v === 'string'）。
// 假 fetch 的返回对象必须满足 apiGet 的用法：res.status 与 res.text()（Promise<string>）。
import { test, expect } from "./harness.mjs"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LobsterAuthPlugin as plugin, _internal } from "../index.mjs"
import { PROVIDER, FALLBACK_MODELS } from "../lib/constants.mjs"

const ENV = { LOBSTER_API_BASE: "http://127.0.0.1:9/api" }
const CLOUD_ENTRY = {
  modelId: "cloud-model", modelName: "Cloud Model",
  contextWindow: 1000000, accessible: true, supportsThinking: false,
}
const PROVIDER_CFG = () => ({ id: PROVIDER, models: { ...FALLBACK_MODELS } })

// 造一份 openclaw 托管目录
function makeOpenclaw(dir) {
  const file = join(dir, "openclaw.json")
  writeFileSync(file, JSON.stringify({
    models: {
      providers: {
        "lobsterai-server": {
          models: [
            { id: "managed-model", name: "Managed Model", input: ["text"], contextWindow: 200000 },
          ],
        },
      },
    },
  }))
  return file
}

test("T21 云端可用时用云端目录", async () => {
  const hooks = await plugin({}, {
    env: { ...ENV },
    fetch: async () => ({
      status: 200,
      text: async () => JSON.stringify({ code: 0, message: "OK", data: [CLOUD_ENTRY] }),
    }),
  })
  const out = await hooks.provider.models(PROVIDER_CFG(), { auth: { type: "oauth", access: "tok" } })
  expect(Object.keys(out)).toEqual(["cloud-model"])
  expect(out["cloud-model"].name).toBe("Cloud Model")
})

test("T21 云端抛错时回退 openclaw 目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-oc-"))
  try {
    const oc = makeOpenclaw(dir)
    const hooks = await plugin({}, {
      env: { ...ENV, LOBSTER_OPENCLAW_PATH: oc },
      fetch: async () => { throw new Error("boom") },
    })
    const out = await hooks.provider.models(PROVIDER_CFG(), { auth: { type: "oauth", access: "tok" } })
    expect(Object.keys(out)).toEqual(["managed-model"])
    expect(out["managed-model"].name).toBe("Managed Model")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T21 两者皆无时回退静态表，静态表含 kimi-k3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-none-"))
  try {
    const hooks = await plugin({}, {
      env: { ...ENV, LOBSTER_OPENCLAW_PATH: join(dir, "absent.json") },
      fetch: async () => { throw new Error("boom") },
    })
    const out = await hooks.provider.models(PROVIDER_CFG(), { auth: { type: "oauth", access: "tok" } })
    expect(Object.keys(out)).toContain("kimi-k3")
    expect(Object.keys(out).length).toBe(Object.keys(FALLBACK_MODELS).length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T21 云端给了空目录也算降级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-empty-"))
  try {
    const hooks = await plugin({}, {
      env: { ...ENV, LOBSTER_OPENCLAW_PATH: join(dir, "absent.json") },
      fetch: async () => ({
        status: 200,
        text: async () => JSON.stringify({ code: 0, message: "OK", data: [] }),
      }),
    })
    const out = await hooks.provider.models(PROVIDER_CFG(), { auth: { type: "oauth", access: "tok" } })
    expect(Object.keys(out)).toContain("kimi-k3")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T22 降级列表带 magpie.fellBack 标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-fb-"))
  try {
    const hooks = await plugin({}, {
      env: { ...ENV, LOBSTER_OPENCLAW_PATH: join(dir, "absent.json") },
      fetch: async () => { throw new Error("boom") },
    })
    const out = await hooks.provider.models(PROVIDER_CFG(), { auth: { type: "oauth", access: "tok" } })
    // 官方文档要求：返回自己的列表时必须打上这个标记
    expect(out[Symbol.for("magpie.fellBack")]).toBe(true)
    expect(_internal.FELL_BACK).toBe(Symbol.for("magpie.fellBack"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T21 上游 401 是登录失效：抛错，不降级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lobster-401-"))
  try {
    const hooks = await plugin({}, {
      env: { ...ENV, LOBSTER_OPENCLAW_PATH: join(dir, "absent.json") },
      fetch: async () => ({ status: 401, text: async () => "{}" }),
    })
    let caught = null
    try {
      await hooks.provider.models(PROVIDER_CFG(), { auth: { type: "oauth", access: "tok" } })
    } catch (e) { caught = e }
    // 登录失效必须冒泡（magpie 据此把账号标记为需重登），不能悄悄降级
    expect(caught).toBeTruthy()
    expect(caught?.signIn).toBe("expired")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
