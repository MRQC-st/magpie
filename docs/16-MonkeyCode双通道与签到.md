# 16 · MonkeyCode 双通道与签到（2026-10-30）

> **本文是什么**：MonkeyCode 在 magpie 上的两条通道（谁实现、实测什么状态）、**两条通道各自的签到**，
> 以及「登录一次之后还要不要再手动登录」的自动续期方案。
> **本文不负责**：magpie 网关部署（→ `00`/`01`）、第三方插件接入（→ `14`）、u1s12api（→ `15`）。

## 〇、本地 fork 插件上线（2026-10-30 下午）

社区插件 `opencode-monkeycode-auth` 0.1.1 有三处硬伤，本仓库的
**`plugins/monkeycode/`** 全部修掉，并已部署到服务器
（`/home/ubuntu/magpie-plugins/monkeycode`，`magpie plugin add` 本地路径）。

| 社区插件 0.1.1 | 本仓库 fork | 根因 |
|---|---|---|
| 只有一个 `monkeycode`，国际版要靠 env 覆盖 | **两个供应商**：`monkeycode`（国内版）/ `monkeycode-intl`（国际版），各占一行、登录态与账号池互不干扰 | 一个包只能导出一个插件 |
| `single: true` ⇒ 再登录一次就**覆盖**第一个账号 | 不设 `single` ⇒ magpie 自己开 `monkeycode#xxxxxx` 槽位，**多账号并存** | magpie 的 `signInKey`：single 为真时永远写进第一个槽 |
| 没有 `auth.refresh` ⇒ 7 天后凭据静默失效 | **服务器端自主续期**（会话有效就自己铸新 key；会话过期就用口令重登；国内版还有百智云 OAuth 桥） | 凭据只是 `plugin login` 那一刻的快照 |
| 只签 B 通道 | **A 通道（百智云每日临时额度）也签** | A 不领就是 0 ⇒ `400 余额不足` |

### 0.1 修掉的四个真 bug（都是实测撞出来的）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 续期时 OAuth 桥回 `400 参数错误` | 授权页的 query **整段照抄**到 API 端点（`scope=user+phone` 的 `+` 服务端不认） | 照上游 `authorize_page_to_api`：按名字取参数再逐个 append |
| 2 | OAuth 桥发 `401` | 只带 `baizhi_session` 一个 cookie 走到底 | 自己维护 cookie 罐，链上种下的 cookie 一起带 |
| 3 | **oauth 账号取不到 key** ⇒ loader 返回 `{}` ⇒ 请求没有 baseURL/apiKey | magpie 的 oauth 记录把 key 存在 **`refresh`**、签名密钥存 **`access`**，而 `credentialOf` 只读 `auth.key` | `credentialOf` 兼容 `auth.refresh` / `auth.access` |
| 4 | 国际版登录捡到国内版的 `base_url` | 客户端 `settings.json` 里两地区的条目混在一个文件 | `localCredentialFor(dir, {site})` 按地区挑；cookie 也按 domain 挑 |

> ⚠️ bug 3 最阴险：`credentialOf` 少读一个字段 ⇒ key 是空串 ⇒ loader 提前
> `return {}` ⇒ **不报错，直接没有 baseURL**。只有真打一次请求才看得出来。

### 0.2 服务器端自主续期（脱离本机电脑）

```
magpie 到期前 24h（refreshLead）调 auth.refresh
  └─ 控制台会话还有效 → POST /api/v1/users/ohmyagent/api-keys 铸一把新的 oma_ key + omas_ 密钥
     └─ 会话过期 → ① 用服务器上存的口令重新登录（国际版只能走这条）
                 ② 国内版还可用百智云 OAuth 桥（30 天的 baizhi_session 换一个会话）
     └─ 都没有 → 抛 signIn:"expired"，magpie 把该账号标成「需要重新登录」，其余账号照常
```

口令存在 `~/.config/magpie/monkeycode-credentials.json`（600），
**不进 `plugin-auth.json`** —— 那个文件 magpie 的网页界面读得到。

实测（服务器上，无本机电脑参与）：

```
python3 -c "把 plugin-auth.json 里 monkeycode.expires 改成 1"   # 强制到期
magpie quota monkeycode                                            # 触发一次
⇒ key 换了（oma_f2khpmj5 → oma_gu77263a）
⇒ expires 变成 2026-11-06（= 会话 cookie 的真实到期）
⇒ 网关实测：monkeycode/basic/deepseek-flash → 200 "PONG"
```

### 0.3 多账号实测

```
magpie plugin login monkeycode 3        # 手动填 oma_ key + omas_ 密钥
⇒ plugin-auth.json 里同时有：
     monkeycode         type=oauth  uid=019d9669-…  email=18975964597@qq.com
     monkeycode#co5ov5  type=oauth  （第二个账号槽）
⇒ magpie quota monkeycode 列出两行，magpie plugin list 显示两个 provider
```

### 0.4 14 个模型而不是 25 个（**不是 bug**）

账号在 B 侧的套餐是 **basic**（`GET /api/v1/users/subscription` → `{"plan":"basic"}`），
上游 `plan_allows_model` 的规则是：

- `monkeycode-ultra*` ⇒ 需要 flagship / ultra 档
- `monkeycode-pro*`  ⇒ 需要 pro / flagship / ultra 档
- 其余（含 basic 与 8 个裸名）⇒ 恒可用

实测（同一把 key、同一套签名）：

```
monkeycode-basic/deepseek-flash → 200
monkeycode-pro/gpt-5.6-terra    → 403 Forbidden
monkeycode-ultra/gpt-6-astra    → 403 Forbidden
```

⇒ 6 个 basic + 8 个无档位名 = **14 个**（25 - 11 个 pro/ultra）。
插件按套餐过滤，所以 basic 账号只看到 14 个 —— 与上游一致
（上游是把 pro/ultra 标成 `locked` 而不是藏起来，magpie 没有 `locked` 这个标记）。

## 一、两个通道是什么

MonkeyCode（长亭 chaitin · ohmyagent）逆向项目里有**两个互不相同的计费通道**
（SSOT：`model-reverse/providers.yaml` 的 `monkeycode` 条目 + `docs/12-情报-M13-MonkeyCode.md`）：

| 通道 | 端点 | 凭据 | 目录 | 计费账户 |
|---|---|---|---|---|
| **A** | `ai-models.app.baizhi.cloud`（百智云）<br>`/api/anthropic/v1/messages`、`/api/openai/v1/responses` | SK 密钥（`sk-…`） | 46 个模型 | **baizhi.cloud 钱包**（另一本账） |
| **B** | `proxy.monkeycode-ai.com/v1`（订阅网关） | `oma_…` key + `omas_…` 签名密钥（HMAC-SHA256 签 system 首块） | 25 个带档位的模型（`monkeycode-basic/…`、`-pro/…`、`-ultra/…`） | **monkeycode-ai.com 官方云钱包**（订阅账户的每日免费 Token + 积分） |

本机 `%APPDATA%\com.chaitin.baizhi.monkeycode\ohmyagent\settings.json` 里 **69 个模型条目**
就是这两条通道的并集：44 个 `@baizhi` 条目（A）+ 25 个 `monkeycode-*` 条目（B）。
> ⚠️ `14` 号文档里写的「17 个 `monkeycode-*` 条目」是旧数，实际 **25 个**。

## 二、为什么 magpie 上只有一个通道

装的是社区插件 `opencode-monkeycode-auth` 0.1.1（`github:xxhhlk/magpie-monkeycode-plugin`），
它**只实现了 B**：`readLocalCredential()` 在 settings.json 里只取 `models` 中
`name.startsWith("monkeycode-")` 的条目，因此它只有 25 个 B 档模型，A 通道的 SK 与
44 个 `@baizhi` 模型它压根不读。

⇒ magpie 上 `monkeycode` provider = 25 个模型；A 通道的模型一个都没有。

## 三、A 通道已补进 magpie（custom vendor，零代码）

magpie 支持「自定义厂商」直接吃 Anthropic / Responses 协议的端点，于是把 A 挂成独立 provider：

```sh
# SK 从服务器上已有的 settings.json 里取（那份是我们导入凭据时带过去的）
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

## 四、两条通道**各自**的签到（关键：不是同一个站）

这一节是 2026-10-30 修正的认知：**两条通道的余额来自两个不同站点的钱包，签到端点也各走各的。**
magpie 的插件只做了 B，A 之前一直没人做 —— 那才是 A 长期 `400 余额不足` 的真正原因。

| | A 通道（百智云） | B 通道（MonkeyCode 官方云） |
|---|---|---|
| 钱包站 | `baizhi.cloud` | `monkeycode-ai.com` |
| 会话 cookie | `baizhi_session`（HttpOnly，**30 天**） | `monkeycode_ai_session`（**7 天**） |
| 状态查询 | `GET /api/v1/user/wallet/balance` → `data.daily_temporary_credit_claimed` | `GET /api/v1/users/wallet` → `balance` / `daily_token_balance` |
| 签到 | `POST /api/v1/user/wallet/daily-temporary-credit` body `{"captcha_token":"…"}` → **+100 积分/天** | `POST /api/v1/users/wallet/checkin` → **+100 积分/天**（幂等） |
| 验证码 | 自研 **Cap PoW**（见下） | 自研 **Cap PoW**（插件自带实现） |
| 本机 cookie 文件 | `%APPDATA%\com.chaitin.baizhi.monkeycode\baizhi-cookies.json` | `…\monkeycode-cookies.json` |
| magpie 里谁做 | **本仓库 `scripts/baizhi-checkin.py`**（A 侧此前缺位） | 社区插件 `auth.checkin`（已实现，PoW 也在插件里） |

### 4.1 Cap PoW（@cap.js 0.0.6 族，两站同源）

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

### 4.2 A 通道签到的实测（2026-10-30 13:31）

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

### 4.3 B 通道签到的实测（2026-10-30 13:40）

刷新 cookie 后服务器侧直查控制台：

```
GET /api/v1/users/wallet/checkin → 200 {"checked_in": false}
GET /api/v1/users/wallet         → 200 {"balance": 277434, "daily_token_balance": 9992562, "daily_token_limit": 10000000}
```

`magpie quota monkeycode` 也从「未保存控制台 Cookie」变成
`每日 Token 额度 0% (7.4K / 10M tokens)  278 积分 left`。
之后由 magpie 自己的插件签到（`pluginCheckins.monkeycode=true`，每 30 分钟一次 tick）POST 领取。

## 五、会话有效期与「登录一次之后还要不要再登录」

| cookie | 有效期 | 谁续期 | 实测 |
|---|---|---|---|
| `monkeycode_ai_session`（B 控制台） | **7 天** | **MonkeyCode 桌面端每次启动自动续期**（无需重新登录账号） | 2026-10-30 启动客户端：过期到 2026-10-14 的 cookie → 变成 **2026-11-06** |
| `baizhi_session`（A 钱包） | **30 天** | 客户端启动**不**延长（要真登录/换 session 才变） | 2026-10-08 写过文件，expires 仍是 2026-11-06 |

两个坑：

1. **magpie 的插件不会自己续期**。社区插件**没有 `auth.refresh`** —— 凭据是 `plugin login` 那一刻
   拷进 `plugin-auth.json` 的快照（`key` + `metadata.secret/cookie/base`），
   请求时只读这份快照，**不再回读服务器上的文件**。所以「服务器文件更新了」≠「插件生效」。
2. **服务器上的 cookie 文件是本机文件的一次性拷贝**，不更新就会一直用过期值；
   插件 `readCookieFile()` 按 `expires` 判活，**过期就静默丢弃** ⇒ 表现为「未保存控制台 Cookie」。

⇒ 完整链路 = ①客户端续期本机 cookie → ②文件同步到服务器 → ③服务器重跑 `plugin login monkeycode 1`。
下面把它自动化。

## 六、自动续期方案（已落地）

### 6.1 本机（Windows）：`scripts/sync-monkeycode-creds.ps1` + 计划任务

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sync-monkeycode-creds.ps1
```

做三件事：启动 MonkeyCode 客户端（让它续期 cookie）→ sha256 比对，只同步**变了**的两个 cookie 文件
→ 服务器上重跑 `magpie plugin login monkeycode 1`（keyless，零交互）。

计划任务 **`magpie-sync-monkeycode`**：每日 **08:05**（`schtasks` 注册，只在登录状态下跑；
电脑关机/未登录时当天不会执行，下次开机后下一次运行补上）。
> ⚠️ 踩坑：计划任务在隐藏窗口里跑，**stdin 是一个没人输入的控制台** —— 远端 `magpie plugin login`
> 会一直等输入而挂住（第一次跑就卡在 `Last Result: 267009` = 仍在运行）。
> 解法：`ssh -n`（stdin 接 /dev/null）+ 远端命令 `magpie plugin login monkeycode 1 < /dev/null`。
> 另：`schtasks /sc onlogon` 建任务报「Access is denied」（需要管理员），所以只有每日一条。

### 6.2 服务器（systemd user）

| 单元 | 作用 | 频率 |
|---|---|---|
| `magpie-monkeycode-refresh.timer` → `.service` | 跑 `scripts/refresh-monkeycode-auth.sh`：服务器上的 cookie 文件 sha256 变了才重跑 `plugin login monkeycode 1` | 每 2 小时 |
| `magpie-baizhi-checkin.timer` → `.service` | 跑 `scripts/baizhi-checkin.py`：领 A 通道的每日临时额度 | 每日 **08:20**（`Persistent=true`，关机错过会补） |
| magpie 自带插件签到 | `pluginCheckins.monkeycode=true` → 领 B 通道积分 | 每 30 分钟 tick |

脚本落在服务器 `~/refresh-monkeycode-auth.sh`、`~/baizhi-checkin.py`；
仓库副本见 `scripts/`，服务器侧改动后 `scp` 覆盖即可。

### 6.3 用户还要做什么

**日常不需要再手动登录。** 只要这台 Windows 机器开着、客户端被计划任务拉起来一次，
B 通道的 7 天 cookie 就会一直续着，服务器侧 2 小时内的定时器会把新 cookie 收进插件。

仍需人工的边界情况：

- **电脑长期不开机 / 客户端从未启动** → B 通道 cookie（7 天）过期 ⇒
  手动**启动一次客户端**即可（不必重新登录账号，客户端会自己续期）。
- **A 通道的 `baizhi_session`（30 天）** → 客户端启动不延长它 ⇒ 每 ~30 天需要在
  baizhi.cloud 重新登录一次（或用 `relay-checkin` 的 `probe/baizhi_adapter.py --add` 重抓 cookie）。
- 服务器上的凭据文件被清掉 / 换了机器 ⇒ 重跑一次 `scripts/sync-monkeycode-creds.ps1`。

## 七、实测矩阵（2026-10-30）

| 通道 / 模型 | 结果 |
|---|---|
| A `GET /api/anthropic/v1/models` | ✅ 200，46 个模型 |
| A `POST /api/anthropic/v1/messages` | ✅ **200，正文 PONG**（领完每日额度后；领之前是 400 余额不足） |
| A 经网关 `baizhi/minimax-m2.7` | ✅ 200，正文 `MiniMax-M2.7`（`magpie provider test baizhi` → ✓ anthropic / ✓ responses） |
| B `monkeycode-basic/deepseek-flash` | ✅ 200，正文 `PONG`（直连签名请求与经网关两条路径都验过） |
| B `monkeycode/basic/{qwen3.8-flash, deepseek-flash, glm-5.3-flash, minimax-m2.5}` | ✅ 200，正文 `PONG` |
| B `monkeycode-pro/qwen3.6-plus`、`monkeycode-ultra/qwen3.7-max` | ❌ 403 Forbidden（用的就是带档位的全名 ⇒ 不是「模型名要带档位」那个坑，是**本账号在 B 侧只有 basic 档权限**） |
| B 无档别名 `monkeycode/qwen3.6-plus` | ❌ 502（上游回 Cloudflare HTML 页） |
| B 积分查询 `magpie quota monkeycode` | ✅ `每日 Token 额度 0% (7.4K / 10M) 278 积分 left` |
| B 控制台会话 | ✅ `monkeycode_ai_session` 刷新后 → 2026-11-06（客户端自动续期） |
| A 钱包会话 | ✅ `baizhi_session` 有效 → 2026-11-06 |
| A 每日签到 | ✅ `+100 积分`（`scripts/baizhi-checkin.py`） |

### 7.1 fork 插件上线后的实测（2026-10-30 下午，服务器上）

| 项 | 结果 |
|---|---|
| 插件列表 | `monkeycode (国内版, 14 models) signed in as 18975964597@qq.com` / `monkeycode-intl (国际版, 25 models) not signed in` |
| 账号存储形状 | `monkeycode` 一条，`type=oauth`，`refresh`/`access`/`expires` 齐 ⇒ **magpie 会自动续期** |
| 强制到期后自动续期 | ✅ 把 `expires` 改成 1 → `magpie quota` 触发 → key 换新、expires → 2026-11-06 |
| 网关推理（`monkeycode/basic/deepseek-flash`） | ✅ 200，正文 **`PONG`** |
| 会话过期后的续期（走 OAuth 桥） | ✅ 铸出新 key（`oma_ae22a4ee`） |
| 多账号并存 | ✅ `monkeycode` + `monkeycode#co5ov5` 两个槽位同时在册 |
| 国际版拒绝捡国内版配置 | ✅ `服务器上的客户端配置里没有 MonkeyCode 国际版 的凭据（要找的端点是 https://proxy.monkeycode-ai.net/v1）` |
| A 通道余额 | ✅ `available_credit_cents=9978`（≈100 积分），`daily_temporary_credit_claimed=true` |
| 插件自带测试 | ✅ `bun test` → **68 pass / 0 fail**（5 个测试文件） |

## 八、待办

| 项 | 谁做 | 状态 |
|---|---|---|
| A 通道每日签到（领临时额度） | 服务器 systemd timer | ✅ 已上线（每日 08:20） |
| B 通道 cookie 自动续期 + 同步 | 本机计划任务 + 服务器 timer | ✅ 已上线 |
| B 通道积分签到 | magpie 插件（每 30 分钟） | ✅ 已上线（`pluginCheckins.monkeycode=true`） |
| **服务器端自主续期（不靠本机电脑）** | 本仓库 fork 插件 `auth.refresh` | ✅ 已上线并实测（见 0.2） |
| **国内版 / 国际版分供应商** | 本仓库 fork 插件（一包两导出） | ✅ 已上线并实测 |
| **多账号并存** | 本仓库 fork 插件（去掉 `single`） | ✅ 已上线并实测 |
| **国际版账号登录** | 用户（`magpie plugin login monkeycode-intl 2`，邮箱 + 口令） | ⏳ 服务器上还没有国际版账号 |
| `baizhi_session` 30 天到期后的重抓 | 用户（浏览器登录 baizhi.cloud / `relay-checkin --add`） | ⏳ 2026-11-06 前 |
| B 通道 pro/ultra 档 | 用户（订阅升级） | ⏳ 当前账号只有 basic 档 |
| 给 B 挂 A 回落（`magpie provider fallback`） | 待定 | ⏳ 现在 A 已有每日额度，可考虑挂回落 |
| 旧的本机同步链路（`scripts/sync-monkeycode-creds.ps1` + 计划任务 `magpie-sync-monkeycode`） | — | ⏳ 服务器已自主，**本机这条可以退役**（待用户确认） |
