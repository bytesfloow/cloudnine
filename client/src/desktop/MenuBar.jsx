import React, { useEffect, useState } from 'react';
import { useStore, bus, getState, setState, setTheme, showDialog, confirmDialog, notify, openWindow } from '../store.js';
import { api } from '../api.js';
import { uploadStats } from '../transfers.js';
import { refreshDisk } from '../App.jsx';
import { IconBell, IconChevron, IconGlobe } from '../icons.jsx';
import { fmtSize } from '../store.js';

// 焦点窗口对应的应用菜单
function appMenus(type, w) {
  const A = (action, label, extra = {}) => ({ action, label, ...extra });
  const menus = [];
  const emit = undefined; // 动作统一通过 win-action 事件派发
  const g = (action) => bus.emit('global-action', { action });

  if (type === 'finder') {
    menus.push({ label: '文件', items: [
      A('newFolder', '新建文件夹'), A('newFile', '新建空白文件'), A('uploadFile', '上传文件…'), A('uploadFolder', '上传文件夹…'), '-',
      A('openTerminal', '在终端中打开'), '-', A('closeWin', '关闭窗口'),
    ] });
    menus.push({ label: '编辑', items: [A('copy', '复制'), A('cut', '剪切'), A('paste', '粘贴'), '-', A('selectAll', '全选'), A('rename', '重命名'), '-', A('trash', '移入废纸篓')] });
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
    menus.push({ label: '文件', items: [A('save', '保存'), A('saveAs', '另存为…'), '-', A('closeWin', '关闭窗口')] });
    menus.push({ label: '编辑', items: [A('find', '查找…')] });
  } else if (type === 'preview') {
    menus.push({ label: '文件', items: [A('download', '下载'), A('edit', '用编辑器打开'), '-', A('closeWin', '关闭窗口')] });
  }
  menus.push({ label: '窗口', items: [
    A('minimize', '最小化'), { label: '最小化全部窗口', action: '__minAll' }, '-', { label: '新建访达窗口', action: '__newFinder' },
  ] });
  menus.push({ label: '帮助', items: [{ label: '关于本系统', action: '__about' }] });
  return menus;
}

export default function MenuBar() {
  const s = useStore();
  const [openMenu, setOpenMenu] = useState(null); // index of opened menu
  const [now, setNow] = useState(new Date());
  const focusWin = s.windows.find((w) => w.id === s.focusId);
  const menus = appMenus(focusWin?.type, focusWin);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20 * 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const close = () => setOpenMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  useEffect(() => { refreshDisk(); }, []);

  const stats = uploadStats();

  function runItem(item) {
    setOpenMenu(null);
    if (item.action.startsWith('__')) {
      if (item.action === '__about') showDialog({ kind: 'about' });
      else if (item.action === '__newFinder') openWindow('finder');
      else if (item.action === '__minAll') bus.emit('global-action', { action: 'minimizeAll' });
      return;
    }
    bus.emit('win-action', { windowId: getState().focusId, action: item.action, arg: item.arg });
  }

  return (
    <div className="menubar">
      <button className="mb-site" onClick={() => showDialog({ kind: 'about' })}>{s.siteName}</button>
      {menus.map((m, i) => (
        <div key={m.label} className="mb-menu-wrap">
          <button
            className={`mb-menu-btn${openMenu === i ? ' open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === i ? null : i); }}
            onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
          >{m.label}</button>
          {openMenu === i && (
            <div className="dropdown" onClick={(e) => e.stopPropagation()}>
              {m.items.map((item, j) => item === '-'
                ? <div key={j} className="dropdown-sep" />
                : (
                  <button key={j} className={`dropdown-item${item.danger ? ' danger' : ''}`} disabled={item.disabled} onClick={() => runItem(item)}>
                    <span className="di-check">{item.checked ? '✓' : ''}</span>
                    {item.label}
                  </button>
                ))}
            </div>
          )}
        </div>
      ))}

      <div className="mb-right">
        <DiskIndicator />
        {stats.activeCount > 0 && (
          <button className="mb-status-btn transfer-active" title="传输进行中" onClick={() => bus.emit('global-action', { action: 'transfers' })}>
            <span className="transfer-badge">{stats.activeCount}</span>
          </button>
        )}
        <NotifBell />
        <AccountMenu />
        <span className="mb-clock">{now.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
      </div>
    </div>
  );
}

function DiskIndicator() {
  const s = useStore();
  const mounts = s.disk || [];
  if (!mounts.length) return null;
  const worst = mounts.reduce((a, b) => (b.usePct > a.usePct ? b : a));
  const level = worst.usePct > 95 ? 'danger' : worst.usePct > 85 ? 'warn' : worst.usePct > 70 ? 'notice' : 'ok';
  return (
    <Popover
      wide
      button={<span className={`disk-indicator di-${level}`}>💽 {worst.usePct}%</span>}
    >
      {(close) => (
        <div className="disk-popover">
          {mounts.map((m) => (
            <button key={m.mount} className="disk-row" onClick={() => { close(); openWindow('disk'); }}>
              <span className="disk-path">{m.mount}</span>
              <span className="disk-bar"><i style={{ width: `${m.usePct}%` }} className={m.usePct > 85 ? 'danger' : m.usePct > 70 ? 'warn' : ''} /></span>
              <span className="disk-free">{fmtSize(m.free)} 可用</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function NotifBell() {
  const s = useStore();
  return (
    <Popover button={<span className="bell"><IconBell />{s.notifications.length > 0 && <i className="dot" />}</span>}>
      {(close) => (
        <div className="notif-popover">
          {s.notifications.length === 0 && <div className="popover-empty">暂无通知</div>}
          {s.notifications.slice().reverse().map((n) => (
            <div key={n.id} className={`notif-row n-${n.type}`}>
              <b>{n.title}</b>
              {n.body && <span>{n.body}</span>}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

function AccountMenu() {
  const s = useStore();
  return (
    <Popover wide button={<span className="avatar-btn">{(s.user || '?').slice(0, 1).toUpperCase()}</span>}>
      {(close) => (
        <div className="account-popover">
          <div className="popover-header">{s.user}</div>
          <button className="dropdown-item" onClick={async () => { close(); await changePasswordFlow(); }}>修改密码…</button>
          <div className="dropdown-sep" />
          <button className="dropdown-item" onClick={() => { setTheme('light'); }}><span className="di-check">{s.theme === 'light' ? '✓' : ''}</span>浅色主题</button>
          <button className="dropdown-item" onClick={() => { setTheme('dark'); }}><span className="di-check">{s.theme === 'dark' ? '✓' : ''}</span>深色主题</button>
          <button className="dropdown-item" onClick={() => { setTheme('auto'); }}><span className="di-check">{s.theme === 'auto' ? '✓' : ''}</span>跟随系统</button>
          <div className="dropdown-sep" />
          <button className="dropdown-item danger" onClick={async () => {
            close();
            if (await confirmDialog({ title: '退出登录', message: '确定要退出当前会话吗？' })) {
              await api.logout().catch(() => {});
              setState({ user: null, windows: [], focusId: null });
            }
          }}>退出登录…</button>
        </div>
      )}
    </Popover>
  );
}

export async function changePasswordFlow() {
  const values = await showDialog({
    kind: 'form',
    title: '修改密码',
    fields: [
      { key: 'current', label: '原密码', type: 'password', required: true },
      { key: 'next', label: '新密码（≥8 位，含字母数字）', type: 'password', required: true },
    ],
    okText: '修改',
  });
  if (!values) return;
  try {
    await api.changePassword(values);
    notify({ type: 'success', title: '密码已修改' });
  } catch (e) {
    notify({ type: 'error', title: '修改失败', body: e.message });
  }
}

export function Popover({ button, children, align = 'right', wide = false }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => document.addEventListener('click', close), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', close); };
  }, [open]);
  return (
    <div className="popover-wrap">
      <button className="popover-btn" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{button}</button>
      {open && <div className={`popover ${align}${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
