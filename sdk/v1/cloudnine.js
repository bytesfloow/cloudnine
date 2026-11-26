/*!
 * CloudNine 插件 SDK v1
 * 用 <script src="/plugin-sdk/v1/cloudnine.js"></script> 引入，挂到 window.cloudnine。
 *
 * 协议（全部走 window.postMessage，插件永远不直接访问 parent/top 的其它属性）：
 *   host → iframe: {type:'cn:init', v:1, pluginId, theme:{--var:'值'}, locale, file}
 *                  file = {rel, name, ext}（文件关联打开）或 null（从图标 / 开始菜单启动）
 *   iframe → host: {type:'cn:ready', v:1}
 *   iframe → host: {type:'cn:call', id, method, params}
 *   host → iframe: {type:'cn:result', id, ok:true, value} | {id, ok:false, error:{code,message}}
 *   host → iframe: {type:'cn:event', name:'focus'|'blur'|'resize', payload}
 *
 * 约定：
 *   - 收到 cn:init 之前不发起任何调用；3 秒内没收到 init 的调用以 NOT_READY 拒绝。
 *   - 每次调用 8 秒超时 → TIMEOUT；host 返回的错误原样变成带 code 的 Error。
 *   - 不使用 eval，不读 parent/top 的任何属性（只调 parent.postMessage）。
 */
(function (global) {
  'use strict';

  var CALL_TIMEOUT = 8000;
  var INIT_TIMEOUT = 3000;

  var booted = false;        // 收到 cn:init
  var initTimedOut = false;  // 3 秒内没收到 init
  var pluginId = null;
  var theme = {};
  var locale = null;
  var file = null;
  var seq = 0;
  var pending = Object.create(null);   // callId -> {ok, fail}
  var waiters = [];                    // 等 init 的回调
  var handlers = { focus: [], blur: [], resize: [] };
  var readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  function post(msg) {
    try {
      global.parent.postMessage(msg, '*');
    } catch (e) { /* 没有宿主（直接打开页面）时静默失败，调用方会拿到 NOT_READY */ }
  }

  function makeError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function flushWaiters() {
    var list = waiters;
    waiters = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { /* 单个等待者出错不影响其它 */ }
    }
  }

  // 等 init：已就绪立刻放行；已超时立刻拒绝；否则排队
  function waitInit(cb) {
    if (booted) return cb(null);
    if (initTimedOut) return cb(makeError('NOT_READY', '插件宿主尚未初始化（3 秒内未收到 cn:init）'));
    waiters.push(function () { cb(booted ? null : makeError('NOT_READY', '插件宿主尚未初始化')); });
  }

  function applyTheme(next) {
    if (!next || typeof next !== 'object') return;
    theme = next;
    var root = document.documentElement;
    for (var k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      var v = next[k];
      if (v === null || v === undefined) continue;
      try { root.style.setProperty(k, String(v)); } catch (e) { /* 非法属性名，跳过 */ }
    }
  }

  // host 传来的 file 可能是 null（图标启动）/ 缺字段（旧宿主）：一律归一成三字段对象或 null，
  // 这样插件里不用写 `host.file && host.file.rel` 这种防御代码
  function normalizeFile(f) {
    if (!f || typeof f !== 'object' || typeof f.rel !== 'string' || !f.rel) return null;
    return {
      rel: f.rel,
      name: typeof f.name === 'string' ? f.name : f.rel.split('/').pop(),
      ext: typeof f.ext === 'string' ? f.ext.toLowerCase() : ''
    };
  }

  function emit(name, payload) {
    var list = handlers[name];
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) {
        if (global.console && console.error) console.error('[cloudnine] ' + name + ' 监听器抛错:', e);
      }
    }
  }

  global.addEventListener('message', function (ev) {
    // 只接受宿主窗口发来的消息：页面上其它 iframe / 第三方脚本不能伪造请求
    if (ev.source !== global.parent) return;
    var d = ev.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;

    if (d.type === 'cn:init') {
      if (d.v !== undefined && d.v !== 1) {
        if (global.console && console.warn) console.warn('[cloudnine] 不支持的协议版本:', d.v);
      }
      pluginId = d.pluginId || pluginId;
      if (d.locale) locale = d.locale;
      // 文件关联：宿主只告诉“打开的是哪个文件”，内容插件自己用 fs.readText 读
      file = normalizeFile(d.file);
      applyTheme(d.theme);
      booted = true;
      initTimedOut = false;
      readyResolve({ pluginId: pluginId, theme: theme, locale: locale, file: file });
      flushWaiters();
      post({ type: 'cn:ready', v: 1 });
      return;
    }

    if (d.type === 'cn:result') {
      var p = pending[d.id];
      if (!p) return; // 超时后迟到的结果直接丢掉
      delete pending[d.id];
      if (d.ok) p.ok(d.value);
      else {
        var e = d.error || {};
        p.fail(makeError(e.code || 'ERROR', e.message || '调用失败'));
      }
      return;
    }

    if (d.type === 'cn:theme' && d.theme) { applyTheme(d.theme); return; }

    if (d.type === 'cn:event' && typeof d.name === 'string') { emit(d.name, d.payload); return; }
    if (d.type === 'cn:focus' || d.type === 'cn:blur' || d.type === 'cn:resize') {
      emit(d.type.slice(3), d.payload);
    }
  }, false);

  // 3 秒没等到 init：之后的调用直接 NOT_READY，不让插件页面一直转圈
  setTimeout(function () {
    if (booted) return;
    initTimedOut = true;
    var list = waiters;
    waiters = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { /* ignore */ }
    }
  }, INIT_TIMEOUT);

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      if (typeof method !== 'string' || !method) {
        return reject(makeError('INVALID_ARGUMENT', 'call(method, params) 的 method 必须是非空字符串'));
      }
      var id = pluginId ? pluginId + '-' : '';
      id += (++seq).toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      var settled = false;
      var timer = setTimeout(function () {
        finish(makeError('TIMEOUT', '调用超时（8 秒）：' + method));
      }, CALL_TIMEOUT);

      function finish(e, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete pending[id];
        if (e) reject(e); else resolve(value);
      }

      pending[id] = {
        ok: function (value) { finish(null, value); },
        fail: function (e) { finish(e); }
      };

      waitInit(function (e) {
        if (e) return finish(e);
        post({ type: 'cn:call', id: id, method: method, params: params === undefined ? null : params });
      });
    });
  }

  // storage.get 解包一层 {data}：宿主直接转发 /api/plugins/:id/storage 的响应，
  // 插件作者拿到的是自己存进去的那个值，不用关心服务端包了一层
  function storageGet() {
    return call('storage.get').then(function (v) {
      if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'data')) return v.data;
      return v;
    });
  }

  function on(name, fn) {
    if (!handlers[name]) throw makeError('INVALID_ARGUMENT', '不支持的事件：' + name + '（只支持 focus / blur / resize）');
    if (typeof fn !== 'function') throw makeError('INVALID_ARGUMENT', 'on(name, fn) 的 fn 必须是函数');
    handlers[name].push(fn);
    return function off() {
      var i = handlers[name].indexOf(fn);
      if (i >= 0) handlers[name].splice(i, 1);
    };
  }

  function notify(title, body) {
    var params = typeof title === 'string' ? { title: title, body: body } : (title || {});
    return call('notify', params);
  }

  global.cloudnine = {
    v: 1,
    get pluginId() { return pluginId; },
    get theme() { return theme; },
    get locale() { return locale; },
    // 文件关联打开时的 {rel, name, ext}；从图标启动时为 null
    get file() { return file; },
    ready: function () { return readyPromise; },
    call: call,
    on: on,
    notify: notify,
    storage: {
      get: storageGet,
      set: function (data) { return call('storage.set', { data: data }); }
    },
    fs: {
      list: function (p) { return call('fs.list', { path: p }); },
      readText: function (p) { return call('fs.readText', { path: p }); },
      writeText: function (p, text) { return call('fs.writeText', { path: p, text: text }); }
    },
    clipboard: {
      writeText: function (text) { return call('clipboard.writeText', { text: String(text) }); }
    },
    ui: {
      setTitle: function (title) { return call('ui.setTitle', { title: String(title) }); },
      // 脏状态：true 时窗口标题前加 *，用户点 X / 刷新页面都会被拦一遭
      markDirty: function (dirty) { return call('ui.markDirty', { dirty: !!dirty }); },
      close: function () { return call('ui.close'); }
    }
  };
})(typeof window !== 'undefined' ? window : this);
