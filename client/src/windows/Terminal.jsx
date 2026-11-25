import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore, bus, getState, nextId, openContextMenu } from '../store.js';
import { IconChevron } from '../icons.jsx';
import WindowMenu from './WindowMenu.jsx';
import { copyTermSelection, pasteFromClipboard, pasteTextToTerm } from './termClipboard.js';

const utf8ToB64 = (s) => btoa(unescape(encodeURIComponent(s)));
// 流式 UTF-8 解码：多字节字符被输出块边界切开时（跨 WebSocket 消息）也能正确解码
const b64ToBytes = (s) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const outDecoder = new TextDecoder('utf-8');
const b64ToUtf8 = (s) => outDecoder.decode(b64ToBytes(s), { stream: true });

// xterm 配色：画布由 xterm 自己绘制，CSS 类量不到，只能把主题令牌读成实色。
// 令牌在 base.css 的亮/暗两块里各有一份（--term-bg / --term-fg / --term-cursor /
// --term-selection），这里不再出现任何色值 —— 改配色只改 CSS，JS 里也扫不到硬编码。
// 选中色也必须显式给：xterm 默认用 rgba(255,255,255,.3)，那是给深色终端设计的，
// 亮色主题下叠在 #ffffff 上等于没高亮（拖拽能选中、但看不见）。
function termTheme() {
  const read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const theme = {};
  const bg = read('--term-bg');
  const fg = read('--term-fg');
  const cursor = read('--term-cursor');
  const selection = read('--term-selection');
  if (bg) theme.background = bg;
  if (fg) theme.foreground = fg;
  if (cursor) theme.cursor = cursor;
  if (selection) {
    theme.selectionBackground = selection;
    // 焦点离开终端（比如右键菜单开着）时 xterm 会换成「非活动选中」色，
    // 默认同样是白 30%；不一起给就会在打开菜单的瞬间丢掉高亮。
    theme.selectionInactiveBackground = selection;
  }
  return theme;
}

// 单个终端会话视图（桌面窗口与移动端复用）
export function TerminalView({ cwd, actionFilter, className = '', terminalRef, contextMenu = true }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      theme: termTheme(),
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const hostEl = hostRef.current; // 副作用清理阶段 ref 可能已置空，dom 节点自己存一份
    term.open(hostEl);
    try { fit.fit(); } catch { /* 隐藏状态时可能失败 */ }
    termRef.current = term;
    if (terminalRef) terminalRef.current = term;

    let alive = true;
    let closedByUser = false;

    function connect() {
      if (!alive) return;
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/term`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (!alive) return;
        ws.send(JSON.stringify({ type: 'start', cwd, cols: term.cols, rows: term.rows }));
        setStatus('connected');
        term.focus();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'out') term.write(b64ToUtf8(msg.data));
        else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[2m[会话已结束${msg.error ? '：' + msg.error : ''}]\x1b[0m\r\n`);
          setStatus('exited');
        }
      };
      ws.onclose = () => { if (alive && !closedByUser) setStatus('disconnected'); };
      ws.onerror = () => setStatus('disconnected');
    }
    connect();

    term.onData((d) => {
      if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'in', data: utf8ToB64(d) }));
    });

    // ---- 剪贴板：Ctrl+Shift+C / Ctrl+Shift+V ----
    // xterm 对「ctrl+shift+字母」本来就不产字节（evaluateKeyboardEvent 的 default 分支在这种
    // 组合下返回空 key），所以在这里接管不会抢走任何终端语义：Ctrl+C 仍是 \x03（SIGINT），
    // Ctrl+V 仍是 \x16（readline 的 quoted-insert）。
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return true;
      const key = String(ev.key).toLowerCase();
      if (key === 'c') {
        ev.preventDefault(); // 否则开着 DevTools 时 Chrome 会抢去当「检查元素」
        copyTermSelection(term);
        return false;
      }
      // Ctrl+Shift+V 不能 preventDefault：非安全上下文里剪贴板内容只能靠浏览器自己派发的
      // paste 事件拿到，默认行为被取消就等于没有粘贴来源（见下面的 onNativePaste）。
      if (key === 'v') return false;
      return true;
    });

    // 原生 paste 事件（Ctrl+Shift+V / Shift+Insert / 系统右键菜单「粘贴」）在捕获阶段截住：
    // 不拦的话 xterm 自带的 paste 处理会把多行内容直接灌进 shell，绕过确认框。
    const onNativePaste = (ev) => {
      if (!ev.clipboardData) return;
      ev.preventDefault();
      ev.stopPropagation();
      pasteTextToTerm(term, ev.clipboardData.getData('text/plain'));
    };
    hostEl.addEventListener('paste', onNativePaste, true);

    // 终端右键 = 复制/粘贴，不弹桌面或浏览器的全局菜单
    const onCtx = (ev) => {
      if (!contextMenu) return; // 移动端把长按留给系统的文本选择菜单
      ev.preventDefault();
      ev.stopPropagation();
      const hasSel = term.hasSelection();
      openContextMenu(ev.clientX, ev.clientY, [
        { label: '复制', hint: 'Ctrl+Shift+C', disabled: !hasSel, action: () => copyTermSelection(term) },
        { label: '粘贴', hint: 'Ctrl+Shift+V', action: () => pasteFromClipboard(term) },
      ]);
    };
    hostEl.addEventListener('contextmenu', onCtx);

    const sendResize = () => {
      if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    term.onResize(sendResize);
    const ro = new ResizeObserver(() => {
      if (hostRef.current && hostRef.current.offsetParent !== null) {
        try { fit.fit(); } catch { /* 忽略 */ }
      }
    });
    ro.observe(hostRef.current);

    const unsubAction = bus.on('term-action', ({ filter, action }) => {
      if (filter !== actionFilter) return;
      if (action === 'clear') term.clear();
      else if (action === 'reset') term.reset();
      else if (action === 'focus') term.focus();
    });

    // 外部输入（移动端快捷键栏）
    const onExtInput = (e) => {
      if (e.detail?.filter !== actionFilter) return;
      if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'in', data: utf8ToB64(e.detail.data) }));
      term.focus();
    };
    window.addEventListener('cloudnine-term-input', onExtInput);

    // 移动端快捷键栏的「粘贴」：没有按键可等，走 pasteFromClipboard 的降级链路
    const onExtPaste = (e) => {
      if (e.detail?.filter !== actionFilter) return;
      pasteFromClipboard(term);
    };
    window.addEventListener('cloudnine-term-paste', onExtPaste);

    // 主题切换跟随
    const unsubTheme = bus.on('theme-changed', () => { term.options.theme = termTheme(); });

    return () => {
      alive = false;
      closedByUser = true;
      unsubAction(); unsubTheme();
      window.removeEventListener('cloudnine-term-input', onExtInput);
      window.removeEventListener('cloudnine-term-paste', onExtPaste);
      hostEl.removeEventListener('paste', onNativePaste, true);
      hostEl.removeEventListener('contextmenu', onCtx);
      ro.disconnect();
      try { wsRef.current?.close(); } catch { /* 忽略 */ }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`terminal-view ${className}`}>
      <div className="term-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
      {status !== 'connected' && (
        <div className="term-status">
          {status === 'connecting' && '正在连接…'}
          {status === 'disconnected' && (
            <>
              连接已断开
              <button className="btn btn-small" onClick={() => location.reload()}>重连</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function TerminalWindow({ win }) {
  const [tabs, setTabs] = useState([{ id: nextId(), label: 'shell' }]);
  const [active, setActive] = useState(tabs[0].id);
  const s = useStore();

  // 标签栏 ∨ 下拉与文件命令栏走同一条 win-action 通道，避免两套平行业务逻辑
  const act = (action, arg) => bus.emit('win-action', { windowId: win.id, action, arg });

  useEffect(() => bus.on('win-action', ({ windowId, action, arg }) => {
    if (windowId !== win.id) return;
    if (action === 'newTab') {
      const t = { id: nextId(), label: `shell ${tabs.length + 1}` };
      setTabs((ts) => [...ts, t]);
      setActive(t.id);
    } else if (action === 'closeTab') {
      if (tabs.length > 1) {
        const rest = tabs.filter((t) => t.id !== active);
        setTabs(rest);
        setActive(rest[rest.length - 1].id);
      } else {
        // Windows Terminal 语义：最后一个标签被关闭 = 关闭窗口（否则这一项是死入口）
        bus.emit('win-action', { windowId: win.id, action: 'closeWin' });
      }
    } else if (action === 'clear') {
      // 终端菜单把「重置终端」表达为 clear + arg:'reset'，这里按 arg 分流
      bus.emit('term-action', { filter: active, action: arg === 'reset' ? 'reset' : 'clear' });
    }
  }), [win.id, tabs, active]);

  // Ctrl+W / Ctrl+Shift+W 关标签，Ctrl+Shift+T 新建标签（捕获阶段：先于 Desktop 的全局关窗逻辑）。
  // C1：只认 ctrlKey；C7：焦点在终端时 Ctrl+W 的优先级是「先关标签」而不是关窗口。
  // stopPropagation 同时挡住 xterm 把 ^W 送给 shell，以及 Desktop 的 Ctrl+W 关窗分支。
  useEffect(() => {
    function onKey(e) {
      if (!e.ctrlKey || e.altKey) return;
      const k = String(e.key).toLowerCase();
      const closeTab = k === 'w';
      const newTab = k === 't' && e.shiftKey;
      if (!closeTab && !newTab) return;
      if (getState().focusId !== win.id) return; // 仅当前焦点窗口响应
      e.preventDefault();
      e.stopPropagation();
      act(newTab ? 'newTab' : 'closeTab');
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id]);

  const tabMenu = [
    { label: '新建标签页', hint: 'Ctrl+Shift+T', action: () => act('newTab') },
    { label: '关闭当前标签', hint: 'Ctrl+W', action: () => act('closeTab') },
    '-',
    { label: '清屏', action: () => act('clear') },
    { label: '重置终端', action: () => act('clear', 'reset') },
    '-',
    { label: '关闭窗口', action: () => act('closeWin') },
  ];

  return (
    <div className="terminal-window">
      <div className="term-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`term-tab${t.id === active ? ' active' : ''}`} onClick={() => setActive(t.id)}>
            <span>{t.label}</span>
            {tabs.length > 1 && (
              <button className="term-tab-close" onClick={(e) => {
                e.stopPropagation();
                const rest = tabs.filter((x) => x.id !== t.id);
                setTabs(rest);
                if (active === t.id) setActive(rest[0].id);
              }}>×</button>
            )}
          </div>
        ))}
        <button className="term-new-tab" title="新建标签页" onClick={() => {
          const t = { id: nextId(), label: `shell ${tabs.length + 1}` };
          setTabs((ts) => [...ts, t]);
          setActive(t.id);
        }}>＋</button>
        <WindowMenu
          className="term-tab-menu"
          icon={<IconChevron dir="down" size={9} />}
          title="标签页菜单"
          items={tabMenu}
        />
      </div>
      {tabs.map((t) => (
        <div key={t.id} style={{ display: t.id === active ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <TerminalView cwd={win.props.cwd || ''} actionFilter={t.id} />
        </div>
      ))}
    </div>
  );
}
