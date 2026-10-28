import React, { useState } from 'react';
import { useStore, getState, openWindow, openContextMenu, setTheme, setState, bus, promptDialog, confirmDialog, notify, dirname, joinPath } from '../store.js';
import { addUpload } from '../transfers.js';
import { api } from '../api.js';
import { IconHome, IconGlobe, IconTrash, IconTerminal } from '../icons.jsx';

// 桌面图标区：常用位置聚合（决策 Q12），外部文件拖入上传到主目录
export default function DesktopIcons() {
  const s = useStore();
  const [selected, setSelected] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const icons = [
    { key: 'home', label: '主目录', Icon: IconHome, open: () => openWindow('finder', { cwd: s.homeRel || '' }) },
    { key: 'root', label: '根目录', Icon: IconGlobe, open: () => openWindow('finder', { cwd: '' }) },
    { key: 'trash', label: '废纸篓', Icon: IconTrash, open: () => openWindow('finder', { trash: true }), badge: s.trashCount },
  ];

  const desktopMenu = (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: '新建文件夹', action: () => newInHome('dir') },
      { label: '新建空白文件', action: () => newInHome('file') },
      '-',
      { label: '上传文件…', action: () => uploadToHome(false) },
      { label: '上传文件夹…', action: () => uploadToHome(true) },
      '-',
      { label: '打开访达', action: () => openWindow('finder') },
      { label: '打开终端', action: () => openWindow('terminal', { cwd: s.homeRel || '' }) },
      '-',
      { label: '切换深浅色主题', checked: document.documentElement.dataset.theme === 'dark', action: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
    ]);
  };

  async function newInHome(kind) {
    const v = await promptDialog({
      title: kind === 'dir' ? '新建文件夹' : '新建空白文件',
      fields: [{ key: 'name', label: '名称', required: true, autofocus: true, placeholder: kind === 'dir' ? '文件夹名称' : '文件名称.txt' }],
    });
    if (!v?.name) return;
    try {
      const p = joinPath(s.homeRel || '', v.name);
      if (kind === 'dir') await api.mkdir(p); else await api.touch(p);
      bus.emit('fs:changed', dirname(p));
    } catch (e) { notify({ type: 'error', title: '创建失败', body: e.message }); }
  }

  function uploadToHome(folder) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.onchange = () => {
      const { homeRel } = getState();
      for (const f of input.files) {
        const rel = folder ? (f.webkitRelativePath || f.name) : '';
        addUpload(f, homeRel || '', rel);
      }
    };
    input.click();
  }

  return (
    <div
      className={`desktop-icons${dragOver ? ' drag-over' : ''}`}
      onContextMenu={desktopMenu}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        for (const f of e.dataTransfer.files) addUpload(f, s.homeRel || '');
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
    >
      {icons.map(({ key, label, Icon, open, badge }) => (
        <button
          key={key}
          className={`desktop-icon${selected === key ? ' selected' : ''}`}
          onClick={() => setSelected(key)}
          onDoubleClick={open}
          onContextMenu={(e) => {
            e.preventDefault(); e.stopPropagation();
            openContextMenu(e.clientX, e.clientY, [
              { label: '打开', action: open },
              ...(key !== 'trash' ? [{ label: '在终端中打开', action: () => openWindow('terminal', { cwd: key === 'home' ? (s.homeRel || '') : '' }) }] : []),
              ...(key === 'trash' && s.trashCount > 0 ? ['-', {
                label: '清倒废纸篓', danger: true, action: async () => {
                  if (await confirmDialog({ title: '清倒废纸篓', message: `将彻底删除废纸篓中的 ${s.trashCount} 项，此操作不可撤销。`, danger: true, okText: '清倒' })) {
                    await api.trashEmpty();
                    setState({ trashCount: 0 });
                    bus.emit('fs:changed', '__trash__');
                  }
                },
              }] : []),
            ]);
          }}
        >
          <span className="di-icon-wrap">
            {key === 'trash' ? <IconTrash size={52} full={s.trashCount > 0} /> : <Icon size={52} />}
            {badge > 0 && <span className="desktop-badge">{badge}</span>}
          </span>
          <span className="di-label">{label}</span>
        </button>
      ))}
    </div>
  );
}
