/**
 * CSInterface.js — 精简版 CEP 宿主接口封装
 *
 * 只实现本插件需要的部分（evalScript / 系统路径 / 事件 / 宿主环境）。
 * 与 Adobe 官方 CSInterface 的调用方式保持一致，便于日后替换为官方文件。
 */
function CSInterface() { }

/** 是否运行在 CEP 宿主内（否则为浏览器预览模式） */
CSInterface.prototype.isHostAvailable = function () {
  return typeof window !== 'undefined' && typeof window.__adobe_cep__ !== 'undefined';
};

/**
 * 执行 ExtendScript
 * @param {string} script
 * @param {function(string=)} callback 回调参数为脚本返回值（字符串）
 */
CSInterface.prototype.evalScript = function (script, callback) {
  callback = callback || function () { };
  if (!this.isHostAvailable()) {
    callback(JSON.stringify({ ok: false, error: '未运行在 Illustrator 中（浏览器预览模式）' }));
    return;
  }
  try {
    window.__adobe_cep__.evalScript(script, function (result) {
      callback(result === undefined || result === null ? '' : String(result));
    });
  } catch (e) {
    callback(JSON.stringify({ ok: false, error: 'evalScript 异常：' + e.message }));
  }
};

/**
 * 获取系统路径
 * @param {string} type 'extension' | 'hostApplication' | 'userData' | 'myDocuments' | 'desktop' | 'temporary'
 */
CSInterface.prototype.getSystemPath = function (type) {
  if (!this.isHostAvailable()) return '';
  try {
    var path = window.__adobe_cep__.getSystemPath(type);
    if (!path) return '';
    // CEP 返回的是 URL 形式（file:///C:/…），且非 ASCII 会被百分号编码。
    // Node 的 require() 不认 file:// 前缀，必须先还原成文件系统路径。
    try { path = decodeURI(path); } catch (e) { /* 编码不合法时按原样用 */ }
    path = path.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
    // file:///C:/… 在部分平台上会剩下 /C:/… 的前导斜杠
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\\/g, '/');
  } catch (e) {
    return '';
  }
};

/** 宿主环境 { appName, appVersion, appId, isAppOnline, ... } */
CSInterface.prototype.getHostEnvironment = function () {
  if (!this.isHostAvailable()) {
    return { appName: 'browser-preview', appVersion: '0.0', appId: 'preview' };
  }
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return { appName: 'unknown', appVersion: '0.0', appId: 'unknown' };
  }
};

CSInterface.prototype.getExtensionId = function () {
  if (!this.isHostAvailable()) return 'com.dsh.aitranslator.panel';
  try { return window.__adobe_cep__.getExtensionId(); } catch (e) { return ''; }
};

CSInterface.prototype.getScaleFactor = function () {
  if (!this.isHostAvailable()) return 1;
  try { return window.__adobe_cep__.getScaleFactor(); } catch (e) { return 1; }
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (!this.isHostAvailable()) { window.open(url, '_blank'); return; }
  try { window.__adobe_cep__.openURLInDefaultBrowser(url); } catch (e) { }
};

/** 事件：'com.adobe.csxs.events.ThemeColorChanged' 等 */
CSInterface.prototype.addEventListener = function (type, listener, obj) {
  if (!this.isHostAvailable()) return;
  try { window.__adobe_cep__.addEventListener(type, listener, obj || {}); } catch (e) { }
};

CSInterface.prototype.removeEventListener = function (type, listener, obj) {
  if (!this.isHostAvailable()) return;
  try { window.__adobe_cep__.removeEventListener(type, listener, obj || {}); } catch (e) { }
};

CSInterface.prototype.dispatchEvent = function (event) {
  if (!this.isHostAvailable()) return;
  try {
    if (window.__adobe_cep__.__adobe_cep__dispatchEvent) {
      window.__adobe_cep__.__adobe_cep__dispatchEvent(event);
    }
  } catch (e) { }
};

CSInterface.prototype.closeExtension = function () {
  if (!this.isHostAvailable()) return;
  try { window.__adobe_cep__.closeExtension(); } catch (e) { }
};

/** 常用事件常量 */
var SystemPath = {
  EXTENSION: 'extension',
  HOST_APPLICATION: 'hostApplication',
  USER_DATA: 'userData',
  MY_DOCUMENTS: 'myDocuments',
  DESKTOP: 'desktop',
  TEMPORARY: 'temporary',
};

var CSXSWindowType = { PANEL: 'Panel', MODAL_DIALOG: 'ModalDialog', MODELESS_DIALOG: 'ModelessDialog' };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CSInterface: CSInterface, SystemPath: SystemPath, CSXSWindowType: CSXSWindowType };
}
