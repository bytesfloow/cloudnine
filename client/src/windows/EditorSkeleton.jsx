import React from 'react';

/* ============================================================================
   编辑器占位骨架
   ----------------------------------------------------------------------------
   出现在两个时刻，两处共用同一份结构与尺寸：
     1. 窗口已经开出来、编辑器 chunk 还在路上的那一段（windows/registry.jsx 的 Suspense 兜底）
     2. chunk 到了、文件内容还在读（Editor.jsx 的 loading 态）
   结构刻意与真实编辑器一一对应（窗口内菜单条 / 行号栏 + 正文行 / 状态栏），
   高度、内边距都按真实布局来，换成编辑器时不会跳版。
   配色只用 --hover / --active 这两档中性色，亮暗主题都只是很轻的一层灰，不刺眼。
   ========================================================================== */

// 正文行宽度：按「代码行的参差」排一遍，不是随机，避免每次 open 都换一个样子
const LINE_WIDTHS = ['58%', '36%', '74%', '28%', '62%', '44%', '80%', '34%', '52%', '22%'];
const GUTTER_ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function EditorSkeleton({ label = '正在打开编辑器' }) {
  return (
    <div className="editor-window ed-skeleton" role="status" aria-busy="true" aria-label={label}>
      <div className="ed-sk-menu">
        <span className="ed-sk-pill" />
        <span className="ed-sk-pill" />
      </div>
      <div className="ed-sk-body">
        <div className="ed-sk-gutter">
          {GUTTER_ROWS.map((i) => <span key={i} />)}
        </div>
        <div className="ed-sk-lines">
          {LINE_WIDTHS.map((w, i) => <span key={i} style={{ width: w }} />)}
        </div>
      </div>
      <div className="ed-sk-status">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
