# AGENTS.md · magpie

> **活总入口（状态结论层）**。冷启动先读这里 → 再读 `docs/00-项目总览.md`（结构层）→ 再读任务相关的
> 主题文档（`docs/10`～`docs/19`）。时间线与证据在 `docs/99-变更日志.md`。
> **本页不负责**：结构与分工表（在 `00`）、协议与实测（在主题文档）。

## 当前状态（2026-11-06 实测服务器）

- **网关在线**：magpie **0.1.3105**，systemd 用户服务；公网 `https://magpie.sunfolower.cn`；
  网关 `:3425` / 网页 `:3430`。
- **provider 覆盖面**：已登录 zcode(3) · lobster(7) · monkeycode 国内版(14) · baizhi(46，A 通道) ·
  u1s12api(3) · magicrew(16)/magicrew-intl(27) · genspark(45/8) · qoder(17)/qoder-cn(4) ·
  trae-cn(90)/trae-global(3) · minimax(4/2) · raccoon(10) · codearts(9) · autoclaw-cn(4) ·
  devin(1) · copilot(23) · aihubmix · **agentrouter(3，responses API)**。
- **AgentRouter 走 relay**：`agentrouter` 自定义厂商 → 本机 relay `127.0.0.1:8399`
  （补 Codex 指纹头 + 经 mihomo 出网，绕阿里云 WAF）→ `agentrouter.org`；模型列表
  `models.url` 动态拉取，`refresh-every 1d`。详见 `19`。
- **AgentRouter 出口已固定**：mihomo 独立 `select` 组 `AgentRouter` → `日本-HY2-47`（出口
  `163.227.161.157`，实测 10/10 稳定）；**决策不建 fallback**，失效时人工秒级切换。
  另有 `127.0.0.0/8` / `::1` 回环 DIRECT 规则（客户端带 `HTTP_PROXY` 时访问本机 3425 才不会被转出成 502），详见 `19` §九。
- **MonkeyCode 已脱离本机电脑**：服务器端 `auth.refresh` 自主续期；A/B 两条通道各自签到。
- ⚠️ **`lobster` 只剩 7 个模型**（`12` 验收时是 30 个）—— 上游目录/权限变化，待核。
- ⚠️ `monkeycode-intl`（国际版）未登录；`monkeycode` 是 basic 档 ⇒ 14 个模型（不是 bug）。

## 待办看板（**只维护这一份**）

| # | 事项 | 谁做 | 状态 | 出处 |
|---|---|---|---|---|
| 1 | 核 `lobster` 模型数 30 → 7 的原因（上游目录 / 账号权限 / 插件降级） | 我 | ⏳ | 本页「当前状态」 |
| 2 | 登录 MonkeyCode 国际版账号 —— 该站**没有注册 API**，先在浏览器 `monkeycode-ai.net/login` 注册/登录，再 `magpie plugin login monkeycode-intl 4` 粘控制台会话 Cookie | 用户 | ⏳ | `17` §六 |
| 3 | `baizhi_session`（30 天）到期前重抓 —— **2026-11-06 前** | 用户 | ⏳ | `16` §四 |
| 4 | 退役旧的本机同步链路：`scripts/sync-monkeycode-creds.ps1` + Windows 计划任务 `magpie-sync-monkeycode` + 服务器 `magpie-monkeycode-refresh.timer` | 用户确认后我执行 | ⏳ | `16` §六、`17` §七 |
| 5 | B 通道 pro/ultra 档（需订阅升级） | 用户 | ⏳ | `17` §五 |
| 6 | 考虑给 B 挂 A 回落（`magpie provider fallback`） | 待定 | ⏳ | `16` §七 |
| 7 | 文档体检：`python <skill>/references/scripts/docs_health.py D:\projects\magpie` → 0 问题 | 我 | ✅ 本轮已跑 | `00` §文档治理约定 |
| 8 | AgentRouter 的 WAF / 出口节点 / 模型目录会变：变化时按 `19` §二 重跑三组对照；切换判定信号见 `19` §9.8 | 我 | ⏳ | `19` §八、§9.8 |

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
| 社区插件安装与凭据导入 | `docs/14-第三方插件接入记录.md` |
| u1s12api 插件 | `docs/15-u1s12api插件部署记录.md` |
| MonkeyCode 两条通道与各自签到 | `docs/16-MonkeyCode双通道与签到.md` |
| MonkeyCode 插件 fork、自主续期、多账号 | `docs/17-MonkeyCode插件接入与自主续期.md` |
| **所有插件共用的宿主机制** | `docs/18-magpie插件宿主契约.md` |
| AgentRouter 接入 / 指纹头 / 模型刷新 / 固定出口 / 回滚 | `docs/19-AgentRouter接入与模型刷新.md` |
| 时间线与证据（append-only） | `docs/99-变更日志.md` |

## 关联项目（主题级指针）

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
