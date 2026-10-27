// 签到补测：T23 outcome 映射 / T24 判据严格性。
// 用注入的 fetchImpl 假上游，全程不碰网络。
import { test, expect } from "./harness.mjs"
import { runCheckin } from "../lib/checkin.mjs"

const ENV = { LOBSTER_API_BASE: "http://127.0.0.1:9/api" }
const TOKEN = "token-placeholder"

// 造一个假上游：按 path 给出槽位 / 上下文 / 签到三段响应
function fakeApi({ slot, context, checkin }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    calls.push({ u, method })
    const body = method === "GET" && u.includes("/slot?")
      ? slot
      : method === "GET" && u.includes("/context?")
        ? context
        : checkin
    return {
      status: body?.status ?? 200,
      text: async () => JSON.stringify(body?.payload ?? {}),
    }
  }
  return { fetchImpl, calls }
}

const SLOT_OK = {
  payload: {
    code: 0, message: "OK",
    data: { slotState: "available", activity: { activityCode: "act-1", configRevision: 7 } },
  },
}
const CTX_OK = {
  payload: {
    code: 0, message: "OK",
    data: {
      state: { claimedDays: 3, claimedToday: false },
      lifecycleState: "active",
      actions: ["check_in"],
    },
  },
}
const CHECKIN_GRANTED = {
  payload: { code: 0, message: "OK", data: { result: { creditsGranted: 5 } } },
}

test("T23 领到分才是 claimed", async () => {
  const { fetchImpl } = fakeApi({ slot: SLOT_OK, context: CTX_OK, checkin: CHECKIN_GRANTED })
  const out = await runCheckin({ token: TOKEN, version: "2030.1.2", env: ENV, fetchImpl })
  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe(5)
})

test("T23 上游说今天已领就是 done", async () => {
  const ctx = {
    payload: {
      code: 0, message: "OK",
      data: {
        state: { claimedDays: 4, claimedToday: true },
        lifecycleState: "active",
        actions: ["check_in"],
      },
    },
  }
  const { fetchImpl } = fakeApi({ slot: SLOT_OK, context: ctx, checkin: CHECKIN_GRANTED })
  const out = await runCheckin({ token: TOKEN, version: "2030.1.2", env: ENV, fetchImpl })
  expect(out.outcome).toBe("done")
  expect(out.streak).toBe(4)
})

test("T23 槽位不可用是 inactive", async () => {
  const slot = {
    payload: {
      code: 0, message: "OK",
      data: { slotState: "unavailable", activity: { activityCode: "act-1", configRevision: 7 } },
    },
  }
  const { fetchImpl } = fakeApi({ slot, context: CTX_OK, checkin: CHECKIN_GRANTED })
  const out = await runCheckin({ token: TOKEN, version: "2030.1.2", env: ENV, fetchImpl })
  expect(out.outcome).toBe("inactive")
})

test("T23 活动不是 active 是 ineligible", async () => {
  const ctx = {
    payload: {
      code: 0, message: "OK",
      data: {
        state: { claimedDays: 2, claimedToday: false },
        lifecycleState: "ended",
        actions: ["check_in"],
      },
    },
  }
  const { fetchImpl } = fakeApi({ slot: SLOT_OK, context: ctx, checkin: CHECKIN_GRANTED })
  const out = await runCheckin({ token: TOKEN, version: "2030.1.2", env: ENV, fetchImpl })
  expect(out.outcome).toBe("ineligible")
})

test("T24 code:0 但没发分，不许报 claimed", async () => {
  const zero = { payload: { code: 0, message: "OK", data: { result: { creditsGranted: 0 } } } }
  const { fetchImpl } = fakeApi({ slot: SLOT_OK, context: CTX_OK, checkin: zero })
  let caught = null
  let out = null
  try {
    out = await runCheckin({ token: TOKEN, version: "2030.1.2", env: ENV, fetchImpl })
  } catch (e) { caught = e }
  // 要么抛异常，要么返回一个不是 claimed/done 的 outcome —— 绝不能是 claimed
  if (caught) {
    expect(caught.message).toContain("creditsGranted")
  } else {
    expect(out.outcome).not.toBe("claimed")
    expect(out.outcome).not.toBe("done")
  }
})

// ── 插件级签到（T23 / T24）───────────────────────────────────────────
// ⚠️ 装配签名是 LobsterAuthPlugin(input, options)：fetch 走**第二个参数**，
//    放到第一个参数就会真打网络。
import { LobsterAuthPlugin as plugin } from "../index.mjs"

test("T23 插件 auth.checkin 用注入的 fetch 完成签到", async () => {
  const { fetchImpl } = fakeApi({ slot: SLOT_OK, context: CTX_OK, checkin: CHECKIN_GRANTED })
  const hooks = await plugin({}, { env: { ...ENV }, fetch: fetchImpl })
  const out = await hooks.auth.checkin(async () => ({ type: "oauth", access: TOKEN }))
  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe(5)
})

test("T24 插件 auth.checkin 在没发分时抛错，不报 claimed", async () => {
  const zero = { payload: { code: 0, message: "OK", data: { result: { creditsGranted: 0 } } } }
  const { fetchImpl } = fakeApi({ slot: SLOT_OK, context: CTX_OK, checkin: zero })
  const hooks = await plugin({}, { env: { ...ENV }, fetch: fetchImpl })
  let caught = null
  try {
    await hooks.auth.checkin(async () => ({ type: "oauth", access: TOKEN }))
  } catch (e) { caught = e }
  expect(caught).toBeTruthy()
  expect(caught?.message).toContain("creditsGranted")
})
