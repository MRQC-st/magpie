#!/usr/bin/env python3
"""genspark-web-bridge: 把 Genspark 网页端 Super Agent 接口包装成 OpenAI Chat Completions。

为什么需要这一层：
- Genspark 的 /api/llm_proxy/v1（App/api_key 那条线）被套餐门禁挡住了，Free 计划的积分在那里
  不能花；积分实际只能通过网页端的 /api/agent/ask_proxy 花掉。
- ask_proxy 是 Cloudflare 前置的，普通 HTTP 客户端（curl / .NET / node fetch）拿不到 200，
  只有浏览器 TLS 指纹能过，因此这里用 curl_cffi 的 chrome 指纹。
- ask_proxy 返回的是项目级 SSE（project_start / message_field_delta / message_result），
  不是模型直连，需要翻译成 OpenAI 流。

对外：127.0.0.1:8420
  GET  /v1/models
  GET  /health
  POST /v1/chat/completions   (stream / non-stream 都支持)
"""
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from curl_cffi import requests as cffi

UPSTREAM = "https://www.genspark.ai/api/agent/ask_proxy"
COOKIE_FILE = os.path.expanduser("~/.config/magpie/genspark/web-cookie.txt")
FALLBACK_COOKIE = "/tmp/gsp_cookie.txt"
LISTEN = ("127.0.0.1", 8420)
UA_PROFILE = "chrome"
REQUEST_TIMEOUT = 300
MODEL_ID = "genspark-web"
MODEL_ALIASES = ["genspark-web", "genspark-web-agent", "gpt-4.1", "gpt-5.4-nano"]

BASE_HEADERS = {
    "accept": "text/event-stream",
    "accept-language": "zh-CN,zh;q=0.9",
    "origin": "https://www.genspark.ai",
    "referer": "https://www.genspark.ai/",
    "user-agent": None,  # curl_cffi 会按 impersonate 自动补
}


def read_cookie():
    for path in (COOKIE_FILE, FALLBACK_COOKIE):
        try:
            with open(path, encoding="utf-8") as fh:
                value = fh.read().strip()
            if value:
                return value
        except OSError:
            continue
    return ""


def content_to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in (None, "text") and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def build_prompt(messages):
    """把 OpenAI messages 压成单轮 prompt：ask_proxy 每次都是新项目，历史只能靠文本带过去。"""
    system = []
    turns = []
    last_user = ""
    for msg in messages:
        role = msg.get("role")
        text = content_to_text(msg.get("content")).strip()
        if not text:
            continue
        if role == "system":
            system.append(text)
        elif role == "assistant":
            turns.append(("assistant", text))
        else:
            turns.append(("user", text))
    # 最后一条用户消息作为本次问题，之前的内容作为上下文
    user_indexes = [i for i, (role, _) in enumerate(turns) if role == "user"]
    if not user_indexes:
        return "", ""
    last_idx = user_indexes[-1]
    last_user = turns[last_idx][1]
    history = turns[:last_idx]
    if history:
        lines = ["以下是此前的对话，仅作为上下文参考："]
        for role, text in history:
            lines.append(("用户：" if role == "user" else "助手：") + text)
        lines.append("")
        lines.append("现在请回答下面这一条消息：")
        context = "\n".join(lines)
        if system:
            context = "\n".join(system) + "\n\n" + context
        return context + "\n" + last_user, last_user
    if system:
        return "\n".join(system) + "\n\n" + last_user, last_user
    return last_user, last_user


def make_payload(prompt_text, user_input):
    """服务端读的是 messages[].content 与 user_s_input，两者都给拼好的全文，
    否则多轮历史只会出现在 user_s_input 里而进不了智能体的上下文。"""
    message_id = str(uuid.uuid4())
    message = {"role": "user", "id": message_id, "content": prompt_text, "pending": True,
               "sendStatus": "sending"}
    return {
        "models": ["gpt-4.1"],
        "run_with_another_model": False,
        "request_web_knowledge": False,
        "speed_mode": False,
        "use_webpage_capture_screen": False,
        "use_python_workspace": False,
        "dataframe_enhanced": False,
        "custom_tools": [],
        "unselected_custom_tools": [],
        "installed_custom_tools": [],
        "writingContent": None,
        "sas_ask_origin": "typed",
        "tier_source": "default",
        "type": "super_agent",
        "project_id": None,
        "messages": [message],
        "user_s_input": prompt_text,
        "client_message_id": message_id,
        "is_private": True,
        "push_token": "",
        "session_state": {"steps": [], "messages": [message]},
        "last_seen_event_index": -1,
        "chat_session_id": None,
    }


class StreamResult:
    def __init__(self):
        self.text = []
        self.usage = None
        self.served_model = None
        self.error = None


def upstream_stream(payload, cookie, on_delta=None, result=None):
    """跑一次 ask_proxy，边收边回调。返回 StreamResult。"""
    if result is None:
        result = StreamResult()
    headers = dict(BASE_HEADERS)
    headers["cookie"] = cookie
    headers["content-type"] = "application/json"
    headers.pop("user-agent", None)
    try:
        resp = cffi.post(UPSTREAM, headers=headers, json=payload, impersonate=UA_PROFILE,
                         timeout=REQUEST_TIMEOUT, stream=True)
    except Exception as exc:  # 网络层
        result.error = f"上游连接失败：{type(exc).__name__} {exc}"
        return result
    if resp.status_code != 200:
        snippet = resp.text[:400].replace("\n", " ")
        if resp.status_code in (401, 403):
            result.error = f"网页会话失效或被 Cloudflare 拦截（HTTP {resp.status_code}），需要重新同步浏览器 cookie"
        else:
            result.error = f"上游 HTTP {resp.status_code}：{snippet}"
        resp.close()
        return result
    for line in resp.iter_lines():
        if not line:
            continue
        raw = line.decode("utf-8") if isinstance(line, bytes) else line
        if not raw.startswith("data: "):
            continue
        try:
            event = json.loads(raw[6:])
        except ValueError:
            continue
        kind = event.get("type")
        if kind == "message_field_delta" and event.get("field_name") == "content":
            delta = event.get("delta") or ""
            if delta:
                result.text.append(delta)
                if on_delta:
                    on_delta(delta)
        elif kind == "message_result":
            state = (event.get("message") or {}).get("session_state") or {}
            result.usage = state.get("_llm_usage")
            result.served_model = state.get("_llm_model")
        elif kind == "error" or event.get("error"):
            result.error = str(event.get("error") or event.get("message") or event)[:300]
    resp.close()
    if not result.text and not result.error:
        result.error = "上游没有返回正文（SSE 已结束但无 content）"
    return result


def chunk(model, delta_text, finish=None, usage=None, role=None):
    delta = {}
    if role:
        delta["role"] = role
    if delta_text:
        delta["content"] = delta_text
    body = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage:
        body["usage"] = usage
    return "data: " + json.dumps(body, ensure_ascii=False) + "\n\n"


def normalize_usage(raw):
    if not isinstance(raw, dict):
        return None
    prompt = raw.get("prompt_tokens")
    completion = raw.get("completion_tokens")
    total = raw.get("total_tokens")
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion
    if prompt is None and total is None:
        return None
    return {"prompt_tokens": prompt or 0, "completion_tokens": completion or 0,
            "total_tokens": total or 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "genspark-web-bridge/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] " + fmt % args + "\n")

    def _json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/v1/models", "/models"):
            now = int(time.time())
            data = [{"id": alias, "object": "model", "created": now, "owned_by": "genspark-web"}
                    for alias in MODEL_ALIASES]
            self._json(200, {"object": "list", "data": data})
            return
        if path == "/health":
            cookie = read_cookie()
            info = {"ok": bool(cookie), "cookie_present": bool(cookie)}
            if cookie:
                try:
                    r = cffi.get("https://www.genspark.ai/api/payment/get_credit_balance",
                                 headers={"cookie": cookie, "accept": "application/json"},
                                 impersonate=UA_PROFILE, timeout=30)
                    info["balance_probe_status"] = r.status_code
                    info["balance"] = (r.json().get("data") or {}).get("balance") if r.status_code == 200 else None
                except Exception as exc:
                    info["balance_probe_status"] = f"error {type(exc).__name__}"
            self._json(200, info)
            return
        self._json(404, {"error": {"message": f"unknown path {path}", "type": "not_found"}})

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self._json(404, {"error": {"message": f"unknown path {path}", "type": "not_found"}})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._json(400, {"error": {"message": "invalid json", "type": "invalid_request_error"}})
            return
        cookie = read_cookie()
        if not cookie:
            self._json(503, {"error": {"message": "缺少 Genspark 网页 cookie，请先同步", "type": "auth_missing"}})
            return
        messages = body.get("messages") or []
        if not messages:
            self._json(400, {"error": {"message": "messages 为空", "type": "invalid_request_error"}})
            return
        prompt_text, user_input = build_prompt(messages)
        if not user_input:
            self._json(400, {"error": {"message": "没有可用的用户消息", "type": "invalid_request_error"}})
            return
        model = body.get("model") or MODEL_ID
        payload = make_payload(prompt_text, user_input)
        stream = bool(body.get("stream"))

        if not stream:
            result = upstream_stream(payload, cookie)
            if result.error:
                self._json(502, {"error": {"message": result.error, "type": "upstream_error"}})
                return
            usage = normalize_usage(result.usage)
            out = {
                "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(result.text)},
                             "finish_reason": "stop"}],
            }
            if usage:
                out["usage"] = usage
            self._json(200, out)
            return

        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def write(text):
            try:
                self.wfile.write(text.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        write(chunk(model, None, role="assistant"))
        result = StreamResult()
        state = {"closed": False}

        def on_delta(text):
            if state["closed"]:
                return
            write(chunk(model, text))

        upstream_stream(payload, cookie, on_delta=on_delta, result=result)
        if result.error and not result.text:
            write("data: " + json.dumps({"error": {"message": result.error, "type": "upstream_error"}},
                                        ensure_ascii=False) + "\n\n")
            write("data: [DONE]\n\n")
            state["closed"] = True
            return
        usage = normalize_usage(result.usage)
        write(chunk(model, None, finish="stop", usage=usage))
        write("data: [DONE]\n\n")
        state["closed"] = True


def main():
    server = ThreadingHTTPServer(LISTEN, Handler)
    print(f"genspark-web-bridge listening on {LISTEN[0]}:{LISTEN[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
