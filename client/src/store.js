import { useSyncExternalStore } from 'react';

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
  setState({ contextMenu: { x, y, items } });
}
export const closeContextMenu = () => setState({ contextMenu: null });

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
  finder: { title: '访达', w: 860, h: 560, minW: 560, minH: 380, multi: true },
  terminal: { title: '终端', w: 760, h: 460, minW: 420, minH: 300, multi: true },
  editor: { title: '文本编辑', w: 800, h: 560, minW: 480, minH: 360, multi: true },
  preview: { title: '预览', w: 780, h: 580, minW: 420, minH: 320, multi: true },
  info: { title: '显示简介', w: 400, h: 480, minW: 360, minH: 320, multi: true },
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

export async function closeWindow(id) {
  const win = state.windows.find((w) => w.id === id);
  if (!win) return;
  const doClose = () => {
    bus.emit('window-close', { windowId: id });
    setState((s) => ({
      windows: s.windows.filter((w) => w.id !== id),
      focusId: s.focusId === id ? (s.windows.filter((w) => w.id !== id).sort((a, b) => b.z - a.z)[0]?.id || null) : s.focusId,
    }));
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

export const minimizeWindow = (id) =>
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)), focusId: s.focusId === id ? null : s.focusId }));
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
