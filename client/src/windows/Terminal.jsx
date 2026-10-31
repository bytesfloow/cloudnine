import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore, bus, getState, nextId, basename } from '../store.js';

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

function termTheme() {
  return document.documentElement.dataset.theme === 'dark'
    ? { background: 'rgba(20,20,24,0.92)', foreground: '#e8e8ec', cursor: '#5be07f' }
    : { background: 'rgba(252,252,253,0.94)', foreground: '#2b2b30', cursor: '#28a745' };
}

// 单个终端会话视图（桌面窗口与移动端复用）
export function TerminalView({ cwd, actionFilter, className = '', terminalRef }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Cascadia Code', Menlo, Consolas, 'Courier New', monospace",
      theme: termTheme(),
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
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

    // 主题切换跟随
    const unsubTheme = bus.on('theme-changed', () => { term.options.theme = termTheme(); });

    return () => {
      alive = false;
      closedByUser = true;
      unsubAction(); unsubTheme();
      window.removeEventListener('cloudnine-term-input', onExtInput);
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

  useEffect(() => bus.on('win-action', ({ windowId, action }) => {
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
      }
    } else if (action === 'clear' || action === 'reset') {
      bus.emit('term-action', { filter: active, action });
    }
  }), [win.id, tabs, active]);

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
      </div>
      {tabs.map((t) => (
        <div key={t.id} style={{ display: t.id === active ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <TerminalView cwd={win.props.cwd || ''} actionFilter={t.id} />
        </div>
      ))}
    </div>
  );
}
