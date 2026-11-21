import React from 'react';
import { useStore } from '../store.js';
import { IconFiles, IconTerminal, IconEditor, IconEye, IconInfo, IconTransfer, IconShare, IconDisk } from '../icons.jsx';

// Alt+Tab 窗口切换器（docs §5.1 状态表）。
// 只列非最小化窗口，顺序 = store.recent（最近使用）；选中项高亮，
// 松开 Alt 由 store.commitAltTab 落到焦点，Esc 由 closeAltTab 取消。
const ICONS = {
  finder: IconFiles,
  terminal: IconTerminal,
  editor: IconEditor,
  preview: IconEye,
  info: IconInfo,
  transfers: IconTransfer,
  shares: IconShare,
  disk: IconDisk,
};
const LABELS = {
  finder: '文件', terminal: '终端', editor: '记事本', preview: '预览',
  info: '属性', transfers: '传输', shares: '分享管理', disk: '磁盘监控',
};

export default function AltTab() {
  const s = useStore();
  const t = s.altTab;
  if (!t) return null;
  const wins = t.ids.map((id) => s.windows.find((w) => w.id === id)).filter(Boolean);
  if (!wins.length) return null;
  const index = Math.min(t.index, wins.length - 1);
  return (
    <div className="alt-tab" role="dialog" aria-label="窗口切换器">
      <div className={`alt-tab-panel${wins.length > 6 ? ' scroll' : ''}`}>
        {wins.map((w, i) => {
          const Icon = ICONS[w.type] || IconFiles;
          const state = w.snap ? (w.snap === 'left' ? '左半屏' : '右半屏') : w.rect.max ? '最大化' : '';
          return (
            <div key={w.id} className={`alt-tab-item${i === index ? ' sel' : ''}`} data-win-id={w.id} data-win-type={w.type}>
              <span className="alt-tab-icon"><Icon size={22} /></span>
              <span className="alt-tab-meta">
                <b className="alt-tab-title">{w.title}</b>
                <span className="alt-tab-type">{LABELS[w.type] || w.type}{state ? ` · ${state}` : ''}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="alt-tab-hint">松开 Alt 切换 · Tab 循环 · Esc 取消</div>
    </div>
  );
}
