/**
 * http.js — 面板内 Node 网络层（CEP 的 Node.js 环境）
 *
 * 为什么不用浏览器 fetch：
 *   1. CEP 的 CEF 请求会受同源/CORS 限制，直接调第三方翻译接口会被拦；
 *   2. Node 端可以自定义代理（本机 Clash 等），Google 系接口必须走代理；
 *   3. Node 端可精确控制超时、重试、并发节流。
 *
 * 该文件同时被 Node 单测 / 命令行工具复用（CommonJS）。
 */
var https = require('https');
var http = require('http');
var tls = require('tls');
var URL = require('url').URL;

var DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function sleepJitter(base) {
  return delay(base + Math.floor(Math.random() * base * 0.5));
}

/* ------------------------------------------------------------------ *
 * 代理支持：自定义 https.Agent，通过 HTTP CONNECT 打隧道
 * ------------------------------------------------------------------ */
var agentCache = {};

function proxyAgent(proxyUrl) {
  if (agentCache[proxyUrl]) return agentCache[proxyUrl];
  var p = new URL(proxyUrl);
  var agent = new https.Agent({ keepAlive: false, maxSockets: 8 });

  agent.createConnection = function (options, cb) {
    var targetHost = options.host;
    var targetPort = options.port || 443;
    var creq = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: { host: targetHost + ':' + targetPort, 'proxy-connection': 'keep-alive' },
      timeout: 15000,
    });
    creq.on('connect', function (res, socket) {
      if (res.statusCode !== 200) {
        var err = new Error('代理 CONNECT 失败: HTTP ' + res.statusCode);
        socket.destroy();
        if (cb) cb(err);
        return;
      }
      var t = tls.connect({ socket: socket, servername: targetHost }, function () {
        if (cb) cb(null, t);
      });
      t.on('error', function (e) { if (cb) cb(e); });
    });
    creq.on('timeout', function () {
      creq.destroy();
      if (cb) cb(new Error('代理连接超时'));
    });
    creq.on('error', function (e) { if (cb) cb(e); });
    creq.end();
  };

  agentCache[proxyUrl] = agent;
  return agent;
}

/* ------------------------------------------------------------------ *
 * 单次请求
 * ------------------------------------------------------------------ */
/**
 * @param {object} o
 *   url, method, headers, body(string|Buffer|object), timeout(ms), proxy('http://127.0.0.1:7897')
 * @returns {Promise<{status:number, headers:object, text:string, ms:number}>}
 */
function requestOnce(o) {
  return new Promise(function (resolve, reject) {
    var u;
    try {
      u = new URL(o.url);
    } catch (e) {
      reject(new Error('非法 URL: ' + o.url));
      return;
    }
    var isHttps = u.protocol === 'https:';
    var payload = null;
    if (o.body !== undefined && o.body !== null) {
      payload = Buffer.isBuffer(o.body)
        ? o.body
        : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body), 'utf8');
    }
    var headers = Object.assign(
      {
        'user-agent': o.userAgent || DEFAULT_UA,
        accept: '*/*',
        'accept-encoding': 'identity',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      o.headers || {}
    );
    if (payload) headers['content-length'] = String(payload.length);

    var options = {
      method: o.method || 'GET',
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: headers,
      timeout: o.timeout || 20000,
    };

    var useProxy = o.proxy && String(o.proxy).replace(/\s/g, '') !== '';
    if (useProxy && isHttps) {
      options.agent = proxyAgent(o.proxy);
    } else if (useProxy) {
      var pp = new URL(o.proxy);
      options.host = pp.hostname;
      options.port = pp.port || 80;
      options.path = o.url;
      options.headers.host = u.host;
    }

    var mod = isHttps ? https : http;
    var started = Date.now();
    var req = mod.request(options, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          ms: Date.now() - started,
        });
      });
      res.on('error', reject);
    });

    req.on('timeout', function () {
      req.destroy(new Error('请求超时(' + options.timeout + 'ms)'));
    });
    req.on('error', function (e) {
      e.ms = Date.now() - started;
      reject(e);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 重定向跟随 + Cookie 收集
 * ------------------------------------------------------------------ */
var REDIRECT_CODES = [301, 302, 303, 307, 308];

async function requestChain(o) {
  var url = o.url;
  var method = o.method || 'GET';
  var body = o.body;
  var cookies = [];
  var maxRedirects = o.maxRedirects === undefined ? 5 : o.maxRedirects;
  var hops = 0;

  while (true) {
    var headers = Object.assign({}, o.headers || {});
    if (cookies.length) {
      headers.cookie = [headers.cookie, cookies.join('; ')].filter(Boolean).join('; ');
    }
    var res = await requestOnce(Object.assign({}, o, { url: url, method: method, body: body, headers: headers }));

    var setCookie = res.headers['set-cookie'] || [];
    for (var i = 0; i < setCookie.length; i++) {
      cookies.push(String(setCookie[i]).split(';')[0]);
    }

    if (
      o.followRedirect === false ||
      REDIRECT_CODES.indexOf(res.status) === -1 ||
      !res.headers.location ||
      hops >= maxRedirects
    ) {
      res.finalUrl = url;
      res.cookies = cookies;
      return res;
    }

    var next = '';
    try {
      next = new URL(res.headers.location, url).href;
    } catch (e) {
      res.finalUrl = url;
      res.cookies = cookies;
      return res;
    }
    // 301/302/303 把非 GET 请求降级为 GET 并丢弃 body（与浏览器行为一致）
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = null;
    }
    url = next;
    hops++;
  }
}

/* ------------------------------------------------------------------ *
 * 带重试 / 代理回退的请求
 * ------------------------------------------------------------------ */
function isRetryable(err, res) {
  if (err) {
    var code = err.code || '';
    if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ECONNABORTED'].indexOf(code) !== -1) return true;
    if (/超时|socket hang up|aborted|disconnected|TLS/i.test(err.message || '')) return true;
    return false;
  }
  if (!res) return false;
  if (res.status === 429) return true;
  if (res.status >= 500 && res.status < 600) return true;
  return false;
}

/**
 * 请求策略：先按配置的代理（或直连）尝试；失败后自动换另一条路。
 * 这样既能翻墙访问 Google，又不会因为代理不通而拖垮国内接口。
 *
 * @param {object} o  requestOnce 的参数，另有：
 *   retries      每个通道的重试次数（默认 1）
 *   retryDelay   重试间隔基数（默认 600ms）
 *   proxy        代理地址，如 http://127.0.0.1:7897
 *   noProxyFallback  true 时禁止回退到直连
 */
async function request(o) {
  var retries = o.retries === undefined ? 1 : o.retries;
  var channels = [];
  if (o.proxy) channels.push(o.proxy);
  if (o.noProxyFallback !== true) channels.push(null);
  if (!o.proxy && o.autoProxy) channels.push(o.autoProxy);

  // 去重，保持顺序
  var seen = {};
  channels = channels.filter(function (c) {
    var k = String(c);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });

  var errors = [];
  for (var c = 0; c < channels.length; c++) {
    var proxy = channels[c];
    var label = proxy ? '代理 ' + proxy : '直连';
    for (var a = 0; a <= retries; a++) {
      try {
        var res = await requestChain(Object.assign({}, o, { proxy: proxy }));
        if (isRetryable(null, res)) {
          errors.push(label + ' HTTP ' + res.status);
          if (a < retries) { await sleepJitter(o.retryDelay || 600); continue; }
          break; // 换下一条通道
        }
        res.usedProxy = proxy || '';
        res.channel = label;
        return res;
      } catch (e) {
        errors.push(label + ' ' + (e.message || e.code || '失败'));
        if (!isRetryable(e, null)) break;          // 非网络问题，换通道也没用
        if (a < retries) { await sleepJitter(o.retryDelay || 600); continue; }
        break;                                     // 该通道重试耗尽 → 换下一条
      }
    }
  }
  throw new Error(errors.join(' ｜ ') || '请求失败');
}

async function requestJson(o) {
  var res = await request(o);
  var data = null;
  try { data = JSON.parse(res.text); } catch (e) { /* 保留 text */ }
  return {
    status: res.status, headers: res.headers, ms: res.ms, data: data,
    text: res.text, channel: res.channel, cookies: res.cookies, finalUrl: res.finalUrl,
  };
}

/* ------------------------------------------------------------------ *
 * 并发节流器
 * ------------------------------------------------------------------ */
function createLimiter(limit) {
  var queue = [];
  var active = 0;

  function next() {
    if (active >= limit || queue.length === 0) return;
    var job = queue.shift();
    active++;
    Promise.resolve()
      .then(job.fn)
      .then(
        function (v) { active--; job.resolve(v); next(); },
        function (e) { active--; job.reject(e); next(); }
      );
  }

  return function (fn) {
    return new Promise(function (resolve, reject) {
      queue.push({ fn: fn, resolve: resolve, reject: reject });
      next();
    });
  };
}

/** 串行 + 固定间隔（应对有道这类限流严格的接口） */
function createSerialQueue(gapMs) {
  var chain = Promise.resolve();
  return function (fn) {
    var run = chain.then(function () {
      return Promise.resolve().then(fn);
    });
    chain = run.then(
      function () { return delay(gapMs || 0); },
      function () { return delay(gapMs || 0); }
    );
    return run;
  };
}

/* ------------------------------------------------------------------ *
 * 网络诊断
 * ------------------------------------------------------------------ */
function probeTcp(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    var socket = require('net').connect({ host: host, port: port });
    var done = false;
    function finish(v) {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) { }
      resolve(v);
    }
    socket.setTimeout(timeoutMs || 1500);
    socket.on('connect', function () { finish(true); });
    socket.on('timeout', function () { finish(false); });
    socket.on('error', function () { finish(false); });
  });
}

/** 自动探测本机代理：先读注册表，再扫常见端口 */
async function detectSystemProxy() {
  // 1) Windows 系统代理设置
  try {
    var execSync = require('child_process').execSync;
    var out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf8', timeout: 4000 }
    );
    if (/0x1\b/.test(out)) {
      var out2 = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf8', timeout: 4000 }
      );
      var m = out2.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m) {
        var server = m[1];
        if (server.indexOf('=') !== -1) {
          var parts = server.split(';');
          for (var i = 0; i < parts.length; i++) {
            if (/^https=/i.test(parts[i])) server = parts[i].split('=')[1];
          }
        }
        var alive = await probeTcp(server.split(':')[0], Number(server.split(':')[1] || 80), 1200);
        if (alive) return 'http://' + server;
      }
    }
  } catch (e) { /* 非 Windows 或读取失败 */ }

  // 2) 常见本地代理端口
  var ports = [7897, 7890, 10809, 10808, 1080, 2080, 8080, 20171];
  for (var p = 0; p < ports.length; p++) {
    if (await probeTcp('127.0.0.1', ports[p], 400)) {
      return 'http://127.0.0.1:' + ports[p];
    }
  }
  return '';
}

module.exports = {
  request: request,
  requestOnce: requestOnce,
  requestJson: requestJson,
  createLimiter: createLimiter,
  createSerialQueue: createSerialQueue,
  detectSystemProxy: detectSystemProxy,
  probeTcp: probeTcp,
  delay: delay,
  DEFAULT_UA: DEFAULT_UA,
};
