/**
 * probe-engines.mjs — 实测各「免费 / 免 Key」翻译接口在本机网络下是否可用。
 * 用法: node tools/probe-engines.mjs
 * 结果同时打印到 stdout 并写入 tools/probe-results.json
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = Number(process.env.PROBE_TIMEOUT || 15000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function request({ url, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const started = Date.now();
    const payload =
      body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const options = {
      method,
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept-encoding': 'identity',
        ...headers,
      },
      timeout: TIMEOUT,
    };
    if (payload) options.headers['content-length'] = String(payload.length);

    const req = https.request(options, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          ms: Date.now() - started,
          body: buf.slice(0, 500),
        })
      );
    });
    req.on('error', (e) => resolve({ status: 0, ms: Date.now() - started, error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ms: Date.now() - started, error: 'timeout' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const SRC = 'Design is not just what it looks like, design is how it works.';
const results = [];

function record(name, extra) {
  results.push({ name, ...extra });
  const flag = extra.status >= 200 && extra.status < 300 ? 'OK  ' : 'FAIL';
  console.log(`${flag} ${name.padEnd(34)} status=${extra.status} ${extra.ms}ms ${extra.error || ''}`);
}

/* ---------------- 1. Microsoft / Edge 免费翻译（无需 Key） ---------------- */
async function probeBing() {
  const auth = await request({ url: 'https://edge.microsoft.com/translate/auth' });
  if (auth.status !== 200) return record('bing:edge-token', auth);
  const token = (auth.body || '').trim();
  const r = await request({
    url: 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: [{ Text: SRC }],
  });
  record('bing:translate', { ...r, tokenLen: token.length });
  try {
    const j = JSON.parse(r.body);
    record('bing:result', { status: 200, ms: r.ms, body: j[0].translations[0].text });
  } catch {
    record('bing:result', { status: 0, ms: r.ms, error: 'parse failed' });
  }
}

/* ---------------- 2. 腾讯交互翻译 Transmart（免 Key） ---------------- */
async function probeTencent() {
  const r = await request({
    url: 'https://transmart.qq.com/api/imt',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      referer: 'https://transmart.qq.com/zh-CN/index',
      origin: 'https://transmart.qq.com',
    },
    body: {
      header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0.0', user: 'probe' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'en', text_list: [SRC] },
      target: { lang: 'zh', text_list: [''] },
    },
  });
  record('tencent:transmart', r);
}

/* ---------------- 3. MyMemory（免 Key，有日额度） ---------------- */
async function probeMyMemory() {
  const r = await request({
    url: `https://api.mymemory.translated.net/get?q=${encodeURIComponent(SRC)}&langpair=en|zh-CN`,
  });
  record('mymemory:get', r);
}

/* ---------------- 4. 有道（网页免 Key 接口，可能失效） ---------------- */
async function probeYoudao() {
  const r1 = await request({
    url: 'https://aidemo.youdao.com/trans?q=hello&from=auto&to=zh-CHS',
  });
  record('youdao:aidemo', r1);
  const form = 'doctype=json&type=AUTO&i=' + encodeURIComponent('hello world');
  const r2 = await request({
    url: 'https://fanyi.youdao.com/translate?&doctype=json&type=AUTO&i=hello%20world',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://fanyi.youdao.com/' },
    body: form,
  });
  record('youdao:fanyi-web', r2);
}

/* ---------------- 5. Google 免费接口（需代理） ---------------- */
async function probeGoogle() {
  const r = await request({
    url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent('hello')}`,
  });
  record('google:gtx (需代理)', r);
  const r2 = await request({
    url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=${encodeURIComponent('hello')}`,
  });
  record('google:clients5 (需代理)', r2);
}

/* ---------------- 6. Google 前端代理镜像（免 Key） ---------------- */
async function probeMirrors() {
  const r1 = await request({ url: `https://lingva.ml/api/v1/en/zh/${encodeURIComponent('hello')}` });
  record('lingva.ml', r1);
  const r2 = await request({
    url: `https://simplytranslate.org/api/translate/?engine=google&from=en&to=zh-CN&text=${encodeURIComponent('hello')}`,
  });
  record('simplytranslate.org', r2);
  const r3 = await request({ url: 'https://translate.plus/api/translate?text=hello&source=en&target=zh' });
  record('translate.plus', r3);
}

/* ---------------- 7. LibreTranslate 公共实例（多数已需 Key） ---------------- */
async function probeLibre() {
  for (const host of ['libretranslate.de', 'translate.argosopentech.com', 'libretranslate.com']) {
    const r = await request({
      url: `https://${host}/translate`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { q: 'hello', source: 'en', target: 'zh', format: 'text' },
    });
    record(`libre:${host}`, r);
  }
}

/* ---------------- 8. 免费 LLM 平台（需注册 Key，但不要钱） ---------------- */
async function probeFreeLlm() {
  const r1 = await request({
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { model: 'glm-4-flash', messages: [{ role: 'user', content: 'hi' }] },
  });
  record('zhipu:glm-4-flash (免费Key)', r1);
  const r2 = await request({ url: 'https://api.siliconflow.cn/v1/models' });
  record('siliconflow (免费模型)', r2);
  const r3 = await request({ url: 'https://api.deepseek.com/v1/models' });
  record('deepseek (付费Key)', r3);
  const r4 = await request({ url: 'https://api-free.deepl.com/v2/usage' });
  record('deepl-free (免费Key)', r4);
}

const probes = [
  probeBing,
  probeTencent,
  probeMyMemory,
  probeYoudao,
  probeGoogle,
  probeMirrors,
  probeLibre,
  probeFreeLlm,
];

for (const p of probes) {
  try {
    await p();
  } catch (e) {
    record(p.name, { status: 0, ms: 0, error: String(e && e.message) });
  }
}

const out = path.join(__dirname, 'probe-results.json');
fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
console.log('\n结果已写入: ' + out);
