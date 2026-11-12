# 验收报告 — LobsterAI → magpie 插件迁移（试点第一例）

> **本文是什么**：lobster 插件的**验收证据** —— 结论、代码侧验收、6 项回填能力验收、服务器侧实测、
> 修复的缺陷、纠正的自身误判、遗留与建议。
> **本文不负责**：决策理由（→ `10`）、部署步骤（→ `11`）、宿主机制通则（→ `18`）。
>
> 验收时间：2026-10-27 · 验收人：主代理（独立复核，非子代理自述）
> 对象：D:\projects\magpie\plugins\lobster（合并版 magpie 插件）
> 服务器：ubuntu@43.131.227.120 · magpie 0.1.1734 · 网关 3425 / 网页 3430

## 索引

| 节 | 内容 |
|---|---|
| 一 | 结论 |
| 二 | 代码侧验收（主代理亲自执行） |
| 三 | 6 项回填能力验收 |
| 四 | 服务器侧实测证据 |
| 五 | 过程中发现并修复的缺陷 |
| 六 | 过程中纠正的自身误判 |
| 七 | 遗留与建议 |
| 八 | 回滚 |


## 一、结论

**通过。** 合并版插件已部署到腾讯云服务器并真实跑通：登录、模型目录、非流式 SSE 合并、思考档位、kimi-k3 工具调用、每日签到、自动续期全部实测有据。

## 二、代码侧验收（主代理亲自执行）

| 项 | 命令 | 结果 |
|---|---|---|
| node 侧测试 | `node --test --test-force-exit "test/**/*.test.mjs"` | ✅ 103 pass / 0 fail / exit 0 |
| bun 侧测试 | `bun test ./test/` | ✅ 103 pass / 0 fail / exit 0（15 files） |
| 入口导出面 | `import('./index.mjs')` | ✅ 仅 `LobsterAuthPlugin` + `_internal`，函数导出数 = 1 |
| bun:sqlite 残留 | grep | ✅ 仅注释提及，无实际 import |
| 写死 2026.9.x | grep | ✅ 仅注释说明，无代码常量 |
| 真实凭据泄漏 | grep JWT | ✅ 无 |
| 禁区改动 | mtime 核对 | ✅ model-reverse 与 magpie/docs 未动 |
| **SQL 转义往返** | 自建探针（node+bun） | ✅ 单引号/反斜杠/换行/U+2028 全部正确往返；裸值键正常；无 EBUSY |

## 三、6 项回填能力验收

| 能力 | 实现 | 验证 |
|---|---|---|
| 每日签到 | `lib/checkin.mjs` → `auth.checkin` | ✅ 真实调用返回 `{outcome:"done", streak:21}`（已领不谎报 claimed，判据正确） |
| 双层 JSON 兼容 | `lib/sqlite-kv.mjs` normalizeValue | ✅ 单层/双层/裸字符串三态均正确（T9/T14/T25） |
| refresh 归因字段 | `lib/session.mjs` refreshBody | ✅ 实测 body = `[refreshToken, firstKeyfrom, latestKeyfrom, uuid, userId, version]` |
| 客户端版本动态读 | `lib/version.mjs` | ✅ 实测 version=**2026.10.16**（真值，非写死）；分段读 669MB asar |
| sqlite 回写副本 | `lib/sqlite-kv.mjs` writeKvObject | ✅ updated_at 自适应 + 双层 stringify；桌面端路径一律拒绝 |
| 模型目录三级降级 | `lib/managed-models.mjs` | ✅ 27 条模型、显示上游真名（deepseek-flash→DeepSeek-V4.1-Flash）；降级带 `magpie.fellBack` 标记 |

## 四、服务器侧实测证据

| 环节 | 命令 | 结果 |
|---|---|---|
| 插件注册 | `magpie plugin add /home/ubuntu/magpie-plugins/lobster` | ✅ `✓ added`；spec = 文件夹路径（就地加载） |
| 插件加载 | `magpie plugin list --json` | ✅ `lobster (LobsterAI, 30 models) signed in`；loaded=11；无 error |
| **零交互登录** | `magpie plugin login lobster 3` | ✅ `✓ signed in to LobsterAI`（全��自动，无浏览器无 stdin） |
| 落盘形态 | `plugin-auth.json` | ✅ `type=oauth, source=server-copy, access_len=290, refresh_len=230, expires=2026-11-26` ⇒ 普通 oauth 账号，**magpie 接管续期** |
| 模型目录 | `magpie models \\| grep lobster` | ✅ 27 条 + 上游真名 + 档位 `none/high/max` |
| 冒烟 | `magpie provider test lobster` | ✅ `✓ chat 780 ms · deepseek-flash` |
| 用量 | `magpie quota lobster` | ✅ `免费额度 0/300 免费积分 · 1821.08 点数 left` |
| 签到 | 直接调 `auth.checkin` | ✅ `{outcome:"done", streak:21}` |
| 续期 | 直接调 `auth.refresh` | ✅ 换到新 token，expires 2026-11-26；body 含 userId=94951 / uuid / version=2026.10.16 |

### 三条关键断言（真实推理）

| 断言 | 结果 |
|---|---|
| **A 非流式调用方拿到完整 JSON**（证明强制 SSE 合并生效） | ✅ HTTP 200 · `content_type: application/json`（**非** event-stream）· `object=chat.completion` · content=`ok` · usage 完整 |
| **B 思考档位差分** | ✅ `none`→reasoning_len=**0**（正确关思考）· `high`→reasoning_len=**140` |
| **C kimi-k3 原生工具调用** | ✅ `finish=tool_calls` · `tool_calls[0].function.name=get_weather` · arguments 正确 |

## 五、过程中发现并修复的缺陷

| # | 缺陷 | 严重级 | 处置 |
|---|---|---|---|
| D1 | `bun:sqlite` 顶层 import ⇒ node 下整个插件不可加载 | blocker | 改 `node:sqlite`（node v24 + bun 1.4.2 双端通吃） |
| D2 | `parse()` 只 parse 一次 ⇒ 双层存储下**桌面导入路径上线即坏** | blocker | 改双层兼容 + 另设裸值读取器 + SELECT 扩到三键 |
| D3 | 客户端版本写死 2026.9.23（真值 2026.10.16） | major | 动态读 asar（分段读，不整读 669MB）+ 回退打 warn |
| D4 | refresh 请求缺归因字段 | major | 补 firstKeyfrom/latestKeyfrom/uuid/userId/version |
| D5 | 签到本地节流文件会把失败伪装成 done（且 UTC 日与北京日错位） | major | 不移植节流文件，靠上游 claimedToday 幂等 + magpie 调度 |
| D6 | Bun 的 node:sqlite 用 prepare() 泄漏 Windows 文件句柄（EBUSY） | major | 改走 exec() + db.function() 回调取行 |
| D7 | 回环服务关闭顺序错误 ⇒ Windows libuv 断言 abort | minor | closeAllConnections() + connection:close |
| D8 | **auth_user 字段名是 userId 而非 id** ⇒ userId 归因永远取不到 | minor | 新增 userIdOf() 双键名兼容（连带修 localAttribution 同根因） |
| D9 | 静态兜底表两套不一致 ⇒ 模型列表忽多忽少 | minor | 取并集（8 个，必含 kimi-k3） |
| D10 | **服务器副本被误判为桌面端库 ⇒ 永远无法回写**（Linux 上 `dbPath()` 与副本路径重合） | **major** | 显式声明优先 + 平台判据；Windows 桌面端库仍拒写 |

## 六、过程中纠正的自身误判

1. **「Bun 无 node:sqlite」** —— 实测 Bun 1.4.2 完全可用，推翻了子代理的断言 ⇒ 采纳 node:sqlite，避免双驱动适配层
2. **「代理污染是横切高风险」** —— 实测本机与服务器均无代理变量 ⇒ 不需要防御性代码
3. **「magpie plugin login 的 method 是 0-based 下标」** —— 实测为 **1-based**（1=浏览器/2=桌面导入/**3=服务器副本**）
4. **测试 4 条失败的归因** —— 是测试把 fetch 传给了 `input` 而非 `options`（实现的注入点在第二个参数），非实现缺陷

## 七、遗留与建议

### 7.1 遗留项已全部闭环（2026-10-27 23:42 复验）

| 原遗留项 | 复验结果 |
|---|---|
| 签到尚无 magpie 侧记录 | ✅ **已记录**：`plugin-checkin.json` 里 `lobster|lobster` → `{day:"2026-10-27", outcome:"done", streak:21, msg:"今天已经领过了"}`。magpie 侧调度 → 插件 `auth.checkin` → outcome 映射 → streak 回填 → 落盘，全链路打通 |
| 回写副本未在生产验证 | ✅ **已验证**（并因此发现并修掉 D10 缺陷）：修复后实测 `COPY_ACCESS_CHANGED=true`、`COPY_ACCESS_EQ_RETURNED=true`、`COPY_REFRESH_EQ_RETURNED=true`、`COPY_MTIME_CHANGED=true`、`COPY_IS_DOUBLE_STRINGIFIED=true` ⇒ 副本 token 已刷新到 **exp 2026-11-26（剩余 30 天）** |

### 7.2 新发现并修复的缺陷 D10

**服务器副本被误判为桌面端库 ⇒ 永远无法回写**（主代理在服务器实测中抓出，非子代理自述）：

```
dbPath(env)         = /home/ubuntu/.config/LobsterAI/lobsterai.sqlite
serverCopyPath(env) = /home/ubuntu/.config/LobsterAI/lobsterai.sqlite   ← 同一路径
isDesktopPath(copy) = true                                              ← 误判 ⇒ 拒写
```
根因：`isDesktopPath()` 用 `desktopPathCandidates(env)` 判定，而 `dbPath()` 在 **Linux 上返回的正是 `~/.config/LobsterAI/`** —— 与服务器副本路径完全重合。
修复（判据「显式声明优先 + 平台判据」）：
1. `serverCopyPath(env)` 显式声明的路径**永远可写**（运维显式指定的可写副本）
2. 其余路径才比桌面端候选集：win32 桌面端客户端真实存在 ⇒ 一律禁写（**安全边界未放宽**）；darwin/linux 上未被显式声明时才当桌面端
3. 路径归一新增 `.`/`..` 折叠与大小写区分（Linux 路径区分大小写）
修复前后四情形对比：Windows 桌面端库 `true→true`（仍拒写）／Linux+serverCopyDb `true→false`★／显式声明优先 `true→false`／未声明 `true→true`（行为不变）

### 7.3 建议

- **后续应用迁移**：本试点建立的 6 项能力、三条断言、回写判据可直接复用到其余 14 个适配器（zen/autoclaw/workbuddy/teleagent/copilot/monkeycode/evox/qoder/trae/kilo/phanthy/verdent/genspark）
- **回滚保险已在位**：`~/magpie-backups/20261027-204732/`（三份配置）；回滚命令见第八节
- **仓库已初始化 git**（原建议项，2026-10-28 完成）：`D:\projects\magpie` 现在是 git 仓库（branch `main`），
  插件目录去掉嵌套 `.git` 后作为普通文件纳管，上游历史保留在仓库外 `D:\projects\magpie-upstream-lobster.git`（**该镜像已于 2026-11-12 移除**，重建命令见 `00-项目总览.md` §外部依赖）。
  > **为什么会误判**：验收当时（2026-10-27 23:42）仓库确实还没建 git，该建议是对**当时事实**的记录；
  > 两天后完成初始化，但这条建议留在「遗留与建议」里没销账 ⇒ 读的人会以为仓库仍未纳管。
  > ⇒ 「遗留」条目要么闭环勾掉、要么注明完成日期，不留半开状态。
- **凭据副本已从本机清除**：`.secrets-staging/` 已删除；本机桌面端原库 mtime 仍为 10-25（**插件的桌面端只读纪律生效，未被改动**）

## 八、回滚

```sh
magpie plugin rm lobster
rm -rf /home/ubuntu/magpie-plugins/lobster ~/.config/LobsterAI
cp ~/magpie-backups/20261027-204732/{plugin-auth.json,settings.json,plugins.json}.bak ~/.config/magpie/
```
