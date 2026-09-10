<#
.SYNOPSIS
    打包「AI 文本翻译」插件为可分发安装包

.DESCRIPTION
    生成一个开箱即用的目录（默认放到桌面）：
        AI翻译插件-AI2023\
        ├─ 安装.bat               双击即安装
        ├─ 卸载.bat
        ├─ 自检.bat               在真机上跑 21 项端到端断言（可选）
        ├─ 安装说明.txt
        ├─ 版本信息.txt
        ├─ com.dsh.aitranslator\  扩展本体
        └─ tools\                 安装/自检脚本（与仓库同一份，已测过）

    目录结构刻意让 tools\install.ps1 能原样复用（它按「脚本上一级 = 包根目录」找扩展）。

.PARAMETER OutputDir
    输出目录（默认 桌面\AI翻译插件-AI2023）

.PARAMETER NoZip
    不生成同名 zip

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\package.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputDir,
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$bundleId = 'com.dsh.aitranslator'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$sourceExt = Join-Path $repoRoot $bundleId

if (-not $OutputDir) {
    $OutputDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI翻译插件-AI2023'
}

function Info($m) { Write-Host "[信息] $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "[成功] $m" -ForegroundColor Green }
function Die($m) { Write-Host "[错误] $m" -ForegroundColor Red; exit 1 }

$utf8Bom = New-Object System.Text.UTF8Encoding($true)
function Write-TextFile($path, $content) {
    [System.IO.File]::WriteAllText($path, $content, $utf8Bom)
}

# ---------------------------------------------------------------- 检查源
if (-not (Test-Path $sourceExt)) { Die "找不到扩展目录：$sourceExt" }
if (-not (Test-Path (Join-Path $sourceExt 'CSXS\manifest.xml'))) { Die '扩展目录缺少 CSXS\manifest.xml' }
$installer = Join-Path $scriptDir 'install.ps1'
if (-not (Test-Path $installer)) { Die "找不到安装脚本：$installer" }

# 从 manifest 读取宿主版本声明，写进说明里
$manifestText = Get-Content (Join-Path $sourceExt 'CSXS\manifest.xml') -Raw -Encoding UTF8
$hostVersion = '未知'
$m = [regex]::Match($manifestText, 'Name="ILST"\s+Version="([^"]+)"')
if ($m.Success) { $hostVersion = $m.Groups[1].Value }

# ---------------------------------------------------------------- 组装
Info "输出目录：$OutputDir"
if (Test-Path $OutputDir) {
    Info '目录已存在，先清理…'
    Remove-Item -Recurse -Force $OutputDir
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

Copy-Item -Path $sourceExt -Destination (Join-Path $OutputDir $bundleId) -Recurse -Force
Ok '扩展本体已复制'

$toolsDir = Join-Path $OutputDir 'tools'
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
Copy-Item -Path $installer -Destination (Join-Path $toolsDir 'install.ps1') -Force

# 可选：真机自检工具（用于在 AI 2023 上确认行为一致）
$e2eSrc = Join-Path $scriptDir 'e2e'
$hasE2E = $false
if ((Test-Path (Join-Path $e2eSrc 'run-e2e.ps1')) -and (Test-Path (Join-Path $e2eSrc 'e2e-full.jsx'))) {
    $e2eDst = Join-Path $toolsDir 'e2e'
    New-Item -ItemType Directory -Path $e2eDst -Force | Out-Null
    Copy-Item (Join-Path $e2eSrc 'run-e2e.ps1') $e2eDst -Force
    Copy-Item (Join-Path $e2eSrc 'e2e-full.jsx') $e2eDst -Force
    $hasE2E = $true
}
Ok '安装脚本已复制'

# ---------------------------------------------------------------- 批处理入口
# 说明：批处理里保持纯 ASCII，不切 code page —— 中文 Windows 控制台默认 GBK，
# 而 install.ps1 是 UTF-8 BOM，PowerShell 输出中文本来就正常，切 65001 反而会乱码。
$installBat = @"
@echo off
title AI Text Translator - Install
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1"
echo.
pause
"@
Write-TextFile (Join-Path $OutputDir '安装.bat') $installBat

$uninstallBat = @"
@echo off
title AI Text Translator - Uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -Uninstall
echo.
pause
"@
Write-TextFile (Join-Path $OutputDir '卸载.bat') $uninstallBat

if ($hasE2E) {
    $selftestBat = @"
@echo off
title AI Text Translator - Self Test
echo This will launch Illustrator and run 21 end-to-end checks.
echo Close Illustrator documents first. Press Ctrl+C to abort.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\e2e\run-e2e.ps1"
echo.
pause
"@
    Write-TextFile (Join-Path $OutputDir '自检.bat') $selftestBat
}

# ---------------------------------------------------------------- 说明文件
$version = '1.0.0'
try {
    $pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg.version) { $version = $pkg.version }
} catch { }

$readme = @"
========================================================
 AI 文本翻译 · Adobe Illustrator 插件  v$version
========================================================

【这个包是什么】
  一个 Illustrator 扩展（CEP 面板），把画布上的文字批量翻译成目标语言，
  保留原有字体/字号/颜色，自动处理文本框溢出，支持撤销，
  并且可以把输出统一转成大写英文（SAVE AS）。

【支持的 Illustrator 版本】
  宿主版本声明：$hostVersion
  → Illustrator 2023(27.x)、2024(28.x)、2025(29.x) 及以后版本通用。
    不需要为 2023 单独装另一个版本，这一个包就是。
  → 注意：AI 2023 的宿主版本号是 27.x（23.x 是 2019 版）。

【30 秒安装】
  1) 双击本目录里的「安装.bat」
     （如果没反应或报权限错误，见下面「手动安装」）
  2) 完全退出 Illustrator（不是关文档，是退出程序）
  3) 重新打开 Illustrator
  4) 菜单：窗口(Window) → 扩展功能(Extensions) → AI 文本翻译
  5) 面板顶部显示 "Adobe Illustrator 27.x · 脚本就绪" 即安装成功
     （版本号随你自己的 AI 版本变化：2023 显示 27.x，2025 显示 29.x）

【安装脚本实际做了什么】
  1. 把 com.dsh.aitranslator 复制到
     %APPDATA%\Adobe\CEP\extensions\com.dsh.aitranslator
  2. 写入注册表 HKCU\Software\Adobe\CSXS.{9,10,11,12}\PlayerDebugMode = 1
     （AI 2023 用 CSXS.11，2025 用 CSXS.12；未签名的 CEP 扩展必须开这个才加载）
  3. 不需要管理员权限，不需要联网

【手动安装（脚本跑不了时）】
  1. 按 Win+R，输入下面这行后回车，打开扩展目录：
         %APPDATA%\Adobe\CEP\extensions
     （如果没有 extensions 文件夹，手动新建一个）
  2. 把本目录里的 com.dsh.aitranslator 整个文件夹复制进去
     最终路径应为：
         ...\Adobe\CEP\extensions\com.dsh.aitranslator\CSXS\manifest.xml
  3. 按 Win+R，输入 regedit 回车，找到：
         HKEY_CURRENT_USER\Software\Adobe\CSXS.11
     （若 CSXS.11 不存在就新建这一项）
     在里面新建「字符串值」PlayerDebugMode，值为 1
     同样处理 CSXS.9 / CSXS.10 / CSXS.12（存在就改，不存在可跳过）
  4. 重启 Illustrator

【怎么用】
  1. 选范围（整个文档 / 当前选中 / 当前画板 / 当前图层）
  2. 引擎保持「自动（免费引擎依次降级）」即可，零配置
  3. 目标语言选中文（默认）或英语等
  4. 想输出大写英文：把「输出大小写」设成「全部大写」
  5. 点「扫描」→ 检查列表 → 点「翻译」
  6. 不满意点「撤销」（可回滚最近 30 次）

【免费引擎说明】
  默认使用 5 个免 Key 免费引擎，按顺序自动降级：
     腾讯交互翻译 → Bing 微软翻译 → 有道翻译 → Google → MyMemory
  · 腾讯/Bing/有道 国内直连可用
  · Google 需要代理（面板高级选项里可填，或点「自动检测」）
  · Bing 有 IP 配额，约 8 条后可能限流，插件会自动冷却并换下一个引擎
  想要更高质量可在「引擎设置」里填 DeepSeek / 智谱 GLM-4-Flash（有免费额度）等。

【装不上 / 面板空白怎么查】
  · 菜单里没有「AI 文本翻译」→ 没重启 Illustrator，或 PlayerDebugMode 没写成功
  · 面板空白 → 浏览器打开 http://localhost:8092 可远程调试看报错
  · 提示「Node 网络层未加载」→ 把面板日志里的「扩展目录原始值 / 已尝试路径」发出来
  · 翻译全部失败 → 点面板里的「网络诊断」，逐条看哪个引擎不通

【可选：在 AI 2023 上做真机自检】
  本机只在 AI 2025 上做过真机验证。如果你要在 2023 上确认行为一致：
  1) 先完成安装并重启 Illustrator
  2) 双击「自检.bat」
     它会启动 Illustrator、自动建测试文档、跑 21 项断言
     （所有段落写回、字号保持、溢出处理、撤销还原、整框替换等）
  3) 看到「通过 21 项，失败 0 项」即为通过
  自检脚本默认找 2025 的安装路径；2023 请用命令行指定：
     powershell -ExecutionPolicy Bypass -File tools\e2e\run-e2e.ps1 -Exe "你的2023安装路径\Support Files\Contents\Windows\Illustrator.exe"

【卸载】
  1) 双击「卸载.bat」
  2) 重启 Illustrator
  （可选：把 HKCU\Software\Adobe\CSXS.*\PlayerDebugMode 改回 0）

【目录说明】
  安装.bat / 卸载.bat          一键安装卸载
  自检.bat                     真机端到端自检（可选）
  com.dsh.aitranslator\        扩展本体（可整体拷贝到别的机器）
  tools\install.ps1            安装脚本本体
  tools\e2e\                   自检工具

========================================================
"@
Write-TextFile (Join-Path $OutputDir '安装说明.txt') $readme

$versionInfo = @"
包名        : AI 文本翻译（Adobe Illustrator 插件）
版本        : $version
打包时间    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
宿主声明    : ILST $hostVersion
扩展 ID     : $bundleId
安装目标    : %APPDATA%\Adobe\CEP\extensions\$bundleId
调试端口    : 8092

真机验证情况
  · Illustrator 2025 (29.8.1)：21 项端到端断言全部通过
  · Illustrator 2023/2024：按同一套 CEP + 同一份 manifest 声明支持，
    未在本机验证（本机只装了 2025）。可用「自检.bat」自行确认。

包内文件校验（大小 / 相对路径）
"@
$files = Get-ChildItem $OutputDir -Recurse -File | Where-Object { $_.Name -ne '版本信息.txt' } |
    Sort-Object FullName |
    ForEach-Object { "{0,8}  {1}" -f $_.Length, $_.FullName.Substring($OutputDir.Length + 1) }
$versionInfo += "`r`n" + ($files -join "`r`n")
Write-TextFile (Join-Path $OutputDir '版本信息.txt') $versionInfo

Ok '说明文件已生成'

# ---------------------------------------------------------------- 打包 zip
if (-not $NoZip) {
    $zipPath = "$OutputDir.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path (Join-Path $OutputDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
    Ok "已生成压缩包：$zipPath  ($([math]::Round((Get-Item $zipPath).Length/1KB,1)) KB)"
}

# ---------------------------------------------------------------- 结果
Write-Host ''
Ok '打包完成，目录结构：'
Get-ChildItem $OutputDir | ForEach-Object {
    if ($_.PSIsContainer) { Write-Host "  [目录] $($_.Name)" } else { Write-Host "  [文件] $($_.Name)" }
}
Write-Host ''
Write-Host "安装方法：双击「$(Join-Path $OutputDir '安装.bat')」，然后重启 Illustrator" -ForegroundColor Yellow
