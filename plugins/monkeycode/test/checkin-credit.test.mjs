// performCheckin 的钱包差额积分显示：
//   T1 领到积分且钱包差额可得 ⇒ claimed + credit + message 带数额
//   T2 钱包接口挂掉 ⇒ 仍 claimed，但不编数额
//   T3 已签过 ⇒ done，不查钱包
//   T4 差额为 0（记账延迟）⇒ 不报数额
// 全程注入 fetchImpl，不碰网络。
import { test, expect } from "./harness.mjs"
import { performCheckin } from "../lib/console.mjs"

const BASE = "https://monkeycode-ai.com"
const COOKIE = "monkeycode_ai_session=sess-1"

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })

// 造一个假上游：/wallet 按 walletBalances 序列逐次返回，/wallet/checkin 按 checkinResponses 逐次返回。
function fakeApi({ walletBalances = [], checkinResponses = [] }) {
  let walletCalls = 0
  let checkinCalls = 0
  const calls = []
  const fetchImpl = async (url, init) => {
    const u = String(url)
    calls.push({ u: u.replace(BASE, ""), method: init?.method ?? "GET" })
    if (u.includes("/wallet/checkin")) {
      const r = checkinResponses[Math.min(checkinCalls, checkinResponses.length - 1)]
      checkinCalls++
      return json(r)
    }
    if (u.includes("/users/wallet")) {
      const bal = walletBalances[Math.min(walletCalls, walletBalances.length - 1)]
      walletCalls++
      return json({ code: 0, data: { balance: bal, daily_token_balance: 10, daily_token_limit: 10 } })
    }
    if (u.includes("/captcha/challenge")) {
      // c=1 让 capSolve 一轮即出解（d=1 目标 1 个 hex 字符）
      return json({ code: 0, token: "t", challenge: { c: 1, s: 1, d: 1 }, expires: Date.now() + 60000 })
    }
    if (u.includes("/captcha/redeem")) return json({ success: true, token: "cap-tok" })
    return json({ code: 0, data: {} })
  }
  return { fetchImpl, calls }
}

test("T1 签到成功且钱包差额可得 ⇒ claimed + credit", async () => {
  const { fetchImpl } = fakeApi({
    walletBalances: [50_000, 150_000], // 50 积分 → 150 积分
    checkinResponses: [{ code: 0, data: { checked_in: false } }, { code: 0, data: { checked_in: true } }],
  })
  const r = await performCheckin(BASE, COOKIE, { fetchImpl })
  expect(r.outcome).toBe("claimed")
  expect(r.credit).toBe(100)
  expect(r.message).toContain("+100")
})

test("T2 钱包接口挂掉 ⇒ 仍 claimed，不编数额", async () => {
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.includes("/wallet/checkin")) {
      const r = init?.method === "POST" && JSON.parse(init.body).captcha_token
        ? { code: 0, data: { checked_in: true } }
        : { code: 0, data: { checked_in: false } }
      return json(r)
    }
    if (u.includes("/users/wallet")) return new Response("boom", { status: 500 })
    if (u.includes("/captcha/challenge"))
      return json({ code: 0, token: "t", challenge: { c: 1, s: 1, d: 1 }, expires: Date.now() + 60000 })
    if (u.includes("/captcha/redeem")) return json({ success: true, token: "cap-tok" })
    return json({ code: 0, data: {} })
  }
  const r = await performCheckin(BASE, COOKIE, { fetchImpl })
  expect(r.outcome).toBe("claimed")
  expect(r.credit).toBeUndefined()
  expect(r.message).toBe("签到成功")
})

test("T3 已签过 ⇒ done，不查钱包", async () => {
  const { fetchImpl, calls } = fakeApi({
    walletBalances: [999_999],
    checkinResponses: [{ code: 0, data: { checked_in: true } }],
  })
  const r = await performCheckin(BASE, COOKIE, { fetchImpl })
  expect(r.outcome).toBe("done")
  expect(r.message).toBe("今日已签到")
  // checkin 状态查询走的是 /wallet/checkin；真正的钱包接口（/users/wallet）一次都不该被调
  expect(calls.filter((c) => c.u.endsWith("/users/wallet")).length).toBe(0)
})

test("T4 记账延迟差额为 0 ⇒ claimed 不报数额", async () => {
  const { fetchImpl } = fakeApi({
    walletBalances: [50_000, 50_000],
    checkinResponses: [{ code: 0, data: { checked_in: false } }, { code: 0, data: { checked_in: true } }],
  })
  const r = await performCheckin(BASE, COOKIE, { fetchImpl })
  expect(r.outcome).toBe("claimed")
  expect(r.credit).toBeUndefined()
  expect(r.message).toBe("签到成功")
})
