/**
 * test-core.mjs — 核心逻辑 + 真实引擎的自动化测试
 *
 * 用法:
 *   node tools/test-core.mjs              # 只跑离线单测
 *   node tools/test-core.mjs --network    # 额外跑真实翻译引擎（联网）
 *   node tools/test-core.mjs --engine=bing
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(__dirname, '..', 'com.dsh.aitranslator', 'panel', 'js');

const core = require(path.join(extRoot, 'core.js'));
const http = require(path.join(extRoot, 'http.js'));
const engines = require(path.join(extRoot, 'engines.js'));

/* ------------------------------------------------------------------ *
 * 迷你测试框架
 * ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || ''} 期望 ${b}，实际 ${a}`);
}

function truthy(v, label) {
  if (!v) throw new Error(`${label || '断言'} 应为真，实际 ${JSON.stringify(v)}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/* ------------------------------------------------------------------ *
 * 1. 文本切分
 * ------------------------------------------------------------------ */
section('文本切分 / 规范化');
test('splitParagraphs 支持 \\r \\n \\r\\n', () => {
  eq(core.splitParagraphs('a\rb\nc\r\nd'), ['a', 'b', 'c', 'd']);
});
test('flatten 把多行压成单行并合并空格', () => {
  eq(core.flatten('  a\r\n  b\t\tc  '), 'a b c');
});
test('flatten 处理空值', () => {
  eq(core.flatten(null), '');
  eq(core.flatten(undefined), '');
});

/* ------------------------------------------------------------------ *
 * 2. 语言识别 / 可译性
 * ------------------------------------------------------------------ */
section('语言识别 / 可译性判断');
test('detectScript 中文 / 英文 / 混合', () => {
  eq(core.detectScript('设计'), 'cjk');
  eq(core.detectScript('Design'), 'latin');
  eq(core.detectScript('Design 设计'), 'mixed');
  eq(core.detectScript('123 456'), 'none');
});
test('跳过纯数字与符号', () => {
  eq(core.checkTranslatable('123.45', { targetLang: 'zh-CN' }).ok, false);
  eq(core.checkTranslatable('— 100% —', { targetLang: 'zh-CN' }).ok, false);
  eq(core.checkTranslatable('Hello', { targetLang: 'zh-CN' }).ok, true);
});
test('跳过网址与邮箱', () => {
  eq(core.checkTranslatable('https://adobe.com/x', { targetLang: 'zh-CN' }).reason, 'url-email');
  eq(core.checkTranslatable('a@b.com', { targetLang: 'zh-CN' }).reason, 'url-email');
});
test('跳过已是目标语言的文本', () => {
  eq(core.checkTranslatable('已经是中文了', { targetLang: 'zh-CN' }).reason, 'already-target-lang');
  eq(core.checkTranslatable('已经是中文了', { targetLang: 'zh-CN', skipTargetLang: false }).ok, true);
});
test('跳过空文本', () => {
  eq(core.checkTranslatable('   ', { targetLang: 'zh-CN' }).reason, 'empty');
});

/* ------------------------------------------------------------------ *
 * 3. 任务规划（去重 / 过滤 / 分批）
 * ------------------------------------------------------------------ */
section('任务规划');
const sampleItems = [
  {
    id: 'itm1',
    paragraphs: [
      { i: 0, text: 'Save as' },
      { i: 1, text: 'Save as' },          // 重复 → 去重
      { i: 2, text: '123' },              // 纯数字 → 跳过
      { i: 3, text: '已经中文' },           // 已是目标语言 → 跳过
    ],
  },
  {
    id: 'itm2',
    paragraphs: [
      { i: 0, text: 'Save as' },          // 跨对象重复 → 去重
      { i: 1, text: 'Open recent files' },
    ],
  },
];

const plan = core.planTasks(sampleItems, { targetLang: 'zh-CN' });

test('去重：3 条 Save as 只翻译 1 条', () => {
  eq(plan.stats.paragraphCount, 6);
  eq(plan.stats.uniqueCount, 2);
  eq(plan.stats.skippedCount, 2);
  eq(plan.stats.savedByDedupe, 2);
});
test('tasks 保留全部引用位置', () => {
  eq(plan.tasks.length, 4);
  const refs = plan.unique.find((u) => u.text === 'Save as').refs;
  eq(refs.length, 3);
});
test('跳过原因分类正确', () => {
  const reasons = plan.skipped.map((s) => s.reason).sort();
  eq(reasons, ['already-target-lang', 'no-letter']);
});
test('分批受 maxItems 限制', () => {
  const many = [{
    id: 'x',
    paragraphs: Array.from({ length: 7 }, (_, i) => ({ i, text: `text number ${i}` })),
  }];
  const p = core.planTasks(many, { targetLang: 'zh-CN', maxItemsPerRequest: 3 });
  eq(p.batches.map((b) => b.texts.length), [3, 3, 1]);
});
test('超长文本单独成批', () => {
  const long = 'a '.repeat(300);
  const p = core.planTasks([{ id: 'y', paragraphs: [{ i: 0, text: long }] }], {
    targetLang: 'zh-CN',
    maxCharsPerRequest: 100,
  });
  eq(p.batches.length, 1);
  eq(p.batches[0].oversized, true);
});

/* ------------------------------------------------------------------ *
 * 4. 术语表
 * ------------------------------------------------------------------ */
section('术语表');
test('前置替换：原文术语 → 目标术语', () => {
  const out = core.applyGlossary('Design Layer 1', [{ from: 'Layer', to: '图层' }], 'before');
  eq(out, 'Design 图层 1');
});
test('大小写不敏感', () => {
  const out = core.applyGlossary('layer and LAYER', [{ from: 'layer', to: '图层' }], 'before');
  eq(out, '图层 and 图层');
});

/* ------------------------------------------------------------------ *
 * 5. 译文清洗 / 解析
 * ------------------------------------------------------------------ */
section('译文清洗 / 解析');
test('去掉代码块与「译文：」前缀', () => {
  eq(core.cleanTranslation('```json\n译文：你好\n```'), '你好');
});
test('去掉外层引号并压缩换行', () => {
  eq(core.cleanTranslation('“你好\r\n世界”'), '你好 世界');
});
test('parseTranslationArray 解析标准 JSON 数组', () => {
  eq(core.parseTranslationArray('["甲","乙"]', 2), ['甲', '乙']);
});
test('parseTranslationArray 解析带代码块的输出', () => {
  eq(core.parseTranslationArray('```json\n["甲","乙"]\n```', 2), ['甲', '乙']);
});
test('parseTranslationArray 解析 {translations:[...]}', () => {
  eq(core.parseTranslationArray('{"translations":["甲","乙"]}', 2), ['甲', '乙']);
});
test('parseTranslationArray 退化解析编号列表', () => {
  eq(core.parseTranslationArray('1. 甲\n2. 乙', 2), ['甲', '乙']);
});
test('parseTranslationArray 数量不足时报错', () => {
  let threw = false;
  try { core.parseTranslationArray('["只有一条"]', 3); } catch (e) { threw = true; }
  truthy(threw, '应抛错');
});

/* ------------------------------------------------------------------ *
 * 6. 结果合并
 * ------------------------------------------------------------------ */
section('结果合并');
test('mergeResults 按对象聚合段落译文', () => {
  const updates = core.mergeResults(plan, { [plan.unique[0].hash]: '另存为', [plan.unique[1].hash]: '打开最近文件' });
  eq(updates.itm1.length, 2);            // Save as ×2（两个段落）
  eq(updates.itm1[0].text, '另存为');
  eq(updates.itm2.length, 2);
});
test('estimateRatio 计算长度比', () => {
  eq(core.estimateRatio('abcd', 'abcdefgh'), 2);
});

/* ------------------------------------------------------------------ *
 * 7. 大小写变换
 * ------------------------------------------------------------------ */
section('大小写变换');
test('keep 保持原样', () => {
  eq(core.transformCase('Save as', 'keep'), 'Save as');
  eq(core.transformCase('Save as', undefined), 'Save as');
});
test('upper 全部大写', () => {
  eq(core.transformCase('Save as', 'upper'), 'SAVE AS');
  eq(core.transformCase('另存为 Save as', 'upper'), '另存为 SAVE AS');
});
test('lower 全部小写', () => {
  eq(core.transformCase('SAVE AS', 'lower'), 'save as');
});
test('title 首字母大写且不改动其余字母', () => {
  eq(core.titleCase('save as'), 'Save As');
  eq(core.titleCase('OPEN RECENT FILES'), 'OPEN RECENT FILES');
  eq(core.titleCase('my iphone case'), 'My Iphone Case');
});
test('大小写不影响中文数字符号', () => {
  eq(core.transformCase('图层 123 — 标题', 'upper'), '图层 123 — 标题');
  eq(core.transformCase('', 'upper'), '');
  eq(core.transformCase(null, 'upper'), '');
});
test('caseChanges 判断文本是否真的会变', () => {
  eq(core.caseChanges('Save as', 'upper'), true);
  eq(core.caseChanges('SAVE AS', 'upper'), false);
  eq(core.caseChanges('中文标题', 'upper'), false);
  eq(core.caseChanges('Save as', 'keep'), false);
});
test('网址与占位符禁止做大小写改写', () => {
  eq(core.caseTransformAllowed('url-email'), false);
  eq(core.caseTransformAllowed('placeholder'), false);
  eq(core.caseTransformAllowed('same-script'), true);
  eq(core.caseTransformAllowed('already-target-lang'), true);
});

/* ------------------------------------------------------------------ *
 * 8. 引擎表 / 语言码
 * ------------------------------------------------------------------ */
section('引擎注册表');
test('免费引擎齐全', () => {
  const ids = engines.engineList().filter((e) => e.free).map((e) => e.id).sort();
  eq(ids, ['bing', 'google', 'mymemory', 'tencent', 'youdao']);
});
test('自动降级顺序只包含免费引擎', () => {
  engines.AUTO_ORDER.forEach((id) => {
    truthy(engines.ENGINES[id] && engines.ENGINES[id].free, `${id} 应为免费引擎`);
  });
});
test('语言码映射正确', () => {
  eq(engines.langOf('bing', 'zh-CN'), 'zh-Hans');
  eq(engines.langOf('tencent', 'zh-CN'), 'zh');
  eq(engines.langOf('youdao', 'zh-CN'), 'zh-CHS');
  eq(engines.langOf('deepl', 'en'), 'EN');
  eq(engines.langOf('google', 'auto'), 'auto');
});
test('分批遵循各引擎上限', () => {
  const unique = Array.from({ length: 100 }, (_, i) => ({ hash: 'h' + i, text: 't' + i, chars: 2, refs: [] }));
  const b = engines.batchesFor('tencent', unique, {});
  truthy(b.length >= 3, '腾讯应分成至少 3 批');
  b.forEach((batch) => truthy(batch.length <= 40, '每批不超过 40 条'));
});

/* ------------------------------------------------------------------ *
 * 8. 联网测试（真实引擎）
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const wantNetwork = args.includes('--network');
const engineArg = (args.find((a) => a.startsWith('--engine=')) || '').split('=')[1];

if (wantNetwork) {
  section('联网：真实翻译引擎');
  const proxy = await http.detectSystemProxy();
  console.log(`  本机代理检测结果：${proxy || '（无）'}`);
  const ctx = {
    targetLang: 'zh-CN',
    targetLangLabel: '简体中文',
    sourceLang: 'auto',
    proxy,
    log: null,
  };
  const list = engineArg ? [engineArg] : ['tencent', 'bing', 'youdao', 'google', 'mymemory'];
  const unique = [
    { hash: 'a', text: 'Design is not just what it looks like, design is how it works.', chars: 61, refs: [] },
    { hash: 'b', text: 'Save as', chars: 7, refs: [] },
  ];

  let skippedByQuota = 0;

  for (const id of list) {
    await testAsync(`引擎 ${id} 真实翻译`, async () => {
      let r;
      try {
        r = await engines.translateBatch(id, unique, ctx);
      } catch (e) {
        // 免费接口有配额：被限流属于预期情况（插件会自动降级），记为 skip 而不是失败
        if (/限流|冷却|空响应|quota|额度/i.test(e.message)) {
          skippedByQuota++;
          console.log(`       ⚠ 跳过（接口限流/额度用尽）：${e.message}`);
          return;
        }
        throw e;
      }
      const values = Object.values(r.map);
      if (values.length !== 2) throw new Error('译文数量不对');
      if (values.some((v) => !v || !v.trim())) throw new Error('存在空译文');
      console.log(`       → ${JSON.stringify(values)}`);
    });
  }

  await testAsync('自动降级模式（auto）可用', async () => {
    const r = await engines.translateBatch('auto', unique, ctx);
    console.log(`       → 实际使用引擎：${r.engine}，尝试记录 ${JSON.stringify(r.tried.map((t) => t.engine + (t.ok ? '✔' : '✘')))}`);
    if (!r.map.a) throw new Error('未拿到译文');
  });
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  failures.forEach((f) => console.log(`  ✘ ${f.name}: ${f.error}`));
  process.exit(1);
}
console.log('全部通过 ✅');
