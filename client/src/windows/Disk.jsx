import React, { useEffect, useState } from 'react';
import { useStore, setState, openWindow, notify } from '../store.js';
import { api } from '../api.js';
import { fmtSize } from '../store.js';
import { IconRefresh } from '../icons.jsx';

export default function DiskWindow() {
  const s = useStore();
  const [interval, setIntervalSec] = useState(0);
  const mounts = s.disk || [];

  const load = () => api.disk().then((d) => setState({ disk: d.mounts })).catch(() => {});

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!interval) return;
    const t = setInterval(load, interval * 1000);
    return () => clearInterval(t);
  }, [interval]);

  return (
    <div className="disk-window">
      <div className="section-head">
        <h4>磁盘空间</h4>
        <div className="section-actions">
          <select value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))} className="btn btn-small">
            <option value={0}>不自动刷新</option>
            <option value={10}>每 10 秒</option>
            <option value={30}>每 30 秒</option>
            <option value={60}>每 60 秒</option>
          </select>
          <button className="btn btn-small" onClick={load}><IconRefresh /> 刷新</button>
        </div>
      </div>
      {mounts.length === 0 ? <div className="empty-hint">未读取到挂载点信息</div> : (
        <div className="disk-cards">
          {mounts.map((m) => (
            <div key={m.mount} className="disk-card" onClick={() => m.mountRel != null && openWindow('finder', { cwd: m.mountRel })} title={m.mountRel != null ? '在访达中打开' : ''}>
              <div className="dc-head">
                <span className="dc-mount ellipsis" title={m.mount}>{m.mount}</span>
                <span className={`dc-pct ${m.usePct > 95 ? 'danger' : m.usePct > 85 ? 'warn' : m.usePct > 70 ? 'notice' : ''}`}>{m.usePct}%</span>
              </div>
              <div className="disk-bar big"><i style={{ width: `${m.usePct}%` }} className={m.usePct > 85 ? 'danger' : m.usePct > 70 ? 'warn' : ''} /></div>
              <div className="dc-detail">
                <span>已用 {fmtSize(m.used)}</span>
                <span>可用 {fmtSize(m.free)}</span>
                <span>共 {fmtSize(m.total)}</span>
              </div>
              <div className="dc-sub mono">{m.fstype}{m.inodes ? ` · inode ${m.inodesFree != null ? fmtSize(m.inodesFree) : '?'} / ${fmtSize(m.inodes)}` : ''}</div>
            </div>
          ))}
        </div>
      )}
      <p className="info-hint">使用率分级：&lt;70% 正常 · 70–85% 注意 · 85–95% 警告 · &gt;95% 危险。点击卡片可在访达中打开对应目录。</p>
    </div>
  );
}
