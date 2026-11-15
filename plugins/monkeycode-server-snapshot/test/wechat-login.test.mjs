// 微信扫码登录（国内版）的回归测试。
//
// 协议照上游 desktop/src/baizhi/wechat.rs 移植。三个易碎点都有测试钉着：
//   ① 二维码 uuid 从授权页 HTML 刮（页面改版就断 → 测试用线上结构快照）；
//   ② 长轮询应答是段 JS（wx_errcode / wx_code），不是 JSON；
//   ③ 回调不跟随重定向，`baizhi_session` 在首响应的 Set-Cookie 里。

import { test, expect } from "./harness.mjs"

import { startWechatLogin, pollWechatLogin, waitForWechatLogin, completeWechatCallback } from "../lib/wechat-login.mjs"

const ACCOUNT = "https://baizhi.cloud"
const AUTH_URL =
  "https://open.weixin.qq.com/connect/qrconnect?appid=wx48fa7c1c1259a963" +
  `&redirect_uri=${encodeURIComponent(`${ACCOUNT}/api/v1/oauth/wechat/callback`)}` +
  "&response_type=code&scope=snsapi_login&state=wx-state-1"
const UUID = "041YvQe44lY41002"

// 授权页 HTML 的关键结构（线上快照，2026-11）。
const AUTH_PAGE = `<html><body><img src="/connect/qrcode/${UUID}"></body></html>`

// fakeWX 按角色接住每个请求。
//   oauthLogin / authPage / qrcode / lp.<host>（长轮询）/ wechat callback
function fakeWX({ errcode = 408, code = "wx-code-9", callbackSetsCookie = true } = {}) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push(u.toString())

    if (u.pathname === "/api/v1/user/oauth/login") {
      return Response.json({ code: 0, data: { url: AUTH_URL } })
    }
    if (u.hostname === "open.weixin.qq.com" && u.pathname === "/connect/qrconnect") {
      return new Response(AUTH_PAGE, { status: 200 })
    }
    if (u.hostname === "lp.open.weixin.qq.com" && u.pathname === "/connect/l/qrconnect") {
      // 线上应答是一段 JS，不是 JSON。
      return new Response(
        `window.wx_errcode=${errcode};window.wx_code='${code}';`,
        { status: 200 },
      )
    }
    if (u.pathname === "/api/v1/oauth/wechat/callback") {
      expect(u.searchParams.get("code")).toBe(code)
      expect(u.searchParams.get("state")).toBe("wx-state-1")
      const headers = new Headers()
      if (callbackSetsCookie) {
        headers.append(
          "Set-Cookie",
          `baizhi_session=bz-sess-1; Path=/; HttpOnly; Expires=Wed, 09 Dec 2026 00:00:00 GMT`,
        )
      }
      return new Response("", { status: 302, headers })
    }
    return new Response(`unexpected ${u}`, { status: 404 })
  }
  return { fetchImpl, seen }
}

test("startWechatLogin fetches the auth page and carves the QR uuid", async () => {
  const { fetchImpl } = fakeWX()
  const st = await startWechatLogin(ACCOUNT, { fetchImpl })
  expect(st.uuid).toBe(UUID)
  expect(st.qrUrl).toBe(`https://open.weixin.qq.com/connect/qrcode/${UUID}`)
  expect(st.state).toBe("wx-state-1")
  expect(st.callback).toContain("/api/v1/oauth/wechat/callback")
})

test("startWechatLogin fails plainly when the page has no QR", async () => {
  const { fetchImpl } = fakeWX()
  const broken = async (url) => {
    const u = new URL(String(url))
    if (u.hostname === "open.weixin.qq.com") return new Response("<html>no qr</html>", { status: 200 })
    return fakeWX().fetchImpl(url)
  }
  await expect(() => startWechatLogin(ACCOUNT, { fetchImpl: broken })).toThrow("二维码")
})

test("pollWechatLogin maps wx_errcode to states and completes on 405", async () => {
  for (const [errcode, want] of [[408, "waiting"], [404, "scanned"], [403, "canceled"], [402, "expired"]]) {
    const { fetchImpl } = fakeWX({ errcode })
    const st = await startWechatLogin(ACCOUNT, { fetchImpl })
    expect(await pollWechatLogin(st, { fetchImpl })).toBe(want)
  }
  const { fetchImpl } = fakeWX({ errcode: 405, code: "wx-code-9" })
  const st = await startWechatLogin(ACCOUNT, { fetchImpl })
  const done = await pollWechatLogin(st, { fetchImpl })
  expect(done.session).toBe("bz-sess-1")
})

test("completeWechatCallback throws when no baizhi_session comes back", async () => {
  const { fetchImpl } = fakeWX({ callbackSetsCookie: false })
  await expect(() =>
    completeWechatCallback(`${ACCOUNT}/api/v1/oauth/wechat/callback`, "wx-state-1", "wx-code-9", { fetchImpl }),
  ).toThrow("没有落会话")
})

test("waitForWechatLogin drives the whole scan → session loop", async () => {
  // 两轮 408（waiting）→ 405（成功）。轮询间隔在模块里是 2s，这里只验状态机，
  // 时间成本 = 2 次轮询 × 2s ≈ 4s，可接受。
  let calls = 0
  const base = fakeWX()
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url))
    if (u.hostname === "lp.open.weixin.qq.com") {
      calls++
      const errcode = calls >= 3 ? 405 : 408
      return new Response(`window.wx_errcode=${errcode};window.wx_code='wx-code-9';`, { status: 200 })
    }
    return base.fetchImpl(url, init)
  }
  const statuses = []
  const session = await waitForWechatLogin(ACCOUNT, {
    fetchImpl,
    onStatus: (st) => statuses.push(st.status),
  })
  expect(session).toBe("bz-sess-1")
  expect(statuses).toContain("waiting")
  expect(calls).toBe(3)
})
