import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { loadBootDataState } from './boot.js';

export default function Login() {
  const s = useStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.login({ username: username.trim(), password, remember });
      await loadBootDataState();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card login-card" onSubmit={submit}>
        <div className="auth-avatar">👤</div>
        <h1>{s.siteName}</h1>
        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="用户名" />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>记住我（延长登录有效期）</span>
        </label>
        {error && <p className="auth-err">{error}</p>}
        <button className="btn-primary" disabled={busy || !username || !password}>{busy ? '登录中…' : '登录'}</button>
        {s.version && <p className="auth-version">v{s.version}</p>}
      </form>
    </div>
  );
}
