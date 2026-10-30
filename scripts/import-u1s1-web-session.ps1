# 把本机 u1s1 网站会话（u1s1_session cookie）复制到 magpie 服务器（供插件每日打卡）
#
# 用法（本机 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts/import-u1s1-web-session.ps1
#
# 为什么需要这一步：
#   u1s12api 插件的每日打卡（auth.checkin）走的是**网站**接口
#   POST https://u1s1app.com/api/packages/login-checkin/claim，
#   它认的是网站会话 cookie（~/.u1s1/web-session.json 里的 u1s1_session），
#   不是 CLI 的设备凭证 —— 设备凭证只够访问 api.u1s1app.com。
#   服务器上没有浏览器，插件自带的 CDP 兜底（127.0.0.1:9222）用不上，
#   所以这个文件得由本机生成再搬过去。
#
# 本机怎么生成（Chrome 已登录 u1s1app.com）：
#   chrome.exe --remote-debugging-port=9222
#   node <插件目录>/login-once.mjs
#   → 写 ~/.u1s1/web-session.json（只打印名字与掩码，不泄露值）
#
# 注：Claude Code 会话内的 scp 到该主机可能被安全策略硬阻断（凭据文件外传），
#     所以这一步必须由人在自己的终端里跑。

$ErrorActionPreference = 'Stop'

$Server = 'ubuntu@43.131.227.120'
$Remote = '/home/ubuntu/.u1s1/web-session.json'
$Src = Join-Path $env:USERPROFILE '.u1s1\web-session.json'

if (-not (Test-Path $Src)) {
    throw "本机没有 $Src —— 先用 Chrome(--remote-debugging-port=9222) + login-once.mjs 生成"
}

$item = Get-Item $Src
Write-Host "→ web-session.json  ($($item.Length) bytes)"

# 服务器侧目录
ssh $Server "mkdir -p /home/ubuntu/.u1s1"
if ($LASTEXITCODE -ne 0) { throw '服务器目录创建失败' }

scp -o StrictHostKeyChecking=no $Src "$Server`:$Remote"
if ($LASTEXITCODE -ne 0) { throw 'scp 失败（可能被安全策略拦截）—— 请在本机终端里手动执行同一条 scp' }

ssh $Server "chmod 600 '$Remote'"

# 只核对大小，不看内容
$remoteSize = (ssh $Server "wc -c < '$Remote'" | Out-String).Trim()
if ([int64]$remoteSize -ne $item.Length) {
    throw "大小不符：远端 $remoteSize / 本地 $($item.Length)"
}

Write-Host "  ✓ 已到位（$remoteSize bytes，权限 600）"
Write-Host ''
Write-Host '接下来在服务器上：'
Write-Host '  export PATH=$PATH:/home/ubuntu/.local/bin'
Write-Host '  magpie provider test u1s12api'
Write-Host '  # 打卡的验证（magpie 会记到 plugin-checkin.json）：'
Write-Host '  cat ~/.config/magpie/plugin-checkin.json | grep -A5 u1s1'
