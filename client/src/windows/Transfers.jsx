import React, { useEffect, useState } from 'react';
import { useStore, bus, fmtSpeed, notify } from '../store.js';
import { pauseUpload, resumeUpload, cancelUpload, clearFinishedUploads, fmtProgress, fmtUploaded, addUpload } from '../transfers.js';
import { api } from '../api.js';
import { FileIcon, IconUpload } from '../icons.jsx';

// 系统文件选择器（同访达工具栏的上传入口），落点与桌面拖放一致：主目录
function pickUpload(folder, destDir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.webkitdirectory = true;
  input.onchange = () => {
    for (const f of input.files) addUpload(f, destDir, folder ? (f.webkitRelativePath || f.name) : '');
  };
  input.click();
}

// 传输窗口：上传队列 + 后台任务（压缩/解压）
export default function TransfersWindow() {
  const s = useStore();
  const [jobs, setJobs] = useState([]);
  const anyRunning = s.transfers.some((x) => ['uploading', 'pending'].includes(x.status)) || jobs.some((j) => j.status === 'running');
  const homeRel = s.homeRel || '';

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
          <h4>上传{s.transfers.length > 0 && <span className="head-count">{s.transfers.length} 项</span>}</h4>
          <div className="section-actions">
            <button className="btn btn-small btn-primary" onClick={() => pickUpload(false, homeRel)} title="选择系统文件上传到主目录">
              <IconUpload size={13} />选择文件
            </button>
            <button className="btn btn-small" onClick={() => pickUpload(true, homeRel)} title="选择系统文件夹上传到主目录（保留目录结构）">选择文件夹</button>
            {s.transfers.length > 0 && <button className="btn btn-small" onClick={clearFinishedUploads}>清除已完成</button>}
          </div>
        </div>
        {s.transfers.length === 0 ? (
          <button className="empty-state" onClick={() => pickUpload(false, homeRel)} title="选择文件上传到主目录">
            <span className="es-icon"><IconUpload size={22} /></span>
            <span className="es-title">选择文件开始上传</span>
            <span className="es-sub">点击选择系统文件，或把文件拖到访达窗口 / 桌面上</span>
          </button>
        ) : (
          <div className="transfer-list">
            {s.transfers.map((it) => (
              <div key={it.id} className={`transfer-item t-${it.status}`}>
                <span className="tr-icon"><FileIcon name={it.displayName} size={30} /></span>
                <div className="tr-info">
                  <div className="tr-top">
                    <div className="tr-name ellipsis">{it.displayName}</div>
                    {it.status === 'done' && <span className="tr-chip chip-ok">已完成</span>}
                    {it.status === 'error' && <span className="tr-chip chip-bad">失败</span>}
                    {it.status === 'canceled' && <span className="tr-chip chip-muted">已取消</span>}
                  </div>
                  <div className="tr-sub">
                    {it.status === 'error' ? <span className="tr-error">{it.error}</span>
                      : <>{fmtUploaded(it)}{it.status === 'uploading' ? ` · ${fmtSpeed(it.speed)}` : ['pending', 'paused'].includes(it.status) ? ` · ${statusLabel(it.status)}` : ''}</>}
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="transfers-section">
        <div className="section-head">
          <h4>后台任务{jobs.length > 0 && <span className="head-count">{jobs.length} 项</span>}{anyRunning && <span className="running-dot" />}</h4>
        </div>
        {jobs.length === 0 ? <div className="empty-hint">压缩、解压等任务将在这里显示进度</div> : (
          <div className="transfer-list">
            {jobs.map((j) => (
              <div key={j.id} className={`transfer-item t-${j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'uploading'}`}>
                <span className="tr-icon"><FileIcon name={j.label} size={30} /></span>
                <div className="tr-info">
                  <div className="tr-top">
                    <div className="tr-name ellipsis">{j.label}</div>
                    {j.status === 'done' && <span className="tr-chip chip-ok">已完成</span>}
                    {j.status === 'error' && <span className="tr-chip chip-bad">失败</span>}
                  </div>
                  <div className="tr-sub">
                    {j.status === 'error' ? <span className="tr-error">{j.error}</span>
                      : j.status === 'done' ? '已完成' : `${j.progress}%`}
                  </div>
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
