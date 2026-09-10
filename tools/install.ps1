<#
.SYNOPSIS
    安装「AI 文本翻译」CEP 扩展（无需签名，通过 PlayerDebugMode 加载）

.DESCRIPTION
    1. 把扩展复制到 %APPDATA%\Adobe\CEP\extensions\com.dsh.aitranslator
    2. 写入 HKCU\Software\Adobe\CSXS.{9,10,11,12}\PlayerDebugMode = 1
       （未签名的 CEP 扩展必须开启调试模式才能被 Illustrator 加载）

.PARAMETER Target
    自定义安装目录（默认用户级 CEP 扩展目录）

.PARAMETER Uninstall
    卸载：删除已安装目录

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install.ps1
    powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Target,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$bundleId = 'com.dsh.aitranslator'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$sourceDir = Join-Path $repoRoot $bundleId

if (-not $Target) {
    $Target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$bundleId"
}

function Write-Info($msg) { Write-Host "[信息] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[成功] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[注意] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[错误] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
    if (Test-Path $Target) {
        Remove-Item -Recurse -Force $Target
        Write-Ok "已删除扩展目录：$Target"
    } else {
        Write-Warn2 "未找到已安装目录：$Target"
    }
    Write-Info '如需彻底恢复，可把 HKCU\Software\Adobe\CSXS.*\PlayerDebugMode 改回 0'
    return
}

# ---------------------------------------------------------------- 检查源目录
if (-not (Test-Path $sourceDir)) {
    Write-Err "找不到扩展源目录：$sourceDir"
    Write-Info '请在仓库根目录下运行本脚本（目录名应为 com.dsh.aitranslator）'
    exit 1
}

$manifest = Join-Path $sourceDir 'CSXS\manifest.xml'
if (-not (Test-Path $manifest)) {
    Write-Err "缺少 CSXS\manifest.xml：$manifest"
    exit 1
}

# ---------------------------------------------------------------- 提示关闭 Illustrator
$running = Get-Process -Name 'Illustrator' -ErrorAction SilentlyContinue
if ($running) {
    Write-Warn2 '检测到 Illustrator 正在运行，安装后需要完全重启 Illustrator 才会生效'
}

# ---------------------------------------------------------------- 复制文件
Write-Info "安装到：$Target"
if (Test-Path $Target) {
    Write-Info '目标目录已存在，先清理旧版本…'
    Remove-Item -Recurse -Force $Target
}
New-Item -ItemType Directory -Path $Target -Force | Out-Null
Copy-Item -Path (Join-Path $sourceDir '*') -Destination $Target -Recurse -Force
Write-Ok '扩展文件已复制'

# ---------------------------------------------------------------- 开启 PlayerDebugMode
$csxsVersions = 9..12
foreach ($v in $csxsVersions) {
    $regPath = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    New-ItemProperty -Path $regPath -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}
Write-Ok "已开启 PlayerDebugMode（CSXS 9~12）"

# ---------------------------------------------------------------- 完成提示
Write-Host ''
Write-Ok '安装完成！接下来的步骤：'
Write-Host '  1. 完全退出并重新启动 Illustrator'
Write-Host '  2. 打开菜单：窗口(Window) → 扩展功能(Extensions) → AI 文本翻译'
Write-Host '  3. 面板顶部应显示 “Illustrator 29.x · 脚本就绪”'
Write-Host ''
Write-Info "安装目录：$Target"
Write-Info '调试：浏览器打开 http://localhost:8092 可对面板做远程调试'
