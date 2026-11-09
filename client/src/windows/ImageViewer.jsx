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
  const imgRef = useRef(null);
  const pointers = useRef(new Map()); // 当前按下的指针（鼠标/触摸）
  const gesture = useRef(null); // 手势基线
  const lastTap = useRef(null); // 上一次轻点（用于判定双击复位）
  const multiTouch = useRef(false); // 本轮触摸是否出现过第二根手指（双指手势不算轻点）
  const live = useRef({ zoom: view.zoom, pan: { x: view.pan?.x || 0, y: view.pan?.y || 0 }, rotate: view.rotate || 0 }); // 手势过程中的实时值
  const viewRef = useRef(view);
  const gesturing = useRef(false); // 手势进行中：外部状态不得回灌，否则画面会跳
  const [dragging, setDragging] = useState(false);
  viewRef.current = view;

  // 画面变换直接写 DOM style：
  // 拖动过程中不触发 React 重渲染，避免整个预览窗口（含 backdrop-filter 模糊背景）
  // 每移动一像素就整窗重绘，既卡顿又容易在合成层上留下残影。
  const paint = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const { zoom, pan, rotate } = live.current;
    el.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotate}deg)`;
  }, []);

  // 外部改动（缩放工具条 / 旋转 / 复位 / 切换文件）→ 同步到手势实时值并重绘
  useEffect(() => {
    if (gesturing.current) return;
    live.current = { zoom: view.zoom, pan: { x: view.pan?.x || 0, y: view.pan?.y || 0 }, rotate: view.rotate || 0 };
    paint();
  }, [view.zoom, view.pan?.x, view.pan?.y, view.rotate, paint]);

  // 以锚点缩放：锚点相对舞台中心的偏移
  const applyZoom = useCallback((factor, anchor) => {
    const cur = live.current;
    const zoom = clamp(cur.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const f = zoom / cur.zoom;
    const pan = {
      x: anchor.x - f * (anchor.x - cur.pan.x),
      y: anchor.y - f * (anchor.y - cur.pan.y),
    };
    live.current = { zoom, pan, rotate: cur.rotate };
    paint();
    // 缩放值要实时反映到工具条百分比上，这里仍需同步给共享状态
    viewRef.current.setZoom(zoom);
    viewRef.current.setPan(pan);
  }, [paint]);

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
    live.current = { zoom: 1, pan: { x: 0, y: 0 }, rotate: live.current.rotate };
    paint();
    viewRef.current.setZoom(1);
    viewRef.current.setPan({ x: 0, y: 0 });
  }, [paint]);

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 阻止浏览器的默认行为：否则按住图片拖动会被浏览器接管成原生 HTML5 拖拽，
    // 指针被浏览器截走后页面收不到 pointermove，图片就拖不动，
    // 同时浏览器还会拖出一个半透明的图片重影。
    e.preventDefault();
    if (pointers.current.size === 0) multiTouch.current = false; // 新的一轮触摸
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 某些浏览器不支持捕获 */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesturing.current = true;
    const cur = live.current;
    if (pointers.current.size === 1) {
      gesture.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, startPan: { ...cur.pan } };
      setDragging(true);
    } else if (pointers.current.size === 2) {
      // 第二根手指落下 = 双指手势：清掉待判定的轻点，
      // 否则双指缩放抬手会被记成一次轻点，紧接着的滑动就被误判成「双击复位」
      multiTouch.current = true;
      lastTap.current = null;
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
      // 平移只改画面，不动共享状态：拖动期间不触发任何 React 重渲染
      live.current = { ...live.current, pan };
      paint();
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
    live.current = { zoom, pan, rotate: live.current.rotate };
    paint();
    // 双指缩放要实时反映到工具条百分比上
    viewRef.current.setZoom(zoom);
  };

  const onPointerEnd = (e) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    // 轻点判定：必须是「单指 + 几乎没移动」的抬手。
    // 双指缩放（multiTouch）后的抬手不算轻点，否则会被下一次快速点击凑成「双击复位」。
    const isTap = g && g.mode === 'pan' && !multiTouch.current
      && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 8;
    if (isTap) {
      // 双击复位：不依赖 dblclick（Safari 触屏不派发该事件），在第二次抬手时判定
      const lt = lastTap.current;
      if (lt && e.timeStamp - lt.t < 400 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
        lastTap.current = null;
        resetView();
      } else {
        // 原地轻点：记为「点击」，供下一次快速点击判定双击
        lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      }
    } else {
      // 拖动或双指手势：打断轻点序列，避免紧接着的抬手被误判成双击
      lastTap.current = null;
    }
    if (pointers.current.size === 0) {
      gesture.current = null;
      gesturing.current = false;
      setDragging(false);
      // 手势收尾：把最终平移/缩放提交回共享状态（工具条、复位、切换文件都依赖它）
      viewRef.current.setPan({ ...live.current.pan });
      viewRef.current.setZoom(live.current.zoom);
    } else if (pointers.current.size === 1) {
      // 从双指回到单指：以剩余手指为新的拖拽起点，避免画面跳动
      const [p] = [...pointers.current.values()];
      gesture.current = { mode: 'pan', startX: p.x, startY: p.y, startPan: { ...live.current.pan } };
    }
  };

  // 鼠标双击复位（触屏由上面的手动判定覆盖）
  const onDoubleClick = () => resetView();

  return (
    <div
      ref={stageRef}
      className={`preview-stage${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onDoubleClick}
      // 兜底：任何落到预览区里的原生拖拽一律掐掉，避免浏览器接管指针后图片拖不动
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}
