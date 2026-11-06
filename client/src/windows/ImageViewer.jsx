import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// 图片预览交互：滚轮/双指缩放 + 拖拽平移 + 双击复位
// 缩放以光标（或双指中心）为锚点，保证放大时画面内容不跳动
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// 视图状态：缩放 / 旋转 / 平移
// 预览窗口持有并下传（工具条要读同一份状态）；快速预览与移动端自持一份
export function useImageView() {
  const [state, setState] = useState(() => ({ zoom: 1, rotate: 0, pan: { x: 0, y: 0 } }));

  const setZoom = useCallback((next) => setState((s) => ({
    ...s,
    zoom: clamp(typeof next === 'function' ? next(s.zoom) : next, MIN_ZOOM, MAX_ZOOM),
  })), []);
  const setRotate = useCallback((next) => setState((s) => ({
    ...s,
    rotate: (((typeof next === 'function' ? next(s.rotate) : next) % 360) + 360) % 360,
  })), []);
  const setPan = useCallback((next) => setState((s) => ({
    ...s,
    pan: typeof next === 'function' ? next(s.pan) : next,
  })), []);
  // 复位到「适应窗口」：缩放 100%、平移归零（旋转保留）
  const reset = useCallback(() => setState((s) => ({ ...s, zoom: 1, pan: { x: 0, y: 0 } })), []);

  return useMemo(
    () => ({ zoom: state.zoom, rotate: state.rotate, pan: state.pan, setZoom, setRotate, setPan, reset }),
    [state, setZoom, setRotate, setPan, reset],
  );
}

// 图片舞台：承载缩放/平移的手势
export default function ImageViewer({ src, alt = '', view }) {
  const stageRef = useRef(null);
  const pointers = useRef(new Map()); // 当前按下的指针（鼠标/触摸）
  const gesture = useRef(null); // 手势基线
  const lastTap = useRef(null); // 上一次轻点（用于判定双击复位）
  const live = useRef({ zoom: view.zoom, pan: { ...view.pan } }); // 手势过程中的实时值
  const viewRef = useRef(view);
  const [dragging, setDragging] = useState(false);
  viewRef.current = view;

  // 受控状态（外部改缩放/平移）同步到实时值
  useEffect(() => {
    live.current = { zoom: view.zoom, pan: { x: view.pan?.x || 0, y: view.pan?.y || 0 } };
  }, [view.zoom, view.pan?.x, view.pan?.y]);

  // 以锚点缩放：锚点相对舞台中心的偏移
  const applyZoom = useCallback((factor, anchor) => {
    const cur = live.current;
    const zoom = clamp(cur.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const f = zoom / cur.zoom;
    const pan = {
      x: anchor.x - f * (anchor.x - cur.pan.x),
      y: anchor.y - f * (anchor.y - cur.pan.y),
    };
    live.current = { zoom, pan };
    viewRef.current.setZoom(zoom);
    viewRef.current.setPan(pan);
  }, []);

  // 滚轮缩放：非被动监听才能阻止页面滚动/整页缩放
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      // 触控板捏合会带 ctrlKey，幅度更大
      const k = e.ctrlKey ? 0.01 : 0.0022;
      const factor = Math.exp(-e.deltaY * unit * k);
      const r = el.getBoundingClientRect();
      applyZoom(factor, {
        x: e.clientX - r.left - r.width / 2,
        y: e.clientY - r.top - r.height / 2,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // Safari 手势事件：阻止页面级双指缩放，交给下方指针事件处理
    const onGesture = (e) => e.preventDefault();
    el.addEventListener('gesturestart', onGesture);
    el.addEventListener('gesturechange', onGesture);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGesture);
      el.removeEventListener('gesturechange', onGesture);
    };
  }, [applyZoom]);

  // 复位到「适应窗口」
  const resetView = useCallback(() => {
    live.current = { zoom: 1, pan: { x: 0, y: 0 } };
    viewRef.current.setZoom(1);
    viewRef.current.setPan({ x: 0, y: 0 });
  }, []);

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 双击/双指点击复位：自行判定，不依赖 dblclick（Safari 触屏不派发该事件）
    const lt = lastTap.current;
    if (lt && e.timeStamp - lt.t < 400 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
      lastTap.current = null;
      resetView();
      return;
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 某些浏览器不支持捕获 */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = live.current;
    if (pointers.current.size === 1) {
      gesture.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, startPan: { ...cur.pan } };
      setDragging(true);
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        mode: 'pinch',
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startZoom: cur.zoom,
        startPan: { ...cur.pan },
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = stageRef.current?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 };
    if (g.mode === 'pan') {
      const pan = {
        x: g.startPan.x + (e.clientX - g.startX),
        y: g.startPan.y + (e.clientY - g.startY),
      };
      live.current = { zoom: live.current.zoom, pan };
      viewRef.current.setPan(pan);
      return;
    }
    const pts = [...pointers.current.values()];
    if (pts.length < 2 || !g.startDist) return;
    const [a, b] = pts;
    const zoom = clamp(g.startZoom * (Math.hypot(a.x - b.x, a.y - b.y) / g.startDist), MIN_ZOOM, MAX_ZOOM);
    const f = zoom / g.startZoom;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // 双指中心跟随手指移动，画面内容锚定在两指之间
    const m0 = { x: g.startMid.x - cx, y: g.startMid.y - cy };
    const m1 = { x: (a.x + b.x) / 2 - cx, y: (a.y + b.y) / 2 - cy };
    const pan = {
      x: m1.x - f * (m0.x - g.startPan.x),
      y: m1.y - f * (m0.y - g.startPan.y),
    };
    live.current = { zoom, pan };
    viewRef.current.setZoom(zoom);
    viewRef.current.setPan(pan);
  };

  const onPointerEnd = (e) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g && g.mode === 'pan' && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 8) {
      // 原地轻点：记为「点击」，供下一次快速点击判定双击
      lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }
    if (pointers.current.size === 0) {
      gesture.current = null;
      setDragging(false);
    } else if (pointers.current.size === 1) {
      // 从双指回到单指：以剩余手指为新的拖拽起点，避免画面跳动
      const [p] = [...pointers.current.values()];
      gesture.current = { mode: 'pan', startX: p.x, startY: p.y, startPan: { ...live.current.pan } };
    }
  };

  // 鼠标双击复位（触屏由上面的手动判定覆盖）
  const onDoubleClick = () => resetView();

  const pan = view.pan || { x: 0, y: 0 };
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${view.zoom}) rotate(${view.rotate}deg)`;

  return (
    <div
      ref={stageRef}
      className={`preview-stage${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform }}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}
