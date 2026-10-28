import React, { useEffect, useRef, useState } from 'react';
import { useStore, closeContextMenu } from '../store.js';

export default function ContextMenu() {
  const s = useStore();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const { x, y, items } = s.contextMenu;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    });
    const close = (e) => { if (!el.contains(e.target)) closeContextMenu(); };
    const onKey = (e) => e.key === 'Escape' && closeContextMenu();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, []);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: 'hidden' }}
    >
      {items.map((item, i) => item === '-'
        ? <div key={i} className="dropdown-sep" />
        : (
          <button
            key={i}
            className={`dropdown-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => { closeContextMenu(); item.action?.(); }}
          >
            <span className="di-check">{item.checked ? '✓' : ''}</span>
            {item.label}
          </button>
        ))}
    </div>
  );
}
