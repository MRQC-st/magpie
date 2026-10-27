import { test, expect } from "./harness.mjs"
import { createServer } from "node:http"
import { authorizeUrl, signIn } from "../lib/auth-login.mjs"

test("login params ride the hash query, as the portal expects", () => {
  const u = new URL(authorizeUrl(
    "https://lobsterai.youdao.com/portal#/login",
    "http://127.0.0.1:5555/auth/callback",
    "st4te",
  ))
  expect(u.origin + u.pathname).toBe("https://lobsterai.youdao.com/portal")
  expect(u.hash.startsWith("#/login?")).toBe(true)
  const q = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1))
  expect(q.get("source")).toBe("electron")
  expect(q.get("state")).toBe("st4te")
  expect(q.get("redirect_uri")).toBe("http://127.0.0.1:5555/auth/callback")
})

test("return_to points back at the login page's success state", () => {
  const u = new URL(authorizeUrl(
    "https://lobsterai.youdao.com/portal#/login", "http://127.0.0.1:5555/auth/callback", "s",
  ))
  const q = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1))
  const back = q.get("redirect_uri")
  expect(back).toBe("http://127.0.0.1:5555/auth/callback")
  expect(q.get("source")).toBe("electron")
})

// 用 node:http 起假服务端，不用 Bun.serve —— 后者在 node 下不存在。
function serveFakeApi(token) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/api/auth/exchange") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ code: 0, message: "OK", data: { accessToken: token, refreshToken: "rt" } }))
        return
      }
      res.writeHead(404)
      res.end("nope")
    })
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port })
    })
  })
}

test("signIn completes the loopback callback and returns an oauth account", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const token = `h.${b64({ sub: 67097, yid: "u@x.com", exp: 1793152423 })}.s`

  const { server, port } = await serveFakeApi(token)

  // 把 exchange 指向假服务端。
  // 用注入的 fetchImpl，不改全局 fetch：全局 fetch 的 keep-alive 连接池
  // 在进程退出时会撞上 libuv 的 UV_HANDLE_CLOSING 断言。
  const orig = globalThis.fetch
  const fetchImpl = (input, init) => {
    const s = String(input)
    const url = s.includes("/api/auth/exchange")
      ? s.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`)
      : s
    const headers = new Headers(init?.headers)
    headers.set("connection", "close")
    return orig(url, { ...init, headers })
  }

  try {
    const out = await signIn({
      fetchImpl,
      open: async (url) => {
        // 假装用户在浏览器里登录：直接把 code 回调到 redirect_uri
        const q = new URLSearchParams(new URL(url).hash.split("?")[1])
        const cb = new URL(q.get("redirect_uri"))
        cb.searchParams.set("code", "fake-code")
        cb.searchParams.set("state", q.get("state"))
        await fetch(cb.toString())
      },
      timeoutMs: 5000,
    })
    expect(out.type).toBe("success")
    expect(out.access).toBe(token)
    expect(out.refresh).toBe("rt")
    expect(out.accountId).toBe("u@x.com")
  } finally {
    // 先掐连接再关：否则 keep-alive 的空闲 socket 会在进程退出时撞 libuv 断言
    try { server.closeAllConnections?.() } catch {}
    await new Promise((r) => server.close(r))
  }
})
