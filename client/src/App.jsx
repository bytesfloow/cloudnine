import React, { useEffect, useState, Suspense, lazy } from 'react';
import { api, AuthError } from './api.js';
import { useStore, getState, setState, applyTheme, notify } from './store.js';
import InitWizard from './auth/InitWizard.jsx';
import Login from './auth/Login.jsx';
import Desktop from './desktop/Desktop.jsx';
import Dialogs, { Notifications } from './desktop/Dialogs.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

const MobileApp = lazy(() => import('./mobile/MobileApp.jsx'));

export default function App() {
  const s = useStore();
  const [isMobile, setIsMobile] = useState(() => detectMobile());

  useEffect(() => {
    applyTheme(s.theme);
    boot();
    const mq = window.matchMedia('(max-width: 767px), (pointer: coarse) and (max-width: 900px)');
    const onChange = () => setIsMobile(detectMobile());
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  if (!s.booted) return <div className="boot-screen"><div className="boot-spinner" /></div>;

  // 对话框与通知挂最外层：登录页/初始化向导/桌面/移动共用（移动端此前缺失导致弹窗类功能全部失效）
  const body = !s.initialized ? <InitWizard /> : !s.user ? <Login /> : (
    <Suspense fallback={<div className="boot-screen"><div className="boot-spinner" /></div>}>
      {isMobile ? <MobileApp /> : <Desktop />}
    </Suspense>
  );

  return (
    // 整页级错误边界：任何未捕获的渲染异常都不会再变成纯白屏
    <ErrorBoundary label="app" full>
      {body}
      <Notifications />
      <Dialogs />
    </ErrorBoundary>
  );
}

function detectMobile() {
  return window.matchMedia('(max-width: 767px)').matches
    || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900);
}

async function boot() {
  try {
    const st = await api.state();
    setState({ booted: true, initialized: st.initialized, user: st.user, siteName: st.siteName, version: st.version });
    document.title = st.siteName;
    if (st.user) loadBootData();
  } catch (e) {
    setState({ booted: true });
    if (!(e instanceof AuthError)) notify({ type: 'error', title: '连接失败', body: e.message });
  }
}

export async function loadBootData() {
  try {
    const [trash, home] = await Promise.all([api.trashCount(), api.home()]);
    setState({ trashCount: trash.count, homeRel: home.homeRel });
    refreshDisk();
  } catch { /* 忽略 */ }
}

export async function refreshDisk() {
  try {
    const d = await api.disk();
    setState({ disk: d.mounts });
  } catch { /* 忽略 */ }
}

setInterval(() => {
  if (getState().user) {
    api.trashCount().then((r) => setState({ trashCount: r.count })).catch(() => {});
  }
}, 30 * 1000);
