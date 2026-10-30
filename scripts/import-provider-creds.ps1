# 把本机 MonkeyCode / Genspark 登录态复制到 magpie 服务器（供插件读取）
#
# 用法（本机 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts/import-provider-creds.ps1
#
# 为什么需要这一步：
#   · monkeycode 插件的登录方式 1「读取本机 MonkeyCode 客户端登录态」在 Linux 上
#     找的是 ~/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json
#     与同目录上一层的 monkeycode-cookies.json。
#   · genspark 插件的登录方式「复用 Genspark App 当前登录」读的是
#     ~/Library/Application Support/gensparkaio/spaces/gencode/gsk/profile/config.json
#     （路径写死在插件里，macOS 布局；Linux 上照抄该相对路径即可命中）。
#
# 复制的是凭据文件本身 —— 落地后请在服务器上 chmod 600。
#
# 注：Claude Code 会话内的 scp 到该主机被安全策略硬阻断（凭据文件外传），
#     所以这一步必须由人在自己的终端里跑。

$ErrorActionPreference = 'Stop'

$Server = 'ubuntu@43.131.227.120'
$AppData = $env:APPDATA
$Home = '/home/ubuntu'

$Items = @(
    @{
        Name = 'monkeycode settings.json'
        Src  = Join-Path $AppData 'com.chaitin.baizhi.monkeycode\ohmyagent\settings.json'
        Dst  = "$Home/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json"
    }
    @{
        Name = 'monkeycode cookies.json'
        Src  = Join-Path $AppData 'com.chaitin.baizhi.monkeycode\monkeycode-cookies.json'
        Dst  = "$Home/.config/com.chaitin.baizhi.monkeycode/monkeycode-cookies.json"
    }
    @{
        Name = 'genspark gsk profile config.json'
        Src  = Join-Path $AppData 'gensparkaio\spaces\gencode\gsk\profile\config.json'
        Dst  = "$Home/Library/Application Support/gensparkaio/spaces/gencode/gsk/profile/config.json"
    }
)

function Invoke-Scp($src, $dst) {
    scp -o StrictHostKeyChecking=no $src "$Server`:$dst"
    return $LASTEXITCODE -eq 0
}

# 预检：控制台 cookie（用于查积分 / 签到）带自己的过期时间。
# 过期时复制过去的也只是废值 —— 插件按 expires 判活，会静默丢弃 ⇒ 必须先在
# MonkeyCode 客户端重新登录，再跑本脚本。只打印日期，不打印 cookie 值。
function Show-CookieExpiry {
    $cookieFile = Join-Path $env:APPDATA 'com.chaitin.baizhi.monkeycode\monkeycode-cookies.json'
    if (-not (Test-Path $cookieFile)) { return }
    try {
        $items = Get-Content $cookieFile -Raw | ConvertFrom-Json
        $item = $items | Where-Object { $_.name -eq 'monkeycode_ai_session' } | Select-Object -First 1
        if (-not $item) { Write-Host '! 找不到 monkeycode_ai_session（积分 / 签到将不可用）'; return }
        $exp = $item.expires
        if (-not $exp) { Write-Host '! cookie 无 expires 字段（插件按不判活处理）'; return }
        $at = [datetime]::Parse($exp).ToUniversalTime()
        if ($at -le (Get-Date).ToUniversalTime()) {
            Write-Host "! 控制台 cookie 已过期（$exp）—— 请先在 MonkeyCode 客户端重新登录再跑本脚本，否则积分 / 签到不可用" -ForegroundColor Yellow
        } else {
            Write-Host "→ 控制台 cookie 有效期至 $exp"
        }
    } catch {
        Write-Host '! 无法解析 cookie 文件（不影响推理凭据的复制）'
    }
}

function Invoke-Sftp($src, $dst) {
    # sftp 批处理模式：put 的远端路径带空格时必须引号包住
    $srcFwd = $src -replace '\\', '/'
    $batch = Join-Path $env:TEMP ("magpie-sftp-{0}.txt" -f (Get-Random))
    "put `"$srcFwd`" `"$dst`"" | Set-Content -Path $batch -Encoding ascii
    sftp -o StrictHostKeyChecking=no -b $batch $Server
    $rc = $LASTEXITCODE
    Remove-Item $batch -ErrorAction SilentlyContinue
    return $rc -eq 0
}

# 服务器侧目标目录（含带空格的 genspark 路径）
ssh $Server "mkdir -p '$Home/.config/com.chaitin.baizhi.monkeycode/ohmyagent' '$Home/Library/Application Support/gensparkaio/spaces/gencode/gsk/profile'"
if ($LASTEXITCODE -ne 0) { throw '服务器目录创建失败' }

Show-CookieExpiry

$failed = @()
foreach ($item in $Items) {
    if (-not (Test-Path $item.Src)) { throw "本机源文件不存在：$($item.Src)" }
    $localSize = (Get-Item $item.Src).Length
    Write-Host "→ $($item.Name)  ($localSize bytes)"

    $ok = Invoke-Scp $item.Src $item.Dst
    if (-not $ok) {
        Write-Host '  scp 失败，改用 sftp 重试…'
        $ok = Invoke-Sftp $item.Src $item.Dst
    }
    if (-not $ok) { $failed += $item.Name; continue }

    # 校验远端大小一致（只看数字，不看内容）
    $remoteSize = (ssh $Server "wc -c < '$($item.Dst)'" | Out-String).Trim()
    if ([int64]$remoteSize -ne $localSize) {
        $failed += "$($item.Name)（大小不符：远端 $remoteSize / 本地 $localSize）"
        continue
    }
    Write-Host "  ✓ 已到位（$remoteSize bytes）"
}

ssh $Server "chmod 600 '$Home/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json' '$Home/.config/com.chaitin.baizhi.monkeycode/monkeycode-cookies.json' '$Home/Library/Application Support/gensparkaio/spaces/gencode/gsk/profile/config.json'"

if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host ("以下文件未成功复制：" + ($failed -join '、')) -ForegroundColor Red
    Write-Host '请检查网络/主机密钥后再跑一次本脚本。'
    exit 1
}

Write-Host ''
Write-Host '复制完成。接下来在服务器上执行（登录 + 验证）：'
Write-Host '  export PATH=$PATH:/home/ubuntu/.local/bin'
Write-Host '  magpie plugin login monkeycode 1'
Write-Host '  magpie plugin login genspark-llm-proxy 1'
Write-Host '  magpie plugin login genspark-gemini-proxy 1'
Write-Host '  magpie daemon restart'
Write-Host '  magpie providers'
Write-Host '  magpie provider test monkeycode'
Write-Host '  magpie provider test genspark-llm-proxy'
