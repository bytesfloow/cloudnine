import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  useStore, getState, bus, openWindow, openContextMenu, openFile,
  promptDialog, confirmDialog, notify, setClipboard, setWindowTitle, updateWindowProps,
  setState, setFinderSel, basename, dirname, joinPath, fmtSize, fileCat, TEXT_EDITABLE,
} from '../store.js';
import { api } from '../api.js';
import { addUpload, pickFiles } from '../transfers.js';
import {
  createItem, uploadTo, copyToClipboard, cutToClipboard, pasteInto, trashItems, renameItem,
  downloadItem, downloadItems, compressItems, extractItem, shareItem, shareBlockReason, copyPathText, isArchive,
  syncTrashCount, openWithItems, openRecentItem, dropDeadRecents,
} from '../fsops.js';
import FinderToolbar from './finder/FinderToolbar.jsx';
import FinderCommandBar from './finder/FinderCommandBar.jsx';
import FinderSidebar from './finder/FinderSidebar.jsx';
import FinderIconView from './finder/FinderIconView.jsx';
import FinderListView from './finder/FinderListView.jsx';

export default function Finder({ win }) {
  const s = useStore();
  const clipboard = s.clipboard;
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
  const containerRef = useRef(null);
  const bodyRef = useRef(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  // 「是否处于废纸篓视图」：仅跟随当前目录。废纸篓窗口初始 cwd 即 __trash__，
  // 导航离开（主目录/最近等）后自动退出；「最近」是虚拟视图，不算废纸篓
  const isTrash = !recentMode && cwd === '__trash__';

  // 窗口标题与菜单状态：标题栏显示当前目录名（「最近」是虚拟视图，保留原名）
  useEffect(() => {
    const title = recentMode ? '最近' : isTrash ? '废纸篓' : (cwd === '' ? '根目录' : basename(cwd));
    setWindowTitle(win.id, title);
    // pasteBlocked 供全局粘贴上传判断目标目录：虚拟视图/废纸篓不允许写入
    const pasteBlocked = recentMode ? '最近使用' : searchMode ? '搜索结果' : isTrash ? '废纸篓' : null;
    updateWindowProps(win.id, { view, showHidden, cwd, pasteBlocked });
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
        // 已判定失效（文件被删 / 改名）的记录不再出现；正常条目不改一发请求
        setEntries(dropDeadRecents(r.items).map((x) => ({ name: x.name, type: 'file', size: 0, mtimeMs: x.at, path: x.path, isRecent: true })));
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
    // 磁盘信息喂给任务栏托盘/磁盘窗口，侧边栏不再展示挂载点（「位置」分组已移除）
    api.disk().then((d) => setState({ disk: d.mounts })).catch(() => {});
  }, []);

  // 文件系统变更 → 刷新
  useEffect(() => bus.on('fs:changed', (dir) => {
    if (dir === '__trash__') { if (currentRef.current === '__trash__') load(); return; }
    if (recentMode || searchMode) return;
    if (dir === cwd || cwd === '' || (dir && (cwd === dir || cwd.startsWith(dir + '/')))) load();
  }), [cwd, searchMode, recentMode, load]);

  // 菜单动作
  // 这里不能只依赖 win.id：Finder 导航时组件不重挂载，固定依赖会让 act 闭包
  // 永远拿到打开窗口时的 cwd，导致菜单“粘贴”把文件放回复制时的源目录。
  useEffect(() => bus.on('win-action', ({ windowId, action, arg }) => {
    if (windowId !== win.id) return;
    act(action, arg);
  }));

  // F3 / F5 / Alt+←→↑ / Ctrl+L / Enter / Alt+Enter 已统一由桌面壳的全局 keydown 派发到
  // win-action（见 desktop/Desktop.jsx §3.2），窗口内不再重复挂监听，避免同一次按键执行两次。

  // 选择状态上报（外壳级选择操作 / 后续预览窗格）：上报完整相对路径而不是裸文件名，
  // 否则在子文件夹按空格会请求 /api/fs/stat?path=1.jpg 这类不存在的路径。
  useEffect(() => {
    const paths = [...sel]
      .map((name) => entries?.find((e) => e.name === name))
      .filter((e) => e && e.type !== 'dir' && !e.trashId)
      .map((e) => e.path || joinPath(cwd, e.name));
    setFinderSel(win.id, paths);
  }, [sel, entries, cwd, win.id]);

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
      case 'copy': if (!isTrash && selPaths.length) copyToClipboard(selPaths, cwd); return;
      case 'cut': if (!isTrash && selPaths.length) cutToClipboard(selPaths, cwd); return;
      case 'paste': return paste();
      // 命令栏「粘贴 ▾ › 粘贴为副本」：复制模式下的内部剪贴板再复制一份
      case 'pasteCopy': return pasteCopy();
      // 命令栏「粘贴 ▾ › 清空剪贴板」：原顶栏「编辑」菜单的 __clearClipboard 在这里的落点
      case 'clearClipboard': return setClipboard(null);
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
      case 'share': if (selectedEntries[0]) return shareDialog({ path: joinPath(cwd, selectedEntries[0].name), name: selectedEntries[0].name, entry: selectedEntries[0] }); return;
      // 预览窗口（macOS 空格预览浮层已删除）：path/name 定位文件，siblings 供 ←/→ 切换
      case 'preview': {
        const files = selectedEntries.filter((e) => e.type !== 'dir').map((e) => joinPath(cwd, e.name));
        return openPreview(files);
      }
      // Enter：打开选中项（多选时逐个打开，与 Win11 一致）
      case 'open': {
        selectedEntries.forEach((en) => openEntry(en));
        return;
      }
      // 空格：切换当前选中项（不再触发预览）
      case 'toggleSel': return toggleCurrent();
      // Alt+Enter：属性
      case 'showInfo': {
        const one = selectedEntries.length === 1 ? selectedEntries[0] : null;
        if (one) openWindow('info', { path: one.path || joinPath(cwd, one.name) });
        return;
      }
      // Alt+← / →：目录历史后退 / 前进
      case 'goBack': return back();
      case 'goForward': return fwd();
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
    // C9：多选修饰键只认 Ctrl（⌘ 不再参与），Shift 连选保留
    if (e.ctrlKey) {
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
    // C10：框选修饰键只认 Ctrl
    if (e.button !== 0 || e.ctrlKey || e.target.closest('.finder-item, input, button, .rename-input')) return;
    // 空白处只做橡皮筋框选，别让浏览器同时启动原生文本拖选
    e.preventDefault();
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
  // 「最近」是虚拟视图：条目的真实路径存在 entry.path（而不是 cwd + 名字）
  const pathOf = (entry) => entry.path || joinPath(cwd, entry.name);

  function openEntry(entry) {
    if (entry.isRecent) return openRecent(entry);
    if (entry.trashId) return;
    if (entry.type === 'dir') {
      navigate(searchMode ? dirname(entry.path) : joinPath(cwd, entry.name));
      return;
    }
    openFile(joinPath(cwd, entry.name), entry.name);
  }

  // 点击过期条目：只在点击这一下才发一次请求（绝不预发）。文件不在了 → 友好提示 + 从「最近」剔除
  async function openRecent(entry) {
    const r = await openRecentItem(entry);
    if (r === 'missing') setEntries((prev) => (prev || []).filter((e) => e.path !== entry.path));
  }

  // 打开预览窗口（macOS 空格预览浮层已删除）：path/name 定位文件，siblings 供 ←/→ 切换
  function openPreview(paths) {
    if (!paths.length) return;
    openWindow('preview', { path: paths[0], name: basename(paths[0]), siblings: paths, index: 0 });
  }

  // 空格：切换当前项（锚点）的选中态
  function toggleCurrent() {
    const cur = anchor != null ? visible()[anchor] : null;
    if (!cur) return;
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(cur.name)) n.delete(cur.name); else n.add(cur.name);
      return n;
    });
  }

  // ---------- 新建 / 上传 / 重命名 / 剪贴板 ----------
  async function newItem(kind) {
    if (isTrash) return;
    const p = await createItem(cwd, kind);
    if (!p) return;
    if (kind === 'file') openWindow('editor', { path: p, name: basename(p) });
  }

  function pickUpload(folder) {
    if (isTrash) return;
    uploadTo(cwd, folder);
  }

  async function submitRename(oldName, newName) {
    setRenaming(null);
    if (!newName || newName === oldName) return;
    await renameItem(joinPath(cwd, oldName), newName);
  }

  async function paste() {
    if (isTrash) return;
    await pasteInto(cwd);
  }

  // 粘贴为副本：只对「复制」模式的内部剪贴板有意义（剪切没有副本可言）
  async function pasteCopy() {
    if (isTrash) return;
    const cb = getState().clipboard;
    if (!cb || cb.mode !== 'copy') return;
    try {
      await api.copy(cb.paths, cwd);
      bus.emit('fs:changed', cwd);
    } catch (e) {
      notify({ type: 'error', title: '粘贴失败', body: e.message });
    }
  }

  // ---------- 删除 ----------
  async function trashSelected() {
    if (isTrash || !sel.size) return;
    const names = [...sel];
    const ok = await trashItems(names.map((n) => joinPath(cwd, n)), names);
    if (ok) setSel(new Set());
  }

  async function restoreSelected() {
    if (!isTrash || !sel.size) return;
    const ids = entries.filter((e) => sel.has(e.name)).map((e) => e.trashId).filter(Boolean);
    try {
      const r = await api.trashRestore(ids);
      syncTrashCount(r);
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
    syncTrashCount(r);
    setSel(new Set());
    bus.emit('fs:changed', '__trash__');
  }

  async function emptyTrash() {
    if (!isTrash) return;
    const ok = await confirmDialog({ title: '清空回收站', message: `将彻底删除回收站中的全部 ${entries?.length || 0} 项，不可恢复。`, danger: true, okText: '清空' });
    if (!ok) return;
    await api.trashEmpty();
    setState({ trashCount: 0 });
    bus.emit('fs:changed', '__trash__');
  }

  // ---------- 下载 ----------
  function downloadPath(p) {
    downloadItem(p);
  }
  function downloadZip(paths) {
    downloadItems(paths);
  }

  // ---------- 压缩 / 解压 / 分享 ----------
  function compressDialog(paths) {
    return compressItems(paths, cwd);
  }

  function extractDialog(entry) {
    return extractItem(joinPath(cwd, entry.name), cwd);
  }

  function shareDialog({ path, name, entry }) {
    return shareItem(path, name, entry);
  }

  // ---------- 右键菜单 ----------
  // 结构对齐 docs §1.5（新建 ▸ / 打开方式 ▸ / 发送到 ▸），项与改造前逐条一致：
  // 只是把「在终端中打开」「下载」「复制路径」从平铺收进子菜单，不增不减。
  // 「打开方式 ▸」与桌面图标右键共用 fsops.openWithItems，两处集合逐项一致。
  function itemMenu(e, entry) {
    e.preventDefault(); e.stopPropagation();
    if (!sel.has(entry.name)) setSel(new Set([entry.name]));
    const paths = pathOf(entry);
    const items = isTrash ? [
      { label: '放回原处', action: restoreSelected, disabled: !sel.size },
      { label: '彻底删除…', danger: true, action: deleteForeverSelected, disabled: !sel.size },
      '-',
      { label: '清空回收站…', danger: true, action: emptyTrash },
    ] : [
      { label: '打开', action: () => openEntry(entry) },
      ...(entry.type !== 'dir' ? [{ label: '预览', action: () => openPreview([paths]) }] : []),
      // 文件 = 用编辑器打开 / 用预览打开，目录 = 在终端中打开（§1.5，与桌面右键同一份）
      { label: '打开方式', items: openWithItems(paths, entry) },
      '-',
      { label: '剪切', action: () => setClipboard('cut', [paths], cwd) },
      { label: '复制', action: () => setClipboard('copy', [paths], cwd) },
      '-',
      { label: '重命名', action: () => setRenaming(entry.name), disabled: sel.size > 1 },
      { label: '删除', danger: true, action: trashSelected },
      '-',
      { label: '压缩…', action: () => compressDialog(sel.has(entry.name) ? [...sel].map((n) => joinPath(cwd, n)) : [paths]) },
      ...(isArchive(entry) ? [{ label: '解压到…', action: () => extractDialog(entry) }] : []),
      { label: '发送到', items: [
        ...(entry.type !== 'dir' ? [{ label: '下载', action: () => downloadPath(paths) }] : []),
        { label: '复制路径', action: () => copyPathText(paths) },
      ] },
      '-',
      { label: shareBlockReason(entry) ? `分享…（${shareBlockReason(entry)}）` : '分享…', disabled: !!shareBlockReason(entry), action: () => shareDialog({ path: paths, name: entry.name, entry }) },
      { label: '属性', action: () => openWindow('info', { path: paths }) },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  }

  function blankMenu(e) {
    if (e.target.closest('.finder-item, input, button, .rename-input')) return;
    e.preventDefault();
    const cb = getState().clipboard;
    openContextMenu(e.clientX, e.clientY, isTrash ? [
      { label: '清空回收站…', danger: true, action: emptyTrash },
      { label: '刷新', action: () => act('refresh') },
    ] : [
      { label: '新建', items: [
        { label: '文件夹', action: () => newItem('dir') },
        { label: '文本文档', action: () => newItem('file') },
      ] },
      '-',
      { label: cb ? (cb.mode === 'copy' ? '粘贴项目' : '移动项目到此处') : '粘贴', disabled: !cb, action: paste },
      // 「粘贴为副本」只存在于文件窗口空白右键（命令栏里没有），搬动时最容易漏：
      // 命令栏「粘贴 ▾」也调用同一个 pasteCopy()
      { label: '粘贴为副本', disabled: !cb || cb.mode !== 'copy', action: pasteCopy },
      '-',
      { label: '上传文件…', action: () => pickUpload(false) },
      { label: '上传文件夹…', action: () => pickUpload(true) },
      '-',
      { label: '查看', items: [
        { label: '显示隐藏文件', checked: showHidden, action: () => act('toggleHidden') },
      ] },
      { label: '排序方式', items: sortItems() },
      { label: '刷新', action: () => act('refresh') },
      '-',
      { label: '在终端中打开', action: () => openWindow('terminal', { cwd }) },
    ]);
  }

  // 排序项：右键「排序方式 ▸」与命令栏「排序 ▾」共用同一份（不另写一套）
  function sortItems() {
    return [
      { label: '按名称', checked: sort.key === 'name', action: () => setSort((s2) => ({ ...s2, key: 'name' })) },
      { label: '按大小', checked: sort.key === 'size', action: () => setSort((s2) => ({ ...s2, key: 'size' })) },
      { label: '按修改时间', checked: sort.key === 'mtime', action: () => setSort((s2) => ({ ...s2, key: 'mtime' })) },
      '-',
      { label: sort.asc ? '改为降序' : '改为升序', action: () => setSort((s2) => ({ ...s2, asc: !s2.asc })) },
    ];
  }

  // ---------- 拖拽 ----------
  function onItemDragStart(e, entry) {
    const paths = sel.has(entry.name) ? [...sel].map((n) => joinPath(cwd, n)) : [joinPath(cwd, entry.name)];
    e.dataTransfer.setData('application/x-cloudnine', JSON.stringify({ paths, cwd, mode: e.ctrlKey ? 'copy' : 'move' }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }
  async function onDropToDir(e, targetDir) {
    e.preventDefault(); e.stopPropagation();
    const raw = e.dataTransfer.getData('application/x-cloudnine');
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
  // 地址栏面包屑：「最近」是虚拟视图，给一个不可点的静态段
  const crumbs = recentMode
    ? [{ label: '最近', dir: null }]
    : cwd === '__trash__'
      ? [{ label: '废纸篓', dir: '__trash__' }]
      : [{ label: '根目录', dir: '' }, ...cwd.split('/').filter(Boolean).map((seg, i, arr) => ({ label: seg, dir: arr.slice(0, i + 1).join('/') }))];

  return (
    <div className="finder" ref={containerRef} onContextMenu={blankMenu}>
      <FinderToolbar
        hIdx={hIdx}
        history={history}
        back={back}
        fwd={fwd}
        crumbs={crumbs}
        onCrumb={(dir) => navigate(dir)}
        act={act}
        isTrash={isTrash}
        query={query}
        searchMode={searchMode}
        setQuery={setQuery}
        runSearch={runSearch}
      />

      <FinderCommandBar
        isTrash={isTrash}
        selCount={sel.size}
        clipboard={clipboard}
        showHidden={showHidden}
        view={view}
        act={act}
        sortItems={sortItems}
        onDeleteForever={deleteForeverSelected}
      />

      <div className="finder-main">
        <FinderSidebar
          cwd={cwd}
          isTrash={isTrash}
          recentMode={recentMode}
          navigate={navigate}
          setRecentMode={setRecentMode}
          setCwd={setCwd}
          setSel={setSel}
        />

        <div className="finder-content" ref={bodyRef} onMouseDown={startMarquee}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length && !isTrash && !recentMode) {
              e.preventDefault();
              for (const f of e.dataTransfer.files) addUpload(f, cwd);
            }
          }}
        >
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
            <FinderIconView
              shown={shown}
              sel={sel}
              renaming={renaming}
              cwd={cwd}
              clickItem={clickItem}
              openEntry={openEntry}
              itemMenu={itemMenu}
              onItemDragStart={onItemDragStart}
              onDropToDir={onDropToDir}
              submitRename={submitRename}
              setRenaming={setRenaming}
            />
          ) : (
            <FinderListView
              shown={shown}
              sel={sel}
              renaming={renaming}
              cwd={cwd}
              clickItem={clickItem}
              openEntry={openEntry}
              itemMenu={itemMenu}
              onItemDragStart={onItemDragStart}
              onDropToDir={onDropToDir}
              submitRename={submitRename}
              setRenaming={setRenaming}
              sort={sort}
              setSort={setSort}
            />
          )}

          {marquee && <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>

      <div className="finder-statusbar">
        <span>{shown.length} 个项目</span>
        {sel.size > 0 && <span>已选择 {sel.size} 项</span>}
        {free != null && <span className="sb-free">可用 {fmtSize(free)}</span>}
        {isTrash && entries?.length > 0 && <button className="btn btn-small" onClick={emptyTrash}>清空回收站…</button>}
      </div>
    </div>
  );
}
