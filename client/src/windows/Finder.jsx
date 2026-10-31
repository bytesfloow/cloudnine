import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  useStore, getState, bus, openWindow, openContextMenu, openQuickLook, openFile,
  promptDialog, confirmDialog, notify, setClipboard, setWindowTitle, updateWindowProps,
  setState, setFinderSel, basename, dirname, joinPath, fmtSize, fmtTime, fileCat, TEXT_EDITABLE,
} from '../store.js';
import { api } from '../api.js';
import { addUpload } from '../transfers.js';
import { FileIcon, IconSearch, IconChevron, IconGrid, IconList, IconRefresh, IconNewFolder, IconUpload } from '../icons.jsx';

export default function Finder({ win }) {
  const winIsTrash = !!win.props.trash;
  const [cwd, setCwd] = useState(winIsTrash ? '__trash__' : (win.props.cwd || ''));
  const [history, setHistory] = useState([winIsTrash ? '__trash__' : (win.props.cwd || '')]);
  const [hIdx, setHIdx] = useState(0);
  const [entries, setEntries] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [anchor, setAnchor] = useState(null);
  const [view, setView] = useState(win.props.view || 'icon');
  const [showHidden, setShowHidden] = useState(!!win.props.showHidden);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [sort, setSort] = useState({ key: 'name', asc: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [free, setFree] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [recents, setRecents] = useState([]);
  const [recentMode, setRecentMode] = useState(false);
  const [mounted, setMounted] = useState([]);
  const containerRef = useRef(null);
  const bodyRef = useRef(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  // 「是否处于废纸篓视图」：仅跟随当前目录。废纸篓窗口初始 cwd 即 __trash__，
  // 导航离开（主目录/最近等）后自动退出；「最近」是虚拟视图，不算废纸篓
  const isTrash = !recentMode && cwd === '__trash__';

  // 窗口标题与菜单状态：位置信息已由工具栏面包屑展示，标题栏不再重复显示目录名（「最近」无面包屑指示，保留）
  useEffect(() => {
    setWindowTitle(win.id, recentMode ? '最近' : '');
    updateWindowProps(win.id, { view, showHidden, cwd });
  }, [cwd, isTrash, searchMode, query, view, showHidden, recentMode]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const dir = currentRef.current;
      if (dir === '__trash__') {
        const r = await api.trashList();
        setEntries(r.entries.map((e) => ({ name: e.name, type: e.type, size: e.size, mtimeMs: e.mtimeMs, trashId: e.id })));
        setFree(null);
      } else if (recentRef.current) {
        const r = await api.recents();
        setEntries(r.items.map((x) => ({ name: x.name, type: 'file', size: 0, mtimeMs: x.at, path: x.path, isRecent: true })));
        setFree(null);
      } else {
        const r = await api.list(dir);
        setEntries(r.entries);
        setFree(r.free);
      }
    } catch (e) {
      setError(e.message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);
  const currentRef = useRef(cwd);
  currentRef.current = recentMode ? '__recent__' : cwd;
  const recentRef = useRef(false);
  recentRef.current = recentMode;

  useEffect(() => { load(); }, [cwd, searchMode, query, recentMode]);

  // 侧边栏数据
  useEffect(() => {
    api.recents().then((r) => setRecents(r.items)).catch(() => {});
    api.disk().then((d) => { setMounted(d.mounts); setState({ disk: d.mounts }); }).catch(() => {});
  }, []);

  // 文件系统变更 → 刷新
  useEffect(() => bus.on('fs:changed', (dir) => {
    if (dir === '__trash__') { if (currentRef.current === '__trash__') load(); return; }
    if (recentMode || searchMode) return;
    if (dir === cwd || cwd === '' || (dir && (cwd === dir || cwd.startsWith(dir + '/')))) load();
  }), [cwd, searchMode, recentMode, load]);

  // 菜单动作
  useEffect(() => bus.on('win-action', ({ windowId, action, arg }) => {
    if (windowId !== win.id) return;
    act(action, arg);
  }), [win.id]);

  // 选择状态上报（空格快速预览）
  useEffect(() => { setFinderSel(win.id, [...sel]); }, [sel, win.id]);

  function visibleNames() { return visible().map((e) => e.name); }

  function act(action, arg) {
    const st = getState();
    const selNames = [...selRef.current];
    const selPaths = selNames.map((n) => joinPath(cwd, n));
    const selectedEntries = entries?.filter((e) => selRef.current.has(e.name)) || [];
    switch (action) {
      case 'newFolder': return newItem('dir');
      case 'newFile': return newItem('file');
      case 'uploadFile': return pickUpload(false);
      case 'uploadFolder': return pickUpload(true);
      case 'openTerminal': return openWindow('terminal', { cwd: isTrash ? '' : cwd });
      case 'copy': if (!isTrash && selPaths.length) setClipboard('copy', selPaths, cwd); return;
      case 'cut': if (!isTrash && selPaths.length) setClipboard('cut', selPaths, cwd); return;
      case 'paste': return paste();
      case 'selectAll': return setSel(new Set(visibleNames()));
      case 'rename': if (selectedEntries[0]) setRenaming(selectedEntries[0].name); return;
      case 'trash': return trashSelected();
      case 'viewIcon': setView('icon'); return;
      case 'viewList': setView('list'); return;
      case 'toggleHidden': setShowHidden((v) => !v); return;
      case 'refresh': return load();
      case 'focus-search': return containerRef.current?.querySelector('.finder-search input')?.focus();
      case 'goHome': return navigate(st.homeRel || '');
      case 'goRoot': return navigate('');
      case 'goTrash': return navigate('__trash__');
      case 'goParent': return navigate(dirname(cwd));
      case 'goFolder': return goToFolder();
      case 'download': if (selPaths.length === 1 && selectedEntries[0]?.type !== 'dir') downloadPath(selPaths[0]); else if (selPaths.length) downloadZip(selPaths); return;
      case 'compress': if (selPaths.length) return compressDialog(selPaths); return;
      case 'share': if (selectedEntries[0]) return shareDialog({ path: joinPath(cwd, selectedEntries[0].name), name: selectedEntries[0].name }); return;
      case 'quickLook': {
        const files = selectedEntries.filter((e) => e.type !== 'dir').map((e) => joinPath(cwd, e.name));
        if (files.length) openQuickLook(files, 0);
        return;
      }
      case 'emptyTrash': return emptyTrash();
      case 'restore': return restoreSelected();
      default: return;
    }
  }

  // ---------- 导航 ----------
  function navigate(dir) {
    setRecentMode(false);
    setSearchMode(false);
    setQuery('');
    setSel(new Set());
    if (dir === cwd) return load();
    setCwd(dir);
    setHistory((h) => [...h.slice(0, hIdx + 1), dir]);
    setHIdx((i) => i + 1);
  }
  const back = () => { if (hIdx > 0) { setHIdx(hIdx - 1); setRecentMode(false); setSearchMode(false); setCwd(history[hIdx - 1]); setSel(new Set()); } };
  const fwd = () => { if (hIdx < history.length - 1) { setHIdx(hIdx + 1); setRecentMode(false); setSearchMode(false); setCwd(history[hIdx + 1]); setSel(new Set()); } };

  async function goToFolder() {
    const v = await promptDialog({ title: '前往文件夹', fields: [{ key: 'p', label: '路径（相对于文件根目录）', placeholder: '如 /home/user/docs', autofocus: true }] });
    if (!v?.p) return;
    navigate(String(v.p).replace(/^\/+|\/+$/g, ''));
  }

  function runSearch(q) {
    setQuery(q);
    if (!q) { setSearchMode(false); return; }
    setSearchMode(true);
    setSel(new Set());
  }

  // ---------- 选择 ----------
  function clickItem(e, entry, idx) {
    const sorted = visible();
    if (e.metaKey || e.ctrlKey) {
      setSel((s) => { const n = new Set(s); if (n.has(entry.name)) n.delete(entry.name); else n.add(entry.name); return n; });
      setAnchor(idx);
    } else if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
      setSel(new Set(sorted.slice(a, b + 1).map((x) => x.name)));
    } else {
      setSel(new Set([entry.name]));
      setAnchor(idx);
    }
  }

  // 橡皮筋框选
  function startMarquee(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.target.closest('.finder-item, input, button, .rename-input')) return;
    const box = bodyRef.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const onMove = (ev) => {
      const r = { x: Math.min(sx, ev.clientX), y: Math.min(sy, ev.clientY), w: Math.abs(ev.clientX - sx), h: Math.abs(ev.clientY - sy) };
      setMarquee({ ...r, left: r.x - box.left, top: r.y - box.top });
      const names = new Set();
      bodyRef.current.querySelectorAll('.finder-item').forEach((el) => {
        const er = el.getBoundingClientRect();
        if (er.left < r.x + r.w && er.right > r.x && er.top < r.y + r.h && er.bottom > r.y) names.add(el.dataset.name);
      });
      setSel(names);
    };
    const onUp = () => { setMarquee(null); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------- 打开 ----------
  function openEntry(entry) {
    if (entry.isRecent) return openFile(entry.path, entry.name);
    if (entry.trashId) return;
    if (entry.type === 'dir') {
      navigate(searchMode ? dirname(entry.path) : joinPath(cwd, entry.name));
      return;
    }
    openFile(joinPath(cwd, entry.name), entry.name);
  }

  // ---------- 新建 / 上传 / 重命名 / 剪贴板 ----------
  async function newItem(kind) {
    if (isTrash) return;
    const v = await promptDialog({
      title: kind === 'dir' ? '新建文件夹' : '新建空白文件',
      fields: [{ key: 'name', label: '名称', required: true, autofocus: true, placeholder: kind === 'dir' ? '文件夹名称' : '未命名.txt' }],
    });
    if (!v?.name) return;
    try {
      const p = joinPath(cwd, v.name);
      if (kind === 'dir') await api.mkdir(p);
      else await api.touch(p);
      bus.emit('fs:changed', cwd);
      if (kind === 'file') openWindow('editor', { path: p, name: v.name });
    } catch (e) { notify({ type: 'error', title: '创建失败', body: e.message }); }
  }

  function pickUpload(folder) {
    if (isTrash) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.onchange = () => {
      for (const f of input.files) addUpload(f, cwd, folder ? (f.webkitRelativePath || f.name) : '');
    };
    input.click();
  }

  async function submitRename(oldName, newName) {
    setRenaming(null);
    if (!newName || newName === oldName) return;
    try {
      await api.rename(joinPath(cwd, oldName), newName);
      bus.emit('fs:changed', cwd);
    } catch (e) { notify({ type: 'error', title: '重命名失败', body: e.message }); }
  }

  async function paste() {
    const cb = getState().clipboard;
    if (!cb || isTrash) return;
    try {
      if (cb.mode === 'copy') await api.copy(cb.paths, cwd);
      else await api.move(cb.paths, cwd);
      if (cb.mode === 'cut') setClipboard(null);
      bus.emit('fs:changed', cwd);
      bus.emit('fs:changed', cb.cwd);
    } catch (e) { notify({ type: 'error', title: '粘贴失败', body: e.message }); }
  }

  // ---------- 删除 ----------
  async function trashSelected() {
    if (isTrash || !sel.size) return;
    const names = [...sel];
    const ok = await confirmDialog({
      title: '移入废纸篓',
      message: names.length === 1 ? `要将“${names[0]}”移入废纸篓吗？` : `要将选中的 ${names.length} 项移入废纸篓吗？`,
      okText: '移入废纸篓',
    });
    if (!ok) return;
    try {
      await api.trash(names.map((n) => joinPath(cwd, n)));
      setSel(new Set());
      bus.emit('fs:changed', cwd);
      bus.emit('fs:changed', '__trash__');
    } catch (e) { notify({ type: 'error', title: '删除失败', body: e.message }); }
  }

  async function restoreSelected() {
    if (!isTrash || !sel.size) return;
    const ids = entries.filter((e) => sel.has(e.name)).map((e) => e.trashId).filter(Boolean);
    try {
      await api.trashRestore(ids);
      setSel(new Set());
      bus.emit('fs:changed', '__trash__');
    } catch (e) { notify({ type: 'error', title: '放回原处失败', body: e.message }); }
  }

  async function deleteForeverSelected() {
    if (!isTrash || !sel.size) return;
    const ok = await confirmDialog({ title: '彻底删除', message: `将彻底删除选中的 ${sel.size} 项，不可恢复。`, danger: true, okText: '删除' });
    if (!ok) return;
    const ids = entries.filter((e) => sel.has(e.name)).map((e) => e.trashId).filter(Boolean);
    const r = await api.trashDelete(ids);
    setState({ trashCount: r.trashCount });
    setSel(new Set());
    bus.emit('fs:changed', '__trash__');
  }

  async function emptyTrash() {
    if (!isTrash) return;
    const ok = await confirmDialog({ title: '清倒废纸篓', message: `将彻底删除废纸篓中的全部 ${entries?.length || 0} 项，不可恢复。`, danger: true, okText: '清倒' });
    if (!ok) return;
    await api.trashEmpty();
    setState({ trashCount: 0 });
    bus.emit('fs:changed', '__trash__');
  }

  // ---------- 下载 ----------
  function downloadPath(p) {
    const a = document.createElement('a');
    a.href = api.downloadUrl(p);
    a.download = '';
    a.click();
  }
  function downloadZip(paths) {
    const a = document.createElement('a');
    a.href = api.zipUrl(paths);
    a.download = '';
    a.click();
    notify({ type: 'info', title: '开始打包下载', body: `${paths.length} 项，浏览器将下载 zip 文件` });
  }

  // ---------- 压缩 / 解压 / 分享 ----------
  async function compressDialog(paths) {
    const v = await promptDialog({
      title: '压缩',
      wide: true,
      fields: [
        { key: 'format', label: '格式', type: 'select', value: 'zip', options: [{ value: 'zip', label: 'zip' }, { value: 'tar.gz', label: 'tar.gz' }, { value: 'tar', label: 'tar' }] },
        { key: 'name', label: '文件名（不含扩展名）', value: basename(paths[0]) || 'archive' },
      ],
      okText: '开始压缩',
    });
    if (!v) return;
    try {
      await api.archiveCreate({ paths, format: v.format, destDir: cwd, name: v.name || 'archive' });
      notify({ type: 'info', title: '压缩任务已开始', body: '进度可在传输窗口查看' });
      openWindow('transfers');
    } catch (e) { notify({ type: 'error', title: '压缩失败', body: e.message }); }
  }

  async function extractDialog(entry) {
    const p = joinPath(cwd, entry.name);
    const v = await promptDialog({
      title: `解压 ${entry.name}`,
      wide: true,
      fields: [
        { key: 'destDir', label: '解压到（目录）', value: cwd },
        { key: 'intoSubdir', label: '解压到以包名命名的子目录', type: 'checkbox', value: true },
      ],
      okText: '开始解压',
    });
    if (!v) return;
    try {
      await api.archiveExtract({ path: p, destDir: v.destDir || cwd, intoSubdir: !!v.intoSubdir });
      notify({ type: 'info', title: '解压任务已开始', body: '进度可在传输窗口查看' });
      openWindow('transfers');
    } catch (e) { notify({ type: 'error', title: '解压失败', body: e.message }); }
  }

  async function shareDialog({ path, name }) {
    const v = await promptDialog({
      title: `分享“${name}”`,
      wide: true,
      fields: [
        { key: 'expiresIn', label: '有效期', type: 'select', value: '604800', options: [
          { value: '3600', label: '1 小时' }, { value: '86400', label: '1 天' }, { value: '604800', label: '7 天' },
          { value: '2592000', label: '30 天' }, { value: '', label: '永久' },
        ] },
        { key: 'password', label: '访问密码（可选）', type: 'text' },
        { key: 'allowDownload', label: '允许下载', type: 'checkbox', value: true },
        { key: 'allowUpload', label: '允许他人上传到此目录', type: 'checkbox', value: false },
        { key: 'maxDownloads', label: '下载次数上限（可选）', type: 'number' },
        { key: 'note', label: '备注（可选）', type: 'text' },
      ],
      okText: '创建分享',
    });
    if (!v) return;
    try {
      const r = await api.shareCreate({
        path,
        expiresIn: v.expiresIn || null,
        password: v.password || null,
        allowDownload: !!v.allowDownload,
        allowUpload: !!v.allowUpload,
        maxDownloads: v.maxDownloads || null,
        note: v.note,
      });
      const url = `${location.origin}/s/${r.share.token}`;
      navigator.clipboard?.writeText(url).catch(() => {});
      notify({ type: 'success', title: '分享链接已创建并复制', body: url });
    } catch (e) { notify({ type: 'error', title: '创建分享失败', body: e.message }); }
  }

  // ---------- 右键菜单 ----------
  function itemMenu(e, entry) {
    e.preventDefault(); e.stopPropagation();
    if (!sel.has(entry.name)) setSel(new Set([entry.name]));
    const paths = joinPath(cwd, entry.name);
    const items = isTrash ? [
      { label: '放回原处', action: restoreSelected, disabled: !sel.size },
      { label: '彻底删除…', danger: true, action: deleteForeverSelected, disabled: !sel.size },
      '-',
      { label: '清倒废纸篓…', danger: true, action: emptyTrash },
    ] : [
      { label: entry.type === 'dir' ? '打开' : '打开', action: () => openEntry(entry) },
      ...(entry.type !== 'dir' ? [{ label: '快速预览', action: () => openQuickLook([paths], 0) }] : []),
      '-',
      { label: '重命名', action: () => setRenaming(entry.name), disabled: sel.size > 1 },
      { label: '复制', action: () => setClipboard('copy', [paths], cwd) },
      { label: '剪切', action: () => setClipboard('cut', [paths], cwd) },
      '-',
      ...(entry.type !== 'dir' ? [{ label: '下载', action: () => downloadPath(paths) }] : []),
      { label: '压缩…', action: () => compressDialog(sel.has(entry.name) ? [...sel].map((n) => joinPath(cwd, n)) : [paths]) },
      ...(fileCat(entry.name) === 'archive' ? [{ label: '解压到…', action: () => extractDialog(entry) }] : []),
      '-',
      { label: '分享…', action: () => shareDialog({ path: paths, name: entry.name }) },
      { label: '显示简介', action: () => openWindow('info', { path: paths }) },
      { label: '复制路径', action: () => navigator.clipboard?.writeText('/' + paths).then(() => notify({ title: '路径已复制' })).catch(() => {}) },
      ...(entry.type === 'dir' ? [{ label: '在终端中打开', action: () => openWindow('terminal', { cwd: paths }) }] : []),
      '-',
      { label: '移入废纸篓', danger: true, action: trashSelected },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  }

  function blankMenu(e) {
    if (e.target.closest('.finder-item, input, button, .rename-input')) return;
    e.preventDefault();
    const cb = getState().clipboard;
    openContextMenu(e.clientX, e.clientY, isTrash ? [
      { label: '清倒废纸篓…', danger: true, action: emptyTrash },
      { label: '刷新', action: () => load() },
    ] : [
      { label: '新建文件夹', action: () => newItem('dir') },
      { label: '新建空白文件', action: () => newItem('file') },
      '-',
      { label: cb ? (cb.mode === 'copy' ? '粘贴项目' : '移动项目到此处') : '粘贴', disabled: !cb, action: paste },
      { label: '粘贴为副本', disabled: !cb || cb.mode !== 'copy', action: async () => { try { await api.copy(cb.paths, cwd); bus.emit('fs:changed', cwd); } catch (e2) { notify({ type: 'error', title: '粘贴失败', body: e2.message }); } } },
      '-',
      { label: '上传文件…', action: () => pickUpload(false) },
      { label: '上传文件夹…', action: () => pickUpload(true) },
      '-',
      { label: '显示隐藏文件', checked: showHidden, action: () => setShowHidden((v) => !v) },
      { label: '在终端中打开', action: () => openWindow('terminal', { cwd }) },
      '-',
      { label: '排序方式', action: (evt) => sortMenu(evt) },
      { label: '刷新', action: () => load() },
    ]);
  }

  function sortMenu(e) {
    const rect = e?.currentTarget?.getBoundingClientRect();
    openContextMenu(rect?.left || 200, rect?.bottom || 200, [
      { label: '按名称', checked: sort.key === 'name', action: () => setSort((s) => ({ ...s, key: 'name' })) },
      { label: '按大小', checked: sort.key === 'size', action: () => setSort((s) => ({ ...s, key: 'size' })) },
      { label: '按修改时间', checked: sort.key === 'mtime', action: () => setSort((s) => ({ ...s, key: 'mtime' })) },
      '-',
      { label: sort.asc ? '改为降序' : '改为升序', action: () => setSort((s) => ({ ...s, asc: !s.asc })) },
    ]);
  }

  // ---------- 拖拽 ----------
  function onItemDragStart(e, entry) {
    const paths = sel.has(entry.name) ? [...sel].map((n) => joinPath(cwd, n)) : [joinPath(cwd, entry.name)];
    e.dataTransfer.setData('application/x-skydesk', JSON.stringify({ paths, cwd, mode: e.altKey ? 'copy' : 'move' }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }
  async function onDropToDir(e, targetDir) {
    e.preventDefault(); e.stopPropagation();
    const raw = e.dataTransfer.getData('application/x-skydesk');
    if (raw) {
      try {
        const { paths, mode } = JSON.parse(raw);
        if (mode === 'copy') await api.copy(paths, targetDir);
        else await api.move(paths, targetDir);
        bus.emit('fs:changed', targetDir);
        bus.emit('fs:changed', dirname(paths[0]));
      } catch (err2) { notify({ type: 'error', title: '操作失败', body: err2.message }); }
    } else if (e.dataTransfer.files.length) {
      for (const f of e.dataTransfer.files) addUpload(f, targetDir);
    }
  }

  // ---------- 渲染辅助 ----------
  function visible() {
    if (!entries) return [];
    let list = (showHidden || isTrash) ? entries : entries.filter((e) => !e.hidden);
    if (query && !searchMode) list = list.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()));
    const dirFirst = (a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'zh'),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      mtime: (a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0),
    }[sort.key] || ((a, b) => a.name.localeCompare(b.name, 'zh'));
    return [...list].sort((a, b) => (dirFirst(a, b) || cmp(a, b)) * (sort.asc ? 1 : -1));
  }

  const shown = visible();
  const crumbs = cwd === '__trash__'
    ? [{ label: '废纸篓', dir: '__trash__' }]
    : [{ label: '根目录', dir: '' }, ...cwd.split('/').filter(Boolean).map((seg, i, arr) => ({ label: seg, dir: arr.slice(0, i + 1).join('/') }))];

  return (
    <div className="finder" ref={containerRef} onContextMenu={blankMenu}>
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

      <div className="finder-main">
        <div className="finder-sidebar">
          <div className="sb-group">个人收藏</div>
          <SideItem label="主目录" onClick={() => navigate(getState().homeRel || '')} dropdir={getState().homeRel || ''} active={cwd === getState().homeRel && !isTrash && !recentMode} />
          {/* 主目录与根目录重合（homeRel 为空）时不重复显示根目录 */}
          {getState().homeRel && <SideItem label="根目录" onClick={() => navigate('')} dropdir="" active={cwd === '' && !isTrash && !recentMode} />}
          <SideItem label="最近" onClick={() => { setRecentMode(true); setCwd(''); setSel(new Set()); }} active={recentMode} />
          <SideItem label="废纸篓" onClick={() => navigate('__trash__')} active={isTrash} />
          {mounted.filter((m) => m.mountRel != null).length > 0 && (
            <>
              <div className="sb-group">位置</div>
              {mounted.filter((m) => m.mountRel != null).map((m) => (
                <SideItem key={m.mount} label={m.mount} small onClick={() => navigate(m.mountRel)} dropdir={m.mountRel} active={cwd === m.mountRel} />
              ))}
            </>
          )}
        </div>

        <div className="finder-content" ref={bodyRef} onMouseDown={startMarquee}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length && !isTrash && !recentMode) {
              e.preventDefault();
              for (const f of e.dataTransfer.files) addUpload(f, cwd);
            }
          }}
        >
          {(!recentMode || searchMode) && (
            <div className="finder-crumbs">
              {crumbs.map((c, i) => (
                <React.Fragment key={c.dir}>
                  {i > 0 && <IconChevron size={9} />}
                  <button className="crumb" onClick={() => !isTrash && navigate(c.dir)}>{c.label}</button>
                </React.Fragment>
              ))}
              {searchMode && <span className="crumb-note">搜索“{query}”的结果</span>}
            </div>
          )}

          {loading ? (
            <div className="finder-loading"><div className="boot-spinner" /></div>
          ) : error ? (
            <div className="finder-empty">
              <p>⚠️ {error}</p>
              <button className="btn" onClick={() => load()}>重试</button>
            </div>
          ) : shown.length === 0 ? (
            <div className="finder-empty">
              <p>{searchMode ? '没有找到匹配的项目' : isTrash ? '废纸篓是空的' : recentMode ? '最近没有打开过文件' : '此文件夹是空的'}</p>
            </div>
          ) : view === 'icon' ? (
            <div className="icon-grid">
              {shown.map((entry, idx) => (
                <div
                  key={entry.name + (entry.path || '')}
                  data-name={entry.name}
                  className={`finder-item icon-item${sel.has(entry.name) ? ' selected' : ''}`}
                  onClick={(e) => clickItem(e, entry, idx)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(e) => itemMenu(e, entry)}
                  draggable={!renaming}
                  onDragStart={(e) => !entry.trashId && onItemDragStart(e, entry)}
                  onDragOver={(e) => { if (entry.type === 'dir' && !entry.isRecent) { e.preventDefault(); e.stopPropagation(); } }}
                  onDrop={(e) => { if (entry.type === 'dir' && !entry.isRecent) onDropToDir(e, joinPath(cwd, entry.name)); }}
                  title={entry.name}
                >
                  <FileIcon name={entry.name} type={entry.type} size={52} />
                  {renaming === entry.name ? (
                    <RenameInput value={entry.name} onSubmit={(v) => submitRename(entry.name, v)} onCancel={() => setRenaming(null)} />
                  ) : (
                    <span className="item-name">{entry.name}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="list-view">
              <div className="list-header">
                <span className="col-name" onClick={() => setSort((s) => ({ key: 'name', asc: s.key === 'name' ? !s.asc : true }))}>名称{sort.key === 'name' ? (sort.asc ? ' ↑' : ' ↓') : ''}</span>
                <span className="col-size" onClick={() => setSort((s) => ({ key: 'size', asc: s.key === 'size' ? !s.asc : true }))}>大小{sort.key === 'size' ? (sort.asc ? ' ↑' : ' ↓') : ''}</span>
                <span className="col-mtime" onClick={() => setSort((s) => ({ key: 'mtime', asc: s.key === 'mtime' ? !s.asc : true }))}>修改时间{sort.key === 'mtime' ? (sort.asc ? ' ↑' : ' ↓') : ''}</span>
                <span className="col-mode">权限</span>
                <span className="col-owner">所有者</span>
              </div>
              <div className="list-body">
                {shown.map((entry, idx) => (
                  <div
                    key={entry.name + (entry.path || '')}
                    data-name={entry.name}
                    className={`finder-item list-item${sel.has(entry.name) ? ' selected' : ''}`}
                    onClick={(e) => clickItem(e, entry, idx)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(e) => itemMenu(e, entry)}
                    draggable={!renaming}
                    onDragStart={(e) => !entry.trashId && onItemDragStart(e, entry)}
                    onDragOver={(e) => { if (entry.type === 'dir' && !entry.isRecent) { e.preventDefault(); e.stopPropagation(); } }}
                    onDrop={(e) => { if (entry.type === 'dir' && !entry.isRecent) onDropToDir(e, joinPath(cwd, entry.name)); }}
                  >
                    <span className="col-name item-file">
                      <FileIcon name={entry.name} type={entry.type} size={20} />
                      {renaming === entry.name
                        ? <RenameInput value={entry.name} onSubmit={(v) => submitRename(entry.name, v)} onCancel={() => setRenaming(null)} />
                        : <span className="item-name">{entry.name}</span>}
                    </span>
                    <span className="col-size">{entry.type === 'dir' ? '—' : fmtSize(entry.size)}</span>
                    <span className="col-mtime">{fmtTime(entry.mtimeMs)}</span>
                    <span className="col-mode mono">{entry.modeStr || '—'}</span>
                    <span className="col-owner mono">{entry.uid != null ? `${entry.uid}:${entry.gid}` : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {marquee && <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>

      <div className="finder-statusbar">
        <span>{shown.length} 个项目</span>
        {sel.size > 0 && <span>已选择 {sel.size} 项</span>}
        {free != null && <span className="sb-free">可用 {fmtSize(free)}</span>}
        {isTrash && entries?.length > 0 && <button className="btn btn-small" onClick={emptyTrash}>清倒…</button>}
      </div>
    </div>
  );
}

function SideItem({ label, onClick, active, dropdir, small }) {
  return (
    <button
      className={`sb-item${active ? ' active' : ''}${small ? ' small' : ''}`}
      onClick={onClick}
      data-dropdir={dropdir}
      onDragOver={(e) => { if (dropdir != null) e.preventDefault(); }}
      onDrop={(e) => {
        if (dropdir == null) return;
        const raw = e.dataTransfer.getData('application/x-skydesk');
        if (!raw) return;
        const { paths } = JSON.parse(raw);
        api.move(paths, dropdir).then(() => bus.emit('fs:changed', dropdir)).catch((e2) => notify({ type: 'error', title: '移动失败', body: e2.message }));
      }}
    >
      {label}
    </button>
  );
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
