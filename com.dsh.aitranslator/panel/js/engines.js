/**
 * engines.js — 翻译引擎适配层（Node / CEP 面板内）
 *
 * 免费免 Key 引擎（实测可用）：
 *   bing      微软 Bing 翻译（cn.bing.com 公开链路，质量高，支持 usedLLM）
 *   tencent   腾讯交互翻译 Transmart（支持批量，速度快）
 *   youdao    有道翻译 demo 接口（快，但限流严格，需串行）
 *   google    Google 免费接口（国内需代理）
 *   mymemory  MyMemory（免费额度 1000 词/天）
 * 需 Key 引擎：
 *   deepl     DeepL API Free
 *   openai    OpenAI 兼容接口（DeepSeek / 智谱 GLM-4-Flash / 硅基流动 / Ollama / OpenAI）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./http.js'), require('./core.js'));
  } else {
    root.TXEngines = factory(root.TXHttp, root.TXCore);
  }
})(typeof self !== 'undefined' ? self : this, function (http, core) {

  var LANGS = {
    auto:   { bing: 'auto-detect', tencent: 'auto',   youdao: 'auto',   google: 'auto',  deepl: null, llm: '自动识别', mymemory: null },
    'zh-CN':{ bing: 'zh-Hans',     tencent: 'zh',     youdao: 'zh-CHS', google: 'zh-CN', deepl: 'ZH', llm: '简体中文', mymemory: 'zh-CN' },
    'zh-TW':{ bing: 'zh-Hant',     tencent: 'zh',     youdao: 'zh-CHT', google: 'zh-TW', deepl: 'ZH', llm: '繁体中文', mymemory: 'zh-TW' },
    en:     { bing: 'en',          tencent: 'en',     youdao: 'en',     google: 'en',    deepl: 'EN', llm: '英语',    mymemory: 'en' },
    ja:     { bing: 'ja',          tencent: 'ja',     youdao: 'ja',     google: 'ja',    deepl: 'JA', llm: '日语',    mymemory: 'ja' },
    ko:     { bing: 'ko',          tencent: 'ko',     youdao: 'ko',     google: 'ko',    deepl: 'KO', llm: '韩语',    mymemory: 'ko' },
    fr:     { bing: 'fr',          tencent: 'fr',     youdao: 'fr',     google: 'fr',    deepl: 'FR', llm: '法语',    mymemory: 'fr' },
    de:     { bing: 'de',          tencent: 'de',     youdao: 'de',     google: 'de',    deepl: 'DE', llm: '德语',    mymemory: 'de' },
    es:     { bing: 'es',          tencent: 'es',     youdao: 'es',     google: 'es',    deepl: 'ES', llm: '西班牙语', mymemory: 'es' },
    ru:     { bing: 'ru',          tencent: 'ru',     youdao: 'ru',     google: 'ru',    deepl: 'RU', llm: '俄语',    mymemory: 'ru' },
    it:     { bing: 'it',          tencent: 'it',     youdao: 'it',     google: 'it',    deepl: 'IT', llm: '意大利语', mymemory: 'it' },
    pt:     { bing: 'pt',          tencent: 'pt',     youdao: 'pt',     google: 'pt',    deepl: 'PT-BR', llm: '葡萄牙语', mymemory: 'pt' },
  };

  function langOf(engineId, lang) {
    var row = LANGS[lang] || LANGS['zh-CN'];
    return row[engineId] !== undefined ? row[engineId] : lang;
  }

  function form(obj) {
    return Object.keys(obj)
      .filter(function (k) { return obj[k] !== undefined && obj[k] !== null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); })
      .join('&');
  }

  function need(res) {
    if (res.status < 200 || res.status >= 300) {
      throw new Error('HTTP ' + res.status + '：' + String(res.text || '').slice(0, 120));
    }
    return res;
  }

  /* ================================================================
   * Bing（免 Key）
   * ================================================================ */
  var bingSession = null;

  async function bingGetSession(ctx) {
    if (bingSession && Date.now() - bingSession.ts < 6 * 60 * 1000) return bingSession;

    var res = await http.request({
      url: 'https://cn.bing.com/translator',
      headers: { accept: 'text/html,application/xhtml+xml' },
      proxy: ctx.proxy,
      timeout: 20000,
      retries: 1,
    });
    need(res);
    var html = res.text || '';
    var helper = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/);
    var ig = html.match(/IG:"([^"]+)"/);
    var iid = html.match(/data-iid="([^"]+)"/);
    if (!helper) throw new Error('Bing 会话初始化失败（未找到 token）');
    var parts = helper[1].split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
    // http 层会自动跟随重定向并收集 Cookie（www.bing.com → cn.bing.com）
    var cookie = (res.cookies || []).join('; ');

    bingSession = {
      key: parts[0],
      token: parts[1],
      ig: ig ? ig[1] : '',
      iid: iid ? iid[1] : '',
      cookie: cookie,
      ts: Date.now(),
      used: 0,
    };
    return bingSession;
  }

  var bingQueue = http.createSerialQueue(120);
  var bingEmptyStreak = 0;
  var bingBlockedUntil = 0;

  function bingBlockedError() {
    return new Error('Bing 触发接口限流，冷却中（约 ' +
      Math.ceil((bingBlockedUntil - Date.now()) / 1000) + ' 秒后恢复）');
  }

  /** 用给定会话发一次翻译请求，返回原始响应文本 */
  async function bingPost(text, s, ctx) {
    var url = 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(s.ig) + '&IID=' + encodeURIComponent(s.iid);
    var body = form({
      fromLang: langOf('bing', ctx.sourceLang || 'auto'),
      text: text,
      to: langOf('bing', ctx.targetLang || 'zh-CN'),
      token: s.token,
      key: s.key,
    });
    var res = await http.request({
      url: url,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://cn.bing.com/translator',
        origin: 'https://cn.bing.com',
        cookie: s.cookie,
      },
      body: body,
      proxy: ctx.proxy,
      timeout: 20000,
      retries: 0,
    });
    need(res);
    return String(res.text || '').trim();
  }

  /**
   * 单条翻译。
   * 实测：Bing 会返回 HTTP 200 + 空 body 表示「被限流」。
   *   - 偶发 1 次空 → 同一会话重试即可成功
   *   - 连续多次空 → 已触发 IP 配额（约 8 条/窗口），此时换会话也没用，
   *     必须快速失败让上层降级到别的引擎，并进入冷却期
   */
  async function bingOne(text, ctx) {
    if (Date.now() < bingBlockedUntil) throw bingBlockedError();

    var s = await bingGetSession(ctx);
    var lastErr = null;

    for (var attempt = 0; attempt < 2; attempt++) {
      if (s.used > 8) { bingSession = null; s = await bingGetSession(ctx); }
      s.used++;

      var raw = '';
      try {
        raw = await bingPost(text, s, ctx);
      } catch (e) {
        lastErr = e;
        raw = '';
      }

      if (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (data && data[0] && data[0].translations && data[0].translations[0]) {
          bingEmptyStreak = 0;
          return data[0].translations[0].text;
        }
        lastErr = new Error('Bing 返回结构异常：' + raw.slice(0, 120));
        bingSession = null;
        s = await bingGetSession(ctx);
      } else {
        lastErr = new Error('Bing 返回空响应（限流）');
        bingEmptyStreak++;
        if (bingEmptyStreak >= 3) {
          bingBlockedUntil = Date.now() + 5 * 60 * 1000;   // 冷却 5 分钟
          bingEmptyStreak = 0;
          bingSession = null;
          throw bingBlockedError();
        }
        await http.delay(250);
      }
    }
    throw lastErr;
  }

  async function bingTranslate(texts, ctx) {
    var out = [];
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      out.push(await bingQueue(function () { return bingOne(text, ctx); }));
    }
    return out;
  }

  /* ================================================================
   * 腾讯交互翻译 Transmart（免 Key，支持批量）
   * ================================================================ */
  async function tencentTranslate(texts, ctx) {
    var body = {
      header: { fn: 'auto_translation', client_key: 'browser-firefox-133.0.0', user: '' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: langOf('tencent', ctx.sourceLang || 'auto'), text_list: texts },
      target: {
        lang: langOf('tencent', ctx.targetLang || 'zh-CN'),
        text_list: texts.map(function () { return ''; }),
      },
    };
    var res = await http.request({
      url: 'https://transmart.qq.com/api/imt',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: 'https://transmart.qq.com/zh-CN/index',
        origin: 'https://transmart.qq.com',
      },
      body: body,
      proxy: ctx.proxy,
      timeout: 25000,
      retries: 2,
    });
    need(res);
    var data;
    try { data = JSON.parse(res.text); } catch (e) { throw new Error('腾讯返回无法解析：' + String(res.text).slice(0, 120)); }
    var code = data && data.header && data.header.ret_code;
    if (code && code !== 'succ') {
      throw new Error('腾讯翻译失败：' + (data.message || code));
    }
    if (!data.auto_translation || !data.auto_translation.length) {
      throw new Error('腾讯返回结构异常：' + String(res.text).slice(0, 120));
    }
    return data.auto_translation;
  }

  /* ================================================================
   * 有道 demo 接口（免 Key，需串行）
   * ================================================================ */
  var youdaoQueue = http.createSerialQueue(160);

  async function youdaoTranslate(texts, ctx) {
    var out = [];
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      var value = await youdaoQueue(async function () {
        var url =
          'https://aidemo.youdao.com/trans?q=' +
          encodeURIComponent(text) +
          '&from=' + encodeURIComponent(langOf('youdao', ctx.sourceLang || 'auto')) +
          '&to=' + encodeURIComponent(langOf('youdao', ctx.targetLang || 'zh-CN'));
        var res = await http.request({ url: url, proxy: ctx.proxy, timeout: 20000, retries: 2 });
        need(res);
        var data;
        try { data = JSON.parse(res.text); } catch (e) { throw new Error('有道返回无法解析：' + String(res.text).slice(0, 120)); }
        if (data.errorCode && data.errorCode !== '0') throw new Error('有道翻译失败：' + data.errorCode);
        if (!data.translation || !data.translation.length) throw new Error('有道返回结构异常');
        return data.translation.join(' ');
      });
      out.push(value);
    }
    return out;
  }

  /* ================================================================
   * Google 免费接口（免 Key，国内需代理）
   * ================================================================ */
  var googleLimit = http.createLimiter(3);

  async function googleTranslate(texts, ctx) {
    var sl = langOf('google', ctx.sourceLang || 'auto');
    var tl = langOf('google', ctx.targetLang || 'zh-CN');
    var results = [];
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      results.push(
        await googleLimit(async function () {
          var url =
            'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' +
            encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) +
            '&q=' + encodeURIComponent(text);
          var res = await http.request({ url: url, proxy: ctx.proxy, timeout: 20000, retries: 2 });
          need(res);
          var data;
          try { data = JSON.parse(res.text); } catch (e) { throw new Error('Google 返回无法解析'); }
          if (!data || !data[0]) throw new Error('Google 返回结构异常');
          var parts = [];
          for (var k = 0; k < data[0].length; k++) {
            if (data[0][k] && data[0][k][0]) parts.push(data[0][k][0]);
          }
          return parts.join('');
        })
      );
    }
    return results;
  }

  /* ================================================================
   * MyMemory（免 Key，额度有限）
   * ================================================================ */
  var mmQueue = http.createSerialQueue(200);

  async function myMemoryTranslate(texts, ctx) {
    var out = [];
    var sl = langOf('mymemory', ctx.sourceLang || 'auto') || 'en';
    var tl = langOf('mymemory', ctx.targetLang || 'zh-CN');
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      var value = await mmQueue(async function () {
        var url =
          'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
          '&langpair=' + encodeURIComponent(sl + '|' + tl) +
          (ctx.mymemoryEmail ? '&de=' + encodeURIComponent(ctx.mymemoryEmail) : '');
        var res = await http.request({ url: url, proxy: ctx.proxy, timeout: 20000, retries: 1 });
        need(res);
        var data;
        try { data = JSON.parse(res.text); } catch (e) { throw new Error('MyMemory 返回无法解析'); }
        if (data.quotaFinished) throw new Error('MyMemory 今日免费额度已用完');
        if (!data.responseData || !data.responseData.translatedText) throw new Error('MyMemory 返回结构异常');
        return data.responseData.translatedText;
      });
      out.push(value);
    }
    return out;
  }

  /* ================================================================
   * DeepL（需 Key）
   * ================================================================ */
  async function deeplTranslate(texts, ctx) {
    if (!ctx.apiKey) throw new Error('DeepL 需要填写 API Key');
    var base = ctx.baseUrl || 'https://api-free.deepl.com';
    var parts = [];
    for (var i = 0; i < texts.length; i++) parts.push('text=' + encodeURIComponent(texts[i]));
    var body = parts.join('&') +
      '&target_lang=' + encodeURIComponent(langOf('deepl', ctx.targetLang || 'zh-CN'));
    var sl = langOf('deepl', ctx.sourceLang || 'auto');
    if (sl) body += '&source_lang=' + encodeURIComponent(sl);

    var res = await http.request({
      url: base.replace(/\/+$/, '') + '/v2/translate',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'DeepL-Auth-Key ' + ctx.apiKey },
      body: body,
      proxy: ctx.proxy,
      timeout: 30000,
      retries: 2,
    });
    need(res);
    var data;
    try { data = JSON.parse(res.text); } catch (e) { throw new Error('DeepL 返回无法解析'); }
    if (!data.translations) throw new Error('DeepL 返回结构异常：' + String(res.text).slice(0, 120));
    return data.translations.map(function (t) { return t.text; });
  }

  /* ================================================================
   * OpenAI 兼容（DeepSeek / 智谱 / 硅基流动 / Ollama / OpenAI）
   * ================================================================ */
  var PRESETS = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  };

  async function llmTranslate(texts, ctx) {
    if (!ctx.apiKey && !/127\.0\.0\.1|localhost/.test(ctx.baseUrl || '')) {
      throw new Error('该引擎需要 API Key');
    }
    var preset = PRESETS[ctx.preset] || {};
    var baseUrl = (ctx.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
    var model = ctx.model || preset.model || 'deepseek-chat';
    if (!baseUrl) throw new Error('缺少 API Base URL');

    var prompt = core.buildLlmPrompt(
      texts.map(function (t) { return { text: t }; }),
      { targetLang: ctx.targetLangLabel || ctx.targetLang, sourceLang: ctx.sourceLang, glossary: ctx.glossary }
    );

    var body = {
      model: model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是专业翻译，只输出 JSON 字符串数组，不输出任何解释。' },
        { role: 'user', content: prompt },
      ],
    };

    var headers = { 'content-type': 'application/json' };
    if (ctx.apiKey) headers.authorization = 'Bearer ' + ctx.apiKey;

    var res = await http.request({
      url: baseUrl + '/chat/completions',
      method: 'POST',
      headers: headers,
      body: body,
      proxy: ctx.proxy,
      timeout: ctx.llmTimeout || 120000,
      retries: 1,
    });
    need(res);
    var data;
    try { data = JSON.parse(res.text); } catch (e) { throw new Error('模型返回无法解析'); }
    if (data.error) throw new Error('模型接口报错：' + (data.error.message || JSON.stringify(data.error)).slice(0, 200));
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('模型返回为空');
    return core.parseTranslationArray(content, texts.length);
  }

  /* ================================================================
   * 引擎注册表
   * ================================================================ */
  var ENGINES = {
    bing: {
      id: 'bing', name: 'Bing 微软翻译', free: true, needsKey: false,
      maxItems: 1, maxChars: 1000, note: '免费免 Key，质量高；逐条串行请求',
      translate: bingTranslate,
    },
    tencent: {
      id: 'tencent', name: '腾讯交互翻译', free: true, needsKey: false,
      maxItems: 40, maxChars: 4000, note: '免费免 Key，支持批量，速度快',
      translate: tencentTranslate,
    },
    youdao: {
      id: 'youdao', name: '有道翻译（免费接口）', free: true, needsKey: false,
      maxItems: 1, maxChars: 1500, note: '免费免 Key，响应快；限流严格，已自动串行',
      translate: youdaoTranslate,
    },
    google: {
      id: 'google', name: 'Google 免费接口', free: true, needsKey: false,
      maxItems: 1, maxChars: 1500, note: '免费免 Key，国内需代理',
      translate: googleTranslate,
    },
    mymemory: {
      id: 'mymemory', name: 'MyMemory（免费额度）', free: true, needsKey: false,
      maxItems: 1, maxChars: 500, note: '免费免 Key，匿名每天 1000 词额度',
      translate: myMemoryTranslate,
    },
    deepl: {
      id: 'deepl', name: 'DeepL（需 Key）', free: false, needsKey: true,
      maxItems: 40, maxChars: 4000, note: 'DeepL API Free，每月 50 万字符',
      translate: deeplTranslate,
    },
    openai: {
      id: 'openai', name: 'AI 大模型（需 Key）', free: false, needsKey: true,
      maxItems: 30, maxChars: 3000, note: 'DeepSeek / 智谱 GLM-4-Flash（免费）/ 硅基流动 / Ollama 本地模型',
      translate: llmTranslate,
    },
  };

  /** 自动模式的降级顺序（全部免 Key） */
  var AUTO_ORDER = ['tencent', 'bing', 'youdao', 'google', 'mymemory'];

  function engineList() {
    return Object.keys(ENGINES).map(function (k) {
      var e = ENGINES[k];
      return {
        id: e.id, name: e.name, free: e.free, needsKey: e.needsKey,
        maxItems: e.maxItems, maxChars: e.maxChars, note: e.note,
      };
    });
  }

  /** 按引擎限制把 unique 文本分批 */
  function batchesFor(engineId, unique, opts) {
    var e = ENGINES[engineId] || ENGINES.tencent;
    var maxItems = (opts && opts.maxItems) || e.maxItems;
    var maxChars = (opts && opts.maxChars) || e.maxChars;
    var batches = [];
    var cur = [], chars = 0;
    for (var i = 0; i < unique.length; i++) {
      var t = unique[i];
      if (cur.length >= maxItems || (cur.length && chars + t.chars > maxChars)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(t);
      chars += t.chars;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /**
   * 翻译一批文本
   * @param {string} engineId  'auto' 时按 AUTO_ORDER 依次降级
   * @param {Array}  unique    [{hash, text, chars, refs}]
   * @param {object} ctx       { targetLang, sourceLang, proxy, apiKey, baseUrl, model, preset, glossary, log }
   * @returns {Promise<{engine:string, map:object, tried:Array, failed:Array}>}
   */
  async function translateBatch(engineId, unique, ctx) {
    var order = engineId === 'auto' ? AUTO_ORDER.slice() : [engineId];
    var tried = [];
    var lastError = null;

    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var engine = ENGINES[id];
      if (!engine) continue;
      var t0 = Date.now();
      try {
        var batches = batchesFor(id, unique, ctx);
        var map = {};
        var done = 0;
        for (var b = 0; b < batches.length; b++) {
          var batch = batches[b];
          var texts = batch.map(function (x) { return x.text; });
          var out = await engine.translate(texts, ctx);
          if (!out || out.length !== texts.length) {
            throw new Error('译文数量不匹配（期望 ' + texts.length + '，得到 ' + (out ? out.length : 0) + '）');
          }
          for (var k = 0; k < batch.length; k++) {
            map[batch[k].hash] = core.cleanTranslation(out[k]);
          }
          done += batch.length;
          if (ctx && typeof ctx.onProgress === 'function') {
            ctx.onProgress(done, unique.length, id);
          }
        }
        tried.push({ engine: id, ok: true, ms: Date.now() - t0, count: unique.length });
        return { engine: id, map: map, tried: tried, failed: [] };
      } catch (e) {
        lastError = e;
        tried.push({ engine: id, ok: false, ms: Date.now() - t0, error: e.message });
        if (ctx && typeof ctx.log === 'function') {
          ctx.log('引擎 ' + id + ' 失败：' + e.message + '，尝试下一个引擎');
        }
      }
    }
    var err = new Error('所有引擎都失败了。最后错误：' + (lastError ? lastError.message : '未知'));
    err.tried = tried;
    throw err;
  }

  /** 网络诊断：单条短文本测试某引擎 */
  async function diagnose(engineId, ctx) {
    var sample = [{ hash: 'probe', text: 'Hello world, design works.', chars: 26, refs: [] }];
    var t0 = Date.now();
    try {
      var r = await translateBatch(engineId, sample, Object.assign({}, ctx, { log: null }));
      return {
        ok: true, engine: r.engine, ms: Date.now() - t0,
        result: r.map.probe, tried: r.tried,
      };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message, tried: e.tried || [] };
    }
  }

  return {
    LANGS: LANGS,
    ENGINES: ENGINES,
    AUTO_ORDER: AUTO_ORDER,
    engineList: engineList,
    langOf: langOf,
    batchesFor: batchesFor,
    translateBatch: translateBatch,
    diagnose: diagnose,
  };
});
