import React from 'react';
import { useStore } from '../store.js';
import { appForWindow, AppIcon } from '../apps/registry.jsx';

// Alt+Tab 窗口切换器（docs §5.1 状态表）。
// 只列非最小化窗口，顺序 = store.recent（最近使用）；选中项高亮，
// 松开 Alt 由 store.commitAltTab 落到焦点，Esc 由 closeAltTab 取消。
// 图标 / 插件名来自应用注册表（apps/registry.jsx）；下面的 LABELS 是切换器里的
// 「类型短标签」，比应用全名短，保持改造前的文案不变。
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
          const app = appForWindow(w, s.plugins);
          const state = w.snap ? (w.snap === 'left' ? '左半屏' : '右半屏') : w.rect.max ? '最大化' : '';
          // 插件窗口直接用插件名（appForWindow 对 plugin 类型返回对应插件的记录）
          const label = app?.isPlugin ? app.name : (LABELS[w.type] || w.type);
          return (
            <div key={w.id} className={`alt-tab-item${i === index ? ' sel' : ''}`} data-win-id={w.id} data-win-type={w.type}>
              <span className="alt-tab-icon">{app ? <AppIcon app={app} size={22} /> : null}</span>
              <span className="alt-tab-meta">
                <b className="alt-tab-title">{w.title}</b>
                <span className="alt-tab-type">{label}{state ? ` · ${state}` : ''}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="alt-tab-hint">松开 Alt 切换 · Tab 循环 · Esc 取消</div>
    </div>
  );
}
