// OAuth 桥（百智云账号 → MonkeyCode 会话）的回归测试。
//
// 这条链路是「服务器脱离本机电脑」的**兜底**：控制台会话只有 7 天，
// 会话过期后只有两条路能救 —— 账密登录，或者走这个桥。
//
// ⚠️ 之前踩的坑（照抄上游 upstream desktop/src/baizhi/monkeycode.rs 修的）：
//   把授权页的 query **整段照抄**到 API 端点 → 服务端不认。
//   正确做法：按名字取参数，再逐个 append（URLSearchParams 会重新编码）。
//   另一条关键：**自己维护 cookie 罐** —— 只带 `baizhi_session` 一个 cookie
//   走到底不行，链上种下的 `sl-session` 之类也得跟着走。

import { test, expect } from "./harness.mjs"

import { bridgeLogin } from "../lib/console.mjs"

const CONSOLE = "https://monkeycode-ai.com"
const ACCOUNT = "https://baizhi.cloud"

// 授权页 URL（上游 `{mc}/api/v1/users/login` 302 过去的那一跳）。
const PAGE_URL =
  `${ACCOUNT}/oauth/authorize?client_id=monkeycode-ai` +
  `&redirect_uri=${encodeURIComponent(`${CONSOLE}/api/v1/users/baizhi/callback`)}` +
  `&response_type=code&scope=user+phone&state=state-abc`

// fakeConsole 演一遍上游那条重定向链，并记录收到的 URL。
function fakeConsole({ failAuthorize = false, hops = 4 } = {}) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({
      url: u.toString(),
      params: Object.fromEntries(u.searchParams),
      cookie: init?.headers?.Cookie ?? "",
    })

    if (u.hostname === "monkeycode-ai.com" && u.pathname === "/api/v1/users/login") {
      return new Response("", {
        status: 302,
        headers: { Location: PAGE_URL },
      })
    }
    if (u.hostname === "baizhi.cloud" && u.pathname === "/api/v1/oauth/authorize") {
      if (failAuthorize) {
        return new Response(JSON.stringify({ code: 400, message: "参数错误" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("", {
        status: 302,
        headers: {
          Location: `${CONSOLE}/api/v1/users/baizhi/callback?code=tmp-xyz&state=state-abc`,
        },
      })
    }
    if (u.hostname === "monkeycode-ai.com" && u.pathname.includes("/callback")) {
      return new Response("", {
        status: 302,
        headers: {
          Location: CONSOLE,
          "Set-Cookie": "monkeycode_ai_session=sess-from-bridge; Path=/; HttpOnly",
        },
      })
    }
    // 前端页：链走完（2xx）
    return new Response("<html></html>", { status: hops > 4 ? 500 : 200 })
  }
  return { fetchImpl, seen }
}

test("the bridge walks the redirect chain and returns a session", async () => {
  const { fetchImpl, seen } = fakeConsole()
  const out = await bridgeLogin(CONSOLE, ACCOUNT, "baizhi-value", { fetchImpl })
  expect(out.ok).toBe(true)
  expect(out.session).toBe("sess-from-bridge")
  // 链上每一跳都走到了
  expect(seen.length).toBeGreaterThanOrEqual(3)
  expect(seen[0].url).toContain("/api/v1/users/login")
})

test("the authorize call carries the params by name, not the raw query", async () => {
  const { fetchImpl, seen } = fakeConsole()
  await bridgeLogin(CONSOLE, ACCOUNT, "baizhi-value", { fetchImpl })
  const api = seen.find((s) => s.url.includes("/api/v1/oauth/authorize"))
  expect(api).toBeTruthy()
  // scope 是按名字取的 ⇒ 空格被正确解码（上游 query_pairs 也是这么解的）
  expect(api.params.scope).toBe("user phone")
  expect(api.params.client_id).toBe("monkeycode-ai")
  expect(api.params.state).toBe("state-abc")
  expect(api.params.response_type).toBe("code")
  expect(api.params.redirect_uri).toBe(`${CONSOLE}/api/v1/users/baizhi/callback`)
  // 参数**一个不多一个不少**（整段照抄原 query 会带上别的）
  expect(Object.keys(api.params).sort()).toEqual([
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
  ])
})

test("the bridge sends the baizhi cookie on the authorize hop", async () => {
  const { fetchImpl, seen } = fakeConsole()
  const out = await bridgeLogin(CONSOLE, ACCOUNT, "baizhi-value", { fetchImpl })
  expect(out.ok).toBe(true)
  // 授权那一跳必须带上百智云的会话 cookie
  const api = seen.find((s) => s.url.includes("/api/v1/oauth/authorize"))
  expect(api.cookie).toContain("baizhi_session=baizhi-value")
})

test("a rejected authorize hop says the baizhi session is gone", async () => {
  const { fetchImpl } = fakeConsole({ failAuthorize: true })
  let err = null
  try {
    await bridgeLogin(CONSOLE, ACCOUNT, "bad-value", { fetchImpl })
  } catch (e) {
    err = e
  }
  expect(err).toBeTruthy()
  expect(err.message).toContain("HTTP 400")
})
