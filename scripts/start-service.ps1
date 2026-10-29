# 启动 PlantOmics Hub 服务（本机一键启动）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start-service.ps1
#
# 说明：
#   - 默认从**已安装的 DSH 插件目录**启动，不依赖本仓库是否在原地。
#   - 默认不设 token（只监听 127.0.0.1，仅本机可访问）。
#   - 端口被占用时用 -Port 换一个；换端口后插件侧要配 PLANTOMICS_HUB_URL。
#
# 想开机自启：把本脚本的快捷方式放进
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
# 目标写：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<本脚本完整路径>"

param(
  [int]$Port = 8787,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$cli = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\plantomics-hub\dist\service\cli.js"

if (-not (Test-Path $cli)) {
  Write-Host "[plantomics-hub] 找不到已安装的服务入口：" -ForegroundColor Red
  Write-Host "  $cli"
  Write-Host ""
  Write-Host "说明：包还没装到该 profile，或 profile 名不对（当前 -Profile $Profile）。" -ForegroundColor Yellow
  Write-Host "先在 DSH 插件页安装 plantomics-hub 的 tgz，再运行本脚本。"
  exit 1
}

$env:PLANTOMICS_HUB_PORT = "$Port"

Write-Host "[plantomics-hub] 入口：$cli"
Write-Host "[plantomics-hub] 地址：http://127.0.0.1:$Port/mcp   （健康检查 /healthz）"
Write-Host "[plantomics-hub] 未设 token，仅本机可访问。保持本窗口开着；Ctrl+C 停止。"
Write-Host ""

# 先探一次端口占用，给出人话提示，而不是让 Node 抛 EADDRINUSE 堆栈
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Write-Host "[plantomics-hub] 端口 $Port 已被占用（PID $($inUse[0].OwningProcess)）。" -ForegroundColor Yellow
  Write-Host "  换个端口重试：-Port 8788"
  Write-Host "  注意：换端口后插件里的 PLANTOMICS_HUB_URL 也要指向新地址，否则宿主连不上。"
  exit 1
}

& node $cli
