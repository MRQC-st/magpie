# 19 · AgentRouter 接入与模型列表刷新

> **本文是什么**：AgentRouter（公益中转站）以 **magpie 自定义厂商 + 本机 relay** 方式接入的
> 全部事实：为什么不能直连、链路、配置、模型刷新、部署/回滚与实测证据。
> **本文不负责**：magpie 首次部署（→ `01`）、插件宿主机制（→ `18`）、域名与回源（→ `02`）。
>
> 2026-11-06 实装并验证；服务器 magpie **0.1.3105**。

## 一句话结论

服务器**直连 `agentrouter.org` 会命中阿里云 WAF 验证页**（HTTP 200 但返回 HTML），
且上游要求 **Codex CLI 客户端指纹头**，否则 `401 unauthorized client detected`。
因此在服务器上加了一层 **relay**（注入指纹头 + 经 mihomo 出网），magpie 以自定义厂商接入；
模型列表由 `models.url` 动态拉取，`refresh-every 1d` 自动刷新。实测 3 个模型经网关全部返回 `PONG`。

## 一、上游事实（2026-11-06 实测）

| 项 | 值 |
|---|---|
| Base URL | `https://agentrouter.org/v1` |
| 鉴权 | `Authorization: Bearer <key>`（key 存服务器 `~/.config/magpie/agentrouter.key`，600） |
| 必带请求头（**每个请求**，含 `/v1/models`） | `Originator: codex_cli_rs`<br>`User-Agent: codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464`<br>`Version: 0.101.0` |
| 模型列表 | `GET /v1/models`，标准 OpenAI JSON（`{"data":[{"id":…}]}`） |
| 模型数 | **3**：`gpt-5.6-sol` / `gpt-6-astra` / `gpt-6.1-sol` |
| 可用 API | 三个模型**只支持 Responses API**；`/v1/chat/completions` 返回 400 并提示改用 `/v1/responses` |

> 旧记录（pi 项目）称 `/v1/models` 返回非标准 JSON —— 2026-11-06 复测**已是标准格式**，以本次为准。

## 二、为什么必须经过 relay

两组对照（同一 key、同一模型列表请求）：

| 场景 | 结果 |
|---|---|
| 服务器**直连**（带全部指纹头） | HTTP 200，但正文是 16 KB 的 **`aliyun_waf` 验证页 HTML**（`<meta name="aliyun_waf_aa" …>`） |
| 经 mihomo、**不带**指纹头 | HTTP 401 `unauthorized client detected` |
| 经 mihomo、**带**指纹头 | HTTP 200，3 个模型 |

⇒ 两个条件缺一不可：**换可用的出网 IP**（mihomo 出口）+ **带 Codex 指纹头**。

## 三、链路

```
agent / curl
  → magpie 网关 :3425
    → provider `agentrouter`（chat/responses = http://127.0.0.1:8399/v1）
      → relay（127.0.0.1:8399，补指纹头，缺什么补什么）
        → mihomo（http://172.17.0.1:17900）
          → https://agentrouter.org
```

- **relay 只做两件事**：补齐三个指纹头（已有则不覆盖）、固定经 mihomo 出网。
  不改协议、不缓存，响应逐块透传（Responses API 的 SSE 流式同样可用）。
- `models.url` 指向 relay，所以**模型刷新也走同一条链路、同样带头**。
- mihomo 是服务器既有服务（host 网络，mixed-port `17900`）；接入初期出口随 `AUTO` 测速漂移
  （实测在 `163.227.160.152` / `163.227.161.157` 之间切换），2026-11-06 已**固定出口**，见 §九。

## 四、magpie 侧配置（实装值）

```sh
export PATH=$PATH:/home/ubuntu/.local/bin
magpie provider add agentrouter \
  url=http://127.0.0.1:8399/v1 \
  responses=http://127.0.0.1:8399/v1 \
  key="$(cat ~/.config/magpie/agentrouter.key)" \
  models.url=http://127.0.0.1:8399/v1/models \
  header.Originator=codex_cli_rs \
  "header.User-Agent=codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464" \
  header.Version=0.101.0
```

落地结果：

| 字段 | 值 |
|---|---|
| id | `agentrouter`（显示名 `AgentRouter 公益中转`） |
| chat / responses | `http://127.0.0.1:8399/v1` |
| headers | `Originator` / `User-Agent` / `Version`（与上游要求逐字一致） |
| modelsURL | `http://127.0.0.1:8399/v1/models` |
| refreshEvery | `1d` |

模型必须逐个标记为 Responses API，否则 magpie 会按 chat 调用而失败：

```sh
magpie model api agentrouter/gpt-5.6-sol   responses
magpie model api agentrouter/gpt-6-astra   responses
magpie model api agentrouter/gpt-6.1-sol   responses
```

### 踩坑：`agentrouter` 是 magpie 的内置 preset 名

`magpie provider add agentrouter …` 会先加一个**预设**（3 个占位模型、直连 agentrouter、无指纹头），
再建一个自定义厂商 `agentrouter-2`。处置（本次已执行）：

```sh
yes | magpie provider rm agentrouter        # 删预设（不确认会静默不动）
yes | magpie provider set agentrouter-2 id=agentrouter   # 改名成最终 id
yes | magpie provider set agentrouter 'name=AgentRouter 公益中转'
```

下次接入同类中转站，**第一段直接用一个不撞 preset 的名字**（如 `agentrouter-relay`）可以少两步。

## 五、刷新与验证

```sh
magpie provider refresh agentrouter                 # 手动刷新模型列表（本次：3 models from 127.0.0.1:8399）
magpie provider refresh-every agentrouter 1d        # 定时刷新：由 magpie serve 每 1d 拉一次
magpie provider agentrouter                         # 看配置/模型/headers
magpie provider test agentrouter                    # 冒烟（chat 必然 ✗，responses 应 ✓）
```

端到端（服务器本机，网关 loopback 免 key）：

```sh
curl -sS http://127.0.0.1:3425/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"agentrouter/gpt-6.1-sol","input":"Reply with the single word PONG","max_output_tokens":64}'
```

### 实测证据（2026-11-06）

| 测试 | 结果 |
|---|---|
| `magpie provider refresh agentrouter` | ✓ 3 models from `127.0.0.1:8399` |
| 网关 `/v1/models` | 总 669 个模型中含 3 个 `agentrouter/*`（其它 agent 可直接发现） |
| `magpie provider test agentrouter` | ✗ chat 400（提示改用 `/v1/responses`）；✓ responses 200 |
| 网关 `/v1/responses` × `gpt-5.6-sol` | HTTP 200，正文 `PONG` |
| 网关 `/v1/responses` × `gpt-6-astra` | HTTP 200，正文 `PONG` |
| 网关 `/v1/responses` × `gpt-6.1-sol` | HTTP 200，正文 `PONG` |
| 网关 `/v1/responses` 流式（`stream:true`） | HTTP 200（9.5 KB SSE），含 `response.output_text.delta` ×2 与 `response.completed` |
| magpie 是否真发指纹头 | relay 日志收到 `Originator='codex_cli_rs' Version='0.101.0' UA='codex_cli_rs/0.101.0 …'` |
| 无指纹头对照 | 401 `unauthorized client detected`（见 §二） |

> `provider test` 只看状态码会误判（chat 那行是红的），**必须按正文/模型可用性复核**（铁律 6）。

### 给其它 agent 的指向方式

- Base URL：`https://magpie.sunfolower.cn/v1`
- 模型：`agentrouter/<id>`，从 magpie 的 `/v1/models` 动态取（**任何 agent 侧都不要写死模型清单**）
- 协议：**Responses API**（`/v1/responses`，请求体用 `input`），不是 `/v1/chat/completions`
- 鉴权：各设备自己的 magpie 网关 key（本文不记录 key 值）

## 六、部署与运维

| 项 | 值 |
|---|---|
| relay 脚本（仓库 SSOT） | `scripts/agentrouter-relay.py`（Python 3 stdlib，无常驻依赖） |
| systemd 单元（仓库） | `scripts/agentrouter-relay.service` |
| 服务器副本 | `/home/ubuntu/services/agentrouter-relay/relay.py` + `~/.config/systemd/user/agentrouter-relay.service`（**enabled + active**，Restart=always；与仓库一致） |
| 监听 | `127.0.0.1:8399`（仅本机，不暴露公网） |
| 密钥 | `~/.config/magpie/agentrouter.key`（600，**不进仓库、不进聊天**） |
| 依赖 | mihomo `172.17.0.1:17900`（若它挂了，relay 返回 502 并提示检查出口代理） |

常用命令：

```sh
systemctl --user status  agentrouter-relay
systemctl --user restart agentrouter-relay
journalctl --user -u agentrouter-relay -n 50
curl -s http://127.0.0.1:8399/healthz      # {"ok":true}
docker ps | grep mihomo                    # 出口依赖
```

## 七、回滚

改动前的配置备份：`~/backups/magpie-config-pre-agentrouter-20261106T091300Z.tar.gz`
（含 `providers.json` / `settings.json` / `plugins.json` / `plugin-auth.json` / `logins.json` / `routing/`）。

```sh
# 1) 移除 provider
yes | magpie provider rm agentrouter
# 2) 停用并删除 relay
systemctl --user disable --now agentrouter-relay
rm -f ~/.config/systemd/user/agentrouter-relay.service ~/services/agentrouter-relay/relay.py
systemctl --user daemon-reload
# 3) 若还要恢复其它 provider 配置（谨慎：会覆盖备份之后的改动）
tar xzf ~/backups/magpie-config-pre-agentrouter-20261106T091300Z.tar.gz -C ~/.config/magpie providers.json
```

> 回滚后 `magpie provider agentrouter` 应报 provider 不存在；其它 provider 不受影响。

## 八、注意事项

1. **WAF 是变量**：本次靠 mihomo 出口绕过阿里云 WAF。若以后直连恢复、或出口节点被拉黑，
   重跑 §二 的三组对照再决定是否需要调整出口；不要凭「之前能用」判断。
2. **指纹头与 key 缺一不可**：换 key 只需更新 `~/.config/magpie/agentrouter.key` 后
   `magpie provider set agentrouter key="$(cat …)"`（或重新 add）；头保持原样。
3. **模型目录随时会变**：不要在任何 agent 侧写死；统一从 magpie 的 `/v1/models` 取，
   刷新走 `magpie provider refresh agentrouter`（已设 1d 自动刷新）。
4. **模型默认是 Responses API**：新拉到的模型也要 `magpie model api agentrouter/<id> responses`
   （若未来出现 chat 模型，再按实际标记）。
5. **relay 是单点**：只监听 loopback，随 systemd 用户服务开机自启；改 `relay.py` 后必须
   `systemctl --user restart agentrouter-relay`。provider 配置变更**即时**被网关采用
   （本次加完未重启 magpie，`/v1/models` 与 `/v1/responses` 立即可用）。
6. **不要把 key/cookie 写进 relay 日志**：relay 只记录方法/路径/状态码；本次曾临时打印头用于校验，已移除。

## 九、固定出口（2026-11-06）

**为什么做**：`MATCH,PROXY` 落到 `AUTO`（URLTest，`interval: 300s`、`tolerance: 50ms`、37 个节点），
每 5 分钟重新测速就会换节点，出口 IP 随之变化 —— 对 AgentRouter 这种**按 IP 做 WAF/风控**的上游
是随时可能翻车的隐患。修法是给 agentrouter 单独一条规则，绑到一个**不参与测速的 selector 组**。

### 9.1 规则写法（已实装）

配置文件：服务器 `/home/ubuntu/services/mihomo/mihomo.conf`（只读挂载到容器 `/root/.config/mihomo/config.yaml`）。

```yaml
proxy-groups:
  # …（原有 AUTO / PROXY 不动）
  - name: AgentRouter
    type: select
    proxies:
      - '日本-HY2-47'

rules:
  - DOMAIN-SUFFIX,agentrouter.org,AgentRouter
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve   # 2026-11-08 补：见 §9.9
  - IP-CIDR6,::1/128,DIRECT,no-resolve
  - GEOIP,CN,DIRECT          # 保持原样
  - MATCH,PROXY              # 保持原样
```

- 用 **`select` 组 + `DOMAIN-SUFFIX`** 而不是直接把规则指节点：以后换节点只改组内选择（或改
  `proxies` 一行），**规则不动**；`DOMAIN-SUFFIX` 覆盖 `agentrouter.org` 及其子域。
- 只影响 `agentrouter.org` 与**本机回环**流量；`GEOIP,CN,DIRECT` 与 `MATCH,PROXY` 顺序/语义均未改
  （回环两条规则的原因见 §9.9）。
- 切换组内选择（**改完即生效，无需重载配置**）：

```sh
# 查看
curl -s -H "Authorization: Bearer $(grep -m1 '^secret:' ~/services/mihomo/mihomo.conf | awk '{print $2}')" \
  http://172.17.0.1:19900/proxies/AgentRouter
# 切换（示例：换成另一个已验证节点）
curl -s -X PUT -H "Authorization: Bearer <secret>" -H 'Content-Type: application/json' \
  -d '{"name":"美国-VLESS-13"}' http://172.17.0.1:19900/proxies/AgentRouter
```

### 9.2 改前备份与热重载

| 项 | 值 |
|---|---|
| 备份 | `~/backups/mihomo.conf.pre-agentrouter-pin-20261106T103439Z` |
| 备份 sha256 | `7e90243326d87cd6eb5061d7ba4533304bfbbcfd237d2d4b51d0302d7420332f` |
| 改后（含本节规则）sha256 | `7a2507dd941f5cf1e47a63335ca55e35e60a43f87acf13917d5732a526605fa2` |
| 热重载 | `docker kill -s HUP mihomo`（无需重启容器、不影响其它连接） |

### 9.3 验证结果（只读，2026-11-06 18:3x）

| 测试 | 结果 |
|---|---|
| 分组采样 ×5（每 3 s） | `PROXY=AUTO`、`AUTO=日本-HY2-51`（仍在参与测速）、**`AgentRouter=日本-HY2-47` 5/5 不变** |
| 出口 IP ×5 轮（每轮 `ipinfo.io/ip` + `api.ipify.org`） | **10/10 全部 `163.227.161.157`**，去重后仅 1 个 IP |
| 对照：`MATCH,PROXY`→`AUTO` 的出口 | `163.227.160.152`（**与固定出口不同**，证明规则确实分流） |
| 活跃连接链 | `chains=['日本-HY2-47','AgentRouter']`，`rule=DomainSuffix`，`rulePayload=agentrouter.org` |
| `magpie provider refresh agentrouter` | ✓ 3 models from `127.0.0.1:8399` |
| 网关 `/v1/models` | 3 条 `agentrouter/*`（`gpt-5.6-sol` / `gpt-6-astra` / `gpt-6.1-sol`） |
| 网关 `/v1/responses`（`gpt-6.1-sol`） | HTTP 200，正文 `PONG` |
| 网关 `/v1/responses` 流式 | HTTP 200，9365 字节 SSE，`output_text.delta` ×4、`response.completed` ×2 |

> 测出口 IP 时临时加过两条测试域名规则（`ipinfo.io` / `ipify.org` → `AgentRouter`），测完**已还原**
> （校验 sha256 与改前完全一致、无残留测试规则），最终配置只多 AgentRouter 组 + 1 条 DOMAIN 规则。
> 节点身份：`日本-HY2-47`，hysteria2，服务器 `163.227.161.157:23001`，实际落地越南河内（UPNET / AS153830）。

### 9.4 节点失效时怎么切

1. **先判断是节点问题还是上游问题**：`curl -s -m 8 https://agentrouter.org/v1/models` 经 relay（`/healthz` 正常但 models 5xx/超时）→ 多为节点；
   `mihomo` API 对该节点做 `delay` 测试同样失败基本可确认。
2. **组内切换**（最快，秒级生效）：`PUT /proxies/AgentRouter` 换到候选节点（§9.6），或用 mihomo 面板点选。
3. **候选都不可用时**：临时把组内 `proxies` 换成 `['PROXY','AUTO']`（回到跟随 AUTO），改完 `docker kill -s HUP mihomo`；
   此时等于放弃固定出口，需同步在本文记录时间点，便于以后排查 WAF 变化。
4. **修复后**：切回固定节点，重跑 §9.3 的出口 IP 采样（至少 3 轮）再交付。

### 9.5 回滚（恢复固定出口之前的状态）

```sh
cp ~/backups/mihomo.conf.pre-agentrouter-pin-20261106T103439Z ~/services/mihomo/mihomo.conf
docker kill -s HUP mihomo
# 校验：API 中不再有 AgentRouter 组，规则回到 DOMAIN 之外的两条
curl -s -H "Authorization: Bearer <secret>" http://172.17.0.1:19900/rules | head -c 400
```

> 回滚后 agentrouter 仍可访问（走 `MATCH,PROXY`→`AUTO`），只是出口重新随测速漂移。

### 9.6 候选节点（本次只测延迟，**未改选**）

测试目标 `https://agentrouter.org/v1/models`，`timeout=8000`：

| 节点 | delay | 备注 |
|---|---|---|
| 泰国-HY2-48 | 155 ms | 最快，可作首选备选 |
| 美国-VLESS-13 | 321 ms | 美国落地，适合需要美国 IP 的场景 |
| 美国-HY2-35 | 328 ms | |
| 美国-HY2-29 | 334 ms | |
| 德国-HY2-36 | 411 ms | 欧洲备选 |
| 德国-HY2-46 | 467 ms | 欧洲备选 |

> 台湾/香港类节点在同池内但未逐个测；`sg1/sg2/sg3` 命名的节点**实际落地是美国 DigitalOcean 圣克拉拉**，
> 不要按名字当成新加坡。选备选时除延迟外，还要按 §9.3 的方法实测出口 IP 可用性。

### 9.7 注意：`build_conf.py` 会覆盖

服务器上 `scripts/build_conf.py` 会重新生成 `mihomo.conf`。若之后跑过它，**AgentRouter 组与规则会丢失**，
需用下面这条检查，丢了就重新插入 §9.1 的片段：

```sh
grep -n 'AgentRouter' ~/services/mihomo/mihomo.conf || echo '丢失，需重加'
```

长期更稳的做法是把 `AgentRouter` 组 + 规则写进 `build_conf.py` 的模板（本次未改脚本，避免扩大改动面）。

### 9.8 决策：不建 fallback 备用组（2026-11-06，用户确认）

**决策**：保持**单节点固定出口**（`AgentRouter` → `日本-HY2-47`），**不建 fallback / url-test 备用组**，
也不做多节点轮换。切换一律人工执行（§9.4 的 `PUT /proxies/AgentRouter`，秒级生效）。

**为什么不建 fallback**：

1. **切节点 = 换出口 IP**。AgentRouter 按来源 IP 做 WAF/风控，自动切换到备用节点会**重新触发风控**，
   等于把「稳定」换成「可用但不可控」——而这些是需要重新回归验证的，不是配置能自动保证的。
2. **自动切换会掩盖问题**。fallback 组在主节点探测失败时静默换节点，事后只看「请求成功了」，
   分不清是「主节点恢复」还是「已换成别的出口」，排障与审计都失去基准。
3. **收益不对称**。单节点失效是低频事件，人工切换成本≈一条命令；而自动切换带来的出口不确定性
   是持续的。故选择「人工介入 + 明确记录」。

**触发切换的判定信号**（满足任一即按 §9.4 处理，顺序即优先级）：

| 信号 | 现象 | 先排除什么 |
|---|---|---|
| ① 模型刷新异常 | `magpie provider refresh agentrouter` 不是 `✓ 3 models from 127.0.0.1:8399`；报 HTML/解析失败/超时 | 先看 relay `/healthz` 与 provider 配置（§五） |
| ② 正文是 HTML | `/v1/responses` 返回 **HTTP 200 但正文是 `aliyun_waf` 验证页** | 这是出口被风控的典型形态（§二 对照③） |
| ③ 流式首包前失败 | `stream:true` 在收到第一个 `response.*` 事件前超时/断流（中途断则更像上游限流） | 用非流式复测一次，区分首包前 vs 中途 |
| ④ 节点探测失败 | mihomo 对该节点 `delay` 连续失败或 >8s（URL 用 `https://agentrouter.org/v1/models`） | 同时直连 `agentrouter.org` 判断是否上游整体故障 |

> 注意：`401 unauthorized client detected` **不是**节点信号，是**指纹头缺失/被改**，按 §八 第 2 条处理，别去换节点。

**失败时的处理路径**：

1. **先定性**：按 §二 重跑三组对照（直连 / 经出口不带指纹头 / 经出口带指纹头），确认是
   节点出口被风控、key 失效，还是指纹头问题。**不要在未定性前换节点**（会污染证据）。
2. **确认是节点** → 按 §9.6 选候选，`PUT /proxies/AgentRouter` 切过去，切完**重跑 §9.3 的出口 IP 采样（至少 3 轮）**
   再恢复业务验证（refresh + 非流式 + 流式）。
3. **候选全不可用** → 组内临时改 `['PROXY','AUTO']`（回到跟随测速）+ `docker kill -s HUP mihomo`，
   并在本文/`99` 记录时间点；这等于**临时放弃固定出口**，之后必须切回并复验。
4. **key/头问题** → 不动出口：更新 `~/.config/magpie/agentrouter.key` 并 `provider set`，或核对三个指纹头。

**接受的代价**：节点失效时需要人工介入（没有自动兜底）；换来的是出口 IP 可预期、可审计。
若以后要降人工成本，优先做**只读告警探针**（定时 refresh + 校验正文，只告警不改出口），
而不是自动切节点。

### 9.9 补丁：回环直连规则（2026-11-08，修 502）

**现象**：Codex 报 `unexpected status 502 Bad Gateway: Unknown error, url: http://127.0.0.1:3425/v1/responses`。
服务器上的 Codex 进程带 `HTTP_PROXY=HTTPS_PROXY=http://172.17.0.1:17900`，而它的 `base_url` 是
`http://127.0.0.1:3425/v1` ⇒ 请求被**当成外网流量**送进 mihomo，命中 `MATCH,PROXY` 后被转发到
日本节点；远端节点当然连不到服务器的 `127.0.0.1:3425`，于是回 502。

**定性证据（三组对照）**：

| 路径 | 结果 |
|---|---|
| `curl --noproxy '*' http://127.0.0.1:3425/v1/models` | **200**（网关/relay/节点/上游全健康） |
| `curl -x http://172.17.0.1:17900 http://127.0.0.1:3425/v1/models` | **502**（复现 Codex 报错） |
| 逐模型经网关（`gpt-6-astra`/`gpt-6.1-sol`/`gpt-5.6-sol`） | 全 **200**，模型未下线 |

**修法**：在 `agentrouter.org` 规则后、`GEOIP` 前加两条回环直连规则（上面 §9.1 已并入）：

```yaml
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR6,::1/128,DIRECT,no-resolve
```

- 只影响本机回环（不改变任何外网流量；`GEOIP,CN,DIRECT`、`MATCH,PROXY` 语义不变）。
- 备份：`~/backups/mihomo.conf.pre-loopback-direct-20261108T091606Z`（sha256 `7a2507…`，与 §9.2 的改后值一致）；
  修复后 sha256 `ce998554a67ec4601a34c03652d5ae372ef87a87680e57c8738e492afa10fccb`。
- 生效方式仍为 `docker kill -s HUP mihomo`。

**修后验证（全部经代理 `172.17.0.1:17900`，即 Codex 的真实环境）**：

| 项 | 结果 |
|---|---|
| `GET /v1/models` | 200，`agentrouter/*` 3 个 |
| `POST /v1/responses`（`gpt-6-astra`，非流式） | 200，正文 `PONG` |
| 同上 `stream:true` | 200，11757 字节 SSE，`delta` ×4、`completed` ×2 |
| 分流回归 | `AgentRouter=日本-HY2-47`、`PROXY=AUTO`；`baidu.com` 仍 200（走 `GEOIP,CN,DIRECT`） |

> 注意：客户端若设了 `HTTP_PROXY`，**任何访问 `127.0.0.1` 的调用**都会被送进代理；这条规则是通用兜底，
> 以后新增本机回环服务（如其它 sidecar）不需要再改规则。

> 跨项目指针：Codex 侧文档（两实例版本升级、早停两类判定、模型目录元数据兜底）见
> `D:\projects\agent\codex\docs\`，入口 `AGENTS.md`（2026-11-08 建立）。
