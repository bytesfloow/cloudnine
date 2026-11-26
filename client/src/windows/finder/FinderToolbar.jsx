import React, { useEffect, useRef, useState } from 'react';
import { openContextMenu } from '../../store.js';
import { IconChevron } from '../../icons.jsx';

// 文件资源管理器 · 地址行（docs/design/finder-toolbar.md §3.1 第一行，高 34）
//
//   [←] [→] [↑] │ 主目录 › … › windows › finder
//
// 后退/前进走本地历史栈；「↑」直接 act('goParent')，点地址药丸空白处 act('goFolder')，
// 后退/前进之外的动作全部经 act()，与命令栏共用同一条执行路径。
//
// 长路径折叠：段数放不下时折成「首段 … 末 N 段」。末 N 段跟着地址药丸的实测宽度走
// （<620 保 1 段，否则保 2 段），点「…」弹出被折叠的段（不能横向铺开，否则挤成一排省略号），
// 点其中一段仍然走 onCrumb(c.dir) —— 与直接点面包屑是同一条导航路径。
//
// ⚠️ R5：`.finder-search input` 那个选择器在命令栏（FinderCommandBar）里，`act('focus-search')`
// 靠它做 DOM 查询（Ctrl+F / F3）。搜索框从地址行搬到了命令行，选择器本身没有改名。
export default function FinderToolbar({
  hIdx, history, back, fwd, crumbs, onCrumb, act, isTrash, query, searchMode,
}) {
  const pillRef = useRef(null);
  const [pillW, setPillW] = useState(1200);

  useEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    setPillW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPillW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const keep = pillW < 620 ? 1 : 2;
  // 只有折叠能省下至少两段时才折：段数 = keep + 2 时折起来反而更占地方
  const folding = crumbs.length > keep + 2;
  const hidden = folding ? crumbs.slice(1, crumbs.length - keep) : [];
  const shown = folding ? [crumbs[0], null, ...crumbs.slice(crumbs.length - keep)] : crumbs;

  function openFolded(e) {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 2, hidden.map((c) => ({
      label: c.label,
      action: () => { if (c.dir != null) onCrumb(c.dir); },
    })));
  }

  return (
    <div className="finder-toolbar" role="toolbar" aria-label="地址栏">
      <div className="fx-nav">
        <button className="tb-btn" disabled={hIdx === 0} onClick={back} title="后退（Alt+←）"><IconChevron dir="left" /></button>
        <button className="tb-btn" disabled={hIdx >= history.length - 1} onClick={fwd} title="前进（Alt+→）"><IconChevron /></button>
        <button className="tb-btn" onClick={() => act('goParent')} title="上一级（Alt+↑）"><IconChevron dir="up" /></button>
      </div>
      <span className="tb-sep" aria-hidden="true" />

      {/* 点空白处 = 前往文件夹（Win11 地址栏点空白变可编辑路径） */}
      <div
        className="finder-address"
        ref={pillRef}
        data-act="goFolder"
        title="点击空白处可输入路径（前往文件夹…）"
        onClick={(e) => { if (e.target === e.currentTarget) act('goFolder'); }}
      >
        {shown.map((c, i) => (
          <React.Fragment key={c ? `${c.label}-${c.dir}` : 'fold'}>
            {i > 0 && <span className="crumb-sep" aria-hidden="true"><IconChevron size={9} /></span>}
            {c === null ? (
              <button
                type="button"
                className="crumb crumb-more"
                data-crumb="folded"
                title={`展开被折叠的 ${hidden.length} 级`}
                aria-label={`展开被折叠的 ${hidden.length} 级路径`}
                onClick={openFolded}
              >…</button>
            ) : c.dir == null ? (
              <span className="crumb crumb-static">{c.label}</span>
            ) : (
              <button
                type="button"
                className={`crumb${i === shown.length - 1 ? ' current' : ''}`}
                onClick={() => !isTrash && onCrumb(c.dir)}
              ><span>{c.label}</span></button>
            )}
          </React.Fragment>
        ))}
        {searchMode && <span className="crumb-note">搜索“{query}”的结果</span>}
      </div>
    </div>
  );
}
