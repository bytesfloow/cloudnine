import React, { useEffect, useState } from 'react';
import { useStore, resolveDialog, getState, dismissNotification } from '../store.js';
import { api } from '../api.js';

// 通知堆栈（桌面/移动共用）：登录页等早期阶段也需要展示 notify()
export function Notifications() {
  const s = useStore();
  if (!s.notifications.length) return null;
  return (
    <div className="notification-stack">
      {s.notifications.slice(-4).map((n) => (
        <div key={n.id} className={`notification n-${n.type}`} onClick={() => dismissNotification(n.id)}>
          <div className="n-title">{n.title}</div>
          {n.body && <div className="n-body">{n.body}</div>}
        </div>
      ))}
    </div>
  );
}

export default function Dialogs() {
  const s = useStore();
  const dlg = s.dialog;
  if (!dlg) return null;
  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && dlg.kind !== 'confirm3') resolveDialog(null); }}>
      <div className={`dialog${dlg.wide ? ' wide' : ''}`}>
        <h3>{dlg.title}</h3>
        {dlg.message && <p className="dialog-message">{dlg.message}</p>}
        {dlg.kind === 'confirm' && (
          <div className="dialog-actions">
            <button className="btn" onClick={() => resolveDialog(false)} autoFocus>{dlg.cancelText || '取消'}</button>
            <button className={`btn${dlg.danger ? ' btn-danger' : ' btn-primary'}`} onClick={() => resolveDialog(true)}>{dlg.okText || '好'}</button>
          </div>
        )}
        {dlg.kind === 'confirm3' && (
          <div className="dialog-actions three">
            <button className="btn" onClick={() => resolveDialog('cancel')} autoFocus>取消</button>
            <button className="btn btn-danger" onClick={() => resolveDialog('discard')}>不保存</button>
            <button className="btn btn-primary" onClick={() => resolveDialog('save')}>保存</button>
          </div>
        )}
        {dlg.kind === 'form' && <FormBody dlg={dlg} />}
        {dlg.kind === 'about' && <AboutBody />}
      </div>
    </div>
  );
}

function FormBody({ dlg }) {
  const [values, setValues] = useState(() => {
    const v = {};
    dlg.fields.forEach((f) => { v[f.key] = f.value ?? (f.type === 'checkbox' ? false : ''); });
    return v;
  });
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') resolveDialog(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function submit() {
    for (const f of dlg.fields) {
      if (f.required && !String(values[f.key] ?? '').trim()) {
        setError(`请填写${f.label}`);
        return;
      }
    }
    resolveDialog(values);
  }

  return (
    <>
      <div className="form-fields">
        {dlg.fields.map((f) => (
          <label key={f.key} className={`field field-${f.type}`}>
            {f.type !== 'checkbox' && <span>{f.label}</span>}
            {f.type === 'select' ? (
              <select value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'checkbox' ? (
              <span className="check-row">
                <input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))} />
                <span>{f.label}</span>
              </span>
            ) : f.type === 'textarea' ? (
              <textarea rows={4} value={values[f.key]} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <input
                type={f.type || 'text'}
                value={values[f.key]}
                placeholder={f.placeholder}
                autoFocus={f.autofocus}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
      </div>
      {error && <p className="auth-err">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" onClick={() => resolveDialog(null)}>取消</button>
        <button className={`btn btn-primary${dlg.danger ? ' btn-danger' : ''}`} onClick={submit}>{dlg.okText || '好'}</button>
      </div>
    </>
  );
}

function AboutBody() {
  const s = useStore();
  const [about, setAbout] = useState(null);
  useEffect(() => { api.about().then(setAbout).catch(() => {}); }, []);
  return (
    <>
      <div className="about-body">
        <div className="about-icon">🖥️</div>
        <h2>{s.siteName}</h2>
        {about && (
          <table className="about-table">
            <tbody>
              <tr><td>版本</td><td>v{about.version}</td></tr>
              <tr><td>服务主机</td><td>{about.hostname}</td></tr>
              <tr><td>运行身份</td><td>{about.runtimeUser}</td></tr>
              <tr><td>系统平台</td><td>{about.platform}</td></tr>
              <tr><td>文件根目录</td><td className="mono">{about.fileRoot}</td></tr>
              <tr><td>废纸篓保留</td><td>{about.trashRetentionDays} 天</td></tr>
            </tbody>
          </table>
        )}
        <p className="about-note">本系统为自托管单用户云桌面，界面风格原创实现，与 Apple 无关。</p>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-primary" onClick={() => resolveDialog(true)} autoFocus>好</button>
      </div>
    </>
  );
}
