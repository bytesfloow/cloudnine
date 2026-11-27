import React, { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { openContextMenu } from '../../store.js';
import {
  IconMore, IconChevron, IconUpload, IconPaste, IconCut, IconCopy,
  IconRename, IconDownload, IconTrashLine, IconSort, IconGrid, IconList, IconRefresh, IconSearch,
  IconClose, IconFolderPlus,
} from '../../icons.jsx';

// 文件资源管理器 · 命令行（docs/design/finder-toolbar-v2.md 的 V3「材质分层」，高 48）
//
//   新建 ⌄ │ 上传 ⌄ │ 剪切 复制 粘贴 ⌄ │ 重命名 [下载] 删除 │ 排序 ⌄ 查看 ⌄ │ ⋯ 搜索
//
// 组件本身不持有任何业务状态：视图 / 排序 / 隐藏文件 / 剪贴板 / 选中数全部由 Finder.jsx 传入，
// 每个按钮都只翻译成 act(action)，落到 Finder.jsx 里既有的动作分支——
// 不在这里另写一套平行业务逻辑（否则命令栏与窗口内会各走一条代码路径）。
// 下拉统一走全局 ContextMenu（T5 已支持子菜单 / 键盘 / 边缘翻转），这里只负责摆按钮。
//
// 标签策略（V3 的第三条主张，见 md §5）：
//   一级只放短词（新建 / 上传 / 排序 / 查看），全称放二级菜单（上传文件 / 上传文件夹），
//   标签不带句末 `…`、也**不许**被 CSS 裁字：.cmd-label 没有 text-overflow，
//   放不下就把整枚按钮收进「更多」（Fluent 2 toolbar / WinUI CommandBar 的 overflow 语汇）。
//   原来「上传文件…（101px）+ 上传文件夹…（113px）」两枚 214px，合成「上传 ⌄」后约 82px，
//   这就是 700 宽不再需要收纳的直接原因。
//
// 三段降级（按窗口宽度，CSS 容器查询管前两段，JS 管第三段）：
//   ① ≥1090：图标 + 中文标签（新建为主操作，唯一填充强调色）
//   ② <1090：次要动作收成 36×36 纯图标（只留「新建 / 上传」两枚关键动作的标签）
//   ③ 仍放不下：按 data-drop 优先级把动作收进「更多」，更多里这些动作一个不少
// 第 ③ 段必须走 JS：宽度是运行时的事，CSS 没法把按钮搬进菜单。
//
// 回收站视图换一组按钮（还原 / 彻底删除 / 清空回收站），与 Win11 回收站命令栏一致。

const mi = (label, action, extra = {}) => ({ label, action, ...extra });

function openAt(e, items) {
  const r = e.currentTarget.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 2, items);
}

// 溢出兜底的收纳顺序：进度胶囊先让位（它的进度在「上传」按钮上还有一份），
// 然后才是上传 / 排序 / 重命名 / 下载 / 剪贴板 / 查看。
// 键名必须与按钮的 data-drop 一致（同步错一个，收纳就会漏掉那枚按钮、露出横向溢出）。
// 新建 / 删除 / 更多 永不收：主操作、危险操作、以及「收回来的东西去哪看」的入口。
const DROP_ORDER = ['up-pill', '上传', '排序', '重命名', '下载', '粘贴', '复制', '剪切', '查看'];

// ---------- 涟漪（M3 的两段式按压反馈）----------
// pointerdown 时在指针位置插一枚 currentColor 圆：105ms 展开到 0.55 倍（--fx-dur-press），
// animationend 后接力 375ms 扩散到 1 倍并淡出（--fx-dur-out）。
// 结束时**必须**把节点摘掉：animationend 负责正常路径，另设 520ms 兜底——
// 后台标签页或被跳帧时 animationend 可能不触发，不能只靠它保证「节点不累积 DOM」。
// prefers-reduced-motion: reduce 下直接不插（CSS 侧另有 .cmd-ripple{display:none} 兜底）。
const RIPPLE_MS = 520;
const reduceMotion = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function spawnRipple(e) {
  const btn = e.currentTarget;
  if (!btn || btn.disabled || e.button > 0 || reduceMotion()) return;
  const r = btn.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span');
  s.className = 'cmd-ripple';
  s.setAttribute('aria-hidden', 'true');
  s.style.width = `${d}px`;
  s.style.height = `${d}px`;
  s.style.left = `${e.clientX - r.left}px`;
  s.style.top = `${e.clientY - r.top}px`;
  btn.appendChild(s);
  const kill = () => s.remove();
  s.addEventListener('animationend', () => {
    if (s.classList.contains('is-out')) kill();
    else s.classList.add('is-out');
  });
  window.setTimeout(kill, RIPPLE_MS);
}

function Btn({
  cmd, label, icon, onClick, disabled, title, caret, primary, danger, keepLabel, isIcon, lift, drop, cls = '', style,
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
      data-drop={drop}
      disabled={disabled}
      title={title || label}
      onClick={onClick}
      onPointerDown={spawnRipple}
      style={style}
    >
      <span className={`cmd-ico${lift ? ' is-lift' : ''}`} aria-hidden="true">{icon}</span>
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
  // 一级「上传 ⌄」的二级菜单：两个动作全称都放这里（一级标签只留 2 个字）
  const uploadItems = () => [
    mi('上传文件', () => act('uploadFile')),
    mi('上传文件夹', () => act('uploadFolder')),
  ];
  // 「更多」必须把所有被收纳的动作都收进来：窄窗下功能一点不少，只是多一次点击。
  // 文案与命令栏按钮同一套词表（不放 `…`），否则同一个动作在两处两个名字。
  const moreItems = () => [
    mi('上传文件', () => act('uploadFile')),
    mi('上传文件夹', () => act('uploadFolder')),
    '-',
    mi('剪切', () => act('cut'), { disabled: !hasSel, hint: 'Ctrl+X' }),
    mi('复制', () => act('copy'), { disabled: !hasSel, hint: 'Ctrl+C' }),
    mi('粘贴', () => act('paste'), { disabled: !cb, hint: 'Ctrl+V' }),
    '-',
    mi('重命名', () => act('rename'), { disabled: selCount !== 1, hint: 'F2' }),
    mi('下载', () => act('download'), { disabled: !hasSel }),
    '-',
    mi('排序方式', () => {}, { items: sortItems() }),
    mi('视图', () => {}, { items: viewItems() }),
    mi('刷新', () => act('refresh'), { hint: 'F5' }),
    '-',
    mi('全选', () => act('selectAll'), { hint: 'Ctrl+A' }),
    // 带 `…` 是因为它真的会弹一个要输入的对话框（桌面语义），不是被裁掉的痕迹
    mi('前往文件夹…', () => act('goFolder'), { hint: 'Ctrl+L' }),
  ];

  // 回收站视图的「更多」：只列回收站里成立的动作（新建/上传/剪贴板在这里没有意义）
  const trashMoreItems = () => [
    mi('放回原处', () => act('restore'), { disabled: !hasSel }),
    mi('彻底删除', onDeleteForever, { disabled: !hasSel }),
    mi('清空回收站', () => act('emptyTrash')),
    '-',
    mi('视图', () => {}, { items: viewItems() }),
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
        <span className="fx-up" data-drop="up-pill" title={`正在上传：${upStats.activeCount} 个文件`}>
          <span className="fx-up-label">上传中</span>
          <span className="fx-up-track"><span className="fx-up-bar" style={{ width: `${upStats.totalProgress}%` }} /></span>
          <span className="fx-up-n">{upStats.totalProgress}%</span>
        </span>
      )}
      <Btn cmd="更多" title="更多操作" isIcon icon={<IconMore size={18} />}
        onClick={(e) => openAt(e, more)} />
      <button
        type="button"
        className="cmd-btn is-icon fx-search-toggle"
        data-cmd="搜索"
        title="搜索（Ctrl+F）"
        onClick={openSearch}
        onPointerDown={spawnRipple}
      ><span className="cmd-ico" aria-hidden="true"><IconSearch size={18} sw={2} /></span></button>
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
              icon={<IconRefresh size={18} sw={2} />} onClick={() => act('restore')} />
          </div>
          <span className="cmd-sep" aria-hidden="true" />
          <div className="cmd-group">
            <Btn cmd="彻底删除" label="彻底删除" title="彻底删除选中的项目" danger disabled={!hasSel} lift
              icon={<IconTrashLine size={18} />} onClick={onDeleteForever} />
            <Btn cmd="清空回收站" label="清空回收站" danger lift
              icon={<IconTrashLine size={18} />} onClick={() => act('emptyTrash')} />
          </div>
          <span className="cmd-sep" aria-hidden="true" />
          <div className="cmd-group">
            <Btn cmd="查看" label="查看" caret title="查看（图标 / 列表 / 显示隐藏文件 / 刷新）"
              icon={view === 'list' ? <IconList size={18} sw={2} /> : <IconGrid size={18} />}
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
            icon={<IconFolderPlus size={18} />}
            onClick={(e) => openAt(e, [
              mi('文件夹', () => act('newFolder')),
              mi('文本文档', () => act('newFile')),
            ])} />
        ),
      },
    ],
    [
      {
        key: '上传',
        node: (
          <Btn cmd="上传" label="上传" keepLabel caret drop="上传" lift
            title="上传（文件 / 文件夹）"
            icon={<IconUpload size={18} sw={2} />}
            cls={upStats.activeCount > 0 ? 'is-uploading' : ''}
            style={upStats.activeCount > 0 ? { '--up': `${upStats.totalProgress}%` } : undefined}
            onClick={(e) => openAt(e, uploadItems())} />
        ),
      },
    ],
    [
      {
        key: '剪切',
        node: (
          <Btn cmd="剪切" label="剪切" drop="剪切" title="剪切（Ctrl+X）" disabled={!hasSel}
            icon={<IconCut size={18} />} onClick={() => act('cut')} />
        ),
      },
      {
        key: '复制',
        node: (
          <Btn cmd="复制" label="复制" drop="复制" title="复制（Ctrl+C）" disabled={!hasSel}
            icon={<IconCopy size={18} />} onClick={() => act('copy')} />
        ),
      },
      {
        key: '粘贴',
        node: (
          <span className="cmd-split" data-drop="粘贴">
            <Btn cmd="粘贴" label="粘贴" drop="粘贴" title="粘贴（Ctrl+V）" disabled={!cb}
              icon={<IconPaste size={18} sw={2} />} onClick={() => act('paste')} />
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
              onPointerDown={spawnRipple}
            ><IconChevron dir="down" size={8} /></button>
          </span>
        ),
      },
    ],
    [
      {
        key: '重命名',
        node: (
          <Btn cmd="重命名" label="重命名" drop="重命名" title="重命名（F2）" disabled={selCount !== 1}
            icon={<IconRename size={18} />} onClick={() => act('rename')} />
        ),
      },
      ...(selCount > 1 ? [{
        key: '下载',
        node: (
          <Btn cmd="下载" label="下载" drop="下载" title="下载（打包）" lift
            icon={<IconDownload size={18} sw={2} />} onClick={() => act('download')} />
        ),
      }] : []),
      {
        key: '删除',
        node: (
          <Btn cmd="删除" label="删除" title="删除（移入回收站）" danger disabled={!hasSel} lift
            icon={<IconTrashLine size={18} />} onClick={() => act('trash')} />
        ),
      },
    ],
    [
      {
        key: '排序',
        node: (
          <Btn cmd="排序" label="排序" caret drop="排序" title="排序方式" icon={<IconSort size={18} />}
            onClick={(e) => openAt(e, sortItems())} />
        ),
      },
      {
        key: '查看',
        node: (
          <Btn cmd="查看" label="查看" caret drop="查看" title="查看（图标 / 列表 / 显示隐藏文件 / 刷新）"
            icon={view === 'list' ? <IconList size={18} sw={2} /> : <IconGrid size={18} />}
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
