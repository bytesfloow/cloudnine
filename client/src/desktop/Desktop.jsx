import React, { useEffect } from 'react';
import { useStore, bus, openWindow, closeWindow, focusWindow, closeContextMenu, openQuickLook, getState, minimizeWindow, showDialog } from '../store.js';
import { installPasteUpload } from '../pasteUpload.js';
import WindowFrame from './WindowFrame.jsx';
import MenuBar from './MenuBar.jsx';
import Dock from './Dock.jsx';
import ContextMenu from './ContextMenu.jsx';
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

      // 焦点在桌面（无窗口获得焦点）：走桌面级快捷键
      if (!focus) {
        if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); bus.emit('desktop-action', { action: 'selectAll' }); }
        else if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); bus.emit('desktop-action', { action: 'copy' }); }
        else if (meta && e.key.toLowerCase() === 'x') { e.preventDefault(); bus.emit('desktop-action', { action: 'cut' }); }
        else if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); bus.emit('desktop-action', { action: 'newFolder' }); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); bus.emit('desktop-action', { action: 'trash' }); }
        else if (e.key === 'F2') { e.preventDefault(); bus.emit('desktop-action', { action: 'rename' }); }
        else if (e.key === ' ') { e.preventDefault(); bus.emit('desktop-action', { action: 'quickLook' }); }
        return;
      }

      if (meta && e.key.toLowerCase() === 'w' && focus) { e.preventDefault(); closeWindow(focus.id); }
      else if (meta && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); openWindow('finder'); }
      else if (meta && e.key.toLowerCase() === 'm' && focus) { e.preventDefault(); minimizeWindow(focus.id); }
      else if (meta && e.key.toLowerCase() === 'a' && focus.type === 'finder') { e.preventDefault(); bus.emit('win-action', { windowId: focus.id, action: 'selectAll' }); }
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

  // Ctrl+V 粘贴系统剪贴板文件到当前文件夹（仅桌面端；移动端/分享页不安装）
  useEffect(() => installPasteUpload(), []);

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
      {s.windows.map((w) => (
        <WindowFrame key={w.id} win={w} focused={s.focusId === w.id}>
          {renderWindow(w)}
        </WindowFrame>
      ))}
      <Dock />
      {s.contextMenu && <ContextMenu />}
      {s.quickLook && <QuickLook />}
    </div>
  );
}
