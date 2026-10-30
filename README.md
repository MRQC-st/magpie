# magpie

magpie 网关的部署文档与插件仓库。magpie 是**模型网关**：所有 agent（本机 Claude Code / 服务器上的 OpenCode、Hermes 等 / 其他设备）通过同一个网关走 provider，网页只用于管理。

- 服务器：腾讯云 `ubuntu@43.131.227.120`（Ubuntu 22.04，systemd 用户服务）
- 公网入口：`https://magpie.sunfolower.cn`（网关 `/v1/`、网页 `/`）
- 本机回环：网关 `127.0.0.1:3425`、网页 `127.0.0.1:3430`

## 目录

| 路径 | 内容 |
|---|---|
| `docs/` | 部署文档（00–03）、插件文档（10–16：迁移 / 第三方插件 / u1s12api / MonkeyCode 双通道与签到）、变更日志（99）、调研归档（research/） |
| `plugins/` | magpie 插件（folder plugin，`magpie plugin add <path>` 就地加载） |
| `scripts/` | 运维脚本（Cloudflare 域名配置、凭据导入与自动同步、签到等） |

## 插件

每个插件是一个文件夹，入口导出 async 函数，遵循 [magpie 插件规范](https://usemagpie.ai/docs/zh/plugins)（magpie 跑的是 OpenCode v1 插件）。插件被 magpie 加载进同一个 Bun 进程。

### lobster — LobsterAI（网易有道）

由 `model-reverse`（自有逆向网关）的逆向成果转制，是「逆向项目 → magpie 插件」替代路径的**第一个试点**。

- 上游：`https://lobsterai-server.youdao.com`（OpenAI 协议，**强制 SSE**）
- 模型：约 30 个（DeepSeek / GLM / Kimi / Qwen / MiniMax / Doubao），目录带上游真名
- 三个登录方式：浏览器登录 / 本机桌面端导入（只读）/ 服务器凭据副本导入（零交互，自动续期）

部署与验证见 `docs/11-LobsterAI部署手册.md`，验收证据见 `docs/12-LobsterAI插件验收报告.md`。

### u1s12api — u1s1（u1s1app.com）

用户自带的本地插件（zip 交付），把 u1s1 账号接进 magpie。**模型调用靠 spawn 本机 u1s1 CLI**（CLI 自己签名，
免费额度只认官方客户端），所以服务器上还额外装了 `u1s1-cli` 并通过 systemd drop-in 给插件指路。

- 站点：`u1s1app.com`（CN）/ `u1s1.dev`（Intl）；模型 3 个（deepseek-flash / qwen3.8-flash / glm-5.3-flash）
- 登录：浏览器设备流；打卡：网站会话 cookie（需本机生成后搬过去）

部署记录见 `docs/15-u1s12api插件部署记录.md`。

### 第三方社区插件（装在服务器上，不在本仓库托管代码）

| spec | 包 | provider |
|---|---|---|
| `github:MYCF711/magpie-magicrew-auth` | `Magicrew` 0.3.63 | `magicrew`（超级麦吉）/ `magicrew-intl`（MagiCrew） |
| `github:orangercat/magpie-genspark` | `opencode-genspark-app-auth` 0.2.0 | `genspark-llm-proxy` / `genspark-gemini-proxy` |

这两个插件的凭据都不存进 `plugin-auth.json`，而是每次请求读**服务器上的本机文件**。
本机桌面端凭据的导入方式见 `docs/14-第三方插件接入记录.md` 与 `scripts/import-provider-creds.ps1`。

### MonkeyCode — 本仓库托管的 fork（`plugins/monkeycode/`）

社区插件 `opencode-monkeycode-auth` 0.1.1 有三处硬伤：**不区分国内版/国际版**、
**`single: true` 让多账号互相覆盖**、**没有 `auth.refresh`（7 天后凭据静默失效）**。
本仓库的 fork 全部修掉，服务器上装的是本地路径：

```sh
magpie plugin add /home/ubuntu/magpie-plugins/monkeycode
```

| | 社区插件 0.1.1 | 本仓库 fork |
|---|---|---|
| 版本 | 只有一个 `monkeycode` | **两个供应商**：`monkeycode`（国内版）/ `monkeycode-intl`（国际版），各占一行、互不干扰 |
| 多账号 | `single: true` ⇒ 覆盖第一个 | 不设 `single` ⇒ magpie 开 `monkeycode#xxxxxx` 槽位，**并存** |
| 续期 | 无 `auth.refresh` | **服务器端自主续期**（会话有效就自己铸新 key；过期用口令重登 / 百智云 OAuth 桥） |
| 签到 | 只签 B 通道 | A 通道（百智云每日临时额度）**也签** |

⇒ **不再需要本机电脑开机、不需要桌面端客户端**：magpie 到期前 24h 自己调 `auth.refresh`。
口令存在服务器上 `~/.config/magpie/monkeycode-credentials.json`（600），**不进 `plugin-auth.json`**。
完整说明与实测见 `docs/16-MonkeyCode双通道与签到.md`。

### baizhi — MonkeyCode 的第二条通道（custom vendor，非插件）

逆向项目里 MonkeyCode 有两个通道：插件实现 B（`proxy.monkeycode-ai.com` 订阅网关），
A（`ai-models.app.baizhi.cloud` 百智云 SK）用 magpie 的自定义厂商直接挂上：

```sh
magpie provider add baizhi url=…/api/anthropic anthropic=…/api/anthropic responses=…/api/openai/v1 key=$SK models.url=…/v1/models
```

目录 46 个模型全暴露。**A 的余额来自百智云钱包的「每日临时额度」，不充值、每天领一次积分就有**
（插件的 `auth.checkin` 两条通道都领，magpie 的 30 分钟插件签到 tick 覆盖；
另有 `scripts/baizhi-checkin.py` 独立定时器兜底）。双通道与签到的完整说明见
`docs/16-MonkeyCode双通道与签到.md`。

### 凭据自动续期

| 位置 | 单元 | 作用 |
|---|---|---|
| 服务器 | MonkeyCode 插件的 `auth.refresh` | **B 通道**：magpie 到期前 24h 自动续（会话有效就自己铸新 key，过期就用口令重登） |
| 服务器 | `magpie-baizhi-checkin.timer`（每日 08:20） | 跑 `scripts/baizhi-checkin.py`：领 A 通道的每日临时额度 |
| 本机 | Windows 计划任务 `magpie-sync-monkeycode`（每日 08:05） | 旧链路：客户端续期 → 同步 cookie 文件 → 服务器重登插件。**服务器已自主，可退役** |

## 常用命令（服务器上）

```sh
export PATH=$PATH:/home/ubuntu/.local/bin
magpie daemon status | restart
magpie plugin list                # 已装插件与 provider 登录状态
magpie plugin add <path>          # 装一个 folder plugin（就地加载）
magpie plugin login <provider> <n>  # 登录；<n> 是**第 n 个**登录方式（1-based）
magpie provider test <provider>   # 冒烟：真发一次请求
magpie models | grep <provider>   # 该 provider 的模型目录
magpie quota <provider>           # 用量与额度
journalctl --user -u magpie -f    # 日志（插件日志以 plugin: 前缀出现）
```

## 本地开发

插件代码在 `plugins/<name>/`，改完重新部署即可（folder plugin 就地加载，重启宿主后生效）：

```sh
cd plugins/lobster
node --test --test-force-exit "test/**/*.test.mjs"   # node 侧
bun test ./test/                                      # bun 侧（线上运行时）
```

测试用 `test/harness.mjs` 做双端适配：bun 下用 `bun:test`、node 下用 `node:test`，同一批用例两边都能跑。
