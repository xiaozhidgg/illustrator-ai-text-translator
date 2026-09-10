/**
 * debug-bing2.mjs — 对照实验：会话复用 vs 每条新建会话
 * 用法: node tools/debug-bing2.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const http = require(path.join(__dirname, '..', 'com.dsh.aitranslator', 'panel', 'js', 'http.js'));

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
  if (!helper) throw new Error('无 token');
  const parts = helper[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  return {
    key: parts[0], token: parts[1], ig: ig ? ig[1] : '', iid: iid ? iid[1] : '',
    cookie: (res.cookies || []).join('; '),
  };
}

async function translate(text, s, proxy) {
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
  return { status: r.status, len: (r.text || '').length, text: (r.text || '').slice(0, 90) };
}

const proxy = await http.detectSystemProxy();
console.log('代理: ' + (proxy || '无'));

console.log('\n--- 实验 A：一个会话连续翻译 4 条 ---');
try {
  const s = await newSession(proxy);
  console.log('  会话建立 key=' + s.key + ' cookieLen=' + s.cookie.length);
  for (let i = 1; i <= 4; i++) {
    const r = await translate('Save as ' + i, s, proxy);
    console.log(`  第${i}条: status=${r.status} len=${r.len} ${r.text}`);
  }
} catch (e) {
  console.log('  实验 A 失败: ' + e.message);
}

console.log('\n--- 实验 B：每条新建会话 ---');
for (let i = 1; i <= 3; i++) {
  try {
    const s = await newSession(proxy);
    const r = await translate('Open recent ' + i, s, proxy);
    console.log(`  第${i}条: status=${r.status} len=${r.len} ${r.text}`);
  } catch (e) {
    console.log(`  第${i}条 失败: ${e.message}`);
  }
}
