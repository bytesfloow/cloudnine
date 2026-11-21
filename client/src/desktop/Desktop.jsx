import React, { useEffect } from 'react';
import { useStore, bus, openWindow, closeWindow, closeContextMenu, closePopover, getState, showDialog, minimizeWindow, minimizeAllWindows } from '../store.js';
import { installPasteUpload } from '../pasteUpload.js';
import { refreshDisk } from '../App.jsx';
import WindowFrame from './WindowFrame.jsx';
import Taskbar from './Taskbar.jsx';
import ContextMenu from './ContextMenu.jsx';
import DesktopIcons from './DesktopIcons.jsx';
import { renderWindow } from '../windows/registry.jsx';

export default function Desktop() {
  const s = useStore();

  // 全局键盘快捷键（Win11 语义，见 docs/win11-interaction-spec.md §3.1 / §3.2 / §3.3）。
  // R14：只挂在桌面壳内（本组件随登录后挂载），不要抽到 App.jsx ——
  // 那会污染登录页 / 初始化向导 / 分享页（C13）。
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const inEditable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest?.('.xterm')));
      // C1：只用 ctrlKey。metaKey（⌘）不再参与任何快捷键，Win 上也没有 ⌘ 键。
      const ctrl = e.ctrlKey;
      const alt = e.altKey;
      const key = String(e.key || '');
      const lower = key.toLowerCase();
      // 焦点在按钮 / 链接 / 下拉上时，空格与 Enter 属于控件原生行为，不能抢
      const inControl = !!(t && t.closest?.('button, a[href], select, [role="button"], [role="menuitem"], [role="tab"]'));
      const st = getState();
      const focus = st.windows.find((w) => w.id === st.focusId);
      // 弹层（对话框 / 右键菜单 / 开始菜单）打开时：浏览器保留键照旧拦下，但不执行动作，
      // 其余键完交回弹层自己的键盘处理（方向键 / Enter / Esc）
      const layerOpen = !!(st.dialog || st.contextMenu || st.popover);
      // 焦点窗口优先，没有焦点窗口时落到桌面（两边的动作名保持一致）
      const dispatch = (action) => {
        if (focus) bus.emit('win-action', { windowId: focus.id, action });
        else bus.emit('desktop-action', { action });
      };
      const winOnly = (action) => { if (focus) bus.emit('win-action', { windowId: focus.id, action }); };

      if (key === 'Escape') {
        if (st.contextMenu) return closeContextMenu();
        if (st.popover) return closePopover();
        return;
      }

      // ---------- 浏览器保留键：必须先于 inEditable 判断拦下（R15）----------
      // 否则在输入框里按 Ctrl+W / Ctrl+N 会直接关掉浏览器标签页、弹出新窗口。

      // C7：Ctrl+W 的优先级 —— 焦点在终端标签上时先关标签，否则关当前窗口。
      // （终端自己在捕获阶段先处理并 stopPropagation，这里是不经终端时的兜底）
      if (ctrl && !alt && !e.shiftKey && lower === 'w') {
        e.preventDefault();
        if (layerOpen || !focus) return;
        if (focus.type === 'terminal') winOnly('closeTab');
        else closeWindow(focus.id);
        return;
      }
      // C2 / C3：Ctrl+N 统一为「新建文件资源管理器窗口」，桌面态与窗口态语义一致
      if (ctrl && !alt && !e.shiftKey && lower === 'n') {
        e.preventDefault();
        if (!layerOpen) openWindow('finder', { cwd: st.homeRel || '' });
        return;
      }
      // C2：新建文件夹改 Ctrl+Shift+N（Chrome 里这是无痕窗口，必须 preventDefault）
      if (ctrl && !alt && e.shiftKey && lower === 'n') {
        e.preventDefault();
        if (!layerOpen && !inEditable) dispatch('newFolder');
        return;
      }
      // 记事本里的 Ctrl+F 是编辑器自己的查找，不能被全局「聚焦搜索框」抢走：
      // 输入态只 preventDefault（挡掉浏览器查找栏），动作交给编辑器 / CodeMirror。
      if (ctrl && !alt && !e.shiftKey && lower === 'f') {
        e.preventDefault();
        if (!layerOpen && !inEditable) winOnly(focus?.type === 'editor' ? 'find' : 'focus-search');
        return;
      }
      // Ctrl+L：浏览器定位地址栏，这里改「前往文件夹」（Win11 资源管理器地址栏语义）
      if (ctrl && !alt && !e.shiftKey && lower === 'l') {
        e.preventDefault();
        if (!layerOpen && !inEditable) winOnly('goFolder');
        return;
      }
      // F5：浏览器刷新页面 —— 无论焦点在哪都要拦，只刷新当前视图
      if (key === 'F5') {
        e.preventDefault();
        if (!layerOpen && !inEditable) dispatch('refresh');
        return;
      }
      // F3：聚焦搜索框（浏览器里是「查找下一个」）
      if (key === 'F3') {
        e.preventDefault();
        if (!layerOpen && !inEditable) winOnly('focus-search');
        return;
      }
      // Alt+← / → / ↑：浏览器的前进后退也要挡掉；这里映射到文件窗口的目录历史
      if (alt && !ctrl && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp')) {
        e.preventDefault();
        if (layerOpen || inEditable) return;
        if (key === 'ArrowLeft') winOnly('goBack');
        else if (key === 'ArrowRight') winOnly('goForward');
        else winOnly('goParent');
        return;
      }
      // Alt+Enter：属性（Windows 的「Alt+Enter 打开属性」）
      if (alt && !ctrl && key === 'Enter') {
        e.preventDefault();
        if (!layerOpen && !inEditable) winOnly('showInfo');
        return;
      }

      // 弹层打开 / 输入框、编辑器、终端输入态：其余快捷键一律不命中（保留原有保护）
      if (layerOpen || inEditable) return;

      // 焦点在桌面（无窗口获得焦点）：桌面级快捷键
      if (!focus) {
        // C5：空格不再是预览，改为切换当前选中项（Win11 资源管理器行为）
        if (key === ' ' && !inControl) { e.preventDefault(); return bus.emit('desktop-action', { action: 'toggleSel' }); }
        // C4：只有 Delete 删除；Backspace 是后退（桌面没有历史，直接吞掉，别让浏览器后退）
        if (key === 'Delete') { e.preventDefault(); return bus.emit('desktop-action', { action: 'trash' }); }
        if (key === 'Backspace') { e.preventDefault(); return; }
        if (key === 'F2') { e.preventDefault(); return bus.emit('desktop-action', { action: 'rename' }); }
        if (key === 'Enter' && !inControl) { e.preventDefault(); return bus.emit('desktop-action', { action: 'open' }); }
        if (ctrl && !alt && !e.shiftKey && lower === 'a') { e.preventDefault(); return bus.emit('desktop-action', { action: 'selectAll' }); }
        if (ctrl && !alt && !e.shiftKey && lower === 'c') { e.preventDefault(); return bus.emit('desktop-action', { action: 'copy' }); }
        if (ctrl && !alt && !e.shiftKey && lower === 'x') { e.preventDefault(); return bus.emit('desktop-action', { action: 'cut' }); }
        return;
      }

      // 焦点在窗口：只处理文件资源管理器认识的通用动作；
      // 其它窗口不派发文件动作、也不拦默认行为（预览窗口里 Ctrl+C 仍要能复制选中的文本）。
      // C6：Ctrl+M 已删除（Win11 没有这个快捷键，最小化走任务栏 / Win+↓ 语义）
      if (focus.type !== 'finder') {
        // 唯一例外：Backspace 绝不能让浏览器后退（离开整个应用）
        if (key === 'Backspace') e.preventDefault();
        return;
      }
      if (key === ' ' && !inControl) { e.preventDefault(); return winOnly('toggleSel'); }
      if (key === 'Delete') { e.preventDefault(); return winOnly('trash'); }
      // C4：Backspace = 后退（等价 Alt+←），只有 Delete 才删除
      if (key === 'Backspace') { e.preventDefault(); return winOnly('goBack'); }
      if (key === 'F2') { e.preventDefault(); return winOnly('rename'); }
      if (key === 'Enter' && !inControl) { e.preventDefault(); return winOnly('open'); }
      if (ctrl && !alt && !e.shiftKey && lower === 'a') { e.preventDefault(); return winOnly('selectAll'); }
      if (ctrl && !alt && !e.shiftKey && lower === 'c') { e.preventDefault(); return winOnly('copy'); }
      if (ctrl && !alt && !e.shiftKey && lower === 'x') { e.preventDefault(); return winOnly('cut'); }
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
    </div>
  );
}
