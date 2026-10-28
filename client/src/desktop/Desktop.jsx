import React, { useEffect } from 'react';
import { useStore, bus, openWindow, closeWindow, focusWindow, closeContextMenu, openQuickLook, getState, minimizeWindow, showDialog, dismissNotification } from '../store.js';
import { addUpload } from '../transfers.js';
import WindowFrame from './WindowFrame.jsx';
import MenuBar from './MenuBar.jsx';
import Dock from './Dock.jsx';
import ContextMenu from './ContextMenu.jsx';
import Dialogs from './Dialogs.jsx';
import QuickLook from './QuickLook.jsx';
import DesktopIcons from './DesktopIcons.jsx';
import { renderWindow } from '../windows/registry.jsx';

export default function Desktop() {
  const s = useStore();

  // 全局键盘快捷键
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const inEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.xterm'));
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (getState().contextMenu) return closeContextMenu();
        return;
      }
      if (inEditable) return;
      const focus = getState().windows.find((w) => w.id === getState().focusId);
      if (meta && e.key.toLowerCase() === 'w' && focus) { e.preventDefault(); closeWindow(focus.id); }
      else if (meta && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); openWindow('finder'); }
      else if (meta && e.key.toLowerCase() === 'm' && focus) { e.preventDefault(); minimizeWindow(focus.id); }
      else if (e.key === ' ' && focus?.type === 'finder') {
        const sel = getState().finderSel[focus.id] || [];
        if (sel.length) { e.preventDefault(); openQuickLook(sel, 0); }
      } else if (meta && e.key.toLowerCase() === 'f' && focus) {
        bus.emit('win-action', { windowId: focus.id, action: 'focus-search' });
      } else if (meta && e.key.toLowerCase() === 's' && focus?.type === 'editor') {
        e.preventDefault();
        bus.emit('editor-save', { windowId: focus.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 窗口通用动作（各窗口组件自行处理专属动作）
  useEffect(() => bus.on('win-action', ({ windowId, action }) => {
    if (action === 'minimize') minimizeWindow(windowId);
    else if (action === 'closeWin') closeWindow(windowId);
  }), []);

  // 菜单栏触发的全局动作
  useEffect(() => bus.on('global-action', ({ action }) => {
    if (action === 'about') showDialog({ kind: 'about' });
    else if (action === 'newFinder') openWindow('finder');
    else if (action === 'newTerminal') openWindow('terminal');
    else if (action === 'newEditor') openWindow('editor');
    else if (action === 'transfers') openWindow('transfers');
    else if (action === 'shares') openWindow('shares');
    else if (action === 'disk') openWindow('disk');
    else if (action === 'minimizeAll') getState().windows.forEach((w) => bus.emit('win-action', { windowId: w.id, action: 'minimize' }));
  }), []);

  return (
    <div className="desktop"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuBar />
      <DesktopIcons />
      <div className="desktop-dropzone"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={(e) => {
          e.preventDefault();
          const { homeRel } = getState();
          for (const f of e.dataTransfer.files) addUpload(f, homeRel || '');
        }}
      />
      {s.windows.map((w) => (
        <WindowFrame key={w.id} win={w} focused={s.focusId === w.id}>
          {renderWindow(w)}
        </WindowFrame>
      ))}
      <Dock />
      {s.contextMenu && <ContextMenu />}
      <Dialogs />
      {s.quickLook && <QuickLook />}
      <NotificationStack />
    </div>
  );
}

function NotificationStack() {
  const s = useStore();
  if (!s.notifications.length) return null;
  return (
    <div className="notification-stack">
      {s.notifications.slice(-4).map((n) => (
        <div key={n.id} className={`notification n-${n.type}`} onClick={() => dismissNotification(n.id)}>
          <div className="n-title">{n.title}</div>
          {n.body && <div className="n-body">{n.body}</div>}
        </div>
      ))}
    </div>
  );
}
