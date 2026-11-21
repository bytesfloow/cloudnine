import { useSyncExternalStore } from 'react';

// ---------- 桌面视图偏好（排序 / 隐藏文件）----------
// 桌面图标位置不再手工摆放：桌面即主目录，所有图标同属一个目录，
// 位置完全由排序规则决定（Windows 桌面自动排列的思路）。
const DESKTOP_VIEW_KEY = 'cloudnine-desktop-view';

function loadDesktopView() {
  const fallback = { sort: { key: 'name', asc: true, dirsFirst: true }, showHidden: false };
  try {
    const v = JSON.parse(localStorage.getItem(DESKTOP_VIEW_KEY));
    if (v && typeof v === 'object') {
      return {
        sort: {
          key: ['name', 'size', 'mtime', 'type'].includes(v.sort?.key) ? v.sort.key : 'name',
          asc: v.sort?.asc !== false,
          dirsFirst: v.sort?.dirsFirst !== false,
        },
        showHidden: !!v.showHidden,
      };
    }
  } catch { /* 忽略解析失败 */ }
  return fallback;
}

const dv = loadDesktopView();

// ---------- 极简全局状态 ----------
let state = {
  booted: false,
  initialized: true,
  user: null,
  siteName: 'CloudNine',
  version: '',
  theme: localStorage.getItem('cloudnine-theme') || 'auto',

  windows: [],
  zTop: 10,
  focusId: null,
  windowCount: 0,

  clipboard: null, // {mode:'copy'|'cut', paths:[], cwd}
  finderSel: {},   // windowId -> [paths]

  // 桌面（主目录直览）状态
  desktopSel: [],            // 选中的条目名
  desktopSort: dv.sort,      // {key:'name'|'size'|'mtime'|'type', asc, dirsFirst}
  desktopShowHidden: dv.showHidden,

  notifications: [],
  dialog: null,        // 当前模态对话框（队列首）
  contextMenu: null,   // {x,y,items}
  quickLook: null,     // {paths:[], index}
  popover: null,       // 菜单栏弹出面板 {kind, anchor}

  transfers: [],       // 上传项
  jobs: [],
  trashCount: 0,
  disk: null,
  homeRel: '',
};

const listeners = new Set();
export function getState() { return state; }
export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function subscribe(l) { listeners.add(l); return () => listeners.delete(l); }
export function useStore() {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ---------- 事件总线（窗口间/组件间通信） ----------
const busMap = new Map();
export const bus = {
  on(ev, fn) {
    if (!busMap.has(ev)) busMap.set(ev, new Set());
    busMap.get(ev).add(fn);
    return () => busMap.get(ev)?.delete(fn);
  },
  emit(ev, payload) {
    busMap.get(ev)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  },
};

// ---------- 工具 ----------
let idCounter = 1;
export const nextId = () => `w${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export const basename = (p) => String(p).split('/').filter(Boolean).pop() || '/';
export const dirname = (p) => {
  const parts = String(p).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
};
export const joinPath = (a, b) => [a, b].filter(Boolean).join('/');

export function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString('zh-CN', {
    year: sameYear ? undefined : 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
export const fmtSpeed = (bps) => (bps > 0 ? `${fmtSize(bps)}/s` : '—');

// 文件类别
const EXT_MAP = (() => {
  const m = {};
  const add = (cat, exts) => exts.forEach((e) => { m[e] = cat; });
  add('image', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
  add('video', ['mp4', 'webm', 'ogg', 'mov', 'mkv']);
  add('audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']);
  add('pdf', ['pdf']);
  add('archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
  add('code', ['js', 'ts', 'jsx', 'tsx', 'py', 'sh', 'bash', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'go', 'java', 'rs', 'c', 'cpp', 'h', 'hpp', 'php', 'rb', 'sql', 'toml', 'ini', 'conf', 'env', 'vue']);
  add('text', ['txt', 'log', 'md', 'csv', 'tsv', 'list', 'properties', 'gitignore', 'dockerfile', 'lock']);
  add('office', ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt']);
  return m;
})();
export const extname = (name) => {
  const b = basename(name);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
export const fileCat = (name, type) => {
  if (type === 'dir') return 'dir';
  return EXT_MAP[extname(name)] || 'bin';
};
export const TEXT_EDITABLE = (name) => ['code', 'text'].includes(fileCat(name)) || ['dockerfile', 'makefile', 'license', 'readme'].includes(basename(name).toLowerCase());

// 主题应用
export function applyTheme(theme) {
  const resolved = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}
export function setTheme(theme) {
  localStorage.setItem('cloudnine-theme', theme);
  setState({ theme });
  applyTheme(theme);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if ((localStorage.getItem('cloudnine-theme') || 'auto') === 'auto') applyTheme('auto');
});

// ---------- 通知 ----------
// onClick（可选）：点击通知时执行的动作，例如打开「传输」窗口；
// actionLabel（可选）：给可点击通知一个轻量提示文案，便于发现其可交互。
export function notify({ type = 'info', title, body = '', ms = 5000, onClick = null, actionLabel = '' }) {
  const id = nextId();
  setState((s) => ({ notifications: [...s.notifications, { id, type, title, body, ts: Date.now(), onClick, actionLabel }].slice(-20) }));
  if (ms > 0) setTimeout(() => dismissNotification(id), ms);
  return id;
}
export function dismissNotification(id) {
  setState((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
}
// 点击通知：先移除该条，再执行其动作；未带动作的通知退化为「点击即消失」
export function activateNotification(id) {
  const n = state.notifications.find((x) => x.id === id);
  dismissNotification(id);
  if (typeof n?.onClick === 'function') n.onClick();
}

// ---------- 模态对话框（Promise 风格） ----------
let dialogResolve = null;
export function showDialog(dlg) {
  return new Promise((resolve) => {
    if (state.dialog && dialogResolve) { state.dialog._aborted = true; dialogResolve(null); }
    dialogResolve = resolve;
    setState({ dialog: { ...dlg, id: nextId() } });
  });
}
export function resolveDialog(value) {
  const r = dialogResolve;
  dialogResolve = null;
  setState({ dialog: null });
  r?.(value);
}
export const confirmDialog = ({ title = '确认操作', message = '', danger = false, okText = '好', cancelText = '取消' } = {}) =>
  showDialog({ kind: 'confirm', title, message, danger, okText, cancelText });
export const promptDialog = ({ title, message, fields = [], okText = '好', danger = false, wide = false }) =>
  showDialog({ kind: 'form', title, message, fields, okText, danger, wide });

// ---------- 右键菜单 ----------
export function openContextMenu(x, y, items) {
  // 同一时刻只允许一层弹出层：打开右键菜单时先收起菜单栏下拉/通知面板
  setState({ contextMenu: { x, y, items }, popover: null });
}
export const closeContextMenu = () => setState({ contextMenu: null });

// 菜单栏下拉与右侧面板共用同一个全局槽位，Esc、右键、点击外部统一收口
export const openPopover = (kind) =>
  setState({ popover: kind ? { kind } : null, contextMenu: null });
export const closePopover = () => setState({ popover: null });

// ---------- 快速预览 ----------
export function openQuickLook(paths, index = 0) {
  setState({ quickLook: { paths, index } });
}
export const closeQuickLook = () => setState({ quickLook: null });
export function quickLookNav(delta) {
  setState((s) => {
    if (!s.quickLook) return null;
    const n = (s.quickLook.index + delta + s.quickLook.paths.length) % s.quickLook.paths.length;
    return { quickLook: { ...s.quickLook, index: n } };
  });
}

// ---------- 窗口管理 ----------
// 手动调整过的窗口几何按类型持久化到 localStorage，下次打开同类型窗口时恢复
const GEOM_KEY = 'cloudnine-win-geom';

function loadGeom() {
  try {
    const v = JSON.parse(localStorage.getItem(GEOM_KEY));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function saveGeom(type, rect) {
  try {
    const all = loadGeom();
    all[type] = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
    localStorage.setItem(GEOM_KEY, JSON.stringify(all));
  } catch { /* 忽略持久化失败 */ }
}

const WINDOW_DEFAULTS = {
  finder: { title: '文件', w: 860, h: 560, minW: 560, minH: 380, multi: true },
  terminal: { title: '终端', w: 760, h: 460, minW: 420, minH: 300, multi: true },
  editor: { title: '文本编辑', w: 800, h: 560, minW: 480, minH: 360, multi: true },
  preview: { title: '预览', w: 780, h: 580, minW: 420, minH: 320, multi: true },
  info: { title: '显示简介', w: 400, h: 480, minW: 360, minH: 320, multi: true },
  // multi: true 的五个类型（finder/terminal/editor/preview/info）同类型可多开：
  // 任务栏必须每窗口一个按钮，按 type 去重会让按钮数与窗口数对不上（见 docs §5.3）
  transfers: { title: '传输', w: 720, h: 480, minW: 520, minH: 360, multi: false },
  shares: { title: '分享管理', w: 760, h: 500, minW: 560, minH: 400, multi: false },
  disk: { title: '磁盘监控', w: 680, h: 520, minW: 480, minH: 380, multi: false },
};

export function openWindow(type, props = {}) {
  const def = WINDOW_DEFAULTS[type] || { title: type, w: 640, h: 480, minW: 360, minH: 280, multi: true };
  const existing = state.windows.find((w) => w.type === type && !def.multi);
  if (existing) { focusWindow(existing.id); return existing.id; }
  // 编辑器同一文件只开一个窗口
  if (type === 'editor' && props.path) {
    const same = state.windows.find((w) => w.type === 'editor' && w.props.path === props.path);
    if (same) { focusWindow(same.id); return same.id; }
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const n = state.windowCount;
  const saved = loadGeom()[type];
  let x, y, w, h;
  if (saved) {
    // 恢复上次手动调整的几何；视口可能已变化，先收敛尺寸再保证窗口可见、可拖回
    w = Math.max(def.minW, Math.min(saved.w, vw - 40));
    h = Math.max(def.minH, Math.min(saved.h, vh - 110));
    x = Math.min(Math.max(saved.x, -(w - 120)), vw - 120); // 边界与 WindowFrame 拖动限制一致
    y = Math.min(Math.max(saved.y, 28), vh - 44);
  } else {
    w = Math.min(def.w, vw - 40);
    h = Math.min(def.h, vh - 110);
    x = Math.max(10, Math.min((vw - w) / 2 + ((n % 6) - 2.5) * 32, vw - w - 10));
    y = Math.max(38, Math.min(52 + ((n % 6) - 2) * 28, vh - h - 80));
  }
  const win = {
    id: nextId(),
    type,
    props,
    title: def.title,
    rect: { x, y, w, h, max: false },
    minW: def.minW, minH: def.minH,
    minimized: false,
    z: ++state.zTop,
  };
  setState((s) => ({ windows: [...s.windows, win], windowCount: n + 1, focusId: win.id, zTop: s.zTop + 1 }));
  return win.id;
}

export function focusWindow(id) {
  const w = state.windows.find((x) => x.id === id);
  if (w && !w.minimized && state.focusId === id) return;
  setState((s) => ({
    focusId: id,
    zTop: s.zTop + 1,
    windows: s.windows.map((x) => (x.id === id ? { ...x, z: s.zTop + 1, minimized: false } : x)),
  }));
}

// 任务栏按钮单击：已聚焦且未最小化 → 最小化；否则 → 还原并置顶。
// 不能复用 focusWindow 的早退逻辑："已聚焦"时它直接 return，按钮会变成死键。
export function toggleWindow(id) {
  const w = state.windows.find((x) => x.id === id);
  if (!w) return;
  if (!w.minimized && state.focusId === id) return minimizeWindow(id);
  focusWindow(id);
}

// 应用启动器（任务栏固定项 / 开始菜单）：
// 1) 同类型有可见窗口 → 置顶（已经是前台则什么都不做，绝不叠新的）；
// 2) 只剩最小化窗口 → 还原最上层那个；
// 3) 一个都没有 → 新建。
// 与 openWindow 的差别就在这两步：multi: true 的类型 openWindow 永远新建，
// 启动器若直接调它，最小化的旧窗口就会被永远埋在内存里（docs §5.3 ①）。
// match 用来区分同类型里身份不同的窗口（如 finder 中带 props.trash 的回收站窗口）。
export function activateOrOpen(type, props = {}, match = null) {
  const pool = state.windows.filter((w) => w.type === type && (!match || match(w)));
  const visible = pool.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0];
  if (visible) return focusWindow(visible.id);
  const minimized = pool.filter((w) => w.minimized).sort((a, b) => b.z - a.z)[0];
  if (minimized) return focusWindow(minimized.id);
  return openWindow(type, props);
}

export async function closeWindow(id) {
  const win = state.windows.find((w) => w.id === id);
  if (!win) return;
  const doClose = () => {
    bus.emit('window-close', { windowId: id });
    setState((s) => {
      const rest = s.windows.filter((w) => w.id !== id);
      // 焦点回落要跳过最小化窗口，否则会把焦点交给一个看不见的窗口
      const next = rest.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0];
      return {
        windows: rest,
        focusId: s.focusId === id ? (next?.id || null) : s.focusId,
      };
    });
  };
  if (state.editorDirty?.[id]) {
    const choice = await showDialog({
      kind: 'confirm3',
      title: '未保存的更改',
      message: `“${win.title}”有未保存的更改，要保存吗？`,
      saveText: '保存', dangerText: '不保存',
    });
    if (choice === 'cancel') return;
    // 保存由编辑器异步完成，成功后才关闭（失败/取消则保留窗口继续编辑）
    if (choice === 'save') { bus.emit('editor-save', { windowId: id, done: (ok) => { if (ok !== false) doClose(); } }); return; }
  }
  doClose();
}

export const minimizeWindow = (id) => setState((s) => {
  if (!s.windows.some((w) => w.id === id)) return null;
  // 焦点交接：交给剩余窗口中最上层者，而不是直接置 null。
  // （置 null 等于"焦点消失"，菜单栏会立刻退回桌面态，剩下的窗口也失去激活语义）
  const rest = s.windows.filter((w) => w.id !== id);
  const next = s.focusId === id ? rest.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0] : null;
  return {
    windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    focusId: s.focusId === id ? (next?.id ?? null) : s.focusId,
  };
});

// 「最小化全部窗口 / 显示桌面」：全部最小化后焦点回到桌面；
// 窗口只是隐藏，任务栏按钮仍在，逐个点就能还原。
export const minimizeAllWindows = () => setState((s) => ({
  windows: s.windows.map((w) => (w.minimized ? w : { ...w, minimized: true })),
  focusId: null,
}));

// 上一条的反向操作：一次还原全部最小化窗口，焦点给最上层者
export const restoreAllWindows = () => setState((s) => {
  if (!s.windows.some((w) => w.minimized)) return null;
  const windows = s.windows.map((w) => (w.minimized ? { ...w, minimized: false } : w));
  const top = [...windows].sort((a, b) => b.z - a.z)[0];
  return { windows, focusId: top ? top.id : s.focusId };
});
export const toggleMaxWindow = (id) =>
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, rect: { ...w.rect, max: !w.rect.max } } : w)) }));
// 拖拽/缩放时直接操作 DOM，落点提交到 store，并按窗口类型记忆几何
export const commitRect = (id, rect) => {
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, rect: { ...w.rect, ...rect } } : w)) }));
  const win = state.windows.find((w) => w.id === id);
  if (win && !win.rect.max) saveGeom(win.type, win.rect);
};
export const setWindowTitle = (id, title) =>
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)) }));

export function updateWindowProps(id, patch) {
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...patch } } : w)) }));
}

// ---------- 剪贴板 ----------
// setClipboard(null) 表示清空：必须真的写成 null，否则会留下 {paths: undefined} 的坏状态
export const setClipboard = (mode, paths, cwd) =>
  setState({ clipboard: mode == null ? null : { mode, paths, cwd } });

// ---------- 访达选择上报（供快速预览等全局功能使用） ----------
export const setFinderSel = (windowId, paths) =>
  setState((s) => ({ finderSel: { ...s.finderSel, [windowId]: paths } }));

// ---------- 桌面（主目录直览）----------
// 支持函数式更新：连续点击时避免读到上一次渲染的快照
export const setDesktopSel = (names) =>
  setState((s) => ({ desktopSel: typeof names === 'function' ? names(s.desktopSel) : names }));

function saveDesktopView() {
  const s = getState();
  try {
    localStorage.setItem(DESKTOP_VIEW_KEY, JSON.stringify({ sort: s.desktopSort, showHidden: s.desktopShowHidden }));
  } catch { /* 忽略持久化失败 */ }
}

export function setDesktopSort(sort) {
  setState({ desktopSort: sort });
  saveDesktopView();
}

export function setDesktopShowHidden(v) {
  setState({ desktopShowHidden: v });
  saveDesktopView();
}

// ---------- 编辑器未保存标记（关闭窗口时拦截） ----------
export const markDirty = (windowId, dirty) =>
  setState((s) => ({ editorDirty: { ...s.editorDirty, [windowId]: dirty } }));

// ---------- 打开文件（按类型分流到编辑器/预览窗口） ----------
export async function openFile(path, name) {
  const { api } = await import('./api.js');
  api.addRecent(path, name).catch(() => {});
  if (TEXT_EDITABLE(name)) {
    openWindow('editor', { path, name });
  } else {
    try {
      const parent = dirname(path);
      const r = await api.list(parent);
      const siblings = r.entries.filter((e) => e.type !== 'dir').map((e) => joinPath(parent, e.name));
      openWindow('preview', { path, siblings, index: Math.max(0, siblings.indexOf(path)) });
    } catch {
      openWindow('preview', { path, siblings: [path], index: 0 });
    }
  }
}
