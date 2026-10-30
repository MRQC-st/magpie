#!/usr/bin/env python3
"""百智云（baizhi.cloud）每日临时额度领取 —— MonkeyCode **A 通道**（ai-models.app.baizhi.cloud）的签到。

为什么需要它：
  MonkeyCode 有两条计费通道、两本账：
    A = ai-models.app.baizhi.cloud（百智云 SK）—— 余额走 **baizhi.cloud 钱包**
    B = proxy.monkeycode-ai.com（订阅网关）    —— 余额走 **monkeycode-ai.com 官方云钱包**
  magpie 社区插件的 `auth.checkin` 只做 B（monkeycode-ai.com 的 /api/v1/users/wallet/checkin），
  **A 的签到没人做** ⇒ A 通道长期报 `400 余额不足`。
  A 的签到端点是 baizhi.cloud 的「每日领积分 +100」：
    GET  /api/v1/user/wallet/balance                       → data.daily_temporary_credit_claimed
    POST /api/v1/user/wallet/daily-temporary-credit        body {"captcha_token": "..."}
    POST /api/v1/public/captcha/challenge  → {challenge:{c,s,d}, token}
    POST /api/v1/public/captcha/redeem     → {success, token}
  验证码 = 自研 Cap PoW（@cap.js 0.0.6 族，c=50 s=32 d=3，FNV-1a + xorshift32 派生 salt/target，
  SHA-256 爆破 nonce）；nonce 比对按**完整 hex 前缀**（奇数 d 也要比满 3 个字符）。

鉴权：HttpOnly cookie `baizhi_session`（~30 天；来源 = MonkeyCode 桌面端
  %APPDATA%\\com.chaitin.baizhi.monkeycode\\baizhi-cookies.json，或浏览器登录 baizhi.cloud 后抓取）。

用法：
    python scripts/baizhi-checkin.py --cookie-file "<path to baizhi-cookies.json>"
    python scripts/baizhi-checkin.py --cookie-file "<path>" --json
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://baizhi.cloud"
CAP_EP = BASE + "/api/v1/public/captcha/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")


# ---------- Cap PoW（与 relay-checkin/probe/baizhi_adapter.py 同源，逐字节对齐） ----------

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
    """服务端按完整 hex 前缀比对（d=3 也要比满 3 个字符）。"""
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


# ---------- HTTP ----------

def http(method, url, cookies=None, body=None, timeout=25):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
         "Referer": BASE + "/console/wallet"}
    if cookies:
        h["Cookie"] = "; ".join("%s=%s" % (k, v) for k, v in cookies.items())
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=h, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.getcode(), json.loads(raw), raw
            except Exception:
                return r.getcode(), None, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw), raw
        except Exception:
            return e.code, None, raw
    except Exception as e:
        return 0, None, str(e)[:160]


def captcha_token():
    code, ch, raw = http("POST", CAP_EP + "challenge", body={})
    ch = ch or {}
    token = ch.get("token")
    meta = ch.get("challenge") or {}
    c, slen, dlen = meta.get("c"), meta.get("s"), meta.get("d")
    if code not in (200, 201) or not token or not isinstance(c, int):
        raise RuntimeError("challenge 失败 http=%s %s" % (code, str(raw)[:120]))
    if c > 200:
        raise RuntimeError("挑战数过大 c=%s，放弃" % c)
    sols = []
    for i in range(1, c + 1):
        salt = cap_d(token + str(i), slen)
        tgt = cap_d(token + str(i) + "d", dlen)
        sols.append(solve_pow_one(salt, tgt))
    code2, rd, raw2 = http("POST", CAP_EP + "redeem",
                           body={"token": token, "solutions": sols})
    rd = rd or {}
    if code2 != 201 or not rd.get("success") or not rd.get("token"):
        raise RuntimeError("redeem 失败 http=%s %s" % (code2, str(raw2)[:150]))
    return rd["token"]


def read_session(cookie_file, env="BAIZHI_SESSION"):
    """从 cookie 文件（数组或 {accounts:[...]}）或环境变量取 baizhi_session。绝不打印其值。"""
    val = (os.environ.get(env) or "").strip()
    if val:
        return val
    if not cookie_file:
        raise RuntimeError("未提供 --cookie-file 且环境变量 %s 为空" % env)
    with open(cookie_file, encoding="utf-8") as f:
        data = json.load(f)
    items = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("accounts") or []
        if not items and "baizhi_session" in data:
            items = [data]
    for it in items:
        if it.get("name") == "baizhi_session" and it.get("value"):
            return it["value"]
        if it.get("baizhi_session"):
            return it["baizhi_session"]
    raise RuntimeError("cookie 文件里没有 baizhi_session")


def run(cookie_file, env="BAIZHI_SESSION"):
    sess = read_session(cookie_file, env)
    cookies = {"baizhi_session": sess}
    code, prof, raw = http("GET", BASE + "/api/v1/user/profile", cookies=cookies)
    if code != 200 or (prof or {}).get("code") != 0:
        return {"status": "noauth",
                "message": "会话失效 http=%s %s（浏览器重登 baizhi.cloud 后重新取 cookie）"
                           % (code, str(raw)[:80]), "reward": 0}
    name = ((prof or {}).get("data") or {}).get("name") or "baizhi"

    code, d, raw = http("GET", BASE + "/api/v1/user/wallet/balance", cookies=cookies)
    data = (d or {}).get("data") or {}
    avail = float(data.get("available_credit_cents") or 0) / 100.0
    if data.get("daily_temporary_credit_claimed"):
        return {"status": "already", "account": name,
                "message": "今日已领（可用 %g 积分）" % avail, "reward": 0, "balance": avail}

    try:
        tok = captcha_token()
    except Exception as e:
        return {"status": "failed", "account": name,
                "message": "Cap PoW 失败: %s" % str(e)[:120], "reward": 0, "balance": avail}

    code2, d2, raw2 = http("POST", BASE + "/api/v1/user/wallet/daily-temporary-credit",
                           cookies=cookies, body={"captcha_token": tok})
    d2 = d2 or {}
    if code2 == 200 and d2.get("code") == 0:
        dta = d2.get("data") or {}
        if dta.get("claimed"):
            reward = float(dta.get("amount_credit_cents") or 0) / 100.0
            code3, d3, _ = http("GET", BASE + "/api/v1/user/wallet/balance", cookies=cookies)
            bal = avail
            if code3 == 200 and (d3 or {}).get("code") == 0:
                bal = float(((d3 or {}).get("data") or {}).get("available_credit_cents") or 0) / 100.0
            else:
                bal = avail + reward
            return {"status": "success", "account": name,
                    "message": "签到成功 +%g 积分（可用 %g）" % (reward, bal),
                    "reward": reward, "balance": bal}
        return {"status": "already", "account": name,
                "message": "今日已领（可用 %g 积分）" % avail, "reward": 0, "balance": avail}
    if code2 in (401, 403):
        return {"status": "noauth", "account": name,
                "message": "签到鉴权失败 http=%s" % code2, "reward": 0, "balance": avail}
    return {"status": "failed", "account": name,
            "message": str((d2 or {}).get("message") or ("签到失败 http=%s %s" % (code2, str(raw2)[:80])))[:120],
            "reward": 0, "balance": avail}


def main():
    ap = argparse.ArgumentParser(description="百智云每日临时额度领取（MonkeyCode A 通道签到）")
    ap.add_argument("--cookie-file", default=os.path.join(
        os.environ.get("APPDATA", ""), "com.chaitin.baizhi.monkeycode", "baizhi-cookies.json"),
        help="baizhi-cookies.json 路径（默认取本机 MonkeyCode 桌面端的数据目录）")
    ap.add_argument("--env", default="BAIZHI_SESSION", help="改从该环境变量读 cookie")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    args = ap.parse_args()
    try:
        res = run(args.cookie_file, args.env)
    except Exception as e:
        res = {"status": "failed", "message": str(e)[:160], "reward": 0}
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print("[%s] %s" % (res.get("status"), res.get("message")))
    sys.exit(0 if res.get("status") in ("success", "already") else 1)


if __name__ == "__main__":
    main()
