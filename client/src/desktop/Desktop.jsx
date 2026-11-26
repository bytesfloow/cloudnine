import React, { useEffect } from 'react';
import {
  useStore, bus, openWindow, closeWindow, closeContextMenu, closePopover, getState, showDialog, setState, setPlugins,
  minimizeWindow, minimizeAllWindows, toggleShowDesktop, toggleMaxWindow, restoreWindow,
  openAltTab, cycleAltTab, commitAltTab, closeAltTab,
} from '../store.js';
import { api } from '../api.js';
import { installPasteUpload } from '../pasteUpload.js';
import { refreshDisk } from '../App.jsx';
import WindowFrame from './WindowFrame.jsx';
import Taskbar from './Taskbar.jsx';
import ContextMenu from './ContextMenu.jsx';
import DesktopIcons from './DesktopIcons.jsx';
import AltTab from './AltTab.jsx';
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
      // C1：只用 ctrlKey。metaKey 不参与任何快捷键（键位仅支持 Ctrl）。
      const ctrl = e.ctrlKey;
      const alt = e.altKey;
      const key = String(e.key || '');
      const lower = key.toLowerCase();
      // 焦点在按钮 / 链接 / 下拉上时，空格与 Enter 属于控件原生行为，不能抢
      const inControl = !!(t && t.closest?.('button, a[href], select, [role="button"], [role="menuitem"], [role="tab"]'));
      const st = getState();
      const focus = st.windows.find((w) => w.id === st.focusId);
      // 弹层（对话框 / 右键菜单 / 开始菜单 / Alt+Tab）打开时：浏览器保留键照旧拦下，但不执行动作，
      // 其余键完交回弹层自己的键盘处理（方向键 / Enter / Esc）
      const layerOpen = !!(st.dialog || st.contextMenu || st.popover || st.altTab);
      // 焦点窗口优先，没有焦点窗口时落到桌面（两边的动作名保持一致）
      const dispatch = (action) => {
        if (focus) bus.emit('win-action', { windowId: focus.id, action });
        else bus.emit('desktop-action', { action });
      };
      const winOnly = (action) => { if (focus) bus.emit('win-action', { windowId: focus.id, action }); };

      // ---------- Alt+Tab 窗口切换器（docs §5.1 / §5.3 状态表）----------
      // 「按住 Alt 连续 Tab 循环、松开切到当前项、Esc 取消」的按键入口在捕获阶段
      // （见下面的 altTabKey effect）；这里只负责打开状态下的取消。
      // ⚠️ Windows 桌面上 Alt+Tab 会被操作系统先截走，浏览器根本收不到这个组合键；
      // 能收到它的场景（远程桌面 / 内嵌 WebView / 自定义按键映射）一律生效，
      // 收不到时任务栏窗口按钮仍是最稳的入口。
      if (st.altTab) {
        if (key === 'Escape') { e.preventDefault(); return closeAltTab(); }
        if (key === 'Alt') { e.preventDefault(); return; }
      }

      if (key === 'Escape') {
        if (st.contextMenu) return closeContextMenu();
        if (st.popover) return closePopover();
        return;
      }

      // ---------- Win 键（metaKey）----------
      // Win+D 显示桌面（双向）/ Win+↑ 最大化 / Win+↓ 还原否则最小化。
      // 同 Alt+Tab：这几个组合在浏览器里通常被操作系统先吃掉（Win+D 会直接最小化整个桌面），
      // 页面收不到时同样有任务栏入口兜底（任务栏右端「显示桌面」条 / 窗口按钮 / 标题栏按钮）。
      if (e.metaKey && !ctrl && !alt && !e.shiftKey) {
        if (lower === 'd') { e.preventDefault(); if (!layerOpen) toggleShowDesktop(); return; }
        if (key === 'ArrowUp') { e.preventDefault(); if (focus && !layerOpen) toggleMaxWindow(focus.id); return; }
        if (key === 'ArrowDown') {
          e.preventDefault();
          if (!focus || layerOpen) return;
          if (focus.rect.max || focus.snap) restoreWindow(focus.id);
          else minimizeWindow(focus.id);
          return;
        }
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
    // Alt 松开 = 切到当前选中项（Alt+Tab 的提交动作）；窗口失焦（真被 OS 抢走）按取消处理
    const onKeyUp = (e) => { if (e.key === 'Alt' && getState().altTab) commitAltTab(); };
    const onBlur = () => { if (getState().altTab) closeAltTab(); };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
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

  // 已安装插件：登录后拉一次，把 onDesktop / inStartMenu 交给外壳变成桌面图标与菜单项。
  // 失败（401 / 网络错）一律按「无插件」处理：插件拉不到不能挡住桌面启动。
  useEffect(() => {
    let alive = true;
    api.plugins()
      .then((r) => { if (alive) setPlugins(Array.isArray(r?.plugins) ? r.plugins : []); })
      .catch(() => { if (alive) setPlugins([]); });
    return () => { alive = false; };
  }, []);

  // Alt+Tab 必须在捕获阶段接：焦点在 xterm / 输入框时，元素级 keydown 会把 Tab 吃掉。
  // 只拦这一个组合，不影响其它键的优先级（终端 Ctrl+W 仍由它自己的捕获监听先处理）。
  useEffect(() => {
    const onAltTab = (e) => {
      if (e.key !== 'Tab' || !e.altKey) return;
      const st = getState();
      e.preventDefault();
      e.stopPropagation();
      if (!st.altTab) {
        if (st.dialog || st.contextMenu) return;
        openAltTab();
      } else {
        cycleAltTab(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onAltTab, true);
    return () => window.removeEventListener('keydown', onAltTab, true);
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
      {s.altTab && <AltTab />}
      {s.contextMenu && <ContextMenu key={s.contextMenu.id} />}
    </div>
  );
}
