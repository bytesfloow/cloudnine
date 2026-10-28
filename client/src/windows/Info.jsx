import React, { useEffect, useState } from 'react';
import { useStore, setWindowTitle, notify, basename, fmtSize, fmtTime } from '../store.js';
import { api } from '../api.js';
import { FileIcon } from '../icons.jsx';

// 显示简介（Get Info）：属性 + 权限修改
export default function InfoWindow({ win }) {
  const { path } = win.props;
  const [stat, setStat] = useState(null);
  const [error, setError] = useState('');
  const [modeStr, setModeStr] = useState('');
  const [owner, setOwner] = useState({ uid: '', gid: '' });

  useEffect(() => { setWindowTitle(win.id, `简介 — ${basename(path)}`); }, [path, win.id]);
  useEffect(() => {
    api.stat(path).then((s) => {
      setStat(s);
      setModeStr((s.modeStr || '').slice(1));
      setOwner({ uid: s.uid ?? '', gid: s.gid ?? '' });
    }).catch((e) => setError(e.message));
  }, [path]);

  async function applyChmod() {
    try {
      const mode = parseInt(modeStr, 8);
      if (Number.isNaN(mode)) throw new Error('权限格式错误（应为 8 位八进制，如 755）');
      await api.chmod(path, mode);
      notify({ type: 'success', title: '权限已修改' });
      const s = await api.stat(path);
      setStat(s); setModeStr((s.modeStr || '').slice(1));
    } catch (e) { notify({ type: 'error', title: '修改失败', body: e.message }); }
  }

  async function applyChown() {
    try {
      await api.chown(path, owner.uid === '' ? null : Number(owner.uid), owner.gid === '' ? null : Number(owner.gid));
      notify({ type: 'success', title: '所有者已修改' });
      const s = await api.stat(path);
      setStat(s);
    } catch (e) { notify({ type: 'error', title: '修改失败', body: e.message }); }
  }

  if (error) return <div className="info-window"><div className="finder-empty"><p>⚠️ {error}</p></div></div>;
  if (!stat) return <div className="info-window"><div className="boot-spinner" /></div>;

  const bits = modeStr.padEnd(9, '-').split('');
  const permLabels = ['所有者读', '所有者写', '所有者执行', '组读', '组写', '组执行', '其他读', '其他写', '其他执行'];

  return (
    <div className="info-window">
      <div className="info-head">
        <FileIcon name={stat.name} type={stat.type} size={56} />
        <div>
          <h3>{stat.name}</h3>
          <p className="mono ellipsis">/{stat.path}</p>
        </div>
      </div>
      <table className="about-table">
        <tbody>
          <tr><td>类型</td><td>{stat.type === 'dir' ? '文件夹' : stat.type === 'symlink' ? `软链接 → ${stat.target || '?'}` : '文件'}</td></tr>
          <tr><td>大小</td><td>{fmtSize(stat.size)}（{stat.size} 字节）</td></tr>
          <tr><td>创建时间</td><td>{fmtTime(stat.birthtimeMs)}</td></tr>
          <tr><td>修改时间</td><td>{fmtTime(stat.mtimeMs)}</td></tr>
          <tr><td>访问时间</td><td>{fmtTime(stat.atimeMs)}</td></tr>
        </tbody>
      </table>

      <div className="info-section">
        <h4>权限（chmod）</h4>
        <div className="perm-grid">
          {bits.map((b, i) => (
            <label key={i} className="perm-bit" title={permLabels[i]}>
              <input
                type="checkbox"
                checked={b !== '-'}
                onChange={(e) => {
                  const nb = [...bits];
                  nb[i] = e.target.checked ? 'rwx'[i % 3] : '-';
                  setModeStr(nb.join(''));
                }}
              />
              <span className="mono">{b === '-' ? '−' : b}</span>
            </label>
          ))}
        </div>
        <div className="info-row">
          <input className="mono" value={modeStr} onChange={(e) => setModeStr(e.target.value.replace(/[^rwx-]/g, '').slice(0, 9))} />
          <button className="btn btn-small btn-primary" onClick={applyChmod}>应用</button>
        </div>
      </div>

      {stat.uid != null && stat.uid > 0 && (
        <div className="info-section">
          <h4>所有者（chown）</h4>
          <div className="info-row">
            <input placeholder="uid" value={owner.uid} onChange={(e) => setOwner((o) => ({ ...o, uid: e.target.value }))} />
            <input placeholder="gid" value={owner.gid} onChange={(e) => setOwner((o) => ({ ...o, gid: e.target.value }))} />
            <button className="btn btn-small btn-primary" onClick={applyChown}>应用</button>
          </div>
          <p className="info-hint">留空表示不修改；修改 uid/gid 需要服务进程具备相应系统权限。</p>
        </div>
      )}
    </div>
  );
}
