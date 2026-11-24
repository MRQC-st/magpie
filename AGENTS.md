# AGENTS.md · magpie

> **活总入口（状态结论层）**。冷启动先读这里 → 再读 `docs/00-项目总览.md`（结构层）→ 再读任务相关的
> 主题文档（`docs/10`～`docs/19`）。时间线与证据在 `docs/99-变更日志.md`。
> **本页不负责**：结构与分工表（在 `00`）、协议与实测（在主题文档）。

## 当前状态（网关与 Genspark 于 2026-11-24 复核；其余沿用 2026-11-19 快照）

- **网关在线**：magpie **0.1.4749**（2026-11-24 实测版本），systemd 用户服务；公网 `https://magpie.sunfolower.cn`；
  网关 `:3425` / 网页 `:3430`。
- **provider 覆盖面**：已登录 zcode(3) · lobster(7) · monkeycode 国内版(14) · baizhi(46，A 通道) ·
  u1s12api(3) · magicrew(16)/magicrew-intl(27) · genspark LLM/Gemini（同一 Free 账号，API 仍不可用；
  2026-11-24 上游目录 49/11） · **genspark-web(2，网页积分通道，自定义厂商)** · qoder(17)/qoder-cn(4) ·
  trae-cn(90)/trae-global(3) · minimax(4/2) · raccoon(10) · codearts(9) · autoclaw-cn(4) ·
  devin(1) · copilot(23) · aihubmix · **agentrouter(3，responses API)**。
- **Genspark 14.4 已查清（2026-11-24 晚用浏览器登录态补核）**：它不是每日赠送的残余，也不是本轮
  调用的扣费，而是 **2026-09-27 系统赠送的 20 点 `agent_reward`（有效期至 2026-12-27）用剩的余量**；
  9 笔充值里 8 笔「每日赠送」都是 `is_depleted=false`（从未消耗）。**终身额度没有耗尽** —— 11-24 15:47
  又到账 100，余额 114（账本 remaining=114，consumed 为空）。但 **API 门槛是套餐级不是余额级**：余额
  114 时回环网关实测仍返回 Free 提示、tokens 0 ⇒ 只有付费套餐或买 credit pack 才可能恢复推理。
  插件 `auth.checkin` 只查 `/api/tool_cli/me` 并返回 `inactive`，不会领奖。
  **补测（`14` §9.6）**：网页端发一句话余额 114→111（扣 3.4），证明积分在产品内能花；但 `/api/llm_proxy/v1`
  只认 api key（cookie 走法 401）。
  详见 `14` §九、`DEC-MAG-022`。
- **Genspark 网页积分通道已跑通（2026-11-24 夜，`14` §9.7）**：`genspark-web` 自定义厂商 →
  本机桥 `127.0.0.1:8420`（`scripts/genspark-web-bridge.py`，systemd 用户服务）→ 网页智能体接口
  `POST /api/agent/ask_proxy` → 花网页积分。关键更正：**CF 挡的是 TLS 指纹不是 IP** —— curl/.NET/node
  全 403，`curl_cffi impersonate=chrome` 在服务器上直接 200（换 mihomo 出口无效）。请求体靠「页面内
  挂 fetch 钩子」抓到，`g_recaptcha_token` 实测可不传。已实测：`provider test` ✓ 6096ms、网关直调返回正文、
  余额 114→86。**模型不可选**（传 gpt-4.1/gemini-3-pro 都落 `glm-5p3-flash-baseten`），每次约 2～3 积分、
  ~57k prompt tokens，属智能体套壳。cookie 过期就重跑 `scripts/genspark-web-cookie.ps1`。
- **AgentRouter 走 relay**：`agentrouter` 自定义厂商 → 本机 relay `127.0.0.1:8399`
  （补 Codex 指纹头 + 经 mihomo 出网，绕阿里云 WAF）→ `agentrouter.org`；模型列表
  `models.url` 动态拉取，`refresh-every 1d`。详见 `19`。
- **AgentRouter 出口已固定**：mihomo 独立 `select` 组 `AgentRouter` → `日本-HY2-47`（出口
  `163.227.161.157`，实测 10/10 稳定）；**决策不建 fallback**，失效时人工秒级切换。
  另有 `127.0.0.0/8` / `::1` 回环 DIRECT 规则（客户端带 `HTTP_PROXY` 时访问本机 3425 才不会被转出成 502），详见 `19` §九。
- **MonkeyCode 已脱离本机电脑**：服务器端 `auth.refresh` 自主续期；A/B 两条通道各自签到。
- **`magpie-zcode-switch-auth` 已换源为本地路径插件**（`~/magpie-plugins/magpie-zcode-switch-auth/`，0.2.2）：
  上游 `github:Arimayuki03/...` 的仓库、账号与同名 npm 包在 2026-11-19 全部 404，更新报 `bun update ... 404`；
  改本地路径后 `plugin update` 恢复 exit 0。它被 `prefer.zcode`（社区 `opencode-zcode-auth`）遮蔽，只保留导入入口。详见 `20`。
- ⚠️ **`lobster` 只剩 7 个模型**（`12` 验收时是 30 个）—— 上游目录/权限变化，待核。
- ⚠️ `monkeycode-intl`（国际版）未登录；`monkeycode` 是 basic 档 ⇒ 14 个模型（不是 bug）。

## 待办看板（**只维护这一份**）

| # | 事项 | 谁做 | 状态 | 出处 |
|---|---|---|---|---|
| 1 | 核 `lobster` 模型数 30 → 7 的原因（上游目录 / 账号权限 / 插件降级）——**大概率是账号封号连带（2026-11-15 事故，见待办 9）** | 我 | ⏳ | 本页「当前状态」 |
| 2 | 登录 MonkeyCode 国际版账号 —— 该站**没有注册 API**，先在浏览器 `monkeycode-ai.net/login` 注册/登录，再 `magpie plugin login monkeycode-intl 4` 粘控制台会话 Cookie | 用户 | ⏳ | `17` §六 |
| 3 | ~~`baizhi_session` 重抓~~ ✅ 2026-11-15/16 闭环：本机重抓 + scp 到服务器 + 触发签到验证 `[already] 已领（100 积分）`。⚠️ 注意多账号隔离已修复（DEC-MAG-019 ④），百智会话按槽存 `metadata.bz_cookie`；下次到期（约 2026-12-15）用户浏览器重登 baizhi.cloud 后重新扫码或 `--add` 即可 | 用户（到期时浏览器重登） | ✅ 2026-11-16 | `16` §四 |
| 4 | 退役旧的本机同步链路：`scripts/sync-monkeycode-creds.ps1` + Windows 计划任务 `magpie-sync-monkeycode` + 服务器 `magpie-monkeycode-refresh.timer` | 用户确认后我执行 | ⏳ | `16` §六、`17` §七 |
| 5 | B 通道 pro/ultra 档（需订阅升级） | 用户 | ⏳ | `17` §五 |
| 6 | 考虑给 B 挂 A 回落（`magpie provider fallback`） | 待定 | ⏳ | `16` §七 |
| 7 | 文档体检：`python <skill>/references/scripts/docs_health.py D:\projects\magpie` → 0 问题 | 我 | ✅ 本轮已跑 | `00` §文档治理约定 |
| 8 | AgentRouter 的 WAF / 出口节点 / 模型目录会变：变化时按 `19` §二 重跑三组对照；切换判定信号见 `19` §9.8 | 我 | ⏳ | `19` §八、§9.8 |
| 9 | **LobsterAI 已封号（2026-11-15，用户发现）**——服务器版封号根因审计见 model-reverse `docs/field-journal/2026-11-15_lobsterai-server-ban-forensics.md`：数据中心 IP 为主因（无代码解）+ 两处代码差异（签到 `platform=linux` 矛盾、缺 `X-LobsterAI-Client-*` 两头）+ 30min tick 频率放大。**待执行**：① `lib/checkin.mjs` call() 补两身份头 ② `PLATFORM` 改可注入默认 win32 ③ lobster 签到降频（非当日幂等早退）④ 账号处置待用户（解封/换号）；用户已拍板「先别管 lobster」，服务器侧维持现状 | 我（代码）/ 用户（账号） | ⏸️ 用户叫停 | model-reverse field-journal 2026-11-15 |
| 10 | monkeycode 插件签到积分显示 + 微信扫码四连修（uuid 错位根治/TLS/导入/类型）——✅ **全部部署并闭环**（2026-11-16 用户自助扫码登录成功，新槽 `#7c6js2` 当日 claimed +100 钱包差额积分显示正常）。⚠️ 长期纪律：服务器插件有未入库改动 ⇒ **改 monkeycode 必须先拉服务器快照**（`plugins/monkeycode-server-snapshot/`），且部署前 `node --check` + 真链路冒烟（DEC-MAG-019 教训） | 我 | ✅ 2026-11-16 | `plugins/monkeycode-server-snapshot/`、99 §DEC-MAG-019 |
| 11 | **`magpie-zcode-switch-auth` 上游消失**：GitHub 账号 `Arimayuki03` 与同名 npm 包均 404，已换成本地路径插件（0.2.2）⇒ 现无自动更新来源。源码副本已纳入本仓库 `plugins/magpie-zcode-switch-auth/`；要么**上游恢复/迁移后改回 `github:`/`npm:` spec**，要么**用这份副本自建仓库发布** | 用户（决定是否自建）/ 我（改回 spec） | ⏳ | `20` §四、§五 |
| 12 | Genspark 14.4 的账号级来源 —— ✅ **已查清（2026-11-24 晚）**：9-27 的 20 点 `agent_reward`（到期 2026-12-27）用剩约 14；每日赠送按笔 24 小时独立过期、8/9 未消耗；终身额度未耗尽，11-24 又到账 100 ⇒ 余额 114。**API 那条线仍不可用且与余额无关**：余额 114 时实测依旧 Free 提示、tokens 0 ⇒ 需付费套餐或 credit pack（用户决定，我不代付）。**但网页积分通道已另开成功**（`genspark-web`，2026-11-24 夜，见 `14` §9.7）：不花付费套餐也能用积分，代价是只能当匿名智能体用。遗留可选：`genspark` 的 49/11 个模型对 agent 可见但必失败，是否对 agent 隐藏待定 | 我（已闭环）/ 用户（付费决定） | ✅ 2026-11-24（付费项待用户） | `14` §九、`DEC-MAG-022`、`DEC-MAG-023` |
| 13 | **`genspark-web` 的 cookie 会过期**：过期信号是桥 `/health` 的 `balance_probe_status` 变 401/403 或调用报「网页会话失效」，处置是重跑 `scripts/genspark-web-cookie.ps1`（浏览器还登录着就行）。另：桥不承诺模型名（平台固定路由），若用户要求「必须是指定模型」则不适用本通道 | 用户（到期重跑脚本）/ 我（改脚本） | ⏳ 待首次过期 | `14` §9.7.7、§9.7.8 |

## 文档索引

| 我要查 | 去哪 |
|---|---|
| 入口 / 架构 / 命令 / 分工表 | `docs/00-项目总览.md` |
| 首次部署过程与实测证据 | `docs/01-部署与验证记录.md` |
| 域名、nginx、DNS 的本项目实例 | `docs/02-域名与回源.md` |
| 部署阶段的误判与更正 | `docs/03-踩坑与更正.md` |
| 「逆向成果 → magpie 插件」的决策与移植清单 | `docs/10-LobsterAI插件迁移决策记录.md` |
| lobster 部署步骤 / 验收证据 | `docs/11-LobsterAI部署手册.md` / `docs/12-LobsterAI插件验收报告.md` |
| zcode 多账号导入 | `docs/13-ZCode账号导入magpie记录.md` |
| 社区插件安装与凭据导入；Genspark 额度、每日 100 规则、可用性复核与 `genspark-web` 网页积分桥（§9.7） | `docs/14-第三方插件接入记录.md` |
| u1s12api 插件 | `docs/15-u1s12api插件部署记录.md` |
| MonkeyCode 两条通道与各自签到 | `docs/16-MonkeyCode双通道与签到.md` |
| MonkeyCode 插件 fork、自主续期、多账号 | `docs/17-MonkeyCode插件接入与自主续期.md` |
| **所有插件共用的宿主机制** | `docs/18-magpie插件宿主契约.md` |
| AgentRouter 接入 / 指纹头 / 模型刷新 / 固定出口 / 回滚 | `docs/19-AgentRouter接入与模型刷新.md` |
| **zcode-switch-auth 插件来源 / 换源 / 回滚** | `docs/20-zcode-switch-auth插件接入与换源.md` |
| 时间线与证据（append-only） | `docs/99-变更日志.md` |

## 关联项目（主题级指针）

> ⚠️ **仓库拓扑（2026-11-15 勘误）**：`origin`（`MRQC-st/magpie`）是 **yetone/magpie 官方仓（36k 星）的 fork**，
> 其 `main` = 上游源码（与本项目文档**无共同祖先**）。本仓的文档/插件提交**不可 push 到 origin/main**；
> 已推为独立分支 **`origin/workstation-docs`**（本仓 main 的完整镜像，2026-11-15 起）。上游更新用
> `git fetch origin` 取 tags/源码做版本对照，**绝不 merge/rebase 上游 main 进本仓 main**。

| 项目 | 主题 | 关系 | 本项目对应 |
|---|---|---|---|
| `D:\projects\model-reverse` | MonkeyCode 协议与计费 | **SSOT 在对方**（协议/端点/模型档位/单位换算）；本项目只写 magpie 侧接入 | `16` §一、`17` §五 |
| `D:\projects\model-reverse` | ↩ **回流**（本项目 → 对方） | A 通道签到 + Cap PoW 事实已写回对方 `docs/topics/monkeycode.md` §1.4（对方原无此记录）；对方已加 magpie 下游行 | `16` §3.1、`16` §3.2 |
| `D:\projects\model-reverse` | LobsterAI 逆向成果 | 能力供给方 → 转制成本仓库 `plugins/lobster/` | `10`～`12` |
| `D:\projects\docs` | CF 托管 HTTPS + 源站 HTTP 回源 | **方法 SSOT 在对方**；本项目只留实例 | `02` |
| `D:\projects\relay-checkin` | baizhi 站 adapter / Cap PoW | 同源实现，可互抄 | `16` §3.1、`scripts/baizhi-checkin.py` |
| `D:\projects\magpie-upstream-lobster.git` | lobster 上游历史 | 仓库外 git，仅对照用 | `docs/_archive/2026-lobster-merge/` |

## 铁律

1. **凭据只输出状态与业务码**，绝不打印 cookie / key / 口令的值；核对文件时只报布尔值与字段名。
2. **口令放服务器 `~/.config/magpie/`（600）**，**不进 `plugin-auth.json`**（网页界面读得到那个文件）。
3. **插件不得写本机桌面客户端的配置 / cookie / 库**，只写服务器侧副本。
4. **一个事实只在一处维护**：结论写主题文档，`99` 只做证据时间线，「当前状态」只写本页。
5. **跨文档引用用文件名或 `DEC-*` 编号**，不写 `文件:行号`。
6. **「能用」以正文为准**：`provider test` 只看状态码，须复验正文（见 `18` §八）。
7. 改插件后 `magpie daemon restart` 才生效（folder plugin 就地加载）。
8. 非交互 SSH 里 magpie 不在 PATH：**先 `export PATH=$PATH:/home/ubuntu/.local/bin`**。

## 维护规则

- **结论变了**（翻案 / 重大更新）→ 当次会话改**所有**载体：状态层（本页）先改，`99` 补一条
  保留翻案痕迹（不静默改写历史条目），兄弟项目同步；并写清「为什么会误判」。
- **新插件接入** → 在 `docs/` 新建一份主题文档（编号接在现有主题号之后），
  在 `00` 的分工表登记，宿主通用机制写进 `18` 而不是各写一遍。
- **`99` 新增条目** → 日期 + 一行结论 + `DEC-*` 编号 + 指向主题文档；
  索引与覆盖标记同步更新，然后跑 `scripts/check-changelog-index.py`。
- **文档体检** → `python <knowledge-wiki skill>/references/scripts/docs_health.py D:\projects\magpie`
  必须 **0 问题**（不是「剩下的都是误报」）。
