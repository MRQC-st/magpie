// 控制台 API 客户端：钱包、签到、会员模型目录、api key 铸造、账密登录。
//
// 全部走 `https://<console>/api/v1/...`；国内版与国际版**路径逐字相同**，
// 只有主机名不同（上游 mc_call() 就是这么拼的，没有按地区分支的逻辑）。
//
// 凭据处理：**只输出状态与业务码，绝不打印 cookie / key / 口令的值。**

import { createHash } from "node:crypto"
import { setImmediate as yieldTurn } from "node:timers/promises"

import { AGENT_UA, SESSION_COOKIE, ACCOUNT_COOKIE } from "./constants.mjs"

const TIMEOUT = 20_000

// hostOf 从基址取出主机名（OAuth 桥要判断「有没有落到账号站」）。
//
// ⚠️ 不能从 session.mjs import —— session.mjs 要 import 本模块，
//    那样就成环了（ESM 里环能跑，但导出函数的初始化顺序会踩坑）。
function hostOf(base) {
  try {
    return new URL(String(base)).hostname
  } catch {
    return ""
  }
}

// ---- 底层 HTTP --------------------------------------------------------------

export async function readJSON(res) {
  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  return { text, payload }
}

export function vendorMessage(payload, fallback) {
  for (const k of ["message", "msg", "error_description", "detail"]) {
    const v = payload?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  const e = payload?.error
  if (typeof e === "string" && e.trim()) return e.trim()
  if (typeof e?.message === "string" && e.message.trim()) return e.message.trim()
  return fallback
}

// sessionCookie 从 Set-Cookie 列表里取会话 cookie 的值。
export function sessionCookie(setCookies, name = SESSION_COOKIE) {
  for (const c of setCookies ?? []) {
    const first = String(c).split(";")[0]
    if (!first.startsWith(name + "=")) continue
    return first.slice(name.length + 1)
  }
  return ""
}

// consoleFetch 发一次控制台请求。
//
// `cookie` 为空 ⇒ 不带 Cookie 头（登录类端点用）。
export async function consoleFetch(
  consoleBase,
  path,
  { method = "GET", body, cookie, headers = {}, fetchImpl = fetch, timeout = TIMEOUT, redirect = "follow" } = {},
) {
  const h = {
    Accept: "application/json",
    "User-Agent": AGENT_UA,
    ...(cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...headers,
  }
  const res = await fetchImpl(consoleBase + path, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
    redirect,
  })
  return res
}

// ---- 账户状态 ---------------------------------------------------------------

// fetchStatus 读会话状态：谁登录着、是不是被封。
export async function fetchStatus(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  const res = await consoleFetch(consoleBase, "/api/v1/users/status", { cookie, fetchImpl })
  const { text, payload } = await readJSON(res)
  if (res.status === 401) {
    const err = new Error("控制台会话已过期")
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(`会话状态 HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
  if (Number(payload?.code) !== 0) throw new Error(`会话状态 code=${payload?.code} ${vendorMessage(payload, "")}`.trim())
  return payload?.data ?? {}
}

// userIdentity 从 /users/status 里取出账号身份（邮箱 + id）。
export function userIdentity(status) {
  const u = status?.user ?? {}
  return {
    email: String(u.email ?? "").trim(),
    name: String(u.name ?? "").trim(),
    id: String(u.id ?? "").trim(),
  }
}

// ---- 钱包 -------------------------------------------------------------------

// fetchWallet 读钱包。balance 单位是 1/1000 积分，日额度字段单位是 token。
export async function fetchWallet(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  const res = await consoleFetch(consoleBase, "/api/v1/users/wallet", { cookie, fetchImpl })
  const { text, payload } = await readJSON(res)
  if (res.status === 401) {
    const err = new Error("控制台会话已过期")
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(`钱包接口 HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
  if (!payload || typeof payload !== "object") throw new Error("钱包接口返回的不是 JSON")
  if (Number(payload.code) !== 0) throw new Error(`钱包接口 code=${payload.code} ${vendorMessage(payload, "")}`.trim())
  return payload.data ?? {}
}

// fetchSubscription 读会员档位（决定能用哪些档的模型）。
export async function fetchSubscription(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  const res = await consoleFetch(consoleBase, "/api/v1/users/subscription", { cookie, fetchImpl })
  const { text, payload } = await readJSON(res)
  if (res.status === 401) {
    const err = new Error("控制台会话已过期")
    err.status = 401
    throw err
  }
  if (!res.ok) return { plan: "", error: `订阅接口 HTTP ${res.status}` }
  if (Number(payload?.code) !== 0) return { plan: "", error: `订阅接口 code=${payload?.code}` }
  return payload?.data ?? {}
}

// walletToUsage 把钱包翻成 magpie 的额度卡片。
export function walletToUsage(data, { plan = "" } = {}) {
  const milli = Number(data?.balance) || 0
  const credits = milli > 0 ? Math.ceil(milli / 1000) : 0
  const limit = Number(data?.daily_token_limit) || 0
  const remain = Number(data?.daily_token_balance) || 0
  const used = Math.max(0, limit - remain)
  const windows = []
  if (limit > 0) {
    windows.push({
      name: "每日 Token 额度",
      used: (used / limit) * 100,
      display: `${formatTokens(used)} / ${formatTokens(limit)} tokens`,
      amount: used,
      limit,
      unit: "tokens",
      span: 86400,
    })
  }
  return {
    plan: plan || "MonkeyCode",
    balance: `${credits} 积分`,
    windows,
  }
}

export function formatTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`
  return String(v)
}

// ---- Cap PoW（@cap.js 0.0.6 族）-------------------------------------------

// capPRNG 用 FNV-1a 播种 xorshift32。索引从 1 开始 —— 与上游
// wild-work/internal/monkeycode/captcha.go 和厂商的 redeem 端点一致。
export function capPRNG(seed, length) {
  let state = 2166136261
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i)
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24)
  }
  let out = ""
  while (out.length < length) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out += (state >>> 0).toString(16).padStart(8, "0")
  }
  return out.slice(0, length)
}

// capSolve 解 PoW 挑战。
//
// ⚠️ 坑：服务端按**完整 hex 前缀**比对 —— d=3 是奇数也要比满 3 个字符。
//    只比 floor(d/2) 字节会被判 "invalid solutions"。
export async function capSolve(token, c, s, d, { signal, deadline = Date.now() + 15000 } = {}) {
  if (
    typeof token !== "string" || !token || token.length > 512 ||
    !Number.isInteger(c) || c < 1 || c > 100 ||
    !Number.isInteger(s) || s < 1 || s > 128 ||
    !Number.isInteger(d) || d < 1 || d > 5 || !Number.isFinite(deadline)
  ) {
    throw new Error("PoW 挑战参数不受支持")
  }
  const check = () => {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error("PoW 挑战已过期或计算超时")
  }
  check()
  const solutions = []
  let work = 0
  for (let i = 1; i <= c; i++) {
    const salt = capPRNG(token + i, s)
    const target = capPRNG(token + i + "d", d)
    for (let nonce = 0; ; nonce++) {
      if ((work++ & 2047) === 0) {
        // 让插件宿主能同时服务对话并处理取消
        await yieldTurn()
        check()
      }
      if (createHash("sha256").update(salt + nonce).digest("hex").startsWith(target)) {
        solutions.push(nonce)
        break
      }
    }
  }
  check()
  return solutions
}

// captchaToken 走一遍 challenge → 求解 → redeem，拿到 captcha_token。
export async function captchaToken(consoleBase, { fetchImpl = fetch, signal } = {}) {
  const res = await consoleFetch(consoleBase, "/api/v1/public/captcha/challenge", {
    method: "POST",
    body: {},
    fetchImpl,
    ...(signal ? { timeout: TIMEOUT } : {}),
  })
  const { text, payload } = await readJSON(res)
  if (!res.ok) throw new Error(`PoW 挑战 HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
  const token = payload?.token
  const meta = payload?.challenge ?? {}
  const expires = payload?.expires
  if (typeof token !== "string" || !token) throw new Error("PoW 挑战没有 token")
  if (expires !== undefined && (!Number.isFinite(expires) || expires <= Date.now())) {
    throw new Error("PoW 挑战已过期或有效期无效")
  }
  const solutions = await capSolve(token, meta.c, meta.s, meta.d, {
    signal,
    deadline: Math.min(Date.now() + 15000, expires ?? Infinity),
  })
  const rd = await consoleFetch(consoleBase, "/api/v1/public/captcha/redeem", {
    method: "POST",
    body: { token, solutions },
    fetchImpl,
  })
  const rdJson = await readJSON(rd)
  if (!rd.ok || rdJson.payload?.success !== true || typeof rdJson.payload?.token !== "string") {
    throw new Error("PoW 凭证兑换失败")
  }
  return rdJson.payload.token
}

// ---- 签到 -------------------------------------------------------------------

// checkinJSON 签到相关请求。
async function checkinJSON(consoleBase, cookie, path, body, signal, fetchImpl) {
  const res = await consoleFetch(consoleBase, path, {
    method: body === undefined ? "GET" : "POST",
    body,
    cookie,
    fetchImpl,
    redirect: "error",
    timeout: 45000,
  })
  if (!res.ok) {
    await res.body?.cancel()
    const err = new Error(res.status === 401 ? "控制台会话已过期，请重新导入登录态" : `签到接口 HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const { payload } = await readJSON(res)
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("签到接口返回的不是 JSON 对象")
  return payload
}

function checkinData(payload) {
  if (payload.code !== 0) {
    throw new Error(`签到接口业务状态异常（code=${Number.isFinite(payload.code) ? payload.code : "unknown"}）`)
  }
  if (typeof payload.data?.checked_in !== "boolean") throw new Error("签到回执缺少 checked_in")
  return payload.data.checked_in
}

// performCheckin 领今天的积分。幂等：已签过就只报状态。
// 回执里没有奖励数额 —— **绝不编一个积分数字**；改用签到前后钱包差额如实计算，
// 差额拿不到（钱包接口失败 / 上游记账延迟）就不报数额，只报状态。
export async function performCheckin(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  const signal = AbortSignal.timeout(45000)
  const path = "/api/v1/users/wallet/checkin"
  if (checkinData(await checkinJSON(consoleBase, cookie, path, undefined, signal, fetchImpl))) {
    return { outcome: "done", message: "今日已签到" }
  }
  const before = await walletBalanceSafe(consoleBase, cookie, { fetchImpl })
  const token = await captchaToken(consoleBase, { fetchImpl, signal })
  if (!checkinData(await checkinJSON(consoleBase, cookie, path, { captcha_token: token }, signal, fetchImpl))) {
    throw new Error("签到未生效（checked_in=false）")
  }
  const after = await walletBalanceSafe(consoleBase, cookie, { fetchImpl })
  const delta = before !== null && after !== null ? Math.round((after - before) / 1000) : null
  return {
    outcome: "claimed",
    credit: delta !== null && delta !== 0 ? delta : undefined,
    message: delta !== null && delta !== 0
      ? `签到成功（钱包差额 +${delta} 积分）`
      : "签到成功",
  }
}

// walletBalanceSafe 读钱包余额（1/1000 积分），失败返回 null —— 签到的成败不依赖它。
async function walletBalanceSafe(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  try {
    const data = await fetchWallet(consoleBase, cookie, { fetchImpl })
    const bal = Number(data?.balance)
    return Number.isFinite(bal) ? bal : null
  } catch {
    return null
  }
}

// 并发按键合并（同一账号），失败后允许重试。
const checkinFlights = new Map()
export function checkinFor(consoleBase, cookie, opts = {}) {
  const key = `${consoleBase}|${cookie.slice(-12)}`
  let pending = checkinFlights.get(key)
  if (!pending) {
    pending = performCheckin(consoleBase, cookie, opts).finally(() => checkinFlights.delete(key))
    checkinFlights.set(key, pending)
  }
  return pending
}

// ---- 会员模型目录 -----------------------------------------------------------

// fetchRates 读控制台的每模型 input_price，折成 magpie 显示的倍率。
export async function fetchRates(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  if (!cookie) return { rates: new Map(), why: "no console cookie" }
  const res = await consoleFetch(consoleBase, "/api/v1/users/models/available", { cookie, fetchImpl, timeout: 10000 })
  const { payload } = await readJSON(res)
  if (!res.ok || Number(payload?.code) !== 0 || !Array.isArray(payload?.data)) {
    return { rates: new Map(), why: `HTTP ${res.status}` }
  }
  const rates = new Map()
  for (const row of payload.data) {
    const name = String(row?.name ?? row?.model ?? "")
    const price = Number(row?.input_price)
    if (!name || !Number.isFinite(price) || price <= 0) continue
    const bare = name.startsWith("monkeycode-") ? name.slice("monkeycode-".length) : name
    rates.set(bare, price / 200)
  }
  return { rates, why: "" }
}

// fetchModelCatalogue 读控制台列出的模型（含会员档位可见性）。
export async function fetchModelCatalogue(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  const res = await consoleFetch(consoleBase, "/api/v1/users/models/available", { cookie, fetchImpl })
  const { payload } = await readJSON(res)
  if (!res.ok || Number(payload?.code) !== 0 || !Array.isArray(payload?.data)) {
    return { models: [], error: `HTTP ${res.status}` }
  }
  return { models: payload.data, error: "" }
}

// ---- api key 铸造 -----------------------------------------------------------

// mintApiKey 在控制台**铸造一把新的 oma_ key + 签名密钥**。
//
// ⚠️ 这条是「彻底脱离本机电脑」的关键：服务器只要有控制台会话 cookie，
//    就能自己申请一把推理凭据，不需要桌面端、不需要复制 settings.json。
//    凭据是账号级的，签入哪个账号就用哪个账号的额度。
export async function mintApiKey(consoleBase, cookie, { fetchImpl = fetch } = {}) {
  const res = await consoleFetch(consoleBase, "/api/v1/users/ohmyagent/api-keys", {
    method: "POST",
    body: {},
    cookie,
    fetchImpl,
  })
  const { text, payload } = await readJSON(res)
  if (res.status === 401) {
    const err = new Error("控制台会话已过期，无法铸造 api key")
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(`铸造 api key HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
  const d = payload?.data
  if (!d || !d.id || !d.api_key || !d.signing_secret) {
    throw new Error("铸造 api key 失败：响应缺少必要字段")
  }
  return { id: String(d.id), key: String(d.api_key), secret: String(d.signing_secret) }
}

// deleteApiKey 撤销一把 api key。
export async function deleteApiKey(consoleBase, cookie, id, { fetchImpl = fetch } = {}) {
  const res = await consoleFetch(consoleBase, `/api/v1/users/ohmyagent/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cookie,
    fetchImpl,
  })
  if (!res.ok && res.status !== 404) throw new Error(`撤销 api key HTTP ${res.status}`)
  return true
}

// ---- 账密登录 ---------------------------------------------------------------

// passwordLogin 用邮箱 + 口令换一个会话 cookie。
//
// captcha 是在**本 provider 的主机**上取的（国内 .com / 国际 .net），
// 所以国际版不必绕道百智云的 OAuth 桥。
export async function passwordLogin(consoleBase, email, password, { fetchImpl = fetch } = {}) {
  const token = await captchaToken(consoleBase, { fetchImpl })
  const res = await fetchImpl(consoleBase + "/api/v1/users/password-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": AGENT_UA,
    },
    body: JSON.stringify({ email, password, captcha_token: token }),
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: "manual",
  })
  const setCookies = res.headers.getSetCookie?.() ?? []
  const sess = sessionCookie(setCookies)
  if (sess) return { ok: true, session: sess }
  const { text, payload } = await readJSON(res)
  return {
    ok: false,
    http: res.status,
    code: Number.isFinite(payload?.code) ? payload.code : undefined,
    message: vendorMessage(payload, text.slice(0, 160)),
  }
}

// ---- OAuth 桥（百智云账号 → MonkeyCode 会话）--------------------------------

// bridgeLogin 走百智云的 OAuth 桥换一个 MonkeyCode 会话。
//
// 链路（上游 desktop/src/baizhi/monkeycode.rs 的 login_monkeycode）：
//   GET {mc}/api/v1/users/login?redirect=&inviter_id=  → 302
//   → {account}/oauth/authorize?…（授权**页面**）
//   → 改写成 {account}/api/v1/oauth/authorize API（带百智 cookie）
//   → 302 → {mc}/api/v1/users/baizhi/callback?code=… → Set-Cookie 会话
//   → 302 → {mc}/ 前端页 → 链走完（落在 2xx）
//
// ⚠️ 三个必须照上游做的点（踩过的坑）：
//   ① 改写授权地址时**按名字取参数再逐个 append**，不能把原 query 整段照抄 ——
//      原 query 里的 `scope=user+phone` 是 `+` 编码，服务端不把它当空格，
//      整段照抄会得到 `400 参数错误`（实测）。
//   ② 自己维护 cookie 罐（百智 cookie + 链上种下的其它 cookie），
//      不能只带一个 `baizhi_session` 走到底。
//   ③ 手动跟随重定向（`redirect: "manual"`），一路跟到 2xx 为止。
//
// 只在国内版可用（国际版的官方 UI 只给邮箱登录），但两条路都留着。
export async function bridgeLogin(consoleBase, accountBase, accountCookieValue, { fetchImpl = fetch } = {}) {
  const ua = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/json,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  }

  // cookie 罐：名字 → 值。百智 cookie 是入口，链上还会种下别的。
  const jar = new Map()
  const seed = String(accountCookieValue ?? "").trim()
  if (seed) jar.set(ACCOUNT_COOKIE, seed)
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")

  // absorb 把响应头里的 Set-Cookie 收进罐子。
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = String(c).split(";")[0]
      const at = kv.indexOf("=")
      if (at > 0) jar.set(kv.slice(0, at).trim(), kv.slice(at + 1).trim())
    }
  }

  const accountHost = hostOf(accountBase)
  let cur = `${consoleBase}/api/v1/users/login?redirect=&inviter_id=`

  // 跳数上限与上游一致（实测 4~6 跳，留余量防环）。
  for (let hop = 0; hop < 12; hop++) {
    const u = new URL(cur)

    // 落到百智授权「页面」时改写成 API 端点（WebView 里这一跳由页面 JS 完成）。
    if (u.hostname === accountHost && u.pathname === "/oauth/authorize") {
      const q = (name) => u.searchParams.get(name) ?? ""
      const clientId = q("client_id")
      const redirectUri = q("redirect_uri") || q("redirect_url")
      const scope = q("scope")
      const state = q("state")
      if (!clientId || !redirectUri || !scope || !state) {
        throw new Error("OAuth 桥：授权参数不完整")
      }
      const api = new URL(`${accountBase}/api/v1/oauth/authorize`)
      api.searchParams.append("client_id", clientId)
      api.searchParams.append("redirect_uri", redirectUri)
      api.searchParams.append("scope", scope)
      api.searchParams.append("state", state)
      api.searchParams.append("response_type", q("response_type") || "code")
      cur = api.toString()
      continue
    }

    const res = await fetchImpl(cur, {
      headers: { ...ua, Cookie: cookieHeader() },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: "manual",
    })
    absorb(res)

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) throw new Error("OAuth 桥：重定向缺少目标地址")
      cur = new URL(loc, cur).toString()
      continue
    }
    if (!(res.status >= 200 && res.status < 300)) {
      if (res.status === 401 && u.hostname === accountHost) {
        throw new Error("OAuth 桥：百智云会话已失效，请重新登录")
      }
      throw new Error(`OAuth 桥：跳转失败（HTTP ${res.status}，${u.hostname}）`)
    }
    // 链走完（落在 2xx）：会话应该已经种进罐子里了。
    break
  }

  const sess = sessionCookie([...jar.entries()].map(([name, value]) => `${name}=${value}`))
  if (!sess) throw new Error("OAuth 桥：跳转链走完也没有拿到会话 cookie")
  return { ok: true, session: sess }
}
// ---- 密码重置（国际版/GitHub 注册账号的一次性设置）--------------------------

// requestPasswordReset 给邮箱发一封「设置密码」邮件。
//
// 国际版的账号多用 GitHub/Google OAuth 注册 —— 注册流程从不设置口令，
// 账密登录（POST /api/v1/users/password-login）对它永远失败。
// 官方 UI 的「Forgot password」就是这封邮件：用户点邮件里的链接
// 设一个口令，之后服务器上的账密登录 + 自主续期就能永久走通。
//
// 契约（2026-11 从线上前端抓的）：PUT /api/v1/users/passwords/reset-request
//   body { emails: [email], captcha_token }
//   成功 code=0；邮箱不存在 code=10615 一类的业务码也按成功处理（照发不误，
//   不向调用方暴露邮箱是否存在）。captcha 在本站自己的主机上取（同 passwordLogin）。
export async function requestPasswordReset(consoleBase, email, { fetchImpl = fetch } = {}) {
  const token = await captchaToken(consoleBase, { fetchImpl })
  const res = await fetchImpl(consoleBase + "/api/v1/users/passwords/reset-request", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": AGENT_UA,
    },
    body: JSON.stringify({ emails: [email], captcha_token: token }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const { text, payload } = await readJSON(res)
  if (!res.ok) {
    throw new Error(`发送重置邮件失败：HTTP ${res.status} ${vendorMessage(payload, text.slice(0, 120))}`)
  }
  return { ok: true, code: Number.isFinite(payload?.code) ? payload.code : 0 }
}
