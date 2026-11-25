import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, closeContextMenu } from '../store.js';

// 右键菜单：支持「一层层展开」的子菜单。
//
// 向后兼容：扁平 items + 字符串 '-' 分隔符照旧（Finder.jsx / Taskbar.jsx 还在用）。
// 新能力：{ label, items: [...] } —— 只要有 items 就当成子菜单，悬浮展开、可键盘进出。
//
// 定位：每次展开 / 关闭 / 窗口缩放都在 useLayoutEffect 里重算一遍。
// 子菜单优先贴父项的右侧，右边放不下就翻到左侧；下方放不下就上移。R10。

const EDGE = 8;       // 与视口边缘至少留 8px
const OVERLAP = 2;    // 子菜单与父项重叠 2px，鼠标移动不会踩空

// 跳过分隔符与禁用项；dir = 1 向下 / -1 向上，找不到返回 -1
function seek(items, from, dir) {
  const n = items?.length || 0;
  if (!n) return -1;
  const start = from < 0 ? (dir > 0 ? -1 : 0) : from;
  for (let k = 1; k <= n; k++) {
    const idx = ((start + dir * k) % n + n) % n;
    const it = items[idx];
    if (it && it !== '-' && !it.disabled) return idx;
  }
  return -1;
}

function hasSub(item) {
  return !!item && item !== '-' && Array.isArray(item.items) && item.items.length > 0;
}

export default function ContextMenu() {
  const s = useStore();
  const { x, y, items } = s.contextMenu;

  const rootRef = useRef(null);
  const panelRefs = useRef([]);
  const itemRefs = useRef({});        // key = `${level}:${index}`
  const [path, setPath] = useState([]);      // 已展开的子菜单链：每层被展开的项下标
  // 初始不高亮任何项：鼠标右键弹出菜单时，Win11 不会预选一项（以前取第一个可用项，
  // 结果碰到「复制(禁用) + 粘贴」这种菜单，一打开「粘贴」就是蓝底，看起来像被点中了）。
  // 键盘 ↓/↑ 或鼠标移到某一项上才出现高亮。
  const [cursor, setCursor] = useState(() => [-1]);
  const [positions, setPositions] = useState([]);
  const [viewport, setViewport] = useState(() => [window.innerWidth, window.innerHeight]);

  // 当前所有可见层：第 0 层是根菜单，后面每层由 path 逐个解析出来
  const levels = useMemo(() => {
    const out = [{ level: 0, items }];
    let cur = items;
    for (let l = 0; l < path.length; l++) {
      const it = cur?.[path[l]];
      if (!hasSub(it)) break;
      cur = it.items;
      out.push({ level: l + 1, items: cur });
    }
    return out;
  }, [items, path]);

  const focusLevel = path.length;

  // ---------- 定位：根菜单夹在视口内；子菜单右/下溢出时翻转 ----------
  useLayoutEffect(() => {
    const panels = panelRefs.current.slice(0, levels.length);
    if (panels.length !== levels.length || panels.some((el) => !el)) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const next = [];
    for (let l = 0; l < levels.length; l++) {
      const el = panels[l];
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (l === 0) {
        // 根菜单贴着鼠标出现；贴近右/下边缘时整块收回视口（不改锚点语义）
        next.push({
          left: Math.max(EDGE, Math.min(x, vw - w - EDGE)),
          top: Math.max(EDGE, Math.min(y, vh - h - EDGE)),
        });
        continue;
      }
      const parent = itemRefs.current[`${l - 1}:${path[l - 1]}`];
      const pr = parent?.getBoundingClientRect();
      if (!pr) {
        next.push({ left: EDGE, top: EDGE });
        continue;
      }
      // 默认向右展开；右边放不下 → 翻到父项左侧（不是硬挤在右边）
      let left = pr.right - OVERLAP;
      if (left + w > vw - EDGE) left = pr.left - w + OVERLAP;
      left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
      // 下边放不下 → 上移，最后仍夹在视口内
      let top = pr.top - 4;
      if (top + h > vh - EDGE) top = vh - h - EDGE;
      top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
      next.push({ left, top });
    }
    setPositions(next);
  }, [levels, path, x, y, viewport]);

  // 窗口尺寸变化要重算：R10 的「收敛」不只在子菜单展开时，缩放也一样
  useEffect(() => {
    const onResize = () => setViewport([window.innerWidth, window.innerHeight]);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 键盘把高亮移出可视区时，让所在面板跟一下（长菜单 / 小窗口）
  useEffect(() => {
    if (!positions[focusLevel]) return;
    const key = `${focusLevel}:${cursor[focusLevel]}`;
    itemRefs.current[key]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [cursor, focusLevel, positions]);

  // ---------- 交互 ----------
  const setCursorAt = useCallback((level, idx) => {
    setCursor((prev) => {
      const out = prev.slice(0, level + 1);
      while (out.length < level) out.push(-1);
      out[level] = idx;
      return out;
    });
  }, []);

  // 展开第 level 层里下标 idx 的子菜单；同时收掉这一层的兄弟子菜单。
  // focusFirst：只有键盘（→ / Enter）展开时才预选子菜单第一项；鼠标悬浮展开不预选。
  const openSub = useCallback((level, idx, focusFirst = false) => {
    const sub = levels[level]?.items?.[idx]?.items;
    if (!Array.isArray(sub) || sub.length === 0) return;
    const nextPath = [...path.slice(0, level), idx];
    setPath(nextPath);
    setCursor((prev) => {
      const out = prev.slice(0, level + 1);
      while (out.length < level) out.push(-1);
      out[level] = idx;
      out[level + 1] = focusFirst ? seek(sub, -1, 1) : -1;
      return out;
    });
  }, [levels, path]);

  // 收掉最深的一层子菜单（父项保持高亮）
  const closeDeepest = useCallback(() => {
    setPath((p) => p.slice(0, -1));
    setCursor((c) => c.slice(0, Math.max(1, c.length - 1)));
  }, []);

  const pick = useCallback((item) => {
    if (!item || item === '-' || item.disabled) return;
    if (hasSub(item)) return;
    closeContextMenu();
    item.action?.();
  }, []);

  // 鼠标移入某一项：先把同层的旧子菜单关掉，再看这一项有没有子菜单
  const hoverItem = useCallback((level, idx) => {
    const item = levels[level]?.items?.[idx];
    if (!item || item === '-') return;
    setCursor((prev) => {
      const out = prev.slice(0, level + 1);
      while (out.length < level) out.push(-1);
      out[level] = idx;
      return out;
    });
    // 指针回到上层某一项：深层链全部作废
    if (path.length > level) setPath(path.slice(0, level));
    if (item.disabled) return;
    if (hasSub(item)) openSub(level, idx);
  }, [levels, path, openSub]);

  // 鼠标在面板内移动：高亮跟着指针走，停在禁用项/分隔符上方就不高亮任何项。
  // 不用每项的 onMouseEnter 是因为 disabled 按钮不派发鼠标事件（CSS 里又给它加了
  // pointer-events:none），事件会落到面板上；用面板级的 mousemove 才能把「移到置灰项」
  // 也当成一次指针移动，而不是把上一次的高亮卡在那儿。
  const onPanelMove = useCallback((level) => (e) => {
    const btn = e.target.closest?.('[data-ctx-index]');
    const idx = btn ? Number(btn.dataset.ctxIndex) : -1;
    const item = idx >= 0 ? levels[level]?.items?.[idx] : null;
    if (!item || item === '-' || item.disabled) {
      if (cursor[level] !== -1) setCursorAt(level, -1);
      return;
    }
    // 同一项上的连续 mousemove 不再触发状态更新，更不要把已展开的子菜单关掉再开
    if (cursor[level] === idx && (path.length <= level || path[level] === idx)) return;
    hoverItem(level, idx);
  }, [levels, cursor, path, hoverItem, setCursorAt]);

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (e) => {
      const level = path.length;
      const list = levels[level]?.items || [];
      const idx = cursor[level];
      const stop = () => { e.preventDefault(); e.stopPropagation(); };

      if (e.key === 'Escape') {
        stop();
        if (level > 0) closeDeepest();
        else closeContextMenu();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        const next = seek(list, idx ?? -1, e.key === 'ArrowDown' ? 1 : -1);
        if (next >= 0) setCursorAt(level, next);
        return;
      }
      if (e.key === 'ArrowRight') {
        stop();
        const item = list[idx];
        if (hasSub(item) && !item.disabled) openSub(level, idx, true);
        return;
      }
      if (e.key === 'ArrowLeft') {
        stop();
        if (level > 0) closeDeepest();
        return;
      }
      if (e.key === 'Enter') {
        stop();
        const item = list[idx];
        if (!item || item === '-' || item.disabled) return;
        if (hasSub(item)) openSub(level, idx, true);
        else pick(item);
        return;
      }
      if (e.key === 'Home' || e.key === 'End') {
        stop();
        // Home：从头部找；End：从尾部倒着找
        const target = e.key === 'Home' ? seek(list, -1, 1) : (() => {
          for (let i = list.length - 1; i >= 0; i--) {
            const it = list[i];
            if (it && it !== '-' && !it.disabled) return i;
          }
          return -1;
        })();
        if (target >= 0) setCursorAt(level, target);
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [path, cursor, levels, closeDeepest, openSub, pick, setCursorAt]);

  // 点击菜单外任何位置都关闭（capture 阶段，先于按钮的 onClick）
  useEffect(() => {
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) closeContextMenu();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);

  return (
    <div className="ctx-root" ref={rootRef}>
      {levels.map(({ level, items: list }) => {
        const pos = positions[level];
        return (
          <div
            key={level}
            ref={(el) => { panelRefs.current[level] = el; }}
            className="context-menu"
            data-ctx-level={level}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }}
            role="menu"
            aria-label={level === 0 ? '右键菜单' : '子菜单'}
            onContextMenu={(e) => e.preventDefault()}
            onMouseMove={onPanelMove(level)}
          >
            {list.map((item, i) => item === '-'
              ? <div key={i} className="dropdown-sep" role="separator" />
              : (
                <button
                  key={i}
                  ref={(el) => {
                    if (el) itemRefs.current[`${level}:${i}`] = el;
                    else delete itemRefs.current[`${level}:${i}`];
                  }}
                  type="button"
                  role="menuitem"
                  aria-haspopup={hasSub(item) ? 'menu' : undefined}
                  aria-expanded={hasSub(item) ? path[level] === i : undefined}
                  className={[
                    'dropdown-item',
                    item.danger ? 'danger' : '',
                    hasSub(item) ? 'ctx-has-sub' : '',
                    cursor[level] === i ? 'ctx-active' : '',
                  ].filter(Boolean).join(' ')}
                  disabled={item.disabled}
                  data-ctx-index={i}
                  data-label={item.label}
                  onClick={() => {
                    if (item.disabled) return;
                    if (hasSub(item)) openSub(level, i);
                    else pick(item);
                  }}
                >
                  <span className="di-check">{item.checked ? '✓' : ''}</span>
                  {item.label}
                  {item.hint && <span className="di-hint">{item.hint}</span>}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}
