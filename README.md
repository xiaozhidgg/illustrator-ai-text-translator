# AI 文本翻译 · Adobe Illustrator 插件

在 Illustrator 里**一键把画布上的文字翻译成目标语言**，保留原有字体、字号、颜色等格式，自动处理区域文本溢出，支持撤销。

- 兼容 **Illustrator 2023(27.x) ~ 2025(29.x)** 及以后版本（CEP 扩展）
- **默认零配置**：内置 5 个免 Key 免费引擎，自动降级，开箱即用
- **输出大小写**：一键输出大写英文（`SAVE AS`），也可转小写 / 单词首字母大写
- 可接 DeepSeek / 智谱 GLM-4-Flash（免费额度）/ 硅基流动 / DeepL / 本地 Ollama

> 二次开发请看 [`docs/开发文档.md`](docs/开发文档.md)（架构、完整 API 契约、加引擎指南、真机踩坑清单）。

---

## 1. 一键安装

```powershell
# 在仓库根目录执行（PowerShell 5.1 或 7 都可以）
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

脚本会做两件事：

1. 把扩展复制到 `%APPDATA%\Adobe\CEP\extensions\com.dsh.aitranslator`
2. 写入 `HKCU\Software\Adobe\CSXS.{9,10,11,12}\PlayerDebugMode = 1`
   （未签名的 CEP 扩展必须开启调试模式才能被 Illustrator 加载）

然后：

1. **完全退出并重启 Illustrator**
2. 菜单：`窗口(Window) → 扩展功能(Extensions) → AI 文本翻译`
3. 面板顶部显示 `Illustrator 29.8.1 · 脚本就绪` 即安装成功

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Uninstall
```

> 想装到所有用户（需管理员权限）：
> `-Target "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.dsh.aitranslator"`

---

## 2. 怎么用

1. **选范围**：整个文档 / 当前选中 / 当前画板 / 当前图层
2. **选引擎**：默认「自动（免费引擎依次降级）」
3. **选语言**：源语言默认自动识别，目标语言默认简体中文
4. 点 **扫描** → 列表里会显示每个文本对象和它的原文
5. 点 **翻译** → 译文直接写回画布，列表中原文/译文对照
6. 不满意点 **撤销**（可回滚最近 30 次操作）

**点列表里任意一项**，画布会选中对应的文本对象，方便定位。

---

## 3. 翻译引擎

### 3.1 免 Key 免费引擎（默认，本机实测通过）

| 引擎 | 说明 | 实测结果 |
|---|---|---|
| 腾讯交互翻译 Transmart | 支持批量，速度最快 | ✅ 200ms / 批量 40 条 |
| Bing 微软翻译 | 质量高（服务端走 LLM） | ✅ 1.3s；**约 8 条/窗口 后触发限流**（返回空 200），已做冷却+自动降级 |
| 有道翻译 | 响应最快 | ✅ 40~110ms（限流严格，已自动串行） |
| Google 免费接口 | 质量稳定 | ⚠️ 国内直连超时，**必须走代理** |
| MyMemory | 兜底 | ✅ 匿名每天 1000 词额度 |

「自动」模式按 **腾讯 → Bing → 有道 → Google → MyMemory** 依次尝试，某个引擎失败自动换下一个，日志里能看到实际用了哪个。

### 3.2 需要 Key 的引擎（可选，质量更好）

在「引擎设置」里选预设并填 Key：

| 预设 | Base URL | 模型 | 备注 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 便宜、中文质量好 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | **该模型免费** |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | 有免费模型 |
| Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 本地跑，完全离线免费 |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | — |

大模型引擎会把**同一批文本打包成 JSON 数组**一次翻译，保持上下文一致，并可配合术语表。

### 3.3 代理

Google 系接口在国内需要代理。点「**自动检测**」会：

1. 先读 Windows 系统代理设置（`Internet Settings` 注册表）
2. 再扫常见本地端口（7897 / 7890 / 10809 / 1080 …）

网络层还带**通道回退**：填了代理但代理不通，会自动改直连；没填代理但直连失败，会自动试代理。

### 3.4 完全离线：导出 / 导入

点 **导出** → 生成 `ai-translate-<时间>.json`（含原文和空译文）→ 用任意方式翻译好填进 `dst` 字段 → 点 **导入** 写回画布。

导入时优先按对象 ID 匹配，ID 对不上就按**原文逐段比对**匹配，所以关掉重开文件也能用。

---

## 4. 格式保真与溢出处理

### 回写方式

| 方式 | 行为 | 适用 |
|---|---|---|
| **逐段替换**（默认） | 每段单独替换，保留该段自己的字体/字号/颜色 | 混排文本 |
| 整框替换 | 整个文本框一次性替换，保留首字符格式 | 纯文本、追求速度 |

替换前会快照并恢复字符属性（字号、字体、填充色、字距、水平/垂直缩放、基线偏移），避免替换后样式被重置。

### 联排文本框（多个文本框串成一个故事）

插件按 `nextFrame/previousFrame` 把联排框识别为**一个故事**：

- 扫描时把各框文字拼起来整体翻译（保证上下文完整）
- 回写时**从最后一个框往前**逐段写回，避免文字回流导致段号错乱

### 溢出处理

区域文本翻译后通常会变长。四档可选：

| 策略 | 行为 |
|---|---|
| **自动放大文本框**（默认） | 按 1.12 倍逐次放大，最多 3 倍 |
| 自动缩小字号 | 按 0.94 倍逐次缩小，下限 60% |
| 只标记，不修改 | 列表里标「溢出」 |
| 不处理 | — |

> Illustrator 脚本 API **没有** `overflows` 属性（AI 2025 实测为 `undefined`），
> 插件用「可见行字符总数 < 全文长度」判断溢出——隐藏的行不计入 `lines`，实测有效。

### 输出大小写（大写英文）

面板上的「**输出大小写**」下拉，对**最终写回的文本**统一处理：

| 选项 | 效果 |
|---|---|
| 保持原样（默认） | 不处理 |
| **全部大写** | `Save as` → `SAVE AS`，中文/数字/符号不受影响 |
| 全部小写 | `SAVE AS` → `save as` |
| 单词首字母大写 | `save as` → `Save As`（不破坏已大写的词，`OPEN FILES` 保持原样） |

**常见用法**：目标语言选英语 + 输出大小写选「全部大写」＝ 一键产出大写英文文案。

一个关键细节：**原文本来就是英文、又被判定为「无需翻译」的段落，也会被转成大写并写回**。
比如目标选英语时，画布上的 `Save as` 属于「同语种」本会被跳过，但选了大写之后它依然会变成 `SAVE AS`——
否则这个功能在最常见的场景下等于失效。

网址、邮箱、`{占位符}` 除外，它们不会被改大小写（把 URL 改大写可能让链接失效）。

### 自动跳过

默认跳过：空文本、纯数字/符号、网址、邮箱、`{占位符}`、以及**已经是目标语言**的文本。
跨对象重复的文本（比如 10 个按钮都写「Save as」）只请求一次，自动复用译文。

### 术语表

在「高级选项」里一行一条 `原文=译文`：

```
Design=设计
Layer=图层
```

翻译前会把术语替换进原文，让引擎保持译法一致。

---

## 5. 目录结构

```
com.dsh.aitranslator/            扩展本体（安装时整体复制）
├─ CSXS/manifest.xml            宿主声明：ILST 27.0~99.9、CSXS 9.0
├─ .debug                       远程调试端口 8092
├─ panel/
│  ├─ index.html                面板界面
│  ├─ css/panel.css
│  └─ js/
│     ├─ main.js                面板逻辑（扫描/翻译/撤销/导入导出）
│     ├─ core.js                纯文本逻辑（可单测）
│     ├─ http.js                Node 网络层（代理/重定向/重试/节流）
│     ├─ engines.js             5 个免费引擎 + DeepL + 大模型
│     └─ CSInterface.js         CEP 宿主接口
└─ jsx/translator.jsx           画布读写（扫描/回写/溢出/撤销）

tools/
├─ install.ps1                  安装 / 卸载
├─ test-core.mjs                单元测试 + 真实引擎联网测试
├─ test-panel.mjs               jsdom 加载真面板的 UI 全流程测试
├─ probe-engines*.mjs           引擎可用性探测（当时怎么选型的）
├─ debug-bing*.mjs              Bing 限流行为埋点实验
└─ e2e/
   ├─ probe-api.jsx              Illustrator 文本 API 行为探针
   ├─ probe-links.jsx            nextFrame/previousFrame 语义探针
   ├─ e2e-full.jsx               真机端到端测试
   └─ run-e2e.ps1                用 COM 驱动 Illustrator 跑上面的测试

docs/
└─ 开发文档.md                   开发者文档（架构 / API 契约 / 扩展指南 / 踩坑）
```

---

## 6. 开发与验证

### 打包分发给别人

```powershell
powershell -ExecutionPolicy Bypass -File tools\package.ps1
```

会在桌面生成一个可直接分发的目录 `AI翻译插件-AI2023\` 和同名 zip：

```
AI翻译插件-AI2023\
├─ 安装.bat            双击即安装（内部调用 tools\install.ps1）
├─ 卸载.bat
├─ 自检.bat            在真机上跑 21 项端到端断言，用于确认这台机器的 AI 行为一致
├─ 安装说明.txt        图文步骤 + 手动安装 + 排错
├─ 版本信息.txt        版本、宿主声明、验证情况、文件校验清单
├─ com.dsh.aitranslator\
└─ tools\              安装/自检脚本（与仓库同一份）
```

说明：

- 目录结构刻意让 `tools\install.ps1` 能**原样复用**（它按「脚本上一级 = 包根目录」定位扩展），所以包里跑的就是仓库里测过的那份脚本。
- 不需要签名、不需要管理员权限、不需要联网；未签名 CEP 扩展靠 `PlayerDebugMode` 加载。
- **一个包通吃 AI 2023~2025**（manifest 声明 `ILST [27.0,99.9]`），不需要给 2023 单独出一版。
- 打包后建议自检：`$env:TX_EXT_ROOT="<包内扩展目录>"; node tools\test-panel.mjs` 可以直接对包内代码跑 42 项 UI 断言。

### 跑测试

```powershell
npm install                 # 只有面板 UI 测试需要（jsdom），插件本身零依赖

# 单元测试：35 项（离线，不需要联网）
node tools\test-core.mjs

# 真实引擎联网测试：34 项（会真的调用翻译接口，被限流的引擎记为 skip）
node tools\test-core.mjs --network
node tools\test-core.mjs --network --engine=bing      # 只测某个引擎

# 面板 UI 全流程测试：42 项（jsdom 真实加载 index.html，假宿主 + 假网络）
node tools\test-panel.mjs

# 真机端到端：启动 Illustrator，建测试文档，跑 扫描→回写→溢出→撤销：21 项
powershell -ExecutionPolicy Bypass -File tools\e2e\run-e2e.ps1
```

### 各层验证覆盖

| 测试 | 覆盖内容 |
|---|---|
| `test-core.mjs` | 切分、语言识别、可译性过滤、去重、分批、术语表、译文清洗、大小写变换、LLM 输出解析、结果合并 |
| `test-core.mjs --network` | 5 个免费引擎真实调用 + auto 降级链 + 代理自动探测 |
| `test-panel.mjs` | 面板启动、Node 网络层加载（含 `file:///` 路径回归）、引擎/语言下拉、扫描渲染、翻译（去重后只发 1 次请求）、**输出大写两条路径**、apply 载荷正确性、撤销、网络诊断 |
| `e2e-full.jsx` | 真机：联排故事 6 段全部扫描到、译文写进第 2 个框、三段字号 12/30/18 保持、溢出被消除、撤销完全还原、整框替换模式 |

真机测试用 COM 驱动：`tools/e2e/run-e2e.ps1` 会拉起 Illustrator、`GetActiveObject` 连接、`DoJavaScriptFile` 执行脚本并回传 JSON 报告。

### 调试面板

浏览器打开 `http://localhost:8092`（需保持 `.debug` 文件存在），可对面板做 Chrome DevTools 调试。

---

## 7. 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 扩展菜单里找不到 | 没重启 Illustrator；或 `PlayerDebugMode` 没写成功（重跑 `install.ps1`） |
| 面板空白 | 远程调试看报错；确认 `.debug` 与 `CSXS/manifest.xml` 都在 |
| 提示「Node 网络层未加载」 | `manifest.xml` 的 `CEFCommandLine` 需保留 `--enable-nodejs --mixed-context` |
| 所有引擎都失败 | 点「网络诊断」逐条看结果；国内环境给 Google 配代理，或改用腾讯/Bing |
| 有道偶尔失败 | 该接口限流严格，插件已串行+重试；仍失败会自动降级到别的引擎 |
| Bing 翻译一段时间后全部失败 | Bing 有 IP 配额（约 8 条/窗口），超限会返回空响应。插件会自动冷却 5 分钟并降级到其他引擎，日志里能看到原因 |
| 译文写回后样式变了 | 改用「逐段替换」；若该段本身是混排（同一段多种字号），只保留首字符样式 |
| 文本框溢出 | 把「文本溢出」改成「自动放大文本框」或「自动缩小字号」 |
| AI 2023 上打不开 | 确认版本 ≥ 27.0；本插件声明支持 `[27.0,99.9]` |

---

## 8. 已知限制

- Illustrator 脚本 API 不暴露 `overflows`，溢出判断用行字符数推算，极端排版（大量空行）可能误判
- 同一段内混排多种样式时，逐段替换只能保留首字符样式（API 限制）
- 免费接口是第三方公开链路，随时可能调整；插件会自动降级，但建议重要项目用大模型或 DeepL
- 面板 UI 目前是中文，界面尺寸适配窄面板（默认 440×640）

---

## 9. 真机实测记录（Windows + AI 2025 29.8.1，COM 驱动验证）

| 项目 | 实测结论 | 插件里的应对 |
|---|---|---|
| `textFrame.overflows` | **`undefined`（属性不存在）** | 用「可见行字符总数 + 行数 < 全文长度」判断溢出 |
| 联排框 `contents` | 各框只返回**自己那一段**（33 + 638 = 671） | 扫描时拼接所有框，并记录「全局段号 → 框内段号」映射 |
| 联排框 `contents` 的 setter | 同样是**框局部**的：给根框写全文，后续框的旧内容会残留 | 回写/撤销都按框倒序逐框处理 |
| `nextFrame`（未联排） | 返回**自己**（自环）；点文本访问直接抛异常 | 遍历用「自环即停」终止，否则会绕成死循环 |
| `paragraphs[i].contents = x` | 可写，作用于该框所属段落 | 逐段替换模式的基础 |
| 段落级替换后字号 | 保持（12 / 30 / 18 未变） | 替换前快照并恢复字符属性 |
| 5 个免费引擎 | 全部真实翻译成功 | 默认 auto 链，失败自动降级 |

这些结论都来自 `tools/e2e/probe-*.jsx` 与 `e2e-full.jsx` 的真实运行结果，
不是文档推断——其中前三条如果按文档猜，插件会漏译联排框、并把遍历绕成死循环。
