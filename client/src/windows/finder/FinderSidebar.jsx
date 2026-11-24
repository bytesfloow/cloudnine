import React from 'react';
import { getState, bus, notify } from '../../store.js';
import { api } from '../../api.js';

// 文件资源管理器 · 左侧导航栏
// 「快速访问」分组（Win11 侧栏分组名）：主目录 / 文件根目录 / 最近 / 回收站。
// 条目同时是拖放目标（拖到条目上 = 移动到该目录）。
export default function FinderSidebar({
  cwd, isTrash, recentMode, navigate, setRecentMode, setCwd, setSel,
}) {
  return (
    <div className="finder-sidebar">
      <div className="sb-group">快速访问</div>
      <SideItem label="主目录" onClick={() => navigate(getState().homeRel || '')} dropdir={getState().homeRel || ''} active={cwd === getState().homeRel && !isTrash && !recentMode} />
      {/* 这里必须叫「文件根目录」：它和上面的「主目录」（homeRel）是两个目录，
          两个同名项并排会让人分不清；桌面上那枚系统图标指向的正是这一层（文件根）。 */}
      {getState().homeRel && <SideItem label="文件根目录" onClick={() => navigate('')} dropdir="" active={cwd === '' && !isTrash && !recentMode} />}
      <SideItem label="最近" onClick={() => { setRecentMode(true); setCwd(''); setSel(new Set()); }} active={recentMode} />
      <SideItem label="回收站" onClick={() => navigate('__trash__')} active={isTrash} />
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
