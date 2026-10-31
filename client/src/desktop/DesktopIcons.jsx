import React, { useLayoutEffect, useRef, useState } from 'react';
import { useStore, getState, openWindow, openContextMenu, setTheme, setState, bus, promptDialog, confirmDialog, notify, dirname, joinPath } from '../store.js';
import { addUpload } from '../transfers.js';
import { api } from '../api.js';
import { IconHome, IconGlobe, IconTrash, IconTerminal } from '../icons.jsx';

// 桌面图标区：常用位置聚合（决策 Q12），外部文件拖入上传到主目录
// 图标可自由拖动，松手后自动对齐到网格单元（决策：位置按 key 持久化到 localStorage）
const CELL_W = 92;
const CELL_H = 96;
const ICON_W = 84;
const POS_KEY = 'cloudnine-icon-pos';
const DRAG_THRESHOLD = 4;

function loadSavedPositions() {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

export default function DesktopIcons() {
  const s = useStore();
  const [selected, setSelected] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [positions, setPositions] = useState(loadSavedPositions);
  const [size, setSize] = useState(null);
  const [dragging, setDragging] = useState(null); // { key, x, y } 拖动中的实时像素位置
  const layerRef = useRef(null);
  const dragRef = useRef(null);   // 指针拖动会话
  const dragPosRef = useRef(null); // 拖动中最新的像素坐标
  const draggedAtRef = useRef(0); // 最近一次拖动结束时间，用于抑制误触 click/dblclick

  // 挂载时同步测量一次确定网格范围，之后交给 ResizeObserver 跟踪窗口尺寸变化
  // （不依赖 RO 的初始回调：部分环境/隐藏标签页下它不会及时触发）
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxCol = size ? Math.max(0, Math.floor((size.w - CELL_W) / CELL_W)) : 0;
  const maxRow = size ? Math.max(0, Math.floor((size.h - CELL_H) / CELL_H)) : 0;

  // 主目录与根目录重合时（Windows 默认 fileRoot 即用户主目录，homeRel 为空），不再单独显示根目录
  const icons = [
    { key: 'home', label: '主目录', Icon: IconHome, open: () => openWindow('finder', { cwd: s.homeRel || '' }) },
    ...(s.homeRel ? [{ key: 'root', label: '根目录', Icon: IconGlobe, open: () => openWindow('finder', { cwd: '' }) }] : []),
    { key: 'trash', label: '废纸篓', Icon: IconTrash, open: () => openWindow('finder', { trash: true }), badge: s.trashCount },
  ];

  const clampCell = (p) => ({ col: Math.min(Math.max(0, p.col | 0), maxCol), row: Math.min(Math.max(0, p.row | 0), maxRow) });

  // 图标网格坐标：已保存位置优先（越界裁剪），否则默认排在左上角一列
  const posOf = (key, idx) => {
    const saved = positions[key];
    if (saved) return clampCell(saved);
    const perCol = maxRow + 1;
    return { col: Math.min(maxCol, Math.floor(idx / perCol)), row: idx % perCol };
  };

  // 目标像素坐标 → 最近的空闲网格单元（被占用时向外圈扩展查找）
  const nearestFreeCell = (x, y, key) => {
    const col = Math.min(maxCol, Math.max(0, Math.round(x / CELL_W)));
    const row = Math.min(maxRow, Math.max(0, Math.round(y / CELL_H)));
    const taken = new Set(icons.filter((i) => i.key !== key).map((i, idx) => {
      const p = posOf(i.key, idx);
      return `${p.col}:${p.row}`;
    }));
    for (let r = 0; r <= Math.max(maxCol, maxRow); r++) {
      for (let dc = -r; dc <= r; dc++) for (let dr = -r; dr <= r; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const c = col + dc, w = row + dr;
        if (c < 0 || c > maxCol || w < 0 || w > maxRow) continue;
        if (!taken.has(`${c}:${w}`)) return { col: c, row: w };
      }
    }
    return { col, row };
  };

  function startDrag(e, key) {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    dragRef.current = { key, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, baseX: el.offsetLeft, baseY: el.offsetTop, moved: false };
    el.setPointerCapture(e.pointerId);
  }
  function moveDrag(e) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
    }
    dragPosRef.current = { x: d.baseX + dx, y: d.baseY + dy };
    setDragging({ key: d.key, ...dragPosRef.current });
  }
  function endDrag(e) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (!d.moved) return;
    const cur = dragPosRef.current;
    dragPosRef.current = null;
    draggedAtRef.current = Date.now();
    setDragging(null);
    if (!cur) return;
    const cell = nearestFreeCell(cur.x, cur.y, d.key);
    setPositions((prev) => {
      const np = { ...prev, [d.key]: cell };
      try { localStorage.setItem(POS_KEY, JSON.stringify(np)); } catch { /* 忽略持久化失败 */ }
      return np;
    });
  }
  function cancelDrag(e) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    dragPosRef.current = null;
    if (d.moved) { draggedAtRef.current = Date.now(); setDragging(null); }
  }
  const justDragged = () => Date.now() - draggedAtRef.current < 600;

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
      { label: '重排桌面图标', action: () => { setPositions({}); try { localStorage.removeItem(POS_KEY); } catch {} } },
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
      ref={layerRef}
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
      {size && icons.map(({ key, label, Icon, open, badge }, idx) => {
        const isDragging = dragging?.key === key;
        const pos = posOf(key, idx);
        const style = isDragging
          ? { left: dragging.x, top: dragging.y, width: ICON_W, zIndex: 20 }
          : { left: pos.col * CELL_W, top: pos.row * CELL_H, width: ICON_W };
        return (
          <button
            key={key}
            className={`desktop-icon${selected === key ? ' selected' : ''}${isDragging ? ' dragging' : ''}`}
            style={style}
            draggable={false}
            onPointerDown={(e) => startDrag(e, key)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
            onClick={(e) => { if (justDragged()) { e.stopPropagation(); return; } setSelected(key); }}
            onDoubleClick={() => { if (justDragged()) return; open(); }}
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
        );
      })}
    </div>
  );
}
