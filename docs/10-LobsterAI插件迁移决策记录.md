# 决策记录 — LobsterAI → magpie 插件迁移（试点第一例）

> **本文是什么**：本任务的**决策 SSOT** —— 目标、已定决策（含被否方案）、6 项待回填能力、
> 不可协商约束、完成标准、事实核验与移植清单核实结论。
> **本文不负责**：部署步骤（→ `11`）、验收证据（→ `12`）、宿主机制通则（→ `18`）、
> 其它插件（→ `13`～`17`）。
>
> 状态：已收敛（2026-10-27）。来源：澄清访谈 + 仓库事实核验（官方插件文档 + 服务器实测 + 本机 sqlite 实读）。
> 本文件是本任务的 SSOT；后续文档回写以本文件为准。

## 索引

| 节 | 内容 |
|---|---|
| 一 | 目标与背景 |
| 二 | 已定决策（含理由与被否方案） |
| 三 | 待回填的 6 项能力（自有实现 → 参考插件） |
| 四 | 不可协商的约束（来自仓库事实核验） |
| 五 | 完成标准（验收） |
| 六 | 参考事实速查 |
| 七 | 补充：可测试性阻断项与测试方案（S4 调研） |
| 八 | S2 移植清单核实结论 |
| 九 | S3 服务器约束核实结论 |

## 一、目标与背景

- **最终目标**：把 `D:\projects\model-reverse`（mrv，自有逆向网关）里已逆向成功的应用，逐个转成 **magpie 插件**并配置到 magpie 网关上，逐步用 magpie 替代 mrv 逆向项目。
- **本期范围**：第一个试点 —— **LobsterAI**（网易有道 Electron 客户端，M22 逆向成果，2026-10-04）。
- **产物落点**：`D:\projects\magpie\plugins\lobster`（独立插件目录，仓库内管理）。

## 二、已定决策（含理由与被否方案）

| # | 决策 | 理由 | 否决的备选 |
|---|---|---|---|
| D1 | 独立插件目录 `magpie/plugins/lobster` | 仓库内可管理、可版本化；与 magpie 文档同仓 | 直接改参考插件仓库（耦合上游）／只出文档不落代码 |
| D2 | **以参考插件为主干，回填自有实现全部 6 项能力** | 参考插件已符合 magpie 插件规范，自有实现的 6 项能力是「调用模型时出问题」的来源，必须补齐 | 完全重写（风险高）／只回填部分（留坑） |
| D3 | 按官方插件规范 `https://usemagpie.ai/docs/zh/plugins` 编写 | magpie 跑的是 OpenCode v1 插件，钩子形态固定 | — |
| D4 | 完整移植参考插件 lib 进插件目录（自包含） | 服务器部署不依赖外部仓库；改动与演进都在本仓 | git submodule（部署绕）／vendor 单文件（可读性差） |
| D5 | 模型目录：**云端 `/api/models/available` 为主，openclaw.json 兜底** | 服务器无桌面客户端时靠云端；本机场景可回退本地目录，两条都实现、优雅降级 | 只云端（丢本机兜底）／只本地（服务器列不出模型） |
| D6 | 登录：**传本机 `lobsterai.sqlite` 副本到服务器 + 补服务器侧自动续签** | 零交互、一劳永逸：401 → `/api/auth/refresh` → 原子回写服务器副本，此后永不再登录 | 浏览器 oauth（需一次人工浏览器登录）／只读不刷新（27 天后断，须重传） |
| D7 | 部署实测在**腾讯云服务器**上做 | magpie 网关主体在那里（v0.1.1734，已装 8 个社区插件并多账号登录），本机无 magpie CLI | 本机装 magpie（与服务器架构重复） |
| D8 | 本期交付**完整闭环** | 试点要完整才敢铺开到其余 14 个适配器 | 只出代码／只出骨架 |

## 三、待回填的 6 项能力（自有实现 → 参考插件）

| 能力 | 自有实现位置 | 参考插件现状 | 合并后要求 |
|---|---|---|---|
| 每日签到 | `attemptDailyCheckin()`（client-activities 三段式：slot→context→check_in，判成功看 `creditsGranted>0`） | **缺失** | 用 magpie 的 `auth.checkin` 钩子实现（magpie 独有钩子，正对口） |
| 双层 JSON 兼容读取 | `kvGet()`：一次 parse 后若仍是字符串则再 parse | **只 parse 一次** → 读桌面端写的双层 stringify 会拿不到 token | 合并为双层兼容解析（自有实现 2026-10-19 已修此坑） |
| refresh 归因字段 | `refreshAccessToken()`：body 带 `firstKeyfrom/latestKeyfrom/uuid/userId/version` | 只发 `{refreshToken}` | 补齐归因字段，否则可能被上游判为异常来源 |
| 客户端版本动态读取 | 从客户端 `app.asar` 的 package.json 读 version，读不到回退常量并打 WARN | **写死 `2026.9.23`** | 改为动态读 + 回退打 WARN（版本腐化是上游兼容判定风险） |
| token 刷新回写 sqlite | `persistTokens()`：自适应 `updated_at` 列（NOT NULL 无默认值，旧 SQL 写回即炸） | 不写库（桌面同机场景的正确取舍） | 服务器副本场景必须能写；表结构自适应 + 双层 stringify 写回 |
| 模型目录 | 读 `%APPDATA%/LobsterAI/openclaw/state/openclaw.json`（mtime 缓存，30 个模型带上游真名） | 云端 `/api/models/available`（29 个） | 云端为主 + openclaw.json 兜底（D5） |

## 四、不可协商的约束（来自仓库事实核验）

1. **上游强制 SSE**：`stream:false` 也回 `text/event-stream` ⇒ 非流式调用方必须合并 SSE 回 `chat.completion` JSON（自有 `mergeSSEtoCompletion()`，参考插件 `lib/assemble.mjs`）。
2. **SSE 内嵌错误**：上游把错误塞进 `event:error` 且 HTTP 仍是 200 ⇒ 必须映射成真实状态码，否则 magpie 永不故障切换（参考插件 `lib/proxy.mjs` 的 `statusFor()` 做得对，保留）。
3. **思考档位**：magpie 阶梯最低档叫 `none`（非 `off`），只有 21/29 模型有 thinking profile；对无 profile 的模型发 `lobsterai_options` 是硬错误（code 4000），整轮聊天失败。保留参考插件 `lib/thinking.mjs` 的映射与 `none`→`off` 转换。
4. **kimi-k3 特判**：K3 的采样参数由服务端决定（`temperature/top_p/n` 被丢弃，`reasoning_effort` 固定 `max`），且 K3 不在 `/api/models/available` 里（29 个里没有）但实际可用。保留参考插件 `lib/thinking.mjs` 的 `applyKimiK3()`。
5. **401 = 唯一刷新信号**（客户端 `shouldRefreshLobsterAIToken` 判定），刷新要带归因字段。
6. **X-Magpie-Sign-In 头**：`expired` 标记账号失效、`kept` 清除标记；magpie 转发前会摘掉该头。参考插件已正确使用，保留。

## 五、完成标准（验收）

- [ ] `magpie/plugins/lobster` 插件目录自包含（index.mjs + lib/ + package.json + 测试），符合官方插件规范。
- [ ] 6 项回填能力全部实现且有对应测试。
- [ ] 服务器 `magpie plugin add` 成功，`magpie plugin list` 出现 `lobster` provider。
- [ ] 服务器 `magpie plugin login lobster` 用 sqlite 导入方式成功（零人工浏览器交互）。
- [ ] `magpie provider test lobster` 通过；且对 `lobster/deepseek-flash`、`lobster/kimi-k3` 各完成一次**真实推理**（出字 + 工具调用可用）。
- [ ] 非流式调用方拿到完整 `chat.completion` JSON（强制 SSE 合并生效）。
- [ ] 文档回写 `magpie/docs`（含部署步骤、验证记录、踩坑）。

## 六、参考事实速查

- 上游 base：`https://lobsterai-server.youdao.com`，chat 端点 `/api/proxy/v1/chat/completions`（OpenAI 协议）
- 客户端必备头：`X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1`、`X-LobsterAI-Client-Version: <asar package.json 的 version>`
- 本机凭证：`%APPDATA%\LobsterAI\lobsterai.sqlite`，表 `kv(key,value,updated_at)`，键 `auth_tokens`/`auth_user`/`installation_uuid`；值为**双层 JSON 字符串**
- 本机 accessToken：HS512 JWT，`yid=urs-phoneyd.c41c47c96a9042648@163.com`，`userId=94951`，到期 2026-11-23（JWT 不绑定机器 ⇒ 可复制到服务器）
- 服务器：`ubuntu@43.131.227.120`，magpie v0.1.1734，配置目录 `~/.config/magpie/`（`plugins.json`/`plugin-auth.json`/`plugin-providers.json`/`plugin-checkin.json`），网关 `0.0.0.0:3425`


---

## 七、补充：可测试性阻断项与测试方案（来自 S4 调研，2026-10-27）

### 7.1 阻断项（合并版实现前必须处理，否则离线测试跑不起来）

| # | 阻断项 | 位置 | 处理方案 |
|---|---|---|---|
| B1 | 顶层 `import { Database } from "bun:sqlite"` ⇒ node 下 ERR_MODULE_NOT_FOUND，整个插件不可导入 | 参考插件 `lib/auth-import.mjs` 第 5 行 | 改用 `node:sqlite`（node v24 与 bun 1.4.2 双端都支持同一 API）⇒ 一份源码双运行时可用 |
| B2 | 测试全部用 `import { test, expect } from "bun:test"`（expect 是 bun 专有断言 API） | 参考插件 `test/*.test.mjs` | 测试改 `node:test` + `node:assert/strict`（toBe→equal、toEqual→deepEqual、toContain→includes）；线上 Bun 侧另跑一遍复核 |
| B3 | 出站 BASE/CHAT_BASE 常量硬编码、不可注入 ⇒ refresh/签到/出站链路无法指向本地 mock | 自有实现 `SERVER_BASE` 同病 | 改 env 注入（如 `LOBSTER_API_BASE`）+ 构造参数，默认值不变 |
| B4 | `CLIENT_VERSION` 在模块加载时求值（读 asar），测试时无法覆盖 | 自有实现 `resolveClientVersion()` 模块级调用 | 改为惰性求值（首次使用时求值），便于测试注入 |

### 7.2 本机环境事实（S4 实测）

- **本机有 Bun**：`~/.cherrystudio/bin/bun`，revision `1.4.2+744846f84`；node `v24.14.0`
- node v24 的 `node:sqlite` 与 bun 1.4.2 的 `bun:sqlite`/`node:sqlite` 均可用 ⇒ B1 改 `node:sqlite` 后双端通吃
- 自有实现的统一测试入口范式：`node --test --test-force-exit '<glob>'`（`--test-force-exit` 必带，否则泄漏句柄会挂死整个套件）

### 7.3 测试双轨方案

| 轨道 | 环境 | 命令 | 用途 |
|---|---|---|---|
| A（主） | 本机 node | `cd plugins/lobster && node --test --test-force-exit "test/**/*.test.mjs"` | 开发/CI，零额外依赖 |
| B（复核） | 本机 bun / 服务器 bun | `bun test ./test/` | 线上运行时一致性复核（用路径过滤，不依赖 bun 默认发现规则是否覆盖 .mjs —— 该点未实证） |

**硬约束**：`lib/` 下代码必须双运行时兼容，除测试 runner API 外不得出现单侧专有 API。

### 7.4 测试矩阵（20 条，S4 产出，Wave 3 直接执行）

夹具代号：F1 DI 假上游（参考插件 `makeFetch` 注入缝）｜F2 真 http mock 上游（自有 `verdent.test.mjs`/`workbuddy.test.mjs` 范式，`server.closeAllConnections()` 必调）｜F3 SSE 帧构造（`sse.test.mjs` 的 from/collect + `assemble.test.mjs` 的 chunk + `proxy.test.mjs` 的 sseResponse）｜F4 双层 JSON sqlite 夹具（两种 schema：含/不含 updated_at）｜F5 JWT 夹具｜F6 全局 fetch 打桩（模型目录/refresh/usage）｜F7 模型目录夹具（云端 ENTRY + openclaw.json）｜F8 签到三段式 mock

| # | 用例 | 断言要点 | 夹具 |
|---|---|---|---|
| 1 | 非流式调用方拿到完整 chat.completion | object=chat.completion、choices[0].message.content 非空、content-type 为 application/json | F1+F3 |
| 2 | 合并 content/reasoning/tool_calls/usage/finish_reason | reasoning_content 正确拼接、tool_calls 参数拼接、finish_reason=tool_calls | F1+F3 |
| 3 | 零帧流不许当成功 | 仅 [DONE] ⇒ 502，不返回 200 空壳 | F1/F2+F3 |
| 4 | 工具独占时 content 为 null | message.content===null 而非空串 | F1+F3 |
| 5 | event:error → 401 | 状态 401 + X-Magpie-Sign-In: expired + 上游原文 | F1+F3 |
| 6 | event:error → 403/429/400 | 40300→403、42900→429、限流文案→429、未知→400 | F1+F3 |
| 7 | 上游真 401 透传带失效标记 | 401 + expired 头，不转 400 | F1 |
| 8 | 成功响应带 kept 头 | X-Magpie-Sign-In: kept | F1+F3 |
| 9 | 思考档位 none→off | lobsterai_options.thinking.level==='off' 且 reasoning_effort 已删 | F1 |
| 10 | variants 最低档键是 none 不是 off | 键含 none、不含 off | 纯函数 |
| 11 | 无档位表模型不得写 lobsterai_options | 字段不存在，且 reasoning_effort 保留 | F1 |
| 12 | kimi-k3 参数丢弃 | temperature/top_p/n/penalties 全 undefined；reasoning_effort=max；仅 tool_call 消息补 reasoning_content:'' | 纯函数 |
| 13 | 双层 JSON 值解出 token | 读出 accessToken（**合并前为失败用例**） | F4 |
| 14 | 单层 JSON 值仍解出 | 读出 | F4 |
| 15 | refresh 带归因字段 | firstKeyfrom/latestKeyfrom/version 必带；有 installation_uuid 带 uuid；有 uid 带 userId（**合并前为失败用例**） | F2/F6 |
| 16 | updated_at 自适应回写 | 含列：回写成功+值双层+updated_at 为数字；不含列：旧 SQL 也成功（**合并前为失败用例**） | F4+F6 |
| 17 | 签到判据 | creditsGranted>0⇒claimed；=0⇒已领不算；code≠0⇒失败 | F8 |
| 18 | 模型目录云端优先+openclaw 兜底 | 云端可用⇒用云端（accessible:false 丢弃）；云端失败⇒回退 openclaw.json；皆无⇒FALLBACK_MODELS | F6+F7 |
| 19 | 上游真 JSON 直通不重组 | 原样透传 | F1 |
| 20 | 未登录⇒401 且不发上游 | 401+expired 头，call 未被调用 | F1 |

### 7.5 真实联调最小验证序列（服务器）

模型名格式 `provider/model` ⇒ `lobster/deepseek-flash`、`lobster/kimi-k3`（provider id = `lobster`；kimi-k3 不在云端 29 个目录里但可用，**必须留在 FALLBACK_MODELS**否则选不到）。

1. `curl -s https://magpie.sunfolower.cn/v1/models -H "Authorization: Bearer <GATEWAY_KEY>"` ⇒ 见 `lobster/deepseek-flash`
2. `magpie provider test lobster` ⇒ CLI 冒烟（子命令面待现场确认）
3. deepseek-flash 非流式真实推理（`stream:false`）⇒ HTTP 200、content-type 为 application/json（**不是 event-stream**）、content 非空 ⇒ 证明强制 SSE 合并生效
4. 思考档位差分：`reasoning_effort` 取 none 与 high ⇒ none 的 reasoning_content 长度恰为 0，high 明显更长
5. kimi-k3 非流式真实推理 ⇒ 200 出字；再发带 tools 的请求 ⇒ tool_calls[0].function.name 有值、finish_reason=tool_calls
6. （可选）流式：`stream:true` ⇒ content-type text/event-stream 且末尾 data: [DONE]
7. （可选）401→refresh→重试：把服务器副本 token 改旧 ⇒ journalctl 可见 refresh（带归因字段）+ 写回 sqlite + 最终 200


---

## 八、S2 移植清单核实结论（2026-10-27，主代理亲自复核）

### 8.1 已实证的两项关键事实

| 事实 | 证据 | 影响 |
|---|---|---|
| **客户端 asar 版本真值 = 2026.10.16** | 分段读 asar header 解析 package.json（asar 669.3MB / 701,834,561 字节） | 🔴 参考插件写死 `2026.9.23`、mrv 回退常量 `2026.9.15` **均已腐化一个次版本**。服务端可能按版本做兼容判定 ⇒ 写死 = 静默降级/被拒。**必须动态读** |
| **Bun 1.4.2 的 `node:sqlite` 完全可用** | `bun -e "import {DatabaseSync} from 'node:sqlite'; ... prepare('select 1 as x').get().x"` ⇒ 返回 1 | ✅ **推翻 S2 的「Bun 无 node:sqlite、必须用 bun:sqlite」断言**。⇒ 采用 `node:sqlite`（node v24 + bun 1.4.2 双端通吃）⇒ **一份源码双运行时**，不必写驱动适配层，也不必改测试夹具的 bun 风格 API 语义 |

### 8.2 代理污染横切风险 —— 服务器端不成立（已核实）

- 服务器登录 shell **无** `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`
- systemd unit `~/.config/systemd/user/magpie.service` 完整 Environment 仅 4 条：`PATH`、`MAGPIE_ADDR=0.0.0.0:3425`、`NVM_DIR`、`MAGPIE_WEB_KEY` ⇒ **无代理变量**
- （`/proc/<pid>/environ` 读取被拒，进程属 magpie 私有，但 unit 已足以证明）

⇒ **mrv 侧的 `env_strip: HTTP_PROXY,...` 纪律在 magpie 侧没有等价物，但服务器端也不需要**。合并版仍保持防御性写法（不主动设代理、不依赖代理 env），但不必为此改造出站层。

### 8.3 S2 提取的 6 项能力 —— 关键修正与采纳项

| 能力 | S2 原始建议 | 主代理裁决 | 理由 |
|---|---|---|---|
| ① 签到 | 用 `auth.checkin`；**不照搬本地节流文件**；outcome 映射 claimed/done/inactive/ineligible；失败抛异常 | **采纳** | S2 指出的 R1/R2 是真缺陷：mrv 的节流文件在「尝试前」落盘 + 用 UTC 日，会把失败伪装成 done、且与 magpie 的北京日调度错位。**本地节流文件一律不移植** |
| ② 双层 JSON | `parse()` 改双层兼容；新增 `readKv()` 读裸值；SELECT 扩到三键（含 `installation_uuid`） | **采纳** | `installation_uuid` 是裸字符串，双层 parse 后仍是 string ⇒ 必须与「取对象」的 parse 分开；不加第三键则 uuid 永远取不到 |
| ③ refresh 归因 | body 补 `firstKeyfrom/latestKeyfrom/uuid?/userId?/version`；**保留 `auth.source==="desktop"` 早退** | **采纳 + 扩展** | 仓库内有直接佐证：参考插件自己的 `/api/auth/exchange` 已带 `firstKeyfrom/latestKeyfrom`，同一上游接受该形状。**但决策 D6 的服务器副本路径必须允许刷新+回写** ⇒ 早退条件改为「本机桌面端库路径才早退」，副本路径走刷新 |
| ④ 版本动态读 | 新建 `lib/version.mjs`；懒求值+缓存；**分段读文件**（勿整读 669MB）；插件签名改 `async ({client}) => ...` 以用 `client.app.log` | **采纳** | 整读 669MB 在 magpie 宿主（同进程跑网关）里是明显内存尖峰，mrv 独立进程没暴露此问题。插件签名必须改，否则拿不到 client.app.log 打 WARN |
| ⑤ sqlite 回写 | 参数化 `{path, writable}`；**写路径与读路径物理分离**；本机桌面端库绝不写；自建副本表须带 `updated_at INTEGER NOT NULL` | **采纳** | 写坏运行中的桌面端库 = 用户会话损坏。副本路径可写是 D6「一劳永逸」的关键 |
| ⑥ 模型目录 | 云端为主 + openclaw.json 兜底；形状转 OpenCode Model（复用 `lib/models.mjs` 的 runtimeModel/configModel）；**静态兜底表取并集**（mrv 7 个 ∪ 参考插件 5 个，必须含 `kimi-k3`） | **采纳** | 两套兜底不一致会让模型列表忽多忽少；`kimi-k3` 不在云端 29 个目录里但实际可用，不并集就选不到 |

### 8.4 S2 标出的其他高价值修正（移植时必须遵守）

1. **R1 签到节流语义**（高）：不移植本地节流文件；靠上游 `claimedToday` 幂等 + magpie 调度。
2. **R2 北京日 vs UTC 日**（高）：任何日期判断一律用北京日。
3. **R3 多账号 uid 缺失**（中）：节流键用 `auth.accountId ?? auth.uid`，不得回落 `'unknown'`。
4. **R4 captcha 分支**（中）：上游回验证码特征 ⇒ outcome `captcha`，不得当 failed 反复重试。
5. **R6 streak 回填**（中）：用 `ctx.state.claimedDays` 填 streak。
6. **§6 R1 注释与代码不一致**（中）：mrv 注释说「name 缺失即整表放弃」，代码实际只过滤 id ⇒ **以代码为准**，并在测试中固定该语义。
7. **§2 R2 裸值守卫**（中）：`installation_uuid` 是字符串，不能被「typeof === object」守卫丢弃。
8. **§5 R4 双写不一致**（中）：magpie 权威是 `client.auth.set`；sqlite 回写仅作副本保鲜的**可选同步** ⇒ 二者都做，magpie 侧为主。
9. **§3 R3 桌面端早退**（高）：必须保留「不抢桌面端会话」的早退，**仅对服务器副本路径放开**。

### 8.5 移植顺序（依赖图，来自 S2 §8，已复核）

1. §2 双层 parse（无依赖，先修，否则桌面导入路径直接坏）
2. §4 版本动态化（§3/§1 依赖它）
3. §3 refresh 归因（依赖 §2 的 uuid + §4 的 version）
4. §5 sqlite 回写（依赖 §3；边界最敏感，单独评审）
5. §1 签到（依赖 §2 token、§4 version、账号身份）
6. §6 模型目录（独立，最后做）

### 8.6 导出面纪律（magpie 文档硬要求）

- 入口文件**不得**导出辅助函数（magpie 会把每个导出函数都当插件加载）⇒ 测试所需一律挂 `export const _internal = {...}`
- 插件函数签名必须改 `async ({ client }) => ({...})` 以取得 `client.app.log` / `client.auth.set`


---

## 九、S3 服务器约束核实结论（2026-10-27，主代理亲自复核）

### 9.1 已实证的四条硬事实

| 事实 | 证据 | 实施影响 |
|---|---|---|
| **folder plugin 就地加载，spec 即路径** | 宿主源码 `host-*.js` L1143 `no such plugin: <target>`；L1239 `fn(input, p.options)`；文档「文件夹就地加载，不安装任何东西」 | **必须先把文件传到服务器**（Windows 路径在 Linux 上 statSync 必失败）。传文件夹即可，无需 npm install（依赖为空） |
| **`magpie plugin login <provider> <下标>` 零交互可行** | 宿主 L2060 `authOf(provider).methods[method]`；L2095 同；L2009 `no sign-in method <index>` | **必须显式传下标** `magpie plugin login lobster 1`，否则 CLI 弹交互选择器（SSH 下会挂住） |
| **sqlite 副本放 `~/.config/LobsterAI/` 零改动可用** | 参考插件 `lib/auth-import.mjs` 的 `dbPath()` 已有 Linux 分支（`XDG_CONFIG_HOME||~/.config` + `LobsterAI/lobsterai.sqlite`） | **无需改代码、无需 options、无需改 unit**。路径可配（options/env）作为增强而非必需 |
| **provider id `lobster` 未被占用** | 服务器 10 个 provider 全部核对，无 lobster/lobsterai/lobster-ai | 无需改名，模型名即 `lobster/<model>` |

### 9.2 服务器环境事实（已脱敏核实）

- magpie **0.1.1734**，二进制 `/home/ubuntu/.local/bin/magpie`，宿主进程名 `magpie-bun`（Bun 1.4.3/1.4.4 缓存在 `~/.cache/magpie/bun/`）
- ⚠️ **非交互 SSH 的 PATH 不含 `~/.local/bin`** ⇒ 所有远程命令必须 `export PATH=$PATH:/home/ubuntu/.local/bin` 或用绝对路径
- systemd unit 无 `User=`（user unit ⇒ ubuntu）、无 `WorkingDirectory=`（⇒ 默认 $HOME）、无 `EnvironmentFile=`
- `plugin-auth.json` 现有 **10 个账号全部 `type:"oauth"`**，字段集 `type/refresh/access/expires/accountId/uid` + 各家自有字段；**`zcode` 的 `expires:0` 证明 0 合法**
- `settings.json` 的 `pluginCheckins` 映射（key = provider id）为签到开关，**无 CLI 等价物**
- `plugin-checkin.json` 落盘结构：key = `"<provider>|<accountId>"`，字段 `day/at/outcome/credit/streak/msg/claimed`
- 签到由网关进程自跑：**每 30 分钟**扫一遍，对「开关开 + 已登录」的每个账号调一次 `auth.checkin`
- 插件加载失败诊断：`magpie plugin list --json` 的 `loaded[].error` 字段 + journalctl 里的 `plugin: …` 前缀日志（宿主把插件 stdout/stderr 全转 stderr）
- 宿主源码可读：`~/.cache/magpie/plugin-host/host-*.js`（可直接 grep 定位逻辑）

### 9.3 🔴 关键设计裁决：续期路线选 B（推翻 D6 的实现方式，保留 D6 的目标）

S3 提出两条路线，主代理裁决如下：

| 路线 | 描述 | 裁决 |
|---|---|---|
| **A**（原 D6 实现方式） | 落盘 desktop 型（access/refresh 空、expires 0），插件内 401→refresh→回写副本，magpie 永不续期 | ❌ **不采用** |
| **B**（S3 建议） | 登录时在服务器端用副本的 refreshToken 换真 token，落盘成**普通 oauth 账号**（access/refresh/expires 齐全），续期交给 magpie 的 `auth.refresh` 钩子 | ✅ **采用** |

**采用 B 的理由（事实依据）**：
1. magpie 原生支持 `auth.refresh` + `refreshLead`（服务器 v0.1.1734 ≥ 0.1.684 支持该钩子）⇒ 插件无需自己实现单飞刷新与并发去重（magpie 文档明文「同一时间只续一次」）
2. 落盘结构与服务器现有 10 个账号**完全一致**（都是 `type:"oauth"`）⇒ 符合服务器既有生态，`magpie plugin`/quota/checkin 等一切机制直接适用
3. magpie 负责续期时机（到期前 refreshLead）与失败标记（`signIn:"expired"`）⇒ 不必在插件里重造
4. 插件侧只剩「读副本的 refreshToken 换新 token」这一件事，逻辑面收窄、风险面收敛

**B 路线下仍需保留 A 的回写能力（合并执行）**：
- magpie 的 `auth.refresh` 拿到新 token 后，**同步回写 sqlite 副本**（让副本保鲜，保留「桌面端/其他工具仍能读该副本」的兼容性与可恢复性）
- 写回必须：双层 stringify + `updated_at` 自适应 + **写路径与读路径物理分离**（本机桌面端库绝不写，只写服务器副本）+ 失败不影响主流程（回写失败仍让 magpie 用新 token 继续）
- `auth.refresh` 仍需从副本读 `installation_uuid`（归因字段）与 `auth_user.id`（userId）⇒ **副本的 SELECT 必须覆盖三键**（`auth_tokens`/`auth_user`/`installation_uuid`）

**登录 method 的最终形态**（3 个 method，下标固定）：
| 下标 | label | 场景 | 交互 |
|---|---|---|---|
| 0 | 浏览器登录（有道账号） | 本机场景 | 需浏览器 |
| 1 | 从本机 LobsterAI 导入登录（只读） | 本机 magpie 场景，**不写桌面端库** | 零交互 |
| 2 | **从服务器 LobsterAI 副本导入（换 token）** | **服务器场景，走 B 路线** | 零交互 |

⇒ 服务器上执行 `magpie plugin login lobster 2`。

### 9.4 🔴 拷贝 sqlite 副本的硬性注意事项

1. **必须连 `-wal` 与 `-shm` 一起拷**（本机实测同目录存在这两个文件）—— 桌面端运行时最新事务在 WAL 里，只拷主库会丢最新 token
2. **最佳做法：先关掉本机 LobsterAI 桌面端再拷**（一次性人工操作），可得到一致快照
3. 拷到服务器 `/home/ubuntu/.config/LobsterAI/`，并 `chmod 600`（含凭据）
4. 副本**仅服务器可写**（回写路径），本机桌面端库**绝不写**

### 9.5 部署路径（Wave 4 执行，全部有回滚）

| # | 步骤 | 命令 | 人工 |
|---|---|---|---|
| 1 | 传插件目录 | `tar -C "D:/projects/magpie/plugins" -czf - lobster | ssh ubuntu@43.131.227.120 "mkdir -p /home/ubuntu/magpie-plugins && tar -xzf - -C /home/ubuntu/magpie-plugins"` | 自动 |
| 2 | 传 sqlite 副本 | 先关本机桌面端 → 拷 `lobsterai.sqlite` + `-wal` + `-shm` → `~/.config/LobsterAI/` + `chmod 600` | **需一次人工关桌面端** |
| 3 | 注册 folder 插件 | `magpie plugin add /home/ubuntu/magpie-plugins/lobster` | 自动（会重启宿主） |
| 4 | 校验加载 | `magpie plugin`（应见 `lobster (LobsterAI, N models)`）；`magpie plugin list --json` 查 `loaded[].error` | 自动 |
| 5 | 零交互登录 | `magpie plugin login lobster 2` | 自动（**必须带下标**） |
| 6 | 核对落盘 | `jq '.lobster' ~/.config/magpie/plugin-auth.json`（脱敏核对 type/expires/accountId/uid） | 自动 |
| 7 | 功能验证 | `magpie provider test lobster`；`magpie models \\| grep lobster`；curl 网关做非流式/档位差分/kimi-k3 工具调用三条断言 | 自动 |
| 8 | 开启签到 | `settings.json` 的 `pluginCheckins` 加 `"lobster": true`（无 CLI，或用网页 :3430） | 需写文件/网页 |
| 9 | 诊断 | `journalctl --user -u magpie -f \\| grep -E "plugin|error"`；`magpie plugin list --json` | 自动 |

**回滚**：`magpie plugin rm lobster`（folder 插件删目录即卸载）；部署前备份 `~/.config/magpie/plugin-auth.json` 与 `settings.json`。



