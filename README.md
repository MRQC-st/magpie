# magpie

magpie 网关的部署文档与插件仓库。magpie 是**模型网关**：所有 agent（本机 Claude Code / 服务器上的 OpenCode、Hermes 等 / 其他设备）通过同一个网关走 provider，网页只用于管理。

- 服务器：腾讯云 `ubuntu@43.131.227.120`（Ubuntu 22.04，systemd 用户服务）
- 公网入口：`https://magpie.sunfolower.cn`（网关 `/v1/`、网页 `/`）
- 本机回环：网关 `127.0.0.1:3425`、网页 `127.0.0.1:3430`

## 目录

| 路径 | 内容 |
|---|---|
| `docs/` | 部署文档（00–03）、插件迁移文档（10–12）、变更日志（99）、调研归档（research/） |
| `plugins/` | magpie 插件（folder plugin，`magpie plugin add <path>` 就地加载） |
| `scripts/` | 运维脚本（Cloudflare 域名配置等） |

## 插件

每个插件是一个文件夹，入口导出 async 函数，遵循 [magpie 插件规范](https://usemagpie.ai/docs/zh/plugins)（magpie 跑的是 OpenCode v1 插件）。插件被 magpie 加载进同一个 Bun 进程。

### lobster — LobsterAI（网易有道）

由 `model-reverse`（自有逆向网关）的逆向成果转制，是「逆向项目 → magpie 插件」替代路径的**第一个试点**。

- 上游：`https://lobsterai-server.youdao.com`（OpenAI 协议，**强制 SSE**）
- 模型：约 30 个（DeepSeek / GLM / Kimi / Qwen / MiniMax / Doubao），目录带上游真名
- 三个登录方式：浏览器登录 / 本机桌面端导入（只读）/ 服务器凭据副本导入（零交互，自动续期）

部署与验证见 `docs/11-LobsterAI部署手册.md`，验收证据见 `docs/12-LobsterAI插件验收报告.md`。

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
