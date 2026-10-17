# ============================================================================
#  指尖花开 · 桌面启动器
# ----------------------------------------------------------------------------
#  做三件事：
#    1. 起一个本地 HTTP 服务（摄像头必须走 http:// 才能用，file:// 不行）
#    2. 用 Edge 的「应用模式」打开，没有地址栏，看起来像原生程序
#    3. 脚本退出时自动关掉后台服务，不留残留进程
#
#  为什么用 PowerShell 而不是 .bat：
#    cmd.exe 按系统 ANSI 代码页（中文 Windows 是 GBK）解析 .bat 文件，
#    UTF-8 保存的中文会被读成乱码甚至导致语法错误。PowerShell 能正确处理 UTF-8。
# ============================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- 配置
$AppDir   = 'D:\deepseek\gesture-flower'
$Port     = 5500
$Python   = 'C:\Users\zcx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$EdgeExe  = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

$Url      = "http://127.0.0.1:$Port/"
$proc     = $null          # 后台 HTTP 服务进程

# ---------------------------------------------------------------- 工具函数
function Write-Head($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor Cyan }
function Write-OK($text)   { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [提示] $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  [错误] $text" -ForegroundColor Red }

# 退出前清理：确保不留后台进程
function Stop-Server {
  if ($script:proc -and -not $script:proc.HasExited) {
    try {
      Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue
      Write-Host '  后台服务已关闭。' -ForegroundColor DarkGray
    } catch { }
  }
  # 兜底：按端口清理（万一进程句柄丢了）
  try {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# ---------------------------------------------------------------- 主流程
try {
  Clear-Host
  Write-Host ''
  Write-Host '  ============================================' -ForegroundColor Magenta
  Write-Host '     指尖花开 · 手势控制的粒子花朵' -ForegroundColor Magenta
  Write-Host '  ============================================' -ForegroundColor Magenta

  # ---- 1. 检查文件 ----
  if (-not (Test-Path (Join-Path $AppDir 'index.html'))) {
    Write-Err "找不到程序文件：$AppDir\index.html"
    Write-Host '         项目可能被移动或删除了。' -ForegroundColor DarkGray
    Write-Host ''
    Read-Host '  按回车退出'
    exit 1
  }

  # ---- 2. 准备 Python ----
  if (-not (Test-Path $Python)) {
    $sysPython = Get-Command python -ErrorAction SilentlyContinue
    if ($sysPython) {
      $Python = $sysPython.Source
      Write-Warn2 "没找到内置 Python，改用系统 Python：$Python"
    } else {
      Write-Err '系统里没有可用的 Python。'
      Write-Host '         请安装 Python，或手动执行：' -ForegroundColor DarkGray
      Write-Host "           cd /d $AppDir" -ForegroundColor DarkGray
      Write-Host "           python -m http.server $Port" -ForegroundColor DarkGray
      Write-Host ''
      Read-Host '  按回车退出'
      exit 1
    }
  }

  # ---- 3. 端口是否已被占用（程序可能已经在跑）----
  $existing = $null
  try {
    $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  } catch { }

  if ($existing) {
    Write-Warn2 "端口 $Port 已被占用。"
    # 判断是不是本项目遗留的服务：能取到 index.html 就认为是我们自己的
    $isOurs = $false
    try {
      $probe = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if ($probe.StatusCode -eq 200 -and $probe.Content -match '指尖花开') { $isOurs = $true }
    } catch { }

    if ($isOurs) {
      Write-Host '         检测到程序已在运行，直接打开界面。' -ForegroundColor DarkGray
    } else {
      Write-Warn2 "该端口被别的程序占用（不是本程序），请先关闭它。"
      Write-Host ''
      Read-Host '  按回车退出'
      exit 1
    }
  }
  else {
    # ---- 4. 启动 HTTP 服务（无窗口）----
    Write-Host ''
    Write-Host "  [1/2] 正在启动本地服务（端口 $Port）..." -ForegroundColor Gray

    # 优先用项目自带的 serve.py（带父进程监视，不会留僵尸进程）
    $serveScript = Join-Path $AppDir 'serve.py'
    if (Test-Path $serveScript) {
      $proc = Start-Process -FilePath $Python `
        -ArgumentList $serveScript, '--port', $Port, '--parent', $PID `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden -PassThru
    } else {
      # 兜底：用标准库的 http.server
      $proc = Start-Process -FilePath $Python `
        -ArgumentList '-m', 'http.server', $Port, '--bind', '127.0.0.1' `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden -PassThru
    }

    # ---- 5. 等服务就绪（最多 15 秒）----
    $ready = $false
    for ($i = 1; $i -le 30; $i++) {
      Start-Sleep -Milliseconds 500
      if ($proc.HasExited) {
        Write-Err "服务启动失败（退出码 $($proc.ExitCode)）。"
        Write-Host "         端口 $Port 可能被防火墙或其他程序拦截。" -ForegroundColor DarkGray
        Write-Host ''
        Read-Host '  按回车退出'
        exit 1
      }
      try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
      } catch { }
    }

    if (-not $ready) {
      Write-Err '服务启动超时（15 秒）。'
      Write-Host ''
      Read-Host '  按回车退出'
      exit 1
    }
    Write-OK "服务已就绪（PID $($proc.Id)）"
  }

  # ---- 6. 打开界面 ----
  Write-Host '  [2/2] 正在打开界面...' -ForegroundColor Gray

  if (Test-Path $EdgeExe) {
    # --app 模式：无地址栏、无标签页，像原生程序
    Start-Process -FilePath $EdgeExe `
      -ArgumentList "--app=$Url", '--window-size=1280,880' | Out-Null
  } else {
    Write-Warn2 '没找到 Edge，改用默认浏览器打开。'
    Start-Process $Url | Out-Null
  }

  Write-Host ''
  Write-Host '  ============================================' -ForegroundColor Magenta
  Write-Host '   程序已启动！' -ForegroundColor White
  Write-Host ''
  Write-Host '   在打开的窗口里点「开始体验」，' -ForegroundColor Gray
  Write-Host '   然后允许摄像头权限即可。' -ForegroundColor Gray
  Write-Host ''
  Write-Host '   握拳 = 花苞闭合   张开五指 = 粒子绽放' -ForegroundColor Gray
  Write-Host ''
  Write-Host '   ● 关闭本窗口 = 退出程序' -ForegroundColor Yellow
  Write-Host '  ============================================' -ForegroundColor Magenta
  Write-Host ''

  # ---- 7. 挂起，直到用户关窗口；期间保持服务存活 ----
  while ($true) {
    Start-Sleep -Seconds 2
    # 浏览器关掉后这里依然挂着；用户关窗口时脚本被终止，finally 会清理
  }
}
finally {
  Stop-Server
}
