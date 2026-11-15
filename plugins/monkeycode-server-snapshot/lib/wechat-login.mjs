// 微信扫码登录（国内版）：服务器出二维码，用户手机扫一下，全程不要口令。
//
// 协议来自上游桌面客户端 desktop/src/baizhi/wechat.rs（网页版微信登录同款
// qrconnect 协议，多年稳定）：
//
//   1. baizhi GET /api/v1/user/oauth/login?platform=wechat&redirect_url=…
//      → { url }（open.weixin.qq.com/connect/qrconnect?… 授权页）
//   2. GET 授权页，从 HTML 里刮二维码 uuid（/connect/qrcode/<uuid>）
//      → 二维码图片 https://open.weixin.qq.com/connect/qrcode/<uuid>
//   3. 长轮询 https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=…
//      （主机 = 授权页域名加 `lp.` 前缀，微信开放平台多年不变的约定）
//      应答是一段 JS：window.wx_errcode=…;window.wx_code='…'
//        408 待扫码 / 404 已扫码待确认 / 403 已取消 / 402|500 过期 / 405 确认成功
//   4. 405 时拿 wx_code 调百智云回调 GET {redirect_uri}?code=…&state=…
//      → Set-Cookie 落 `baizhi_session`（30 天）
//
// 拿到百智云会话后走已有的 bridgeLogin()（OAuth 桥：百智云 → MonkeyCode
// 会话），再铸 oma_ key。这样「扫码登录」和「口令登录」产出的账号完全同构，
// 后续推理、查额度、签到、续期全部复用。
//
// 与上游的两处差别（都有意为之）：
//   - 轮询间隔固定 2s、超时 3 分钟：桌面端 UI 收到结果立即再调，插件侧
//     在 magpie 的 authorize 回调里跑，轮询太快没有意义，太慢扫码体验差。
//   - 二维码不回传图片字节（magpie 的 prompt 只能收文本），把授权页 URL
//     与二维码 URL 交给登录说明，用户在自己手机/浏览器打开即可。

import { ACCOUNT_COOKIE } from "./constants.mjs"
import https from "node:https"

const WX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
const TIMEOUT = 30_000
const POLL_INTERVAL_MS = 2_000
const POLL_DEADLINE_MS = 3 * 60_000

// ⚠️ 服务器侧实测坑（2026-11-15）：微信长轮询域名是 `lp.<授权页域>` —— 百智云用
//   `lp.baizhi.cloud`，但该域**不在** CLB 证书的 SAN 里（SAN 只有 baizhi.cloud /
//   www.baizhi.cloud）⇒ Node 内置 fetch（undici）证书 hostname 校验直接
//   ERR_TLS_CERT_ALTNAME_INVALID，扫码后状态轮询全部失败（"The operation was
//   aborted" 刷屏）。curl -k / 浏览器都放行（浏览器根本不把这个域当证书错误）。
//   修复：对 `lp.` 子域走 https.request + rejectUnauthorized:false 的兜底 fetch。
//   仅豁免 lp. 子域，其余域名仍走全局 fetch 正常校验。
const lpRelaxedFetch = (url, init = {}) => {
  const u = new URL(url)
  if (!u.hostname.startsWith("lp.")) return fetch(url, init)
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...init, rejectUnauthorized: false, headers: init.headers ?? {} }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () =>
        resolve(new Response(Buffer.concat(chunks).toString("utf8"), {
          status: res.statusCode,
          headers: res.headers,
        })),
      )
    })
    req.on("error", reject)
    req.setTimeout(TIMEOUT, () => req.destroy(new Error("lp 轮询超时")))
    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy(new DOMException("aborted", "AbortError")), { once: true })
    }
    req.end()
  })
}

// startWechatLogin 走第 1~2 步，返回扫码会话。
// 失败抛 Error（message 直接给人看）。
export async function startWechatLogin(accountBase, { fetchImpl = fetch } = {}) {
  const api = `${accountBase}/api/v1/user/oauth/login?platform=wechat&redirect_url=${encodeURIComponent(accountBase + "/")}`
  const res = await fetchImpl(api, {
    headers: { "User-Agent": WX_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`获取微信授权地址失败（HTTP ${res.status}）`)
  const payload = await res.json().catch(() => null)
  const authUrl = payload?.data?.url
  if (!authUrl) throw new Error("微信授权地址响应异常")

  const u = new URL(authUrl)
  const q = (name) => u.searchParams.get(name) ?? ""
  const state = q("state")
  const callback = q("redirect_uri")
  if (!state || !callback) throw new Error(`微信授权地址缺少 state/redirect_uri`)

  const page = await (
    await fetchImpl(authUrl, {
      headers: { "User-Agent": WX_UA },
      signal: AbortSignal.timeout(TIMEOUT),
    })
  ).text()
  const uuid = page.match(/\/connect\/qrcode\/([A-Za-z0-9_-]+)/)?.[1]
  if (!uuid) throw new Error("微信授权页里没找到二维码（页面结构可能已变化）")

  return { authUrl, qrUrl: new URL(`/connect/qrcode/${uuid}`, u).toString(), uuid, state, callback }
}

// pollWechatLogin 长轮询一次扫码状态（微信侧最长挂 ~25s）。
// 返回 "waiting" | "scanned" | "canceled" | "expired" | login。
// login = { session }：百智云回调已完成、`baizhi_session` 已落袋。
export async function pollWechatLogin(loginState, { fetchImpl = fetch } = {}) {
  const { uuid, state, callback } = loginState
  const authUrl = loginState.authUrl
  const host = new URL(authUrl).host
  const lpUrl = `https://lp.${host}/connect/l/qrconnect?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`

  const res = await lpRelaxedFetch(lpUrl, {
    headers: { "User-Agent": WX_UA, Referer: authUrl },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  const errcode = Number(text.match(/wx_errcode=(\d+)/)?.[1])
  switch (errcode) {
    case 408:
      return "waiting"
    case 404:
      return "scanned"
    case 403:
      return "canceled"
    case 402:
    case 500:
      return "expired"
    case 405: {
      const code = text.match(/wx_code='([^']*)'/)?.[1] ?? ""
      if (!code) throw new Error("扫码确认成功但未返回授权码")
      const session = await completeWechatCallback(callback, state, code, { fetchImpl })
      return { session }
    }
    default:
      throw new Error(`扫码状态响应异常（wx_errcode=${text.slice(0, 80)}）`)
  }
}

// waitForWechatLogin 轮询到出结果为止（或超时/取消）。
// 这是 authorize 回调用的入口：start → waitFor，两行完事。
export async function waitForWechatLogin(accountBase, { fetchImpl = fetch, onStatus } = {}) {
  const loginState = await startWechatLogin(accountBase, { fetchImpl })
  onStatus?.({ ...loginState, status: "waiting" })
  const deadline = Date.now() + POLL_DEADLINE_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const r = await pollWechatLogin(loginState, { fetchImpl })
    if (r === "waiting") continue
    if (r === "scanned") {
      onStatus?.({ ...loginState, status: "scanned" })
      continue
    }
    if (r === "canceled") throw new Error("你取消了扫码登录")
    if (r === "expired") throw new Error("二维码已过期，请重试扫码登录")
    return r.session
  }
  throw new Error("扫码登录超时（3 分钟），请重试")
}

// completeWechatCallback 用 wx_code 走百智云回调换会话。
// 回调 302 到 redirect_url；Set-Cookie 在首响应即出现，不跟随重定向。
export async function completeWechatCallback(callbackUrl, state, code, { fetchImpl = fetch } = {}) {
  const u = new URL(callbackUrl)
  u.searchParams.set("code", code)
  u.searchParams.set("state", state)
  const res = await fetchImpl(u.toString(), {
    headers: { "User-Agent": WX_UA },
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: "manual",
  })
  const cookies = res.headers.getSetCookie?.() ?? []
  for (const c of cookies) {
    const [kv] = c.split(";")
    const at = kv.indexOf("=")
    if (at > 0 && kv.slice(0, at).trim() === ACCOUNT_COOKIE) {
      return kv.slice(at + 1).trim()
    }
  }
  throw new Error(`微信登录回调没有落会话（HTTP ${res.status}）`)
}
