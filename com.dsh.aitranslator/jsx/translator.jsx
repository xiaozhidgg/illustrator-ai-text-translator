/*************************************************************************
 * translator.jsx — 「AI 文本翻译」Illustrator 宿主脚本 (ExtendScript / ES3)
 *
 * 由 CEP 面板通过 CSInterface.evalScript() 调用。
 * 所有方法都返回 JSON 字符串：{ ok: true, ... } 或 { ok: false, error: "..." }
 *
 * 兼容 Illustrator 2023(27.x) ~ 2025(29.x)
 * 注意：本文件不使用 #include / #target，避免 CEP ScriptPath 加载失败。
 *************************************************************************/

var TX = (function () {

    /* ============================================================
     * 1. JSON 兜底实现（ExtendScript 没有原生 JSON）
     * ============================================================ */
    var TXJSON = (function () {
        var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
        var meta = {
            '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\'
        };

        function quote(string) {
            escapable.lastIndex = 0;
            if (!escapable.test(string)) {
                return '"' + string + '"';
            }
            escapable.lastIndex = 0;
            return '"' + string.replace(escapable, function (a) {
                var c = meta[a];
                if (typeof c === 'string') { return c; }
                return '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
            }) + '"';
        }

        function str(value, depth) {
            if (depth > 32) { throw new Error('JSON: 嵌套过深'); }
            if (value === null || value === undefined) { return 'null'; }
            var t = typeof value;
            if (t === 'string') { return quote(value); }
            if (t === 'number') { return isFinite(value) ? String(value) : 'null'; }
            if (t === 'boolean') { return value ? 'true' : 'false'; }
            if (t === 'object') {
                var i, parts = [];
                if (value instanceof Array) {
                    for (i = 0; i < value.length; i++) { parts.push(str(value[i], depth + 1)); }
                    return '[' + parts.join(',') + ']';
                }
                for (var k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        var v = value[k];
                        if (typeof v === 'function' || v === undefined) { continue; }
                        parts.push(quote(String(k)) + ':' + str(v, depth + 1));
                    }
                }
                return '{' + parts.join(',') + '}';
            }
            return 'null';
        }

        function parse(text) {
            if (text === null || text === undefined) { return null; }
            var s = String(text).replace(/^\s+|\s+$/g, '');
            if (s === '') { return null; }
            var tmp = s
                .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
                .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
                .replace(/(?:^|:|,)(?:\s*\[)+/g, '');
            if (!/^[\],:{}\s]*$/.test(tmp)) {
                throw new SyntaxError('JSON.parse: 非法 JSON 字符串');
            }
            return eval('(' + s + ')');
        }

        return { stringify: str, parse: parse };
    })();

    /* ============================================================
     * 2. 内部状态
     * ============================================================ */
    var registry = {};      // id -> { item, frames, scope, kind }
    var counter = 0;
    var undoStack = [];     // 每步一条快照
    var VERSION = '1.0.0';

    function uid() { counter++; return 'itm' + counter; }

    function fail(msg) { return TXJSON.stringify({ ok: false, error: String(msg) }); }
    function ok(obj) {
        obj = obj || {};
        obj.ok = true;
        return TXJSON.stringify(obj);
    }

    function activeDoc() {
        if (!app.documents || app.documents.length === 0) {
            throw new Error('请先打开一个 Illustrator 文档');
        }
        return app.activeDocument;
    }

    /* ============================================================
     * 3. 文档遍历
     * ============================================================ */
    function itemKey(item) {
        try {
            if (item && item.uuid) { return 'u:' + item.uuid; }
        } catch (e) { /* 老版本没有 uuid */ }
        return null;
    }

    function makeVisited() { return { __ids: [] }; }

    function pushUnique(item, bucket, visited) {
        var k = itemKey(item);
        if (k) {
            if (visited[k]) { return false; }
            visited[k] = true;
        } else {
            if (visited.__ids.indexOf(item) !== -1) { return false; }
            visited.__ids.push(item);
        }
        bucket.push(item);
        return true;
    }

    /** 递归收集文本对象（组内也收集），带去重，避免 document.pageItems 重复枚举 */
    function collectTextFrames(root, out, visited) {
        if (!root) { return; }
        var tn;
        try { tn = root.typename; } catch (e) { return; }

        if (tn === 'TextFrame') {
            pushUnique(root, out, visited);
            return;
        }
        if (tn === 'GroupItem') {
            if (!pushUnique(root, out, visited) && visited['g:' + (itemKey(root) || '')]) { return; }
            var kids = root.pageItems;
            for (var i = 0; i < kids.length; i++) { collectTextFrames(kids[i], out, visited); }
            return;
        }
        if (tn === 'CompoundPathItem') {
            var cp = root.pathItems;
            for (var j = 0; j < cp.length; j++) { collectTextFrames(cp[j], out, visited); }
            return;
        }
        // 其余（PathItem / 光栅图 / 符号等）不是文本
    }

    function inRect(item, rect) {
        try {
            var b = item.geometricBounds; // [left, top, right, bottom]
            var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            return cx >= rect[0] && cx <= rect[2] && cy <= rect[1] && cy >= rect[3];
        } catch (e) { return true; }
    }

    function framesByScope(doc, scope) {
        var out = [], visited = makeVisited(), i;
        if (scope === 'selection') {
            var sel = doc.selection;
            if (!sel || sel.length === 0) { return out; }
            for (i = 0; i < sel.length; i++) { collectTextFrames(sel[i], out, visited); }
            return out;
        }
        if (scope === 'layer') {
            var layer = doc.activeLayer;
            for (i = 0; i < layer.pageItems.length; i++) { collectTextFrames(layer.pageItems[i], out, visited); }
            return out;
        }
        if (scope === 'artboard') {
            var idx = doc.artboards.getActiveArtboardIndex();
            var rect = doc.artboards[idx].artboardRect;
            for (i = 0; i < doc.pageItems.length; i++) { collectTextFrames(doc.pageItems[i], out, visited); }
            var kept = [];
            for (i = 0; i < out.length; i++) { if (inRect(out[i], rect)) { kept.push(out[i]); } }
            return kept;
        }
        for (i = 0; i < doc.pageItems.length; i++) { collectTextFrames(doc.pageItems[i], out, visited); }
        return out;
    }

    /* ============================================================
     * 4. 联排文本框（story）处理
     * ============================================================ */
    function storyRoot(frame) {
        var f = frame, guard = 0, prev = null;
        while (f && guard < 500) {
            prev = null;
            try { prev = f.previousFrame; } catch (e) { prev = null; }   // 点文本会抛异常
            if (!prev || prev === f) { break; }                          // 未联排时可能返回自身
            f = prev; guard++;
        }
        return f || frame;
    }

    /**
     * 返回 { frames:[...], scope:'story'|'frame' }
     *
     * 实测（AI 2025）：
     *   - 未联排的区域文本：nextFrame 返回自身（自环），previousFrame 为 null
     *   - 点文本：访问 nextFrame 直接抛「属性不可用」
     *   - 联排末框：nextFrame 返回自身
     * 所以必须用「自环即停」来终止遍历，否则会绕成死循环。
     */
    function storyInfo(root) {
        var frames = [], f = root, guard = 0, nf = null;
        while (f && guard < 500) {
            frames.push(f);
            nf = null;
            try { nf = f.nextFrame; } catch (e) { nf = null; }
            if (!nf || nf === f) { break; }
            f = nf; guard++;
        }
        var scope = 'frame';
        if (frames.length > 1) {
            var same = true, len0 = -1;
            for (var i = 0; i < frames.length; i++) {
                var L = 0;
                try { L = frames[i].contents.length; } catch (e) { L = -1; }
                if (i === 0) { len0 = L; }
                else if (L !== len0) { same = false; break; }
            }
            scope = same ? 'story' : 'frames';
        }
        return { frames: frames, scope: scope };
    }

    /**
     * 组装故事的全部段落。
     * 实测（AI 2025）：联排文本框里每个框的 contents 只返回自己那一段，
     * 所以必须把各框段落按顺序拼起来，并记录「全局段号 → 框内段号」的映射，
     * 回写时才能精确落到对应的框。
     *
     * @returns {{paras:Array, paraMap:Array, chars:number}}
     */
    function collectStoryParagraphs(info) {
        var paras = [];
        var paraMap = [];
        var chars = 0;
        var frames = info.frames;

        if (info.scope === 'story') {
            // 某些版本里每个框都返回整段故事：只读根框
            var root = frames[0];
            try { chars = root.contents.length; } catch (e) { chars = 0; }
            var prs = null;
            try { prs = root.paragraphs; } catch (e) { prs = null; }
            if (prs) {
                for (var i = 0; i < prs.length; i++) {
                    var t = '';
                    try { t = String(prs[i].contents); } catch (e) { t = ''; }
                    paras.push({ i: paras.length, text: t.replace(/[\r\n]+$/, '') });
                    paraMap.push({ frameIndex: 0, localIndex: i });
                }
            }
            return { paras: paras, paraMap: paraMap, chars: chars };
        }

        for (var fi = 0; fi < frames.length; fi++) {
            var fr = frames[fi];
            try { chars += fr.contents.length; } catch (e) { }
            var list = null;
            try { list = fr.paragraphs; } catch (e) { list = null; }
            if (!list) { continue; }
            for (var p = 0; p < list.length; p++) {
                var txt = '';
                try { txt = String(list[p].contents); } catch (e) { txt = ''; }
                paras.push({ i: paras.length, text: txt.replace(/[\r\n]+$/, '') });
                paraMap.push({ frameIndex: fi, localIndex: p });
            }
        }
        return { paras: paras, paraMap: paraMap, chars: chars };
    }

    /* ============================================================
     * 5. 属性快照（保格式的关键）
     * ============================================================ */
    function snapshotCharAttrs(range) {
        var snap = {};
        try { snap.size = range.characterAttributes.size; } catch (e) { }
        try { snap.textFont = range.characterAttributes.textFont; } catch (e) { }
        try { snap.fillColor = range.characterAttributes.fillColor; } catch (e) { }
        try { snap.tracking = range.characterAttributes.tracking; } catch (e) { }
        try { snap.horizontalScale = range.characterAttributes.horizontalScale; } catch (e) { }
        try { snap.verticalScale = range.characterAttributes.verticalScale; } catch (e) { }
        try { snap.baselineShift = range.characterAttributes.baselineShift; } catch (e) { }
        return snap;
    }

    function restoreCharAttrs(range, snap) {
        var ca;
        try { ca = range.characterAttributes; } catch (e) { return; }
        try { if (snap.size !== undefined) { ca.size = snap.size; } } catch (e) { }
        try { if (snap.textFont !== undefined) { ca.textFont = snap.textFont; } } catch (e) { }
        try { if (snap.fillColor !== undefined) { ca.fillColor = snap.fillColor; } } catch (e) { }
        try { if (snap.tracking !== undefined) { ca.tracking = snap.tracking; } } catch (e) { }
        try { if (snap.horizontalScale !== undefined) { ca.horizontalScale = snap.horizontalScale; } } catch (e) { }
        try { if (snap.verticalScale !== undefined) { ca.verticalScale = snap.verticalScale; } } catch (e) { }
        try { if (snap.baselineShift !== undefined) { ca.baselineShift = snap.baselineShift; } } catch (e) { }
    }

    /* ============================================================
     * 6. 溢出检测与处理
     * ============================================================ */
    function kindOf(item) {
        var k = null;
        try { k = item.kind; } catch (e) { return 'unknown'; }
        try {
            if (k === TextType.AREATEXT) { return 'area'; }
            if (k === TextType.POINTTEXT) { return 'point'; }
            if (k === TextType.PATHTEXT) { return 'path'; }
            if (k === TextType.ONPATHTEXT) { return 'onpath'; }
        } catch (e) { }
        var s = String(k);
        if (s.indexOf('AREA') >= 0) { return 'area'; }
        if (s.indexOf('POINT') >= 0) { return 'point'; }
        if (s.indexOf('PATH') >= 0) { return 'path'; }
        return 'unknown';
    }

    /**
     * 溢出检测：优先用官方属性；若宿主版本没有 overflows，
     * 退化为「可见行字符总数 < 全文长度」判断（隐藏行不计入 lines）。
     */
    function isOverflowing(item) {
        try {
            if (typeof item.overflows === 'boolean') { return item.overflows; }
        } catch (e) { }
        try {
            var total = item.textRange.length;
            if (!total) { return false; }
            var lines = item.lines, visible = 0;
            for (var i = 0; i < lines.length; i++) {
                try { visible += lines[i].contents.length; } catch (e2) { }
            }
            if (visible <= 0) { return false; }
            // lines 不含段落符，正常时应满足 visible + (行数-1) ≈ total
            return (visible + lines.length) < total;
        } catch (e3) { }
        return false;
    }

    function fixOverflow(item, policy, opts) {
        var res = { policy: policy, tried: 0, resized: false, scaled: false, stillOverflow: false };
        if (!policy || policy === 'none' || policy === 'report') { return res; }
        if (!isOverflowing(item)) { return res; }

        var kind = kindOf(item);
        var i;

        if (policy === 'expand') {
            if (kind !== 'area') { res.stillOverflow = true; return res; }
            var maxGrow = (opts && opts.maxGrow) || 3.0;
            var w0 = item.width, h0 = item.height, k = 1;
            for (i = 0; i < 16; i++) {
                k *= 1.12;
                if (k > maxGrow) { break; }
                try {
                    item.width = w0 * k;
                    item.height = h0 * k;
                } catch (e) { break; }
                res.tried++;
                if (!isOverflowing(item)) { res.resized = true; break; }
            }
            res.grow = k;
            if (!res.resized) {
                try { item.width = w0; item.height = h0; } catch (e2) { }
                res.stillOverflow = isOverflowing(item);
            }
            return res;
        }

        if (policy === 'shrink') {
            var minScale = (opts && opts.minScale) || 0.6;
            var range = item.textRange;
            var size0 = 12;
            try { size0 = range.characterAttributes.size; } catch (e3) { }
            var s = 1;
            for (i = 0; i < 30; i++) {
                s *= 0.94;
                if (s < minScale) { break; }
                try { range.characterAttributes.size = size0 * s; } catch (e4) { break; }
                res.tried++;
                if (!isOverflowing(item)) { res.scaled = true; break; }
            }
            res.scale = s;
            if (!res.scaled) {
                try { range.characterAttributes.size = size0; } catch (e5) { }
                res.stillOverflow = isOverflowing(item);
            }
            return res;
        }
        return res;
    }

    /* ============================================================
     * 7. 文本回写
     * ============================================================ */
    function normalizeText(t) {
        return String(t === null || t === undefined ? '' : t)
            .replace(/[\r\n]+/g, ' ')
            .replace(/^\s+|\s+$/g, '');
    }

    function setParagraphText(para, text) {
        var snap = snapshotCharAttrs(para);
        para.contents = text;
        restoreCharAttrs(para, snap);
    }

    function applyParagraphs(item, list) {
        var paras = item.paragraphs;
        var sorted = [], i;
        for (i = 0; i < list.length; i++) { sorted.push(list[i]); }
        sorted.sort(function (a, b) { return b.i - a.i; });   // 倒序，避免索引位移

        var applied = 0, errors = [];
        for (i = 0; i < sorted.length; i++) {
            var entry = sorted[i];
            var idx = entry.i;
            if (idx < 0 || idx >= paras.length) {
                errors.push('段落 ' + idx + ' 不存在（共 ' + paras.length + ' 段）');
                continue;
            }
            var text = normalizeText(entry.text);
            if (text === '') { continue; }
            try {
                setParagraphText(paras[idx], text);
                applied++;
            } catch (e) {
                errors.push('段落 ' + idx + ': ' + e.message);
            }
        }
        return { applied: applied, errors: errors };
    }

    function setWholeText(item, text) {
        var range = item.textRange;
        var snap = snapshotCharAttrs(range);
        item.contents = normalizeText(text);
        restoreCharAttrs(item.textRange, snap);
    }

    /**
     * 回写段落：把「全局段号」映射回「第几个框的第几段」。
     * 框之间按倒序处理——文本只会向后流动，先改后面的框，
     * 前面框的段号才不会被回流文本冲乱。
     */
    function applyStoryParagraphs(reg, list) {
        var paraMap = reg.paraMap || [];
        var frames = reg.frames || [reg.item];
        var byFrame = {};
        var errors = [];
        var applied = 0;
        var i;

        for (i = 0; i < list.length; i++) {
            var it = list[i];
            var m = paraMap[it.i];
            if (!m) { errors.push('段落 ' + it.i + ' 找不到映射'); continue; }
            if (!byFrame[m.frameIndex]) { byFrame[m.frameIndex] = []; }
            byFrame[m.frameIndex].push({ i: m.localIndex, text: it.text });
        }

        var keys = [];
        for (var k in byFrame) {
            if (Object.prototype.hasOwnProperty.call(byFrame, k)) { keys.push(Number(k)); }
        }
        keys.sort(function (a, b) { return b - a; });

        for (i = 0; i < keys.length; i++) {
            var fi = keys[i];
            var frame = frames[fi];
            if (!frame) { errors.push('文本框 ' + fi + ' 已失效'); continue; }
            var res = applyParagraphs(frame, byFrame[fi]);
            applied += res.applied;
            for (var e = 0; e < res.errors.length; e++) {
                errors.push('第' + (fi + 1) + '个框：' + res.errors[e]);
            }
        }
        return { applied: applied, errors: errors };
    }

    /* ============================================================
     * 8. 对外 API
     * ============================================================ */

    /** 环境自检：返回宿主信息 + 关键 API 能力 */
    function ping() {
        var info = { version: VERSION, app: {}, caps: {} };
        try { info.app.name = app.name; } catch (e) { }
        try { info.app.version = app.version; } catch (e) { }
        try { info.app.locale = app.locale; } catch (e) { }
        try { info.docCount = app.documents.length; } catch (e) { }
        info.caps.hasOverflowsProp = false;
        info.caps.hasUuid = false;
        info.caps.hasStories = false;
        try {
            var d = activeDoc();
            info.doc = { name: d.name, path: d.fullName ? String(d.fullName) : '', textFrames: d.textFrames.length };
            if (d.textFrames.length > 0) {
                var t = d.textFrames[0];
                info.caps.hasOverflowsProp = (typeof t.overflows === 'boolean');
                info.caps.hasUuid = !!t.uuid;
            }
            info.caps.hasStories = (typeof d.stories === 'object');
        } catch (e2) {
            info.doc = null;
        }
        return ok(info);
    }

    /** 扫描文本对象 */
    function scan(optionsJson) {
        var opts = TXJSON.parse(optionsJson || '{}') || {};
        var doc = activeDoc();
        var scope = opts.scope || 'document';
        var frames = framesByScope(doc, scope);
        var items = [];
        var storySeen = {};
        var skipped = { empty: 0, locked: 0, duplicateStory: 0 };

        for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            var locked = false, hidden = false, layerName = '', layerLocked = false, layerVisible = true;
            try { locked = !!f.locked; } catch (e) { }
            try { hidden = !!f.hidden; } catch (e) { }
            try { layerName = f.layer.name; layerLocked = !!f.layer.locked; layerVisible = !!f.layer.visible; } catch (e) { }

            if (!opts.includeLocked && (locked || layerLocked)) { skipped.locked++; continue; }
            if (!opts.includeHidden && (hidden || !layerVisible)) { skipped.locked++; continue; }

            var root = storyRoot(f);
            var rootKey = itemKey(root) || ('idx' + i);
            if (storySeen[rootKey]) { skipped.duplicateStory++; continue; }

            var info = storyInfo(root);
            storySeen[rootKey] = true;

            var story = collectStoryParagraphs(info);
            if (!story.paras.length || story.chars === 0) { skipped.empty++; continue; }

            var id = uid();
            registry[id] = {
                item: root,
                frames: info.frames,
                scope: info.scope,
                kind: kindOf(root),
                paraMap: story.paraMap
            };

            var bounds = [0, 0, 0, 0];
            try { bounds = root.geometricBounds; } catch (e) { }

            items.push({
                id: id,
                kind: kindOf(root),
                storyScope: info.scope,
                frameCount: info.frames.length,
                chars: story.chars,
                paragraphCount: story.paras.length,
                paragraphs: story.paras,
                locked: locked || layerLocked,
                hidden: hidden || !layerVisible,
                layerName: layerName,
                name: (function () { try { return root.name || ''; } catch (e) { return ''; } })(),
                bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
                overflow: isOverflowing(root)
            });
        }

        return ok({
            docName: doc.name,
            scope: scope,
            frameCount: frames.length,
            itemCount: items.length,
            skipped: skipped,
            items: items
        });
    }

    /** 回写译文 */
    function apply(payloadJson) {
        var payload = TXJSON.parse(payloadJson || '{}') || {};
        var list = payload.items || [];
        var mode = payload.mode || 'paragraph';
        var overflowPolicy = (payload.overflow && payload.overflow.policy) || 'none';
        var overflowOpts = payload.overflow || {};

        var snapshot = { entries: [] };
        var results = [];
        var totalApplied = 0, totalErrors = 0;

        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var reg = registry[entry.id];
            var item = reg ? reg.item : null;

            if (!item) {
                results.push({ id: entry.id, ok: false, error: '对象已失效，请重新扫描' });
                totalErrors++;
                continue;
            }
            // 校验对象是否还在文档中
            var alive = true;
            try { if (item.parent === null || item.parent === undefined) { alive = false; } } catch (e) { alive = false; }
            if (!alive) {
                results.push({ id: entry.id, ok: false, error: '对象已被删除，请重新扫描' });
                totalErrors++;
                continue;
            }

            // 快照（用于撤销）：联排故事的 contents 读写都是「框局部」的，
            // 必须逐框记录、逐框还原，否则后一个框的旧内容会残留在故事里
            var snap = { item: item, frames: [], contents: '', width: 0, height: 0, size: 0 };
            try {
                var frs = (reg && reg.frames) ? reg.frames : [item];
                for (var fi = 0; fi < frs.length; fi++) {
                    var t = '';
                    try { t = frs[fi].contents; } catch (e) { }
                    snap.frames.push({ item: frs[fi], contents: t });
                    snap.contents += t;
                }
            } catch (e) { }
            try { snap.width = item.width; snap.height = item.height; } catch (e) { }
            try { snap.size = item.textRange.characterAttributes.size; } catch (e) { }
            snapshot.entries.push(snap);

            var before = false;
            try { before = isOverflowing(item); } catch (e) { }

            var r = { id: entry.id, ok: true, applied: 0, errors: [], overflowBefore: before, overflowAfter: false };
            try {
                if (mode === 'frame' && entry.frameText !== undefined) {
                    setWholeText(item, entry.frameText);
                    r.applied = 1;
                } else if (entry.paragraphs && entry.paragraphs.length) {
                    var pr = applyStoryParagraphs(reg, entry.paragraphs);
                    r.applied = pr.applied;
                    r.errors = pr.errors;
                }
            } catch (e2) {
                r.ok = false;
                r.error = '回写失败: ' + e2.message;
            }

            if (r.ok) {
                var fx = fixOverflow(item, overflowPolicy, overflowOpts);
                r.overflowFix = fx;
                try { r.overflowAfter = isOverflowing(item); } catch (e3) { }
                totalApplied += r.applied;
                if (r.errors.length) { totalErrors++; }
            } else {
                totalErrors++;
            }
            results.push(r);
        }

        if (snapshot.entries.length) {
            undoStack.push(snapshot);
            if (undoStack.length > 30) { undoStack.shift(); }
        }

        try { app.redraw(); } catch (e4) { }

        return ok({
            applied: totalApplied,
            errorCount: totalErrors,
            canUndo: undoStack.length > 0,
            results: results
        });
    }

    /** 撤销上一步翻译 */
    function undo() {
        if (!undoStack.length) { return ok({ restored: 0, message: '没有可撤销的操作' }); }
        var snapshot = undoStack.pop();
        var restored = 0, errors = [];
        for (var i = 0; i < snapshot.entries.length; i++) {
            var e = snapshot.entries[i];
            try {
                // 倒序还原各框（与回写方向一致，避免回流打乱内容）
                if (e.frames && e.frames.length) {
                    for (var fi = e.frames.length - 1; fi >= 0; fi--) {
                        try { e.frames[fi].item.contents = e.frames[fi].contents; } catch (err2) { }
                    }
                } else if (e.contents !== '') {
                    e.item.contents = e.contents;
                }
                if (e.width) { e.item.width = e.width; }
                if (e.height) { e.item.height = e.height; }
                if (e.size) { e.item.textRange.characterAttributes.size = e.size; }
                restored++;
            } catch (err) {
                errors.push(err.message);
            }
        }
        try { app.redraw(); } catch (e2) { }
        return ok({ restored: restored, errors: errors, canUndo: undoStack.length > 0 });
    }

    /** 在画布中选中某个对象（预览列表点击定位） */
    function selectItem(id) {
        var reg = registry[id];
        if (!reg || !reg.item) { return fail('对象已失效，请重新扫描'); }
        var doc = activeDoc();
        try {
            doc.selection = null;
            reg.item.selected = true;
            app.redraw();
        } catch (e) {
            return fail('选中失败: ' + e.message);
        }
        return ok({ id: id });
    }

    /** 只读取某个对象的最新文本（重新扫描单条时用） */
    function readItem(id) {
        var reg = registry[id];
        if (!reg || !reg.item) { return fail('对象已失效'); }
        var story = collectStoryParagraphs({ frames: reg.frames, scope: reg.scope });
        var contents = '';
        try { contents = reg.item.contents; } catch (e) { }
        return ok({
            id: id,
            contents: contents,
            chars: story.chars,
            paragraphs: story.paras,
            overflow: isOverflowing(reg.item)
        });
    }

    /* ============================================================
     * 9. 导出
     * ============================================================ */
    return {
        version: VERSION,
        ping: ping,
        scan: scan,
        apply: apply,
        undo: undo,
        selectItem: selectItem,
        readItem: readItem,
        _json: TXJSON
    };
})();
