# 18 · magpie 插件宿主契约

> **本文是什么**：magpie 插件宿主（OpenCode v1 插件协议）里**所有插件都会撞到**的那几条机制：
> 插件导出规范、登录方式编号、oauth 记录形状、`auth.refresh` 触发条件、账号槽位分配、
> 凭据过期表现、签到 tick、以及判定「插件是否真的可用」的正确口径。
> **本文不负责**：单个插件的业务协议与上游端点（MonkeyCode → `16`/`17`，LobsterAI → `10`～`12`，
> u1s12api → `15`）、第三方插件的安装记录（→ `14`）、网关部署（→ `00`/`01`）。

## 索引

| 节 | 内容 |
|---|---|
| 一 | 插件导出规范：一个包 = 几个供应商 |
| 二 | 登录方式编号是 1-based |
| 三 | oauth 记录的字段形状（key 在 `refresh`，密钥在 `access`） |
| 四 | `auth.refresh` 的触发条件 |
| 五 | 账号槽位：`single` 与并存 |
| 六 | 凭据过期 = 静默丢弃，不是报错 |
| 七 | 插件签到：开关、频率、结果落盘 |
| 八 | 判定「真的能用」的口径（`provider test` 会骗人） |
| 九 | 凭据安全纪律 |
| 十 | 诊断命令速查 |

## 一、插件导出规范：一个包 = 几个供应商

宿主用 `servers(mod)` 加载插件：**模块导出的每个函数都会被当成一个插件加载**。

- 只有**插件函数**与 `_internal` 允许被导出；导出其它东西宿主会报错。
- ⇒ 想在一个包里同时提供「国内版 / 国际版」两个供应商，就**导出两个函数**。
  实例：`plugins/monkeycode/index.mjs` 导出 `monkeycode`（国内版）与 `monkeycode-intl`（国际版），
  两者各自独立取凭据，互不覆盖。
- ⇒ 反过来，一个包只能导出一个插件时，就只能靠 env 覆盖来切换版本 —— 这正是社区插件
  `opencode-monkeycode-auth` 的硬伤（见 `17`）。

## 二、登录方式编号是 1-based

```
magpie plugin login <provider> <n>     # <n> = 第 n 个登录方式，1 = 第一个
```

`plugin login monkeycode 3` 指的是**第三个**登录方式，不是第四个，也不是从 0 开始。
写脚本时不要按 0-based 数组去拼这个参数。

## 三、oauth 记录的字段形状

magpie 的 oauth 类型记录（`plugin-auth.json`）里：

| 字段 | 装什么 |
|---|---|
| `type` | `"oauth"`（宿主据此决定要不要走 `auth.refresh`） |
| `key` | 多数插件自己写的 key |
| **`refresh`** | **oauth 账号的 API key 也可能存在这里** |
| **`access`** | **签名密钥 / 刷新令牌存这里** |
| `expires` | 到期时间戳；`0` 表示「永不续期」 |

🔴 **插件侧读凭据必须同时兼容 `auth.key` 与 `auth.refresh`**（密钥同理兼容
`metadata.secret` / `md.signingSecret` / `auth.access`）。

只读 `auth.key` 时，oauth 账号拿到的 key 是**空串** ⇒ loader 提前 `return {}`
⇒ 请求里既没有 baseURL 也没有 apiKey ⇒ **宿主不报错、不打日志**，只有真打一次请求才看得出来。
这是本项目在 `17` 里修掉的第 3 个 bug，也是「装上了但用不了」类问题的头号根因。

## 四、`auth.refresh` 的触发条件

宿主只在**同时**满足下面两条时才调用插件的 `auth.refresh`：

1. 该账号记录的 `type === "oauth"`；
2. 该记录的 `expires > 0`。

⇒ **插件不导出 `auth.refresh` ⇒ 凭据就是 `plugin login` 那一刻的快照**，
到期后静默失效（请求开始 401，但宿主不会替你去续）。
⇒ `expires` 写 0 等于主动放弃自动续期。

## 五、账号槽位：`single` 与并存

| 插件声明 | 宿主行为 | 后果 |
|---|---|---|
| `single: true` | 签入结果**永远写进第一个账号槽位** | 第二次登录**覆盖**第一个账号 ⇒ 多账号互相顶替 |
| 不设 `single` | 宿主自己开 `<provider>#xxxxxx` 槽位 | **多账号并存**，互不干扰 |

槽位 id 是宿主生成的（`monkeycode#co5ov5` 这类），插件拿不到也控制不了。
所以「支持多账号」这件事**只能靠不设 `single` 来实现**，插件侧无别的开关。

排查时看 `magpie plugin list`：出现 `<provider>#xxxxxx` 说明走的是并存路径。

## 六、凭据过期 = 静默丢弃，不是报错

插件读取本机 cookie / 客户端配置时按 `expires` 判活，**过期就静默丢弃**。
表象是「未保存控制台 Cookie」「查不到积分」，而不是一条明确错误。

⇒ 遇到「说没登录/说没 cookie」时，**先查凭据的到期时间**，别急着重登；
重登也解决不了「文件早就过期」这件事。

## 七、插件签到：开关、频率、结果落盘

| 项 | 位置 |
|---|---|
| 开关 | `settings.json` 的 `pluginCheckins.<provider> = true` |
| 频率 | 宿主自带 tick，**每 30 分钟**一次 |
| 结果 | 落 `plugin-checkin.json`（键形如 `lobster|lobster` → `{outcome:"done", streak:21}`） |
| 语义 | `outcome:"done"` 表示**今天已经领过**，不谎报 `claimed` |

⇒ 插件自己的 `auth.checkin` 被勾上就自动跑，不需要额外 systemd 定时器；
定时器只用于**插件之外**的签到（例如百智云 A 通道 → `scripts/baizhi-checkin.py`）。

## 八、判定「真的能用」的口径（`provider test` 会骗人）

`magpie provider test <provider>` **只看 HTTP 状态码**，会给出两种假信号：

| 假信号 | 真相 | 正确判据 |
|---|---|---|
| genspark 报 ✓，但正文是「免费额度不能用于 API / LLM 代理」 | HTTP 200 ≠ 业务可用 | **看正文**：让模型回一个固定字符串（如 `PONG`） |
| gemini 类 provider 报「拒绝向 XX 以外的地址发送凭据」 | 探针打的是 Google Code Assist 端点，与插件的凭据域限制冲突 | **不是凭据问题**，换直连端点复验 |

⇒ 验收判据统一为：**经网关打一次真实推理，正文符合预期**。只报状态码的结论不算结论。

## 九、凭据安全纪律

- **口令 / 刷新令牌放 `~/.config/magpie/<name>-credentials.json`（权限 600）**，
  **不要写进 `plugin-auth.json`** —— 那个文件 magpie 的网页界面读得到。
- 核对凭据时**只输出布尔值与字段名**，不打印值；也不要把值粘进日志、截图、文档。
- 插件**不得写本机桌面客户端自己的配置 / cookie / 数据库**（只写服务器侧副本）。
- 凭据一律走 `ssh` 的 stdin 或用户侧脚本搬运，不落在命令行参数里。

## 十、诊断命令速查

```sh
export PATH=$PATH:/home/ubuntu/.local/bin
magpie plugin list                  # 判据在这条：已装插件 + provider + 登录态（provider 未登录时这里仍可见）
magpie plugin login <provider> <n>  # <n> 1-based
magpie plugin logout <provider>     # 清掉该 provider 的账号槽位
magpie plugin options <provider>    # 插件选项（如 serverCopyDb）
magpie provider test <provider>     # 只看状态码，须配合正文复核
magpie models | grep <provider>
magpie quota <provider>
journalctl --user -u magpie -f      # 插件日志带 plugin: 前缀
```

> `magpie providers` **不列未登录的 provider** ⇒ 装完插件在 providers 里找不到 ≠ 装失败，
> 判据是 `magpie plugin list`。

## 相关

- `17-MonkeyCode插件接入与自主续期.md` —— 本契约在真实插件上的完整应用（含四个已修 bug）。
- `14-第三方插件接入记录.md` —— 社区插件的安装与凭据导入实测。
- `10-LobsterAI插件迁移决策记录.md` —— 第一个走完整套契约的插件。
