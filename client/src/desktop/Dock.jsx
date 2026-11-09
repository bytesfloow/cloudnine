import React from 'react';
import { useStore, getState, openWindow } from '../store.js';
import { addUpload } from '../transfers.js';
import { IconFiles, IconTerminal, IconEditor, IconTransfer, IconShare, IconDisk, IconTrash } from '../icons.jsx';

const ITEMS = [
  { type: 'finder', label: '文件', Icon: IconFiles },
  { type: 'terminal', label: '终端', Icon: IconTerminal },
  { type: 'editor', label: '文本编辑', Icon: IconEditor },
  { type: 'transfers', label: '传输', Icon: IconTransfer },
  { type: 'shares', label: '分享管理', Icon: IconShare },
  { type: 'disk', label: '磁盘监控', Icon: IconDisk },
  { type: 'trash', label: '废纸篓', Icon: IconTrash, trash: true },
];

export default function Dock() {
  const s = useStore();
  return (
    <div className="dock">
      {ITEMS.map(({ type, label, Icon, trash }) => {
        const running = trash ? false : s.windows.some((w) => w.type === type);
        const badge = trash && s.trashCount > 0 ? s.trashCount : 0;
        return (
          <button
            key={type}
            className="dock-item"
            title={label}
            onClick={() => trash ? openWindow('finder', { trash: true }) : openWindow(type, type === 'finder' ? { cwd: s.homeRel || '' } : undefined)}
            onDragOver={(e) => { if (trash || type === 'transfers') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={(e) => {
              if (!trash && type !== 'transfers') return;
              e.preventDefault();
              const files = [...e.dataTransfer.files];
              if (!files.length) return;
              if (trash) {
                // Dock 不接受文件拖入废纸篓（废纸篓只收系统内文件）
                return;
              }
              const { homeRel } = getState();
              files.forEach((f) => addUpload(f, homeRel || ''));
            }}
          >
            {type === 'trash'
              ? <IconTrash size={44} full={s.trashCount > 0} />
              : <Icon size={44} />}
            {badge > 0 && <span className="dock-badge">{badge}</span>}
            {running && <span className="dock-dot" />}
          </button>
        );
      })}
    </div>
  );
}
