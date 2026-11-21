import React from 'react';
import { IconSearch, IconChevron, IconGrid, IconList, IconRefresh, IconNewFolder, IconUpload } from '../../icons.jsx';

// 文件资源管理器 · 命令栏
// 后退/前进、新建文件夹、上传、图标/列表视图切换、搜索、刷新、排序。
// 所有动作都由父组件（Finder）传入，组件本身不持有状态。
export default function FinderToolbar({
  hIdx, history, back, fwd, isTrash, newItem, pickUpload,
  view, setView, query, searchMode, setQuery, runSearch, load, sortMenu,
}) {
  return (
    <div className="finder-toolbar">
      <button className="tb-btn" disabled={hIdx === 0} onClick={back} title="后退"><IconChevron dir="left" /></button>
      <button className="tb-btn" disabled={hIdx >= history.length - 1} onClick={fwd} title="前进"><IconChevron /></button>
      {!isTrash && (
        <>
          <button className="tb-btn" onClick={() => newItem('dir')} title="新建文件夹"><IconNewFolder /></button>
          <button className="tb-btn" onClick={() => pickUpload(false)} title="上传文件"><IconUpload /></button>
        </>
      )}
      <div className="tb-view">
        <button className={`tb-btn${view === 'icon' ? ' active' : ''}`} onClick={() => setView('icon')} title="图标视图"><IconGrid /></button>
        <button className={`tb-btn${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')} title="列表视图"><IconList /></button>
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
      <button className="tb-btn" onClick={() => load()} title="刷新"><IconRefresh /></button>
      <button className="tb-btn" onClick={(e) => sortMenu(e)} title="排序方式">⇅</button>
    </div>
  );
}
