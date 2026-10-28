import React, { useEffect, useState, Suspense, lazy } from 'react';
import { api, AuthError } from './api.js';
import { useStore, setState, applyTheme, notify } from './store.js';
import InitWizard from './auth/InitWizard.jsx';
import Login from './auth/Login.jsx';
import Desktop from './desktop/Desktop.jsx';

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

  if (!s.initialized) return <InitWizard />;
  if (!s.user) return <Login />;

  return (
    <Suspense fallback={<div className="boot-screen"><div className="boot-spinner" /></div>}>
      {isMobile ? <MobileApp /> : <Desktop />}
    </Suspense>
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
