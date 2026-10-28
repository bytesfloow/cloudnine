import React, { useEffect, useState } from 'react';
import { useStore, bus, fmtSize, fmtSpeed, notify } from '../store.js';
import { pauseUpload, resumeUpload, cancelUpload, clearFinishedUploads, fmtProgress, fmtUploaded } from '../transfers.js';
import { api } from '../api.js';

// 传输窗口：上传队列 + 后台任务（压缩/解压）
export default function TransfersWindow() {
  const s = useStore();
  const [jobs, setJobs] = useState([]);
  const anyRunning = s.transfers.some((x) => ['uploading', 'pending'].includes(x.status)) || jobs.some((j) => j.status === 'running');

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.jobs();
        if (!stop) {
          setJobs(r.jobs);
          // 任务完成 → 通知 + 刷新目录
          r.jobs.filter((j) => j.status === 'done' && !j._notified).forEach((j) => {
            j._notified = true;
            notify({ type: 'success', title: j.type === 'compress' ? '压缩完成' : '解压完成', body: j.label });
            bus.emit('fs:changed', '');
          });
          r.jobs.filter((j) => j.status === 'error' && !j._notified).forEach((j) => {
            j._notified = true;
            notify({ type: 'error', title: '任务失败', body: `${j.label}：${j.error}` });
          });
        }
      } catch { /* 忽略 */ }
    };
    poll();
    const t = setInterval(poll, 1500);
    return () => { stop = true; clearInterval(t); };
  }, []);

  return (
    <div className="transfers-window">
      <div className="transfers-section">
        <div className="section-head">
          <h4>上传</h4>
          {s.transfers.length > 0 && <button className="btn btn-small" onClick={clearFinishedUploads}>清除已完成</button>}
        </div>
        {s.transfers.length === 0 ? <div className="empty-hint">把文件拖到访达窗口或桌面上即可上传</div> : (
          <div className="transfer-list">
            {s.transfers.map((it) => (
              <div key={it.id} className={`transfer-item t-${it.status}`}>
                <div className="tr-info">
                  <div className="tr-name ellipsis">{it.displayName}</div>
                  <div className="tr-sub">
                    {it.status === 'error' ? <span className="tr-error">{it.error}</span>
                      : <>{fmtUploaded(it)} · {it.status === 'uploading' ? fmtSpeed(it.speed) : statusLabel(it.status)}</>}
                  </div>
                  <div className="tr-bar"><i style={{ width: `${fmtProgress(it)}%` }} /></div>
                </div>
                <div className="tr-actions">
                  {it.status === 'uploading' && <button className="btn btn-small" onClick={() => pauseUpload(it.id)}>暂停</button>}
                  {it.status === 'paused' && <button className="btn btn-small" onClick={() => resumeUpload(it.id)}>继续</button>}
                  {it.status === 'error' && <button className="btn btn-small" onClick={() => resumeUpload(it.id)}>重试</button>}
                  {['pending', 'uploading', 'paused', 'error'].includes(it.status) && (
                    <button className="btn btn-small" onClick={() => cancelUpload(it.id)}>取消</button>
                  )}
                  {it.status === 'done' && <span className="tr-done">✓</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="transfers-section">
        <div className="section-head"><h4>后台任务</h4>{anyRunning && <span className="running-dot" />}</div>
        {jobs.length === 0 ? <div className="empty-hint">压缩、解压等任务将在这里显示进度</div> : (
          <div className="transfer-list">
            {jobs.map((j) => (
              <div key={j.id} className={`transfer-item t-${j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'uploading'}`}>
                <div className="tr-info">
                  <div className="tr-name ellipsis">{j.label}</div>
                  <div className="tr-sub">{j.status === 'error' ? <span className="tr-error">{j.error}</span> : j.status === 'done' ? '已完成' : `${j.progress}%`}</div>
                  <div className="tr-bar"><i style={{ width: `${j.status === 'done' ? 100 : j.progress}%` }} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabel(st) {
  return { pending: '排队中', paused: '已暂停', done: '已完成', canceled: '已取消', error: '失败' }[st] || st;
}
