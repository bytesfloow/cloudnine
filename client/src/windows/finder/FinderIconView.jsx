import React from 'react';
import { joinPath } from '../../store.js';
import { FileIcon } from '../../icons.jsx';
import RenameInput from './RenameInput.jsx';

// 文件资源管理器 · 图标视图
export default function FinderIconView({
  shown, sel, renaming, cwd, clickItem, openEntry, itemMenu,
  onItemDragStart, onDropToDir, submitRename, setRenaming,
}) {
  return (
    <div className="icon-grid">
      {shown.map((entry, idx) => (
        <div
          key={entry.name + (entry.path || '')}
          data-name={entry.name}
          className={`finder-item icon-item${sel.has(entry.name) ? ' selected' : ''}`}
          onClick={(e) => clickItem(e, entry, idx)}
          onDoubleClick={() => openEntry(entry)}
          onContextMenu={(e) => itemMenu(e, entry)}
          draggable={!renaming}
          onDragStart={(e) => !entry.trashId && onItemDragStart(e, entry)}
          onDragOver={(e) => { if (entry.type === 'dir' && !entry.isRecent) { e.preventDefault(); e.stopPropagation(); } }}
          onDrop={(e) => { if (entry.type === 'dir' && !entry.isRecent) onDropToDir(e, joinPath(cwd, entry.name)); }}
          title={entry.name}
        >
          <FileIcon name={entry.name} type={entry.type} size={52} />
          {renaming === entry.name ? (
            <RenameInput value={entry.name} onSubmit={(v) => submitRename(entry.name, v)} onCancel={() => setRenaming(null)} />
          ) : (
            <span className="item-name">{entry.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
