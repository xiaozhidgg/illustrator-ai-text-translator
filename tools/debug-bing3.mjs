/**
 * debug-bing3.mjs — 埋点实验：连续翻译 12 条，逐次记录 状态/长度/重试序号
 * 用法: node tools/debug-bing3.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const http = require(path.join(__dirname, '..', 'com.dsh.aitranslator', 'panel', 'js', 'http.js'));

let session = null;

async function newSession(proxy) {
  const res = await http.request({
    url: 'https://cn.bing.com/translator',
    headers: { accept: 'text/html,application/xhtml+xml' },
    proxy,
    timeout: 20000,
    retries: 0,
  });
  const html = res.text || '';
  const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/);
  const ig = html.match(/IG:"([^"]+)"/);
  const iid = html.match(/data-iid="([^"]+)"/);
  const parts = helper[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  session = {
    key: parts[0], token: parts[1], ig: ig ? ig[1] : '', iid: iid ? iid[1] : '',
    cookie: (res.cookies || []).join('; '), used: 0,
  };
  console.log(`  [会话] key=${session.key} cookie=${session.cookie.length}字节`);
  return session;
}

async function post(text, s, proxy) {
  const body =
    'fromLang=auto-detect&text=' + encodeURIComponent(text) +
    '&to=zh-Hans&token=' + encodeURIComponent(s.token) + '&key=' + encodeURIComponent(s.key);
  const r = await http.request({
    url: 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(s.ig) + '&IID=' + encodeURIComponent(s.iid),
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://cn.bing.com/translator',
      origin: 'https://cn.bing.com',
      cookie: s.cookie,
    },
    body,
    proxy,
    timeout: 20000,
    retries: 0,
  });
  return { status: r.status, raw: (r.text || '').trim() };
}

const proxy = await http.detectSystemProxy();
console.log('代理: ' + (proxy || '无') + '\n');

await newSession(proxy);
let emptyStreak = 0;
let maxStreak = 0;
let ok = 0;
let fail = 0;

for (let i = 1; i <= 12; i++) {
  let done = false;
  for (let attempt = 0; attempt < 5 && !done; attempt++) {
    if (session.used > 8) await newSession(proxy);
    session.used++;
    const r = await post('menu item number ' + i, session, proxy);
    const empty = r.raw.length === 0;
    console.log(`  #${i} 尝试${attempt} status=${r.status} len=${r.raw.length}${empty ? '  ← 空' : '  ' + r.raw.slice(0, 60)}`);
    if (!empty) {
      done = true;
      ok++;
      if (emptyStreak > maxStreak) maxStreak = emptyStreak;
      emptyStreak = 0;
    } else {
      emptyStreak++;
      await http.delay(300);
    }
  }
  if (!done) { fail++; console.log(`  #${i} ✘ 5 次重试仍为空`); }
}

if (emptyStreak > maxStreak) maxStreak = emptyStreak;
console.log(`\n成功 ${ok} 条，失败 ${fail} 条，最长连续空响应 ${maxStreak} 次`);
