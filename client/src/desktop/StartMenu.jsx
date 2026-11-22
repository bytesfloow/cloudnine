import React, { useEffect, useRef, useState } from 'react';
import {
  useStore, getState, closePopover, activateOrOpen, openFile, bus, showDialog,
  minimizeAllWindows, dirname, fileCat,
} from '../store.js';
import { api } from '../api.js';
import { lockFlow } from './account.js';
import {
  IconFiles, IconTerminal, IconEditor, IconTransfer, IconShare, IconDisk, IconTrash,
  IconSearch, IconNewFolder, IconUpload, IconGrid, IconDoc, IconPhoto, IconInfo,
} from '../icons.jsx';

// 固定应用：严格 7 项，与旧底栏 Dock 的 7 项一一对应（docs §1.3 / §2.4）。
// 不加「预览」：preview 窗口必须带 props.path 才能工作，空参启动等于放一个点了就报错的按钮。
const PINNED = [
  { key: 'finder', type: 'finder', label: '文件资源管理器', Icon: IconFiles },
  { key: 'terminal', type: 'terminal', label: '终端', Icon: IconTerminal },
  { key: 'editor', type: 'editor', label: '记事本', Icon: IconEditor },
  { key: 'transfers', type: 'transfers', label: '传输', Icon: IconTransfer },
  { key: 'shares', type: 'shares', label: '分享管理', Icon: IconShare },
  { key: 'disk', type: 'disk', label: '磁盘监控', Icon: IconDisk },
  { key: 'trash', type: 'finder', label: '回收站', Icon: IconTrash },
];

// 高频命令：都落到现有动作上，不新造功能
const COMMANDS = [
  {
    key: 'newFolder', label: '新建文件夹', hint: '在主目录', Icon: IconNewFolder,
    run: () => bus.emit('desktop-action', { action: 'newFolder' }),
  },
  {
    key: 'upload', label: '上传文件…', hint: '到主目录', Icon: IconUpload,
    run: () => bus.emit('desktop-action', { action: 'uploadFile' }),
  },
  {
    key: 'minAll', label: '最小化全部窗口', hint: '显示桌面', Icon: IconGrid,
    run: minimizeAllWindows,
  },
];

const IconLock = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="10.5" width="16" height="9.6" rx="2.4" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <path d="M12 14.5v2.2" />
  </svg>
);

// 开始菜单只负责渲染弹层；开合由任务栏的开始按钮控制（共用 store.popover 单槽位）
export default function StartMenu() {
  const s = useStore();
  return s.popover?.kind === 'start' ? <StartMenuPanel /> : null;
}

function StartMenuPanel() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(-1);
  const [recents, setRecents] = useState([]);
  const [recentsLoaded, setRecentsLoaded] = useState(false);
  const inputRef = useRef(null);
  const bodyRef = useRef(null);

  // 打开即聚焦搜索框（docs §1.2「搜索框」：点开开始菜单并聚焦其搜索框）
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 最近使用的文件：每次打开都重新拉（菜单关闭即卸载，下次打开是新的挂载）
  useEffect(() => {
    let alive = true;
    api.recents()
      .then((r) => { if (alive) setRecents(Array.isArray(r?.items) ? r.items : []); })
      .catch(() => { /* 读取失败按空列表处理，下面给提示 */ })
      .finally(() => { if (alive) setRecentsLoaded(true); });
    return () => { alive = false; };
  }, []);

  // 点击菜单以外任何位置收起；开始按钮自己负责开/合，这里跳过，避免同一次点击又关又开
  useEffect(() => {
    const onDocClick = (e) => {
      if (!e.target?.closest?.('.startmenu') && !e.target?.closest?.('.tb-start')) closePopover();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const q = query.trim().toLowerCase();
  const visibleRecents = recents.slice(0, 6);

  const appRow = (app) => ({
    key: `app:${app.key}`,
    label: app.label,
    kind: '应用',
    Icon: app.Icon,
    run: () => launchApp(app),
  });
  const cmdRow = (cmd) => ({
    key: `cmd:${cmd.key}`,
    label: cmd.label,
    kind: '命令',
    Icon: cmd.Icon,
    hint: cmd.hint,
    run: cmd.run,
  });
  const recentRow = (item) => {
    const Icon = fileCat(item.name, 'file') === 'image' ? IconPhoto : IconDoc;
    return {
      key: `recent:${item.path}`,
      label: item.name,
      kind: '最近',
      Icon,
      hint: dirname(item.path),
      run: () => openFile(item.path, item.name),
    };
  };

  // 输入即实时过滤应用名与命令；空查询时 rows = 已固定 + 最近文件，供方向键统一选取
  const searchRows = q
    ? [...PINNED.map(appRow), ...COMMANDS.map(cmdRow)]
      .filter((r) => r.label.toLowerCase().includes(q) || (r.hint || '').toLowerCase().includes(q))
    : [];
  const rows = q ? searchRows : [...PINNED.map(appRow), ...visibleRecents.map(recentRow)];
  const cur = rows.length ? Math.min(Math.max(cursor, -1), rows.length - 1) : -1;

  // 输入变化后把光标放回第一项；清空后取消高亮
  useEffect(() => {
    setCursor(q ? 0 : -1);
  }, [q]);

  // 键盘选中项滚进可视区
  useEffect(() => {
    if (cur < 0) return;
    bodyRef.current?.querySelector(`[data-idx="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  function launchApp(app) {
    const st = getState();
    // 回收站与普通文件窗口同属 finder，必须用 props.trash 区分：
    // 否则「回收站」会把一个已最小化的普通文件窗口还原出来（docs §5.3 ①）。
    if (app.key === 'trash') {
      activateOrOpen('finder', { trash: true }, (w) => !!w.props?.trash);
      return;
    }
    if (app.type === 'finder') {
      activateOrOpen('finder', { cwd: st.homeRel || '' }, (w) => !w.props?.trash);
      return;
    }
    activateOrOpen(app.type);
  }

  // 先收起开始菜单再执行动作：命令可能弹对话框，应用会开窗，菜单不该压在上面
  function run(row) {
    if (!row) return;
    closePopover();
    row.run();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
      return;
    }
    if (!rows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      setCursor((c) => {
        if (c < 0 || c >= rows.length) return down ? 0 : rows.length - 1;
        return down ? (c + 1) % rows.length : (c - 1 + rows.length) % rows.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(rows[cur < 0 ? 0 : cur]);
    }
  }

  return (
    <div
      className="startmenu"
      role="dialog"
      aria-label="开始菜单"
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="sm-search">
        <div className="sm-search-field">
          <span className="sm-search-icon" aria-hidden="true"><IconSearch size={15} /></span>
          <input
            ref={inputRef}
            className="sm-search-input"
            type="text"
            value={query}
            placeholder="搜索应用、命令…"
            aria-label="搜索应用、命令"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>

      <div className="sm-body" ref={bodyRef}>
        {q ? (
          <section className="sm-section">
            <div className="sm-section-title">搜索结果<span>{searchRows.length} 项</span></div>
            {searchRows.length === 0 ? (
              <div className="sm-empty">
                没有找到与「{query.trim()}」匹配的应用或命令。
                <br />
                试试应用名，或「新建文件夹」「上传文件」这类命令。
              </div>
            ) : (
              <div className="sm-results">
                {searchRows.map((row, i) => {
                  const Icon = row.Icon;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      data-idx={i}
                      className={`sm-result${cur === i ? ' sel' : ''}`}
                      onClick={() => run(row)}
                      onMouseEnter={() => setCursor(i)}
                    >
                      <span className="sm-result-icon"><Icon size={19} /></span>
                      <span className="sm-result-label">{row.label}</span>
                      {row.hint && <span className="sm-result-hint">{row.hint}</span>}
                      <span className="sm-result-kind">{row.kind}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ) : (
          <>
            <section className="sm-section">
              <div className="sm-section-title">已固定</div>
              <div className="sm-pinned">
                {PINNED.map((app, i) => {
                  const Icon = app.Icon;
                  return (
                    <button
                      key={app.key}
                      type="button"
                      data-app={app.key}
                      data-idx={i}
                      className={`sm-app${cur === i ? ' sel' : ''}`}
                      title={app.label}
                      onClick={() => run(appRow(app))}
                      onMouseEnter={() => setCursor(i)}
                    >
                      <Icon size={30} full={app.key === 'trash' && s.trashCount > 0} />
                      <span className="sm-app-label">{app.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="sm-section">
              <div className="sm-section-title">最近使用的文件</div>
              {!recentsLoaded ? (
                <div className="sm-empty">正在读取最近记录…</div>
              ) : visibleRecents.length === 0 ? (
                <div className="sm-empty">
                  还没有最近使用的文件。
                  <br />
                  从「文件资源管理器」打开文件后会出现在这里。
                </div>
              ) : (
                <div className="sm-recents">
                  {visibleRecents.map((item, j) => {
                    const idx = PINNED.length + j;
                    const row = recentRow(item);
                    const Icon = row.Icon;
                    return (
                      <button
                        key={row.key}
                        type="button"
                        data-idx={idx}
                        className={`sm-recent${cur === idx ? ' sel' : ''}`}
                        title={item.path}
                        onClick={() => run(row)}
                        onMouseEnter={() => setCursor(idx)}
                      >
                        <span className="sm-recent-icon"><Icon size={18} /></span>
                        <span className="sm-recent-name">{item.name}</span>
                        {row.hint && <span className="sm-recent-dir">{row.hint}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <div className="sm-footer">
        <span className="avatar-btn sm-avatar" aria-hidden="true">{(s.user || '?').slice(0, 1).toUpperCase()}</span>
        <span className="sm-user" title={s.user || ''}>{s.user || '账户'}</span>
        <button
          type="button"
          className="sm-foot-btn"
          title="关于本系统"
          onClick={() => { closePopover(); showDialog({ kind: 'about' }); }}
        >
          <IconInfo size={15} /><span>关于本系统</span>
        </button>
        <button
          type="button"
          className="sm-foot-btn"
          title="锁定（回到登录页）"
          onClick={async () => { closePopover(); await lockFlow(); }}
        >
          <IconLock size={15} /><span>锁定</span>
        </button>
      </div>
    </div>
  );
}
