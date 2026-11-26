import { useSyncExternalStore } from 'react';
import { WINDOW_DEFAULTS as APP_WINDOW_DEFAULTS } from './apps/registry.jsx';

// ---------- 桌面视图偏好（排序 / 隐藏文件）----------
// 桌面图标位置不再手工摆放：桌面即主目录，所有图标同属一个目录，
// 位置完全由排序规则决定（Windows 桌面自动排列的思路）。
const DESKTOP_VIEW_KEY = 'cloudnine-desktop-view';
// 用户从桌面移除过的虚拟应用图标（插件）：只记本地名单，v1 不做卸载
const DESKTOP_APPS_HIDDEN_KEY = 'cloudnine-desktop-apps-hidden';

// 桌面图标三档（Windows 桌面右键 › 查看 ▸ 大图标 / 中等图标 / 小图标）
export const DESKTOP_ICON_SIZES = ['large', 'medium', 'small'];

function loadDesktopView() {
  const fallback = { sort: { key: 'name', asc: true, dirsFirst: true }, showHidden: false, iconSize: 'medium' };
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
        iconSize: DESKTOP_ICON_SIZES.includes(v.iconSize) ? v.iconSize : 'medium',
      };
    }
  } catch { /* 忽略解析失败 */ }
  return fallback;
}

const dv = loadDesktopView();

// ---------- 外壳几何 ----------
// 顶部全局菜单栏已删除（docs §7 R11 / R12）：窗口可以拖到 y = 0，最大化后顶到屏幕最上沿。
// 底部是通栏任务栏；SHELL_BOTTOM_H 必须与 styles/base.css 的 --taskbar-h 保持一致。
export const SHELL_TOP_H = 0;
export const SHELL_BOTTOM_H = 40;
// 拖动 / 恢复几何时，标题栏至少要露出这么多（标题栏 39px + 1px 余量），不能被任务栏吃掉
export const TITLEBAR_MIN_VISIBLE = 44;
// Aero Snap 触发区宽度（docs §5.2：Win 系默认 8px）
export const SNAP_EDGE = 8;

// ---------- 极简全局状态 ----------
let state = {
  booted: false,
  initialized: true,
  user: null,
  siteName: 'CloudNine',
  version: '',
  // 启动时 /api/state 带回来的库状态：库损坏时后端进只读降级，
  // 铭牌「健康」块据此点亮状态点（true = 降级）。
  dbDamaged: false,
  theme: localStorage.getItem('cloudnine-theme') || 'auto',

  windows: [],
  zTop: 10,
  focusId: null,
  windowCount: 0,
  recent: [],   // 最近使用顺序（窗口 id，从新到旧），Alt+Tab 切换器按它排
  altTab: null, // Alt+Tab 切换器打开时的快照 { ids: [], index: 0 }

  clipboard: null, // {mode:'copy'|'cut', paths:[], cwd}
  finderSel: {},   // windowId -> [paths]

  // 桌面（主目录直览）状态
  desktopSel: [],            // 选中的条目名
  desktopSort: dv.sort,      // {key:'name'|'size'|'mtime'|'type', asc, dirsFirst}
  desktopShowHidden: dv.showHidden,
  desktopIconSize: dv.iconSize, // 'large' | 'medium' | 'small'

  notifications: [],
  dialog: null,        // 当前模态对话框（队列首）
  contextMenu: null,   // {x,y,items,id}
  popover: null,       // 外壳弹层（开始菜单 / 任务栏托盘）{kind, anchor}

  // 已安装插件（GET /api/plugins 的 plugins 数组，服务端原样）
  // 移动端不拉取；拉取失败 / 401 一律按「无插件」处理，不阻塞桌面
  plugins: [],
  // 窗口「未保存」标记（windowId → true）。单一真相：点 X / 任务栏关闭 /
  // 其它任何走 closeWindow 的入口、以及页面 beforeunload 都读这一份（见下面窗口管理段）
  dirtyWindows: {},
  // 用户从桌面移除过的虚拟应用图标（localStorage，v1 不做卸载）
  desktopAppsHidden: loadDesktopAppsHidden(),

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
// 无扩展名但确定是纯文本的文件名（Makefile / LICENSE / .gitignore / .env …）。
// 这些名字本身就是「扩展名」，extname() 取不到，不能因此给个 BIN 角标。
export const PLAIN_TEXT_NAMES = new Set([
  'makefile', 'dockerfile', 'containerfile', 'jenkinsfile', 'vagrantfile', 'gemfile',
  'rakefile', 'procfile', 'brewfile', 'license', 'licence', 'copying', 'notice',
  'readme', 'changelog', 'changes', 'authors', 'contributors', 'install',
  'makefile.am', 'makefile.in', '.gitignore', '.gitattributes', '.npmignore',
  '.editorconfig', '.env', '.babelrc', '.eslintrc', '.prettierrc', '.dockerignore',
]);
export const fileCat = (name, type) => {
  if (type === 'dir') return 'dir';
  const ext = extname(name);
  if (ext) return EXT_MAP[ext] || 'bin';
  // 无扩展名：认识的纯文本名归 text；其余归 plain（中性纸面、不带类型角标），
  // 不再谎称它是 BIN——无扩展名既不等于文本，也不等于二进制。
  return PLAIN_TEXT_NAMES.has(basename(name).toLowerCase()) ? 'text' : 'plain';
};
export const TEXT_EDITABLE = (name) => ['code', 'text'].includes(fileCat(name));

// 主题应用
export function applyTheme(theme) {
  const resolved = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // 主题真正落地后广播一次：画布类组件（终端 xterm）不跟着 React 重渲染，
  // 必须靠这个事件刷新配色。这里是全仓唯一的 theme-changed 发射点。
  bus.emit('theme-changed', resolved);
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
  // 同一时刻只允许一层弹出层：打开右键菜单时先收起开始菜单/任务栏托盘
  // id 用于让 ContextMenu 在「菜单已打开时换一份 items」也能重置展开的层级
  setState({ contextMenu: { x, y, items, id: nextId() }, popover: null });
}
export const closeContextMenu = () => setState({ contextMenu: null });

// 开始菜单与任务栏托盘共用同一个全局槽位，Esc、右键、点击外部统一收口
export const openPopover = (kind) =>
  setState({ popover: kind ? { kind } : null, contextMenu: null });
export const closePopover = () => setState({ popover: null });

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

export function openWindow(type, props = {}, opts = {}) {
  const base = APP_WINDOW_DEFAULTS[type] || { title: type, w: 640, h: 480, minW: 360, minH: 280, multi: true };
  // 单窗口覆盖（插件按 manifest.window 定初始尺寸 / 标题）：只影响本次开窗，
  // 不写回应用表——否则第一个插件会把默认值改掉，第二个插件跟着错
  const size = opts.size || null;
  const def = Object.assign({}, base, size ? {
    w: size.width ?? base.w, h: size.height ?? base.h,
    minW: size.minWidth ?? base.minW, minH: size.minHeight ?? base.minH,
    multi: typeof size.multi === 'boolean' ? size.multi : base.multi,
  } : {}, { title: opts.title || base.title });
  // 同类型里身份不同的窗口（回收站 / 各个插件）靠 match 区分，不能只比 type
  const match = typeof opts.match === 'function' ? opts.match : null;
  const sameType = (w) => w.type === type && (!match || match(w));
  const existing = state.windows.find((w) => sameType(w) && !def.multi);
  if (existing) { focusWindow(existing.id); return existing.id; }
  // 编辑器同一文件只开一个窗口
  if (type === 'editor' && props.path) {
    const same = state.windows.find((w) => w.type === 'editor' && w.props.path === props.path);
    if (same) { focusWindow(same.id); return same.id; }
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const n = state.windowCount;
  // 几何按类型持久化；插件窗口各存一份（geomKey = plugin:<id>），互不干扰
  const geomKey = opts.geomKey || type;
  const saved = loadGeom()[geomKey];
  let x, y, w, h;
  if (saved) {
    // 恢复上次手动调整的几何；视口可能已变化，先收敛尺寸再保证窗口可见、可拖回
    w = Math.max(def.minW, Math.min(saved.w, vw - 40));
    h = Math.max(def.minH, Math.min(saved.h, vh - SHELL_BOTTOM_H - 14));
    x = Math.min(Math.max(saved.x, -(w - 120)), vw - 120); // 边界与 WindowFrame 拖动限制一致
    y = Math.min(Math.max(saved.y, SHELL_TOP_H), vh - SHELL_BOTTOM_H - TITLEBAR_MIN_VISIBLE);
  } else {
    w = Math.min(def.w, vw - 40);
    h = Math.min(def.h, vh - SHELL_BOTTOM_H - 14);
    x = Math.max(10, Math.min((vw - w) / 2 + ((n % 6) - 2.5) * 32, vw - w - 10));
    // 窗口从屏幕顶部下方 10px 起层叠，不越过任务栏，也不再为顶栏留 38px
    y = Math.max(SHELL_TOP_H + 10, Math.min(24 + ((n % 6) - 2) * 28, vh - h - SHELL_BOTTOM_H - 8));
  }
  // 同类型多开时几何按类型只持久化一份：第二个窗口会精确盖住第一个。
  // 目标位置若已被现存窗口占用，就按上面那套 (n % 6) 的层叠步长错开（最多挪 6 次）。
  // 最大化 / 吸附窗口不参与占位判断：它们本来就铺满屏幕，rect 只是还原用的旧几何。
  const occupiedAt = (px, py) => state.windows.some((w) => !w.rect.max && !w.snap
    && Math.abs(w.rect.x - px) < 8 && Math.abs(w.rect.y - py) < 8);
  if (occupiedAt(x, y)) {
    const minX = Math.max(0, Math.min(10, vw - w)), maxX = Math.max(minX, vw - w - 10);
    const minY = SHELL_TOP_H, maxY = Math.max(minY, vh - h - SHELL_BOTTOM_H - 8);
    const spanX = Math.max(1, maxX - minX + 1), spanY = Math.max(1, maxY - minY + 1);
    for (let i = 1; i <= 6 && occupiedAt(x, y); i++) {
      x = minX + ((Math.max(0, Math.round(x - minX)) + 32 * i) % spanX);
      y = minY + ((Math.max(0, Math.round(y - minY)) + 28 * i) % spanY);
    }
  }
  const win = {
    id: nextId(),
    type,
    props,
    geomKey: opts.geomKey || null,
    title: def.title,
    rect: { x, y, w, h, max: false },
    snap: null,        // null | 'left' | 'right'（docs §5.1）
    restoreRect: null, // 最大化 / 吸附前的几何，供还原用
    minW: def.minW, minH: def.minH,
    minimized: false,
    z: ++state.zTop,
  };
  setState((s) => ({
    windows: [...s.windows, win],
    windowCount: n + 1,
    focusId: win.id,
    zTop: s.zTop + 1,
    recent: [win.id, ...s.recent.filter((id) => id !== win.id)].slice(0, 40),
  }));
  return win.id;
}

export function focusWindow(id) {
  const w = state.windows.find((x) => x.id === id);
  if (!w) return;
  // 最近使用顺序：Alt+Tab 的排序依据（已聚焦也要更新，否则从任务栏点回来的窗口排不上来）
  const recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 40);
  if (!w.minimized && state.focusId === id) { setState({ recent }); return; }
  setState((s) => ({
    focusId: id,
    zTop: s.zTop + 1,
    recent,
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
      // 脏标记随窗口一起清掉，否则关掉之后 beforeunload 会一直拦刷新
      const dirtyWindows = { ...s.dirtyWindows };
      delete dirtyWindows[id];
      return {
        windows: rest,
        focusId: s.focusId === id ? (next?.id || null) : s.focusId,
        recent: s.recent.filter((x) => x !== id),
        dirtyWindows,
      };
    });
  };
  // 未保存保护（插件窗口用 cloudnine.ui.markDirty 上报）：所有关闭入口都走这里，
  // 所以点 X、任务栏右键「关闭窗口」、任何其它调 closeWindow 的地方行为一致 —— 只问一次。
  if (isWindowDirty(id)) {
    const ok = await confirmDialog({
      title: '未保存的更改',
      message: `“${win.title}”有未保存的更改，关闭窗口会丢失这些更改。`,
      okText: '关闭',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return; // 取消：窗口与脏标记都原样留着
    markWindowDirty(id, false); // 已确认丢弃：别让 beforeunload 再拦一次
  }
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
  // （置 null 等于"焦点消失"，剩下的窗口会失去激活语义）
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

// Win+D / 任务栏「显示桌面」：双向切换。
// 还有可见窗口 → 全部最小化；全都已最小化 → 全部还原（docs §5.3 ⑤）。
export function toggleShowDesktop() {
  if (!state.windows.length) return;
  if (state.windows.some((w) => !w.minimized)) minimizeAllWindows();
  else restoreAllWindows();
}
// 吸附 / 最大化前的几何快照：已经是特殊状态（最大化或已吸附）时沿用旧值，
// 否则把当前几何记下来 —— 连续换边吸附不能把半屏尺寸当成「原始几何」。
function restoreRectOf(w) {
  if ((w.rect.max || w.snap) && w.restoreRect) return w.restoreRect;
  return { x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h };
}

// 吸附目标几何（docs §5.2）：左/右半屏，高度到任务栏上沿
export function snapTargetRect(side) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const h = Math.max(160, vh - SHELL_BOTTOM_H - SHELL_TOP_H);
  if (side !== 'left' && side !== 'right') return null;
  const w = Math.round(vw / 2);
  return side === 'left'
    ? { x: 0, y: SHELL_TOP_H, w, h, max: false }
    : { x: vw - w, y: SHELL_TOP_H, w, h, max: false };
}

// 提交吸附（只在 pointerup 调用）：side 为 'left' | 'right' | 'max'。
// 吸附 / 最大化都不落几何库（见 commitRect），否则下次开窗会带着半屏尺寸。
export function applySnap(id, side) {
  setState((s) => ({
    windows: s.windows.map((w) => {
      if (w.id !== id) return w;
      const restoreRect = restoreRectOf(w);
      if (side === 'max') return { ...w, restoreRect, snap: null, rect: { ...w.rect, max: true } };
      const r = snapTargetRect(side);
      if (!r) return w;
      return { ...w, restoreRect, snap: side, rect: r };
    }),
  }));
}

// 从最大化 / 吸附回到 restoreRect（拖离边缘、Win+↓、双击标题栏共用）
export function restoreWindow(id) {
  setState((s) => ({
    windows: s.windows.map((w) => {
      if (w.id !== id) return w;
      if (!w.rect.max && !w.snap) return w;
      const r = w.restoreRect;
      return { ...w, snap: null, restoreRect: null, rect: r ? { ...r, max: false } : { ...w.rect, max: false } };
    }),
  }));
}

// 拖动标题栏时从特殊状态「就地还原」：先把窗口放回给定几何并去掉 max/snap，
// 剩下的位移仍由 WindowFrame 直接操作 DOM（指针锚点不跳）。
export function beginMoveFromSpecial(id, rect) {
  setState((s) => ({
    windows: s.windows.map((w) => (w.id === id
      ? { ...w, rect: { ...rect, max: false }, snap: null, restoreRect: null }
      : w)),
  }));
}

export const toggleMaxWindow = (id) => setState((s) => ({
  windows: s.windows.map((w) => {
    if (w.id !== id) return w;
    if (w.rect.max) {
      const r = w.restoreRect || w.rect;
      return { ...w, snap: null, restoreRect: null, rect: { ...r, max: false } };
    }
    return { ...w, snap: null, restoreRect: restoreRectOf(w), rect: { ...w.rect, max: true } };
  }),
}));

// 拖拽/缩放时直接操作 DOM，落点提交到 store，并按窗口类型记忆几何。
// 吸附 / 最大化必须跳过几何持久化：否则下次开窗会带着半屏 / 整屏尺寸（docs §5.1）。
export const commitRect = (id, rect) => {
  setState((s) => ({
    windows: s.windows.map((w) => (w.id === id ? { ...w, rect: { ...w.rect, ...rect }, snap: null } : w)),
  }));
  const win = state.windows.find((w) => w.id === id);
  if (win && !win.rect.max && !win.snap) saveGeom(win.geomKey || win.type, win.rect);
};
export const setWindowTitle = (id, title) =>
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)) }));

export function updateWindowProps(id, patch) {
  setState((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, props: { ...w.props, ...patch } } : w)) }));
}

// ---------- 插件 / 虚拟应用 ----------
// 插件列表由桌面壳（Desktop.jsx）在登录后拉一次；失败一律按空列表处理
export const setPlugins = (plugins) => setState({ plugins: Array.isArray(plugins) ? plugins : [] });

function loadDesktopAppsHidden() {
  try {
    const v = JSON.parse(localStorage.getItem(DESKTOP_APPS_HIDDEN_KEY));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

// 「从桌面移除」：只记本地名单，v1 不做卸载（插件仍在开始菜单 / 仍可打开）
export function setAppDesktopVisible(appId, visible) {
  const cur = new Set(loadDesktopAppsHidden());
  if (visible) cur.delete(appId); else cur.add(appId);
  const list = [...cur];
  try { localStorage.setItem(DESKTOP_APPS_HIDDEN_KEY, JSON.stringify(list)); } catch { /* 忽略持久化失败 */ }
  setState({ desktopAppsHidden: list });
}

/** 应用记录 → 启动 props（对象字段直接展开，函数字段按当前 state 求值） */
export function appLaunchProps(app, st = state) {
  if (typeof app.props === 'function') return app.props(st) || {};
  return { ...(app.props || {}) };
}

function appOpenOpts(app) {
  const opts = { title: app.name };
  if (app.size) opts.size = app.size;      // 插件：manifest.window
  if (app.match) opts.match = app.match;   // 回收站 / 单个插件窗口
  if (app.geomKey) opts.geomKey = app.geomKey;
  return opts;
}

/** 桌面图标双击 / 直接开窗：multi 时每次新建，multi=false 时复用已有窗口 */
export function openApp(app) {
  return openWindow(app.windowType, appLaunchProps(app), appOpenOpts(app));
}

// ---------- Alt+Tab 窗口切换器 ----------
// 列表：非最小化窗口，按最近使用顺序（当前窗口排第一，初始选中第二项 —— Win 语义）。
// 按住 Alt 连续 Tab 循环，松开提交，Esc 取消。
export function openAltTab() {
  const s = state;
  const live = s.windows.filter((w) => !w.minimized);
  if (!live.length) return false;
  const rank = (w) => {
    const i = s.recent.indexOf(w.id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ids = live.slice().sort((a, b) => rank(a) - rank(b) || b.z - a.z).map((w) => w.id);
  // 与右键菜单 / 开始菜单共用「同一时刻只开一层」的收口规则（docs §5.4）
  setState({ popover: null, contextMenu: null, altTab: { ids, index: ids.length > 1 ? 1 : 0 } });
  return true;
}

export function cycleAltTab(dir = 1) {
  setState((s) => {
    if (!s.altTab) return null;
    const n = s.altTab.ids.length || 1;
    return { altTab: { ...s.altTab, index: (s.altTab.index + dir + n) % n } };
  });
}

export const closeAltTab = () => setState((s) => (s.altTab ? { altTab: null } : null));

export function commitAltTab() {
  const t = state.altTab;
  if (!t) return;
  const id = t.ids[t.index];
  setState({ altTab: null });
  if (id && state.windows.some((w) => w.id === id)) focusWindow(id);
}

// ---------- 剪贴板 ----------
// setClipboard(null) 表示清空：必须真的写成 null，否则会留下 {paths: undefined} 的坏状态
export const setClipboard = (mode, paths, cwd) =>
  setState({ clipboard: mode == null ? null : { mode, paths, cwd } });

// ---------- 文件窗口选择上报（外壳级快捷键 / 后续预览窗格使用） ----------
// 旧版空格预览浮层已删除，这里只保留选择上报本身，不再有浮层消费者。
export const setFinderSel = (windowId, paths) =>
  setState((s) => ({ finderSel: { ...s.finderSel, [windowId]: paths } }));

// ---------- 桌面（主目录直览）----------
// 支持函数式更新：连续点击时避免读到上一次渲染的快照
export const setDesktopSel = (names) =>
  setState((s) => ({ desktopSel: typeof names === 'function' ? names(s.desktopSel) : names }));

function saveDesktopView() {
  const s = getState();
  try {
    localStorage.setItem(DESKTOP_VIEW_KEY, JSON.stringify({
      sort: s.desktopSort, showHidden: s.desktopShowHidden, iconSize: s.desktopIconSize,
    }));
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

export function setDesktopIconSize(v) {
  if (!DESKTOP_ICON_SIZES.includes(v)) return;
  setState({ desktopIconSize: v });
  saveDesktopView();
}

// ---------- 编辑器未保存标记（关闭窗口时拦截） ----------
export const markDirty = (windowId, dirty) =>
  setState((s) => ({ editorDirty: { ...s.editorDirty, [windowId]: dirty } }));

// ---------- 窗口「未保存」标记（所有关闭入口 + beforeunload 共用的单一真相） ----------
// 插件侧入口：cloudnine.ui.markDirty(bool) → PluginWindow → 这里。
// 不进窗口对象（不跟着 openWindow/focusWindow 一起拷），而是单独一张表：
//   - closeWindow 统一读它，所以点 X / 任务栏右键 / 其它入口都会问同一句话；
//   - WindowFrame 只读它来决定标题前那个 `*`；
//   - 页面级 beforeunload 也只看它（浏览器只会弹一个原生确认框）。
export const markWindowDirty = (windowId, dirty) => setState((s) => {
  const on = !!s.dirtyWindows[windowId];
  if (on === !!dirty) return null; // 状态没变：不白跑一次全量重渲染
  const next = { ...s.dirtyWindows };
  if (dirty) next[windowId] = true; else delete next[windowId];
  return { dirtyWindows: next };
});

export const isWindowDirty = (windowId) => !!state.dirtyWindows[windowId];
export const anyWindowDirty = () => Object.keys(state.dirtyWindows).length > 0;

// 刷新 / 关标签：只要有窗口脏着就拦一次。
// 多个窗口脏着也只有这一道页面级监听 → 浏览器只弹一个原生框，不会弹窗炸弹。
if (typeof window !== 'undefined' && !window.__cnDirtyBeforeUnload) {
  window.__cnDirtyBeforeUnload = true;
  window.addEventListener('beforeunload', (ev) => {
    if (!anyWindowDirty()) return;
    ev.preventDefault();
    ev.returnValue = '有窗口还有未保存的更改'; // 旧 WebKit 只认 returnValue
  });
}

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
