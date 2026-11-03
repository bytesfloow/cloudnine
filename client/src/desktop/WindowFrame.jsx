import React, { useRef } from 'react';
import { useStore, focusWindow, closeWindow, minimizeWindow, toggleMaxWindow, commitRect, setState, getState } from '../store.js';

const MENUBAR_H = 28;

export default function WindowFrame({ win, focused, children }) {
  const ref = useRef(null);
  const { rect } = win;

  // 拖动/缩放：直接操作 DOM，pointerup 时提交，避免整棵树重渲染
  function startDrag(e) {
    if (e.target.closest('.win-controls') || rect.max) return;
    e.preventDefault();
    focusWindow(win.id);
    const el = ref.current;
    const startX = e.clientX, startY = e.clientY;
    const { x: ox, y: oy } = rect;
    const onMove = (ev) => {
      const nx = Math.min(Math.max(ox + ev.clientX - startX, -(rect.w - 120)), window.innerWidth - 120);
      const ny = Math.min(Math.max(oy + ev.clientY - startY, MENUBAR_H), window.innerHeight - 44);
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
      el._drag = { x: nx, y: ny };
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (el._drag) commitRect(win.id, { x: el._drag.x, y: el._drag.y });
      el._drag = null;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function startResize(e, dir) {
    e.preventDefault(); e.stopPropagation();
    focusWindow(win.id);
    const el = ref.current;
    const sx = e.clientX, sy = e.clientY;
    const o = { ...rect };
    const minW = win.minW, minH = win.minH;
    const apply = (w, h, x, y) => {
      el.style.width = `${w}px`; el.style.height = `${h}px`;
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      el._resize = { w, h, x, y };
    };
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let { w, h, x, y } = o;
      if (dir.includes('e')) w = Math.max(minW, o.w + dx);
      if (dir.includes('s')) h = Math.max(minH, o.h + dy);
      if (dir.includes('w')) { w = Math.max(minW, o.w - dx); x = o.x + (o.w - w); }
      if (dir.includes('n')) { h = Math.max(minH, o.h - dy); y = Math.max(MENUBAR_H, o.y + (o.h - h)); }
      apply(w, h, x, y);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (el._resize) { const r = el._resize; delete el._resize; commitRect(win.id, r); }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  const style = rect.max
    ? { left: 0, top: MENUBAR_H, width: '100vw', height: `calc(100vh - ${MENUBAR_H}px)`, zIndex: win.z }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z };

  return (
    <div
      ref={ref}
      className={`window${focused ? ' focused' : ''}${win.minimized ? ' minimized' : ''}${rect.max ? ' maximized' : ''}`}
      style={style}
      onPointerDown={() => focusWindow(win.id)}
    >
      <div className="window-titlebar" onPointerDown={startDrag} onDoubleClick={() => toggleMaxWindow(win.id)}>
        {win.props?.savedFlash && <span className="win-saved">已保存</span>}
        <div className="win-controls">
          <button className="tc tc-min" title="最小化" aria-label="最小化" onClick={(e) => { e.stopPropagation(); minimizeWindow(win.id); }} />
          <button className="tc tc-max" title="最大化" aria-label="最大化" onClick={(e) => { e.stopPropagation(); toggleMaxWindow(win.id); }} />
          <button className="tc tc-close" title="关闭" aria-label="关闭" onClick={(e) => { e.stopPropagation(); closeWindow(win.id); }} />
        </div>
        <div className="window-title">{win.title}</div>
        <div className="titlebar-spacer" />
      </div>
      <div className="window-body">{children}</div>
      {!rect.max && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => (
        <div key={d} className={`resize-handle rh-${d}`} onPointerDown={(e) => startResize(e, d)} />
      ))}
    </div>
  );
}
