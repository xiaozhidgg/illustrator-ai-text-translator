/**
 * fetch-ai-docs.mjs — 抓取 Illustrator 官方脚本参考，核对 TextFrame / TextRange 的准确属性名。
 * 用法: node tools/fetch-ai-docs.mjs
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000, headers: { 'user-agent': UA, 'accept-encoding': 'identity' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout' });
    });
  });
}

const pages = {
  TextFrame: 'https://ai-scripting.docsforadobe.dev/jsobjref/TextFrame/',
  TextRange: 'https://ai-scripting.docsforadobe.dev/jsobjref/TextRange/',
  Paragraph: 'https://ai-scripting.docsforadobe.dev/jsobjref/Paragraph/',
  TextFrameItem: 'https://ai-scripting.docsforadobe.dev/jsobjref/TextFrameItem/',
};

const report = {};
for (const [name, url] of Object.entries(pages)) {
  const r = await get(url);
  if (r.status !== 200) {
    report[name] = { status: r.status, error: r.error || '' };
    console.log(`FAIL ${name} status=${r.status} ${r.error || ''}`);
    continue;
  }
  // 提取属性名：文档里形如 <a href="#...">contents</a> 或 <code>overflows</code>
  const ids = [...r.body.matchAll(/id="([a-z][a-z0-9_-]{2,40})"/g)].map((m) => m[1]);
  const uniq = [...new Set(ids)].filter(
    (s) => !['toc', 'main', 'footer', 'header', 'search', 'navigation'].includes(s)
  );
  report[name] = { status: 200, len: r.body.length, anchors: uniq.slice(0, 200) };
  const hit = ['overflows', 'contents', 'textRange', 'paragraphs', 'kind', 'areaText', 'nextFrame', 'previousFrame', 'characters', 'words', 'lines', 'story', 'opticalAlignment', 'textPath'].filter((k) =>
    r.body.includes(k)
  );
  console.log(`OK   ${name} len=${r.body.length} 命中关键字: ${hit.join(', ')}`);
  if (name === 'TextFrame') {
    const m = r.body.match(/overflows[\s\S]{0,200}/);
    console.log('   overflows 上下文: ' + (m ? m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 180) : '未命中'));
  }
}

fs.writeFileSync(path.join(__dirname, 'ai-docs-probe.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('\n写入 tools/ai-docs-probe.json');
