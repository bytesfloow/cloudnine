import React, { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { openContextMenu } from '../../store.js';
import {
  IconMore, IconChevron, IconUpload, IconFolderUp, IconFolderPlus, IconPaste, IconCut, IconCopy,
  IconRename, IconDownload, IconTrashLine, IconSort, IconGrid, IconList, IconRefresh, IconSearch,
  IconClose,
} from '../../icons.jsx';

// 文件资源管理器 · 命令行（docs/design/finder-toolbar.md §3.2 第二行，高 40）
//
//   新建 ▾ │ 上传文件… 上传文件夹… │ 剪切 复制 粘贴 ▾ │ 重命名 [下载] 删除 │ 排序 查看 ▾ │ ⋯ 搜索
//
// 组件本身不持有任何业务状态：视图 / 排序 / 隐藏文件 / 剪贴板 / 选中数全部由 Finder.jsx 传入，
// 每个按钮都只翻译成 act(action)，落到 Finder.jsx 里既有的动作分支——
// 不在这里另写一套平行业务逻辑（否则命令栏与窗口内会各走一条代码路径）。
// 下拉统一走全局 ContextMenu（T5 已支持子菜单 / 键盘 / 边缘翻转），这里只负责摆按钮。
//
// 三段降级（按窗口宽度，CSS 容器查询管前两段，JS 管第三段）：
//   ① ≥1090：图标 + 中文标签（新建为主操作，唯一填充强调色）
//   ② <1090：次要动作收成 32×32 纯图标（只留「新建 / 上传文件…」等关键动作的标签）
//   ③ 仍放不下：按 data-drop 优先级把动作收进「更多」，更多里这些动作一个不少
// 第 ③ 段必须走 JS：宽度是运行时的事，CSS 没法把按钮搬进菜单。
//
// 回收站视图换一组按钮（还原 / 彻底删除 / 清空回收站），与 Win11 回收站命令栏一致。

const mi = (label, action, extra = {}) => ({ label, action, ...extra });

function openAt(e, items) {
  const r = e.currentTarget.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 2, items);
}

// 溢出兜底的收纳顺序（数字越小越先收）：进度胶囊先让位（它的进度在「上传文件…」按钮
// 上还有一份），然后才是上传 / 排序 / 重命名 / 下载 / 剪贴板 / 查看。
// 新建 / 删除 / 更多 永不收：主操作、危险操作、以及「收回来的东西去哪看」的入口。
const DROP_ORDER = ['up-pill', '上传文件…', '上传文件夹…', '排序', '重命名', '下载', '粘贴', '复制', '剪切', '查看'];

function Btn({
  cmd, label, icon, onClick, disabled, title, caret, primary, danger, keepLabel, isIcon, cls = '', style,
}) {
  const c = ['cmd-btn'];
  if (primary) c.push('is-primary');
  if (danger) c.push('danger');
  if (keepLabel) c.push('keep-label');
  if (isIcon) c.push('is-icon');
  if (cls) c.push(cls);
  return (
    <button
      type="button"
      className={c.join(' ')}
      data-cmd={cmd || label}
      disabled={disabled}
      title={title || label}
      onClick={onClick}
      style={style}
    >
      <span className="cmd-ico" aria-hidden="true">{icon}</span>
      {label ? <span className="cmd-label">{label}</span> : null}
      {caret && <span className="cmd-caret" aria-hidden="true"><IconChevron dir="down" size={8} /></span>}
    </button>
  );
}

export default function FinderCommandBar({
  isTrash, selCount, clipboard, showHidden, view, act, sortItems, onDeleteForever,
  query = '', setQuery = () => {}, runSearch = () => {}, searchMode = false,
  searchOpen = false, setSearchOpen = () => {},
  // uploadStats() 的返回：{ activeCount, totalProgress }
  upStats = { activeCount: 0, totalProgress: 0 },
}) {
  const hasSel = selCount > 0;
  const cb = clipboard;
  const barRef = useRef(null);
  const searchRef = useRef(null);
  const [dropped, setDropped] = useState(() => new Set());
  const [barW, setBarW] = useState(0);
  const sigRef = useRef('');
  const liveDropped = useRef(dropped);
  liveDropped.current = dropped;

  // 宽度变化的「触发器」：纯尺寸变化不会触发 React 重渲染，得靠 ResizeObserver 推一下
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    setBarW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBarW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 打包：每次渲染后量一次真实溢出，仍溢出就收一枚进「更多」。
  // 在 useLayoutEffect 里 setState，React 会在同一帧内重渲染，用户看不到中间态。
  //
  // 收纳集合不能只增不减：窗口变宽 / 搜索收起 / 上传结束后要能回位。
  // 所以用「布局签名」（宽度 + 搜索展开 + 是否有上传）做兑现点：签名一变就把所有收纳
  // 先放回去，再由下面的循环重新收一遍——不会出现「上传完了 上传按钮 还在更多里」。
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const sig = `${barW}:${searchOpen ? 1 : 0}:${upStats.activeCount > 0 ? 1 : 0}`;
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      if (liveDropped.current.size) { setDropped(new Set()); return; }
    }
    if (el.scrollWidth - el.clientWidth <= 1) return;
    const next = DROP_ORDER.find((k) => !liveDropped.current.has(k));
    if (!next) return;
    setDropped(new Set([...liveDropped.current, next]));
  });

  const viewItems = () => [
    mi('图标', () => act('viewIcon'), { checked: view === 'icon' }),
    mi('列表', () => act('viewList'), { checked: view === 'list' }),
    '-',
    mi('显示隐藏文件', () => act('toggleHidden'), { checked: !!showHidden }),
    '-',
    mi('刷新', () => act('refresh'), { hint: 'F5' }),
  ];
  // 「更多」必须把所有被收纳的动作都收进来：窄窗下功能一点不少，只是多一次点击
  const moreItems = () => [
    mi('上传文件…', () => act('uploadFile')),
    mi('上传文件夹…', () => act('uploadFolder')),
    '-',
    mi('剪切', () => act('cut'), { disabled: !hasSel, hint: 'Ctrl+X' }),
    mi('复制', () => act('copy'), { disabled: !hasSel, hint: 'Ctrl+C' }),
    mi('粘贴', () => act('paste'), { disabled: !cb, hint: 'Ctrl+V' }),
    '-',
    mi('重命名', () => act('rename'), { disabled: selCount !== 1, hint: 'F2' }),
    mi('下载', () => act('download'), { disabled: !hasSel }),
    '-',
    mi('排序方式…', () => {}, { items: sortItems() }),
    mi('视图…', () => {}, { items: viewItems() }),
    mi('刷新', () => act('refresh'), { hint: 'F5' }),
    '-',
    mi('全选', () => act('selectAll'), { hint: 'Ctrl+A' }),
    mi('前往文件夹…', () => act('goFolder'), { hint: 'Ctrl+L' }),
  ];

  // 回收站视图的「更多」：只列回收站里成立的动作（新建/上传/剪贴板在这里没有意义）
  const trashMoreItems = () => [
    mi('放回原处', () => act('restore'), { disabled: !hasSel }),
    mi('彻底删除…', onDeleteForever, { disabled: !hasSel }),
    mi('清空回收站…', () => act('emptyTrash')),
    '-',
    mi('视图…', () => {}, { items: viewItems() }),
    mi('刷新', () => act('refresh'), { hint: 'F5' }),
  ];

  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchRef.current?.querySelector('input')?.focus(), 0);
  };

  // 右簇：上传进度胶囊 + 更多 + 搜索（更多与搜索同一簇，贴右）
  const rightCluster = (more) => (
    <div className="cmd-right">
      {upStats.activeCount > 0 && !dropped.has('up-pill') && (
        <span className="fx-up" title={`正在上传：${upStats.activeCount} 个文件`}>
          <span className="fx-up-label">上传中</span>
          <span className="fx-up-track"><span className="fx-up-bar" style={{ width: `${upStats.totalProgress}%` }} /></span>
          <span className="fx-up-n">{upStats.totalProgress}%</span>
        </span>
      )}
      <Btn cmd="更多" title="更多操作" isIcon icon={<IconMore size={16} />}
        onClick={(e) => openAt(e, more)} />
      <button
        type="button"
        className="cmd-btn is-icon fx-search-toggle"
        data-cmd="搜索"
        title="搜索（Ctrl+F）"
        onClick={openSearch}
      ><span className="cmd-ico" aria-hidden="true"><IconSearch size={15} /></span></button>
      <div className={`finder-search${searchOpen ? ' is-open' : ''}`} ref={searchRef}>
        <span className="fx-search-ico" aria-hidden="true"><IconSearch size={13} /></span>
        <input
          value={query}
          placeholder={isTrash ? '过滤回收站' : '搜索'}
          aria-label="搜索"
          onChange={(e) => { if (!searchMode) setQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch(e.target.value);
            if (e.key === 'Escape') { runSearch(''); setSearchOpen(false); }
          }}
        />
        {query && (
          <button
            type="button"
            className="clear-btn"
            title="清空"
            onMouseDown={(e) => { e.preventDefault(); runSearch(''); }}
          ><IconClose size={10} /></button>
        )}
      </div>
    </div>
  );

  // 回收站视图：只留能用的动作（新建/上传/剪贴板在这里没有意义）；主操作换成「还原」
  if (isTrash) {
    return (
      <div className="finder-cmdbar" role="toolbar" aria-label="命令栏" ref={barRef}>
        <div className="cmd-groups">
          <div className="cmd-group">
            <Btn cmd="还原" label="还原" title="放回原处" primary keepLabel disabled={!hasSel}
              icon={<IconRefresh size={16} />} onClick={() => act('restore')} />
          </div>
          <span className="cmd-sep" aria-hidden="true" />
          <div className="cmd-group">
            <Btn cmd="彻底删除…" label="彻底删除…" title="彻底删除选中的项目" danger disabled={!hasSel}
              icon={<IconTrashLine size={16} />} onClick={onDeleteForever} />
            <Btn cmd="清空回收站…" label="清空回收站…" danger
              icon={<IconTrashLine size={16} />} onClick={() => act('emptyTrash')} />
          </div>
          <span className="cmd-sep" aria-hidden="true" />
          <div className="cmd-group">
            <Btn cmd="查看" label="查看" caret title="查看（图标 / 列表 / 显示隐藏文件 / 刷新）"
              icon={view === 'list' ? <IconList size={16} /> : <IconGrid size={16} />}
              onClick={(e) => openAt(e, viewItems())} />
          </div>
        </div>
        {rightCluster(trashMoreItems())}
      </div>
    );
  }

  // 五个分组：主操作 / 上传 / 剪贴板 / 选择类 / 视图类。分组的可见性由 dropped 决定。
  const groups = [
    [
      {
        key: '新建',
        node: (
          <Btn cmd="新建" label="新建" primary caret keepLabel title="新建（文件夹 / 文本文档）"
            icon={<IconFolderPlus size={16} />}
            onClick={(e) => openAt(e, [
              mi('文件夹', () => act('newFolder')),
              mi('文本文档', () => act('newFile')),
            ])} />
        ),
      },
    ],
    [
      {
        key: '上传文件…',
        node: (
          <Btn cmd="上传文件…" label="上传文件…" keepLabel title="上传文件…" icon={<IconUpload size={16} />}
            cls={upStats.activeCount > 0 ? 'is-uploading' : ''}
            style={upStats.activeCount > 0 ? { '--up': `${upStats.totalProgress}%` } : undefined}
            onClick={() => act('uploadFile')} />
        ),
      },
      {
        key: '上传文件夹…',
        node: (
          <Btn cmd="上传文件夹…" label="上传文件夹…" title="上传文件夹…" icon={<IconFolderUp size={16} />}
            onClick={() => act('uploadFolder')} />
        ),
      },
    ],
    [
      {
        key: '剪切',
        node: (
          <Btn cmd="剪切" label="剪切" title="剪切（Ctrl+X）" disabled={!hasSel}
            icon={<IconCut size={16} />} onClick={() => act('cut')} />
        ),
      },
      {
        key: '复制',
        node: (
          <Btn cmd="复制" label="复制" title="复制（Ctrl+C）" disabled={!hasSel}
            icon={<IconCopy size={16} />} onClick={() => act('copy')} />
        ),
      },
      {
        key: '粘贴',
        node: (
          <span className="cmd-split" data-drop="粘贴">
            <Btn cmd="粘贴" label="粘贴" title="粘贴（Ctrl+V）" disabled={!cb}
              icon={<IconPaste size={16} />} onClick={() => act('paste')} />
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
        ),
      },
    ],
    [
      {
        key: '重命名',
        node: (
          <Btn cmd="重命名" label="重命名" title="重命名（F2）" disabled={selCount !== 1}
            icon={<IconRename size={16} />} onClick={() => act('rename')} />
        ),
      },
      ...(selCount > 1 ? [{
        key: '下载',
        node: (
          <Btn cmd="下载" label="下载" title="下载（打包）" icon={<IconDownload size={16} />}
            onClick={() => act('download')} />
        ),
      }] : []),
      {
        key: '删除',
        node: (
          <Btn cmd="删除" label="删除" title="删除（移入回收站）" danger disabled={!hasSel}
            icon={<IconTrashLine size={16} />} onClick={() => act('trash')} />
        ),
      },
    ],
    [
      {
        key: '排序',
        node: (
          <Btn cmd="排序" label="排序" caret title="排序方式" icon={<IconSort size={16} />}
            onClick={(e) => openAt(e, sortItems())} />
        ),
      },
      {
        key: '查看',
        node: (
          <Btn cmd="查看" label="查看" caret title="查看（图标 / 列表 / 显示隐藏文件 / 刷新）"
            icon={view === 'list' ? <IconList size={16} /> : <IconGrid size={16} />}
            onClick={(e) => openAt(e, viewItems())} />
        ),
      },
    ],
  ];

  const visibleGroups = groups
    .map((g) => g.filter((b) => !dropped.has(b.key)))
    .filter((g) => g.length > 0);

  return (
    <div className="finder-cmdbar" role="toolbar" aria-label="命令栏" ref={barRef}>
      <div className="cmd-groups">
        {visibleGroups.map((g, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <span className="cmd-sep" aria-hidden="true" />}
            <div className="cmd-group">
              {g.map((b) => <React.Fragment key={b.key}>{b.node}</React.Fragment>)}
            </div>
          </React.Fragment>
        ))}
      </div>
      {rightCluster(moreItems())}
    </div>
  );
}
