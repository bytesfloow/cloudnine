import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, setWindowTitle, closeWindow, notify, bus, basename, extname, markWindowDirty, isWindowDirty } from '../store.js';
import { api } from '../api.js';
import { IconRefresh, IconPlugin } from '../icons.jsx';

/* ============================================================================
   插件宿主窗口（PluginHost）
   ----------------------------------------------------------------------------
   插件跑在 <iframe sandbox="allow-scripts allow-forms"> 里：没有 allow-same-origin
   就没有同源 —— 读不到宿主的 cookie / DOM，也不能直接调宿主接口，只能 postMessage。

   协议（sdk/v1/cloudnine.js 对端）：
     host → iframe  {type:'cn:init', v:1, pluginId, theme, locale, file}
     iframe → host  {type:'cn:ready'}
     iframe → host  {type:'cn:call', id, method, params}
     host → iframe  {type:'cn:result', id, ok, value|error}
     host → iframe  {type:'cn:theme', theme}（主题切换时增量下发）

   文件关联（props.fileRel → cn:init 里的 file: {rel,name,ext}）：
     插件窗口有两种来源：应用图标（file 为 null）与文件关联 / 打开方式（带 fileRel）。
     后者不把内容塞进消息里，只告诉插件“哪个文件”——插件用 fs.readText(file.rel) 自己读，
     因为内容可能很大，而且写回必须走 fs.writeText 才能拿到“外部已修改”这类校验。

   安全边界：
     - 只接受 event.source === iframe.contentWindow 且 event.origin === 'null'
       的消息（沙箱 iframe 是 opaque origin，origin 一律是字符串 'null'）；
       其它窗口 / 宿主自己页面发来的一律丢弃。
     - 每个 method 都校验参数 + 权限声明（permissions），没有权限回 PERMISSION_DENIED。
     - 单次调用 8 秒超时（SDK 侧也有，这里兜服务端卡住的场景）。
   ========================================================================== */

const CALL_TIMEOUT = 8000;
// iframe 加载后 10 秒还没 cn:ready：认定插件页面没接 SDK / 脚本挂了，给「重新加载」面板
const READY_TIMEOUT = 10000;

// 主题注入兜底名单：正常走「扫描样式表里的 --* 变量」，扫描拿不到时退回这一组
const THEME_FALLBACK_VARS = [
  '--bg', '--text', '--text-2', '--win-bg', '--win-border', '--panel-bg', '--sidebar-bg',
  '--hover', '--active', '--line', '--menu-bg', '--input-bg', '--accent', '--accent-text',
  '--accent-hover', '--accent-active', '--accent-soft', '--accent-soft-solid', '--on-accent',
  '--danger', '--danger-soft', '--ok', '--warn', '--radius-win', '--radius-menu', '--radius-ctl',
  '--font', '--mono',
];

let themeVarNames = null;

// 从样式表里收集所有自定义属性名（--foo），只收集一次；换主题时值是重新计算的
function collectThemeVarNames() {
  const names = new Set();
  const walk = (rules) => {
    for (const rule of rules || []) {
      if (rule.style && typeof rule.style.length === 'number') {
        for (let i = 0; i < rule.style.length; i++) {
          const n = rule.style[i];
          if (typeof n === 'string' && n.startsWith('--')) names.add(n);
        }
      }
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* 跨源样式表读不到规则：跳过 */ }
  }
  return names.size ? [...names] : THEME_FALLBACK_VARS.slice();
}

/**
 * 主题色值表：逐个从 :root 的**实际计算值**取值。
 * 插件拿到的是当前亮 / 暗主题下的真实色（含 rgba、字体栈、圆角），
 * 不是宿主 CSS 源码里的静态声明。
 */
export function readThemeVars() {
  if (!themeVarNames) themeVarNames = collectThemeVarNames();
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const name of themeVarNames) {
    const v = cs.getPropertyValue(name);
    if (v && v.trim()) out[name] = v.trim();
  }
  return out;
}

// 协议错误：只有宿主自己判定的错误才带 code，其余异常统一回 FAILED
class CallError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.isProtocol = true;
  }
}

function withTimeout(promise, ms = CALL_TIMEOUT) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CallError('TIMEOUT', `调用超时（${ms} 毫秒）`)), ms);
    }),
  ]);
}

// 相对路径校验：必须是字符串、不含 ..、不是绝对路径（CloudNine 的 fs 接口以 FILE_ROOT 为根，'' = 根目录）
function checkRelPath(v, field = 'path') {
  if (typeof v !== 'string') throw new CallError('INVALID_ARGUMENT', `${field} 必须是字符串`);
  if (v.length > 4096) throw new CallError('INVALID_ARGUMENT', `${field} 过长`);
  if (v.split(/[\\/]/).some((seg) => seg === '..')) throw new CallError('INVALID_ARGUMENT', `${field} 不能包含 .. 路径段`);
  if (v.startsWith('/') || v.startsWith('\\') || /^[a-zA-Z]:/.test(v)) throw new CallError('INVALID_ARGUMENT', `${field} 必须是相对路径`);
  return v;
}

function checkText(v, field, max = 1024 * 1024) {
  if (typeof v !== 'string') throw new CallError('INVALID_ARGUMENT', `${field} 必须是字符串`);
  if (v.length > max) throw new CallError('INVALID_ARGUMENT', `${field} 过长`);
  return v;
}

// 文件关联的入参：props.fileRel（相对 FILE_ROOT 的路径，与 fs.* 接口同一口径）
// → cn:init 里的 file 对象，三种字段都只做展示/分流，读写一律用 rel
function filePayloadOf(fileRel) {
  if (typeof fileRel !== 'string' || !fileRel) return null;
  const name = basename(fileRel);
  const ext = extname(name);
  return { rel: fileRel, name, ext: ext ? `.${ext}` : '' };
}

export default function PluginWindow({ win }) {
  const s = useStore();
  const pluginId = win.props?.pluginId || '';
  const fileRel = win.props?.fileRel || '';
  const file = filePayloadOf(fileRel);
  const plugin = (s.plugins || []).find((p) => p.id === pluginId) || null;
  const entryUrl = plugin?.entryUrl || '';
  const perms = plugin?.permissions || [];

  const frameRef = useRef(null);
  const readyTimer = useRef(null);
  const [nonce, setNonce] = useState(0);   // 「重新加载」= 换 key 重建 iframe
  const [failed, setFailed] = useState('');

  const clearReadyTimer = () => { if (readyTimer.current) { clearTimeout(readyTimer.current); readyTimer.current = null; } };

  // iframe 加载后 10 秒还没 cn:ready → 错误面板（含 load 事件都没来的 404 场景）
  const armReadyTimer = () => {
    clearReadyTimer();
    readyTimer.current = setTimeout(() => {
      readyTimer.current = null;
      setFailed('插件在 10 秒内没有响应（没有收到 cn:ready）。可能是页面没有引入插件 SDK，或入口脚本报错。');
    }, READY_TIMEOUT);
  };

  useEffect(() => clearReadyTimer, []);

  // 窗口消失（被关 / 被卸载）时清掉脏标记：否则 beforeunload 会为一个不存在的窗口拦住刷新
  useEffect(() => () => markWindowDirty(win.id, false), [win.id]);

  // iframe 挂载（首次 / 重新加载）就开始计时：入口 404 时不会触发 load，只能靠它兜底
  useEffect(() => {
    if (failed || !entryUrl) return undefined;
    armReadyTimer();
    return clearReadyTimer;
  }, [nonce, failed, entryUrl]);

  // 插件已被卸载（或窗口比插件列表先恢复）时不留一个空白 iframe
  useEffect(() => {
    if (!pluginId) setFailed('窗口缺少插件标识（props.pluginId）');
    else if (!plugin) setFailed(`插件「${pluginId}」未安装或已被卸载`);
  }, [pluginId, plugin]);

  const send = useCallback((msg) => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    // 沙箱 iframe 是 opaque origin，targetOrigin 只能是 '*'（'null' 不能作为 targetOrigin）
    try { frame.contentWindow.postMessage(msg, '*'); } catch { /* 窗口已销毁：忽略 */ }
  }, []);

  const sendInit = useCallback(() => {
    // file: 有文件关联时是 {rel,name,ext}，从应用图标启动时是 null（旧行为不变）
    send({ type: 'cn:init', v: 1, pluginId, theme: readThemeVars(), locale: 'zh-CN', file });
  }, [pluginId, send, fileRel]);

  // 主题切换：把新的变量表增量推给插件（协议里的可选 cn:theme）
  useEffect(() => bus.on('theme-changed', () => {
    if (!frameRef.current) return;
    send({ type: 'cn:theme', theme: readThemeVars() });
  }), [send]);

  const invoke = useCallback(async (method, params) => {
    const p = params && typeof params === 'object' ? params : {};
    const need = (perm) => {
      if (!perms.includes(perm)) throw new CallError('PERMISSION_DENIED', `插件没有声明 ${perm} 权限`);
    };
    switch (method) {
      case 'storage.get': {
        need('storage');
        return await api.pluginStorage(pluginId);
      }
      case 'storage.set': {
        need('storage');
        if (!('data' in p)) throw new CallError('INVALID_ARGUMENT', 'storage.set 缺少 data');
        return await api.pluginStorageSet(pluginId, p.data);
      }
      case 'fs.list': {
        need('fs.read');
        const rel = checkRelPath(p.path);
        const r = await api.list(rel);
        return { entries: (r.entries || []).map((e) => ({ name: e.name, dir: e.type === 'dir', size: e.size, mtime: e.mtimeMs })) };
      }
      case 'fs.readText': {
        need('fs.read');
        const rel = checkRelPath(p.path);
        const r = await api.read(rel);
        return { text: r.content, encoding: r.encoding, truncated: !!r.truncated };
      }
      case 'fs.writeText': {
        need('fs.write');
        const rel = checkRelPath(p.path);
        const text = checkText(p.text, 'text');
        // force:true —— 插件的写入是一次完整覆盖，不带编辑器的「外部变更」冲突检测
        const r = await api.write({ path: rel, content: text, force: true });
        return { ok: true, size: r.size };
      }
      case 'clipboard.writeText': {
        need('clipboard.write');
        const text = checkText(p.text, 'text', 256 * 1024);
        await navigator.clipboard.writeText(text);
        return { ok: true };
      }
      case 'notify': {
        // 没有 notify 权限：忽略并 warn，不打断插件（文档 §3 的声明式约束）
        if (!perms.includes('notify')) {
          console.warn('[plugin] 忽略通知：插件没有 notify 权限', pluginId, p.title);
          return { ok: false, ignored: true };
        }
        const title = checkText(p.title ?? '', 'title', 200).trim() || plugin?.name || '插件通知';
        const body = checkText(p.body ?? '', 'body', 2000);
        notify({ type: 'info', title, body });
        return { ok: true };
      }
      case 'ui.setTitle': {
        const title = checkText(p.title, 'title', 200).trim();
        if (!title) throw new CallError('INVALID_ARGUMENT', 'title 不能为空');
        setWindowTitle(win.id, title);
        return { ok: true };
      }
      case 'ui.markDirty': {
        if (typeof p.dirty !== 'boolean') throw new CallError('INVALID_ARGUMENT', 'ui.markDirty 的 dirty 必须是布尔值');
        markWindowDirty(win.id, p.dirty);
        return { ok: true, dirty: p.dirty };
      }
      case 'ui.close': {
        // 脏状态不允许插件自己把窗口关掉：数据是用户的，宿主不替它丢；
        // 插件要关就先 markDirty(false)（如已保存），或者让用户点 X 确认
        if (isWindowDirty(win.id)) {
          throw new CallError('UNSAVED_CHANGES', '窗口还有未保存的更改，请先保存并 markDirty(false)');
        }
        closeWindow(win.id);
        return { ok: true };
      }
      default:
        throw new CallError('NOT_SUPPORTED', `不支持的调用：${String(method)}`);
    }
  }, [perms, pluginId, plugin, win.id]);

  // 收消息：source + origin 双校验（沙箱 iframe 的 origin 一定是 'null'）
  useEffect(() => {
    const onMessage = (ev) => {
      const frame = frameRef.current;
      if (!frame || !frame.contentWindow) return;
      if (ev.source !== frame.contentWindow) return;
      if (ev.origin !== 'null') return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;

      if (d.type === 'cn:ready') {
        clearReadyTimer();
        return;
      }
      if (d.type !== 'cn:call') return;

      const id = d.id;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (typeof d.method !== 'string' || !d.method) {
        send({ type: 'cn:result', id, ok: false, error: { code: 'INVALID_ARGUMENT', message: 'method 必须是非空字符串' } });
        return;
      }
      withTimeout(invoke(d.method, d.params)).then(
        (value) => send({ type: 'cn:result', id, ok: true, value }),
        (e) => send({
          type: 'cn:result',
          id,
          ok: false,
          error: {
            code: e?.isProtocol ? e.code : 'FAILED',
            message: e?.message || '调用失败',
          },
        }),
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [invoke, send]);

  const onLoad = () => {
    sendInit();
    armReadyTimer();
  };

  const reload = () => {
    clearReadyTimer();
    setFailed('');
    setNonce((n) => n + 1);
  };

  if (failed) {
    return (
      <div className="plugin-window">
        <div className="plugin-error" role="alert">
          <span className="plugin-error-icon"><IconPlugin size={34} /></span>
          <div className="plugin-error-title">插件无法加载</div>
          <div className="plugin-error-body">{failed}</div>
          <button type="button" className="btn plugin-error-retry" onClick={reload}>
            <IconRefresh size={14} /><span>重新加载</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-window">
      <iframe
        key={nonce}
        ref={frameRef}
        className="plugin-frame"
        // src 用服务端拼好的 entryUrl（带 /pa 签名 token），前端不自己拼
        src={entryUrl}
        title={plugin?.name || '插件'}
        // ⚠️ 绝不能加 allow-same-origin：加上就等于把宿主的 cookie / DOM 交给插件
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        onError={() => setFailed('插件入口页面加载失败（entryUrl 打不开），请检查插件包或重新安装。')}
      />
    </div>
  );
}
