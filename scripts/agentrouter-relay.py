#!/usr/bin/env python3
"""agentrouter-relay: 本机反向代理，把 magpie 的请求转给 agentrouter.org。

- 出口经 mihomo（172.17.0.1:17900）：服务器直连会命中阿里云 WAF 验证页。
- 注入 agentrouter 要求的 Codex CLI 客户端指纹头（Originator / User-Agent / Version）。
- 逐块透传响应（含 SSE 流式），不改协议。
"""
import http.server
import ssl
import sys
import urllib.error
import urllib.request

UPSTREAM = "https://agentrouter.org"
PROXY = "http://172.17.0.1:17900"
LISTEN = ("127.0.0.1", 8399)
SPOOF = {
    "Originator": "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
    "Version": "0.101.0",
}
HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}
NOT_FORWARDED = {"content-length", "transfer-encoding", "connection"}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _relay(self):
        if self.path.split("?")[0] == "/healthz":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        present = {k.lower() for k in headers}
        for k, v in SPOOF.items():
            if k.lower() not in present:
                headers[k] = v
        req = urllib.request.Request(UPSTREAM + self.path, data=data,
                                     method=self.command, headers=headers)
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )
        try:
            resp = opener.open(req, timeout=180)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:  # noqa: BLE001
            self.send_error(502, "agentrouter-relay upstream error: %s (check egress proxy http://172.17.0.1:17900)" % e)
            return
        try:
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k.lower() in NOT_FORWARDED:
                    continue
                self.send_header(k, v)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass

    do_GET = _relay
    do_POST = _relay
    do_PUT = _relay
    do_PATCH = _relay
    do_DELETE = _relay

    def log_message(self, fmt, *args):
        sys.stderr.write("relay: " + fmt % args + "\n")


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print("agentrouter-relay on http://%s:%d -> %s via %s" % (LISTEN[0], LISTEN[1], UPSTREAM, PROXY))
    Server(LISTEN, Handler).serve_forever()
