import React, { useEffect, useRef, useState } from 'react';
import {
  useStore, getState, setTheme, openWindow, openPopover, closePopover, openContextMenu,
  activateNotification, toggleWindow, activateOrOpen, focusWindow, minimizeWindow,
  toggleMaxWindow, closeWindow, toggleShowDesktop, fmtSize,
} from '../store.js';
import { addUpload, uploadStats } from '../transfers.js';
import { changePasswordFlow, logoutFlow } from './account.js';
import StartMenu from './StartMenu.jsx';
import { IconFiles, IconTerminal, IconEditor, IconTransfer, IconBell, IconWindows, IconDisk } from '../icons.jsx';

// 固定应用区：图标常驻，单击 = 无窗口则新建 / 有窗口切到最上层 / 已聚焦则最小化
// （docs §1.2；不是旧 Dock 的「每次点击都新建」）
const PINNED = [
  { type: 'finder', label: '文件资源管理器', Icon: IconFiles },
  { type: 'terminal', label: '终端', Icon: IconTerminal },
  { type: 'editor', label: '记事本', Icon: IconEditor },
  { type: 'transfers', label: '传输', Icon: IconTransfer },
];

// 托盘弹层与开始菜单共用 store.popover 这个全局槽位（一次只开一层），
// 但各自的 kind 互不重叠，关闭逻辑才能各扫门前雪。
const TRAY_KINDS = ['disk', 'notifications', 'clock', 'account', 'wins'];

// 窗口按钮的尺寸常量（与 taskbar.css 里的 .tb-win / .tb-more 保持一致）：
// 溢出策略靠它算「能放下几个」，不靠 CSS 裁切 —— 被裁掉等于点不到。
const WIN_GAP = 4;
const WIN_MIN_W = 44;
const MORE_W = 64;

export default function Taskbar() {
  const s = useStore();
  const [now, setNow] = useState(() => new Date());
  const stats = uploadStats();
  const winsRef = useRef(null);
  const [fitCount, setFitCount] = useState(99);

  // 窗口按钮溢出：算得出能放下几个就渲染几个，多出来的折叠进「更多」。
  // 不选横向滚动 —— overflow 会连带裁掉悬停标题浮层；不选裁切 —— 那样会有点不到的按钮。
  // .tb-windows 是 flex:1/min-width:0，宽度由布局分配、不受内容影响，所以测量不会抖动。
  useEffect(() => {
    const el = winsRef.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth - 4; // 左右各 2px padding
      const total = getState().windows.length;
      const cap = Math.max(1, Math.floor((avail + WIN_GAP) / (WIN_MIN_W + WIN_GAP)));
      if (total <= cap) { setFitCount(total); return; }
      const fit = Math.floor((avail - MORE_W - WIN_GAP) / (WIN_MIN_W + WIN_GAP));
      setFitCount(Math.max(1, Math.min(fit, total)));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [s.windows.length]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20 * 1000);
    return () => clearInterval(t);
  }, []);

  // 点击任务栏以外收起托盘弹层；开始菜单由 StartMenu 自己负责关闭
  useEffect(() => {
    const close = (e) => {
      const kind = getState().popover?.kind;
      if (kind && TRAY_KINDS.includes(kind) && !e.target?.closest?.('.taskbar')) closePopover();
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  // 焦点切换后旧的托盘弹层不再有意义（与任务栏托盘的既有行为一致）
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

  // 任务栏空白处右键：显示桌面（双向切换，与 Win+D / 右端细条同一个动作）
  function blankMenu(e) {
    if (e.target.closest?.('button, .tb-popover')) return;
    e.preventDefault();
    const allMin = s.windows.length > 0 && s.windows.every((w) => w.minimized);
    openContextMenu(e.clientX, e.clientY, [
      {
        label: allMin ? '还原所有窗口' : '最小化全部窗口',
        disabled: s.windows.length === 0,
        action: toggleShowDesktop,
      },
    ]);
  }

  // 溢出到「更多」里的窗口
  const shownWins = s.windows.length > fitCount ? s.windows.slice(0, Math.max(1, fitCount)) : s.windows;
  const overflowWins = s.windows.slice(shownWins.length);

  return (
    <div className="taskbar" onContextMenu={blankMenu}>
      {/* 开始按钮：单击开/合开始菜单；菜单与按钮共用 store.popover 的 'start' 槽位 */}
      <button
        type="button"
        className={`tb-start${s.popover?.kind === 'start' ? ' open' : ''}`}
        title="开始"
        aria-label="开始"
        aria-haspopup="dialog"
        aria-expanded={s.popover?.kind === 'start'}
        onClick={(e) => {
          e.stopPropagation();
          openPopover(s.popover?.kind === 'start' ? null : 'start');
        }}
      >
        <IconWindows size={17} />
      </button>
      <StartMenu />

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
      <div className="tb-windows" ref={winsRef}>
        {shownWins.map((w) => (
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
        {overflowWins.length > 0 && (
          <div className="tb-more-wrap">
            <button
              type="button"
              className={`tb-more${s.popover?.kind === 'wins' ? ' open' : ''}`}
              title={`还有 ${overflowWins.length} 个窗口`}
              aria-label={`还有 ${overflowWins.length} 个窗口`}
              aria-expanded={s.popover?.kind === 'wins'}
              data-count={overflowWins.length}
              onClick={(e) => { e.stopPropagation(); openPopover(s.popover?.kind === 'wins' ? null : 'wins'); }}
            >
              更多 <span className="tb-more-count">{overflowWins.length}</span>
            </button>
            {s.popover?.kind === 'wins' && (
              <div className="tb-popover win-more" onClick={(e) => e.stopPropagation()}>
                <div className="popover-header">其他窗口</div>
                {overflowWins.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className={`dropdown-item win-more-item${w.id === s.focusId && !w.minimized ? ' active' : ''}`}
                    onClick={() => { closePopover(); toggleWindow(w.id); }}
                  >
                    <span className={`win-more-dot${w.minimized ? ' minimized' : ''}`} />
                    <span className="win-more-title">{w.title}</span>
                    <span className="win-more-state">{w.rect.max ? '最大化' : w.snap ? '半屏' : w.minimized ? '已最小化' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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

      {/* 任务栏右端「显示桌面」细条：单击切换全部最小化 / 还原（Win11 同款，docs §5.3 ⑤） */}
      <button
        type="button"
        className="tb-showdesk"
        title="显示桌面（Win+D）"
        aria-label="显示桌面"
        onClick={toggleShowDesktop}
      />
    </div>
  );
}

// 托盘弹层：统一从任务栏向上弹（样式复用内容类，位置单独写）
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
      button={<span className={`disk-indicator di-${level}`}><IconDisk size={14} /> {worst.usePct}%</span>}
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
