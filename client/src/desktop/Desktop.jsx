import React, { useEffect } from 'react';
import { useStore, bus, openWindow, closeWindow, focusWindow, closeContextMenu, closePopover, openQuickLook, getState, minimizeWindow, showDialog, minimizeAllWindows } from '../store.js';
import { installPasteUpload } from '../pasteUpload.js';
import { refreshDisk } from '../App.jsx';
import WindowFrame from './WindowFrame.jsx';
import Taskbar from './Taskbar.jsx';
import ContextMenu from './ContextMenu.jsx';
import QuickLook from './QuickLook.jsx';
import DesktopIcons from './DesktopIcons.jsx';
import { renderWindow } from '../windows/registry.jsx';

export default function Desktop() {
  const s = useStore();

  // 全局键盘快捷键。R14：只挂在桌面壳内（本组件随登录后挂载），
  // 不要抽到 App.jsx —— 那会污染登录页 / 初始化向导 / 分享页。
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const inEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.xterm'));
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const focus = getState().windows.find((w) => w.id === getState().focusId);
      // R15：Ctrl+W / Ctrl+N 是浏览器保留键，必须赶在 inEditable 判断之前拦下。
      // 否则在编辑器 / 搜索框里按 Ctrl+W 会直接关掉整个浏览器标签页。
      if (meta && !e.altKey && !e.shiftKey && key === 'w') {
        e.preventDefault();
        if (focus) closeWindow(focus.id);
        return;
      }
      if (meta && !e.altKey && !e.shiftKey && key === 'n' && focus) {
        e.preventDefault();
        openWindow('finder');
        return;
      }
      if (e.key === 'Escape') {
        const st = getState();
        if (st.contextMenu) return closeContextMenu();
        if (st.popover) return closePopover();
        return;
      }
      if (inEditable) return;

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

      if (meta && e.key.toLowerCase() === 'm' && focus) { e.preventDefault(); minimizeWindow(focus.id); }
      else if (meta && e.key.toLowerCase() === 'a' && focus.type === 'finder') { e.preventDefault(); bus.emit('win-action', { windowId: focus.id, action: 'selectAll' }); }
      else if (meta && !e.shiftKey && e.key.toLowerCase() === 'c' && focus.type === 'finder') { e.preventDefault(); bus.emit('win-action', { windowId: focus.id, action: 'copy' }); }
      else if (meta && !e.shiftKey && e.key.toLowerCase() === 'x' && focus.type === 'finder') { e.preventDefault(); bus.emit('win-action', { windowId: focus.id, action: 'cut' }); }
      else if (e.key === ' ' && focus?.type === 'finder') {
        const sel = getState().finderSel[focus.id] || [];
        if (sel.length) { e.preventDefault(); openQuickLook(sel, 0); }
      } else if (meta && e.key.toLowerCase() === 'f' && focus) {
        // 不拦的话浏览器会同时弹出自己的查找框，把刚聚焦的搜索框抢走（R15）
        e.preventDefault();
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

  // R1：磁盘占比原先只在顶栏挂载时拉一次，顶栏一拆就再没人调。
  // 这里放在登录后常驻的桌面壳里，并真的每 20s 轮询（托盘百分比才会动）。
  useEffect(() => {
    refreshDisk();
    const t = setInterval(refreshDisk, 20 * 1000);
    return () => clearInterval(t);
  }, []);

  // 窗口通用动作（各窗口组件自行处理专属动作）
  useEffect(() => bus.on('win-action', ({ windowId, action }) => {
    if (action === 'minimize') minimizeWindow(windowId);
    else if (action === 'closeWin') closeWindow(windowId);
  }), []);

  // 外壳全局动作：开始菜单 / 任务栏托盘 / 窗口内菜单共用
  useEffect(() => bus.on('global-action', ({ action }) => {
    if (action === 'about') showDialog({ kind: 'about' });
    else if (action === 'newFinder') openWindow('finder');
    else if (action === 'newTerminal') openWindow('terminal');
    else if (action === 'newEditor') openWindow('editor');
    else if (action === 'transfers') openWindow('transfers');
    else if (action === 'shares') openWindow('shares');
    else if (action === 'disk') openWindow('disk');
    else if (action === 'minimizeAll') minimizeAllWindows();
  }), []);

  return (
    <div className="desktop"
      onContextMenu={(e) => e.preventDefault()}
    >
      <DesktopIcons />
      {s.windows.map((w) => (
        <WindowFrame key={w.id} win={w} focused={s.focusId === w.id}>
          {renderWindow(w)}
        </WindowFrame>
      ))}
      <Taskbar />
      {s.contextMenu && <ContextMenu key={s.contextMenu.id} />}
      {s.quickLook && <QuickLook />}
    </div>
  );
}
