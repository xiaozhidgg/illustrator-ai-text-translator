/**
 * probe-engines-3.mjs — 第三轮：验证 Bing(cn) 免费翻译链路 + 有道批量/限流表现。
 * 用法: node tools/probe-engines-3.mjs
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

function httpRequest({ url, method = 'GET', headers = {}, body = null, timeout = 20000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload =
      body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const h = {
      'user-agent': UA,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    };
    if (payload) h['content-length'] = String(payload.length);
    const started = Date.now();
    const req = https.request(
      { host: u.hostname, port: 443, path: u.pathname + u.search, method, headers: h, timeout },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            ms: Date.now() - started,
            body: b,
            setCookie: res.headers['set-cookie'] || [],
          })
        );
      }
    );
    req.on('error', (e) => resolve({ status: 0, ms: Date.now() - started, error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ms: Date.now() - started, error: 'timeout' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFollow(url, headers = {}, max = 5) {
  let cur = url;
  let cookies = [];
  let res;
  for (let i = 0; i < max; i++) {
    res = await httpRequest({ url: cur, headers: { ...headers, cookie: cookies.join('; ') } });
    for (const c of res.setCookie || []) cookies.push(String(c).split(';')[0]);
    if (res.status >= 300 && res.status < 400 && res.headers && res.headers.location) {
      cur = new URL(res.headers.location, cur).href;
      continue;
    }
    return { res, cookies, finalUrl: cur };
  }
  return { res, cookies, finalUrl: cur };
}

const results = [];
const log = (name, obj) => {
  results.push({ name, ...obj });
  const ok = obj.status >= 200 && obj.status < 300;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(28)} ${String(obj.status).padEnd(4)} ${String(obj.ms).padStart(6)}ms ${obj.error || ''} ${obj.note ? '| ' + obj.note : ''}`);
};

/* ---------------- Bing 免费链路 ---------------- */
async function probeBing() {
  const { res, cookies, finalUrl } = await getFollow('https://cn.bing.com/translator', { accept: 'text/html' });
  const html = res.body || '';
  log('bing:page', {
    status: res.status,
    ms: res.ms,
    note: `final=${finalUrl} len=${html.length} cookies=${cookies.length}`,
  });
  const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/);
  const ig = html.match(/IG:"([^"]+)"/);
  const iid = html.match(/data-iid="([^"]+)"/) || html.match(/IID:?"([^"]+)"/);
  if (!helper) {
    log('bing:token', { status: 0, ms: 0, note: '未找到 params_AbusePreventionHelper', error: 'parse' });
    return;
  }
  const parts = helper[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  log('bing:token', { status: 200, ms: 0, note: `key=${parts[0]} tokenLen=${parts[1].length} ig=${!!ig} iid=${!!iid}` });

  const form =
    'fromLang=en&text=' +
    encodeURIComponent('Design is not just what it looks like, design is how it works.') +
    '&to=zh-Hans&token=' +
    encodeURIComponent(parts[1]) +
    '&key=' +
    encodeURIComponent(parts[0]);
  const url = `https://cn.bing.com/ttranslatev3?isVertical=1&IG=${ig ? ig[1] : ''}&IID=${iid ? iid[1] : ''}`;
  const r = await httpRequest({
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://cn.bing.com/translator',
      origin: 'https://cn.bing.com',
      cookie: cookies.join('; '),
    },
    body: form,
  });
  log('bing:ttranslatev3', { status: r.status, ms: r.ms, body: (r.body || '').slice(0, 300) });
}

/* ---------------- 有道：批量/特殊字符/限流 ---------------- */
async function probeYoudao() {
  // 1) 多行文本
  const multi = 'First line.\nSecond line.\nThird line.';
  const r1 = await httpRequest({
    url: 'https://aidemo.youdao.com/trans?q=' + encodeURIComponent(multi) + '&from=auto&to=zh-CHS',
  });
  log('youdao:多行', { status: r1.status, ms: r1.ms, body: (r1.body || '').slice(0, 260) });

  // 2) 中译英方向
  const r2 = await httpRequest({
    url: 'https://aidemo.youdao.com/trans?q=' + encodeURIComponent('这是一个测试') + '&from=auto&to=en',
  });
  log('youdao:中译英', { status: r2.status, ms: r2.ms, body: (r2.body || '').slice(0, 200) });

  // 3) 20 次快速请求看限流
  let ok = 0;
  let fail = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      httpRequest({
        url: 'https://aidemo.youdao.com/trans?q=' + encodeURIComponent('item ' + i) + '&from=auto&to=zh-CHS',
      }).then((r) => {
        if (r.status === 200 && /"translation"/.test(r.body || '')) ok++;
        else fail++;
      })
    )
  );
  log('youdao:20并发', { status: ok > 0 ? 200 : 0, ms: Date.now() - t0, note: `ok=${ok} fail=${fail}` });
}

/* ---------------- 腾讯：长文本 + 批量 ---------------- */
async function probeTencent() {
  const texts = ['Hello world', 'Please select a file', 'Save as'];
  const r = await httpRequest({
    url: 'https://transmart.qq.com/api/imt',
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'https://transmart.qq.com/zh-CN/index', origin: 'https://transmart.qq.com' },
    body: {
      header: { fn: 'auto_translation', client_key: 'browser-firefox-133.0.0', user: '' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'en', text_list: texts },
      target: { lang: 'zh', text_list: ['', '', ''] },
    },
  });
  log('tencent:批量3条', { status: r.status, ms: r.ms, body: (r.body || '').slice(0, 300) });
}

for (const p of [probeYoudao, probeTencent, probeBing]) {
  try {
    await p();
  } catch (e) {
    log(p.name, { status: 0, ms: 0, error: String(e && e.message) });
  }
}

fs.writeFileSync(path.join(__dirname, 'probe-results-3.json'), JSON.stringify(results, null, 2), 'utf8');
console.log('\n结果已写入 tools/probe-results-3.json');
