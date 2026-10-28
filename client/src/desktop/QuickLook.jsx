import React, { useEffect } from 'react';
import { useStore, closeQuickLook, quickLookNav, basename } from '../store.js';
import { PreviewContent } from '../windows/Preview.jsx';

// macOS 式快速预览：空格开、空格/Esc 关、方向键切换
export default function QuickLook() {
  const s = useStore();
  const { paths, index } = s.quickLook;
  const path = paths[index];

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeQuickLook(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') quickLookNav(1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') quickLookNav(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!path) return null;
  return (
    <div className="quicklook-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeQuickLook(); }}>
      <div className="quicklook">
        <div className="quicklook-content">
          <PreviewContent path={path} compact />
        </div>
        <div className="quicklook-footer">
          <button className="btn btn-icon" onClick={() => quickLookNav(-1)} disabled={paths.length < 2}>←</button>
          <span className="quicklook-name">{basename(path)}<em>{index + 1} / {paths.length}</em></span>
          <button className="btn btn-icon" onClick={() => quickLookNav(1)} disabled={paths.length < 2}>→</button>
        </div>
      </div>
    </div>
  );
}
