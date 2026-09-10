/**
 * core.js — 纯逻辑层（无 DOM、无 Node 依赖）
 * 同时被 CEP 面板和 Node 单测（tools/test-core.mjs）加载。
 *
 * 职责：文本切分、可译性判断、术语表、去重、分批、译文清洗、结果合并。
 */
(function (root, factory) {
  var api = factory();
  // CEP 面板（--mixed-context）里同时存在 module 与 window，
  // 所以两种导出都要做，否则 window.TXCore 会是 undefined
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.TXCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 语言 / 字符判断
   * ------------------------------------------------------------------ */
  var RE = {
    cjk: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3007]/,
    kana: /[\u3040-\u30ff]/,
    hangul: /[\uac00-\ud7af\u1100-\u11ff]/,
    latin: /[A-Za-z\u00c0-\u024f]/,
    cyrillic: /[\u0400-\u04ff]/,
    letter: /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/,
    url: /^(https?:\/\/|www\.)\S+$/i,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    pureNumber: /^[\s\d.,:;+\-–—%°'"()\[\]{}\/\\|*#&@_=~^`<>]*$/,
    placeholder: /^[{\[<%$#].*[}\]>%$#]$/,
    hasLetter: /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/,
  };

  function detectScript(text) {
    var s = String(text || '');
    var hasCjk = RE.cjk.test(s) || RE.kana.test(s) || RE.hangul.test(s);
    var hasLatin = RE.latin.test(s);
    var hasCyr = RE.cyrillic.test(s);
    if (hasCjk && (hasLatin || hasCyr)) return 'mixed';
    if (hasCjk) return 'cjk';
    if (hasLatin) return 'latin';
    if (hasCyr) return 'cyrillic';
    return 'none';
  }

  function isCjkLang(lang) {
    return /^(zh|ja|ko)/i.test(String(lang || ''));
  }

  /* ------------------------------------------------------------------ *
   * 段落切分
   * ------------------------------------------------------------------ */
  function splitParagraphs(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');
  }

  function joinParagraphs(list, sep) {
    return (list || []).join(sep === undefined ? '\r' : sep);
  }

  /** 把多行文本压成单行（送给翻译引擎前），保留可读的空格 */
  function flatten(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/\r\n/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[ \t\u00a0\u3000]+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
  }

  /* ------------------------------------------------------------------ *
   * 可译性判断
   * ------------------------------------------------------------------ */
  /**
   * @param {string} text
   * @param {object} opts
   *   targetLang      目标语言（如 zh-CN）
   *   skipPureNumber  纯数字/符号跳过（默认 true）
   *   skipUrlEmail    网址/邮箱跳过（默认 true）
   *   skipTargetLang  已是目标语言则跳过（默认 true）
   *   minChars        最短字符数（默认 1）
   * @returns {{ok:boolean, reason:string}}
   */
  function checkTranslatable(text, opts) {
    opts = opts || {};
    var s = String(text === null || text === undefined ? '' : text);
    var t = flatten(s);

    if (t === '') return { ok: false, reason: 'empty' };
    if (t.length < (opts.minChars || 1)) return { ok: false, reason: 'too-short' };

    if (opts.skipPureNumber !== false && (RE.pureNumber.test(t) || !RE.hasLetter.test(t))) {
      return { ok: false, reason: 'no-letter' };
    }
    if (opts.skipUrlEmail !== false && (RE.url.test(t) || RE.email.test(t))) {
      return { ok: false, reason: 'url-email' };
    }
    if (opts.skipPlaceholder !== false && RE.placeholder.test(t)) {
      return { ok: false, reason: 'placeholder' };
    }
    if (opts.skipTargetLang !== false && isCjkLang(opts.targetLang) && detectScript(t) === 'cjk') {
      return { ok: false, reason: 'already-target-lang' };
    }
    if (!isCjkLang(opts.targetLang) && detectScript(t) === 'latin' && opts.sourceLang === 'auto') {
      // 目标非中文且原文是拉丁文：只有在源语言明确时才翻译，否则可能白翻
      if (!opts.allowSameScript) return { ok: false, reason: 'same-script' };
    }
    return { ok: true, reason: '' };
  }

  /* ------------------------------------------------------------------ *
   * 术语表
   * ------------------------------------------------------------------ */
  /**
   * pairs: [{ from: 'Design', to: '设计' }]
   * 方向：把原文里的 from 预替换为 to，再翻译（提升一致性）；
   * 译文后处理时把可能被引擎改写的 to 再纠回。
   */
  function applyGlossary(text, pairs, phase) {
    if (!pairs || !pairs.length) return text;
    var s = String(text);
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (!p || !p.from) continue;
      var from = String(p.from);
      var to = p.to === undefined || p.to === null ? '' : String(p.to);
      if (from === '') continue;
      if (phase === 'after') {
        // 只做整体包含式纠偏，避免误伤
        if (to && s.indexOf(to) !== -1) continue;
      } else {
        var re = new RegExp(escapeRe(from), 'gi');
        s = s.replace(re, to);
      }
    }
    return s;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ *
   * 任务规划：去重 + 过滤 + 分批
   * ------------------------------------------------------------------ */
  /**
   * @param {Array} items  扫描结果 items：[{id, paragraphs:[{i,text}]}]
   * @param {object} opts  { targetLang, sourceLang, glossary, maxCharsPerRequest, maxItemsPerRequest, minChars }
   * @returns {{tasks:Array, unique:Array, skipped:Array, stats:object}}
   *   tasks:  [{ itemId, paraIndex, hash }]
   *   unique: [{ hash, text, refs:[{itemId,paraIndex}], chars }]
   */
  function planTasks(items, opts) {
    opts = opts || {};
    var maxChars = opts.maxCharsPerRequest || 2000;
    var byHash = {};
    var unique = [];
    var tasks = [];
    var skipped = [];
    var glossary = opts.glossary || [];

    for (var i = 0; i < (items || []).length; i++) {
      var item = items[i];
      var paras = item.paragraphs || [];
      for (var p = 0; p < paras.length; p++) {
        var raw = paras[p].text;
        var check = checkTranslatable(raw, opts);
        if (!check.ok) {
          skipped.push({ itemId: item.id, paraIndex: paras[p].i, text: raw, reason: check.reason });
          continue;
        }
        var pre = applyGlossary(flatten(raw), glossary, 'before');
        var hash = simpleHash(pre);
        if (!byHash[hash]) {
          byHash[hash] = { hash: hash, text: pre, refs: [], chars: pre.length };
          unique.push(byHash[hash]);
        }
        byHash[hash].refs.push({ itemId: item.id, paraIndex: paras[p].i });
        tasks.push({ itemId: item.id, paraIndex: paras[p].i, hash: hash });
      }
    }

    // 超长文本单独成批
    var batches = [];
    var cur = { texts: [], chars: 0 };
    for (var u = 0; u < unique.length; u++) {
      var entry = unique[u];
      var maxItems = opts.maxItemsPerRequest || 20;
      if (entry.chars > maxChars) {
        if (cur.texts.length) { batches.push(cur); cur = { texts: [], chars: 0 }; }
        batches.push({ texts: [entry], chars: entry.chars, oversized: true });
        continue;
      }
      if (cur.texts.length >= maxItems || cur.chars + entry.chars > maxChars) {
        if (cur.texts.length) { batches.push(cur); }
        cur = { texts: [], chars: 0 };
      }
      cur.texts.push(entry);
      cur.chars += entry.chars;
    }
    if (cur.texts.length) batches.push(cur);

    return {
      tasks: tasks,
      unique: unique,
      skipped: skipped,
      batches: batches,
      stats: {
        paragraphCount: tasks.length + skipped.length,
        uniqueCount: unique.length,
        skippedCount: skipped.length,
        batchCount: batches.length,
        savedByDedupe: tasks.length - unique.length,
      },
    };
  }

  function simpleHash(str) {
    var h = 5381, i = str.length;
    while (i) { h = (h * 33) ^ str.charCodeAt(--i); }
    return (h >>> 0).toString(36) + '_' + str.length;
  }

  /* ------------------------------------------------------------------ *
   * 译文清洗
   * ------------------------------------------------------------------ */
  function cleanTranslation(text) {
    var s = String(text === null || text === undefined ? '' : text);
    s = s.replace(/^\uFEFF/, '');
    // 去掉模型常见的包裹
    s = s.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
    s = s.replace(/^\s*(翻译|译文|translation|translated)\s*[:：]\s*/i, '');
    // 去掉整句外层引号（但保留原文本身的引号语义）
    if (s.length > 1 && /^["'“”‘’]/.test(s) && /["'“”‘’]$/.test(s)) {
      s = s.slice(1, -1);
    }
    s = s.replace(/[\r\n]+/g, ' ').replace(/[ \t\u00a0\u3000]+/g, ' ');
    return s.replace(/^\s+|\s+$/g, '');
  }

  /** 从 LLM 输出里稳健地取出字符串数组 */
  function parseTranslationArray(raw, expected) {
    var s = String(raw || '');
    var candidates = [];
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1]);
    candidates.push(s);
    var firstBracket = s.indexOf('[');
    var lastBracket = s.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      candidates.push(s.slice(firstBracket, lastBracket + 1));
    }
    var partial = null;
    for (var i = 0; i < candidates.length; i++) {
      try {
        var v = JSON.parse(candidates[i]);
        var arr = null;
        if (Array.isArray(v)) arr = v.map(function (x) { return String(x); });
        else if (v && Array.isArray(v.translations)) arr = v.translations.map(function (x) { return String(x); });
        if (!arr) continue;
        // 数量必须严格一致，否则宁可报错让上层换引擎，避免错位回写
        if (arr.length === expected) return arr;
        if (!partial) partial = arr;
      } catch (e) { /* 继续尝试下一个候选 */ }
    }
    // 退化：按行取（去掉序号前缀）
    var lines = s.split(/\r?\n/)
      .map(function (l) { return l.replace(/^\s*\d+\s*[.、:：)]\s*/, '').trim(); })
      .filter(function (l) { return l !== ''; });
    if (lines.length === expected) return lines;
    if (lines.length > expected) return lines.slice(0, expected);
    throw new Error(
      '无法从模型输出解析译文数组（期望 ' + expected + ' 条，实际得到 ' +
      (partial ? partial.length : lines.length) + ' 条）'
    );
  }

  /** 把译文合并回每个段落 */
  function mergeResults(plan, translationByHash) {
    var updates = {};
    for (var i = 0; i < plan.tasks.length; i++) {
      var task = plan.tasks[i];
      var tr = translationByHash[task.hash];
      if (tr === undefined || tr === null) continue;
      if (!updates[task.itemId]) updates[task.itemId] = [];
      updates[task.itemId].push({ i: task.paraIndex, text: tr });
    }
    return updates;
  }

  function estimateRatio(src, dst) {
    var a = String(src || '').length || 1;
    var b = String(dst || '').length;
    return Math.round((b / a) * 100) / 100;
  }

  /* ------------------------------------------------------------------ *
   * 大小写变换（输出大写英文等）
   * ------------------------------------------------------------------ */
  var CASE_MODES = ['keep', 'upper', 'lower', 'title'];

  /** 单词首字母大写，其余字母保持原样（不破坏 SAVE、iPhone 这类既有写法） */
  function titleCase(text) {
    return String(text).replace(/[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'\u2019-]*/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  /**
   * 按模式变换大小写。
   * 中文等无大小写概念的字符原样保留，所以对中文译文调用是安全的。
   * @param {string} text
   * @param {string} mode 'keep' | 'upper' | 'lower' | 'title'
   */
  function transformCase(text, mode) {
    var s = String(text === null || text === undefined ? '' : text);
    if (!mode || mode === 'keep') return s;
    try {
      if (mode === 'upper') return s.toUpperCase();
      if (mode === 'lower') return s.toLowerCase();
      if (mode === 'title') return titleCase(s);
    } catch (e) {
      return s;
    }
    return s;
  }

  /**
   * 被可译性规则跳过的段落是否允许做大小写改写。
   * 网址/邮箱/占位符排除在外——把 URL 改成大写可能改变含义甚至让链接失效。
   */
  var CASE_UNSAFE_REASONS = ['url-email', 'placeholder'];

  function caseTransformAllowed(reason) {
    return CASE_UNSAFE_REASONS.indexOf(String(reason || '')) === -1;
  }

  /** 该模式下这段文本是否真的会变（用于决定要不要回写） */
  function caseChanges(text, mode) {
    var s = String(text === null || text === undefined ? '' : text);
    return transformCase(s, mode) !== s;
  }

  /* ------------------------------------------------------------------ *
   * LLM 提示词
   * ------------------------------------------------------------------ */
  function buildLlmPrompt(texts, opts) {
    opts = opts || {};
    var target = opts.targetLang || 'zh-CN';
    var source = opts.sourceLang && opts.sourceLang !== 'auto' ? opts.sourceLang : '自动识别';
    var glossary = opts.glossary || [];
    var lines = [];
    lines.push('你是专业的平面设计文案翻译。把下面 JSON 数组中的每一条文本翻译成 ' + target + '。');
    lines.push('源语言：' + source + '。');
    lines.push('要求：');
    lines.push('1. 只翻译文本内容，保持原意、语气和专业术语；不要添加解释、不要输出多余内容。');
    lines.push('2. 输出必须是 JSON 字符串数组，长度与输入完全一致，顺序一一对应。');
    lines.push('3. 不要合并或拆分条目；不要保留原文换行；不要输出 Markdown 代码块标记。');
    if (glossary.length) {
      var pairs = glossary
        .filter(function (g) { return g && g.from && g.to; })
        .map(function (g) { return g.from + ' → ' + g.to; });
      if (pairs.length) {
        lines.push('4. 以下术语必须按下述译法翻译：' + pairs.join('；') + '。');
      }
    }
    lines.push('输入：' + JSON.stringify(texts.map(function (t) { return t.text; })));
    return lines.join('\n');
  }

  return {
    RE: RE,
    detectScript: detectScript,
    isCjkLang: isCjkLang,
    splitParagraphs: splitParagraphs,
    joinParagraphs: joinParagraphs,
    flatten: flatten,
    checkTranslatable: checkTranslatable,
    applyGlossary: applyGlossary,
    planTasks: planTasks,
    simpleHash: simpleHash,
    cleanTranslation: cleanTranslation,
    parseTranslationArray: parseTranslationArray,
    mergeResults: mergeResults,
    estimateRatio: estimateRatio,
    CASE_MODES: CASE_MODES,
    transformCase: transformCase,
    titleCase: titleCase,
    caseTransformAllowed: caseTransformAllowed,
    caseChanges: caseChanges,
    buildLlmPrompt: buildLlmPrompt,
  };
});
