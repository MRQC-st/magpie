# magpie-lobster-auth

为 [magpie](https://usemagpie.ai) 提供 provider `lobster`：登录
[LobsterAI](https://lobsterai.youdao.com)（有道龙虾，网易有道的桌面 agent）
账号，把它名下的模型接进来。约 30 个模型，含 DeepSeek、GLM、Kimi、Qwen、
MiniMax、豆包。

[English](README.md) · **中文**

## 合并来源

这是**两个来源的合并版**，两边的署名都保留：

- **[Jasery/opencode-lobster-auth](https://github.com/Jasery/opencode-lobster-auth)**
  —— 原始的 magpie provider 插件（MIT，© 2026 Jasery）。钩子结构、SSE 处理、
  思考档位翻译、Kimi K3 契约、登录方式，以及你正在读的这篇 README 都源于此。
  `LICENSE` 原样保留，未作改动。
- **`D:/projects/model-reverse/handlers/lobsterai.mjs` 里的逆向实现** —— 从桌面端
  自己的源码复原、并在服务端实测确认的六项能力：动态客户端版本号、
  `installation_uuid` 归因字段、双层 JSON 凭据格式、服务器端零交互登录、
  `openclaw` 模型目录、每日签到。

合并相对原插件新增的能力：

| 能力 | 作用 |
| --- | --- |
| 动态客户端版本号 | 标识头里的版本跟着已安装的桌面端走（从它的 `app.asar` 里读），而不是写死一个会腐化的字符串。 |
| 续期归因字段 | `/api/auth/refresh` 现在会带上 `uuid`、`userId`、`version`，与客户端自己发的一致。 |
| 服务器端零交互登录 | 第三种登录方式：从服务器上的凭据副本登录，不开浏览器、不用打字。 |
| 自动续签回写 | 续期得到的新 token 会写回服务器副本，长跑的部署因此不会悄悄过期。 |
| 模型三级降级 | 云端目录 → 客户端的 `openclaw` 目录 → 静态兜底表。 |
| 每日签到 | magpie 的 `auth.checkin` 钩子负责领每日积分。 |
| 双运行时可加载 | 用 `node:sqlite` 代替 `bun:sqlite`，Node 与 Bun 两端都能加载。 |

## 安装

这是一个文件夹插件，没有发布到 npm：

```sh
magpie plugin add /path/to/magpie-lobster
magpie plugin login lobster
```

## 登录

三种方式，顺序如下。三者都用有道账号标识（`yid`）给账号命名，所以对一个
已经登录过的账号换一种方式登录，是原地替换。

0. **浏览器登录（有道账号）。** 插件在本机 `127.0.0.1` 起一个回调服务，
   magpie 打开有道登录页。浏览器带着授权码跳回来，插件拿它在
   `/api/auth/exchange` 换取 token。存成一个 `oauth` 账号，带 access 与
   refresh token 及到期时间，因此 magpie 会为它续期。
1. **从桌面端导入。** 使用 LobsterAI 桌面端当前登录的账号。**不打开任何页面，
   不需要输入任何东西。** 只读桌面端的 SQLite 库，绝不写入：
   - Windows：`%APPDATA%\LobsterAI\lobsterai.sqlite`
   - macOS：`~/Library/Application Support/LobsterAI/lobsterai.sqlite`
   - Linux：`~/.config/LobsterAI/lobsterai.sqlite`

   库不存在，或者被桌面端加密存放，这条路会带着说明失败，改用浏览器登录即可。
2. **从服务器凭据副本导入。** 给没有桌面端的部署用：把 `LOBSTER_SERVER_COPY_DB`
   指向那份库的一个副本。插件读出副本里的 `refreshToken`，去
   `/api/auth/refresh` 换一对新 token —— 同样不开浏览器、不用打字。
   结果是一个正常的 `oauth` 账号，因此 magpie 会为它续期，并把续期得到的新
   token 写回副本。

三种方式都保存在 magpie 的 `plugin-auth.json`。

### 为什么从桌面端导入不保存 token

导入方式**一个字节的凭据都不存**（`access` 和 `refresh` 都是空串，`expires`
为 0），只在每次请求时现读桌面端的库：

- 抄一份 `refreshToken` 会与桌面端共用同一个凭据：**谁先续期谁就把对方踢
  下线**。留空则双方互不干扰。
- `expires` 为 0，magpie 因此永不续期（它只对设了到期时间的 `oauth` 账号做
  续期），桌面端的会话不会被搅动。
- 现读意味着桌面端续期之后，插件下一次请求自动用上新 token，不必重新登录。

代价是：桌面端退出登录、卸载，或者库变得不可读，这个账号会**立刻**失效，
并被标记为需要重新登录。这比用一个已经悄悄失效的旧 token 更诚实。

### 写入，以及允许写在哪里

插件的写路径与读路径是物理分开的：

- **桌面端的库绝不写入。** 它可能正在运行，写进去可能破坏桌面端的会话。
  读连接以 `readOnly` 打开。
- **服务器副本**只在它确实是服务器副本时才写 —— 桌面端数据目录是按**路径**
  拒绝的，不是靠约定 —— 而且只写 `auth_tokens` 这一行。写入用客户端自己的
  双层 JSON 格式，并按表结构自适应（表里有 `updated_at` 列就填，没有就省掉）。

### 续期

浏览器登录与服务器副本登录都由 magpie 通过插件的 `auth.refresh` 在到期前 6
小时续期。续期请求带上客户端自己会带的归因字段 —— `firstKeyfrom`、
`latestKeyfrom`、`uuid`（安装 id）、`userId`、`version`。
桌面端导入的账号如上所述，结构性不会被续期。

## 请求

对话走 `https://lobsterai-server.youdao.com/api/proxy/v1` 的 chat
completions。LobsterAI 有三个习惯被处理掉了：

- **所有回复都是 SSE**，即使请求里写了 `stream: false`。非流式调用方会拿到
  由它重组出的一个完整 `chat.completion`；流式调用方拿到的就是原样的事件。
- **错误藏在 200 里。** LobsterAI 把错误放进流里（`event: error`），状态码
  仍是 200 —— 这样调用方没有可故障切换的依据。插件读首条记录，还原成它真正
  表示的状态：`40100` → 401，`40300` → 403，`42900` 或限流措辞 → 429，其余
  → 400。被 LobsterAI 拒绝的登录是真 401，原样透传并带上 magpie 的失效标记，
  账号因此会被标出来。
- **请求带上桌面端的标识头**（`X-LobsterAI-Client-Version`、
  `X-LobsterAI-Client-Capabilities`）。LobsterAI 不强制要求，但它们标明了
  插件所说的特性集。版本号从已安装的客户端读，因此不会过期。

### 思考档位

模型的 `thinkingConfig` 决定它有哪些档位 —— 当前目录里是 `off`、`high`、
`max` —— 它们通过 LobsterAI 自己的字段上线：
`{"lobsterai_options":{"version":1,"thinking":{"level":"off"}}}`。

有两件事值得知道：

- **`lobsterai_options` 只发给自带档位表的模型。** 29 个模型里有 21 个没有
  档位表，给这些模型带上该字段是硬错误（`code 4000`，*model does not have a
  valid thinkingConfig*），整轮对话直接失败。只有在有档位表可映射时，档位才会
  被传下去。
- **最低档对外叫 `none`，不叫 `off`。** magpie 不使用 variant 里存的东西，它
  按自己的一条阶梯（`none/minimal/low/medium/high/xhigh/max`）把
  `reasoning_effort` 映射到「模型声明过的那个档位名」。`off` 不在那条阶梯上，
  所以声明成 `off` 的那一档永远选不中。插件对外声明 `none`，写给 LobsterAI
  时再换回 `off`。

在 `deepseek-flash` 上实测：`none` 会让 `reasoning_content` 恰好为 0 字节，
而 `high`、`max` 和不指定档位都不会。

### Kimi K3

LobsterAI 的 `kimi-k3` 采样参数由服务端固定，因此 `temperature`、`top_p`、
`n` 和两个 penalty 会被删掉，`reasoning_effort` 固定为 `max`，缺少
`reasoning_content` 的 assistant 工具调用会被补一个空串。

`kimi-k3` 属于 LobsterAI「能用但没列出」的模型：`/api/models/available`
返回 29 个模型，其中没有 K3，但对 `kimi-k3` 发请求能正常作答。它保留在
本插件为未登录账号声明的兜底表里，所以 `lobster/kimi-k3` 是可选的 ——
上面那段处理也因此是**实际生效的**，不是预防性代码。

## 模型

登录后，列表来自账号自己（`/api/models/available`）：29 个模型，各带上下文
窗口、是否收图片、以及它的思考档位。云端目录拿不到时，退到桌面端本地维护的
目录（`%APPDATA%/LobsterAI/openclaw/state/openclaw.json`），再退到 8 个模型的
静态表 —— provider 始终可见，不会是空的。

`costMultiplier` 成为 magpie 的 `rate`。它是**分时计价**：`deepseek-flash`
在 LobsterAI 的空闲时段是 0.05，高峰时段是 0.1（高峰为北京时间
09:00–12:00 与 14:00–18:00）。倍率是在拉列表时读的，所以可能有一阵子是过时
的。

## 用量

`magpie quota` 显示免费额度、它的到期时间和剩余点数，数据来自
`/api/user/quota` 与 `/api/user/profile-summary`。插件上报的是 `kept`：它自己
不续期，因此不该声称做过一次它没做的续期。

## 每日签到

插件实现了 magpie 的 `auth.checkin` 钩子，用桌面端自己的 `client-activities`
流程去领 LobsterAI 的每日积分。只有在服务端**确实发分**时才报 `claimed` ——
200 但没发分说明今天已经领过了，不是成功。

## 配置

所有出站地址都可改指向，这也是插件能离线测试的前提：

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `LOBSTER_API_BASE` | 所有请求的 API 根 | `https://lobsterai-server.youdao.com/api` |
| `LOBSTER_SERVER_COPY_DB` | 服务器上的凭据副本 | 未设置 —— 不配就没有服务器登录 |
| `LOBSTER_OPENCLAW_PATH` | 客户端本地的模型目录 | `%APPDATA%/LobsterAI/openclaw/state/openclaw.json` |
| `LOBSTER_ASAR_PATH` | 客户端的 `app.asar`（用于取版本） | 自动探测 |
| `LOBSTER_CLIENT_VERSION` | 固定客户端版本 | 从客户端读取 |
| `LOBSTER_LOGIN_URL` | 登录页 | 门户默认 |

同样的值也可以写在 magpie 的 `plugins.json` 的 `options` 字段里。

## 不做的事

- **企业账号。** LobsterAI 让它们走另一个页面（`EnterpriseIdentitySelect`）。
  目前只处理个人账号。
- **精确的输出上限。** 目录里没有这个字段。插件声明了保守的 32,000；实测
  LobsterAI 接受 262,144，在 524,288 时返回 500，所以真实上限在两者之间。
- **OpenCode。** 这个插件是按 OpenCode 的 provider 插件格式写的 —— magpie
  加载的正是这个格式 —— 但只在 magpie 上实测过。`auth.refresh`、
  `auth.refreshLead`、`auth.checkin` 以及 `package.json` 里的 `magpie` 字段是
  magpie 自己的，OpenCode 会忽略它们。
- **同时使用多个账号。** magpie 每个 provider 只保留一份登录。

## 开发

```sh
bun test                # 参考运行时
node --test --test-force-exit "test/**/*.test.mjs"
```

入口只负责装配钩子。逻辑都在 `lib/` 下，是普通函数，通过 `_internal` 暴露
出来 —— 因为 magpie 和 OpenCode 都会把每一个导出的函数当成一个独立插件。

## 许可

MIT —— 见 [LICENSE](LICENSE)。© 2026 Jasery 与本合并版的贡献者。
