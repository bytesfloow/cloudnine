import React, { useEffect, useRef, useState } from 'react';

// iOS 风格主屏幕：状态栏 / 应用图标网格 / Dock / Home 指示条（原创图形，不使用 Apple 素材）

// 应用图标白色线条图形（24 viewBox，stroke 继承 currentColor）
const GLYPHS = {
  finder: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.2 7.6a2 2 0 0 1 2-2h3.3l2.1 2.3h8.2a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2V7.6Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M3.4 11h17.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  terminal: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 8l4.2 4L6 16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 16.5H18" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  upload: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 15V5.5M8.2 9L12 5.2 15.8 9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 15.5v2A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  transfers: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.5 5v13M5.4 15L8.5 18.2 11.6 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.5 19V6M12.4 9L15.5 5.8 18.6 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  trash: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6.5 7.5h11l-.9 11a1.8 1.8 0 0 1-1.8 1.6H9.2a1.8 1.8 0 0 1-1.8-1.6l-.9-11Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M4.8 7.5h14.4M10 7V5.4A1.2 1.2 0 0 1 11.2 4h1.6A1.2 1.2 0 0 1 14 5.4V7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M10.2 11v5M13.8 11v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  settings: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9.5" cy="7" r="2" fill="currentColor" />
      <circle cx="15" cy="12" r="2" fill="currentColor" />
      <circle cx="8" cy="17" r="2" fill="currentColor" />
    </svg>
  ),
};

// 供设置页等处复用的单色小图标
export function Glyph({ name, size = 16 }) {
  const draw = GLYPHS[name];
  return draw ? draw(size) : null;
}

// 主屏幕应用清单（dock 中的应用不再重复出现在网格）
export const APP_LIST = [
  { key: 'finder', name: '文件', bg: 'linear-gradient(180deg,#53b0ff,#146ffe)' },
  { key: 'terminal', name: '终端', bg: 'linear-gradient(180deg,#48484c,#17171a)' },
  { key: 'upload', name: '上传', bg: 'linear-gradient(180deg,#ffc94d,#ff9500)' },
  { key: 'transfers', name: '传输', bg: 'linear-gradient(180deg,#41c95f,#1fad3d)' },
  { key: 'trash', name: '废纸篓', bg: 'linear-gradient(180deg,#a9adb6,#7d828c)' },
  { key: 'settings', name: '设置', bg: 'linear-gradient(180deg,#b8bcc6,#878d99)' },
];
const DOCK_KEYS = ['finder', 'terminal', 'upload', 'transfers'];

function AppItem({ app, badge, onOpen, inDock }) {
  return (
    <button className={`m-appitem${inDock ? ' indock' : ''}`} aria-label={app.name} onClick={(e) => onOpen(app.key, e)}>
      <span className="m-appicon" style={{ background: app.bg }}>
        {GLYPHS[app.key](28)}
        {badge > 0 && <span className="m-appbadge">{badge > 99 ? '99+' : badge}</span>}
      </span>
      {!inDock && <span className="m-appname">{app.name}</span>}
    </button>
  );
}

// 主屏幕：上侧应用网格 + 底部 Dock
export function HomeScreen({ onOpen, badges }) {
  const byKey = Object.fromEntries(APP_LIST.map((a) => [a.key, a]));
  const gridApps = APP_LIST.filter((a) => !DOCK_KEYS.includes(a.key));
  return (
    <div className="m-home">
      <div className="m-appgrid">
        {gridApps.map((a) => <AppItem key={a.key} app={a} badge={badges[a.key]} onOpen={onOpen} />)}
      </div>
      <div className="m-dock">
        {DOCK_KEYS.map((k) => <AppItem key={k} app={byKey[k]} badge={badges[k]} onOpen={onOpen} inDock />)}
      </div>
    </div>
  );
}

// 状态栏：仅保留实时时钟（信号/Wi-Fi/电池为系统级信息，不模仿）
function fmtClock() {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function StatusBar() {
  const [now, setNow] = useState(fmtClock);
  useEffect(() => {
    const t = setInterval(() => setNow(fmtClock()), 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="m-statusbar">
      <span className="m-sb-time">{now}</span>
    </div>
  );
}

// Home 指示条：点按或上滑返回桌面
export function HomeIndicator({ onHome }) {
  const startY = useRef(null);
  const swiped = useRef(false);
  return (
    <div
      className="m-homezone"
      onClick={() => { if (!swiped.current) onHome(); swiped.current = false; }}
      onTouchStart={(e) => { startY.current = e.touches[0].clientY; }}
      onTouchMove={(e) => {
        if (startY.current != null && startY.current - e.touches[0].clientY > 32) {
          swiped.current = true;
          startY.current = null;
          onHome();
        }
      }}
      onTouchEnd={() => { startY.current = null; }}
    >
      <div className="m-homebar" />
    </div>
  );
}
