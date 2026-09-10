/*************************************************************************
 * probe-links.jsx — 精确判定 nextFrame / previousFrame 在「未联排」时的返回值
 *************************************************************************/
(function () {
    var prev = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    var out = { cases: {}, errors: [] };
    var doc = null;

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

    function describe(label, frame) {
        var d = { label: label, text: '' };
        try { d.text = frame.contents.substr(0, 22); } catch (e) { }
        try {
            var nf = frame.nextFrame;
            d.nextTypeof = typeof nf;
            d.nextIsNull = (nf === null);
            d.nextIsSelf = (nf === frame);
            d.nextEquals = (nf && nf !== frame) ? (nf.contents || '').substr(0, 22) : null;
        } catch (e) { d.nextError = e.message; }
        try {
            var pf = frame.previousFrame;
            d.prevTypeof = typeof pf;
            d.prevIsNull = (pf === null);
            d.prevIsSelf = (pf === frame);
            d.prevEquals = (pf && pf !== frame) ? (pf.contents || '').substr(0, 22) : null;
        } catch (e) { d.prevError = e.message; }
        try { d.uuid = frame.uuid || '(无)'; } catch (e) { d.uuid = '(取不到)'; }
        return d;
    }

    try {
        doc = app.documents.add();

        // 未联排的点文本
        var pt = doc.textFrames.add();
        pt.contents = 'Standalone point text';
        pt.position = [50, 700];
        out.cases.standalonePoint = describe('standalone point', pt);

        // 未联排的区域文本
        var rect = doc.pathItems.rectangle(600, 50, 90, 40);
        var area = doc.textFrames.areaText(rect);
        area.contents = 'Standalone area text';
        out.cases.standaloneArea = describe('standalone area', area);

        // 联排两个框
        var r1 = doc.pathItems.rectangle(500, 350, 120, 60);
        var f1 = doc.textFrames.areaText(r1);
        var r2 = doc.pathItems.rectangle(400, 350, 120, 60);
        var f2 = doc.textFrames.areaText(r2, TextOrientation.HORIZONTAL, f1);
        var story = '';
        for (var i = 1; i <= 8; i++) story += 'Linked paragraph ' + i + '.\r';
        f1.contents = story;

        out.cases.linkFrame1 = describe('linked f1', f1);
        out.cases.linkFrame2 = describe('linked f2', f2);

        // 手工走一遍 nextFrame 链，看会不会打转
        var chain = [];
        var f = f1;
        for (var g = 0; g < 10; g++) {
            if (!f) { chain.push('null'); break; }
            var id = '';
            try { id = f.uuid || ''; } catch (e) { }
            chain.push(id ? id.substr(-6) : ('#' + g));
            var nx = null;
            try { nx = f.nextFrame; } catch (e) { nx = null; }
            if (nx === f) { chain.push('SELF-LOOP'); break; }
            f = nx;
        }
        out.cases.chain = chain;

        // 从第 2 个框往前走 previousFrame
        var back = [];
        var b = f2;
        for (var h = 0; h < 10; h++) {
            if (!b) { back.push('null'); break; }
            var bid = '';
            try { bid = b.uuid || ''; } catch (e) { }
            back.push(bid ? bid.substr(-6) : ('#' + h));
            var pv = null;
            try { pv = b.previousFrame; } catch (e) { pv = null; }
            if (pv === b) { back.push('SELF-LOOP'); break; }
            b = pv;
        }
        out.cases.backChain = back;

        out.cases.docTextFrames = doc.textFrames.length;
        out.cases.pageItems = doc.pageItems.length;
    } catch (e) {
        out.errors.push('主流程: ' + e.message);
    }

    try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) { }
    app.userInteractionLevel = prev;
    return jstr(out);
})();
