# magpie-monkeycode-auth

magpie 的 provider 插件：MonkeyCode（长亭 · ohmyagent）。

在社区插件 [`opencode-monkeycode-auth`](https://github.com/xxhhlk/magpie-monkeycode-plugin)
0.1.1 的基础上改的，四处主要改动：

| | 社区插件 0.1.1 | 本插件 |
|---|---|---|
| 国内版 / 国际版 | 只有一个 `monkeycode`，国际版要靠 env 覆盖 | **两个供应商**：`monkeycode` 与 `monkeycode-intl`，各占一行、各自独立 |
| 多账号 | `single: true` ⇒ 再登录一次就**覆盖**第一个账号 | 不设 `single` ⇒ 第二个账号落到 `monkeycode#xxxxxx`，**并存** |
| 续期 | 没有 `auth.refresh` ⇒ 7 天后凭据静默失效 | **服务器端自主续期**（见下） |
| 签到 | 只签 B 通道（官方云） | **A 通道（百智云每日临时额度）也签** |

## 安装

```bash
magpie plugin add /path/to/monkeycode
```

装完刷新一下 magpie（web 界面或 `magpie` 重启），供应商列表里会出现两行：

```
MonkeyCode 国内版 (25 models)   not signed in · magpie plugin login monkeycode
MonkeyCode 国际版 (25 models)   not signed in · magpie plugin login monkeycode-intl
```

## 登录（三条路）

`magpie plugin login <provider> <method>` 的 method 是 **1-based**。

### 方法 1：读取服务器上的客户端登录态（零交互）

```bash
magpie plugin login monkeycode 1
```

服务器上要有一份 MonkeyCode 客户端的配置（Linux 默认
`~/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json`）。
插件**只读**这份文件，不回写 —— 免得和桌面端抢文件。

### 方法 2：服务器端账密登录（**不需要本机电脑**）

```bash
magpie plugin login monkeycode 2
```

问两个问题：邮箱、口令。插件会：

1. 在控制台上换会话 cookie（PoW 验证码在**该版本自己的主机**上取，国际版同理）；
2. 在控制台上**铸造一把新的 `oma_` key + 签名密钥**（`POST /api/v1/users/ohmyagent/api-keys`）；
3. 把口令存到 `~/.config/magpie/monkeycode-credentials.json`（600 权限）。

口令**不进** `plugin-auth.json` —— 那个文件 magpie 的网页界面读得到。

### 方法 3：手动填写

`oma_` key + `omas_` 签名密钥 + 可选的控制台会话 cookie。

## 服务器端自主续期

这是「彻底脱离本机电脑」的关键。

控制台会话 cookie 只有 **7 天**。插件实现了 `auth.refresh`，magpie 会在到期前
24 小时自动调它：

```
控制台 cookie 还有效 → 铸造一把新的 oma_ key + 签名密钥 → 换掉账号里的凭据
控制台 cookie 过期   → 用服务器上存的口令重新登录 → 再铸造
                        （国内版还多一条路：百智云 OAuth 桥，30 天的 baizhi_session）
```

⇒ 本机电脑关机、断网、桌面端退出，都不影响服务器上的服务。

口令没了、且百智云桥也断了的时候，插件抛 `signIn: "expired"`，
magpie 会把那个账号标成「需要重新登录」，其余账号照常。

## 两条计费通道

MonkeyCode 的余额来自**两个不同的钱包**：

| | A 通道 | B 通道 |
|---|---|---|
| 模型端点 | `ai-models.app.baizhi.cloud/api/{anthropic,openai/v1}` | `proxy.monkeycode-ai.com/v1` |
| 钱包站 | `baizhi.cloud` | `monkeycode-ai.com` |
| 每日领取 | `POST /api/v1/user/wallet/daily-temporary-credit` | `POST /api/v1/users/wallet/checkin` |

A 通道的「每日临时额度」**不领就是 0** ⇒ 上游回 `400 余额不足`。
本插件的 `auth.checkin` 两条都领，magpie 自己的 30 分钟插件签到 tick 就覆盖了。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MONKEYCODE_CONFIG_DIR` | 客户端配置目录（整体覆盖） |
| `MONKEYCODE_COOKIE_FILE` | 会话 cookie 文件 |
| `BAIZHI_COOKIE_FILE` | 百智云（A 通道）会话 cookie 文件 |
| `MONKEYCODE_CREDENTIALS_FILE` | 口令库路径（默认 `~/.config/magpie/monkeycode-credentials.json`） |
| `MONKEYCODE_API_BASE` / `MONKEYCODE_CONSOLE_BASE` | 端点覆盖（私有化部署 / 测试） |

## 测试

```bash
bun test          # 或
npm run test:node
```

## 协议与致谢

- 上游客户端：[chaitin/MonkeyCode](https://github.com/chaitin/MonkeyCode)（`desktop/src/baizhi/`）
- 社区插件：[xxhhlk/magpie-monkeycode-plugin](https://github.com/xxhhlk/magpie-monkeycode-plugin)

MIT License，见 [LICENSE](./LICENSE)。
