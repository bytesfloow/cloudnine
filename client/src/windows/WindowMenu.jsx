import React from 'react';
import { openContextMenu } from '../store.js';

// 窗口内菜单（docs/win11-interaction-spec.md §1.6）
//
// 按钮只负责把下拉摆在自己的下方；下拉本身复用全局 ContextMenu——
// 子菜单、方向键 / 回车 / Esc、贴边翻转都已经在 T5 里做好，这里不再另造一套弹层。
// 和 FinderCommandBar 走同一个入口（openContextMenu），样式与键盘行为因此完全一致。
export function openMenuAt(e, items) {
  const r = e.currentTarget.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 2, items);
}

// label 为空时只渲染 icon（终端标签栏右侧的 ∨）
export default function WindowMenu({ label, items, title, icon = null, className = '', ariaLabel }) {
  const name = ariaLabel || label || title || '';
  return (
    <button
      type="button"
      className={`winmenu-btn${className ? ` ${className}` : ''}`}
      data-menu={name}
      title={title || name}
      aria-label={name}
      aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); openMenuAt(e, items); }}
    >
      {icon && <span className="winmenu-icon" aria-hidden="true">{icon}</span>}
      {label && <span>{label}</span>}
    </button>
  );
}
