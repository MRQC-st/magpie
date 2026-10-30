# 部署手册 — LobsterAI 插件上服务器

> **本文是什么**：lobster 插件上服务器的**可重放步骤** —— 前置事实、执行序列、排查与回滚。
> **本文不负责**：决策理由（→ `10`）、验收结论（→ `12`）、宿主机制通则（→ `18`）。
>
> 状态：**已执行**（2026-10-27 执行完毕，执行证据与结论见 `12-LobsterAI插件验收报告.md`）。
> 步骤原文保留，作为「下次重装照着做」的依据。
> 服务器：ubuntu@43.131.227.120 · magpie 0.1.1734 · 网关 3425 / 网页 3430 · 配置目录 ~/.config/magpie/

## 索引

| 节 | 内容 |
|---|---|
| 0 | 前置事实（已实证，直接采信） |
| 1 | 执行序列 |
| 2 | 出问题时的排查 |
| 3 | 回滚 |


## 0. 前置事实（已实证，直接采信）

| 事实 | 值 |
|---|---|
| 非交互 SSH 的 PATH 不含 magpie | 远程命令须 `export PATH=$PATH:/home/ubuntu/.local/bin` 或用绝对路径 `/home/ubuntu/.local/bin/magpie` |
| folder plugin 行为 | **就地加载，不复制**；plugins.json 的 spec = 文件夹路径本身；删除该目录即卸载 |
| 插件宿主 | Bun（`magpie-bun` 子进程），插件可 import `node:sqlite` |
| provider id `lobster` | 未被占用（服务器现有 10 个 provider 无冲突） |
| `magpie provider test` | **只接受一个 `<id>` 参数**（不接 provider/model 形式）；会真发请求（已用 trae-cn 试跑验证） |
| 签到开关 | `~/.config/magpie/settings.json` 的 `pluginCheckins["lobster"]=true`（**无 CLI**，或用网页 :3430） |
| 日志落点 | journald（无独立 .log）：`journalctl --user -u magpie -f \\| grep -E "plugin|error"` |
| 插件加载失败诊断 | `magpie plugin list --json` 的 `loaded[].error` 字段 |
| 凭据副本位置 | `/home/ubuntu/.config/LobsterAI/lobsterai.sqlite`（参考插件 dbPath() 的 Linux 默认分支，零改动即可读） |
| 回滚保险 | `~/magpie-backups/20261027-204732/`（plugin-auth.json / settings.json / plugins.json 三份已备份） |

## 1. 执行序列

### 1.1 传插件目录（自动）
```sh
tar -C "D:/projects/magpie/plugins" -czf - lobster | ssh ubuntu@43.131.227.120 "mkdir -p /home/ubuntu/magpie-plugins && tar -xzf - -C /home/ubuntu/magpie-plugins"
```
> 建议上传前剔除 `lobster/.git`、`lobster/test`、`lobster/docs`（减少体积；测试只在本地跑）。

### 1.2 传凭据副本（自动；本机桌面端当前未运行且 WAL 为 0 字节 ⇒ 无需人工关闭）
```sh
ssh ubuntu@43.131.227.120 "mkdir -p ~/.config/LobsterAI"
scp "D:/projects/magpie/.secrets-staging/lobsterai.sqlite" ubuntu@43.131.227.120:/home/ubuntu/.config/LobsterAI/
ssh ubuntu@43.131.227.120 "chmod 600 ~/.config/LobsterAI/lobsterai.sqlite"
```
> ⚠️ 副本含真实凭据：上传后 `chmod 600`；**Wave 4 结束后清理本地暂存区** `.secrets-staging/`。
> ⚠️ 落盘形态为 B 路线（普通 oauth 账号），token 由服务器侧换得；副本仅供 plugin 读 refreshToken/uuid 并在刷新后回写保鲜。

### 1.3 注册插件（自动）
```sh
ssh ubuntu@43.131.227.120 'export PATH=$PATH:/home/ubuntu/.local/bin && magpie plugin add /home/ubuntu/magpie-plugins/lobster'
```

### 1.4 校验加载（自动）
```sh
magpie plugin | grep -A2 lobster
magpie plugin list --json | jq '.loaded[] | select(.spec | test("lobster"))'
```
判定：`lobster (LobsterAI, N models)` 出现，且 JSON 里**无 error 字段**。

### 1.5 零交互登录（自动；**必须带 method 下标**）
```sh
magpie plugin login lobster 2
```
> 下标：0=浏览器登录（服务器结构性不可用，callback 绑 127.0.0.1 随机端口）／1=本机导入（桌面端只读）／**2=服务器副本导入（换真 token，本期主用）**
> 不传下标会弹交互选择器 ⇒ SSH 下会挂住。

### 1.6 核对落盘（自动，脱敏）
```sh
jq '.lobster | {type, expires, accountId, uid, has_access: (.access|length>0), has_refresh: (.refresh|length>0)}' ~/.config/magpie/plugin-auth.json
```
判定：`type=="oauth"`、`has_access==true`、`has_refresh==true`、`expires>0`（未来时间戳）。

### 1.7 功能验证（自动）
```sh
magpie provider test lobster          # 冒烟（会真发请求）
magpie models | grep lobster          # 模型目录里应见 lobster/<model>
magpie quota lobster                  # 用量卡片
```

### 1.8 三条精确断言（curl 网关，自动）
```sh
KEY=<gateway key>
# 断言 A：非流式调用方拿到完整 chat.completion JSON（证明强制 SSE 合并生效）
curl -s -o /tmp/ds.json -w '%{http_code} %{content_type}\n' https://magpie.sunfolower.cn/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"lobster/deepseek-flash","stream":false,"messages":[{"role":"user","content":"reply with the single word: ok"}]}'
# 断言 B：思考档位差分（none 的 reasoning_content 长度应为 0）
# 断言 C：kimi-k3 出字 + 工具调用
```
> 断言 A 的关键判据：`content_type` 是 `application/json`（**不是** event-stream）且 `choices[0].message.content` 非空。
> 断言 B：同请求 `reasoning_effort` 取 none 与 high，none 的 `reasoning_content` 长度恰为 0。
> 断言 C：`lobster/kimi-k3` 带 `tools` 的请求返回 `choices[0].message.tool_calls[0].function.name` 有值、`finish_reason=="tool_calls"`。
> ⚠️ `kimi-k3` 不在云端 29 个目录里但实际可用 ⇒ 依赖静态兜底表并集（含 kimi-k3）。

### 1.9 开启签到（需写 settings.json 或网页）
`settings.json` 的 `pluginCheckins` 加 `"lobster": true`。签到由网关每 30 分钟自跑，结果落 `plugin-checkin.json`（key=`lobster|<accountId>`）。
> 检查：`journalctl --user -u magpie --since "1 hour ago" | grep -i "lobster"`

## 2. 出问题时的排查

```sh
magpie plugin list --json | jq '.loaded[] | select(.spec|test("lobster")).error'
journalctl --user -u magpie --since "10 min ago" | grep -E "plugin|lobster|error|fail"
grep -n "lobster" ~/.config/magpie/plugin-auth.json | head
```
宿主源码可读：`~/.cache/magpie/plugin-host/host-*.js`

## 3. 回滚

```sh
magpie plugin rm lobster                       # 移除注册
rm -rf /home/ubuntu/magpie-plugins/lobster     # folder 插件删目录即卸载
cp ~/magpie-backups/20261027-204732/plugin-auth.json.bak ~/.config/magpie/plugin-auth.json
cp ~/magpie-backups/20261027-204732/settings.json.bak ~/.config/magpie/settings.json
cp ~/magpie-backups/20261027-204732/plugins.json.bak ~/.config/magpie/plugins.json
rm -rf ~/.config/LobsterAI                     # 凭据副本
```
