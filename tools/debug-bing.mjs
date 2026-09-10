/**
 * debug-bing.mjs — 定位 Bing 链路失败原因（直连 / 代理分别测试）
 * 用法: node tools/debug-bing.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const http = require(path.join(__dirname, '..', 'com.dsh.aitranslator', 'panel', 'js', 'http.js'));

const SRC = 'Design is not just what it looks like, design is how it works.';

async function flow(label, proxy) {
  console.log(`\n===== ${label} (proxy=${proxy || '无'}) =====`);
  let session;
  try {
    const res = await http.request({
      url: 'https://cn.bing.com/translator',
      headers: { accept: 'text/html,application/xhtml+xml' },
      proxy,
      timeout: 20000,
      retries: 0,
    });
    console.log(`  会话 GET: status=${res.status} channel=${res.channel} finalUrl=${res.finalUrl} len=${res.text.length} cookies=${(res.cookies || []).length}`);
    const html = res.text || '';
    const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/);
    const ig = html.match(/IG:"([^"]+)"/);
    const iid = html.match(/data-iid="([^"]+)"/);
    if (!helper) { console.log('  ✘ 未找到 token'); return; }
    const parts = helper[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    session = { key: parts[0], token: parts[1], ig: ig ? ig[1] : '', iid: iid ? iid[1] : '', cookie: (res.cookies || []).join('; ') };
    console.log(`  token: key=${session.key} tokenLen=${session.token.length} ig=${!!session.ig} iid=${!!session.iid} cookieLen=${session.cookie.length}`);
  } catch (e) {
    console.log('  ✘ 会话失败: ' + e.message);
    return;
  }

  const body =
    'fromLang=auto-detect&text=' + encodeURIComponent(SRC) +
    '&to=zh-Hans&token=' + encodeURIComponent(session.token) +
    '&key=' + encodeURIComponent(session.key);

  try {
    const r = await http.request({
      url: 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(session.ig) + '&IID=' + encodeURIComponent(session.iid),
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://cn.bing.com/translator',
        origin: 'https://cn.bing.com',
        cookie: session.cookie,
      },
      body,
      proxy,
      timeout: 20000,
      retries: 0,
    });
    console.log(`  翻译 POST: status=${r.status} channel=${r.channel} len=${r.text.length}`);
    console.log('  body: ' + JSON.stringify(r.text.slice(0, 400)));
    console.log('  响应头: ' + JSON.stringify({ ct: r.headers['content-type'], cl: r.headers['content-length'], te: r.headers['transfer-encoding'] }));
  } catch (e) {
    console.log('  ✘ 翻译失败: ' + e.message);
  }
}

const proxy = await http.detectSystemProxy();
await flow('直连', null);
await flow('代理', proxy);
