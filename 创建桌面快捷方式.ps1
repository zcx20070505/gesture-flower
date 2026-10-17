# ============================================================================
#  在桌面创建「指尖花开」快捷方式
#  用法：右键此文件 → "使用 PowerShell 运行"
# ============================================================================

$ErrorActionPreference = 'Stop'

$appDir   = 'D:\deepseek\gesture-flower'
$batPath  = Join-Path $appDir '启动指尖花开.bat'
$iconPath = Join-Path $appDir 'icon.ico'
$desktop  = [Environment]::GetFolderPath('Desktop')
$lnkPath  = Join-Path $desktop '指尖花开.lnk'

Write-Host ''
Write-Host '  正在创建桌面快捷方式...' -ForegroundColor Cyan
Write-Host ''

# ---- 前置检查 ----
if (-not (Test-Path $batPath)) {
  Write-Host "  [错误] 找不到启动脚本：$batPath" -ForegroundColor Red
  Read-Host '  按回车退出'
  exit 1
}
if (-not (Test-Path $iconPath)) {
  Write-Host "  [提示] 找不到图标，将使用默认图标（可运行 node make-icon.mjs 生成）" -ForegroundColor Yellow
  $iconPath = $null
}

# ---- 创建快捷方式 ----
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)

  $lnk.TargetPath       = $batPath
  $lnk.WorkingDirectory = $appDir
  $lnk.Description      = '指尖花开 - 手势控制的粒子花朵（握拳闭合，张开五指绽放）'
  $lnk.WindowStyle      = 7          # 7 = 最小化启动（避免黑窗口弹出来抢焦点）
  if ($iconPath) { $lnk.IconLocation = "$iconPath,0" }
  $lnk.Save()

  Write-Host '  [成功] 桌面快捷方式已创建：' -ForegroundColor Green
  Write-Host "         $lnkPath" -ForegroundColor White
  Write-Host ''
  Write-Host '  现在可以双击桌面上的「指尖花开」启动了。' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  使用提示：' -ForegroundColor Gray
  Write-Host '    · 首次打开浏览器会询问摄像头权限，请点「允许」' -ForegroundColor Gray
  Write-Host '    · 关闭那个黑色命令行窗口 = 退出程序' -ForegroundColor Gray
  Write-Host '    · 不想授权摄像头也可以拖动滑块手动体验' -ForegroundColor Gray
  Write-Host ''
}
catch {
  Write-Host "  [错误] 创建失败：$($_.Exception.Message)" -ForegroundColor Red
  Read-Host '  按回车退出'
  exit 1
}

Read-Host '  按回车关闭此窗口'
