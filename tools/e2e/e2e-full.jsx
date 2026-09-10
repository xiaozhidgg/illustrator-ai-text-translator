/*************************************************************************
 * e2e-full.jsx — 在真实 Illustrator 中对插件宿主脚本做端到端验证
 *
 * 流程：建测试文档 → 加载 translator.jsx → 扫描 → 回写 → 溢出处理 → 撤销 → 校验
 * 返回：JSON 报告（含每条断言的通过/失败）
 *
 * 由 tools/e2e/run-e2e.ps1 通过 COM 调用。
 *************************************************************************/

(function () {
    var report = { assertions: [], info: {}, errors: [] };
    var doc = null;
    var prevLevel = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

    function jstr(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'object') {
            if (v instanceof Array) {
                var a = [];
                for (var i = 0; i < v.length; i++) a.push(jstr(v[i]));
                return '[' + a.join(',') + ']';
            }
            var p = [];
            for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) p.push('"' + k + '":' + jstr(v[k]));
            return '{' + p.join(',') + '}';
        }
        return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
    }

    function assert(name, condition, detail) {
        report.assertions.push({ name: name, pass: !!condition, detail: detail === undefined ? '' : detail });
    }

    function finish() {
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) { }
        app.userInteractionLevel = prevLevel;
        report.info.passCount = 0;
        report.info.failCount = 0;
        for (var i = 0; i < report.assertions.length; i++) {
            if (report.assertions[i].pass) report.info.passCount++;
            else report.info.failCount++;
        }
        return jstr(report);
    }

    /* ---------------- 0. 加载插件宿主脚本 ---------------- */
    try {
        var here = File($.fileName).parent;                 // tools/e2e
        var root = here.parent.parent;                      // 仓库根目录
        var jsxPath = root.fsName + '/com.dsh.aitranslator/jsx/translator.jsx';
        report.info.jsxPath = jsxPath;
        if (!File(jsxPath).exists) {
            report.errors.push('找不到 translator.jsx: ' + jsxPath);
            return finish();
        }
        $.evalFile(jsxPath);
        assert('插件脚本加载成功（TX 全局对象存在）', typeof TX === 'object' && typeof TX.scan === 'function');
    } catch (e) {
        report.errors.push('加载插件脚本失败: ' + e.message);
        return finish();
    }

    /* ---------------- 1. 建测试文档 ---------------- */
    try {
        doc = app.documents.add();
    } catch (e) {
        report.errors.push('新建文档失败: ' + e.message);
        return finish();
    }

    var pointText, areaText, storyF1, storyF2, groupedText;
    var SIZES = [12, 30, 18];

    try {
        // 1a. 点文本：3 段，字号各不相同
        pointText = doc.textFrames.add();
        pointText.contents = 'Save as\rExport the selected artwork\rLayer panel';
        pointText.textRange.characterAttributes.size = SIZES[0];
        pointText.paragraphs[1].characterAttributes.size = SIZES[1];
        pointText.paragraphs[2].characterAttributes.size = SIZES[2];
        pointText.position = [50, 700];

        // 1b. 区域文本：小框放长句，必然溢出
        var rect = doc.pathItems.rectangle(620, 50, 90, 40);
        areaText = doc.textFrames.areaText(rect);
        areaText.contents = 'This is a deliberately long sentence that will overflow the small area text frame for sure.';

        // 1c. 联排文本框：2 个框组成一个故事，共 6 段
        var r1 = doc.pathItems.rectangle(500, 350, 120, 60);
        storyF1 = doc.textFrames.areaText(r1);
        var r2 = doc.pathItems.rectangle(400, 350, 120, 60);
        storyF2 = doc.textFrames.areaText(r2, TextOrientation.HORIZONTAL, storyF1);
        var story = '';
        for (var i = 1; i <= 6; i++) {
            story += 'Story paragraph ' + i + ' needs translation.\r';
        }
        storyF1.contents = story;

        // 1d. 组内文本：验证递归遍历 + 不重复
        var g = doc.groupItems.add();
        groupedText = doc.textFrames.add();
        groupedText.move(g, ElementPlacement.INSIDE);
        groupedText.contents = 'Grouped text should be found once';
        groupedText.position = [50, 300];

        assert('测试文档创建完成', true);
    } catch (e) {
        report.errors.push('创建测试内容失败: ' + e.message);
        return finish();
    }

    /* ---------------- 2. ping ---------------- */
    var ping = TX._json.parse(TX.ping());
    report.info.ping = ping;
    assert('ping 返回 ok', ping.ok === true);
    report.info.hasOverflowsProp = ping.caps ? ping.caps.hasOverflowsProp : null;
    report.info.hasUuid = ping.caps ? ping.caps.hasUuid : null;

    /* ---------------- 3. 扫描 ---------------- */
    var scan = TX._json.parse(TX.scan('{"scope":"document"}'));
    report.info.scan = {
        ok: scan.ok, itemCount: scan.itemCount, frameCount: scan.frameCount,
        skipped: scan.skipped
    };
    assert('扫描成功', scan.ok === true, scan.error || '');
    if (!scan.ok) { return finish(); }

    // 期望：点文本 + 区域文本 + 联排故事(1 条) + 组内文本 = 4 条
    assert('扫描到 4 个文本对象（联排故事合并为 1 条）', scan.itemCount === 4, '实际 ' + scan.itemCount);

    var byKind = {};
    var storyItem = null, pointItem = null, areaItem = null, groupItem = null;
    for (var s = 0; s < scan.items.length; s++) {
        var it = scan.items[s];
        byKind[it.kind] = (byKind[it.kind] || 0) + 1;
        if (it.frameCount > 1) { storyItem = it; }
        else if (it.kind === 'point') { pointItem = it; }
        else if (it.kind === 'area' && it.overflow) { areaItem = it; }
        else if (it.kind === 'point' || it.kind === 'area') { groupItem = groupItem || it; }
    }
    report.info.byKind = byKind;

    assert('识别到点文本', !!pointItem);
    assert('识别到溢出的区域文本', !!areaItem, areaItem ? ('overflow=' + areaItem.overflow) : '');
    assert('识别到联排故事（frameCount>1）', !!storyItem,
        storyItem ? ('frameCount=' + storyItem.frameCount + ' scope=' + storyItem.storyScope) : '');

    // 关键断言：联排故事必须包含全部 6 段，而不是只有第 1 个框的 2 段
    if (storyItem) {
        var nonEmpty = 0;
        for (var sp = 0; sp < storyItem.paragraphs.length; sp++) {
            if (storyItem.paragraphs[sp].text !== '') nonEmpty++;
        }
        assert('联排故事扫描到全部 6 个段落', nonEmpty >= 6, '实际非空段落 ' + nonEmpty + '，总段数 ' + storyItem.paragraphs.length);
        assert('联排故事字符数 > 单个框（contents 分片已合并）', storyItem.chars > 100, 'chars=' + storyItem.chars);
    }

    // 组内文本只出现一次
    var groupHits = 0;
    for (var gi = 0; gi < scan.items.length; gi++) {
        for (var gp = 0; gp < scan.items[gi].paragraphs.length; gp++) {
            if (scan.items[gi].paragraphs[gp].text.indexOf('Grouped text') === 0) groupHits++;
        }
    }
    assert('组内文本被找到且只找到一次', groupHits === 1, '命中 ' + groupHits + ' 次');

    /* ---------------- 4. 构造译文并回写 ---------------- */
    // 记录回写前状态，用于撤销校验
    var before = {};
    var applyItems = [];
    var totalParas = 0;

    for (var ai = 0; ai < scan.items.length; ai++) {
        var item = scan.items[ai];
        before[item.id] = [];
        var paras = [];
        for (var ap = 0; ap < item.paragraphs.length; ap++) {
            var src = item.paragraphs[ap].text;
            before[item.id].push(src);
            if (src === '') continue;
            var dst = '译文' + (ap + 1) + '号';          // 不含数字以外的字符，便于校验
            paras.push({ i: item.paragraphs[ap].i, text: dst });
            totalParas++;
        }
        applyItems.push({ id: item.id, paragraphs: paras });
    }

    var applyRes = TX._json.parse(TX.apply(jstr({
        mode: 'paragraph',
        overflow: { policy: 'expand', maxGrow: 3.0 },
        items: applyItems
    })));
    report.info.apply = { ok: applyRes.ok, applied: applyRes.applied, errorCount: applyRes.errorCount };
    assert('回写成功', applyRes.ok === true, applyRes.error || '');
    assert('回写段落数等于送出的段落数', applyRes.applied === totalParas,
        'applied=' + applyRes.applied + ' 期望=' + totalParas);

    /* ---------------- 5. 回读校验 ---------------- */
    var verifyFailures = [];
    for (var vi = 0; vi < scan.items.length; vi++) {
        var vItem = scan.items[vi];
        var read = TX._json.parse(TX.readItem(vItem.id));
        if (!read.ok) { verifyFailures.push(vItem.id + ' 回读失败'); continue; }
        for (var vp = 0; vp < read.paragraphs.length; vp++) {
            var expect = before[vItem.id][vp];
            var actual = read.paragraphs[vp].text;
            if (expect === '') {
                if (actual !== '') verifyFailures.push(vItem.id + ' 段' + vp + ' 空段被改动');
            } else if (actual.indexOf('译文') !== 0) {
                verifyFailures.push(vItem.id + ' 段' + vp + ' 未被翻译：' + actual);
            }
        }
    }
    assert('所有段落都写回了译文（含联排故事的第 2 个框）', verifyFailures.length === 0,
        verifyFailures.slice(0, 4).join('; '));

    // 联排故事的第 2 个框确实收到了译文
    if (storyItem) {
        var f2Text = '';
        try { f2Text = storyF2.contents; } catch (e) { }
        assert('联排第 2 个框内容已被改写', f2Text.indexOf('译文') >= 0, 'f2=' + f2Text.substr(0, 40));
    }

    /* ---------------- 6. 格式保真校验 ---------------- */
    var sizes = [];
    try {
        for (var ps = 0; ps < 3; ps++) {
            sizes.push(pointText.paragraphs[ps].characterAttributes.size);
        }
    } catch (e) { }
    report.info.pointSizes = sizes;
    assert('点文本三段字号保持 12/30/18', sizes[0] === 12 && sizes[1] === 30 && sizes[2] === 18,
        '实际 ' + jstr(sizes));

    /* ---------------- 7. 溢出处理校验 ---------------- */
    var overflowAfter = false;
    var areaWidth = 0;
    try {
        areaWidth = areaText.width;
        // 用与插件相同的判据复检
        var total = areaText.textRange.length;
        var lines = areaText.lines, visible = 0;
        for (var l = 0; l < lines.length; l++) visible += lines[l].contents.length;
        overflowAfter = (visible + lines.length) < total;
    } catch (e) { }
    report.info.areaWidthAfter = areaWidth;
    report.info.overflowAfter = overflowAfter;
    assert('溢出区域文本在 expand 策略后不再溢出', overflowAfter === false,
        'overflow=' + overflowAfter + ' 宽度=' + areaWidth);

    /* ---------------- 8. 撤销校验 ---------------- */
    var undoRes = TX._json.parse(TX.undo());
    assert('撤销返回 ok', undoRes.ok === true, undoRes.error || '');

    var undoFailures = [];
    for (var ui = 0; ui < scan.items.length; ui++) {
        var uItem = scan.items[ui];
        var uRead = TX._json.parse(TX.readItem(uItem.id));
        if (!uRead.ok) { undoFailures.push(uItem.id + ' 回读失败'); continue; }
        for (var up = 0; up < uRead.paragraphs.length; up++) {
            if (uRead.paragraphs[up].text !== before[uItem.id][up]) {
                undoFailures.push(uItem.id + ' 段' + up + ' 未还原');
            }
        }
    }
    assert('撤销后所有文本恢复原样', undoFailures.length === 0, undoFailures.slice(0, 4).join('; '));

    /* ---------------- 9. 整框替换模式 ---------------- */
    var frameRes = TX._json.parse(TX.apply(jstr({
        mode: 'frame',
        overflow: { policy: 'report' },
        items: [{ id: scan.items[0].id, frameText: '整框替换测试文本' }]
    })));
    assert('整框替换模式可用', frameRes.ok === true && frameRes.applied === 1,
        'applied=' + (frameRes ? frameRes.applied : 'null'));
    var afterFrame = TX._json.parse(TX.readItem(scan.items[0].id));
    assert('整框替换后内容正确', afterFrame.ok && afterFrame.contents === '整框替换测试文本',
        '实际 ' + (afterFrame ? afterFrame.contents : ''));

    TX.undo();   // 收拾干净

    return finish();
})();
