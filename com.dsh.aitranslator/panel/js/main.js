/**
 * main.js — 面板逻辑（CEP 面板内运行）
 *
 * 分工：
 *   core.js    纯文本逻辑（切分/过滤/去重/合并）
 *   http.js    Node 网络层（代理 / 重试 / 节流）
 *   engines.js 各翻译引擎适配
 *   translator.jsx  画布读写（扫描 / 回写 / 溢出 / 撤销）
 */
(function () {
    'use strict';

    var cs = new CSInterface();
    var TXHttp = null;
    var TXEngines = null;
    var hostReady = false;

    var state = {
        items: [],            // 扫描结果
        checked: {},          // itemId -> bool
        translations: {},     // itemId -> { paraIndex -> 译文 }
        skipped: [],          // 被跳过的段落
        lastEngine: '',
        busy: false,
    };

    var LANG_OPTIONS = [
        ['auto', '自动识别'],
        ['zh-CN', '简体中文'],
        ['zh-TW', '繁体中文'],
        ['en', '英语'],
        ['ja', '日语'],
        ['ko', '韩语'],
        ['fr', '法语'],
        ['de', '德语'],
        ['es', '西班牙语'],
        ['ru', '俄语'],
        ['it', '意大利语'],
        ['pt', '葡萄牙语'],
    ];

    var PRESET_FIELDS = {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
        siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
        ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    };

    /* ================================================================
     * DOM 快捷方法
     * ================================================================ */
    function $(id) { return document.getElementById(id); }
    function on(id, evt, fn) { var el = $(id); if (el) el.addEventListener(evt, fn); }

    function setStatus(msg, kind) {
        var el = $('status');
        el.textContent = msg;
        el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function setProgress(ratio) {
        $('progressBar').style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
    }

    function log(msg, kind) {
        var box = $('log');
        box.classList.add('show');
        var line = document.createElement('div');
        if (kind) line.className = 'line-' + kind;
        line.textContent = msg;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
        while (box.childNodes.length > 300) box.removeChild(box.firstChild);
    }

    function busy(flag) {
        state.busy = flag;
        $('btnScan').disabled = flag;
        $('btnTranslate').disabled = flag || state.items.length === 0;
        $('btnUndo').disabled = flag;
        $('btnExport').disabled = flag || state.items.length === 0;
    }

    /* ================================================================
     * 宿主通信
     * ================================================================ */
    /** 生成安全的 ExtendScript 字符串字面量（转义 U+2028/2029，否则 ES3 会报语法错） */
    function jsLiteral(str) {
        return JSON.stringify(String(str))
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    function callHost(method, arg, cb) {
        var script = 'TX.' + method + '(' + jsLiteral(arg === undefined ? '' : JSON.stringify(arg)) + ')';
        cs.evalScript(script, function (raw) {
            var data = null;
            try {
                data = raw ? JSON.parse(raw) : null;
            } catch (e) {
                log('宿主返回无法解析：' + String(raw).slice(0, 200), 'err');
                data = { ok: false, error: '宿主返回无法解析' };
            }
            if (cb) cb(data);
        });
    }

    function callHostAsync(method, arg) {
        return new Promise(function (resolve) {
            callHost(method, arg, resolve);
        });
    }

    /**
     * 把 CEP 返回的路径规范成 Node require 能用的本地路径。
     * 真机上 getSystemPath 返回的是 file:///C:/… 形式的 URL（CSInterface 已处理），
     * 这里再兜一层，防止路径形态在不同 CEP 版本间变化。
     */
    function toLocalPath(p) {
        if (!p) return '';
        var s = String(p);
        try { s = decodeURI(s); } catch (e) { }
        s = s.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
        if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
        return s.replace(/\\/g, '/');
    }

    /** CEP 面板里通过 Node 加载网络层 */
    function loadNodeModules() {
        var attempted = [];
        try {
            var req = null;
            if (typeof require === 'function') {
                req = require;
            } else if (window.cep_node && typeof window.cep_node.require === 'function') {
                req = window.cep_node.require;
            }
            if (!req) throw new Error('Node.js 未启用（manifest 需 --enable-nodejs --mixed-context）');

            var rawPath = cs.getSystemPath(SystemPath.EXTENSION);
            if (!rawPath) throw new Error('无法获取扩展目录（getSystemPath 返回空）');
            var extPath = toLocalPath(rawPath);

            // 依次尝试：扩展根目录 → 逐级向上找（兼容安装在多一层子目录的情况）
            var candidates = [extPath];
            var up = extPath;
            for (var i = 0; i < 2; i++) {
                up = up.replace(/\/[^\/]+$/, '');
                if (up && up !== extPath && candidates.indexOf(up) === -1) candidates.push(up);
            }

            var lastErr = null;
            for (var c = 0; c < candidates.length && !TXHttp; c++) {
                var base = candidates[c];
                var httpPath = base + '/panel/js/http.js';
                attempted.push(httpPath);
                try {
                    TXHttp = req(httpPath);
                    TXEngines = req(base + '/panel/js/engines.js');
                } catch (e) {
                    TXHttp = null;
                    TXEngines = null;
                    lastErr = e;
                }
            }
            if (!TXHttp) throw lastErr || new Error('未找到 panel/js/http.js');

            log('网络层已加载：' + attempted[attempted.length - 1], 'ok');
            return true;
        } catch (e) {
            log('网络层加载失败：' + e.message, 'err');
            log('扩展目录原始值：' + cs.getSystemPath(SystemPath.EXTENSION), 'err');
            log('已尝试路径：' + attempted.join(' ｜ '), 'err');
            return false;
        }
    }

    /* ================================================================
     * 设置持久化
     * ================================================================ */
    var SETTING_KEYS = [
        'scope', 'engine', 'sourceLang', 'targetLang', 'caseMode', 'preset', 'apiKey',
        'baseUrl', 'model', 'proxy', 'overflowPolicy', 'writeMode',
        'skipSameLang', 'skipPureNumber', 'includeLocked', 'glossary',
        'sceneText', 'domainPreset',
    ];

    function saveSettings() {
        var data = {};
        SETTING_KEYS.forEach(function (k) {
            var el = $(k);
            if (!el) return;
            data[k] = el.type === 'checkbox' ? el.checked : el.value;
        });
        try { localStorage.setItem('tx.settings', JSON.stringify(data)); } catch (e) { }
    }

    function loadSettings() {
        var data = null;
        try { data = JSON.parse(localStorage.getItem('tx.settings') || 'null'); } catch (e) { }
        if (!data) return;
        SETTING_KEYS.forEach(function (k) {
            var el = $(k);
            if (!el || data[k] === undefined) return;
            if (el.type === 'checkbox') el.checked = !!data[k];
            else el.value = data[k];
        });
    }

    function readOptions() {
        var glossary = [];
        var raw = ($('glossary').value || '').split(/\r?\n/);
        for (var i = 0; i < raw.length; i++) {
            var line = raw[i].trim();
            if (!line || line.indexOf('=') === -1) continue;
            var idx = line.indexOf('=');
            glossary.push({ from: line.slice(0, idx).trim(), to: line.slice(idx + 1).trim() });
        }
        return {
            scope: $('scope').value,
            engine: $('engine').value,
            sourceLang: $('sourceLang').value,
            targetLang: $('targetLang').value,
            caseMode: $('caseMode') ? $('caseMode').value : 'keep',
            preset: $('preset').value,
            apiKey: $('apiKey').value.trim(),
            baseUrl: $('baseUrl').value.trim(),
            model: $('model').value.trim(),
            proxy: $('proxy').value.trim(),
            overflowPolicy: $('overflowPolicy').value,
            writeMode: $('writeMode').value,
            skipSameLang: $('skipSameLang').checked,
            skipPureNumber: $('skipPureNumber').checked,
            includeLocked: $('includeLocked').checked,
            glossary: glossary,
            scene: $('sceneText') ? $('sceneText').value.trim() : '',
            domainPreset: $('domainPreset') ? $('domainPreset').value : '',
        };
    }

    /* ================================================================
     * 初始化
     * ================================================================ */
    function initLangSelects() {
        var src = $('sourceLang');
        var dst = $('targetLang');
        LANG_OPTIONS.forEach(function (pair) {
            var o1 = document.createElement('option');
            o1.value = pair[0]; o1.textContent = pair[1];
            src.appendChild(o1);
            var o2 = document.createElement('option');
            o2.value = pair[0]; o2.textContent = pair[1];
            dst.appendChild(o2);
        });
        src.value = 'auto';
        dst.value = 'zh-CN';
    }

    function initEngineSelect() {
        var sel = $('engine');
        var list = TXEngines ? TXEngines.engineList() : [];
        if (!list.length) {
            var o = document.createElement('option');
            o.value = 'auto'; o.textContent = '自动（多引擎降级）';
            sel.appendChild(o);
            return;
        }
        var auto = document.createElement('option');
        auto.value = 'auto';
        auto.textContent = '自动（免费引擎依次降级）';
        sel.appendChild(auto);

        list.forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = e.name + (e.free ? ' · 免费' : ' · 需Key');
            opt.title = e.note;
            sel.appendChild(opt);
        });
        sel.value = 'auto';
    }

    function updateEngineHint() {
        var id = $('engine').value;
        if (!TXEngines) return;
        updateContextBadge();
        if (id === 'auto') {
            setStatus('自动模式：' + TXEngines.AUTO_ORDER.join(' → '));
            return;
        }
        var e = TXEngines.ENGINES[id];
        if (e) setStatus(e.name + '：' + e.note);
    }

    /* ================================================================
     * 语境（场景 / 领域）
     *
     * 语境只对大模型引擎有效：把「这是什么」写给模型看，让它按该场景的
     * 惯例选词（牙膏盒上的 Net Wt. 与工业铭牌上的净重写法不同）。
     * 免费接口（腾讯/Bing/有道/Google/MyMemory）没有指令通道，只能靠术语表近似。
     * ================================================================ */

    function presetById(id) {
        var list = (TXCore && TXCore.DOMAIN_PRESETS) || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    function initDomainPresets() {
        var sel = $('domainPreset');
        if (!sel || !TXCore || !TXCore.DOMAIN_PRESETS) return;
        TXCore.DOMAIN_PRESETS.forEach(function (p) {
            var o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.label;
            sel.appendChild(o);
        });
        sel.value = '';
    }

    /** 选中场景预设时把说明填进语境输入框（用户可再自行改写） */
    function applyPreset(id) {
        var p = presetById(id);
        if (!p || !p.scene) return;
        var box = $('sceneText');
        if (!box) return;
        box.value = TXCore.composeSceneText(p.scene, '');
        updateContextBadge();
    }

    /** 更新「语境」区块的启用状态徽标 */
    function updateContextBadge() {
        var badge = $('ctxBadge');
        var hint = $('ctxHint');
        if (!badge) return;
        var box = $('sceneText');
        var scene = box ? box.value.trim() : '';
        var supported = !!(TXEngines && TXEngines.supportsContext($('engine').value));

        if (!scene) {
            badge.className = 'ctx-badge off';
            badge.textContent = '未启用';
            if (hint) hint.textContent = supported ? '已选大模型引擎，填写语境即可生效' : '';
            return;
        }
        if (supported) {
            badge.className = 'ctx-badge on';
            badge.textContent = '已启用';
            if (hint) hint.textContent = '';
        } else {
            badge.className = 'ctx-badge off';
            badge.textContent = '当前引擎不支持';
            if (hint) hint.textContent = '切到「AI 大模型」才会生效';
        }
    }

    /** 把模型给出的术语并入术语表输入框（跳过已存在的原文） */
    function mergeGlossary(list) {
        var box = $('glossary');
        if (!box || !list || !list.length) return 0;
        var existing = {};
        (box.value || '').split(/\r?\n/).forEach(function (line) {
            var i = line.indexOf('=');
            if (i > 0) existing[line.slice(0, i).trim()] = true;
        });
        var added = 0;
        var lines = box.value.trim() ? box.value.replace(/\s+$/, '').split(/\r?\n/) : [];
        list.forEach(function (g) {
            if (!g || !g.from || !g.to || existing[g.from]) return;
            existing[g.from] = true;
            lines.push(g.from + '=' + g.to);
            added++;
        });
        if (added) box.value = lines.join('\n');
        return added;
    }

    /**
     * 「分析画布」：把扫描到的文字交给大模型，推断这是什么场景、该用什么术语。
     * 结果回填语境输入框，术语表并入术语表输入框。
     */
    async function doAnalyzeScene() {
        if (!hostReady) { setStatus('宿主脚本未就绪，无法分析', 'err'); return; }
        if (!TXEngines) { setStatus('网络层未加载，请检查 manifest 的 Node 配置', 'err'); return; }

        var opts = readOptions();
        if (!TXEngines.supportsContext(opts.engine)) {
            setStatus('「分析画布」需要大模型引擎：请在「引擎」中选择「AI 大模型」并填入 API Key', 'warn');
            log('语境分析需要大语言模型。免费接口（腾讯 / Bing / 有道 / Google / MyMemory）是纯翻译接口，' +
                '没有接收指令的通道，无法理解场景。可用智谱 GLM-4-Flash（免费额度）或本地 Ollama。', 'warn');
            return;
        }

        var run = async function () {
            var items = state.items.filter(function (it) { return state.checked[it.id]; });
            if (!items.length) { setStatus('请先扫描并勾选要分析的文本', 'warn'); return; }

            // 取样：跨对象去重 + 限量，避免把整份文档塞给模型
            var seen = {};
            var samples = [];
            var chars = 0;
            for (var i = 0; i < items.length; i++) {
                var paras = items[i].paragraphs || [];
                for (var p = 0; p < paras.length; p++) {
                    var t = String(paras[p].text === null || paras[p].text === undefined ? '' : paras[p].text)
                        .replace(/\s+/g, ' ').trim();
                    if (!t || seen[t]) continue;
                    seen[t] = true;
                    samples.push(t);
                    chars += t.length;
                    if (samples.length >= 120 || chars >= 3000) break;
                }
                if (samples.length >= 120 || chars >= 3000) break;
            }
            if (!samples.length) { setStatus('没有可分析的文本', 'warn'); return; }

            busy(true);
            setProgress(0.3);
            setStatus('正在分析画布语境（' + samples.length + ' 条文字）…');

            var ctx = {
                targetLang: opts.targetLang,
                targetLangLabel: (TXEngines.LANGS[opts.targetLang] || {}).llm || opts.targetLang,
                hint: opts.scene || '',
                preset: opts.preset,
                apiKey: opts.apiKey,
                baseUrl: opts.baseUrl,
                model: opts.model,
                proxy: opts.proxy,
                temperature: 0.3,
                log: function (m) { log(m, 'warn'); },
            };

            try {
                var r = await TXEngines.analyzeContext(samples, ctx);
                busy(false);
                setProgress(0);

                var text = TXCore.composeSceneText(r.scene, r.tone);
                if (text) {
                    $('sceneText').value = text;
                } else {
                    log('模型没有判断出明确场景，请手动填写语境', 'warn');
                }
                var added = mergeGlossary(r.glossary);
                saveSettings();
                updateContextBadge();

                var msg = '语境分析完成';
                if (text) msg += '，已填入语境';
                if (added) msg += '，新增术语 ' + added + ' 条（可自行编辑）';
                setStatus(msg, 'ok');
                log(msg, 'ok');
                if (r.glossary && r.glossary.length && !added) {
                    log('模型给出的 ' + r.glossary.length + ' 条术语都已在术语表中', 'ok');
                }
            } catch (e) {
                busy(false);
                setProgress(0);
                setStatus('语境分析失败：' + e.message, 'err');
                log('语境分析失败：' + e.message, 'err');
            }
        };

        // 还没扫描就先静默扫一次，再分析
        if (!state.items.length) scan({ silent: true }, run); else run();
    }

    function initHost() {
        var env = cs.getHostEnvironment();
        var statusEl = $('hostStatus');

        if (!cs.isHostAvailable()) {
            statusEl.textContent = '未连接 Illustrator（浏览器预览模式）';
            statusEl.className = 'host bad';
            setStatus('请通过 Illustrator 的「窗口 → 扩展功能 → AI 文本翻译」打开本面板', 'warn');
            return;
        }
        statusEl.textContent = env.appName + ' ' + env.appVersion;
        statusEl.className = 'host';

        callHost('ping', undefined, function (r) {
            if (!r || !r.ok) {
                statusEl.className = 'host bad';
                setStatus('宿主脚本未就绪：' + (r ? r.error : '无响应'), 'err');
                return;
            }
            hostReady = true;
            statusEl.textContent = env.appName + ' ' + env.appVersion + ' · 脚本就绪';
            statusEl.className = 'host ok';
            var caps = r.caps || {};
            log('宿主就绪：' + JSON.stringify(r.app) + ' 能力=' + JSON.stringify(caps), 'ok');
            setStatus('就绪，点击「扫描」读取画布文本');
        });
    }

    /* ================================================================
     * 扫描
     * ================================================================ */
    /**
     * 扫描
     * @param {object|function} [opts] {silent:true} 时不覆盖状态栏；也可直接传回调
     */
    function scan(opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        busy(true);
        if (!opts.silent) setStatus('正在扫描…');
        setProgress(0.1);
        var ropts = readOptions();
        callHost('scan', { scope: ropts.scope, includeLocked: ropts.includeLocked }, function (r) {
            busy(false);
            setProgress(0);
            if (!r || !r.ok) {
                setStatus('扫描失败：' + (r ? r.error : '无响应'), 'err');
                return;
            }
            state.items = r.items || [];
            state.translations = {};
            state.skipped = [];
            state.checked = {};
            state.items.forEach(function (it) { state.checked[it.id] = true; });
            renderList();
            $('btnTranslate').disabled = state.items.length === 0;
            $('btnExport').disabled = state.items.length === 0;
            var msg = '扫描完成：' + r.itemCount + ' 个文本对象（' + r.frameCount + ' 个文本框';
            if (r.skipped) {
                msg += '，跳过 空' + (r.skipped.empty || 0) + '/锁定' + (r.skipped.locked || 0) +
                    '/重复联排' + (r.skipped.duplicateStory || 0);
            }
            msg += '）';
            if (!opts.silent) setStatus(msg, 'ok');
            log(msg, 'ok');
            if (cb) cb(r);
        });
    }

    /* ================================================================
     * 列表渲染
     * ================================================================ */
    function renderList() {
        var box = $('list');
        box.innerHTML = '';

        if (!state.items.length) {
            box.innerHTML = '<div class="empty">没有可翻译的文本<br/>换个范围（如「整个文档」）再试</div>';
            $('counter').textContent = '0 个对象';
            return;
        }

        state.items.forEach(function (item) {
            var tr = state.translations[item.id] || {};
            var el = document.createElement('div');
            el.className = 'item';
            el.dataset.id = item.id;

            var head = document.createElement('div');
            head.className = 'item-head';

            var chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = !!state.checked[item.id];
            chk.addEventListener('click', function (e) { e.stopPropagation(); });
            chk.addEventListener('change', function () {
                state.checked[item.id] = chk.checked;
                updateCounter();
            });
            head.appendChild(chk);

            var tag = document.createElement('span');
            tag.className = 'tag ' + (item.kind || '');
            tag.textContent = ({ area: '区域', point: '点', path: '路径', onpath: '路径' })[item.kind] || '文本';
            head.appendChild(tag);

            if (item.storyScope === 'story' && item.frameCount > 1) {
                var t2 = document.createElement('span');
                t2.className = 'tag';
                t2.textContent = '联排×' + item.frameCount;
                t2.title = '多个文本框串联为一个故事，整体翻译';
                head.appendChild(t2);
            }
            if (item.overflow) {
                var t3 = document.createElement('span');
                t3.className = 'tag warn';
                t3.textContent = '溢出';
                t3.title = '文本框内容超出范围';
                head.appendChild(t3);
            }

            var meta = document.createElement('span');
            meta.className = 'meta';
            meta.textContent = item.paragraphCount + '段 / ' + item.chars + '字';
            head.appendChild(meta);

            head.addEventListener('click', function () {
                callHost('selectItem', item.id, function (r) {
                    if (!r || !r.ok) setStatus('定位失败：' + (r ? r.error : ''), 'warn');
                    var nodes = box.querySelectorAll('.item');
                    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('selected');
                    el.classList.add('selected');
                });
            });
            el.appendChild(head);

            var body = document.createElement('div');
            body.className = 'item-body';
            item.paragraphs.forEach(function (p) {
                var pair = document.createElement('div');
                pair.className = 'pair';

                var src = document.createElement('div');
                src.className = 'src';
                src.textContent = p.text || '（空段落）';
                pair.appendChild(src);

                var dst = document.createElement('div');
                dst.className = 'dst';
                var val = tr[p.i];
                if (val === undefined) {
                    dst.className += ' pending';
                    dst.textContent = '待翻译';
                } else if (val === '') {
                    dst.className += ' pending';
                    dst.textContent = '（跳过）';
                } else {
                    dst.textContent = val;
                }
                pair.appendChild(dst);

                body.appendChild(pair);
            });
            el.appendChild(body);
            box.appendChild(el);
        });

        updateCounter();
    }

    function updateCounter() {
        var total = state.items.length;
        var checked = 0;
        state.items.forEach(function (it) { if (state.checked[it.id]) checked++; });
        $('counter').textContent = checked + ' / ' + total + ' 个对象';
    }

    function updateItemInDom(itemId) {
        var el = document.querySelector('.item[data-id="' + itemId + '"]');
        if (!el) return;
        var item = null;
        for (var i = 0; i < state.items.length; i++) {
            if (state.items[i].id === itemId) { item = state.items[i]; break; }
        }
        if (!item) return;
        var tr = state.translations[itemId] || {};
        var dstNodes = el.querySelectorAll('.pair .dst');
        item.paragraphs.forEach(function (p, idx) {
            var node = dstNodes[idx];
            if (!node) return;
            var val = tr[p.i];
            node.className = 'dst';
            if (val === undefined) {
                node.className = 'dst pending';
                node.textContent = '待翻译';
            } else if (val === '') {
                node.className = 'dst pending';
                node.textContent = '（跳过）';
            } else {
                node.textContent = val;
            }
        });
    }

    /* ================================================================
     * 翻译主流程
     * ================================================================ */
    async function doTranslate() {
        if (!hostReady) { setStatus('宿主脚本未就绪，无法翻译', 'err'); return; }
        if (!TXEngines) { setStatus('网络层未加载，请检查 manifest 的 Node 配置', 'err'); return; }

        var opts = readOptions();
        var items = state.items.filter(function (it) { return state.checked[it.id]; });
        if (!items.length) { setStatus('请先勾选要翻译的对象', 'warn'); return; }

        // 语境只对大模型引擎生效：提前说清楚，免得用户以为填了没作用
        var ctxSupported = TXEngines.supportsContext(opts.engine);
        if (opts.scene && !ctxSupported) {
            log('已填写语境，但当前引擎（' + engineName(opts.engine) + '）是纯翻译接口，没有接收指令的通道，' +
                '语境不会生效（术语表仍然有效）。要启用语境请把「引擎」切换为「AI 大模型」。', 'warn');
        }

        // 1. 规划任务（过滤 + 去重 + 分批）
        var plan = TXCore.planTasks(items, {
            targetLang: opts.targetLang,
            sourceLang: opts.sourceLang,
            glossary: opts.glossary,
            skipTargetLang: opts.skipSameLang,
            skipPureNumber: opts.skipPureNumber,
            minChars: 1,
        });

        state.skipped = plan.skipped;
        var caseMode = opts.caseMode || 'keep';

        // 大小写变换：译文要套用，被跳过的段落也可能需要改写。
        // 典型场景：目标就是英文，原文已是英文 → 被 same-script 规则跳过，
        // 但用户要的是「大写英文」，这时依然必须写回，否则功能等于失效。
        var caseOnly = [];
        plan.skipped.forEach(function (s) {
            if (!TXCore.caseTransformAllowed(s.reason)) return;   // 网址/邮箱/占位符不动
            var t = TXCore.transformCase(s.text, caseMode);
            var orig = String(s.text === null || s.text === undefined ? '' : s.text);
            if (t !== orig && t.replace(/\s/g, '') !== '') {
                caseOnly.push({ itemId: s.itemId, paraIndex: s.paraIndex, text: t });
            }
        });

        if (!plan.unique.length && !caseOnly.length) {
            busy(false);
            setStatus(caseMode === 'keep'
                ? '没有需要翻译的文本（全部被规则跳过）'
                : '没有需要翻译或调整大小写的文本', 'warn');
            return;
        }

        busy(true);
        setProgress(0.05);

        var result = { engine: '', map: {}, tried: [] };

        if (plan.unique.length) {
            setStatus('准备翻译 ' + plan.unique.length + ' 条（原始 ' + plan.stats.paragraphCount + ' 段，去重省下 ' +
                plan.stats.savedByDedupe + ' 条）…');

            var itemsById = {};
            items.forEach(function (it) { itemsById[it.id] = it; });

            var ctx = {
                targetLang: opts.targetLang,
                targetLangLabel: (TXEngines.LANGS[opts.targetLang] || {}).llm || opts.targetLang,
                sourceLang: opts.sourceLang,
                proxy: opts.proxy,
                apiKey: opts.apiKey,
                baseUrl: opts.baseUrl,
                model: opts.model,
                preset: opts.preset,
                glossary: opts.glossary,
                // 语境：只有支持语境的引擎（大模型）会读这两个字段
                scene: opts.scene,
                sceneEnabled: ctxSupported && !!opts.scene,
                itemsById: itemsById,
                log: function (m) { log(m, 'warn'); },
                onProgress: function (done, total) {
                    setProgress(0.05 + 0.75 * (done / Math.max(1, total)));
                    setStatus('翻译中… ' + done + ' / ' + total);
                },
            };

            // Google 免费接口在国内必须走代理：没填代理时自动探测一次
            if (!ctx.proxy && (opts.engine === 'google' || opts.engine === 'auto')) {
                try {
                    var detected = await TXHttp.detectSystemProxy();
                    if (detected) {
                        ctx.autoProxy = detected;
                        log('自动探测到本机代理：' + detected, 'ok');
                    }
                } catch (e) { }
            }

            try {
                result = await TXEngines.translateBatch(opts.engine, plan.unique, ctx);
            } catch (e) {
                busy(false);
                setProgress(0);
                setStatus('翻译失败：' + e.message, 'err');
                if (e.tried) {
                    e.tried.forEach(function (t) {
                        log('引擎 ' + t.engine + (t.ok ? ' 成功 ' + t.ms + 'ms' : ' 失败：' + t.error), t.ok ? 'ok' : 'err');
                    });
                }
                return;
            }

            state.lastEngine = result.engine;
            result.tried.forEach(function (t) {
                log('引擎 ' + t.engine + (t.ok ? ' 成功 ' + t.ms + 'ms' : ' 失败：' + t.error), t.ok ? 'ok' : 'err');
            });

            // 译文统一套用大小写（中文等无大小写字符不受影响）
            if (caseMode !== 'keep') {
                Object.keys(result.map).forEach(function (h) {
                    result.map[h] = TXCore.transformCase(result.map[h], caseMode);
                });
                log('已按「' + caseModeLabel(caseMode) + '」处理译文', 'ok');
            }
        } else {
            log('没有需要翻译的段落，仅执行大小写调整（' + caseOnly.length + ' 段）', 'warn');
        }

        // 2. 合并译文 + 大小写改写，得到最终要回写的段落
        var updates = plan.unique.length ? TXCore.mergeResults(plan, result.map) : {};
        caseOnly.forEach(function (c) {
            if (!updates[c.itemId]) updates[c.itemId] = [];
            updates[c.itemId].push({ i: c.paraIndex, text: c.text });
        });

        var payloadItems = [];
        Object.keys(updates).forEach(function (itemId) {
            payloadItems.push({ id: itemId, paragraphs: updates[itemId] });
            if (!state.translations[itemId]) state.translations[itemId] = {};
            updates[itemId].forEach(function (u) { state.translations[itemId][u.i] = u.text; });
            updateItemInDom(itemId);
        });

        // 其余被跳过的段落标记为“跳过”
        plan.skipped.forEach(function (s) {
            if (!state.translations[s.itemId]) state.translations[s.itemId] = {};
            if (state.translations[s.itemId][s.paraIndex] === undefined) {
                state.translations[s.itemId][s.paraIndex] = '';
            }
            updateItemInDom(s.itemId);
        });

        // 3. 回写画布
        if (!payloadItems.length) {
            busy(false);
            setProgress(0);
            setStatus('没有需要写回的内容（译文为空或全部被跳过）', 'warn');
            return;
        }
        setStatus('回写画布…');
        setProgress(0.85);
        var applied = await callHostAsync('apply', {
            mode: opts.writeMode,
            overflow: { policy: opts.overflowPolicy, maxGrow: 3.0, minScale: 0.6 },
            items: payloadItems,
        });

        busy(false);
        setProgress(1);
        setTimeout(function () { setProgress(0); }, 800);

        if (!applied || !applied.ok) {
            setStatus('回写失败：' + (applied ? applied.error : '无响应'), 'err');
            return;
        }

        var overflowCount = 0, errorCount = 0, resized = 0;
        (applied.results || []).forEach(function (r) {
            if (r.overflowAfter) overflowCount++;
            if (r.overflowFix && (r.overflowFix.resized || r.overflowFix.scaled)) resized++;
            if (!r.ok) { errorCount++; log('回写失败 ' + r.id + '：' + (r.error || (r.errors || []).join(';')), 'err'); }
            else if (r.errors && r.errors.length) {
                r.errors.forEach(function (e) { log('部分段落失败：' + e, 'warn'); });
            }
        });

        $('btnUndo').disabled = !applied.canUndo;
        var msg;
        if (result.engine) {
            msg = '完成：写回 ' + applied.applied + ' 段';
            if (caseOnly.length) msg += '（其中 ' + caseOnly.length + ' 段仅改大小写）';
            msg += '，引擎 ' + engineName(result.engine);
        } else {
            msg = '完成：仅调整大小写 ' + applied.applied + ' 段（' + caseModeLabel(caseMode) + '）';
        }
        if (resized) msg += '，自动调整 ' + resized + ' 个文本框';
        if (overflowCount) msg += '，仍有 ' + overflowCount + ' 个文本框溢出';
        if (errorCount) msg += '，失败 ' + errorCount + ' 个';
        setStatus(msg, overflowCount || errorCount ? 'warn' : 'ok');
        log(msg, 'ok');
    }

    /** 大小写模式 → 中文名 */
    function caseModeLabel(mode) {
        return ({
            keep: '保持原样',
            upper: '全部大写',
            lower: '全部小写',
            title: '单词首字母大写',
        })[mode] || mode;
    }

    /** 引擎 ID → 中文名 */
    function engineName(id) {
        if (!TXEngines) return id;
        var e = TXEngines.ENGINES[id];
        return e ? e.name : id;
    }

    /* ================================================================
     * 撤销
     * ================================================================ */
    function doUndo() {
        callHost('undo', undefined, function (r) {
            if (!r || !r.ok) { setStatus('撤销失败：' + (r ? r.error : ''), 'err'); return; }
            $('btnUndo').disabled = !r.canUndo;
            // 静默重扫，避免扫描消息把「已撤销」的提示顶掉
            scan({ silent: true }, function () {
                setStatus('已撤销，恢复 ' + r.restored + ' 个文本对象', 'ok');
            });
            log('撤销：恢复 ' + r.restored + ' 个对象', 'ok');
        });
    }

    /* ================================================================
     * 离线导出 / 导入
     * ================================================================ */
    function doExport() {
        var opts = readOptions();
        var data = {
            version: 1,
            targetLang: opts.targetLang,
            sourceLang: opts.sourceLang,
            exportedAt: new Date().toISOString(),
            items: state.items.map(function (it) {
                var tr = state.translations[it.id] || {};
                return {
                    id: it.id,
                    kind: it.kind,
                    paragraphs: it.paragraphs.map(function (p) {
                        return { i: p.i, src: p.text, dst: tr[p.i] === undefined ? '' : tr[p.i] };
                    }),
                };
            }),
        };
        var text = JSON.stringify(data, null, 2);
        try {
            var fs = require('fs');
            var path = require('path');
            var docs = cs.getSystemPath(SystemPath.MY_DOCUMENTS) || cs.getSystemPath(SystemPath.DESKTOP);
            var file = path.join(docs || '.', 'ai-translate-' + Date.now() + '.json');
            fs.writeFileSync(file, text, 'utf8');
            setStatus('已导出：' + file, 'ok');
            log('导出到 ' + file, 'ok');
        } catch (e) {
            // 退化为浏览器下载
            var blob = new Blob([text], { type: 'application/json' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'ai-translate.json';
            a.click();
            setStatus('已导出到下载目录', 'ok');
        }
    }

    function doImport(file) {
        var reader = new FileReader();
        reader.onload = function () {
            var data = null;
            try { data = JSON.parse(String(reader.result)); } catch (e) {
                setStatus('导入失败：不是合法的 JSON', 'err');
                return;
            }
            if (!data || !data.items) { setStatus('导入失败：缺少 items 字段', 'err'); return; }

            var payloadItems = [];
            var matched = 0;

            data.items.forEach(function (fileItem) {
                var target = null;
                for (var i = 0; i < state.items.length; i++) {
                    if (state.items[i].id === fileItem.id) { target = state.items[i]; break; }
                }
                if (!target) {
                    // 按原文匹配
                    for (var j = 0; j < state.items.length; j++) {
                        var cand = state.items[j];
                        var same = cand.paragraphs.length === fileItem.paragraphs.length;
                        if (!same) continue;
                        for (var k = 0; k < cand.paragraphs.length; k++) {
                            if ((cand.paragraphs[k].text || '') !== (fileItem.paragraphs[k].src || '')) { same = false; break; }
                        }
                        if (same) { target = cand; break; }
                    }
                }
                if (!target) return;

                var paras = fileItem.paragraphs
                    .filter(function (p) { return p.dst && p.dst.trim() !== ''; })
                    .map(function (p) { return { i: p.i, text: p.dst }; });
                if (!paras.length) return;

                payloadItems.push({ id: target.id, paragraphs: paras });
                if (!state.translations[target.id]) state.translations[target.id] = {};
                paras.forEach(function (p) { state.translations[target.id][p.i] = p.text; });
                updateItemInDom(target.id);
                matched++;
            });

            if (!payloadItems.length) { setStatus('导入完成：没有匹配到可写回的文本', 'warn'); return; }

            var opts = readOptions();
            callHost('apply', {
                mode: opts.writeMode,
                overflow: { policy: opts.overflowPolicy, maxGrow: 3.0, minScale: 0.6 },
                items: payloadItems,
            }, function (r) {
                if (!r || !r.ok) { setStatus('导入回写失败：' + (r ? r.error : ''), 'err'); return; }
                $('btnUndo').disabled = !r.canUndo;
                setStatus('导入完成：写回 ' + matched + ' 个对象', 'ok');
                log('导入写回 ' + matched + ' 个对象', 'ok');
            });
        };
        reader.readAsText(file, 'utf-8');
    }

    /* ================================================================
     * 网络诊断
     * ================================================================ */
    async function doDiagnose() {
        if (!TXEngines) { setStatus('网络层未加载', 'err'); return; }
        var opts = readOptions();
        var ctx = {
            targetLang: opts.targetLang,
            targetLangLabel: (TXEngines.LANGS[opts.targetLang] || {}).llm || opts.targetLang,
            sourceLang: opts.sourceLang,
            proxy: opts.proxy,
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
            model: opts.model,
            preset: opts.preset,
        };

        setStatus('正在诊断各引擎…');
        log('===== 网络诊断开始 =====');
        var ids = ['bing', 'tencent', 'youdao', 'google', 'mymemory'];
        if (opts.apiKey) ids.push('deepl', 'openai');

        for (var i = 0; i < ids.length; i++) {
            var r = await TXEngines.diagnose(ids[i], ctx);
            if (r.ok) {
                log('[OK] ' + ids[i] + ' ' + r.ms + 'ms → ' + r.result, 'ok');
            } else {
                log('[FAIL] ' + ids[i] + ' ' + r.ms + 'ms → ' + r.error, 'err');
            }
        }
        setStatus('诊断完成，详见下方日志', 'ok');
        log('===== 网络诊断结束 =====');
    }

    /* ================================================================
     * 绑定事件
     * ================================================================ */
    function bindEvents() {
        on('btnScan', 'click', function () { scan(); });
        on('btnTranslate', 'click', doTranslate);
        on('btnUndo', 'click', doUndo);
        on('btnExport', 'click', doExport);
        on('btnImport', 'click', function () { $('fileInput').click(); });
        on('btnDiagnose', 'click', doDiagnose);
        on('btnDetectProxy', 'click', async function () {
            setStatus('正在检测本机代理…');
            var p = await TXHttp.detectSystemProxy();
            $('proxy').value = p;
            saveSettings();
            setStatus(p ? '检测到代理：' + p : '未检测到本机代理', p ? 'ok' : 'warn');
        });
        on('btnReset', 'click', function () {
            try { localStorage.removeItem('tx.settings'); } catch (e) { }
            location.reload();
        });
        on('engine', 'change', function () {
            updateEngineHint();
            saveSettings();
        });
        on('preset', 'change', function () {
            var p = PRESET_FIELDS[$('preset').value];
            if (p) {
                $('baseUrl').value = p.baseUrl;
                $('model').value = p.model;
            }
            saveSettings();
        });
        on('checkAll', 'change', function () {
            var v = $('checkAll').checked;
            state.items.forEach(function (it) { state.checked[it.id] = v; });
            renderList();
        });
        on('domainPreset', 'change', function () {
            applyPreset($('domainPreset').value);
            saveSettings();
        });
        on('sceneText', 'input', updateContextBadge);
        on('sceneText', 'change', function () {
            updateContextBadge();
            saveSettings();
        });
        on('btnAnalyzeScene', 'click', doAnalyzeScene);
        on('btnClearScene', 'click', function () {
            $('sceneText').value = '';
            $('domainPreset').value = '';
            updateContextBadge();
            saveSettings();
            setStatus('已清空语境', 'ok');
        });
        on('fileInput', 'change', function (e) {
            if (e.target.files && e.target.files[0]) doImport(e.target.files[0]);
            e.target.value = '';
        });
        SETTING_KEYS.forEach(function (k) {
            var el = $(k);
            if (el) el.addEventListener('change', saveSettings);
        });
    }

    /* ================================================================
     * 启动
     * ================================================================ */
    function boot() {
        $('verLabel').textContent = 'v1.1';
        initLangSelects();
        var nodeOk = loadNodeModules();
        initEngineSelect();
        initDomainPresets();
        loadSettings();
        bindEvents();
        updateEngineHint();
        updateContextBadge();
        initHost();

        if (!nodeOk) {
            setStatus('Node 网络层未加载，翻译功能不可用（请检查 manifest 与 CEP 版本）', 'err');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
