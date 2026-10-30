# 16 · MonkeyCode 双通道与签到

> **本文是什么**：MonkeyCode 的**两条计费通道**分别是什么、**各自怎么签到**（两个不同的钱包、两套端点）、
> A 通道如何挂进 magpie、会话有效期，以及实测矩阵。
> **本文不负责**：插件实现与自主续期（→ `17`）、magpie 宿主机制（→ `18`）、网关部署（→ `00`/`01`）、
> 第三方插件安装（→ `14`）、u1s12api（→ `15`）。

## 索引

| 节 | 内容 |
|---|---|
| 一 | 两个通道是什么 |
| 二 | A 通道（百智云）挂进 magpie |
| 三 | 两条通道各自的签到 |
| 四 | 会话有效期 |
| 五 | 实测矩阵 |
| 六 | 历史方案（已被取代，勿照着做） |

## 一、两个通道是什么

MonkeyCode（长亭 chaitin · ohmyagent）在逆向项目里有**两个互不相同的计费通道**
（协议与计费层的 SSOT 在兄弟项目 `model-reverse` 的 `docs/topics/monkeycode.md`；
本文只写 magpie 侧的接入方式）：

| 通道 | 端点 | 凭据 | 目录 | 计费账户 |
|---|---|---|---|---|
| **A** | `ai-models.app.baizhi.cloud`（百智云）<br>`/api/anthropic/v1/messages`、`/api/openai/v1/responses` | SK 密钥（`sk-…`） | 46 个模型 | **baizhi.cloud 钱包**（另一本账） |
| **B** | `proxy.monkeycode-ai.com/v1`（订阅网关） | `oma_…` key + `omas_…` 签名密钥（HMAC-SHA256 签 system 首块） | 25 个带档位的模型（`monkeycode-basic/…`、`-pro/…`、`-ultra/…`），basic 账号实际可见 14 个（→ `17` §五） | **monkeycode-ai.com 官方云钱包**（订阅账户的每日免费 Token + 积分） |

本机 `%APPDATA%\com.chaitin.baizhi.monkeycode\ohmyagent\settings.json` 里 **69 个模型条目**
就是这两条通道的并集：**44 条 A**（`@baizhi`）+ **17 条带档位前缀的 B**（`monkeycode-basic/…` 等）
+ **8 条无档位别名**（`deepseek-flash@monkeycode#uid` 这种）⇒ **B 通道合计 25 条**。
> ⚠️ 计数口径：早期文档里的「17 个 `monkeycode-*` 条目」= **以 `monkeycode-` 前缀计**，恰为 17；
> 「25 个」= B 通道**全部**条目。**两个数都对，别当矛盾**；订正记录见 `99` 的 `DEC-MAG-004` 条目。

## 二、A 通道（百智云）挂进 magpie

magpie 支持「自定义厂商」直接吃 Anthropic / Responses 协议的端点，于是把 A 挂成独立 provider：

```sh
# SK 从服务器上已有的 settings.json 里取（那份是导入凭据时带过去的）
magpie provider add baizhi \
  url=https://ai-models.app.baizhi.cloud/api/anthropic \
  anthropic=https://ai-models.app.baizhi.cloud/api/anthropic \
  responses=https://ai-models.app.baizhi.cloud/api/openai/v1 \
  key="$SK" \
  models.url=https://ai-models.app.baizhi.cloud/api/anthropic/v1/models
magpie provider models baizhi +<每个 id>     # 目录 46 个，默认只露 24 个 → 逐个补到 46
```

- `anthropic=` / `responses=` 的值是**基址**，不是布尔（写成 `anthropic=1` 会被当成 URL `https://1`）。
- 目录是活的：`GET /api/anthropic/v1/models` → 46 个模型（`minimax-m2.7`、`glm-5.1`、`kimi-k3`、`qwen3.6-plus` …）。
- `magpie provider test baizhi` → `✓ anthropic` / `✓ responses`（`✗ chat` 属正常：baizhi 只有 anthropic/responses 两种协议）。

## 三、两条通道**各自**的签到（关键：不是同一个站）

**两条通道的余额来自两个不同站点的钱包，签到端点也各走各的。**
插件（`auth.checkin`）只做了 B，A 由 `scripts/baizhi-checkin.py` 独立做 —— A 此前一直缺位，
那才是 A 长期 `400 余额不足` 的真正原因。

| | A 通道（百智云） | B 通道（MonkeyCode 官方云） |
|---|---|---|
| 钱包站 | `baizhi.cloud` | `monkeycode-ai.com` |
| 会话 cookie | `baizhi_session`（HttpOnly，**30 天**） | `monkeycode_ai_session`（**7 天**） |
| 状态查询 | `GET /api/v1/user/wallet/balance` → `data.daily_temporary_credit_claimed` | `GET /api/v1/users/wallet` → `balance` / `daily_token_balance` |
| 签到 | `POST /api/v1/user/wallet/daily-temporary-credit` body `{"captcha_token":"…"}` → **+100 积分/天** | `POST /api/v1/users/wallet/checkin` → **+100 积分/天**（幂等） |
| 验证码 | 自研 **Cap PoW**（见下） | 自研 **Cap PoW**（插件自带实现） |
| 本机 cookie 文件 | `%APPDATA%\com.chaitin.baizhi.monkeycode\baizhi-cookies.json` | `…\monkeycode-cookies.json` |
| magpie 里谁做 | **本仓库 `scripts/baizhi-checkin.py`**（A 侧此前缺位） | 插件 `auth.checkin`（已实现，PoW 也在插件里） |

### 3.1 Cap PoW（@cap.js 0.0.6 族，两站同源）

```
POST /api/v1/public/captcha/challenge  → { challenge:{c,s,d}, token }    # 实测 c=50 s=32 d=3
salt   = cap_d(token + i, s)              # cap_d = FNV-1a + xorshift32 派生 hex
target = cap_d(token + i + "d", d)
求解：SHA-256(salt + nonce) 的 hex 前缀命中 target
redeem: POST /api/v1/public/captcha/redeem { token, solutions:[nonce…] } → { success, token }
```

⚠️ 坑：服务端按**完整 hex 前缀**比对 —— `d=3` 是奇数，也要比满 3 个字符
（只比 `floor(d/2)` 字节会被判 `invalid solutions`）。
Python 纯实现 ~0.2s/站；实现见 `scripts/baizhi-checkin.py`（与 `relay-checkin/probe/baizhi_adapter.py` 同源）。

### 3.2 A 通道签到的实测（2026-10-30 13:31）

```
GET  baizhi.cloud/api/v1/user/wallet/balance
  → daily_temporary_credit_claimed = false,  available_credit_cents = 0
POST .../daily-temporary-credit  （Cap PoW 通过）
  → 签到成功 +100 积分（可用 100）
POST ai-models.app.baizhi.cloud/api/anthropic/v1/messages   ← 同一个 SK
  → 之前：400 余额不足        之后：200，正文 PONG
```

⇒ **不需要充值**：A 的推理余额来自「每日临时额度」，每天领一次 +100 就有；
不领就是 0 → 上游回 `400 余额不足`。
（这也解释了逆向项目 2026-09-24 的「A 打光 → 后来自愈」：那是每日额度重置/领取的结果，不是充值。）

### 3.3 B 通道签到的实测（2026-10-30 13:40）

刷新 cookie 后服务器侧直查控制台：

```
GET /api/v1/users/wallet/checkin → 200 {"checked_in": false}
GET /api/v1/users/wallet         → 200 {"balance": 277434, "daily_token_balance": 9992562, "daily_token_limit": 10000000}
```

`magpie quota monkeycode` 也从「未保存控制台 Cookie」变成
`每日 Token 额度 0% (7.4K / 10M tokens)  278 积分 left`。
之后由 magpie 自己的插件签到（`pluginCheckins.monkeycode=true`，每 30 分钟一次 tick）POST 领取。

## 四、会话有效期

| cookie | 有效期 | 谁续期 | 实测 |
|---|---|---|---|
| `monkeycode_ai_session`（B 控制台） | **7 天** | **服务器端插件 `auth.refresh`**（→ `17` §三）；客户端启动也会续 | 2026-10-30 客户端启动：过期到 2026-10-14 的 cookie → 2026-11-06 |
| `baizhi_session`（A 钱包） | **30 天** | 客户端启动**不**延长（要真登录/换 session 才变） | 2026-10-08 写过文件，expires 仍是 2026-11-06 |

两个坑（都已由插件侧机制消解，机理见 `18` §四 / §六）：

1. **凭据是快照**：插件不回读服务器上的文件，文件更新了 ≠ 插件生效；
   没有 `auth.refresh` 时 7 天后必然静默失效。
2. **过期即静默丢弃**：插件按 `expires` 判活，过期就丢 ⇒ 表现为「未保存控制台 Cookie」。

## 五、实测矩阵（2026-10-30）

| 通道 / 模型 | 结果 |
|---|---|
| A `GET /api/anthropic/v1/models` | ✅ 200，46 个模型 |
| A `POST /api/anthropic/v1/messages` | ✅ **200，正文 PONG**（领完每日额度后；领之前是 400 余额不足） |
| A 经网关 `baizhi/minimax-m2.7` | ✅ 200，正文 `MiniMax-M2.7`（`magpie provider test baizhi` → ✓ anthropic / ✓ responses） |
| B `monkeycode-basic/deepseek-flash` | ✅ 200，正文 `PONG`（直连签名请求与经网关两条路径都验过） |
| B `monkeycode/basic/{qwen3.8-flash, deepseek-flash, glm-5.3-flash, minimax-m2.5}` | ✅ 200，正文 `PONG` |
| B `monkeycode-pro/qwen3.6-plus`、`monkeycode-ultra/qwen3.7-max` | ❌ 403 Forbidden（用的是带档位的全名 ⇒ 不是「模型名要带档位」那个坑，是**本账号在 B 侧只有 basic 档权限**） |
| B 无档别名 `monkeycode/qwen3.6-plus` | ❌ 502（上游回 Cloudflare HTML 页） |
| B 积分查询 `magpie quota monkeycode` | ✅ `每日 Token 额度 0% (7.4K / 10M) 278 积分 left` |
| B 控制台会话 | ✅ `monkeycode_ai_session` 刷新后 → 2026-11-06 |
| A 钱包会话 | ✅ `baizhi_session` 有效 → 2026-11-06 |
| A 每日签到 | ✅ `+100 积分`（`scripts/baizhi-checkin.py`） |

2026-10-30 下午 fork 插件上线后的复验（`monkeycode` 14 models 已登录、
`monkeycode-intl` 25 models 未登录、积分 378 left、百智云 100 积分已领）
见 `17` 与 `99` 的对应条目。

## 六、历史方案（已被取代，勿照着做）

| 旧做法 | 为什么退役 | 现在的做法 |
|---|---|---|
| 本机 Windows 计划任务 `magpie-sync-monkeycode`（每日 08:05）→ 启动客户端续期 → 同步 cookie 文件 → 服务器重跑 `magpie plugin login monkeycode 1` | 依赖本机电脑开机；且计划任务在隐藏窗口里跑时 stdin 无人输入，远端 `plugin login` 会挂住（`Last Result: 267009`） | **服务器端自主续期**：`auth.refresh`（→ `17` §三）。本机链路**待用户确认后删除** |
| 服务器 `magpie-monkeycode-refresh.timer`（每 2 小时，cookie 变了才重登） | 插件已能自己续，无需「文件变更 → 重登」这一跳 | 同上，timer 可一并退役 |
| 「A 通道余额不足 = 百智云账户没钱，要充值」 | **错**：A 的余额来自每日临时额度，签到即得 | 每日签到（`scripts/baizhi-checkin.py`，每日 08:20） |

> **为什么会误判**：把「上游报余额不足」直接映射成「要充值」，跳过了「两个通道钱包不同、
> A 有每日免费额度」这一层。⇒ 遇到余额类错误，先分清是**哪个钱包**、**能不能签到**。

## 七、待办

见 `AGENTS.md` 的当前状态看板（**待办只维护那一份**）。

## 相关

- `17-MonkeyCode插件接入与自主续期.md` —— 插件实现、fork 原因、自主续期。
- `18-magpie插件宿主契约.md` —— 快照 / 槽位 / 过期 / 签到 tick 的宿主机理。
