# 已有基线（前一子代理中断前落盘，质量已复核，可直接沿用）

## lib/version.mjs（92 行，已完成，勿重写）
- `versionFromAsar(asarPath)`：分段读 asar（openSync → 读 16B 头 → 按 headerJsonLen 读 header → 按 entry.offset/size 精确切 package.json，NUL 对齐处理）✔ 正确
- `FALLBACK_CLIENT_VERSION = "2026.10.16"`（已更新到实测真值）
- `asarCandidates(env)`：LOBSTER_ASAR_PATH / LOCALAPPDATA / APPDATA / 硬编码本机路径 / ~/.local/share / macOS 路径
- `clientVersion({log, env, reset})`：懒求值 + 缓存 + `LOBSTER_CLIENT_VERSION` 强制覆盖 + warn 只打一次
- `makeLogger(client)`：兼容 client.app.log 的对象式/位置参数两种形状，日志失败不崩

## lib/checkin.mjs（100 行，已完成，勿重写）
- `beijingDay(date)`：北京日
- `runCheckin({token, version, env, fetchImpl, platform})`：三段式 + captcha 分支 + outcome 映射
- 判据：creditsGranted>0 才 claimed；claimedToday→done；lifecycleState 非 active→ineligible；actions 无 check_in→ineligible；slotState 非 available→inactive；其余抛异常(=failed)
- ⚠️ **依赖 `apiUrl(env)` —— lib/constants.mjs 尚未提供该导出，你必须补上**（env LOBSTER_API_BASE 优先，默认 https://lobsterai-server.youdao.com/api）

## 尚未动的文件（原始克隆状态，20:22:49）
index.mjs(191) / package.json(38) / lib/{constants,auth-import,proxy,models,auth-login,jwt,sse,thinking,usage,assemble}.mjs
