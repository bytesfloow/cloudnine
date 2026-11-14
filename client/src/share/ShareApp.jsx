import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { fmtSize, fmtTime, fileCat } from '../store.js';

// 分享访问页：独立轻量页面，不加载桌面环境（F-07）
// 分享只发单个普通文件，所以这里只有「预览 + 下载」，没有文件夹浏览 / 打包下载 / 上传。
export default function ShareApp() {
  const token = location.pathname.split('/').pop();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(''); // {message, code}
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState(sessionStorage.getItem(`share-pw-${token}`) || '');
  const [text, setText] = useState(null);

  const headers = () => (password ? { 'x-share-password': password } : {});

  useEffect(() => {
    fetch(`/api/share/${token}/meta`, { headers: headers() })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (r.status === 401 && d.code === 'need_password') { setNeedPassword(true); return; }
          setError({ message: d.error || '链接无效', code: d.code });
          return;
        }
        setMeta(d);
        sessionStorage.setItem(`share-pw-${token}`, password);
      })
      .catch(() => setError({ message: '网络错误' }));
  }, [token, password]);

  useEffect(() => {
    if (!meta) return;
    const cat = fileCat(meta.name, 'file');
    if (['text', 'code', 'csv'].includes(cat) && meta.size < 512 * 1024) {
      fetch(`/api/share/${token}/file?inline=1`, { headers: headers() })
        .then((r) => r.text())
        .then((t) => setText(t))
        .catch(() => {});
    }
  }, [meta, token, password]);

  async function submitPassword(e) {
    e.preventDefault();
    setError('');
    const r = await fetch(`/api/share/${token}/meta`, { headers: { 'x-share-password': password } });
    if (r.ok) { setNeedPassword(false); setPassword(password); }
    else setError({ message: '密码错误' });
  }

  if (needPassword) {
    return (
      <div className="share-page">
        <div className="share-card">
          <div className="share-icon">🔒</div>
          <h2>此分享受密码保护</h2>
          <form onSubmit={submitPassword} className="share-pw-form">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入访问密码" autoFocus />
            {error?.message && <p className="auth-err">{error.message}</p>}
            <button className="btn btn-primary" disabled={!password}>查看内容</button>
          </form>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="share-page">
        <div className="share-card">
          <div className="share-icon">🚫</div>
          <h2>{error.message}</h2>
          <p className="share-sub">
            {error.code === 'expired' ? '该链接已超过有效期'
              : error.code === 'max_downloads' ? '该链接已达下载次数上限'
                : error.code === 'share_gone' ? '该分享的文件已被删除或移动'
                  : error.code === 'not_found' ? '链接不存在或已被取消' : ''}
          </p>
        </div>
      </div>
    );
  }

  if (!meta) return <div className="share-page"><div className="boot-spinner" /></div>;

  const cat = fileCat(meta.name, 'file');

  return (
    <div className="share-page">
      <div className="share-card wide">
        <div className="share-head">
          <div className="share-icon">📄</div>
          <div>
            <h2 className="ellipsis">{meta.name}</h2>
            <p className="share-sub">
              {fmtSize(meta.size)}
              {meta.note ? ` · ${meta.note}` : ''}
              {meta.expiresAt ? ` · 有效期至 ${fmtTime(meta.expiresAt)}` : ' · 永久有效'}
            </p>
          </div>
        </div>

        <div className="share-preview">
          {cat === 'image' && <img src={`/api/share/${token}/file?inline=1`} alt={meta.name} />}
          {cat === 'video' && <video src={`/api/share/${token}/file?inline=1`} controls />}
          {cat === 'audio' && <audio src={`/api/share/${token}/file?inline=1`} controls />}
          {cat === 'pdf' && <iframe src={`/api/share/${token}/file?inline=1`} title={meta.name} />}
          {['text', 'code', 'csv'].includes(cat) && text != null && <pre className="preview-pre mono">{text.slice(0, 200 * 1024)}</pre>}
          {!['image', 'video', 'audio', 'pdf', 'text', 'code', 'csv'].includes(cat) && (
            <p className="empty-hint">该文件类型不支持在线预览，请下载查看</p>
          )}
        </div>

        {meta.allowDownload ? (
          <a className="btn btn-primary" href={`/api/share/${token}/file`} download>下载文件（{fmtSize(meta.size)}）</a>
        ) : (
          <p className="share-sub">此分享仅支持在线预览，未开放下载</p>
        )}
      </div>
      <p className="share-footer">该页面由自托管云桌面 CloudNine 提供 · 不代表任何商业服务</p>
    </div>
  );
}

// 分享页独立于桌面应用：自行应用主题
(() => {
  const saved = localStorage.getItem('cloudnine-theme') || 'auto';
  const resolved = saved === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : saved;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();

createRoot(document.getElementById('share-root')).render(<ShareApp />);
