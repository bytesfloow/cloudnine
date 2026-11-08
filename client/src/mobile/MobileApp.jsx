import React, { useEffect, useRef, useState } from 'react';
import {
  useStore, getState, bus, setState, setTheme, promptDialog, confirmDialog, notify, setClipboard,
  basename, dirname, joinPath, fmtSize, fmtTime, fmtSpeed, TEXT_EDITABLE, openFile,
} from '../store.js';
import { api } from '../api.js';
import { addUpload, pauseUpload, resumeUpload, cancelUpload, clearFinishedUploads, fmtProgress, fmtUploaded } from '../transfers.js';
import { refreshDisk } from '../App.jsx';
import { TerminalView } from '../windows/Terminal.jsx';
import { PreviewContent } from '../windows/Preview.jsx';
import EditorWindow from '../windows/Editor.jsx';
import {
  FileIcon, IconChevron, IconSearch, IconRefresh, IconGrid, IconList,
  IconCamera, IconPhoto, IconDoc, IconFolderBig, IconClose,
} from '../icons.jsx';
import { HomeScreen, StatusBar, HomeIndicator, Glyph } from './HomeScreen.jsx';

// iOS 风格移动形态：主屏幕（应用图标 + Dock）+ 全屏应用层 + Home 指示条返回（F-11 / 决策 Q10 的 v2 演进）
const APP_TITLES = { finder: '访达', terminal: '终端', upload: '上传', transfers: '传输', settings: '设置' };

export default function MobileApp() {
  const s = useStore();
  const [app, setApp] = useState(null); // 'finder' | 'terminal' | 'upload' | 'transfers' | 'settings'
  const [phase, setPhase] = useState('closed'); // closed | open | closing（缩放动画状态）
  const [origin, setOrigin] = useState('50% 85%'); // 应用打开/关闭动画的缩放原点（图标位置）
  const [dir, setDir] = useState(s.homeRel || '');
  const [quickLookPath, setQuickLookPath] = useState(null);
  const [editorPath, setEditorPath] = useState(null);
  const closeTimer = useRef(null);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  function openApp(key, e) {
    clearTimeout(closeTimer.current);
    if (e?.currentTarget) {
      const r = e.currentTarget.getBoundingClientRect();
      setOrigin(`${(((r.left + r.width / 2) / window.innerWidth) * 100).toFixed(1)}% ${(((r.top + r.height / 2) / window.innerHeight) * 100).toFixed(1)}%`);
    }
    if (key === 'trash') { setDir('__trash__'); setApp('finder'); }
    else { if (key === 'finder' && dir === '__trash__') setDir(getState().homeRel || ''); setApp(key); }
    setPhase('open');
  }
  function goHome() {
    if (phase !== 'open') return;
    setPhase('closing');
    closeTimer.current = setTimeout(() => setPhase('closed'), 230);
  }

  function openMobileFile(path, name) {
    if (TEXT_EDITABLE(name)) { setEditorPath(path); return; }
    setQuickLookPath(path);
  }

  const title = APP_TITLES[app] || '';
  const badges = {
    trash: s.trashCount,
    transfers: s.transfers.filter((x) => ['uploading', 'pending'].includes(x.status)).length,
  };

  return (
    <div className="mobile-app">
      <StatusBar />
      <HomeScreen onOpen={openApp} badges={badges} />

      {(phase === 'open' || phase === 'closing') && (
        <div className={`m-apphost${phase === 'closing' ? ' closing' : ''}`} style={{ transformOrigin: origin }}>
          <div className="m-appbar">
            <button className="m-back" onClick={goHome} aria-label="返回桌面"><IconChevron dir="left" size={14} /></button>
            <span className="m-apptitle ellipsis">{title}</span>
            <span className="m-appbar-side" />
          </div>
          <div className="m-appcontent">
            {app === 'finder' && <FinderMobile dir={dir} setDir={setDir} openFile={openMobileFile} />}
            {app === 'terminal' && (
              <div className="m-terminal">
                <TerminalView cwd={dir === '__trash__' ? '' : dir} actionFilter="mobile-term" />
                <MobileTermKeys />
              </div>
            )}
            {app === 'upload' && <UploadMobile dir={dir === '__trash__' ? '' : dir} />}
            {app === 'transfers' && <TransfersMobile />}
            {app === 'settings' && <SettingsApp openApp={openApp} />}
          </div>
        </div>
      )}

      <HomeIndicator onHome={goHome} />

      {quickLookPath && (
        <div className="m-quicklook">
          <div className="m-ql-head">
            <span className="m-ql-title ellipsis">{basename(quickLookPath)}</span>
            <div className="m-ql-actions">
              <button className="m-ql-close" onClick={() => setQuickLookPath(null)} aria-label="关闭" title="关闭">
                <IconClose size={14} />
              </button>
            </div>
          </div>
          <div className="m-ql-body">
            {/* 下载按钮并入底部缩放工具条（旋转右侧），顶栏只留关闭图标 */}
            <PreviewContent
              path={quickLookPath}
              compact
              onDownload={() => window.open(api.downloadUrl(quickLookPath))}
            />
          </div>
        </div>
      )}

      {editorPath && (
        <div className="m-quicklook">
          <div className="m-ql-head">
            <span className="m-ql-title ellipsis">{basename(editorPath)}</span>
            <div className="m-ql-actions">
              <button className="m-ql-close" onClick={() => setEditorPath(null)} aria-label="关闭" title="关闭">
                <IconClose size={14} />
              </button>
            </div>
          </div>
          <div className="m-ql-body">
            <EditorWindow win={{ id: 'mobile-editor', type: 'editor', props: { path: editorPath, name: basename(editorPath) }, title: basename(editorPath) }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 访达（移动形态，含废纸篓模式） ----------
function FinderMobile({ dir, setDir, openFile }) {
  const isTrash = dir === '__trash__';
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [view, setView] = useState('list');
  const [sheet, setSheet] = useState(null);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const longPress = useRef({ timer: null, fired: false });

  const load = async () => {
    setLoading(true);
    try {
      if (isTrash) {
        const r = await api.trashList();
        setEntries(r.entries.map((e) => ({ name: e.name, type: e.type, size: e.size, mtimeMs: e.mtimeMs, trashId: e.id })));
      } else {
        const r = await api.list(dir);
        setEntries(r.entries);
      }
      setError('');
    } catch (e) { setError(e.message); setEntries([]); }
    setLoading(false);
  };
  useEffect(() => { load(); setSel(new Set()); setSelectMode(false); }, [dir]);
  useEffect(() => bus.on('fs:changed', (d) => {
    if (d === '__trash__' && isTrash) load();
    else if (!isTrash && (d === dir || dir === '' || (d && dir.startsWith(d + '/')))) load();
  }), [dir, isTrash]);

  // 触摸长按 → 操作菜单（桌面浏览器走 contextmenu）
  // fired 记录长按目标名：长按后浏览器合成的 click 只属于那一行，不应吞掉对其他行的第一次点击
  const lpStart = (entry) => (e) => {
    longPress.current.fired = false;
    longPress.current.name = entry.name;
    clearTimeout(longPress.current.timer);
    longPress.current.timer = setTimeout(() => { longPress.current.fired = true; setSheet({ entry }); }, 480);
  };
  const lpCancel = () => clearTimeout(longPress.current.timer);
  const lpClick = (fn, entry) => () => {
    if (longPress.current.fired && longPress.current.name === entry?.name) { longPress.current.fired = false; return; }
    fn();
  };

  // 空白处触摸长按 → 空白菜单（新建文件夹/粘贴/上传，此前触屏上无法呼出）
  const blankLp = useRef({ timer: null, x: 0, y: 0 });
  const blankStart = (e) => {
    const t = e.touches[0];
    if (e.target.closest('.m-row, .m-cell, input, button, .m-selectbar, .m-toolbar, .m-search, .m-appbar')) return;
    blankLp.current.x = t.clientX; blankLp.current.y = t.clientY;
    clearTimeout(blankLp.current.timer);
    blankLp.current.timer = setTimeout(() => { navigator.vibrate?.(10); setSheet({ entry: null }); }, 480);
  };
  const blankCancel = () => clearTimeout(blankLp.current.timer);
  const blankMove = (e) => {
    if (!blankLp.current.timer) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - blankLp.current.x, t.clientY - blankLp.current.y) > 10) clearTimeout(blankLp.current.timer);
  };

  function openEntry(entry) {
    if (selectMode) { toggle(entry); return; }
    if (entry.trashId) return;
    if (entry.type === 'dir') { setDir(joinPath(dir, entry.name)); setSearch(''); setSearchMode(false); return; }
    openFile(joinPath(dir, entry.name), entry.name);
  }
  function toggle(entry) {
    setSel((s0) => { const n = new Set(s0); if (n.has(entry.name)) n.delete(entry.name); else n.add(entry.name); return n; });
  }

  const selPaths = [...sel].map((n) => joinPath(isTrash ? '' : dir, n));

  async function doTrash() {
    if (!sel.size) return;
    if (!await confirmDialog({ title: '移入废纸篓', message: `将选中的 ${sel.size} 项移入废纸篓？`, okText: '移入' })) return;
    await api.trash(selPaths);
    setSel(new Set()); setSelectMode(false);
    bus.emit('fs:changed', dir);
    bus.emit('fs:changed', '__trash__');
  }
  async function doRestore() {
    const ids = entries.filter((e) => sel.has(e.name)).map((e) => e.trashId).filter(Boolean);
    await api.trashRestore(ids);
    setSel(new Set()); setSelectMode(false);
    bus.emit('fs:changed', '__trash__');
  }
  async function doDeleteForever() {
    if (!await confirmDialog({ title: '彻底删除', message: `将彻底删除选中的 ${sel.size} 项，不可恢复。`, danger: true, okText: '删除' })) return;
    const ids = entries.filter((e) => sel.has(e.name)).map((e) => e.trashId).filter(Boolean);
    const r = await api.trashDelete(ids);
    setState({ trashCount: r.trashCount });
    setSel(new Set()); setSelectMode(false);
    bus.emit('fs:changed', '__trash__');
  }
  async function doMove() {
    const v = await promptDialog({ title: '移动到', fields: [{ key: 'd', label: '目标目录', value: dir, autofocus: true }], okText: '移动' });
    if (!v?.d) return;
    await api.move(selPaths, String(v.d).replace(/^\/+|\/+$/g, ''));
    setSel(new Set()); setSelectMode(false);
    bus.emit('fs:changed', dir);
  }
  function doDownload() {
    const a = document.createElement('a');
    a.href = sel.size > 1 ? api.zipUrl(selPaths) : api.downloadUrl(selPaths[0]);
    a.click();
  }
  async function doCompress() {
    await api.archiveCreate({ paths: selPaths, format: 'zip', destDir: dir, name: `archive-${Date.now() % 10000}` });
    notify({ type: 'info', title: '压缩任务已开始' });
    bus.emit('fs:changed', dir);
  }

  const itemActions = (entry) => {
    if (entry.trashId) {
      return [
        { label: '放回原处', action: async () => { await api.trashRestore([entry.trashId]); bus.emit('fs:changed', '__trash__'); setState({ trashCount: Math.max(0, getState().trashCount - 1) }); } },
        { label: '彻底删除…', danger: true, action: async () => {
          if (!await confirmDialog({ title: '彻底删除', message: `“${entry.name}”将被彻底删除，不可恢复。`, danger: true, okText: '删除' })) return;
          const r = await api.trashDelete([entry.trashId]);
          setState({ trashCount: r.trashCount });
          bus.emit('fs:changed', '__trash__');
        } },
      ];
    }
    return [
      entry.type === 'dir' ? { label: '打开', action: () => openEntry(entry) } : { label: '预览', action: () => openEntry(entry) },
      { label: '重命名…', action: async () => {
        const v = await promptDialog({ title: '重命名', fields: [{ key: 'n', label: '新名称', value: entry.name, autofocus: true }] });
        if (v?.n && v.n !== entry.name) {
          await api.rename(joinPath(dir, entry.name), v.n).catch((e2) => notify({ type: 'error', title: '重命名失败', body: e2.message }));
          bus.emit('fs:changed', dir);
        }
      } },
      { label: '复制', action: () => { setClipboard('copy', [joinPath(dir, entry.name)], dir); notify({ title: '已复制' }); } },
      { label: '剪切', action: () => { setClipboard('cut', [joinPath(dir, entry.name)], dir); notify({ title: '已剪切' }); } },
      { label: '分享…', action: () => shareFlowMobile(joinPath(dir, entry.name), entry.name) },
      { label: '下载', disabled: entry.type === 'dir', action: () => { const a = document.createElement('a'); a.href = api.downloadUrl(joinPath(dir, entry.name)); a.click(); } },
      '-',
      { label: '移入废纸篓', danger: true, action: async () => {
        if (!await confirmDialog({ title: '移入废纸篓', message: `“${entry.name}”将移入废纸篓。`, okText: '移入' })) return;
        await api.trash([joinPath(dir, entry.name)]);
        bus.emit('fs:changed', dir); bus.emit('fs:changed', '__trash__');
      } },
    ];
  };
  const blankActions = () => {
    if (isTrash) return [
      { label: '清空废纸篓…', danger: true, action: async () => {
        if (!await confirmDialog({ title: '清倒废纸篓', message: '将彻底删除全部项目，不可恢复。', danger: true, okText: '清倒' })) return;
        await api.trashEmpty(); setState({ trashCount: 0 });
        bus.emit('fs:changed', '__trash__');
      } },
      { label: '刷新', action: load },
    ];
    const cb = getState().clipboard;
    return [
      { label: '新建文件夹…', action: async () => {
        const v = await promptDialog({ title: '新建文件夹', fields: [{ key: 'n', label: '名称', autofocus: true }] });
        if (v?.n) { await api.mkdir(joinPath(dir, v.n)).catch((e2) => notify({ type: 'error', title: '创建失败', body: e2.message })); bus.emit('fs:changed', dir); }
      } },
      { label: cb ? '粘贴' : '粘贴（剪贴板为空）', disabled: !cb, action: async () => {
        if (!cb) return;
        cb.mode === 'copy' ? await api.copy(cb.paths, dir) : await api.move(cb.paths, dir);
        bus.emit('fs:changed', dir);
      } },
      '-',
      { label: '上传文件…', action: () => pickMobileUpload(false, dir) },
      { label: '刷新', action: load },
    ];
  };

  const shown = (entries || []).filter((e) => !e.hidden && (!searchMode || e.name.toLowerCase().includes(search.toLowerCase())));

  const rowHandlers = (entry) => ({
    onClick: lpClick(() => openEntry(entry), entry),
    onContextMenu: (e) => { e.preventDefault(); setSheet({ entry }); },
    onTouchStart: lpStart(entry),
    onTouchMove: lpCancel,
    onTouchEnd: lpCancel,
  });

  return (
    <div
      className="m-finder"
      onContextMenu={(e) => { e.preventDefault(); if (!e.target.closest('.m-row, .m-cell, input, button')) setSheet({ entry: null }); }}
      onTouchStart={blankStart}
      onTouchMove={blankMove}
      onTouchEnd={blankCancel}
      onTouchCancel={blankCancel}
    >
      <div className="m-toolbar">
        <span className="m-path ellipsis">{isTrash ? '废纸篓' : (dir ? `根目录/${dir}` : '根目录')}</span>
        <button className="tb-btn" onClick={() => setView(view === 'list' ? 'grid' : 'list')} title={view === 'list' ? '切换到卡片视图' : '切换到列表视图'}>
          {view === 'list' ? <IconGrid size={14} /> : <IconList size={14} />}
        </button>
        <button className="tb-btn" onClick={load} title="刷新"><IconRefresh /></button>
        {/* 返回上级放最右侧：与左上角"退出窗口"按钮拉开距离，避免误触 */}
        <button className="tb-btn m-up-btn" disabled={!dir} onClick={() => setDir(isTrash ? (getState().homeRel || '') : dirname(dir))} title="返回上一级"><IconChevron dir="left" /></button>
      </div>
      <div className="m-search">
        <div className="finder-search">
          <IconSearch />
          <input value={searchMode ? search : ''} onChange={(e) => { setSearch(e.target.value); setSearchMode(true); }} placeholder="搜索当前目录" />
        </div>
      </div>

      {loading ? <div className="finder-loading"><div className="boot-spinner" /></div>
        : error ? <div className="finder-empty"><p>{error}</p></div>
        : shown.length === 0 ? <div className="finder-empty"><p>{isTrash ? '废纸篓是空的' : searchMode ? '没有匹配项' : '此文件夹是空的'}</p></div>
        : view === 'list' ? (
          <div className="m-list">
            {shown.map((entry) => (
              <div key={entry.name} className={`m-row${sel.has(entry.name) ? ' selected' : ''}`} {...rowHandlers(entry)}>
                {selectMode && <span className={`m-check${sel.has(entry.name) ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); toggle(entry); }} />}
                <span className="m-row-ic"><FileIcon name={entry.name} type={entry.type} size={30} /></span>
                <span className="m-row-info">
                  <span className="m-row-name ellipsis">{entry.name}</span>
                  <span className="m-row-sub">{entry.type === 'dir' ? '文件夹' : fmtSize(entry.size)} · {fmtTime(entry.mtimeMs)}</span>
                </span>
                <button className="m-row-more" onClick={(e) => { e.stopPropagation(); setSheet({ entry }); }}>⋯</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="m-grid">
            {shown.map((entry) => (
              <button key={entry.name} className={`m-cell${sel.has(entry.name) ? ' selected' : ''}`} {...rowHandlers(entry)}>
                <FileIcon name={entry.name} type={entry.type} size={42} />
                <span className="m-cell-name ellipsis">{entry.name}</span>
              </button>
            ))}
          </div>
        )}

      {selectMode ? (
        <div className="m-selectbar">
          <button className="btn btn-small" onClick={() => setSel(new Set(shown.map((e) => e.name)))}>全选</button>
          {isTrash ? (
            <>
              <button className="btn btn-small" onClick={doRestore} disabled={!sel.size}>放回原处</button>
              <button className="btn btn-small btn-danger" onClick={doDeleteForever} disabled={!sel.size}>彻底删除</button>
            </>
          ) : (
            <>
              <button className="btn btn-small" onClick={doMove} disabled={!sel.size}>移动</button>
              <button className="btn btn-small" onClick={doDownload} disabled={!sel.size}>下载</button>
              <button className="btn btn-small" onClick={doCompress} disabled={!sel.size}>压缩</button>
              <button className="btn btn-small btn-danger" onClick={doTrash} disabled={!sel.size}>删除</button>
            </>
          )}
          <button className="btn btn-small" onClick={() => { setSelectMode(false); setSel(new Set()); }}>完成</button>
        </div>
      ) : (
        !isTrash && <button className="m-select-enter" onClick={() => setSelectMode(true)}>选择</button>
      )}

      {sheet && <ActionSheet title={sheet.entry ? sheet.entry.name : '操作'} items={sheet.entry ? itemActions(sheet.entry) : blankActions()} close={() => setSheet(null)} />}
    </div>
  );
}

async function shareFlowMobile(path, name) {
  const v = await promptDialog({
    title: `分享“${name}”`,
    fields: [
      { key: 'expiresIn', label: '有效期', type: 'select', value: '604800', options: [
        { value: '3600', label: '1 小时' }, { value: '86400', label: '1 天' }, { value: '604800', label: '7 天' },
        { value: '2592000', label: '30 天' }, { value: '', label: '永久' },
      ] },
      { key: 'allowDownload', label: '允许下载', type: 'checkbox', value: true },
    ],
    okText: '创建',
  });
  if (!v) return;
  try {
    const r = await api.shareCreate({ path, expiresIn: v.expiresIn || null, allowDownload: !!v.allowDownload });
    const url = `${location.origin}/s/${r.share.token}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    notify({ type: 'success', title: '链接已复制', body: url });
  } catch (e) { notify({ type: 'error', title: '创建失败', body: e.message }); }
}

function pickMobileUpload(folder, dir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.webkitdirectory = true;
  input.onchange = () => {
    for (const f of input.files) addUpload(f, dir, folder ? (f.webkitRelativePath || f.name) : '');
  };
  input.click();
}

// ---------- 终端快捷键栏 ----------
const KEY_MAP = { Esc: '\x1b', Tab: '\t', 'Ctrl+C': '\x03', '/': '/', '-': '-', '~': '~', '|': '|', '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C' };
function MobileTermKeys() {
  return (
    <div className="m-termkeys">
      {Object.keys(KEY_MAP).map((k) => (
        <button key={k} onClick={() => window.dispatchEvent(new CustomEvent('cloudnine-term-input', { detail: { filter: 'mobile-term', data: KEY_MAP[k] } }))}>{k}</button>
      ))}
    </div>
  );
}

// ---------- 上传页 ----------
function UploadMobile({ dir }) {
  const s = useStore();
  const [target, setTarget] = useState(dir);
  const [picker, setPicker] = useState(false);

  function pickTarget(cwd) {
    setPicker(false);
    setTarget(cwd);
    notify({ type: 'success', title: '上传目标已更新', body: cwd ? `根目录/${cwd}` : '根目录' });
  }

  return (
    <div className="m-upload">
      <div className="m-upload-cards">
        <button className="m-upload-card" onClick={() => {
          const input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
          input.onchange = () => { for (const f of input.files) addUpload(f, target); };
          input.click();
        }}><IconCamera size={30} />拍照上传</button>
        <button className="m-upload-card" onClick={() => {
          const input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/*,video/*'; input.multiple = true;
          input.onchange = () => { for (const f of input.files) addUpload(f, target); };
          input.click();
        }}><IconPhoto size={30} />照片与视频</button>
        <button className="m-upload-card" onClick={() => pickMobileUpload(false, target)}><IconDoc size={30} />选择文件</button>
        <button className="m-upload-card" onClick={() => pickMobileUpload(true, target)}><IconFolderBig size={30} />选择文件夹</button>
      </div>
      <button className="m-upload-target" onClick={() => setPicker(true)}>
        <span className="ut-label">上传目标</span>
        <span className="ut-value ellipsis">{target ? `根目录/${target}` : '根目录'}</span>
        <span className="ut-change">更改</span>
      </button>
      {picker && <DirPicker start={target} close={() => setPicker(false)} onPick={pickTarget} />}
      <div className="transfer-list">
        {s.transfers.slice(0, 10).map((it) => (
          <div key={it.id} className={`transfer-item t-${it.status}`}>
            <div className="tr-info">
              <div className="tr-name ellipsis">{it.displayName}</div>
              <div className="tr-sub">{fmtUploaded(it)} · {fmtSpeed(it.speed)}</div>
              <div className="tr-bar"><i style={{ width: `${fmtProgress(it)}%` }} /></div>
            </div>
            <div className="tr-actions">
              {it.status === 'uploading' && <button className="btn btn-small" onClick={() => pauseUpload(it.id)}>暂停</button>}
              {it.status === 'paused' && <button className="btn btn-small" onClick={() => resumeUpload(it.id)}>继续</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 目录选择器（浏览现有目录，无键盘输入） ----------
function DirPicker({ start, close, onPick }) {
  const [cwd, setCwd] = useState(start || '');
  const [dirs, setDirs] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setDirs(null); setErr('');
    api.list(cwd).then((r) => {
      if (!alive) return;
      setDirs(r.entries.filter((e) => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'zh')));
    }).catch((e) => { if (alive) { setErr(e.message); setDirs([]); } });
    return () => { alive = false; };
  }, [cwd]);

  return (
    <div className="sheet-overlay" onClick={close}>
      <div className="dir-picker" onClick={(e) => e.stopPropagation()}>
        <div className="dp-head">
          <button className="tb-btn" disabled={!cwd} onClick={() => setCwd(dirname(cwd))} title="返回上一级"><IconChevron dir="left" /></button>
          <span className="dp-path ellipsis">{cwd ? `根目录/${cwd}` : '根目录'}</span>
          <button className="tb-btn" onClick={close} title="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="dp-list">
          {dirs === null ? <div className="dp-empty"><div className="boot-spinner" /></div>
            : err ? <div className="dp-empty">{err}</div>
            : dirs.length === 0 ? <div className="dp-empty">此文件夹没有子文件夹</div>
            : dirs.map((d) => (
              <button key={d.name} className="dp-row" onClick={() => setCwd(cwd ? `${cwd}/${d.name}` : d.name)}>
                <span className="dp-ic"><IconFolderBig size={22} /></span>
                <span className="dp-name ellipsis">{d.name}</span>
                <IconChevron size={14} />
              </button>
            ))}
        </div>
        <button className="dp-confirm" onClick={() => onPick(cwd)}>
          选择此目录{cwd ? `（根目录/${cwd}）` : '（根目录）'}
        </button>
      </div>
    </div>
  );
}

// ---------- 传输页 ----------
function TransfersMobile() {
  const s = useStore();
  return (
    <div className="m-transfers">
      {s.transfers.length === 0 && <div className="empty-hint">暂无传输任务</div>}
      <div className="transfer-list">
        {s.transfers.map((it) => (
          <div key={it.id} className={`transfer-item t-${it.status}`}>
            <div className="tr-info">
              <div className="tr-name ellipsis">{it.displayName}</div>
              <div className="tr-sub">{it.status === 'error' ? it.error : fmtUploaded(it)}</div>
              <div className="tr-bar"><i style={{ width: `${fmtProgress(it)}%` }} /></div>
            </div>
            <div className="tr-actions">
              {it.status === 'uploading' && <button className="btn btn-small" onClick={() => pauseUpload(it.id)}>暂停</button>}
              {it.status === 'paused' && <button className="btn btn-small" onClick={() => resumeUpload(it.id)}>继续</button>}
              {['pending', 'uploading', 'paused', 'error'].includes(it.status) && <button className="btn btn-small" onClick={() => cancelUpload(it.id)}>取消</button>}
              {it.status === 'done' && <span className="tr-done">完成</span>}
            </div>
          </div>
        ))}
      </div>
      {s.transfers.length > 0 && <button className="btn m-clear-finished" onClick={clearFinishedUploads}>清除已完成</button>}
    </div>
  );
}

// ---------- 设置（分组列表：废纸篓 / 外观 / 分享管理 / 磁盘 / 退出登录） ----------
function SettingsApp({ openApp }) {
  const s = useStore();
  const [shares, setShares] = useState(null);
  const [disk, setDisk] = useState(s.disk || []);

  useEffect(() => {
    api.shares().then((r) => setShares(r.shares)).catch(() => setShares([]));
    refreshDisk().then(() => setDisk(getState().disk || [])).catch(() => {});
  }, []);

  return (
    <div className="m-settings">
      <div className="m-setgroup">
        <button className="m-setrow" onClick={(e) => openApp('trash', e)}>
          <span className="m-set-ic" style={{ background: 'linear-gradient(180deg,#a9adb6,#7d828c)' }}><Glyph name="trash" size={16} /></span>
          <span className="m-set-label">废纸篓</span>
          <span className="m-set-value">{s.trashCount > 0 ? `${s.trashCount} 项` : '空'}</span>
          <IconChevron size={11} />
        </button>
        <div className="m-setrow">
          <span className="m-set-ic" style={{ background: 'linear-gradient(180deg,#5a5f6a,#2c2f36)' }}><Glyph name="settings" size={16} /></span>
          <span className="m-set-label">深色模式</span>
          <button
            className={`m-switch${s.theme === 'dark' ? ' on' : ''}`}
            aria-label="切换深色模式"
            onClick={() => setTheme(s.theme === 'dark' ? 'light' : 'dark')}
          ><i /></button>
        </div>
      </div>

      <div className="m-settitle">分享管理</div>
      <div className="m-setgroup">
        {shares === null ? <div className="m-setrow"><span className="boot-spinner" /></div>
          : shares.length === 0 ? <div className="m-setrow"><span className="m-set-label" style={{ color: 'var(--text-2)' }}>暂无分享</span></div>
          : shares.map((sh) => (
            <div key={sh.id} className="m-setrow">
              <span className="m-set-ic" style={{ background: 'linear-gradient(180deg,#53b0ff,#146ffe)' }}><Glyph name="finder" size={16} /></span>
              <span className="m-set-label ellipsis">{sh.name}</span>
              <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText(`${location.origin}/s/${sh.token}`).then(() => notify({ title: '链接已复制' }))}>复制</button>
              <button className="btn btn-small btn-danger" onClick={async () => { await api.shareUpdate(sh.id, { action: 'cancel' }); api.shares().then((r) => setShares(r.shares)); }}>取消</button>
            </div>
          ))}
      </div>

      <div className="m-settitle">磁盘空间</div>
      <div className="m-setgroup">
        {disk.map((m) => (
          <div key={m.mount} className="m-setrow">
            <span className="m-set-label ellipsis" style={{ maxWidth: '40%' }}>{m.mount}</span>
            <span className="disk-bar"><i style={{ width: `${m.usePct}%` }} className={m.usePct > 85 ? 'danger' : ''} /></span>
            <span className="m-set-value">{fmtSize(m.free)} 可用</span>
          </div>
        ))}
      </div>

      <div className="m-setgroup">
        <button className="m-setrow" onClick={async () => {
          if (await confirmDialog({ title: '退出登录', message: '确定退出当前会话？' })) {
            await api.logout().catch(() => {});
            setState({ user: null, windows: [] });
          }
        }}>
          <span className="m-set-label" style={{ color: 'var(--danger, #ff3b30)', textAlign: 'center', width: '100%' }}>退出登录</span>
        </button>
      </div>
    </div>
  );
}

export function ActionSheet({ title, items, close }) {
  return (
    <div className="sheet-overlay" onClick={close}>
      <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
        {title && <div className="sheet-title ellipsis">{title}</div>}
        {items.map((item, i) => item === '-'
          ? <div key={i} className="dropdown-sep" />
          : (
            <button key={i} className={`dropdown-item${item.danger ? ' danger' : ''}`} disabled={item.disabled} onClick={() => { close(); item.action?.(); }}>
              {item.label}
            </button>
          ))}
        <button className="dropdown-item cancel" onClick={close}>取消</button>
      </div>
    </div>
  );
}
