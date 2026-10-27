// 每日签到：client-activities 三段式（实测 code:0）。
//   ① GET  /api/client-activities/slot?placement=desktop_sidebar&clientVersion=…&containerApiVersion=2&platform=…
//   ② GET  /api/client-activities/{code}/context?configRevision=N
//   ③ POST /api/client-activities/{code}/actions/check_in  body {configRevision, idempotencyKey, payload:{}}
//
// ⚠️ 判据必须看 creditsGranted>0：HTTP 200 / code:0 不代表领到分（当日已领同样 200/code:0）。
// ⚠️ 不做本地节流文件：magpie 每个北京日调一次，本地再记一份状态只会把失败伪装成 done；
//    mrv 那份还用 UTC 日，和 magpie 的北京日调度错位。这里改用上游自己的 claimedToday 判据。

import { randomUUID } from "node:crypto"
import { apiUrl } from "./constants.mjs"

const CAPTCHA = /验证码|滑动验证|人机验证|captcha|verify/i
const PLATFORM = process.platform === "win32" ? "win32" : process.platform

// 北京日：上游按北京时间算「今天是否已领」，本地记时间也得用北京日
export function beijingDay(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

async function call(path, { token, method = "GET", body, env = process.env, fetchImpl = fetch }) {
  const res = await fetchImpl(apiUrl(env) + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let v = null
  try { v = JSON.parse(text) } catch { /* 非 JSON：按业务错误处理 */ }
  return { http: res.status, code: v?.code, message: String(v?.message ?? ""), data: v?.data, raw: v }
}

function isCaptcha(message) { return CAPTCHA.test(String(message ?? "")) }

// outcome 映射（magpie 的 auth.checkin 契约）：
//   claimed / done / ineligible / inactive / captcha；抛异常 = failed
export async function runCheckin({ token, version, env = process.env, fetchImpl = fetch, platform = PLATFORM }) {
  if (!token) throw new Error("尚未登录，无法签到")
  const q = new URLSearchParams({
    placement: "desktop_sidebar",
    clientVersion: String(version ?? ""),
    containerApiVersion: "2",
    platform: String(platform),
  })
  const slot = await call(`/client-activities/slot?${q}`, { token, env, fetchImpl })
  if (isCaptcha(slot.message)) return { outcome: "captcha", message: slot.message }
  if (slot.http !== 200 || slot.code !== 0) {
    throw new Error(`签到 slot 失败：http=${slot.http} code=${slot.code} ${slot.message}`)
  }
  const activity = slot.data?.activity
  if (slot.data?.slotState !== "available" || !activity) {
    return { outcome: "inactive", message: `当前没有签到活动（slotState=${slot.data?.slotState}）` }
  }

  const ctx = await call(
    `/client-activities/${encodeURIComponent(activity.activityCode)}/context?configRevision=${activity.configRevision}`,
    { token, env, fetchImpl },
  )
  if (isCaptcha(ctx.message)) return { outcome: "captcha", message: ctx.message }
  if (ctx.http !== 200 || ctx.code !== 0) {
    throw new Error(`签到 context 失败：http=${ctx.http} code=${ctx.code} ${ctx.message}`)
  }
  const state = ctx.data?.state ?? {}
  const claimedDays = Number(state.claimedDays ?? 0) || 0
  if (state.claimedToday) return { outcome: "done", streak: claimedDays, message: "今天已经领过了" }
  if (ctx.data?.lifecycleState !== "active") {
    return { outcome: "ineligible", streak: claimedDays, message: `活动状态 ${ctx.data?.lifecycleState}` }
  }
  if (!(ctx.data?.actions ?? []).includes("check_in")) {
    return { outcome: "ineligible", streak: claimedDays, message: "当前活动不提供签到" }
  }

  const body = {
    configRevision: activity.configRevision,
    idempotencyKey: `daily-check-in-${randomUUID()}`.slice(0, 64),
    payload: {},
  }
  const res = await call(
    `/client-activities/${encodeURIComponent(activity.activityCode)}/actions/check_in`,
    { token, method: "POST", body, env, fetchImpl },
  )
  if (isCaptcha(res.message)) return { outcome: "captcha", message: res.message }
  if (res.http !== 200 || res.code !== 0) {
    throw new Error(`签到失败：http=${res.http} code=${res.code} ${res.message}`)
  }
  const granted = Number(res.data?.result?.creditsGranted ?? 0)
  // 200 / code:0 只说明请求成功；当日已领同样 0 分 → 只有真拿到分才算 claimed
  if (!(granted > 0)) throw new Error("签到没有发分（creditsGranted=0）")
  return {
    outcome: "claimed",
    credit: granted,
    streak: claimedDays || 1,
    message: `签到成功，领取 ${granted} 点`,
  }
}
