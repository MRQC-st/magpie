# 17 · MonkeyCode 插件接入与自主续期（本地 fork）

> **本文是什么**：本仓库托管的 MonkeyCode 插件 `plugins/monkeycode/` —— **为什么 fork**（社区插件的三处硬伤）、
> **修掉的四个实测 bug**、**服务器端自主续期链路**、**多账号并存**、**模型数量为何是 14 而不是 25**，
> 以及部署与登录方法。
> **本文不负责**：两条计费通道的端点/签到协议本身（→ `16`）、magpie 宿主机制本身（→ `18`）、
> 网关部署（→ `00`/`01`）、社区插件的安装记录（→ `14`）。

## 索引

| 节 | 内容 |
|---|---|
| 一 | 为什么 fork：社区插件 0.1.1 的三处硬伤 |
| 二 | 修掉的四个真 bug（都是实测撞出来的） |
| 三 | 服务器端自主续期（脱离本机电脑） |
| 四 | 多账号并存 |
| 五 | 14 个模型而不是 25 个（不是 bug） |
| 六 | 部署与登录 |
| 七 | 待办 |

## 一、为什么 fork：社区插件 0.1.1 的三处硬伤

社区插件 `opencode-monkeycode-auth` 0.1.1（spec `github:xxhhlk/magpie-monkeycode-plugin`）
在本项目实测下暴露三处硬伤，本仓库的 `plugins/monkeycode/` 全部修掉。

| 社区插件 0.1.1 | 本仓库 fork | 根因（宿主契约） |
|---|---|---|
| 只有一个 `monkeycode`，国际版要靠 env 覆盖 | **两个供应商**：`monkeycode`（国内版）/ `monkeycode-intl`（国际版），各占一行、登录态与账号池互不干扰 | 一个包只能导出一个插件 ⇒ 靠「导出两个函数」实现（`18` §一） |
| `single: true` ⇒ 再登录一次就**覆盖**第一个账号 | 不设 `single` ⇒ 宿主开 `monkeycode#xxxxxx` 槽位，**多账号并存** | `single` 为真时宿主永远写第一个槽位（`18` §五） |
| 没有 `auth.refresh` ⇒ 7 天后凭据静默失效 | **服务器端自主续期**（会话有效就自己铸新 key；会话过期就用口令重登；国内版还有百智云 OAuth 桥） | 凭据只是 `plugin login` 那一刻的快照（`18` §四） |

额外一条：A 通道（百智云每日临时额度）社区插件**不签**，导致 A 长期 `400 余额不足`
（详见 `16` §三）。

> **为什么会误判**：最初只把「装了一个插件、25 个模型」当成装好了，
> 直到实际调用出现「余额不足」和「7 天后突然全部 401」才逐条挖到上面三处 ——
> 三条全是**宿主契约**问题，不是插件业务逻辑问题。⇒ 排查插件故障时，
> 先按 `18` 的清单逐条对照宿主行为，再看业务代码。

## 二、修掉的四个真 bug（都是实测撞出来的）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 续期时 OAuth 桥回 `400 参数错误` | 授权页的 query **整段照抄**到 API 端点（`scope=user+phone` 的 `+` 服务端不认） | 照上游 `authorize_page_to_api`：按名字取参数再逐个 append |
| 2 | OAuth 桥发 `401` | 只带 `baizhi_session` 一个 cookie 走到底 | 自己维护 cookie 罐，链上种下的 cookie 一起带 |
| 3 | **oauth 账号取不到 key** ⇒ loader 返回 `{}` ⇒ 请求没有 baseURL/apiKey | magpie 的 oauth 记录把 key 存 **`refresh`**、签名密钥存 **`access`**，而 `credentialOf` 只读 `auth.key` | `credentialOf` 兼容 `auth.key ?? auth.refresh`；密钥兼容 `md.secret ?? md.signingSecret ?? auth.access` |
| 4 | 国际版登录捡到国内版的 `base_url` | 客户端 `settings.json` 里两地区的条目混在一个文件 | `localCredentialFor(dir, {site})` 按地区挑；会话 cookie 也按 domain 挑 |

> ⚠️ bug 3 最阴险：`credentialOf` 少读一个字段 ⇒ key 是空串 ⇒ loader 提前
> `return {}` ⇒ **不报错，直接没有 baseURL**。只有真打一次请求才看得出来。

## 三、服务器端自主续期（脱离本机电脑）

```
magpie 到期前 24h（refreshLead）调 auth.refresh
  └─ 控制台会话还有效 → POST /api/v1/users/ohmyagent/api-keys 铸一把新的 oma_ key + omas_ 密钥
     └─ 会话过期 → ① 用服务器上存的口令重新登录（国际版只能走这条）
                 ② 国内版还可用百智云 OAuth 桥（30 天的 baizhi_session 换一个会话）
     └─ 都没有 → 抛 signIn:"expired"，magpie 把该账号标成「需要重新登录」，其余账号照常
```

口令存在服务器 `~/.config/magpie/monkeycode-credentials.json`（600），
**不进 `plugin-auth.json`** —— 那个文件 magpie 的网页界面读得到（`18` §九）。

实测（服务器上，**全程无本机电脑参与**）：

```
python3 -c "把 plugin-auth.json 里 monkeycode.expires 改成 1"   # 强制到期
magpie quota monkeycode                                            # 触发一次
⇒ key 换了（oma_f2khpmj5 → oma_gu77263a）
⇒ expires 变成 2026-11-06（= 会话 cookie 的真实到期）
⇒ 网关实测：monkeycode/basic/deepseek-flash → 200 "PONG"
```

⇒ **日常不需要本机电脑开机、不需要手动登录、不需要跑本机同步脚本。**
旧的「本机计划任务 → 同步 cookie → 服务器重登」链路已被本节取代（见 `16` §六）。

### 国际版没有 OAuth 桥（2026-11-03 实测，别再试）

客户端源码把账号站写死为 `MC_DESKTOP_BAIZHI_URL` 默认 `https://baizhi.cloud`（不随地区变），
但国际版的登录入口 `https://monkeycode-ai.net/api/v1/users/login` 302 出来的授权页
**`client_id` 是空串**（国内版是 `client_id=monkeycode-ai`）：

```
GET  monkeycode-ai.net/api/v1/users/login?redirect=&inviter_id=
→ 302 /oauth/authorize?client_id=&redirect_uri=https://monkeycode-ai.net/api/v1/users/baizhi/callback…
GET  baizhi.cloud/api/v1/oauth/authorize?client_id=&…
→ 400 {"code":400,"message":"参数错误"}
```

⇒ **国际版不能复用国内版的百智云会话来换会话**。国际版要自动续期只能靠**口令登录**
（方式 2）；只想用起来就用方式 4 粘会话 Cookie，到期再粘。


## 四、多账号并存

```
magpie plugin login monkeycode 3        # 手动填 oma_ key + omas_ 密钥
⇒ plugin-auth.json 里同时有：
     monkeycode         type=oauth  uid=019d9669-…  email=18975964597@qq.com
     monkeycode#co5ov5  type=oauth  （第二个账号槽）
⇒ magpie quota monkeycode 列出两行，magpie plugin list 显示两个 provider
```

前提：插件**不设 `single`**（`18` §五）。宿主生成的槽位 id 形如 `<provider>#xxxxxx`。

## 五、14 个模型而不是 25 个（**不是 bug**）

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

⇒ **14 个**（B 通道 25 条 = 17 条带档位前缀〔6 个 basic + 11 个 pro/ultra〕+ 8 条无档位别名；
basic 账号可见 = 6 + 8 = 14）。
插件按套餐过滤，所以 basic 账号只看到 14 个 —— 与上游一致
（上游是把 pro/ultra 标成 `locked` 而不是藏起来，magpie 没有 `locked` 这个标记）。
国际版 provider 未登录时列 **25 个**（未登录时按全量目录展示）。

> **为什么会误判**：把「25 个模型」当成账号应有的权益，于是把「pro/ultra 403」当成签名 bug。
> 实际是**套餐权限**，与签名、key、模型名都无关。判据要先查 `/api/v1/users/subscription`。

## 六、部署与登录

```sh
# 服务器上：仓库目录是本地路径插件（folder plugin，就地加载）
magpie plugin add /home/ubuntu/magpie-plugins/monkeycode
magpie daemon restart                 # 重新加载插件

magpie plugin login monkeycode 1      # 方式 1：读服务器上的客户端登录态（keyless，零交互）
magpie plugin login monkeycode 2      # 方式 2：账号 + 口令
magpie plugin login monkeycode 3      # 方式 3：手填 oma_ key + omas_ 密钥
magpie plugin login monkeycode-intl 4 # 方式 4：浏览器登录后粘贴会话 Cookie（国际版推荐）
```

### 方式 4：浏览器登录后粘贴会话 Cookie（2026-11-03 新增）

**为什么需要它**：国际版（以及国内版）**没有可调用的注册 API** —— 注册与登录都在网页端
（百智云 / Google / GitHub / 账号密码 / 快速注册）。插件问「邮箱 + 口令」时，若账号是用
百智云或 Google 注册的，用户**根本没有口令**，路就断了。

方式 4 不猜口令，改成把「网页登录后的会话」接过来：

1. 浏览器打开 `https://monkeycode-ai.net/login`（国内版是 `https://monkeycode-ai.com/login`），
   用页面上的方式注册或登录；
2. 进控制台后，devtools → Application → Cookies，复制 `monkeycode_ai_session` 的值；
3. `magpie plugin login monkeycode-intl 4`，粘贴进去。

插件会：校验会话（`GET /api/v1/users/status`）→ 在控制台**自动铸造**一把 `oma_` key +
签名密钥（`POST /api/v1/users/ohmyagent/api-keys`）→ 存成账号。
之后推理、查额度、签到都能用。会话到期再粘一次即可；若要**自动续期**，仍需方式 2 的口令
（国际版没有百智云 OAuth 桥，这一点见 §三）。

> 口令登录失败时，错误信息也会指向方式 4 —— 不是「口令错」，而是「你可能压根没有口令」。

### 微信扫码登录（国内版，2026-11-16 修复后可用）

`微信扫码登录（手机扫一下，不要口令）` 登录方式（仅国内版）：插件起扫码会话 → magpie UI 打开**二维码图片直链**（同一 uuid）→ 手机扫 → 确认 → 服务器捕获回调 → OAuth 桥换会话 → 铸 key → 落盘。全程自助，与其它插件体验一致。

⚠️ 三条实测纪律（2026-11-16 五轮排查沉淀，DEC-MAG-019）：
1. **qrconnect 授权页每次加载生成新 uuid** ⇒ 给 UI 的 `url` 必须是二维码图片直链，绝不能是 authUrl（否则用户扫的码与插件轮询的码永远错位）。
2. **`lp.baizhi.cloud` 不在 CLB 证书 SAN** ⇒ Node fetch 长轮询必须走 `lpRelaxedFetch`（`wechat-login.mjs`）。
3. **同账号重铸 key 吊销旧 key** ⇒ 每个微信号只保留一个槽；重复登录后旧槽 403 属预期，界面「重新登录」或移除即可。

多账号：百智 A 通道会话**按槽隔离**（`bzFor(auth,env)` 优先 `metadata.bz_cookie`），扫码登录新微信号不会顶掉旧号的 A 通道签到。

### 签到：两条通道都从插件里走（2026-11-03 修正）

`auth.checkin` 的行为：

1. 账号记录里没有会话时，**先试着续期**（会话 → 口令 → 百智云 OAuth 桥），拿到会话再签到，
   而不是直接判 `ineligible`。历史记录、手填时没填 cookie 的账号因此能自愈。
2. B 通道（官方云每日积分）与 A 通道（百智云每日临时额度）**都签**，且两条通道的结果
   都会写进 `message`（此前 A 通道失败会被静默吞掉，界面上只剩 B 的「今日已签到」，
   看着像 A 根本没跑）。


环境变量（见 `plugins/monkeycode/README.md`）：

| 变量 | 作用 |
|---|---|
| `MONKEYCODE_SESSION` | 直接注入控制台会话，优先于 cookie 文件 |
| `MONKEYCODE_COOKIE_FILE` | 会话 cookie 文件路径 |
| `MONKEYCODE_CREDENTIALS_FILE` | 口令文件路径（默认 `~/.config/magpie/monkeycode-credentials.json`） |

插件自带测试：`bun test ./test/` → 68 pass / 0 fail（5 个测试文件）；
node 侧 `node --test --test-force-exit "test/**/*.test.mjs"` 同批用例。

## 七、待办

| 项 | 谁做 | 状态 |
|---|---|---|
| 国际版账号登录 | 用户（浏览器登录 `monkeycode-ai.net` 后 `magpie plugin login monkeycode-intl 4` 粘会话） | ⏳ 服务器上还没有国际版账号；该站**没有注册 API**，注册只能在网页端 |
| B 通道 pro/ultra 档 | 用户（订阅升级） | ⏳ 当前账号只有 basic 档 |
| `baizhi_session` 30 天到期后的重抓 | 用户（浏览器登录 baizhi.cloud / `relay-checkin --add`） | ⏳ 2026-11-06 前 |
| 旧的本机同步链路（`scripts/sync-monkeycode-creds.ps1` + 计划任务 `magpie-sync-monkeycode`） | — | ⏳ 服务器已自主，**本机这条可以退役**（待用户确认） |

## 相关

- `16-MonkeyCode双通道与签到.md` —— 两条通道的端点、各自的签到与会话有效期。
- `18-magpie插件宿主契约.md` —— 本文引用的全部宿主机制。
- `plugins/monkeycode/README.md` —— 插件自身的说明与安装片段。
