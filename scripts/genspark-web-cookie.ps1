# 把本机 Chrome 的 genspark.ai 网页会话（含 HttpOnly）同步到 magpie 服务器，
# 供 genspark-web 桥使用（Genspark 网页端 Super Agent 通道，花的是网页积分）。
#
# 用法（本机 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts/genspark-web-cookie.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/genspark-web-cookie.ps1 -Profile 72qpbudd
#
# 前置：opencli daemon 在跑、浏览器已登录 genspark.ai（opencli doctor 绿色）。
# 只报 cookie 名字数量与余额，不打印任何 cookie 值。
#
# 什么时候要重跑：桥的 /health 返回 cookie_present=false，或桥报 "网页会话失效"。
# 会话有效期由 Genspark 决定，浏览器里还登录着就能直接重抓。

param(
    [string]$Profile = '72qpbudd',
    [string]$Server = 'ubuntu@43.131.227.120',
    [string]$Daemon = 'http://127.0.0.1:19825/command',
    [string]$RemoteCookie = '/home/ubuntu/.config/magpie/genspark/web-cookie.txt'
)

$ErrorActionPreference = 'Stop'

$body = @{
    id         = "cmd_gsp_cookie_$(Get-Random)"
    action     = 'cookies'
    contextId  = $Profile
    session    = 'gspcookie'
    url        = 'https://www.genspark.ai'
} | ConvertTo-Json -Compress

try {
    $resp = Invoke-RestMethod -Uri $Daemon -Method Post -Headers @{ 'X-OpenCLI' = '1' }`
        -ContentType 'application/json' -Body $body -TimeoutSec 30
} catch {
    $msg = $_.Exception.Message
    throw "取 cookie 失败：$msg`n（若报 profile_required，用 -Profile 指定当前浏览器 profile 名，见 opencli doctor）"
}

$cookies = $resp.data
if (-not $cookies) { throw 'daemon 没有返回 data 字段，检查 opencli doctor 是否正常' }

$siteCookies = $cookies | Where-Object { $_.domain -like '*genspark*' }
if (-not $siteCookies) { throw '拿到的 cookie 里没有 genspark 域，确认浏览器停在该站登录态' }

$header = ($siteCookies | ForEach-Object { "$($_.name)=$($_.value)" }) -join '; '
$names = ($siteCookies | ForEach-Object { $_.name }) -join ','

$tmp = Join-Path $env:TEMP 'genspark_web_cookie.txt'
$header | Out-File -Encoding ascii -NoNewline $tmp

Write-Host "→ 抓到 $($siteCookies.Count) 条 genspark cookie（含 HttpOnly），长度 $($header.Length)"
Write-Host "  名字：$names"

$scpExe = 'C:\Windows\System32\OpenSSH\scp.exe'
$sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
if (-not (Test-Path $scpExe)) { $scpExe = 'scp' }
if (-not (Test-Path $sshExe)) { $sshExe = 'ssh' }

& $scpExe -o StrictHostKeyChecking=no $tmp "${Server}:/tmp/gsp_cookie_sync.txt"
if ($LASTEXITCODE -ne 0) { throw 'scp 失败（可能被安全策略拦截）—— 请在本机终端里手动执行同一条 scp' }

$install = "mkdir -p ~/.config/magpie/genspark && install -m 600 /tmp/gsp_cookie_sync.txt $RemoteCookie && rm -f /tmp/gsp_cookie_sync.txt && echo installed"
& $sshExe -o StrictHostKeyChecking=no $Server $install
if ($LASTEXITCODE -ne 0) { throw '服务器侧安装失败' }

Write-Host '  ✓ 已写入服务器（权限 600），清掉本机临时文件'
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$health = & $sshExe -o StrictHostKeyChecking=no $Server 'curl -s -m 25 http://127.0.0.1:8420/health'
Write-Host "  桥自检：$health"
