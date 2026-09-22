/**
 * 打印「大模型引擎实际会收到的那段提示词」。
 *
 * 用途：语境翻译出问题时，先看提示词里到底写了什么，再决定改预设还是改提示词。
 *      也可以把打印出来的内容整段贴到任意大模型里，人工核对译文质量。
 *
 * 用法：
 *   node tools/show-prompt.mjs --preset=jiuye --to=法语 --demo=toothpaste
 *   node tools/show-prompt.mjs --preset=jiuye --to=法语 --text="Toothpaste" --text="Deep Clean"
 *   node tools/show-prompt.mjs --preset=packaging --to=法语 --file=samples.txt --related="净含量 100g"
 *   node tools/show-prompt.mjs --list                 只看预设清单
 *
 * 参数：
 *   --preset=<id>      领域预设 id（见 --list）；不加则不带语境
 *   --scene=<文本>     直接给语境说明（与 --preset 二选一）
 *   --to=<语言>        目标语言，写自然语言名称，如 法语 / 英语 / 简体中文
 *   --from=<语言>      源语言，默认 auto
 *   --tone=<文本>      语气与风格
 *   --related=<文本>   同一版面的其他文案（仅用于理解语境，不翻译）
 *   --glossary=a=b;c=d 术语表
 *   --text=<文本>      待翻译文本，可重复
 *   --file=<路径>      从文件读待翻译文本（每行一条，跳过空行）
 *   --demo=toothpaste  内置示例：某牙膏管上的英文文案
 *   --list             列出所有领域预设
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const core = require(path.join(root, 'com.dsh.aitranslator', 'panel', 'js', 'core.js'));

const DEMOS = {
  toothpaste: [
    'YATAI',
    'COCONUT CHARCOAL',
    'Toothpaste',
    'With Activated Charcoal & Coconut',
    'Deep Clean',
    'Fresh Breath',
    'Helps Remove Surface Stains',
    'Fresh Mint Flavor',
    'NET WT. 100g',
  ],
};

function parseArgs(argv) {
  const out = { text: [], _: [] };
  argv.forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { out._.push(a); return; }
    const k = m[1];
    const v = m[2] === undefined ? true : m[2];
    if (k === 'text') out.text.push(v);
    else out[k] = v;
  });
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  console.log('可选领域预设：');
  core.DOMAIN_PRESETS.forEach((p) => console.log(`  ${p.id.padEnd(14)} ${p.label}`));
  process.exit(0);
}

let texts = [];
if (args.demo) {
  if (!DEMOS[args.demo]) { console.error(`未知示例：${args.demo}（可用：${Object.keys(DEMOS).join(', ')}）`); process.exit(2); }
  texts = DEMOS[args.demo].slice();
}
if (args.file) {
  texts = texts.concat(readFileSync(args.file, 'utf8').split(/\r?\n/).filter((l) => l.trim()));
}
if (Array.isArray(args.text)) texts = texts.concat(args.text);
if (!texts.length) { console.error('没有待翻译文本：请给 --text / --file / --demo（或用 --list 看预设）'); process.exit(2); }

let scene = args.scene || '';
if (args.preset) {
  const p = core.DOMAIN_PRESETS.find((x) => x.id === args.preset);
  if (!p) { console.error(`未知预设：${args.preset}（用 --list 看全部）`); process.exit(2); }
  scene = core.composeSceneText(p.scene, '');
}

const glossary = [];
if (args.glossary && args.glossary !== true) {
  args.glossary.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) glossary.push({ from: pair.slice(0, i).trim(), to: pair.slice(i + 1).trim() });
  });
}

const prompt = core.buildLlmPrompt(texts.map((t) => ({ text: t })), {
  targetLang: args.to || '简体中文',
  sourceLang: args.from || 'auto',
  scene,
  tone: args.tone || '',
  relatedContext: args.related || '',
  glossary,
});

console.log('─'.repeat(72));
console.log(`预设：${args.preset || '(未选，无语境)'}    目标语言：${args.to || '简体中文'}    条目：${texts.length}`);
console.log('─'.repeat(72));
console.log(prompt);
console.log('─'.repeat(72));
console.log(`提示词字符数：${prompt.length}`);
