import React, { useState } from 'react';
import { api } from '../api.js';
import { loadBootDataState } from './boot.js';

export default function InitWizard() {
  const [step, setStep] = useState(0);
  const [siteName, setSiteName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const strength = (() => {
    let v = 0;
    if (password.length >= 8) v++;
    if (/[a-zA-Z]/.test(password) && /\d/.test(password)) v++;
    if (password.length >= 12 || /[^a-zA-Z0-9]/.test(password)) v++;
    return v; // 0-3
  })();

  const valid = username.trim().length >= 2 && password.length >= 8 && /[a-zA-Z]/.test(password) && /\d/.test(password) && password === confirm;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.init({ username: username.trim(), password, siteName });
      await loadBootDataState();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        {step === 0 ? (
          <>
            <div className="auth-logo">🖥️</div>
            <h1>欢迎使用</h1>
            <p className="auth-sub">首次使用前，请完成系统初始化。这将创建唯一的账号。</p>
            <label className="field">
              <span>站点名称（可选）</span>
              <input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="我的文件管理系统" />
            </label>
            <button className="btn-primary" onClick={() => setStep(1)}>继续</button>
          </>
        ) : (
          <>
            <div className="auth-logo">👤</div>
            <h1>创建管理员账号</h1>
            <p className="auth-sub">系统仅支持一个账号，创建后不可新增。</p>
            <label className="field">
              <span>用户名</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="2-32 位字母数字" />
            </label>
            <label className="field">
              <span>密码（至少 8 位，含字母与数字）</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </label>
            {password && (
              <div className="strength">
                <i style={{ opacity: strength >= 1 ? 1 : 0.25 }} />
                <i style={{ opacity: strength >= 2 ? 1 : 0.25 }} />
                <i style={{ opacity: strength >= 3 ? 1 : 0.25 }} />
                <span>{['弱', '中', '强'][Math.max(0, strength - 1)] || '弱'}</span>
              </div>
            )}
            <label className="field">
              <span>确认密码</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="再次输入密码" />
            </label>
            {password && confirm && password !== confirm && <p className="auth-err">两次输入的密码不一致</p>}
            {error && <p className="auth-err">{error}</p>}
            <button className="btn-primary" disabled={!valid || busy} onClick={submit}>{busy ? '创建中…' : '创建并进入系统'}</button>
          </>
        )}
      </div>
    </div>
  );
}
