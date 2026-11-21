import React from 'react';
import { openContextMenu } from '../../store.js';
import { IconMore, IconChevron } from '../../icons.jsx';

// 文件资源管理器 · 命令栏（docs/win11-interaction-spec.md §1.4 的五组结构）
//
//   新建 ▸ │ 上传文件… 上传文件夹… │ 剪切 复制 粘贴 ▾ │ 重命名 删除 │ 排序 ▸ 查看 ▾ ⋯
//
// 组件本身不持有任何状态：视图 / 排序 / 隐藏文件 / 剪贴板全部由 Finder.jsx 传入，
// 每个按钮都只翻译成 act(action)，落到 Finder.jsx 里既有的动作分支——
// 不在这里另写一套平行业务逻辑（否则命令栏与窗口内会各走一条代码路径）。
// 下拉统一走全局 ContextMenu（T5 已支持子菜单 / 键盘 / 边缘翻转），这里只负责摆按钮。
//
// 回收站视图换一组按钮（还原 / 彻底删除 / 清空回收站），与 Win11 回收站命令栏一致。

const mi = (label, action, extra = {}) => ({ label, action, ...extra });

function openAt(e, items) {
  const r = e.currentTarget.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 2, items);
}

function Btn({ label, onClick, disabled, title, caret, more, danger }) {
  return (
    <button
      type="button"
      className={`cmd-btn${danger ? ' danger' : ''}`}
      data-cmd={label}
      disabled={disabled}
      title={title || label}
      onClick={onClick}
    >
      {more ? <IconMore size={15} /> : label}
      {caret && <span className="cmd-caret" aria-hidden="true"><IconChevron dir="down" size={8} /></span>}
    </button>
  );
}

export default function FinderCommandBar({
  isTrash, selCount, clipboard, showHidden, view, act, sortItems, onDeleteForever,
}) {
  const hasSel = selCount > 0;
  const cb = clipboard;

  const viewItems = () => [
    mi('图标', () => act('viewIcon'), { checked: view === 'icon' }),
    mi('列表', () => act('viewList'), { checked: view === 'list' }),
    '-',
    mi('显示隐藏文件', () => act('toggleHidden'), { checked: !!showHidden }),
    '-',
    mi('刷新', () => act('refresh'), { hint: 'F5' }),
  ];
  const moreItems = () => [
    mi('全选', () => act('selectAll'), { hint: 'Ctrl+A' }),
    '-',
    mi('前往文件夹…', () => act('goFolder'), { hint: 'Ctrl+L' }),
  ];

  const viewBtn = (
    <Btn label="查看" caret title="查看（图标 / 列表 / 显示隐藏文件 / 刷新）"
      onClick={(e) => openAt(e, viewItems())} />
  );

  // 回收站视图：只留能用的动作（新建/上传/剪贴板在这里没有意义）
  if (isTrash) {
    return (
      <div className="finder-cmdbar" role="toolbar" aria-label="命令栏">
        <div className="cmd-group">
          <Btn label="还原" title="放回原处" disabled={!hasSel} onClick={() => act('restore')} />
          <Btn label="彻底删除…" title="彻底删除选中的项目" danger disabled={!hasSel} onClick={onDeleteForever} />
          <Btn label="清空回收站…" danger onClick={() => act('emptyTrash')} />
        </div>
        <span className="cmd-sep" />
        <div className="cmd-group">{viewBtn}</div>
      </div>
    );
  }

  return (
    <div className="finder-cmdbar" role="toolbar" aria-label="命令栏">
      {/* 1. 新建 */}
      <div className="cmd-group">
        <Btn label="新建" caret title="新建（文件夹 / 文本文档）" onClick={(e) => openAt(e, [
          mi('文件夹', () => act('newFolder')),
          mi('文本文档', () => act('newFile')),
        ])} />
      </div>
      <span className="cmd-sep" />

      {/* 2. 上传 */}
      <div className="cmd-group">
        <Btn label="上传文件…" onClick={() => act('uploadFile')} />
        <Btn label="上传文件夹…" onClick={() => act('uploadFolder')} />
      </div>
      <span className="cmd-sep" />

      {/* 3. 剪贴板：粘贴是分裂按钮，右半边下拉保留「粘贴为副本」 */}
      <div className="cmd-group">
        <Btn label="剪切" title="剪切（Ctrl+X）" disabled={!hasSel} onClick={() => act('cut')} />
        <Btn label="复制" title="复制（Ctrl+C）" disabled={!hasSel} onClick={() => act('copy')} />
        <span className="cmd-split">
          <Btn label="粘贴" title="粘贴（Ctrl+V）" disabled={!cb} onClick={() => act('paste')} />
          <button
            type="button"
            className="cmd-btn cmd-split-caret"
            data-cmd="粘贴选项"
            title="粘贴选项"
            onClick={(e) => openAt(e, [
              mi('粘贴为副本', () => act('pasteCopy'), { disabled: !cb || cb.mode !== 'copy' }),
              '-',
              mi('清空剪贴板', () => act('clearClipboard'), { disabled: !cb }),
            ])}
          ><IconChevron dir="down" size={8} /></button>
        </span>
      </div>
      <span className="cmd-sep" />

      {/* 4. 重命名 / 删除 */}
      <div className="cmd-group">
        <Btn label="重命名" title="重命名（F2）" disabled={selCount !== 1} onClick={() => act('rename')} />
        <Btn label="删除" title="删除（移入回收站）" danger disabled={!hasSel} onClick={() => act('trash')} />
      </div>
      <span className="cmd-sep" />

      {/* 5. 排序 / 查看 / 更多 */}
      <div className="cmd-group">
        <Btn label="排序" caret title="排序方式" onClick={(e) => openAt(e, sortItems())} />
        {viewBtn}
        <Btn label="更多" more title="更多操作" onClick={(e) => openAt(e, moreItems())} />
      </div>
    </div>
  );
}
