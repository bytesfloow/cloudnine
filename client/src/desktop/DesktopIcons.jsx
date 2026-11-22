import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useStore, getState, setState, openWindow, openContextMenu, bus, notify,
  setDesktopSel, setDesktopSort, setDesktopShowHidden, setDesktopIconSize, setClipboard, joinPath, basename, confirmDialog,
} from '../store.js';
import { api } from '../api.js';
import { FileIcon, IconGlobe, IconTrash } from '../icons.jsx';
import {
  createItem, uploadTo, uploadDropped, copyToClipboard, cutToClipboard, pasteInto,
  trashItems, renameItem, downloadItem, downloadItems, compressItems, extractItem,
  shareItem, shareBlockReason, copyPathText, openEntry, isArchive, openWithItems,
} from '../fsops.js';

// 桌面 = 用户主目录的直视图：每一个图标都是主目录里的真实文件 / 文件夹。
// 图标位置不再手工摆放（同属一个目录，拖到空白处移动无意义），完全由排序规则决定；
// 拖拽的语义改为「移动文件」：拖到文件夹上=移入该文件夹，拖到回收站上=删除。
const DRAG_TYPE = 'application/x-cloudnine';

// 桌面一次性渲染的图标上限：主目录条目极多时避免页面卡死，
// 超出的部分明确提示「去文件资源管理器看」，不做静默截断。
const MAX_ICONS = 400;

// 图标网格：左上开始、从左往右填满一行再换行向下（Windows 桌面语义）
// 列数不再手工算：CSS 用 repeat(auto-fill, 格子宽) 按容器宽度自动重算，
// 窗口变窄自然减少列数、增加行数，不存在横向溢出后的裁切。

// 三档图标大小：图标绘制尺寸与格子尺寸必须一起变，
// 否则大图标会顶到相邻标签、小图标又会留下大片空白。
// medium 是默认档，数值与改造前的 102×88 / 52px 一致，默认观感不变。
const ICON_TIERS = {
  large: { label: '大图标', icon: 64, sys: 60, cellW: 136, cellH: 116, labelSize: 12.5 },
  medium: { label: '中等图标', icon: 52, sys: 48, cellW: 102, cellH: 88, labelSize: 11.5 },
  small: { label: '小图标', icon: 32, sys: 32, cellW: 86, cellH: 68, labelSize: 11 },
};
const ICON_TIER_ORDER = ['large', 'medium', 'small'];

export default function DesktopIcons() {
  const s = useStore();
  const cwd = s.homeRel || '';
  const sel = s.desktopSel;

  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const [sysSel, setSysSel] = useState(null); // 选中的系统图标（根目录 / 回收站）

  const layerRef = useRef(null);
  const tierKey = ICON_TIERS[s.desktopIconSize] ? s.desktopIconSize : 'medium';
  const tier = ICON_TIERS[tierKey];

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.list(cwd);
      setEntries(r.entries);
      setError('');
    } catch (e) {
      setError(e.message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { load(); }, [load]);

  // 旧版本把图标位置存在本地；桌面改为自动排布后不再使用，顺手清掉
  useEffect(() => {
    try { localStorage.removeItem('cloudnine-icon-pos'); } catch { /* 忽略 */ }
  }, []);

  // 文件系统变更 → 刷新（终端里的操作不会广播，靠轮询与窗口聚焦兜底）
  useEffect(() => bus.on('fs:changed', (d) => {
    if (d === '__trash__') return;
    if (d === cwd || d === '' || (d && cwd.startsWith(d + '/'))) load(true);
  }), [cwd, load]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, 20000);
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [load]);

  // 选中项里已被删除的条目要清掉
  useEffect(() => {
    if (!entries) return;
    const names = new Set(entries.map((e) => e.name));
    const alive = sel.filter((n) => names.has(n));
    if (alive.length !== sel.length) setDesktopSel(alive);
  }, [entries, sel]);

  // 排序：文件夹优先 + 主排序键
  const files = useMemo(() => {
    const list = (entries || []).filter((e) => s.desktopShowHidden || !e.hidden);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'zh'),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      mtime: (a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0),
      type: (a, b) => (extOf(a.name).localeCompare(extOf(b.name), 'zh') || a.name.localeCompare(b.name, 'zh')),
    }[s.desktopSort.key] || ((a, b) => a.name.localeCompare(b.name, 'zh'));
    const dirFirst = s.desktopSort.dirsFirst
      ? (a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1)
      : () => 0;
    return [...list].sort((a, b) => (dirFirst(a, b) || cmp(a, b)) * (s.desktopSort.asc ? 1 : -1));
  }, [entries, s.desktopShowHidden, s.desktopSort]);

  const selectedEntries = useMemo(() => files.filter((e) => sel.includes(e.name)), [files, sel]);
  const selectedPaths = useMemo(() => selectedEntries.map((e) => joinPath(cwd, e.name)), [selectedEntries, cwd]);
  const shownFiles = files.length > MAX_ICONS ? files.slice(0, MAX_ICONS) : files;

  // 系统图标（根目录 / 回收站）：与文件同处一个图标网格，占据左上角前两格，
  // 排列逻辑和 Windows 桌面快捷方式一致；双击才打开，单击只选中。
  const sysItems = [
    { key: '__root__', label: '根目录', Icon: IconGlobe, trash: false },
    { key: '__trash__', label: '回收站', Icon: IconTrash, trash: true },
  ];

  function openSys(key) {
    if (key === '__trash__') openWindow('finder', { trash: true });
    else openWindow('finder', { cwd: '' });
  }

  // 打开预览窗口（macOS 空格预览浮层已删除）：path/name 定位文件，siblings 供 ←/→ 切换
  function openPreview(paths) {
    if (!paths.length) return;
    openWindow('preview', { path: paths[0], name: basename(paths[0]), siblings: paths, index: 0 });
  }

  // 系统图标（根目录 / 回收站）右键：文案按 §2.2.1 统一为「打开」「打开回收站」「清空回收站」
  function sysMenu(e, key) {
    if (key !== '__trash__') {
      openContextMenu(e.clientX, e.clientY, [
        { label: '打开', action: () => openWindow('finder', { cwd: '' }) },
        { label: '在终端中打开', action: () => openWindow('terminal', { cwd: '' }) },
      ]);
      return;
    }
    openContextMenu(e.clientX, e.clientY, [
      { label: '打开回收站', action: () => openWindow('finder', { trash: true }) },
      ...(s.trashCount > 0 ? ['-', {
        label: '清空回收站', danger: true, action: async () => {
          if (!await confirmDialog({ title: '清空回收站', message: `将彻底删除回收站中的 ${s.trashCount} 项，此操作不可撤销。`, danger: true, okText: '清空' })) return;
          await api.trashEmpty();
          setState({ trashCount: 0 });
          bus.emit('fs:changed', '__trash__');
        },
      }] : []),
    ]);
  }

  // ---------- 选择 ----------
  function clickItem(e, entry, idx) {
    setSysSel(null); // 选中文件时取消系统图标的选中态
    setState({ focusId: null }); // 点桌面图标：焦点回到桌面
    // C9：多选修饰键只认 Ctrl（⌘ 不再参与），Shift 连选保留
    if (e.ctrlKey) {
      setDesktopSel((prev) => (prev.includes(entry.name) ? prev.filter((n) => n !== entry.name) : [...prev, entry.name]));
      setAnchor(idx);
    } else if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
      setDesktopSel(files.slice(a, b + 1).map((x) => x.name));
    } else {
      setDesktopSel([entry.name]);
      setAnchor(idx);
    }
  }

  // 橡皮筋框选
  function startMarquee(e) {
    // C10：框选修饰键只认 Ctrl
    if (e.button !== 0 || e.ctrlKey) return;
    if (e.target.closest('.desktop-icon, .desktop-sysicon, input, button')) return;
    // 空白处只做橡皮筋框选，别让浏览器同时启动原生文本拖选（拖动会越过新开的窗口）
    e.preventDefault();
    const layer = layerRef.current;
    const box = layer.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const onMove = (ev) => {
      const r = { x: Math.min(sx, ev.clientX), y: Math.min(sy, ev.clientY), w: Math.abs(ev.clientX - sx), h: Math.abs(ev.clientY - sy) };
      // 框选层可能已竖向滚动：绝对定位的框要加上滚动偏移才能跟住指针
      setMarquee({
        ...r,
        left: r.x - box.left + layer.scrollLeft,
        top: r.y - box.top + layer.scrollTop,
      });
      const names = new Set();
      layer.querySelectorAll('.desktop-icon[data-entry]').forEach((el) => {
        const er = el.getBoundingClientRect();
        if (er.left < r.x + r.w && er.right > r.x && er.top < r.y + r.h && er.bottom > r.y) names.add(el.dataset.entry);
      });
      setDesktopSel([...names]);
    };
    const onUp = () => {
      setMarquee(null);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------- 操作 ----------
  async function doCreate(kind) {
    const p = await createItem(cwd, kind);
    if (!p) return;
    setDesktopSel([basename(p)]);
    if (kind === 'file') openWindow('editor', { path: p, name: basename(p) });
  }

  async function doTrash(paths = selectedPaths, names = selectedEntries.map((e) => e.name)) {
    if (!paths.length) return;
    const ok = await trashItems(paths, names);
    if (ok) setDesktopSel([]);
  }

  function selectAll() {
    setDesktopSel(files.map((e) => e.name));
  }

  function startRename() {
    if (selectedEntries.length !== 1) return;
    setRenaming(selectedEntries[0].name);
  }

  async function submitRename(oldName, newName) {
    setRenaming(null);
    if (!newName || newName === oldName) return;
    const ok = await renameItem(joinPath(cwd, oldName), newName);
    if (ok) setDesktopSel([newName]);
  }

  // ---------- 右键菜单 ----------
  function itemMenu(e, entry) {
    e.preventDefault();
    e.stopPropagation();
    // 右键未选中的条目 → 只作用于该条目；右键已选中的条目 → 作用于整个选中集
    const inSel = sel.includes(entry.name);
    const multi = inSel && selectedEntries.length > 1;
    if (!inSel) setDesktopSel([entry.name]);
    const path = joinPath(cwd, entry.name);
    const paths = multi ? selectedPaths : [path];
    const targets = multi ? selectedEntries : [entry];
    const filesOnly = targets.filter((x) => x.type !== 'dir').map((x) => joinPath(cwd, x.name));
    const openIn = openWithItems(path, entry, { siblings: filesOnly });
    openContextMenu(e.clientX, e.clientY, [
      { label: '打开', action: () => openEntry(entry, cwd) },
      { label: '打开方式', items: openIn },
      ...(entry.type !== 'dir' ? [{ label: '预览', action: () => openPreview(filesOnly.length ? filesOnly : [path]) }] : []),
      '-',
      { label: '重命名', action: startRename, disabled: multi },
      { label: '复制', action: () => copyToClipboard(paths, cwd) },
      { label: '剪切', action: () => cutToClipboard(paths, cwd) },
      { label: '删除', danger: true, action: () => doTrash(paths, targets.map((x) => x.name)) },
      '-',
      { label: '压缩…', action: () => compressItems(paths, cwd) },
      ...(isArchive(entry) ? [{ label: '解压到…', action: () => extractItem(path, cwd) }] : []),
      { label: '发送到', items: [
        { label: '下载', disabled: entry.type === 'dir', action: () => downloadItem(path) },
        { label: '打包下载', disabled: paths.length < 2, action: () => downloadItems(paths) },
        { label: '复制路径', action: () => copyPathText(path) },
      ] },
      '-',
      { label: shareBlockReason(entry) ? `分享…（${shareBlockReason(entry)}）` : '分享…', disabled: !!shareBlockReason(entry), action: () => shareItem(path, entry.name, entry) },
      { label: '属性', action: () => openWindow('info', { path }) },
    ]);
  }

  function blankMenu(e) {
    if (e.target.closest('.desktop-icon, .desktop-sysicon, input, button')) return;
    e.preventDefault();
    const cb = getState().clipboard;
    const sort = s.desktopSort;
    openContextMenu(e.clientX, e.clientY, [
      { label: '查看', items: [
        ...ICON_TIER_ORDER.map((k) => ({
          label: ICON_TIERS[k].label,
          checked: tierKey === k,
          action: () => setDesktopIconSize(k),
        })),
        '-',
        { label: '显示隐藏文件', checked: s.desktopShowHidden, action: () => setDesktopShowHidden(!s.desktopShowHidden) },
      ] },
      { label: '排序方式', items: [
        { label: '名称', checked: sort.key === 'name', action: () => setDesktopSort({ ...sort, key: 'name' }) },
        { label: '大小', checked: sort.key === 'size', action: () => setDesktopSort({ ...sort, key: 'size' }) },
        { label: '修改时间', checked: sort.key === 'mtime', action: () => setDesktopSort({ ...sort, key: 'mtime' }) },
        { label: '类型', checked: sort.key === 'type', action: () => setDesktopSort({ ...sort, key: 'type' }) },
        '-',
        { label: '升序', checked: sort.asc, action: () => setDesktopSort({ ...sort, asc: true }) },
        { label: '降序', checked: !sort.asc, action: () => setDesktopSort({ ...sort, asc: false }) },
        '-',
        { label: '文件夹优先', checked: sort.dirsFirst, action: () => setDesktopSort({ ...sort, dirsFirst: !sort.dirsFirst }) },
      ] },
      { label: '刷新', action: () => load() },
      '-',
      {
        label: cb ? (cb.mode === 'copy' ? '粘贴项目' : '移动项目到此处') : '粘贴',
        disabled: !cb,
        action: () => pasteInto(cwd),
      },
      { label: '新建', items: [
        { label: '文件夹', action: () => doCreate('dir') },
        { label: '文本文档', action: () => doCreate('file') },
      ] },
      { label: '上传文件…', action: () => uploadTo(cwd, false) },
      { label: '上传文件夹…', action: () => uploadTo(cwd, true) },
      '-',
      { label: '剪贴板', items: [
        {
          label: cb ? `剪贴板：${cb.mode === 'cut' ? '剪切' : '复制'} ${cb.paths?.length ?? 0} 项` : '剪贴板：空',
          disabled: true,
        },
        '-',
        { label: '清空剪贴板', disabled: !cb, action: () => setClipboard(null) },
      ] },
      { label: '在终端中打开', action: () => openWindow('terminal', { cwd }) },
    ]);
  }

  // ---------- 拖拽 ----------
  function onDragStart(e, entry) {
    const names = sel.includes(entry.name) ? sel : [entry.name];
    const paths = names.map((n) => joinPath(cwd, n));
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ paths, cwd, mode: e.ctrlKey ? 'copy' : 'move' }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  // 拖到文件夹上：移入该文件夹（C8：按住 Ctrl 为复制，Win 语义）
  async function onDropOnFolder(e, entry) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const target = joinPath(cwd, entry.name);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      try {
        const { paths, mode } = JSON.parse(raw);
        if (mode === 'copy') await api.copy(paths, target);
        else await api.move(paths, target);
        bus.emit('fs:changed', target);
        bus.emit('fs:changed', cwd);
      } catch (err) {
        notify({ type: 'error', title: '移动失败', body: err.message });
      }
      return;
    }
    if (e.dataTransfer.files.length) uploadDropped(target, e.dataTransfer.files);
  }

  // 拖到回收站上：删除
  async function onDropOnTrash(e) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    try {
      const { paths } = JSON.parse(raw);
      const names = paths.map((p) => basename(p));
      const ok = await trashItems(paths, names);
      if (ok) setDesktopSel([]);
    } catch { /* 忽略 */ }
  }

  // 拖到桌面空白处：外部文件上传到主目录；内部拖拽原地放下（同目录移动无意义）
  function onContainerDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.getData(DRAG_TYPE)) return;
    if (e.dataTransfer.files.length) uploadDropped(cwd, e.dataTransfer.files);
  }

  // ---------- 桌面动作 / 快捷键动作 ----------
  useEffect(() => bus.on('desktop-action', ({ action }) => {
    switch (action) {
      case 'newFolder': return doCreate('dir');
      case 'newFile': return doCreate('file');
      case 'uploadFile': return uploadTo(cwd, false);
      case 'uploadFolder': return uploadTo(cwd, true);
      case 'paste': return pasteInto(cwd);
      case 'copy': if (selectedPaths.length) copyToClipboard(selectedPaths, cwd); return;
      case 'cut': if (selectedPaths.length) cutToClipboard(selectedPaths, cwd); return;
      case 'selectAll': return selectAll();
      case 'rename': return startRename();
      case 'trash': return doTrash();
      case 'refresh': return load();
      case 'open': {
        // Enter：打开选中项（多选时逐个打开，与 Win11 一致）
        selectedEntries.forEach((en) => openEntry(en, cwd));
        return;
      }
      case 'toggleSel': {
        // C5：空格 = 切换当前选中项，不再触发预览
        const cur = anchor != null ? files[anchor] : null;
        if (!cur) return;
        setDesktopSel((prev) => (prev.includes(cur.name) ? prev.filter((n) => n !== cur.name) : [...prev, cur.name]));
        return;
      }
      case 'properties': {
        if (selectedEntries.length === 1) openWindow('info', { path: joinPath(cwd, selectedEntries[0].name) });
        return;
      }
      case 'preview': {
        const previewFiles = selectedEntries.filter((e) => e.type !== 'dir').map((e) => joinPath(cwd, e.name));
        openPreview(previewFiles);
        return;
      }
      case 'toggleHidden': return setDesktopShowHidden(!getState().desktopShowHidden);
      case 'toggleSortDir': {
        const st = getState().desktopSort;
        return setDesktopSort({ ...st, asc: !st.asc });
      }
      case 'dirsFirst': {
        const st = getState().desktopSort;
        return setDesktopSort({ ...st, dirsFirst: !st.dirsFirst });
      }
      case 'goHome': return;
      case 'goRoot': return openWindow('finder', { cwd: '' });
      case 'goTrash': return openWindow('finder', { trash: true });
      case 'openTerminal': return openWindow('terminal', { cwd });
      default:
        if (action.startsWith('sort:')) {
          const st = getState().desktopSort;
          return setDesktopSort({ ...st, key: action.slice(5) });
        }
    }
  }), [cwd, selectedPaths, selectedEntries, files, anchor]);

  // ---------- 渲染 ----------
  return (
    <>
      <div
        ref={layerRef}
        className={`desktop-icons${dragOver ? ' drag-over' : ''}`}
        onContextMenu={blankMenu}
        onMouseDown={(e) => {
          if (e.target.closest('.desktop-icon, .desktop-sysicon')) return;
          startMarquee(e);
          if (sel.length) setDesktopSel([]);
          setSysSel(null);
          setAnchor(null);
          setState({ focusId: null }); // 焦点回到桌面
        }}
        onDragOver={(e) => {
          // 内部拖拽不接管：落到空白处等于原地放下
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
        }}
        onDrop={onContainerDrop}
      >
        {loading && <div className="desktop-loading"><div className="boot-spinner" /></div>}
        {!loading && error && <div className="desktop-hint err">⚠️ {error}</div>}
        {!loading && !error && files.length === 0 && (
          <div className="desktop-hint">桌面为空 · 在此右键新建文件或上传</div>
        )}

        <div
          className="desktop-grid"
          style={{
            '--di-cell-w': `${tier.cellW}px`,
            '--di-cell-h': `${tier.cellH}px`,
            '--di-label-size': `${tier.labelSize}px`,
          }}
        >
          {sysItems.map((it) => (
            <div
              key={it.key}
              className={`desktop-icon desktop-sysicon${sysSel === it.key ? ' selected' : ''}${dropTarget === it.key ? ' drop-target' : ''}`}
              title={it.label}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setSysSel(it.key); setDesktopSel([]); setState({ focusId: null }); }}
              onDoubleClick={(e) => { e.stopPropagation(); openSys(it.key); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); sysMenu(e, it.key); }}
              onDragOver={it.trash ? (e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(it.key); } : undefined}
              onDragLeave={it.trash ? () => setDropTarget((t) => (t === it.key ? null : t)) : undefined}
              onDrop={it.trash ? onDropOnTrash : undefined}
            >
              <span className="di-icon-wrap">
                <it.Icon size={tier.sys} full={it.trash ? s.trashCount > 0 : undefined} />
              </span>
              <span className="di-label">{it.label}</span>
              {it.trash && s.trashCount > 0 && <span className="desktop-badge">{s.trashCount}</span>}
            </div>
          ))}

          {shownFiles.map((entry, idx) => {
            const isSel = sel.includes(entry.name);
            const path = joinPath(cwd, entry.name);
            return (
              <div
                key={entry.name}
                data-entry={entry.name}
                className={`desktop-icon${isSel ? ' selected' : ''}${dropTarget === path ? ' drop-target' : ''}`}
                draggable={renaming !== entry.name}
                onClick={(e) => clickItem(e, entry, idx)}
                onDoubleClick={() => { if (renaming) return; openEntry(entry, cwd); }}
                onContextMenu={(e) => itemMenu(e, entry)}
                onDragStart={(e) => onDragStart(e, entry)}
                onDragOver={(e) => {
                  if (entry.type !== 'dir') return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(path);
                }}
                onDragLeave={() => setDropTarget((t) => (t === path ? null : t))}
                onDrop={(e) => onDropOnFolder(e, entry)}
                title={entry.name}
              >
                <span className={`di-icon-wrap${entry.type === 'dir' ? ' no-shadow' : ''}`}>
                  <FileIcon name={entry.name} type={entry.type} size={tier.icon} />
                </span>
                {renaming === entry.name ? (
                  <RenameInput value={entry.name} onSubmit={(v) => submitRename(entry.name, v)} onCancel={() => setRenaming(null)} />
                ) : (
                  <span className="di-label">{entry.name}</span>
                )}
              </div>
            );
          })}
        </div>

        {files.length > shownFiles.length && (
          <div className="desktop-hint">
            共 {files.length} 项，桌面只显示前 {MAX_ICONS} 项；其余请在「文件资源管理器」中查看。
          </div>
        )}

        {marquee && (
          <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.w, height: marquee.h }} />
        )}
      </div>

    </>
  );
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function RenameInput({ value, onSubmit, onCancel }) {
  const [v, setV] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    const input = ref.current;
    input?.focus();
    const dot = value.lastIndexOf('.');
    input?.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onSubmit(v);
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onSubmit(v)}
      draggable
      onDragStart={(e) => e.preventDefault()}
    />
  );
}
