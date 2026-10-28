import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { fmtSize, fmtTime, extname, fileCat } from '../store.js';

// 分享访问页：独立轻量页面，不加载桌面环境（F-07）
export default function ShareApp() {
  const token = location.pathname.split('/').pop();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(''); // {message, code}
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState(sessionStorage.getItem(`share-pw-${token}`) || '');
  const [sub, setSub] = useState('');
  const [entries, setEntries] = useState(null);
  const [text, setText] = useState(null);
  const [uploadMsg, setUploadMsg] = useState('');

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
    if (!meta?.isDir) return;
    setEntries(null);
    fetch(`/api/share/${token}/list?sub=${encodeURIComponent(sub)}`, { headers: headers() })
      .then(async (r) => (r.ok ? (await r.json()).entries : []))
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [meta, sub, token, password]);

  useEffect(() => {
    if (!meta || meta.isDir) return;
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

  async function uploadFile(file) {
    setUploadMsg('上传中…');
    try {
      const r = await fetch(`/api/share/${token}/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', ...headers() },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '上传失败');
      setUploadMsg(`已收到：${d.name}`);
      if (meta?.isDir) {
        fetch(`/api/share/${token}/list?sub=${encodeURIComponent(sub)}`, { headers: headers() })
          .then((r2) => r2.json()).then((d2) => setEntries(d2.entries)).catch(() => {});
      }
    } catch (e) { setUploadMsg(`上传失败：${e.message}`); }
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
          <p className="share-sub">{error.code === 'expired' ? '该链接已超过有效期' : error.code === 'max_downloads' ? '该链接已达下载次数上限' : error.code === 'not_found' ? '链接不存在或已被取消' : ''}</p>
        </div>
      </div>
    );
  }

  if (!meta) return <div className="share-page"><div className="boot-spinner" /></div>;

  const cat = fileCat(meta.name, meta.isDir ? 'dir' : 'file');

  return (
    <div className="share-page">
      <div className="share-card wide">
        <div className="share-head">
          <div className="share-icon">{meta.isDir ? '📁' : '📄'}</div>
          <div>
            <h2 className="ellipsis">{meta.name}</h2>
            <p className="share-sub">
              {meta.isDir ? '文件夹' : fmtSize(meta.size)}
              {meta.note ? ` · ${meta.note}` : ''}
              {meta.expiresAt ? ` · 有效期至 ${fmtTime(meta.expiresAt)}` : ' · 永久有效'}
            </p>
          </div>
        </div>

        {meta.isDir ? (
          <>
            {sub && <button className="btn btn-small" onClick={() => setSub(dirname(sub))}>← 上一级</button>}
            <div className="share-list">
              {(entries || []).map((e) => (
                <div key={e.name} className="m-row">
                  <div className="m-row-info">
                    <span className="m-row-name">{e.type === 'dir' ? '📁' : '📄'} {e.name}</span>
                    <span className="m-row-sub">{e.type === 'dir' ? '' : fmtSize(e.size)}</span>
                  </div>
                  <div className="row-actions">
                    {e.type !== 'dir' && <a className="btn btn-small" href={`/api/share/${token}/file?sub=${encodeURIComponent(joinRel(sub, e.name))}&inline=1`} target="_blank" rel="noreferrer">预览</a>}
                    {meta.allowDownload && e.type !== 'dir' && (
                      <a className="btn btn-small btn-primary" href={`/api/share/${token}/file?sub=${encodeURIComponent(joinRel(sub, e.name))}`} download>下载</a>
                    )}
                    {meta.allowDownload && e.type === 'dir' && (
                      <a className="btn btn-small" href={`/api/share/${token}/zip?sub=${encodeURIComponent(joinRel(sub, e.name))}`}>打包下载</a>
                    )}
                  </div>
                </div>
              ))}
              {entries?.length === 0 && <p className="empty-hint">此文件夹为空</p>}
            </div>
            {meta.allowDownload && (
              <a className="btn btn-primary" href={`/api/share/${token}/zip?sub=${encodeURIComponent(sub)}`}>打包下载整个文件夹</a>
            )}
          </>
        ) : (
          <>
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
          </>
        )}

        {meta.allowUpload && (
          <div className="share-upload">
            <label className="btn">
              上传文件到此目录
              <input type="file" hidden onChange={(e) => e.target.files[0] && uploadFile(e.target.files[0])} />
            </label>
            {uploadMsg && <span className="share-sub">{uploadMsg}</span>}
          </div>
        )}
      </div>
      <p className="share-footer">该页面由自托管文件管理系统提供 · 不代表任何商业服务</p>
    </div>
  );
}

function dirname(p) {
  const parts = String(p).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}
function joinRel(a, b) {
  return [a, b].filter(Boolean).join('/');
}

// 分享页独立于桌面应用：自行应用主题
(() => {
  const saved = localStorage.getItem('wfm-theme') || 'auto';
  const resolved = saved === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : saved;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();

createRoot(document.getElementById('share-root')).render(<ShareApp />);
