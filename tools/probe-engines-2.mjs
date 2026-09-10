/**
 * probe-engines-2.mjs — 第二轮：深挖「免 Key 免费」翻译接口的真实可用性与译文质量。
 * 用法: node tools/probe-engines-2.mjs
 */
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 20000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const SRC = 'Design is not just what it looks like, design is how it works.';

function raw({ url, method = 'GET', headers = {}, body = null, proxy = null, followRedirect = false }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload =
      body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const baseHeaders = {
      'user-agent': UA,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...headers,
    };
    if (payload) baseHeaders['content-length'] = String(payload.length);

    const started = Date.now();
    const done = (obj) => resolve({ ms: Date.now() - started, ...obj });

    const send = (socket, hostHeader) => {
      const hdr = { ...baseHeaders, host: hostHeader };
      let head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
      for (const k of Object.keys(hdr)) head += `${k}: ${hdr[k]}\r\n`;
      head += 'connection: close\r\n\r\n';
      let buf = Buffer.alloc(0);
      socket.write(head);
      if (payload) socket.write(payload);
      socket.on('data', (c) => (buf = Buffer.concat([buf, c])));
      socket.on('end', () => {
        const text = buf.toString('utf8');
        const idx = text.indexOf('\r\n\r\n');
        const headText = idx >= 0 ? text.slice(0, idx) : text;
        const bodyText = idx >= 0 ? text.slice(idx + 4) : '';
        const status = Number((headText.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
        done({ status, body: bodyText.slice(0, 600), rawHeaders: headText.slice(0, 200) });
      });
      socket.on('error', (e) => done({ status: 0, error: e.code || e.message }));
      socket.setTimeout(TIMEOUT, () => {
        socket.destroy();
        done({ status: 0, error: 'timeout' });
      });
    };

    if (proxy) {
      const p = new URL(proxy);
      const creq = http.request({
        host: p.hostname,
        port: p.port,
        method: 'CONNECT',
        path: `${u.hostname}:443`,
        headers: { host: `${u.hostname}:443` },
        timeout: TIMEOUT,
      });
      creq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return done({ status: res.statusCode, error: 'proxy CONNECT failed' });
        const t = tls.connect({ socket, servername: u.hostname }, () => send(t, u.hostname));
        t.on('error', (e) => done({ status: 0, error: 'tls:' + (e.code || e.message) }));
      });
      creq.on('error', (e) => done({ status: 0, error: 'proxy:' + (e.code || e.message) }));
      creq.on('timeout', () => {
        creq.destroy();
        done({ status: 0, error: 'proxy timeout' });
      });
      creq.end();
      return;
    }

    const socket = tls.connect({ host: u.hostname, port: u.port || 443, servername: u.hostname }, () =>
      send(socket, u.hostname)
    );
    socket.on('error', (e) => done({ status: 0, error: e.code || e.message }));
  });
}

const out = [];
const log = (name, r, note = '') => {
  out.push({ name, note, ...r });
  const ok = r.status >= 200 && r.status < 300;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(30)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms ${r.error || ''}`);
};

/* ============ A. Bing 免费翻译（两条路：edge token / bing.com token） ============ */
async function bingEdgeVariants() {
  const variants = [
    { url: 'https://edge.microsoft.com/translate/auth', headers: { origin: 'https://www.bing.com', referer: 'https://www.bing.com/' } },
    { url: 'https://edge.microsoft.com/translate/auth?', headers: {} },
    { url: 'https://edge.microsoft.com/translate/auth', method: 'POST', headers: { 'content-type': 'application/json', body: '{}' } },
  ];
  for (const v of variants) {
    const r = await raw(v);
    log('bing:edge ' + (v.method || 'GET') + (v.url.includes('?') ? '?q' : ''), r, (r.body || '').slice(0, 60));
  }
}

async function bingWebToken() {
  const page = await raw({ url: 'https://www.bing.com/translator', headers: { accept: 'text/html' } });
  if (page.status !== 200) return log('bing:web page', page);
  const html = page.body || '';
  const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/);
  const ig = html.match(/IG:"([^"]+)"/);
  const iid = html.match(/data-iid="([^"]+)"/);
  log('bing:web page', { status: page.status, ms: page.ms, body: `helper=${!!helper} ig=${!!ig} iid=${!!iid}` });
  if (!helper) return;
  const parts = helper[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  const key = parts[0];
  const token = parts[1];
  const form = `fromLang=en&text=${encodeURIComponent(SRC)}&to=zh-Hans&token=${encodeURIComponent(token)}&key=${key}`;
  const r = await raw({
    url: `https://www.bing.com/ttranslatev3?isVertical=1&IG=${ig ? ig[1] : ''}&IID=${iid ? iid[1] : ''}`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://www.bing.com/translator' },
    body: form,
  });
  log('bing:ttranslatev3', r);
}

/* ============ B. 有道 demo 接口：连续请求 + 长文本 ============ */
async function youdao() {
  const long = SRC.repeat(6);
  for (let i = 1; i <= 4; i++) {
    const r = await raw({ url: `https://aidemo.youdao.com/trans?q=${encodeURIComponent(i === 4 ? long : SRC)}&from=auto&to=zh-CHS` });
    log(`youdao:aidemo #${i}${i === 4 ? ' (长文本)' : ''}`, r);
  }
}

/* ============ C. 腾讯 Transmart 变体 ============ */
async function tencent() {
  const variants = [
    { client_key: 'browser-chrome-131.0.0.0', user: 'x' },
    { client_key: 'browser-firefox-133.0.0', user: '' },
    { client_key: 'browser-chrome-110.0.0.0', user: '00000000-0000-0000-0000-000000000000' },
  ];
  for (const v of variants) {
    const r = await raw({
      url: 'https://transmart.qq.com/api/imt',
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: 'https://transmart.qq.com/zh-CN/index', origin: 'https://transmart.qq.com' },
      body: {
        header: { fn: 'auto_translation', client_key: v.client_key, user: v.user },
        type: 'plain',
        model_category: 'normal',
        source: { lang: 'en', text_list: [SRC] },
        target: { lang: 'zh', text_list: [''] },
      },
    });
    log(`tencent:${v.client_key}`, r, (r.body || '').slice(0, 90));
  }
}

/* ============ D. Google 镜像 / 前端代理 ============ */
async function mirrors() {
  const list = [
    'https://lingva.garudalinux.org/api/v1/en/zh/hello',
    'https://translate.plausibility.cloud/api/v1/en/zh/hello',
    'https://lingva.lunar.icu/api/v1/en/zh/hello',
    'https://simplytranslate.org/api/translate/?engine=google&from=auto&to=zh-CN&text=hello',
    'https://simplytranslate.org/api/translate/?engine=google&from=en&to=zh&text=hello',
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=hello',
  ];
  for (const u of list) {
    const r = await raw({ url: u });
    log('mirror:' + new URL(u).host + new URL(u).pathname.slice(0, 18), r, (r.body || '').slice(0, 80));
  }
}

/* ============ E. Yandex 免费接口 ============ */
async function yandex() {
  const r = await raw({
    url: 'https://translate.yandex.net/api/v1/tr.json/translate?srv=android&lang=en-zh&text=hello',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'text=hello',
  });
  log('yandex:tr.json', r, (r.body || '').slice(0, 120));
}

/* ============ F. 走本机代理的 Google ============ */
async function viaProxy() {
  const proxy = process.env.TEST_PROXY || 'http://127.0.0.1:7897';
  const r = await raw({
    url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent('hello world')}`,
    proxy,
  });
  log(`google:gtx via ${proxy}`, r, (r.body || '').slice(0, 80));
  const r2 = await raw({ url: 'https://www.google.com/generate_204', proxy });
  log(`proxy:sanity ${proxy}`, r2);
}

/* ============ G. 本地 Ollama（若装了） ============ */
async function ollama() {
  const r = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: 11434, path: '/api/tags', method: 'GET', timeout: 4000 },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, ms: 0, body: b.slice(0, 300) }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, ms: 0, error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ms: 0, error: 'timeout' });
    });
    req.end();
  });
  log('local:ollama 11434', r, (r.body || '').slice(0, 120));
}

for (const p of [youdao, tencent, mirrors, yandex, viaProxy, ollama, bingEdgeVariants, bingWebToken]) {
  try {
    await p();
  } catch (e) {
    log(p.name, { status: 0, ms: 0, error: String(e && e.message) });
  }
}

const outFile = path.join(__dirname, 'probe-results-2.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
console.log('\n结果已写入: ' + outFile);
