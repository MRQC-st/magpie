// A 通道（百智云 baizhi.cloud）的每日临时额度领取。
//
// 为什么在插件里做：
//   MonkeyCode 有**两条计费通道**，余额来自**两个不同的钱包**：
//     A 通道 ai-models.app.baizhi.cloud  ← 钱包在 baizhi.cloud（百智云）
//     B 通道 proxy.monkeycode-ai.com    ← 钱包在 monkeycode-ai.com（官方云）
//   社区插件只做了 B。A 的余额来自百智云的「每日临时额度」，
//   **不领就是 0** ⇒ 上游回 `400 余额不足`。所以 A 也得每天领。
//
//   本仓库原先用 scripts/baizhi-checkin.py 单独跑；搬进插件后
//   magpie 自己的插件签到 tick 就把两条通道都盖住了。
//
// ⚠️ A 通道的 wallet API **不在开源客户端里** —— 是逆向出来的。
//    路径与 B 通道**不同**（/api/v1/user/… 单数，不是 /api/v1/users/… 复数）。

import { capPRNG, capSolve } from "./console.mjs"
import { readCookieFile, cookieValue, ACCOUNT_COOKIE } from "./credentials.mjs"

// BAIZHI_BASE 百智云账号站（只有国内版有）。
export const BAIZHI_BASE = "https://baizhi.cloud"

// baizhiFetch 发一次百智云请求（带账号站 cookie）。
async function baizhiFetch(path, { method = "GET", body, cookie, fetchImpl = fetch } = {}) {
  const headers = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    Referer: `${BAIZHI_BASE}/console/wallet`,
    ...(cookie ? { Cookie: `${ACCOUNT_COOKIE}=${cookie}` } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  }
  const res = await fetchImpl(BAIZHI_BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  return { status: res.status, ok: res.ok, payload, text }
}

// baizhiCaptchaToken 走一遍 Cap PoW 拿 captcha_token。
//
// 百智云的 challenge/redeem 端点是 /api/v1/public/captcha/{challenge,redeem}
// —— 与 MonkeyCode 官方云**同源同路径**，只是主机不同。
async function baizhiCaptchaToken({ fetchImpl = fetch } = {}) {
  const ch = await baizhiFetch("/api/v1/public/captcha/challenge", { method: "POST", body: {}, fetchImpl })
  if (!ch.ok || !ch.payload?.token) {
    throw new Error(`百智云 PoW 挑战失败 HTTP ${ch.status}`)
  }
  const meta = ch.payload.challenge ?? {}
  const solutions = await capSolve(ch.payload.token, meta.c, meta.s, meta.d, {
    deadline: Math.min(Date.now() + 15000, ch.payload.expires ?? Infinity),
  })
  const rd = await baizhiFetch("/api/v1/public/captcha/redeem", {
    method: "POST",
    body: { token: ch.payload.token, solutions },
    fetchImpl,
  })
  if (!rd.ok || rd.payload?.success !== true || typeof rd.payload?.token !== "string") {
    throw new Error("百智云 PoW 凭证兑换失败")
  }
  return rd.payload.token
}

// fetchBaizhiBalance 读百智云钱包（是否有可领的临时额度）。
export async function fetchBaizhiBalance(cookie, { fetchImpl = fetch } = {}) {
  const r = await baizhiFetch("/api/v1/user/wallet/balance", { cookie, fetchImpl })
  if (r.status === 401) {
    const err = new Error("百智云会话已过期")
    err.status = 401
    throw err
  }
  if (!r.ok) throw new Error(`百智云钱包 HTTP ${r.status}`)
  return r.payload?.data ?? {}
}

// claimBaizhiDailyCredit 领今天的临时额度。
//
// 幂等：服务端以日为键，领过了再领不会加倍。
export async function claimBaizhiDailyCredit(cookie, { fetchImpl = fetch } = {}) {
  const before = await fetchBaizhiBalance(cookie, { fetchImpl })
  if (before?.daily_temporary_credit_claimed === true) {
    return { outcome: "done", message: "今日已领取每日临时额度" }
  }
  const token = await baizhiCaptchaToken({ fetchImpl })
  const r = await baizhiFetch("/api/v1/user/wallet/daily-temporary-credit", {
    method: "POST",
    body: { captcha_token: token },
    cookie,
    fetchImpl,
  })
  if (!r.ok) throw new Error(`领取每日临时额度 HTTP ${r.status}`)
  if (r.payload && Number.isFinite(r.payload.code) && r.payload.code !== 0) {
    throw new Error(`领取每日临时额度 code=${r.payload.code} ${r.payload.message ?? ""}`.trim())
  }
  return { outcome: "claimed", message: "已领取百智云每日临时额度（+100 积分）" }
}

// baizhiCookieFrom 从 cookie 文件里取百智云账号会话。
export function baizhiCookieFrom(path) {
  if (!path) return ""
  return cookieValue(readCookieFile(path), ACCOUNT_COOKIE, { expired: "drop" })
}

// baizhiBalanceToUsage 把百智云钱包翻成 magpie 的额度卡片。
export function baizhiBalanceToUsage(data) {
  const cents = Number(data?.available_credit_cents) || 0
  const credits = Math.round(cents / 100)
  const windows = []
  if (credits > 0) {
    windows.push({
      name: "百智云可用积分",
      used: 0,
      display: `${credits} 积分`,
      amount: credits,
      limit: credits,
      unit: "credits",
    })
  }
  return { plan: "MonkeyCode A 通道（百智云）", balance: `${credits} 积分`, windows }
}

export { capPRNG }
