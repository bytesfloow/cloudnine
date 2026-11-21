import React, { useEffect, useState } from 'react';
import {
  useStore, getState, setTheme, openWindow, openPopover, closePopover, openContextMenu,
  activateNotification, toggleWindow, activateOrOpen, focusWindow, minimizeWindow,
  minimizeAllWindows, restoreAllWindows, toggleMaxWindow, closeWindow, fmtSize,
} from '../store.js';
import { addUpload, uploadStats } from '../transfers.js';
import { changePasswordFlow, logoutFlow } from './account.js';
import { IconFiles, IconTerminal, IconEditor, IconTransfer, IconBell, IconWindows } from '../icons.jsx';

// 固定应用区：图标常驻，单击 = 无窗口则新建 / 有窗口切到最上层 / 已聚焦则最小化
// （docs §1.2；不是旧 Dock 的「每次点击都新建」）
const PINNED = [
  { type: 'finder', label: '文件资源管理器', Icon: IconFiles },
  { type: 'terminal', label: '终端', Icon: IconTerminal },
  { type: 'editor', label: '记事本', Icon: IconEditor },
  { type: 'transfers', label: '传输', Icon: IconTransfer },
];

// 托盘弹层与菜单栏下拉共用 store.popover 这个全局槽位（一次只开一层），
// 但各自的 kind 互不重叠，关闭逻辑才能各扫门前雪。
const TRAY_KINDS = ['disk', 'notifications', 'clock', 'account'];

export default function Taskbar() {
  const s = useStore();
  const [now, setNow] = useState(() => new Date());
  const stats = uploadStats();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20 * 1000);
    return () => clearInterval(t);
  }, []);

  // 点击任务栏以外收起托盘弹层；菜单栏那边只负责自己的 menu:* 弹层
  useEffect(() => {
    const close = (e) => {
      const kind = getState().popover?.kind;
      if (kind && TRAY_KINDS.includes(kind) && !e.target?.closest?.('.taskbar')) closePopover();
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  // 焦点切换后旧的托盘弹层不再有意义（与旧顶栏托盘的行为一致）
  useEffect(() => {
    if (TRAY_KINDS.includes(getState().popover?.kind)) closePopover();
  }, [s.focusId]);

  function launch(item) {
    const st = getState();
    // 有可见窗口 → Win11 语义：切到最上层；已聚焦则最小化
    const visible = st.windows
      .filter((w) => w.type === item.type && !w.minimized)
      .sort((a, b) => b.z - a.z)[0];
    if (visible) return toggleWindow(visible.id);
    // 只有最小化窗口 → 还原最上层那个；一个都没有 → 新建
    activateOrOpen(item.type, item.type === 'finder' ? { cwd: st.homeRel || '' } : undefined);
  }

  // 窗口按钮右键 = 跳转列表（Win11 任务栏同款四项）
  function jumpList(w, e) {
    openContextMenu(e.clientX, e.clientY, [
      { label: '还原', disabled: !w.minimized, action: () => focusWindow(w.id) },
      { label: '最小化', disabled: w.minimized, action: () => minimizeWindow(w.id) },
      { label: w.rect.max ? '向下还原' : '最大化', action: () => toggleMaxWindow(w.id) },
      '-',
      { label: '关闭窗口', danger: true, action: () => closeWindow(w.id) },
    ]);
  }

  // 从系统拖文件到「传输」= 上传到主目录（承接 Dock.jsx:29-39 的旧行为）
  function dropUpload(e) {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const { homeRel } = getState();
    files.forEach((f) => addUpload(f, homeRel || ''));
  }

  // 任务栏空白处右键：最小化全部 / 还原所有（Win11「显示桌面」的底线形态）
  function blankMenu(e) {
    if (e.target.closest?.('button, .tb-popover')) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: '最小化全部窗口', disabled: !s.windows.some((w) => !w.minimized), action: minimizeAllWindows },
      { label: '还原所有窗口', disabled: !s.windows.some((w) => w.minimized), action: restoreAllWindows },
    ]);
  }

  return (
    <div className="taskbar" onContextMenu={blankMenu}>
      {/* 开始按钮：位置先留出，阶段 1 · T4 才接开始菜单 */}
      <span className="tb-start" title="开始菜单（阶段 1 · T4 接入）" aria-hidden="true">
        <IconWindows size={17} />
      </span>

      <div className="tb-pinned">
        {PINNED.map(({ type, label, Icon }) => {
          const running = s.windows.some((w) => w.type === type);
          const active = s.windows.some((w) => w.type === type && w.id === s.focusId && !w.minimized);
          return (
            <button
              key={type}
              type="button"
              className={`tb-app${running ? ' running' : ''}${active ? ' active' : ''}`}
              title={label}
              aria-label={label}
              onClick={() => launch({ type })}
              onDragOver={type === 'transfers' ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } : undefined}
              onDrop={type === 'transfers' ? dropUpload : undefined}
            >
              <Icon size={20} />
              {type === 'transfers' && stats.activeCount > 0 && (
                <span className="transfer-badge">{stats.activeCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 每个窗口一个按钮：同类型多开时绝不能按 type 去重（docs §5.3 ④） */}
      <div className="tb-windows">
        {s.windows.map((w) => (
          <div className="tb-win-wrap" key={w.id}>
            <button
              type="button"
              className={`tb-win${w.minimized ? ' minimized' : ''}${s.focusId === w.id && !w.minimized ? ' active' : ''}`}
              aria-label={w.title}
              onClick={() => toggleWindow(w.id)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); jumpList(w, e); }}
            >
              <span className="tb-win-label">{w.title}</span>
            </button>
            <span className="tb-win-tip" aria-hidden="true">{w.title}</span>
          </div>
        ))}
      </div>

      <div className="tb-tray">
        <DiskTray />
        <button
          type="button"
          className="tray-btn tray-transfers"
          title={stats.activeCount ? `${stats.activeCount} 个传输进行中` : '传输'}
          aria-label="传输"
          onClick={() => openWindow('transfers')}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={dropUpload}
        >
          <IconTransfer size={17} />
          {stats.activeCount > 0 && <span className="transfer-badge">{stats.activeCount}</span>}
        </button>

        <TrayPopover
          kind="notifications"
          className="tray-bell"
          title="通知"
          button={<span className="bell"><IconBell />{s.notifications.length > 0 && <i className="dot" />}</span>}
        >
          {(close) => <NotificationsPanel close={close} />}
        </TrayPopover>

        <TrayPopover
          kind="clock"
          className="tray-clock"
          title="通知中心"
          button={now.toLocaleString('zh-CN', {
            month: 'numeric', day: 'numeric', weekday: 'short',
            hour: '2-digit', minute: '2-digit', hour12: false,
          })}
        >
          {(close) => <NotificationsPanel close={close} />}
        </TrayPopover>

        <TrayPopover
          kind="account"
          className="tray-account"
          wide
          title={s.user || '账户'}
          button={<span className="avatar-btn">{(s.user || '?').slice(0, 1).toUpperCase()}</span>}
        >
          {() => (
            <div className="account-popover">
              <div className="popover-header">{s.user}</div>
              <button className="dropdown-item" onClick={async () => { closePopover(); await changePasswordFlow(); }}>修改密码…</button>
              <div className="dropdown-sep" />
              <button className="dropdown-item" onClick={() => setTheme('light')}><span className="di-check">{s.theme === 'light' ? '✓' : ''}</span>浅色主题</button>
              <button className="dropdown-item" onClick={() => setTheme('dark')}><span className="di-check">{s.theme === 'dark' ? '✓' : ''}</span>深色主题</button>
              <button className="dropdown-item" onClick={() => setTheme('auto')}><span className="di-check">{s.theme === 'auto' ? '✓' : ''}</span>跟随系统</button>
              <div className="dropdown-sep" />
              <button className="dropdown-item danger" onClick={async () => { closePopover(); await logoutFlow(); }}>退出登录…</button>
            </div>
          )}
        </TrayPopover>
      </div>
    </div>
  );
}

// 托盘弹层：统一从任务栏向上弹（旧顶栏的 Popover 是向下弹的，样式复用内容类，位置单独写）
function TrayPopover({ kind, className = '', title, wide = false, button, children }) {
  const s = useStore();
  const open = s.popover?.kind === kind;
  return (
    <div className="tb-pop-wrap">
      <button
        type="button"
        className={`tray-btn ${className}${open ? ' open' : ''}`}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); openPopover(open ? null : kind); }}
      >
        {button}
      </button>
      {open && (
        <div className={`tb-popover${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
          {children(closePopover)}
        </div>
      )}
    </div>
  );
}

function DiskTray() {
  const s = useStore();
  const mounts = s.disk || [];
  if (!mounts.length) return null;
  const worst = mounts.reduce((a, b) => (b.usePct > a.usePct ? b : a));
  const level = worst.usePct > 95 ? 'danger' : worst.usePct > 85 ? 'warn' : worst.usePct > 70 ? 'notice' : 'ok';
  return (
    <TrayPopover
      kind="disk"
      className="tray-disk"
      wide
      title={`磁盘占用 ${worst.usePct}%（${worst.mount}）`}
      button={<span className={`disk-indicator di-${level}`}>💽 {worst.usePct}%</span>}
    >
      {(close) => (
        <div className="disk-popover">
          {mounts.map((m) => (
            <button key={m.mount} className="disk-row" onClick={() => { close(); openWindow('disk'); }}>
              <span className="disk-path">{m.mount}</span>
              <span className="disk-bar">
                <i style={{ width: `${m.usePct}%` }} className={m.usePct > 85 ? 'danger' : m.usePct > 70 ? 'warn' : ''} />
              </span>
              <span className="disk-free">{fmtSize(m.free)} 可用</span>
            </button>
          ))}
        </div>
      )}
    </TrayPopover>
  );
}

function NotificationsPanel({ close }) {
  const s = useStore();
  return (
    <div className="notif-popover">
      {s.notifications.length === 0 && <div className="popover-empty">暂无通知</div>}
      {s.notifications.slice().reverse().map((n) => (
        <div
          key={n.id}
          className={`notif-row n-${n.type}${n.onClick ? ' n-actionable' : ''}`}
          onClick={n.onClick ? () => { close(); activateNotification(n.id); } : undefined}
        >
          <b>{n.title}</b>
          {n.body && <span>{n.body}</span>}
          {n.actionLabel && <em className="notif-action">{n.actionLabel} ›</em>}
        </div>
      ))}
    </div>
  );
}
