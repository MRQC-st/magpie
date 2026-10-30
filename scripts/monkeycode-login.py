#!/usr/bin/env python3
"""MonkeyCode 官方云（monkeycode-ai.com）**服务器端自主登录 / 会话续期**。

为什么需要它：
  magpie 上的社区插件 `opencode-monkeycode-auth` **没有 auth.refresh**，凭据是 `plugin login`
  那一刻拷进 plugin-auth.json 的快照；而 `monkeycode_ai_session` 只有 **7 天**有效期。
  桌面端能续期，但桌面端在这台 Windows 机器上 —— 目标却是「脱离本机电脑，服务器自己会续」。

  开源客户端（chaitin/MonkeyCode `desktop/src/baizhi/monkeycode.rs`）给出了两条登录路径：
    ① 账密登录：POST /api/v1/users/password-login  {email, password, captcha_token}
       —— captcha_token 来自同族的 Cap PoW（challenge → redeem），与签到用同一套端点。
    ② 账号桥接：baizhi.cloud 的会话 cookie → /api/v1/oauth/authorize → 回调 code → 建会话。
  源码里**没有** refresh/renew 端点 —— 续期 = 重新登录一次。

本脚本走 ①：拿一份长期有效的账号口令（存在服务器上，600 权限），随时可以换一个 7 天的会话 cookie。
因此服务器侧就能做到：
  每天 → 换新会话 cookie → 写回 cookie 文件 → `magpie plugin login monkeycode 1` → 插件拿到新 cookie
        → magpie 的插件签到（auth.checkin）就能领积分，全程不碰本机电脑。

用法：
    # 登录并把新 cookie 写进服务器上的 cookie 文件
    python scripts/monkeycode-login.py --email <邮箱> --password <口令> --out <cookie文件>

    # 只检查当前会话是否还有效
    python scripts/monkeycode-login.py --cookie-file <cookie文件> --check

    # 口令从环境变量读（推荐，避免出现在命令行历史里）
    MONKEYCODE_EMAIL=... MONKEYCODE_PASSWORD=... python scripts/monkeycode-login.py --out <file>

只输出状态与业务错误码，**绝不打印 cookie / 口令 / captcha_token 的值**。
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

SAAS = "https://monkeycode-ai.com"
CAP_EP = SAAS + "/api/v1/public/captcha/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")


# ---------- Cap PoW（与 baizhi-checkin.py 同源，@cap.js 0.0.6 族） ----------

def _i32(x):
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


def _fnv1a(seed):
    t = 2166136261
    for ch in seed:
        t = _i32(t) ^ ord(ch)
        t += (_i32(t) << 1) + (_i32(t) << 4) + (_i32(t) << 7) + (_i32(t) << 8) + (_i32(t) << 24)
    return t & 0xFFFFFFFF


def cap_d(seed, ln):
    i = _fnv1a(seed)
    out = ""
    while len(out) < ln:
        i = _i32(i ^ _i32(i << 13))
        i = i ^ ((i & 0xFFFFFFFF) >> 17)
        i = i ^ _i32(i << 5)
        i &= 0xFFFFFFFF
        out += format(i, "08x")
    return out[:ln]


def solve_pow_one(salt, target_hex):
    even = len(target_hex) // 2 * 2
    tgt = bytes.fromhex(target_hex[:even])
    nbytes = len(tgt)
    nib = int(target_hex[even], 16) if even < len(target_hex) else None
    prefix = salt.encode()
    n = 0
    while True:
        dig = hashlib.sha256(prefix + str(n).encode()).digest()
        if dig[:nbytes] == tgt and (nib is None or (dig[nbytes] >> 4) == nib):
            return n
        n += 1


# ---------- HTTP（urllib 失败时回退 curl：Python OpenSSL 与本站握手不兼容的坑 46 家族） ----------

def _curl(method, url, headers=None, body=None, cookie_jar=None, timeout=30):
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        return 0, None, "no curl binary"
    cmd = [curl, "-s", "-i", "--noproxy", "*", "--max-time", str(timeout), "-X", method]
    for k, v in (headers or {}).items():
        cmd += ["-H", "%s: %s" % (k, v)]
    if cookie_jar:
        cmd += ["-b", cookie_jar]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "--data", body]
    cmd.append(url)
    p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout or ""
    head, _, payload = out.partition("\r\n\r\n")
    if not payload:
        head, _, payload = out.partition("\n\n")
    status = 0
    cookies = []
    for line in head.splitlines():
        low = line.lower()
        if low.startswith("http/"):
            try:
                status = int(line.split()[1])
            except Exception:
                status = 0
        elif low.startswith("set-cookie:"):
            cookies.append(line.split(":", 1)[1].strip())
    try:
        data = json.loads(payload) if payload.strip() else None
    except Exception:
        data = None
    return status, data, payload, cookies


def http(method, url, headers=None, body=None, cookie_jar=None, timeout=30):
    """返回 (status, json_or_None, raw_text, set_cookie_list)。"""
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
         "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    if body is not None:
        h["Content-Type"] = "application/json"
    payload = json.dumps(body) if body is not None else None
    try:
        req = urllib.request.Request(url, data=payload.encode() if payload else None,
                                     headers=h, method=method)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
        if cookie_jar:
            opener.addheaders = []
        with opener.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.getcode(), json.loads(raw), raw, list(r.headers.get_all("Set-Cookie") or [])
            except Exception:
                return r.getcode(), None, raw, list(r.headers.get_all("Set-Cookie") or [])
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw), raw, list(e.headers.get_all("Set-Cookie") or [])
        except Exception:
            return e.code, None, raw, list(e.headers.get_all("Set-Cookie") or [])
    except Exception:
        return _curl(method, url, h, payload, cookie_jar, timeout)


def captcha_token():
    """challenge → 求解 → redeem → captcha_token（与签到同一套端点）。"""
    code, ch, raw, _ = http("POST", CAP_EP + "challenge", body={})
    ch = ch or {}
    token = ch.get("token")
    meta = ch.get("challenge") or {}
    c, slen, dlen = meta.get("c"), meta.get("s"), meta.get("d")
    if code not in (200, 201) or not token or not isinstance(c, int):
        raise RuntimeError("challenge 失败 http=%s %s" % (code, str(raw)[:120]))
    if c > 200:
        raise RuntimeError("挑战数过大 c=%s" % c)
    sols = []
    for i in range(1, c + 1):
        salt = cap_d(token + str(i), slen)
        tgt = cap_d(token + str(i) + "d", dlen)
        sols.append(solve_pow_one(salt, tgt))
    code2, rd, raw2, _ = http("POST", CAP_EP + "redeem",
                              body={"token": token, "solutions": sols})
    rd = rd or {}
    if code2 != 201 or not rd.get("success") or not rd.get("token"):
        raise RuntimeError("redeem 失败 http=%s %s" % (code2, str(raw2)[:150]))
    return rd["token"]


def session_cookie_value(set_cookies):
    for c in set_cookies:
        first = c.split(";")[0]
        if first.startswith("monkeycode_ai_session="):
            return first.split("=", 1)[1]
    return ""


def read_cookie_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("accounts") or []
    return []


def check_session(cookie_value):
    """GET /api/v1/users/status → 会话是否还有效。"""
    code, data, raw, _ = http("GET", SAAS + "/api/v1/users/status",
                              headers={"Cookie": "monkeycode_ai_session=" + cookie_value})
    if code == 200 and isinstance(data, dict) and data.get("code") == 0:
        return True, data.get("data")
    return False, None


def password_login(email, password):
    """账密登录 → 返回新的 monkeycode_ai_session 值。"""
    tok = captcha_token()
    code, data, raw, set_cookies = http(
        "POST", SAAS + "/api/v1/users/password-login",
        body={"email": email, "password": password, "captcha_token": tok})
    sess = session_cookie_value(set_cookies)
    if sess:
        return sess, None
    msg = None
    if isinstance(data, dict):
        msg = data.get("message") or data.get("msg")
    return "", {"http": code, "code": (data or {}).get("code") if isinstance(data, dict) else None,
                "message": str(msg)[:120] if msg else str(raw)[:120]}


def write_cookie(path, sess):
    items = read_cookie_file(path)
    out = []
    replaced = False
    for it in items:
        if it.get("name") == "monkeycode_ai_session":
            it = dict(it)
            it["value"] = sess
            it["expires"] = "2099-01-01T00:00:00Z"
            replaced = True
        out.append(it)
    if not replaced:
        out.append({"name": "monkeycode_ai_session", "value": sess,
                    "domain": "monkeycode-ai.com", "expires": "2099-01-01T00:00:00Z"})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(description="MonkeyCode 官方云服务器端登录 / 会话续期")
    ap.add_argument("--email", default=os.environ.get("MONKEYCODE_EMAIL", ""))
    ap.add_argument("--password", default=os.environ.get("MONKEYCODE_PASSWORD", ""))
    ap.add_argument("--out", default="", help="要写入的 cookie 文件（monkeycode-cookies.json）")
    ap.add_argument("--cookie-file", default="", help="检查用的 cookie 文件")
    ap.add_argument("--check", action="store_true", help="只检查现有会话")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    res = {}
    try:
        if args.check:
            path = args.cookie_file or args.out
            items = read_cookie_file(path)
            sess = ""
            for it in items:
                if it.get("name") == "monkeycode_ai_session":
                    sess = it.get("value") or ""
            if not sess:
                res = {"status": "noauth", "message": "cookie 文件里没有 monkeycode_ai_session"}
            else:
                ok, data = check_session(sess)
                res = {"status": "ok" if ok else "expired",
                       "message": "会话有效" if ok else "会话已失效（需重新登录）"}
        else:
            if not (args.email and args.password):
                res = {"status": "failed",
                       "message": "缺邮箱或口令（用 --email/--password 或 MONKEYCODE_EMAIL/MONKEYCODE_PASSWORD）"}
            else:
                sess, err = password_login(args.email, args.password)
                if sess:
                    ok, _ = check_session(sess)
                    if args.out:
                        write_cookie(args.out, sess)
                    res = {"status": "success" if ok else "logged-in-unverified",
                           "message": "登录成功，会话有效" if ok else "登录成功但 /users/status 未确认有效",
                           "written": bool(args.out)}
                else:
                    res = {"status": "failed", "message": "登录失败",
                           "detail": err or {}}
    except Exception as e:
        res = {"status": "failed", "message": str(e)[:200]}

    if args.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print("[%s] %s" % (res.get("status"), res.get("message")))
        if res.get("detail"):
            print("      detail:", json.dumps(res["detail"], ensure_ascii=False))
    sys.exit(0 if res.get("status") in ("success", "ok", "already", "logged-in-unverified") else 1)


if __name__ == "__main__":
    main()
