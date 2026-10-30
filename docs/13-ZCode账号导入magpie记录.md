# 13 · ZCode 账号导入 magpie 记录（2026-10-30）

> **本文是什么**：把本机 zcode-switch 管理的 3 个 z.ai 账号导入 magpie 内置 `zcode` provider 的决策、事实核验与实施记录（SSOT）。
> **本文不负责**：magpie 网关部署（→ `01`）、LobsterAI 插件迁移（→ `10/11/12`）、zcode-switch 应用本身的构建与账号管理（其仓库为上游克隆，无自建 docs）。

## 一、目标与背景

本机 ZCode 账号由 zcode-switch（Tauri 桌面工具）统一管理（账号库 `C:\Users\18975\.zcode-switch\accounts\`，导出快照 `账号/zcode_accounts_2026-10-24.json`）。目标：让 magpie 网关的内置 `zcode` provider 用上这批账号（多账号调度 + GLM 套餐额度），全程零人工浏览器登录。

## 二、已定决策

| # | 决策 | 理由 | 被否方案 |
|---|---|---|---|
| D1 | 直接写服务器 `~/.config/magpie/plugin-auth.json` + 重启，不走网页登录 | zcode 内置 provider 无 CLI 登录命令；网页登录需人工浏览器 OAuth × 3 账号 | magpie Web Library 逐账号登录（可靠但违背零交互目标） |
| D2 | 死掉的 access_token 放弃换取业务密钥，改用 **JWT 凭据方案** | 实测 `api/auth/z/login` 对 3 个账号全部 500（token 全失效）；JWT 在 magpie Go 客户端下推理实测可用（见 D2 验证 §四） | 重新 OAuth 登录刷新 token（可行保底，本任务中未需要） |
| D3 | 账号 2（已有 API-key 凭据）保持主账号 `zcode`，账号 1/3 以 JWT 方案挂 `zcode#<rand5>` | API-key 路径功能最全（推理 + 额度显示都正常）；不动的能跑就别动 | 全部统一 JWT（无必要地替换已验证凭据） |
| D4 | 多账号键名 `zcode#<5位随机小写字母数字>` | 仿照服务器现有 `minimax-code-global#ckxq5v` 多账号先例；随机后缀无语义推导规则（与 accountId/uid 均无关，实测比对确认） | 用 accountId 做后缀（与现有命名形态不符） |

## 三、事实核验（2026-10-30，全部服务器实测）

### 3.1 magpie `zcode` 账号存储格式（`plugin-auth.json`）

- 顶层 = 平铺 map：`providerId → 单账号对象`；多账号 = `providerId#后缀` 平级新键。
- zcode 账号对象字段：`type:"oauth"`、`refresh`（**JSON 字符串**，内含 `site/device/key/base/jwt/plan` 六键）、`access`、`expires`、`accountId`（显示名）、`uid`（z.ai user uuid）。
- 两种凭据形态（二选一落盘）：
  | 形态 | `access`/`refresh.key` | `refresh.base` | 推理 | 额度显示 |
  |---|---|---|---|---|
  | API-key | `apiKey.secret`（约 49 字符，z.ai 后台 `zcode-api-key`） | `https://api.z.ai/api/anthropic` | ✓ | ✓ |
  | JWT | `zcodejwttoken` 原文 | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | ✓ | ✗ Not Found |
- `expires: 0` 合法（不参与到期调度）。`device` = 36 位 UUID（设备指纹），每账号独立一个。

### 3.2 凭据有效性实测

- 本地快照里 3 个账号的 **access_token 全部失效**：`POST api.z.ai/api/auth/z/login` 一律 `code 500 "Z.ai user information is invalid"`——连已在 magpie 正常工作的账号 2 的旧 token 也 500，判定为真失效而非接口/请求头问题（补全 ZCode 全套客户端头重试仍 500）。
- **JWT 全部有效**：带全套 ZCode 客户端头（`User-Agent: ZCode/<ver>`、`X-Title: Z Code@electron`、`X-Device-Mid` 等，取自 zcode-switch `quota.rs` 的 `zai_headers_with_version`）调 `zcode.z.ai/api/v1/zcode-plan/billing/preview`，3 账号全部 `code 0`。
- JWT 不能用脚本直接打推理端点：`x-api-key` → 401 空 body；`Bearer` → `405 code 3012`（风控「unusual activity」，本地家宽 IP 与服务器 IP 结果相同）。**但 magpie 的 Go 客户端同凭据同端点推理成功** ⇒ 3012 拦的是脚本 HTTP 指纹，不是凭据本身（D2 的依据）。
- 推理端点鉴权方式：JWT 走 `x-api-key`（anthropic 协议），`Bearer` 方式必被风控拦。

### 3.3 版本与行为

- magpie v0.1.2020（比 `10` 号文档记录的 0.1.1734 已升级）；zcode 为 Go 内置 agent（二进制内 `internal/agent/zcode.go`），非 folder plugin。
- zcode 模型目录：`zcode/GLM-5.3-Flash`（档位 low/high/max）、`zcode/GLM-5.2`（none/high/max）、`zcode/GLM-5-Turbo`（none/high），另有 1 个未暴露的 GLM-5.3-Flash-Trial。

## 四、实施记录（时间线）

1. 备份 `plugin-auth.json` → `plugin-auth.json.bak-20261030`；上传账号快照到 `/tmp`（600，用毕即删）。
2. 尝试 access_token 换业务密钥（D2 前身）→ 全 500，放弃（§3.2）。
3. JWT 对照探测（python/node 直连）→ 3012 风控，一度误判「JWT 不可用 ⇒ 必须重新登录」。
4. **实证翻案**：造临时 JWT 条目顶替主位重启 → `magpie provider test zcode` 连续两次 ✓（1052/1030ms，GLM-5.3-Flash）⇒ JWT 方案成立。
5. 正式落盘：还原账号 2 为主账号；账号 1/3 以 JWT 条目写入 `zcode#9jbzm`、`zcode#pu038`。
6. 中途两次脚本 bug 污染数据（见 §六），从备份/源数据重建干净终态后再次验证。

## 五、验证结果（终态）

- `magpie provider test zcode` → `✓ anthropic 633 ms · GLM-5.3-Flash`（主账号，API-key 路径）。
- JWT 方案推断推理：主位实验期连续两次 ✓（§四.4）——两条 JWT 条目与该实验条目同构（同 base/同鉴权/同字段集）。
- `magpie quota zcode`：主账号用量正常（4%，窗口 09:00 重置）；两条 JWT 账号显示 `Not Found`（仅展示层，见 §七）。

## 六、踩坑（本次实际踩中）

1. **字典键覆盖丢数据**：`auth['zcode'] = auth.pop('zcode#mainbak')` 时 `zcode` 键已存在 → 原 JWT 条目被静默覆盖丢失，且 api-key 条目被误改名。教训：**交换/挪移键前必须断言目标键不存在**，或先整体 pop 出独立变量再赋值。
2. **字段语义错比**：跳过条件写成 `a['user_id'] == '18975…@qq.com'`（UUID 比邮箱，恒 False）→ 账号 2 被重复导入一份 JWT 副本。教训：比较前核对两侧字段语义。
3. **无主账号时的 405 假象**：键覆盖 bug 导致 `zcode` 主键短暂缺失，此时 `provider test` 报 405（风控文案）——与 JWT 被拦同形。教训：**诊断 405/3012 先确认被测条目确实存在且为主键**，再判断是不是凭据/风控问题。
4. **脚本指纹风控误判**（§3.2）：用 python/urllib、node/fetch 探测上游结论「不可用」前，先考虑换更接近真实客户端的调用方（magpie 自身）复测——本例差点因此错判整条路线。

## 七、已知限制与风险

- **JWT 账号额度显示 Not Found**：magpie 查用量走 api.z.ai（需 API-key）；推理不受影响，额度耗尽时靠上游报错触发调度。
- **JWT `token_version` 风险**：JWT 无 `exp` 但带版本号——在这些账号上重新登录 ZCode 客户端可能使旧 JWT 失效（`expires:0` 使 magpie 不会自动发现）。届时按 §四.4-5 重导即可。
- 两条 JWT 条目的推理长稳性仅验证到「两次成功」，未做长周期观测。

## 八、回滚

`cp ~/.config/magpie/plugin-auth.json.bak-20261030 ~/.config/magpie/plugin-auth.json && magpie daemon restart`
（`.bak2` 为中途污染态快照，仅取证用。）
