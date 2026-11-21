import React, { useEffect } from 'react';
import { useStore, bus, getState, setClipboard, showDialog, openWindow, openPopover, closePopover, extname } from '../store.js';

// 焦点窗口对应的应用菜单
function appMenus(type, w) {
  const A = (action, label, extra = {}) => ({ action, label, ...extra });
  const menus = [];

  if (!type) {
    // 桌面态：没有窗口获得焦点时，菜单栏作用于桌面上的文件
    const st = getState();
    const cb = st.clipboard;
    menus.push({ label: '文件', items: [
      A('newFolder', '新建文件夹'), A('newFile', '新建空白文件'), A('uploadFile', '上传文件…'), A('uploadFolder', '上传文件夹…'), '-',
      A('paste', '粘贴', { disabled: !cb }),
    ] });
    menus.push({ label: '编辑', items: [
      A('copy', '复制'), A('cut', '剪切'), A('paste', '粘贴', { disabled: !cb }), '-',
      { label: cb ? `剪贴板：${cb.mode === 'cut' ? '剪切' : '复制'} ${cb.paths?.length ?? 0} 项` : '剪贴板：空', disabled: true },
      { label: '清空剪贴板', action: '__clearClipboard', disabled: !cb },
      '-', A('selectAll', '全选'), A('rename', '重命名'), '-', A('trash', '移入废纸篓'),
    ] });
    menus.push({ label: '显示', items: [
      A('sort:name', '按名称排列', { checked: st.desktopSort.key === 'name' }),
      A('sort:size', '按大小排列', { checked: st.desktopSort.key === 'size' }),
      A('sort:mtime', '按修改时间排列', { checked: st.desktopSort.key === 'mtime' }),
      A('sort:type', '按类型排列', { checked: st.desktopSort.key === 'type' }),
      '-',
      A('toggleSortDir', st.desktopSort.asc ? '改为降序' : '改为升序'),
      A('dirsFirst', '文件夹优先', { checked: st.desktopSort.dirsFirst }),
      '-',
      A('toggleHidden', '显示隐藏文件', { checked: st.desktopShowHidden }),
      '-', A('refresh', '刷新'),
    ] });
    menus.push({ label: '前往', items: [
      A('goHome', '主目录'),
      ...(st.homeRel ? [A('goRoot', '根目录')] : []),
      A('goTrash', '废纸篓'), '-',
      A('openTerminal', '在终端中打开'),
    ] });
  } else if (type === 'finder') {
    menus.push({ label: '文件', items: [
      A('newFolder', '新建文件夹'), A('newFile', '新建空白文件'), A('uploadFile', '上传文件…'), A('uploadFolder', '上传文件夹…'), '-',
      A('openTerminal', '在终端中打开'), '-', A('closeWin', '关闭窗口'),
    ] });
    // 让内部剪贴板状态可见：用户能据此理解 Ctrl+V 为什么走内部粘贴而非上传
    const cb = getState().clipboard;
    menus.push({ label: '编辑', items: [
      A('copy', '复制'), A('cut', '剪切'), A('paste', '粘贴'), '-',
      { label: cb ? `剪贴板：${cb.mode === 'cut' ? '剪切' : '复制'} ${cb.paths?.length ?? 0} 项` : '剪贴板：空', disabled: true },
      { label: '清空剪贴板', action: '__clearClipboard', disabled: !cb },
      '-', A('selectAll', '全选'), A('rename', '重命名'), '-', A('trash', '移入废纸篓'),
    ] });
    menus.push({ label: '显示', items: [
      A('viewIcon', '图标视图', { checked: w?.props?.view !== 'list' }), A('viewList', '列表视图', { checked: w?.props?.view === 'list' }), '-',
      A('toggleHidden', '显示隐藏文件', { checked: !!w?.props?.showHidden }), '-', A('refresh', '刷新'), A('focus-search', '搜索'),
    ] });
    menus.push({ label: '前往', items: [
      A('goHome', '主目录'),
      // 主目录与根目录重合（homeRel 为空）时不重复显示根目录
      ...(getState().homeRel ? [A('goRoot', '根目录')] : []),
      A('goTrash', '废纸篓'), A('goParent', '上级目录'), '-', A('goFolder', '前往文件夹…'),
    ] });
  } else if (type === 'terminal') {
    menus.push({ label: 'Shell', items: [A('newTab', '新建标签页'), A('closeTab', '关闭当前标签'), '-', A('closeWin', '关闭窗口')] });
    menus.push({ label: '显示', items: [A('clear', '清屏'), A('clear', '重置终端', { arg: 'reset' })] });
  } else if (type === 'editor') {
    const eFmt = w?.props?.fmt || (() => { const e = extname(w?.props?.name || ''); return (e === 'htm' || e === 'xhtml') ? 'html' : e; })();
    // 快捷键提示固定为 Windows 语义（R4：去掉 isMac 判断，不再出现 ⌘S）
    menus.push({ label: '文件', items: [A('save', '保存', { hint: 'Ctrl+S' }), A('saveAs', '另存为…'), '-', A('closeWin', '关闭窗口')] });
    menus.push({ label: '编辑', items: [
      ...(['json', 'html'].includes(eFmt) ? [A('format', '格式化'), '-'] : []),
      A('find', '查找…'),
    ] });
  } else if (type === 'preview') {
    menus.push({ label: '文件', items: [A('download', '下载'), A('edit', '用编辑器打开'), '-', A('closeWin', '关闭窗口')] });
  }
  menus.push({ label: '窗口', items: [
    A('minimize', '最小化'), { label: '最小化全部窗口', action: '__minAll' }, '-', { label: '新建文件窗口', action: '__newFinder' },
  ] });
  menus.push({ label: '帮助', items: [{ label: '关于本系统', action: '__about' }] });
  return menus;
}

// 阶段 1 · T3 起：顶栏右侧的磁盘 / 传输 / 通知 / 账户 / 时钟已迁到任务栏托盘（Taskbar.jsx），
// 这里只剩文件/编辑/显示/前往这组菜单，T4 再与顶栏一起拆掉。
export default function MenuBar() {
  const s = useStore();
  const openKind = s.popover?.kind || null;
  const focusWin = s.windows.find((w) => w.id === s.focusId);
  const menus = appMenus(focusWin?.type, focusWin);

  // 点击菜单栏以外任何位置都收起菜单下拉；托盘弹层由 Taskbar 自己负责，别越权关掉
  useEffect(() => {
    const close = (e) => {
      const kind = getState().popover?.kind;
      if (kind?.startsWith('menu:') && !e.target?.closest?.('.menubar')) closePopover();
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  // 焦点窗口切换后菜单项会变化，旧的下标不再有意义
  useEffect(() => {
    if (getState().popover?.kind?.startsWith('menu:')) closePopover();
  }, [s.focusId]);

  function runItem(item) {
    closePopover();
    if (item.action.startsWith('__')) {
      if (item.action === '__about') showDialog({ kind: 'about' });
      else if (item.action === '__newFinder') openWindow('finder');
      else if (item.action === '__minAll') bus.emit('global-action', { action: 'minimizeAll' });
      else if (item.action === '__clearClipboard') setClipboard(null);
      return;
    }
    // 没有窗口获得焦点 → 动作作用于桌面上的文件
    const fid = getState().focusId;
    if (!fid) bus.emit('desktop-action', { action: item.action, arg: item.arg });
    else bus.emit('win-action', { windowId: fid, action: item.action, arg: item.arg });
  }

  return (
    <div className="menubar">
      <button className="mb-site" onClick={() => showDialog({ kind: 'about' })}>{s.siteName}</button>
      {menus.map((m, i) => {
        const menuKey = `menu:${focusWin?.id || 'desktop'}:${i}`;
        return (
          <div key={m.label} className="mb-menu-wrap">
            <button
              className={`mb-menu-btn${openKind === menuKey ? ' open' : ''}`}
              onClick={(e) => { e.stopPropagation(); openPopover(openKind === menuKey ? null : menuKey); }}
              onMouseEnter={() => openKind?.startsWith('menu:') && openKind !== menuKey && openPopover(menuKey)}
            >{m.label}</button>
            {openKind === menuKey && (
              <div className="dropdown" onClick={(e) => e.stopPropagation()}>
                {m.items.map((item, j) => item === '-'
                  ? <div key={j} className="dropdown-sep" />
                  : (
                    <button key={j} className={`dropdown-item${item.danger ? ' danger' : ''}`} disabled={item.disabled} onClick={() => runItem(item)}>
                      <span className="di-check">{item.checked ? '✓' : ''}</span>
                      {item.label}
                      {item.hint && <span className="di-hint">{item.hint}</span>}
                    </button>
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
