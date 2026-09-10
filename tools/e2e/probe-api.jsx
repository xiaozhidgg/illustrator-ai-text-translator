/*************************************************************************
 * probe-api.jsx — 在真实 Illustrator 中核对文本 API 行为
 * 由 tools/e2e/run-probe.ps1 通过 COM (Illustrator.Application.DoJavaScriptFile) 调用
 * 返回：JSON 字符串（DoJavaScriptFile 的返回值）
 *************************************************************************/
#target illustrator

(function () {
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
            for (var k in v) if (v.hasOwnProperty(k)) p.push('"' + k + '":' + jstr(v[k]));
            return '{' + p.join(',') + '}';
        }
        return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
    }

    var out = { app: {}, point: {}, area: {}, linked: {}, story: {}, errors: [] };
    var doc = null;

    try {
        out.app.version = app.version;
        out.app.name = app.name;
        out.app.locale = app.locale;
    } catch (e) {
        out.errors.push('app: ' + e.message);
    }

    try {
        doc = app.documents.add();
    } catch (e) {
        out.errors.push('documents.add: ' + e.message);
        app.userInteractionLevel = prevLevel;
        return jstr(out);
    }

    /* ---------- 1. 点文本：段落级替换能否保留格式 ---------- */
    try {
        var pt = doc.textFrames.add();
        pt.contents = 'Hello world\rSecond paragraph\rThird paragraph';
        pt.textRange.characterAttributes.size = 12;
        pt.paragraphs[1].characterAttributes.size = 30;          // 第二段放大
        pt.paragraphs[2].characterAttributes.size = 18;          // 第三段中等
        pt.paragraphs[2].characterAttributes.fillColor = doc.swatches.getByName('C=100 M=100 Y=0 K=0').color;

        out.point.typeofOverflows = typeof pt.overflows;
        out.point.hasOverflowsProp = ('overflows' in pt);
        out.point.kind = pt.kind ? pt.kind.toString() : null;
        out.point.contents = pt.contents;
        out.point.paragraphCount = pt.paragraphs.length;
        out.point.textRangeLength = pt.textRange.length;
        out.point.sizesBefore = [
            pt.paragraphs[0].characterAttributes.size,
            pt.paragraphs[1].characterAttributes.size,
            pt.paragraphs[2].characterAttributes.size
        ];

        // 倒序替换第二段（模拟翻译回写）
        pt.paragraphs[1].contents = '第二段译文';
        out.point.afterReplaceContents = pt.contents;
        out.point.afterReplaceParagraphCount = pt.paragraphs.length;
        out.point.sizesAfter = [
            pt.paragraphs[0].characterAttributes.size,
            pt.paragraphs[1].characterAttributes.size,
            pt.paragraphs[2].characterAttributes.size
        ];
        out.point.storyProperty = typeof pt.story;
        out.point.storyContents = pt.story ? pt.story.textRange.contents : null;
        out.point.textRangeContents = pt.textRange.contents;
        out.point.textRangeIsWholeStory = pt.textRange.contents === pt.contents;
    } catch (e) {
        out.errors.push('point: ' + e.message);
    }

    /* ---------- 2. 区域文本：溢出检测手段 ---------- */
    try {
        var rect = doc.pathItems.rectangle(400, 100, 60, 30);   // 很小的框
        var area = doc.textFrames.areaText(rect);
        area.contents = 'This is a long sentence that should definitely overflow the small area text frame.';
        out.area.kind = area.kind ? area.kind.toString() : null;
        out.area.typeofOverflows = typeof area.overflows;
        out.area.contentsLength = area.contents.length;
        out.area.lineCount = area.lines.length;
        out.area.textRangeLength = area.textRange.length;
        out.area.startTValue = typeof area.startTValue === 'number' ? area.startTValue : String(typeof area.startTValue);
        out.area.endTValue = typeof area.endTValue === 'number' ? area.endTValue : String(typeof area.endTValue);
        out.area.geometricBounds = area.geometricBounds;
        out.area.visibleBounds = area.visibleBounds;
        // 尝试用 lines 的 last line 判断是否溢出（lines 里最后一行是否为空/被截断）
        try {
            var last = area.lines[area.lines.length - 1];
            out.area.lastLine = last.contents;
        } catch (e2) {
            out.area.lastLine = 'ERR:' + e2.message;
        }
        // textRange 的 characterAttributes 是否可读，用于判断可写范围
        out.area.textRangeStart = area.textRange.start;
        out.area.textRangeEnd = area.textRange.end;
        // 关键实验：lines 的条数 vs 实际能显示的条数（用 paragraphAttributes 高度估算）
        out.area.textPathType = typeof area.textPath;
    } catch (e) {
        out.errors.push('area: ' + e.message);
    }

    /* ---------- 3. 联排文本框：contents 语义 ---------- */
    try {
        var r1 = doc.pathItems.rectangle(300, 100, 80, 40);
        var t1 = doc.textFrames.areaText(r1);
        var r2 = doc.pathItems.rectangle(200, 100, 80, 40);
        var t2 = doc.textFrames.areaText(r2, TextOrientation.HORIZONTAL, t1);

        var longText = '';
        for (var i = 1; i <= 20; i++) longText += 'Paragraph number ' + i + ' of the story.\r';
        t1.contents = longText;

        out.linked.t1Len = t1.contents.length;
        out.linked.t2Len = t2.contents.length;
        out.linked.sameLength = t1.contents.length === t2.contents.length;
        out.linked.t1Head = t1.contents.substr(0, 40);
        out.linked.t2Head = t2.contents.substr(0, 40);
        out.linked.t1NextFrameExists = !!t1.nextFrame;
        out.linked.t2PreviousFrameExists = !!t2.previousFrame;
        out.linked.t1ParagraphCount = t1.paragraphs.length;
        out.linked.t2ParagraphCount = t2.paragraphs.length;
        out.linked.t1TextRangeLen = t1.textRange.length;
        out.linked.t2TextRangeLen = t2.textRange.length;
        out.linked.storyIsSame = t1.story && t2.story ? (t1.story === t2.story) : null;
        out.linked.t1StoryLen = t1.story ? t1.story.textRange.length : null;

        // 对第 2 个框（非故事根）做段落替换，看是否作用于整个故事
        t2.paragraphs[3].contents = '【替换测试】';
        out.linked.afterReplace_t1Contains = t1.contents.indexOf('【替换测试】') >= 0;
        out.linked.afterReplace_t2Contains = t2.contents.indexOf('【替换测试】') >= 0;
        out.linked.afterReplace_t1Len = t1.contents.length;
    } catch (e) {
        out.errors.push('linked: ' + e.message);
    }

    /* ---------- 4. 文档级集合与遍历 ---------- */
    try {
        out.story.docTextFrames = doc.textFrames.length;
        out.story.docStories = typeof doc.stories === 'number' ? doc.stories : String(typeof doc.stories);
        out.story.docSelectionType = doc.selection ? doc.selection.typename : 'null';
    } catch (e) {
        out.errors.push('story: ' + e.message);
    }

    try {
        doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (e) {
        out.errors.push('close: ' + e.message);
    }

    app.userInteractionLevel = prevLevel;
    return jstr(out);
})();
