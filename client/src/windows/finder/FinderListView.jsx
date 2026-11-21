import React from 'react';
import { joinPath, fmtSize, fmtTime } from '../../store.js';
import { FileIcon } from '../../icons.jsx';
import RenameInput from './RenameInput.jsx';

// 文件资源管理器 · 列表视图（名称/大小/修改时间/权限/所有者，表头可点排序）
export default function FinderListView({
  shown, sel, renaming, cwd, clickItem, openEntry, itemMenu,
  onItemDragStart, onDropToDir, submitRename, setRenaming, sort, setSort,
}) {
  return (
    <div className="list-view">
      <div className="list-header">
        <span className="col-name" onClick={() => setSort((s) => ({ key: 'name', asc: s.key === 'name' ? !s.asc : true }))}>名称{sort.key === 'name' ? (sort.asc ? ' ↑' : ' ↓') : ''}</span>
        <span className="col-size" onClick={() => setSort((s) => ({ key: 'size', asc: s.key === 'size' ? !s.asc : true }))}>大小{sort.key === 'size' ? (sort.asc ? ' ↑' : ' ↓') : ''}</span>
        <span className="col-mtime" onClick={() => setSort((s) => ({ key: 'mtime', asc: s.key === 'mtime' ? !s.asc : true }))}>修改时间{sort.key === 'mtime' ? (sort.asc ? ' ↑' : ' ↓') : ''}</span>
        <span className="col-mode">权限</span>
        <span className="col-owner">所有者</span>
      </div>
      <div className="list-body">
        {shown.map((entry, idx) => (
          <div
            key={entry.name + (entry.path || '')}
            data-name={entry.name}
            className={`finder-item list-item${sel.has(entry.name) ? ' selected' : ''}`}
            onClick={(e) => clickItem(e, entry, idx)}
            onDoubleClick={() => openEntry(entry)}
            onContextMenu={(e) => itemMenu(e, entry)}
            draggable={!renaming}
            onDragStart={(e) => !entry.trashId && onItemDragStart(e, entry)}
            onDragOver={(e) => { if (entry.type === 'dir' && !entry.isRecent) { e.preventDefault(); e.stopPropagation(); } }}
            onDrop={(e) => { if (entry.type === 'dir' && !entry.isRecent) onDropToDir(e, joinPath(cwd, entry.name)); }}
          >
            <span className="col-name item-file">
              <FileIcon name={entry.name} type={entry.type} size={20} />
              {renaming === entry.name
                ? <RenameInput value={entry.name} onSubmit={(v) => submitRename(entry.name, v)} onCancel={() => setRenaming(null)} />
                : <span className="item-name">{entry.name}</span>}
            </span>
            <span className="col-size">{entry.type === 'dir' ? '—' : fmtSize(entry.size)}</span>
            <span className="col-mtime">{fmtTime(entry.mtimeMs)}</span>
            <span className="col-mode mono">{entry.modeStr || '—'}</span>
            <span className="col-owner mono">{entry.uid != null ? `${entry.uid}:${entry.gid}` : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
