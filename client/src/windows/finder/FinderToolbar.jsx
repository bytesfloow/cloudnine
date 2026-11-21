import React from 'react';
import { IconSearch, IconChevron } from '../../icons.jsx';

// 文件资源管理器 · 地址栏（docs/win11-interaction-spec.md §1.4 第一行）
//
//   [←] [→] [↑]  本机 › 用户 › docs   [搜索框]
//
// 后退/前进走本地历史栈；「↑」直接 act('goParent')，点地址栏空白处 act('goFolder')，
// 后退/前进之外的动作全部经 act()，与命令栏共用同一条执行路径。
//
// ⚠️ R5：`.finder-search input` 这个选择器必须保留——`act('focus-search')` 靠它做
// DOM 查询（Ctrl+F / F3），改类名会让快捷键静默失效。
export default function FinderToolbar({
  hIdx, history, back, fwd, crumbs, onCrumb, act, isTrash, query, searchMode, setQuery, runSearch,
}) {
  return (
    <div className="finder-toolbar">
      <button className="tb-btn" disabled={hIdx === 0} onClick={back} title="后退"><IconChevron dir="left" /></button>
      <button className="tb-btn" disabled={hIdx >= history.length - 1} onClick={fwd} title="前进"><IconChevron /></button>
      <button className="tb-btn" onClick={() => act('goParent')} title="上一级（Alt+↑）"><IconChevron dir="up" /></button>

      {/* 点空白处 = 前往文件夹（Win11 地址栏点空白变可编辑路径） */}
      <div
        className="finder-crumbs finder-address"
        data-act="goFolder"
        title="点击空白处可输入路径（前往文件夹…）"
        onClick={(e) => { if (e.target === e.currentTarget) act('goFolder'); }}
      >
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 && <IconChevron size={9} />}
            {c.dir == null
              ? <span className="crumb crumb-static">{c.label}</span>
              : <button className="crumb" onClick={() => !isTrash && onCrumb(c.dir)}>{c.label}</button>}
          </React.Fragment>
        ))}
        {searchMode && <span className="crumb-note">搜索“{query}”的结果</span>}
      </div>

      <div className="finder-search">
        <IconSearch />
        <input
          value={query}
          placeholder={isTrash ? '过滤废纸篓' : '搜索（回车递归搜索）'}
          onChange={(e) => { if (!searchMode) setQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch(e.target.value);
            if (e.key === 'Escape') runSearch('');
          }}
        />
        {query && <button className="clear-btn" onMouseDown={(e) => { e.preventDefault(); runSearch(''); }}>×</button>}
      </div>
    </div>
  );
}
