<#
.SYNOPSIS
    把本机 MonkeyCode 桌面端的登录态同步到 magpie 服务器，并让服务器上的插件重新登记。

.DESCRIPTION
    为什么需要这个脚本：
      · magpie 的社区插件 `opencode-monkeycode-auth` **没有 auth.refresh** —— 凭据是登录那一刻
        拷进 plugin-auth.json 的（key + metadata.secret/cookie/base），之后只读这份快照。
      · 服务器上的凭据文件（~/.config/com.chaitin.baizhi.monkeycode/）是本机文件的一次性拷贝，会过期。
      · 本机 MonkeyCode 桌面端**每次启动都会自动续期**会话 cookie（实测 2026-10-30：过期到
        2026-10-14 的 monkeycode_ai_session，启动客户端后变成 2026-11-06，无需手动重新登录），
        但续期只写**本机**文件。

    所以链路是：启动客户端（续期本机 cookie）→ 把文件同步到服务器 → 服务器侧定时器发现文件变了就
    重跑 `magpie plugin login monkeycode 1`（keyless，零交互）把新 cookie 收进 plugin-auth.json。

    两个 cookie 文件各有各的用处：
      monkeycode-cookies.json → monkeycode_ai_session = **B 通道**（monkeycode-ai.com 订阅网关）
                                控制台会话，7 天有效，用于**积分/签到**（推理不受影响）。
      baizhi-cookies.json     → baizhi_session = **A 通道**（baizhi.cloud 百智云钱包）会话，
                                30 天有效，用于**每日领积分**（= A 通道签到，没有它 A 就 400 余额不足）。

.PARAMETER Server
    magpie 服务器，user@host 形式。

.PARAMETER SshKey
    可选：ssh 私钥路径（默认用 ssh-agent / 默认密钥）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/sync-monkeycode-creds.ps1
#>
[CmdletBinding()]
param(
    [string]$Server = 'ubuntu@43.131.227.120',
    [string]$SshKey = ''
)

$ErrorActionPreference = 'Stop'
$AppData = Join-Path $env:APPDATA 'com.chaitin.baizhi.monkeycode'
$ClientExe = 'D:\Software\MokeyCode\MonkeyCode\monkeycode-desktop.exe'
$RemoteDir = '/home/ubuntu/.config/com.chaitin.baizhi.monkeycode'
$Files = @('monkeycode-cookies.json', 'baizhi-cookies.json')

$sshArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-n')
$scpArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
if ($SshKey) { $sshArgs += @('-i', $SshKey); $scpArgs += @('-i', $SshKey) }

function Write-Step($msg) { Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

# ── 1. 启动桌面端（它会自己续期 cookie 文件） ──────────────────────────────
if (Test-Path $ClientExe) {
    $running = Get-Process -Name 'monkeycode-desktop' -ErrorAction SilentlyContinue
    if ($running) {
        Write-Step 'MonkeyCode 客户端已在运行（跳过启动）'
    } else {
        Write-Step '启动 MonkeyCode 客户端，让它续期会话 cookie'
        Start-Process -FilePath $ClientExe
        Start-Sleep -Seconds 12   # 等它写完 cookie 文件
    }
} else {
    Write-Warn2 "找不到客户端 $ClientExe —— 跳过启动（cookie 不会被续期）"
}

# ── 2. 同步文件（只传变了的） ─────────────────────────────────────────────
foreach ($f in $Files) {
    $src = Join-Path $AppData $f
    if (-not (Test-Path $src)) { Write-Warn2 "本机缺少 $f —— 跳过"; continue }

    $localHash = (Get-FileHash -Algorithm SHA256 $src).Hash.ToLower()
    $remoteHash = (& ssh @sshArgs $Server "sha256sum '$RemoteDir/$f' 2>/dev/null | cut -d' ' -f1") 2>$null
    $remoteHash = if ($remoteHash) { "$remoteHash".Trim() } else { '' }

    if ($localHash -eq $remoteHash) {
        Write-Ok "$f 已是最新（sha256 一致）"
        continue
    }

    Write-Step "同步 $f → 服务器"
    & scp @scpArgs $src "${Server}:$RemoteDir/$f"
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "$f 传输失败"; continue }
    & ssh @sshArgs $Server "chmod 600 '$RemoteDir/$f'"
    Write-Ok "$f 已同步（权限 600）"
}

# ── 3. 让服务器上的插件重新登记（把新 cookie 收进 plugin-auth.json） ───────
Write-Step '服务器上重跑 plugin login monkeycode 1（keyless，零交互）'
# 注意 `-n`（ssh stdin 接 /dev/null）与远端 `< /dev/null`：
# 计划任务跑在隐藏窗口里，stdin 是一个不会有人输入的控制台 —— 远端 magpie 会一直等输入而挂住。
# 这两处一起把 stdin 关掉。
& ssh @sshArgs $Server 'export PATH=$PATH:/home/ubuntu/.local/bin; magpie plugin login monkeycode 1 < /dev/null'
if ($LASTEXITCODE -eq 0) {
    Write-Ok '插件已重新登记'
} else {
    Write-Warn2 'plugin login 返回非 0 —— 手动在服务器上重跑一次'
}

Write-Host ''
Write-Step '服务器侧状态'
& ssh @sshArgs $Server 'export PATH=$PATH:/home/ubuntu/.local/bin; magpie quota monkeycode < /dev/null 2>&1 | tail -3'
