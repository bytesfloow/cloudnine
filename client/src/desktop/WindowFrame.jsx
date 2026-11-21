import React, { useRef } from 'react';
import {
  focusWindow, closeWindow, minimizeWindow, toggleMaxWindow, commitRect,
  applySnap, beginMoveFromSpecial,
  SHELL_TOP_H, SHELL_BOTTOM_H, TITLEBAR_MIN_VISIBLE, SNAP_EDGE,
} from '../store.js';

// 顶部外壳（旧菜单栏）高度已归零：窗口可以拖到 y = 0（docs §7 R12）。
// 底部让位给任务栏，拖动 / 缩放 / 最大化三处用同一组常量。

// ---------- Aero Snap 预览（docs §5.2） ----------
// 预览矩形是纯 DOM 节点，不进 store：拖动过程中不能触发整棵树重渲染，
// 规格也明确要求「预览态不写 store，只在 pointerup 提交」。
let previewEl = null;

function hideSnapPreview() {
  if (previewEl) { previewEl.remove(); previewEl = null; }
}

function showSnapPreview(rect) {
  if (!previewEl) {
    previewEl = document.createElement('div');
    previewEl.className = 'snap-preview';
    (document.querySelector('.desktop') || document.body).appendChild(previewEl);
  }
  previewEl.dataset.snap = rect.side;
  previewEl.style.left = `${rect.x}px`;
  previewEl.style.top = `${rect.y}px`;
  previewEl.style.width = `${rect.w}px`;
  previewEl.style.height = `${rect.h}px`;
}

function previewFor(zone) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const h = Math.max(160, vh - SHELL_BOTTOM_H - SHELL_TOP_H);
  if (zone === 'max') return { side: 'max', x: 0, y: SHELL_TOP_H, w: vw, h };
  const w = Math.round(vw / 2);
  return zone === 'left'
    ? { side: 'left', x: 0, y: SHELL_TOP_H, w, h }
    : { side: 'right', x: vw - w, y: SHELL_TOP_H, w, h };
}

// 触发区判定：顶边缘 → 最大化；左右边缘 → 半屏（阈值 8px）。
// 四角（1/4 屏）按规格留到阶段 3，这里让顶边缘优先。
function snapZoneAt(ev) {
  if (ev.clientY <= SNAP_EDGE) return 'max';
  if (ev.clientX <= SNAP_EDGE) return 'left';
  if (ev.clientX >= window.innerWidth - SNAP_EDGE) return 'right';
  return null;
}

export default function WindowFrame({ win, focused, children }) {
  const ref = useRef(null);
  const { rect } = win;

  // 拖动/缩放：直接操作 DOM，pointerup 时提交，避免整棵树重渲染
  function startDrag(e) {
    if (e.target.closest('.win-controls')) return;
    e.preventDefault();
    focusWindow(win.id);
    const el = ref.current;
    const startX = e.clientX, startY = e.clientY;
    // 指针按下时的几何（最大化 / 吸附态下是铺满屏幕的那个，不是还原后的）
    const from = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    const special = !!(rect.max || win.snap);
    let ox = rect.x, oy = rect.y, ww = rect.w;
    let moved = false;
    let zone = null;
    // 从最大化 / 吸附拖出时先离开触发区，再重新武装吸附判定：
    // 否则刚还原的窗口还在 y ≤ 8 的顶边带上，会立刻又弹出最大化预览。
    let armed = !special;

    const clampX = (v) => Math.min(Math.max(v, -(ww - 120)), window.innerWidth - 120);
    const clampY = (v) => Math.min(Math.max(v, SHELL_TOP_H), window.innerHeight - SHELL_BOTTOM_H - TITLEBAR_MIN_VISIBLE);

    // 拖离边缘 / 顶部：先把窗口放回 restoreRect，再让指针保持原来的锚点继续拖。
    // 水平按「指针在标题栏里的相对位置」等比映射，垂直用标题栏内的抓取偏移；
    // 锚点始终以 pointerdown 那一刻算（不能拿当前事件重设 startX，否则会丢掉
    // 首个 pointermove 之前的那段位移，窗口会落后几个像素）。
    const restoreForDrag = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const tw = Math.min(Math.max(win.restoreRect?.w ?? Math.min(vw - 80, 860), win.minW ?? 320), vw - 20);
      const th = Math.min(Math.max(win.restoreRect?.h ?? Math.min(vh - SHELL_BOTTOM_H - 60, 560), win.minH ?? 240), vh - SHELL_BOTTOM_H - 20);
      ww = tw;
      const ratio = Math.min(1, Math.max(0, (startX - from.x) / Math.max(1, from.w)));
      const x = clampX(startX - ratio * tw);
      const y = clampY(from.y);
      beginMoveFromSpecial(win.id, { x, y, w: tw, h: th });
      ox = x; oy = y;
    };

    const onMove = (ev) => {
      if (!moved) {
        moved = true;
        if (special) restoreForDrag();
      }
      const nx = clampX(ox + ev.clientX - startX);
      const ny = clampY(oy + ev.clientY - startY);
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
      el._drag = { x: nx, y: ny };

      const hit = snapZoneAt(ev);
      if (!armed && !hit) armed = true;
      const next = armed ? hit : null;
      if (next !== zone) {
        zone = next;
        if (zone) showSnapPreview(previewFor(zone)); else hideSnapPreview();
      }
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      hideSnapPreview();
      const committed = zone;
      zone = null;
      // 吸附 / 最大化只在这里提交，拖动途中不落库
      if (committed) {
        el._drag = null;
        applySnap(win.id, committed);
        return;
      }
      if (el._drag) commitRect(win.id, { x: el._drag.x, y: el._drag.y });
      el._drag = null;
    };
    // 指针被系统取消（如窗口失焦）：不提交吸附，但已拖到的位置要落下来
    const onCancel = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      hideSnapPreview();
      zone = null;
      if (el._drag) commitRect(win.id, { x: el._drag.x, y: el._drag.y });
      el._drag = null;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
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
      if (dir.includes('n')) { h = Math.max(minH, o.h - dy); y = Math.max(SHELL_TOP_H, o.y + (o.h - h)); }
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
    ? { left: 0, top: SHELL_TOP_H, width: '100vw', height: `calc(100vh - ${SHELL_BOTTOM_H}px)`, zIndex: win.z }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z };

  return (
    <div
      ref={ref}
      className={`window${focused ? ' focused' : ''}${win.minimized ? ' minimized' : ''}${rect.max ? ' maximized' : ''}${win.snap ? ` snapped snap-${win.snap}` : ''}`}
      data-snap={win.snap || ''}
      data-win-id={win.id}
      style={style}
      onPointerDown={() => focusWindow(win.id)}
    >
      <div className="window-titlebar" onPointerDown={startDrag} onDoubleClick={() => toggleMaxWindow(win.id)}>
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
