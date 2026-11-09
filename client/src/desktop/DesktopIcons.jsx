import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useStore, getState, setState, openWindow, openContextMenu, openQuickLook, bus,
  setDesktopSel, setDesktopSort, setDesktopShowHidden, joinPath, basename,
} from '../store.js';
import { api } from '../api.js';
import { FileIcon, IconGlobe, IconTrash } from '../icons.jsx';
import {
  createItem, uploadTo, uploadDropped, copyToClipboard, cutToClipboard, pasteInto,
  trashItems, renameItem, downloadItem, downloadItems, compressItems, extractItem,
  shareItem, copyPathText, openEntry, isArchive,
} from '../fsops.js';

// 桌面 = 用户主目录的直视图：每一个图标都是主目录里的真实文件 / 文件夹。
// 图标位置不再手工摆放（同属一个目录，拖到空白处移动无意义），完全由排序规则决定；
// 拖拽的语义改为「移动文件」：拖到文件夹上=移入该文件夹，拖到废纸篓上=删除。
const DRAG_TYPE = 'application/x-cloudnine';

// 桌面一次性渲染的图标上限：主目录条目极多时避免页面卡死，
// 超出的部分明确提示「去文件窗口看」，不做静默截断。
const MAX_ICONS = 400;

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

  const layerRef = useRef(null);

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

  // ---------- 选择 ----------
  function clickItem(e, entry, idx) {
    setState({ focusId: null }); // 点桌面图标：焦点回到桌面，菜单栏切到桌面菜单
    if (e.metaKey || e.ctrlKey) {
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
    if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
    if (e.target.closest('.desktop-icon, .desktop-sysicon, input, button')) return;
    const box = layerRef.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const onMove = (ev) => {
      const r = { x: Math.min(sx, ev.clientX), y: Math.min(sy, ev.clientY), w: Math.abs(ev.clientX - sx), h: Math.abs(ev.clientY - sy) };
      setMarquee({ ...r, left: r.x - box.left, top: r.y - box.top });
      const names = new Set();
      layerRef.current.querySelectorAll('.desktop-icon[data-entry]').forEach((el) => {
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
    openContextMenu(e.clientX, e.clientY, [
      { label: '打开', action: () => openEntry(entry, cwd) },
      ...(entry.type !== 'dir' ? [{ label: '快速预览', action: () => openQuickLook(filesOnly.length ? filesOnly : [path], 0) }] : []),
      '-',
      { label: '重命名', action: startRename, disabled: multi },
      { label: '复制', action: () => copyToClipboard(paths, cwd) },
      { label: '剪切', action: () => cutToClipboard(paths, cwd) },
      '-',
      ...(entry.type !== 'dir' ? [{ label: '下载', action: () => downloadItem(path) }] : []),
      ...(paths.length > 1 ? [{ label: '打包下载', action: () => downloadItems(paths) }] : []),
      { label: '压缩…', action: () => compressItems(paths, cwd) },
      ...(isArchive(entry) ? [{ label: '解压到…', action: () => extractItem(path, cwd) }] : []),
      '-',
      { label: '分享…', action: () => shareItem(path, entry.name) },
      { label: '显示简介', action: () => openWindow('info', { path }) },
      { label: '复制路径', action: () => copyPathText(path) },
      ...(entry.type === 'dir' ? [{ label: '在终端中打开', action: () => openWindow('terminal', { cwd: path }) }] : []),
      '-',
      { label: '移入废纸篓', danger: true, action: () => doTrash(paths, targets.map((x) => x.name)) },
    ]);
  }

  function blankMenu(e) {
    if (e.target.closest('.desktop-icon, .desktop-sysicon, input, button')) return;
    e.preventDefault();
    const cb = getState().clipboard;
    openContextMenu(e.clientX, e.clientY, [
      { label: '新建文件夹', action: () => doCreate('dir') },
      { label: '新建空白文件', action: () => doCreate('file') },
      '-',
      {
        label: cb ? (cb.mode === 'copy' ? '粘贴项目' : '移动项目到此处') : '粘贴',
        disabled: !cb,
        action: () => pasteInto(cwd),
      },
      '-',
      { label: '上传文件…', action: () => uploadTo(cwd, false) },
      { label: '上传文件夹…', action: () => uploadTo(cwd, true) },
      '-',
      { label: '显示隐藏文件', checked: s.desktopShowHidden, action: () => setDesktopShowHidden(!s.desktopShowHidden) },
      { label: '文件夹优先', checked: s.desktopSort.dirsFirst, action: () => setDesktopSort({ ...s.desktopSort, dirsFirst: !s.desktopSort.dirsFirst }) },
      { label: '按名称排列', checked: s.desktopSort.key === 'name', action: () => setDesktopSort({ ...s.desktopSort, key: 'name' }) },
      { label: '按大小排列', checked: s.desktopSort.key === 'size', action: () => setDesktopSort({ ...s.desktopSort, key: 'size' }) },
      { label: '按修改时间排列', checked: s.desktopSort.key === 'mtime', action: () => setDesktopSort({ ...s.desktopSort, key: 'mtime' }) },
      { label: '按类型排列', checked: s.desktopSort.key === 'type', action: () => setDesktopSort({ ...s.desktopSort, key: 'type' }) },
      '-',
      { label: '刷新', action: () => load() },
    ]);
  }

  // ---------- 拖拽 ----------
  function onDragStart(e, entry) {
    const names = sel.includes(entry.name) ? sel : [entry.name];
    const paths = names.map((n) => joinPath(cwd, n));
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ paths, cwd, mode: e.altKey ? 'copy' : 'move' }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  // 拖到文件夹上：移入该文件夹（按住 Alt 为复制）
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

  // 拖到废纸篓上：删除
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

  // ---------- 菜单栏 / 快捷键动作 ----------
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
      case 'quickLook': {
        const previewFiles = selectedEntries.filter((e) => e.type !== 'dir').map((e) => joinPath(cwd, e.name));
        if (previewFiles.length) openQuickLook(previewFiles, 0);
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
  }), [cwd, selectedPaths, selectedEntries, files]);

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
          setAnchor(null);
          setState({ focusId: null }); // 焦点回到桌面：菜单栏切换为桌面菜单
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

        <div className="desktop-grid">
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
                <span className="di-icon-wrap">
                  <FileIcon name={entry.name} type={entry.type} size={52} />
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
            共 {files.length} 项，桌面只显示前 {MAX_ICONS} 项；其余请在「文件」窗口中查看。
          </div>
        )}

        {marquee && (
          <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.w, height: marquee.h }} />
        )}
      </div>

      {/* 系统图标：根目录 / 废纸篓（固定在右下角，废纸篓可接收拖入的文件） */}
      <div className="desktop-sysicons">
        <button
          className="desktop-sysicon"
          title="根目录"
          onClick={() => openWindow('finder', { cwd: '' })}
          onDoubleClick={() => openWindow('finder', { cwd: '' })}
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, [
              { label: '打开根目录', action: () => openWindow('finder', { cwd: '' }) },
              { label: '在终端中打开', action: () => openWindow('terminal', { cwd: '' }) },
            ]);
          }}
        >
          <span className="di-icon-wrap"><IconGlobe size={48} /></span>
          <span className="di-label">根目录</span>
        </button>
        <button
          className={`desktop-sysicon${dropTarget === '__trash__' ? ' drop-target' : ''}`}
          title="废纸篓"
          onClick={() => openWindow('finder', { trash: true })}
          onDoubleClick={() => openWindow('finder', { trash: true })}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget('__trash__'); }}
          onDragLeave={() => setDropTarget((t) => (t === '__trash__' ? null : t))}
          onDrop={onDropOnTrash}
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, [
              { label: '打开废纸篓', action: () => openWindow('finder', { trash: true }) },
              ...(s.trashCount > 0 ? ['-', {
                label: '清倒废纸篓', danger: true, action: async () => {
                  const { confirmDialog } = await import('../store.js');
                  if (await confirmDialog({ title: '清倒废纸篓', message: `将彻底删除废纸篓中的 ${s.trashCount} 项，此操作不可撤销。`, danger: true, okText: '清倒' })) {
                    await api.trashEmpty();
                    setState({ trashCount: 0 });
                    bus.emit('fs:changed', '__trash__');
                  }
                },
              }] : []),
            ]);
          }}
        >
          <span className="di-icon-wrap"><IconTrash size={48} full={s.trashCount > 0} /></span>
          <span className="di-label">废纸篓</span>
          {s.trashCount > 0 && <span className="desktop-badge">{s.trashCount}</span>}
        </button>
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
