# 20 · zcode-switch-auth 插件：来源、上游消失与换源（2026-11-19）

> **本文是什么**：服务器上 `magpie-zcode-switch-auth` 插件的**来源、当前部署形态、上游消失的核验过程与换源终态**（SSOT）。
> **本文不负责**：zcode 账号导入与 JWT 凭据方案（→ `13`）、插件宿主通用机制（→ `18`）、社区插件安装凭证（→ `14`）、magpie 本体部署（→ `01`）。

## 一、这个插件是什么

- 给 magpie / OpenCode 用的 **ZCode（GLM Coding Plan）认证插件**：底座是官方社区插件 `@magpie-community/opencode-zcode-auth`（MIT），登录、模型、额度行为不变，额外增加「导入 Z·SWITCH / zcode-switch 保存的账号」与 `.zsb` 捆绑包导入。
- provider id = `zcode`，与官方社区插件**同 id**。两者同时安装时只有一个在 serve，由 `~/.config/magpie/plugins.json` 的 `prefer.zcode` 决定；另一个以 `servedBy` 状态存在。

## 二、原部署形态（2026-10-30 ～ 2026-11-18）

| 项 | 值 |
|---|---|
| spec | `github:Arimayuki03/magpie-zcode-switch-auth` |
| 安装版本 | `0.2.2`（bun 锁提交 `#5e7d155`） |
| 落盘位置 | `~/.config/magpie/plugins/node_modules/magpie-zcode-switch-auth` |
| serve 状态 | 被 `@magpie-community/opencode-zcode-auth@latest` 以 `servedBy` 遮蔽，只保留登录/导入入口 |

## 三、故障与核验（2026-11-19）

**现象**：`magpie plugin update` 内部执行 `bun update magpie-zcode-switch-auth`，报

```
error: GET https://api.github.com/repos/Arimayuki03/magpie-zcode-switch-auth/tarball/ - 404
```

退出码 1，整条更新中止。

**核验**（本机直连 GitHub API，带对照项）：

| 探测 | 结果 |
|---|---|
| `api.github.com/repos/Arimayuki03/magpie-zcode-switch-auth` | 404 |
| `github.com/Arimayuki03`（HTML） | 404 |
| `api.github.com/users/Arimayuki03` | 404 |
| `api.github.com/repos/yetone/magpie`（对照） | 200 |
| `registry.npmjs.org/magpie-zcode-switch-auth` | 404 |

⇒ **仓库、账号、同名 npm 包全部消失**（不是网络、代理或 bun 参数问题：对照项 200，buster 无 ref 的 tarball 请求只因仓库不存在才 404）。

**影响面**：仅「插件更新」失败；已装的 0.2.2 仍照常加载（`magpie plugin list` 正常）。

## 四、换源（终态）

1. 把已装 0.2.2 原样落到本机插件目录：`~/magpie-plugins/magpie-zcode-switch-auth/`（312K，含 `src/*.mjs`、测试与 README，**无运行时依赖**）；同一副本纳入本仓库 `plugins/magpie-zcode-switch-auth/`（上游已不可取，仓库副本是唯一可追溯源）。
2. `magpie plugin rm magpie-zcode-switch-auth` —— 同时清掉 `plugins.json` 的 github spec 与聚合 `package.json` / `bun.lock` 里的包。
3. `magpie plugin add /home/ubuntu/magpie-plugins/magpie-zcode-switch-auth` —— 按**本地路径插件**接入。
4. `magpie plugin use @magpie-community/opencode-zcode-auth@latest zcode` —— 恢复 `prefer.zcode` 到社区插件（与本插件遮蔽关系对齐，状态与换源前一致）。

**验证**：

- `magpie plugin update` → `✓ plugins updated`（exit 0，无 404 / `exit status 1`）。
- `magpie plugin list`：本地路径插件 `on`，`zcode` 由社区插件 serve。
- `plugins.json` / `package.json` / `bun.lock` 中已不存在任何 `Arimayuki03` 引用（仅剩本轮备份文件）。

## 五、代价与回滚

- **代价**：本地路径插件不参与自动更新。上游已消失，本来也没有可更新的源；上游若恢复或迁移到新地址，把 spec 改回 `github:<owner>/<repo>` 或 `npm:<name>` 即可恢复自动更新。
- **回滚**（换源前状态）：`plugins.json.bak-20261119`、`plugins/package.json.bak-20261119`、`plugins/bun.lock.bak-20261119` 覆盖回原位后 `magpie daemon restart`。另有 `plugin-auth.json.bak-20261119`（移除插件前的账号保险，未被改动）。

## 六、顺带核到的既有事实（非本次改动引入）

- zcode provider 当日仍大量可用：2026-11-19 成功 304 次、405 仅 14 次。
- 405 = 上游 `err_type 3012`「This client is not supported. Please use the official ZCode client.」，即客户端指纹风控（见 `13` §3.2 同类现象）；`magpie provider test zcode` 单次命中 405 **不代表整体不可用**，判定要看 `usage.jsonl` 分布。
