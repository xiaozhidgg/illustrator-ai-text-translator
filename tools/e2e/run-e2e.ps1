<#
.SYNOPSIS
    在真实 Illustrator 中运行插件的端到端测试（COM 驱动）

.DESCRIPTION
    Illustrator 首次启动很慢，COM 直接 New-Object 会报 CO_E_SERVER_EXEC_FAILURE，
    因此先拉起进程，再反复尝试 GetActiveObject 连接。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\e2e\run-e2e.ps1
#>
[CmdletBinding()]
param(
    [string]$Exe = 'D:\software\Adobe Illustrator 2025\Support Files\Contents\Windows\Illustrator.exe',
    [int]$TimeoutSeconds = 240,
    [string]$Jsx
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Jsx) { $Jsx = Join-Path $scriptDir 'e2e-full.jsx' }
if (-not (Test-Path $Jsx)) { throw "找不到 jsx: $Jsx" }

function Info($m) { Write-Host "[信息] $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "[成功] $m" -ForegroundColor Green }
function Warn2($m) { Write-Host "[注意] $m" -ForegroundColor Yellow }

# 1. 启动进程（若未运行）
$proc = Get-Process -Name 'Illustrator' -ErrorAction SilentlyContinue
if (-not $proc) {
    if (-not (Test-Path $Exe)) { throw "找不到 Illustrator.exe: $Exe" }
    Info "启动 Illustrator：$Exe"
    Start-Process -FilePath $Exe
} else {
    Info "Illustrator 已在运行 (PID $($proc.Id))"
}

# 2. 等待 COM 服务器可用
$ai = $null
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $alive = Get-Process -Name 'Illustrator' -ErrorAction SilentlyContinue
    if (-not $alive) {
        Warn2 'Illustrator 进程已退出，等待重启…'
        Start-Sleep -Seconds 3
        Start-Process -FilePath $Exe
        continue
    }
    try {
        $ai = [Runtime.InteropServices.Marshal]::GetActiveObject('Illustrator.Application')
        if ($ai) { break }
    } catch {
        # 尚未注册到 ROT，继续等待
    }
}

if (-not $ai) {
    Write-Host '[失败] 超时：无法通过 COM 连接 Illustrator' -ForegroundColor Red
    exit 2
}
Ok "COM 已连接：$($ai.Name) $($ai.Version)"

# 3. 执行测试脚本
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$result = $ai.DoJavaScriptFile($Jsx)
$sw.Stop()
Ok ("测试脚本执行完成，耗时 {0:N1}s" -f $sw.Elapsed.TotalSeconds)

$outFile = Join-Path $scriptDir 'e2e-result.json'
[System.IO.File]::WriteAllText($outFile, [string]$result, (New-Object System.Text.UTF8Encoding($false)))
Ok "结果已写入：$outFile"

# 4. 解析并打印断言结果
try {
    $r = [string]$result | ConvertFrom-Json
    Write-Host ''
    Write-Host '--- 断言明细 ---' -ForegroundColor Cyan
    foreach ($a in $r.assertions) {
        $mark = if ($a.pass) { 'PASS' } else { 'FAIL' }
        $color = if ($a.pass) { 'Green' } else { 'Red' }
        $line = '  [{0}] {1}' -f $mark, $a.name
        if ($a.detail) { $line += "  ($($a.detail))" }
        Write-Host $line -ForegroundColor $color
    }
    Write-Host ''
    if ($r.info) {
        Write-Host ("通过 {0} 项，失败 {1} 项" -f $r.info.passCount, $r.info.failCount) -ForegroundColor Yellow
    }
    if ($r.errors -and $r.errors.Count -gt 0) {
        Write-Host '脚本内部错误：' -ForegroundColor Red
        $r.errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    }
    if ($r.info.failCount -gt 0) { exit 1 }
} catch {
    Write-Host "无法解析测试报告：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host $result
    exit 1
}
