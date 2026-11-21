import React from 'react';
import { getState, bus, notify } from '../../store.js';
import { api } from '../../api.js';

// 文件资源管理器 · 左侧导航栏
// 「个人收藏」分组：主目录 / 根目录 / 最近 / 废纸篓。条目同时是拖放目标（拖到条目上=移动到该目录）。
export default function FinderSidebar({
  cwd, isTrash, recentMode, navigate, setRecentMode, setCwd, setSel,
}) {
  return (
    <div className="finder-sidebar">
      <div className="sb-group">个人收藏</div>
      <SideItem label="主目录" onClick={() => navigate(getState().homeRel || '')} dropdir={getState().homeRel || ''} active={cwd === getState().homeRel && !isTrash && !recentMode} />
      {/* 主目录与根目录重合（homeRel 为空）时不重复显示根目录 */}
      {getState().homeRel && <SideItem label="根目录" onClick={() => navigate('')} dropdir="" active={cwd === '' && !isTrash && !recentMode} />}
      <SideItem label="最近" onClick={() => { setRecentMode(true); setCwd(''); setSel(new Set()); }} active={recentMode} />
      <SideItem label="废纸篓" onClick={() => navigate('__trash__')} active={isTrash} />
    </div>
  );
}

function SideItem({ label, onClick, active, dropdir }) {
  return (
    <button
      className={`sb-item${active ? ' active' : ''}`}
      onClick={onClick}
      data-dropdir={dropdir}
      onDragOver={(e) => { if (dropdir != null) e.preventDefault(); }}
      onDrop={(e) => {
        if (dropdir == null) return;
        const raw = e.dataTransfer.getData('application/x-cloudnine');
        if (!raw) return;
        const { paths } = JSON.parse(raw);
        api.move(paths, dropdir).then(() => bus.emit('fs:changed', dropdir)).catch((e2) => notify({ type: 'error', title: '移动失败', body: e2.message }));
      }}
    >
      {label}
    </button>
  );
}
