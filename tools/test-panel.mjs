/**
 * test-panel.mjs — 用 jsdom 真实加载面板，模拟 CEP 宿主 + 翻译接口，跑通整条 UI 流程
 *
 * 验证点：面板启动 → 扫描渲染 → 翻译（走真实引擎层代码 + 假网络）→ 回写调用 → 撤销
 *
 * 用法: node tools/test-panel.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 默认测仓库里的源码；用 TX_EXT_ROOT 可指向已安装副本或打包出来的目录
const extRoot = process.env.TX_EXT_ROOT
  ? path.resolve(process.env.TX_EXT_ROOT)
  : path.join(__dirname, '..', 'com.dsh.aitranslator');
console.log(`测试目标扩展：${extRoot}`);
const panelIndex = path.join(extRoot, 'panel', 'index.html');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeout = 5000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = fn();
      if (v) return v;
    } catch (e) { /* 继续等 */ }
    await wait(interval);
  }
  return null;
}

/** 等待面板不处于忙碌状态（busy() 会禁用这两个按钮） */
async function waitIdle(timeout = 10000) {
  return waitFor(() => (!$('btnScan').disabled && !$('btnTranslate').disabled) ? true : null, timeout);
}

/* ------------------------------------------------------------------ *
 * 假的 Illustrator 文档模型（喂给 TX.* 宿主协议）
 * ------------------------------------------------------------------ */
const fakeDoc = {
  items: [
    {
      id: 'itm1',
      kind: 'point',
      storyScope: 'frame',
      frameCount: 1,
      chars: 30,
      paragraphCount: 3,
      paragraphs: [
        { i: 0, text: 'Save as' },
        { i: 1, text: 'Export the selected artwork' },
        { i: 2, text: '123' },                       // 纯数字 → 应被跳过
      ],
      locked: false,
      hidden: false,
      layerName: '图层 1',
      bounds: [0, 0, 0, 0],
      overflow: false,
    },
    {
      id: 'itm2',
      kind: 'area',
      storyScope: 'frames',
      frameCount: 2,
      chars: 60,
      paragraphCount: 2,
      paragraphs: [
        { i: 0, text: 'Open recent files' },
        { i: 1, text: 'Open recent files' },          // 重复 → 去重
      ],
      locked: false,
      hidden: false,
      layerName: '图层 1',
      bounds: [0, 0, 0, 0],
      overflow: true,
    },
  ],
};

const hostCalls = [];
let lastApplyPayload = null;

const mockTX = {
  ping() {
    return JSON.stringify({
      ok: true,
      app: { name: 'Adobe Illustrator', version: '29.8.1', locale: 'zh_CN' },
      caps: { hasOverflowsProp: false, hasUuid: true, hasStories: true },
      doc: { name: '测试.ai', textFrames: 2 },
    });
  },
  scan() {
    return JSON.stringify({
      ok: true, docName: '测试.ai', scope: 'document', frameCount: 2,
      itemCount: fakeDoc.items.length, skipped: { empty: 0, locked: 0, duplicateStory: 0 },
      items: fakeDoc.items,
    });
  },
  apply(argJson) {
    const payload = JSON.parse(argJson);
    lastApplyPayload = payload;
    const results = payload.items.map((it) => ({
      id: it.id, ok: true, applied: it.paragraphs.length, errors: [],
      overflowBefore: false, overflowAfter: false,
      overflowFix: { policy: payload.overflow.policy, resized: false },
    }));
    return JSON.stringify({
      ok: true,
      applied: results.reduce((a, r) => a + r.applied, 0),
      errorCount: 0, canUndo: true, results,
    });
  },
  undo() {
    return JSON.stringify({ ok: true, restored: 2, errors: [], canUndo: false });
  },
  selectItem() {
    return JSON.stringify({ ok: true });
  },
  readItem() {
    return JSON.stringify({ ok: true, paragraphs: [] });
  },
};

function handleScript(script) {
  hostCalls.push(script);
  try {
    // script 形如 TX.scan("{\"scope\":\"document\"}")
    const fn = new Function('TX', `return ${script};`);
    const out = fn(mockTX);
    return out === undefined ? '' : String(out);
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'mock 执行失败: ' + e.message });
  }
}

/* ------------------------------------------------------------------ *
 * 假网络：拦截引擎层的 HTTP 请求
 * ------------------------------------------------------------------ */
const TXHttp = require(path.join(extRoot, 'panel', 'js', 'http.js'));
let httpCalls = 0;

TXHttp.request = async function (o) {
  httpCalls++;
  const url = o.url || '';
  if (url.indexOf('transmart.qq.com') >= 0) {
    // 引擎层传进来的是对象（序列化发生在更下层），这里两种都兼容
    const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
    const texts = body.source.text_list;
    return {
      status: 200,
      headers: {},
      ms: 12,
      text: JSON.stringify({
        header: { ret_code: 'succ' },
        auto_translation: texts.map((t) => '【译】' + t),
        src_lang: 'en',
        tgt_lang: 'zh',
      }),
      channel: 'mock',
      cookies: [],
    };
  }
  throw new Error('未拦截的请求: ' + url);
};

/* ------------------------------------------------------------------ *
 * 加载面板
 * ------------------------------------------------------------------ */
console.log('=== 加载面板（jsdom） ===');

const dom = await JSDOM.fromFile(panelIndex, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.__adobe_cep__ = {
      evalScript(script, cb) { setTimeout(() => cb(handleScript(script)), 0); },
      // 真机上 CEP 返回的是 URL 形式，且非 ASCII 会被百分号编码。
      // 这里如实模拟，用来回归「require 拿到 file:/// 前缀会报 Cannot find module」这类问题。
      getSystemPath() { return 'file:///' + encodeURI(extRoot.replace(/\\/g, '/')); },
      getHostEnvironment() {
        return JSON.stringify({ appName: 'Adobe Illustrator', appVersion: '29.8.1', appId: 'ILST' });
      },
      getExtensionId() { return 'com.dsh.aitranslator.panel'; },
      getScaleFactor() { return 1; },
      addEventListener() { },
      removeEventListener() { },
      closeExtension() { },
      openURLInDefaultBrowser() { },
    };
    // 让面板里的 require 与测试共用同一个模块缓存
    window.require = require;
    window.module = { exports: {} };
  },
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);

const booted = await waitFor(() => {
  const el = $('hostStatus');
  return el && /脚本就绪|未连接|未就绪/.test(el.textContent) ? el : null;
}, 8000);

check('面板启动完成（宿主状态已刷新）', !!booted, booted ? booted.textContent : '超时');
check('宿主状态显示 Illustrator 29.8.1', booted && /29\.8\.1/.test(booted.textContent), booted && booted.textContent);
check('宿主状态标记为已就绪', booted && booted.classList.contains('ok'), booted && booted.className);

/* ---------- Node 网络层加载（回归：getSystemPath 返回 file:/// 形式） ---------- */
const logText = () => Array.from(doc.querySelectorAll('#log div')).map((n) => n.textContent).join('\n');
check('Node 网络层加载成功', /网络层已加载/.test(logText()),
  logText().split('\n').filter((l) => /网络层|扩展目录|已尝试/.test(l)).join(' | ') || '无日志');
check('未出现网络层加载失败', !/网络层加载失败/.test(logText()),
  logText().split('\n').filter((l) => /失败/.test(l)).join(' | '));

/* ---------- 引擎下拉 ---------- */
const engineSel = $('engine');
const engineValues = Array.from(engineSel.options).map((o) => o.value);
check('引擎下拉包含 auto + 5 个免费引擎 + 2 个需 Key 引擎', engineValues.length === 8, engineValues.join(','));
check('引擎下拉含腾讯/Bing/有道/Google/MyMemory',
  ['tencent', 'bing', 'youdao', 'google', 'mymemory'].every((id) => engineValues.indexOf(id) >= 0),
  engineValues.join(','));
check('默认选中「自动」', engineSel.value === 'auto', engineSel.value);

/* ---------- 语言下拉 ---------- */
const targetSel = $('targetLang');
check('目标语言默认简体中文', targetSel.value === 'zh-CN', targetSel.value);
check('源语言默认自动识别', $('sourceLang').value === 'auto', $('sourceLang').value);

/* ---------- 扫描 ---------- */
console.log('\n=== 扫描 ===');
$('btnScan').click();
const items = await waitFor(() => doc.querySelectorAll('.item').length === 2 ? doc.querySelectorAll('.item') : null, 5000);
check('扫描后渲染 2 个文本对象', !!items, items ? items.length : '未渲染');
check('列表显示 3 + 2 = 5 个段落行', doc.querySelectorAll('.pair').length === 5, String(doc.querySelectorAll('.pair').length));
check('未翻译时显示「待翻译」', doc.querySelectorAll('.dst.pending').length === 5, String(doc.querySelectorAll('.dst.pending').length));
check('计数器显示 2 / 2', $('counter').textContent.indexOf('2 / 2') >= 0, $('counter').textContent);
check('溢出对象带「溢出」标记', !!doc.querySelector('.item .tag.warn'), '');
check('联排对象带「联排×2」标记', /联排/.test(doc.body.textContent), '');
check('扫描按钮已恢复可用', !$('btnScan').disabled);

/* ---------- 翻译 ---------- */
console.log('\n=== 翻译（假网络：腾讯引擎） ===');
$('btnTranslate').click();

const done = await waitFor(() => /完成：写回/.test($('status').textContent) ? $('status').textContent : null, 10000);
check('翻译流程完成', !!done, done || $('status').textContent);

const dstTexts = Array.from(doc.querySelectorAll('.pair .dst')).map((n) => n.textContent);
check('译文写回列表', dstTexts.filter((t) => /【译】/.test(t)).length === 4, JSON.stringify(dstTexts));
check('纯数字段落被跳过', dstTexts[2] === '（跳过）', dstTexts[2]);
check('重复段落复用同一条译文', dstTexts[3] === dstTexts[4] && /【译】/.test(dstTexts[3]), JSON.stringify([dstTexts[3], dstTexts[4]]));

check('去重生效：3 条唯一文本共用 1 次批量请求', httpCalls === 1, 'httpCalls=' + httpCalls);

check('调用了 TX.apply', hostCalls.some((s) => s.indexOf('TX.apply(') === 0), hostCalls.join(' | ').slice(0, 120));
check('apply 载荷包含 2 个对象', lastApplyPayload && lastApplyPayload.items.length === 2,
  lastApplyPayload ? String(lastApplyPayload.items.length) : 'null');
check('apply 载荷段落索引正确（itm1 段 0、1）',
  lastApplyPayload && JSON.stringify(lastApplyPayload.items[0].paragraphs.map((p) => p.i)) === '[0,1]',
  lastApplyPayload ? JSON.stringify(lastApplyPayload.items[0].paragraphs) : '');
check('apply 载荷带溢出策略', lastApplyPayload && lastApplyPayload.overflow && lastApplyPayload.overflow.policy === 'expand',
  lastApplyPayload ? JSON.stringify(lastApplyPayload.overflow) : '');
check('回写方式默认逐段替换', lastApplyPayload && lastApplyPayload.mode === 'paragraph', lastApplyPayload && lastApplyPayload.mode);
check('状态栏显示所用引擎', /腾讯/.test(done || ''), done || '');

/* ---------- 撤销 ---------- */
console.log('\n=== 撤销 ===');
check('撤销按钮已启用', !$('btnUndo').disabled);
$('btnUndo').click();
const undone = await waitFor(() => /已撤销/.test($('status').textContent) ? $('status').textContent : null, 5000);
check('撤销执行成功', !!undone, undone || $('status').textContent);
check('调用了 TX.undo', hostCalls.some((s) => s.indexOf('TX.undo(') === 0), '');

/* ---------- 输出大写：翻译后转大写 ---------- */
console.log('\n=== 输出大写（翻译 + 转大写） ===');
$('btnScan').click();
await waitIdle();
const upperCallsBefore = httpCalls;
$('caseMode').value = 'upper';
$('caseMode').dispatchEvent(new window.Event('change'));
$('btnTranslate').click();

const upperDone = await waitFor(() => /完成：写回/.test($('status').textContent) ? $('status').textContent : null, 10000);
check('大写模式翻译完成', !!upperDone, upperDone || $('status').textContent);
const upperDst = Array.from(doc.querySelectorAll('.pair .dst')).map((n) => n.textContent);
check('译文已转为大写',
  upperDst[0] === '【译】SAVE AS' && upperDst[1] === '【译】EXPORT THE SELECTED ARTWORK',
  JSON.stringify(upperDst));
check('纯数字段落仍标记跳过', upperDst[2] === '（跳过）', upperDst[2]);
check('回写载荷里是大写译文',
  lastApplyPayload && lastApplyPayload.items[0].paragraphs[0].text === '【译】SAVE AS',
  lastApplyPayload ? JSON.stringify(lastApplyPayload.items[0].paragraphs) : 'null');
check('大写模式下仍只发 1 次请求（去重未失效）', httpCalls - upperCallsBefore === 1,
  `新增 ${httpCalls - upperCallsBefore} 次`);

/* ---------- 仅转大写：目标英文时原文被跳过，仍要写回 ---------- */
console.log('\n=== 仅转大写（目标=英文，原文即英文被跳过） ===');
$('btnScan').click();
await waitIdle();
const caseOnlyCallsBefore = httpCalls;
$('targetLang').value = 'en';
$('btnTranslate').click();

const caseOnlyDone = await waitFor(() => /完成：仅调整大小写/.test($('status').textContent) ? $('status').textContent : null, 8000);
check('仅大小写模式执行成功', !!caseOnlyDone, caseOnlyDone || $('status').textContent);
check('该模式下不发起任何翻译请求', httpCalls === caseOnlyCallsBefore,
  `${caseOnlyCallsBefore} → ${httpCalls}`);
const caseDst = Array.from(doc.querySelectorAll('.pair .dst')).map((n) => n.textContent);
check('被跳过的英文段落被转成大写并写回',
  caseDst[0] === 'SAVE AS' && caseDst[1] === 'EXPORT THE SELECTED ARTWORK' && caseDst[3] === 'OPEN RECENT FILES',
  JSON.stringify(caseDst));
check('大写回写载荷覆盖两个对象',
  lastApplyPayload && lastApplyPayload.items.length === 2 &&
  lastApplyPayload.items[0].paragraphs.map((p) => p.text).join('|') === 'SAVE AS|EXPORT THE SELECTED ARTWORK',
  lastApplyPayload ? JSON.stringify(lastApplyPayload.items.map((i) => i.paragraphs.map((p) => p.text))) : 'null');
check('纯数字段落不受大小写影响（未进载荷）',
  lastApplyPayload && lastApplyPayload.items[0].paragraphs.every((p) => p.i !== 2),
  lastApplyPayload ? JSON.stringify(lastApplyPayload.items[0].paragraphs.map((p) => p.i)) : 'null');

// 复原设置，避免影响后续断言
$('caseMode').value = 'keep';
$('caseMode').dispatchEvent(new window.Event('change'));
$('targetLang').value = 'zh-CN';

/* ---------- 网络诊断 ---------- */
console.log('\n=== 网络诊断 ===');
$('btnDiagnose').click();
const diagDone = await waitFor(() => /诊断完成/.test($('status').textContent) ? true : null, 8000);
check('诊断完成并写入日志', !!diagDone && doc.querySelectorAll('#log div').length > 0,
  String(doc.querySelectorAll('#log div').length));

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(56));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  failures.forEach((f) => console.log('  ✘ ' + f));
  process.exit(1);
}
console.log('面板 UI 全流程通过 ✅');
dom.window.close();
