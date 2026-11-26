import React, { useState } from 'react';
import {
  IconFiles, IconTerminal, IconEditor, IconEye, IconInfo, IconTransfer, IconShare, IconDisk,
  IconTrash, IconPlugin,
} from '../icons.jsx';

/* ============================================================================
   统一应用注册表
   ----------------------------------------------------------------------------
   应用的一切「声明式」信息只在这里写一次：图标、窗口默认几何、开始菜单 /
   任务栏里的固定项与顺序、窗口组件从哪个模块加载。

   之前这些信息散在 5 个地方（windows/registry.jsx 的组件映射、store.js 的
   WINDOW_DEFAULTS、StartMenu.PINNED、Taskbar.PINNED、AltTab 的图标表），
   加一个内置应用要改 5 个文件、漏一个就「菜单里有、点开是未知窗口类型」。
   现在全部从这张表派生：
     - store.js            → WINDOW_DEFAULTS（窗口默认几何）
     - windows/registry.jsx→ 组件映射（renderWindow）
     - StartMenu.jsx       → 已固定 7 项 + 「插件」分组
     - Taskbar.jsx         → 固定 4 项
     - AltTab.jsx          → 切换器里的图标
   新增内置应用 = 往 BUILTIN_APPS 里加一条。

   字段：
     id         应用标识（开始菜单 / 任务栏 / 本地存储用的稳定 key）
     name       显示名（开始菜单、任务栏、桌面图标、任务栏按钮提示）
     icon       图标组件（内置 SVG；插件用 iconUrl 覆盖）
     windowType 窗口类型（openWindow 的第一个参数，窗口几何按它持久化）
     defaults   窗口默认值 {title,width,height,minWidth,minHeight,multi}
                null = 复用同 windowType 的其它应用（回收站就是文件资源管理器的变体）
     startMenu  是否进开始菜单（顺序按 order）
     taskbar    是否固定到任务栏（顺序按 order）
     order      菜单 / 任务栏里的排序键：10 起、步长 10
     props      启动时传给窗口的 props：对象或 (state) => 对象
     match      「找已有窗口」时的额外身份判定（同 windowType 里区分回收站这类变体）
     iconProps  (state) => 额外图标 props（回收站非空时用实心桶）
     load       窗口组件的动态加载器（省略 = 组件随主包加载，见 core）
     core       true = 组件由 windows/registry.jsx 直接 import（首屏主路径，不为它单独分包）
     onDesktop  是否进桌面（内置应用都为 false：桌面只放插件这类虚拟应用图标）
   ========================================================================== */

// 插件窗口共用这一个 type，靠 props.pluginId 区分是哪个插件
export const PLUGIN_WINDOW = 'plugin';

const SAME_AS_FINDER = null; // 回收站 = 文件资源管理器窗口的 {trash:true} 变体，几何跟着类型走

// 开始菜单「已固定」7 项 / 任务栏固定 4 项的顺序与名称必须与改造前逐字一致
// （docs §1.2 / §1.3；uitest 会断言项数与顺序）
export const BUILTIN_APPS = [
  {
    id: 'finder', name: '文件资源管理器', icon: IconFiles, windowType: 'finder',
    defaults: { title: '文件资源管理器', width: 860, height: 560, minWidth: 560, minHeight: 380, multi: true },
    startMenu: true, taskbar: true, order: 10,
    props: (st) => ({ cwd: st.homeRel || '' }),
    match: (w) => !w.props?.trash,
    // 文件资源管理器是桌面主路径：随主包加载，不拆分包（多一次 chunk 请求不划算）
    core: true,
  },
  {
    id: 'terminal', name: '终端', icon: IconTerminal, windowType: 'terminal',
    defaults: { title: '终端', width: 760, height: 460, minWidth: 420, minHeight: 300, multi: true },
    startMenu: true, taskbar: true, order: 20,
    load: () => import('../windows/Terminal.jsx'),
  },
  {
    // 开始菜单 / 任务栏上叫「记事本」，窗口标题仍是「文本编辑」（与改造前一致）
    id: 'editor', name: '记事本', icon: IconEditor, windowType: 'editor',
    defaults: { title: '文本编辑', width: 800, height: 560, minWidth: 480, minHeight: 360, multi: true },
    startMenu: true, taskbar: true, order: 30,
    load: () => import('../windows/Editor.jsx'),
  },
  {
    // 预览 / 属性没有独立入口：必须带 props.path 才能工作，空参启动等于放一个点了就报错的按钮
    id: 'preview', name: '预览', icon: IconEye, windowType: 'preview',
    defaults: { title: '预览', width: 780, height: 580, minWidth: 420, minHeight: 320, multi: true },
    startMenu: false, taskbar: false, order: 32,
    load: () => import('../windows/Preview.jsx'),
  },
  {
    id: 'info', name: '属性', icon: IconInfo, windowType: 'info',
    defaults: { title: '属性', width: 400, height: 480, minWidth: 360, minHeight: 320, multi: true },
    startMenu: false, taskbar: false, order: 34,
    load: () => import('../windows/Info.jsx'),
  },
  // multi: true 的五个类型（finder/terminal/editor/preview/info）同类型可多开：
  // 任务栏必须每窗口一个按钮，按 type 去重会让按钮数与窗口数对不上（见 docs §5.3）
  {
    id: 'transfers', name: '传输', icon: IconTransfer, windowType: 'transfers',
    defaults: { title: '传输', width: 720, height: 480, minWidth: 520, minHeight: 360, multi: false },
    startMenu: true, taskbar: true, order: 40,
    load: () => import('../windows/Transfers.jsx'),
  },
  {
    id: 'shares', name: '分享管理', icon: IconShare, windowType: 'shares',
    defaults: { title: '分享管理', width: 760, height: 500, minWidth: 560, minHeight: 400, multi: false },
    startMenu: true, taskbar: false, order: 50,
    load: () => import('../windows/Shares.jsx'),
  },
  {
    id: 'disk', name: '磁盘监控', icon: IconDisk, windowType: 'disk',
    defaults: { title: '磁盘监控', width: 680, height: 520, minWidth: 480, minHeight: 380, multi: false },
    startMenu: true, taskbar: false, order: 60,
    load: () => import('../windows/Disk.jsx'),
  },
  {
    // 与文件资源管理器同类型（finder），靠 props.trash + match 区分身份：
    // 否则「回收站」会把一个已最小化的普通文件窗口还原出来（docs §5.3 ①）
    id: 'trash', name: '回收站', icon: IconTrash, windowType: 'finder',
    defaults: SAME_AS_FINDER,
    startMenu: true, taskbar: false, order: 70,
    props: { trash: true },
    match: (w) => !!w.props?.trash,
    iconProps: (st) => ({ full: st.trashCount > 0 }),
  },
];

// 只承载窗口、不出现在菜单里的类型（插件宿主窗口）
const INTERNAL_WINDOWS = [
  {
    id: PLUGIN_WINDOW, name: '插件', icon: IconPlugin, windowType: PLUGIN_WINDOW,
    // 兜底默认值；真实尺寸由 manifest.window 通过 openWindow 的单窗口覆盖传进来
    defaults: { title: '插件', width: 900, height: 620, minWidth: 420, minHeight: 320, multi: true },
    startMenu: false, taskbar: false, order: 999,
    load: () => import('../windows/PluginWindow.jsx'),
  },
];

// 所有有窗口的类型（含内部类型）：窗口组件映射 / 默认几何都从这里取
export const WINDOW_ENTRIES = [...BUILTIN_APPS, ...INTERNAL_WINDOWS];

const byOrder = (a, b) => a.order - b.order;

export function appByWindowType(windowType) {
  return WINDOW_ENTRIES.find((a) => a.windowType === windowType) || null;
}

/** store.openWindow 用的默认几何（表里的 width/height 在这里落成 w/h） */
export const WINDOW_DEFAULTS = Object.fromEntries(
  WINDOW_ENTRIES.filter((a) => a.defaults).map((a) => [a.windowType, {
    title: a.defaults.title,
    w: a.defaults.width,
    h: a.defaults.height,
    minW: a.defaults.minWidth,
    minH: a.defaults.minHeight,
    multi: a.defaults.multi,
  }]),
);

/** 开始菜单里的内置固定项（7 项） */
export const START_MENU_APPS = BUILTIN_APPS.filter((a) => a.startMenu).sort(byOrder);
/** 任务栏固定项（4 项） */
export const TASKBAR_APPS = BUILTIN_APPS.filter((a) => a.taskbar).sort(byOrder);

/* ============================ 插件 → 应用记录 ============================ */

// v1 插件装的是一份静态前端包，窗口尺寸来自 manifest.window（服务端已补过默认值）
const DEFAULT_PLUGIN_WINDOW = { width: 900, height: 620, minWidth: 420, minHeight: 320, multi: true };

export function pluginApps(plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  return list.map((p, i) => ({
    id: `plugin:${p.id}`,
    pluginId: p.id,
    name: p.name || p.id,
    icon: IconPlugin,
    iconUrl: p.iconUrl || null,
    windowType: PLUGIN_WINDOW,
    isPlugin: true,
    size: { ...DEFAULT_PLUGIN_WINDOW, ...(p.window || {}) },
    // 每个插件各存一份窗口几何：否则先后打开的两个插件会互相覆盖对方的尺寸
    geomKey: `plugin:${p.id}`,
    props: { pluginId: p.id },
    match: (w) => w.props?.pluginId === p.id,
    startMenu: p.inStartMenu !== false,
    taskbar: false, // 插件默认不固定，打开的插件窗口按「每窗口一个按钮」出现在任务栏
    onDesktop: p.onDesktop !== false,
    order: 1000 + i,
    // 文件关联（v1.1）：服务端已把缺失字段补成 []，这里再兜一层
    fileTypes: Array.isArray(p.fileTypes) ? p.fileTypes : [],
    defaultFor: Array.isArray(p.defaultFor) ? p.defaultFor : [],
  }));
}

/** 开始菜单条目：内置 7 项在前，插件按服务端返回顺序追加（「插件」分组） */
export function startMenuApps(plugins) {
  return [...START_MENU_APPS, ...pluginApps(plugins).filter((a) => a.startMenu)];
}

/** 桌面虚拟应用图标（插件）：按 order 固定顺序，不受桌面「排序方式」影响 */
export function desktopApps(plugins, hiddenIds = []) {
  return pluginApps(plugins)
    .filter((a) => a.onDesktop && !hiddenIds.includes(a.id))
    .sort(byOrder);
}

/** 窗口 → 应用记录（Alt+Tab、任务栏按类型取图标用） */
export function appForWindow(win, plugins) {
  if (!win) return null;
  if (win.type === PLUGIN_WINDOW && win.props?.pluginId) {
    return pluginApps(plugins).find((a) => a.pluginId === win.props.pluginId) || appByWindowType(PLUGIN_WINDOW);
  }
  return appByWindowType(win.type);
}

/* ============================ 文件关联（v1.1） ============================ */

// 扩展名一律带点、小写：'.json'。名字里没有点（Makefile）或只有前导点（.gitignore）时为 ''，
// 与 store.js 的 extname() 口径一致（那边返回不带点的 'json'，调用方加点）。
const normExt = (ext) => String(ext || '').trim().toLowerCase();

/** 能打开某扩展名的插件应用（按 manifest.fileTypes）；没有 fileTypes 的插件永远不在这里出现 */
export function pluginAppsForExt(plugins, ext) {
  const e = normExt(ext);
  if (!e) return [];
  return pluginApps(plugins).filter((a) => a.fileTypes.includes(e));
}

/**
 * 某扩展名的默认插件（manifest.defaultFor）：
 *   { app }                    唯一声明 → 双击该扩展名文件直接用它
 *   { conflict:true, apps }    多个插件抢同一扩展名 → **不默认**，回退内置程序打开
 *   null                       没有插件声明默认
 * 冲突时不弹选择器、不猜：静默回退，用户仍可从「打开方式」里手动选一个。
 */
export function defaultPluginForExt(plugins, ext) {
  const e = normExt(ext);
  if (!e) return null;
  const apps = pluginAppsForExt(plugins, e).filter((a) => a.defaultFor.includes(e));
  if (!apps.length) return null;
  if (apps.length > 1) return { conflict: true, apps };
  return { app: apps[0] };
}

/** 单插件条目：文件关联打开时按 pluginId 取（找不到 = 插件已被卸载） */
export function pluginAppById(plugins, pluginId) {
  return pluginApps(plugins).find((a) => a.pluginId === pluginId) || null;
}

/**
 * 应用图标：插件优先用服务端拼好的 iconUrl（/pa 签名地址），加载失败回退到通用插件图标。
 * 尺寸按调用方给的像素走，桌面图标档位 / 开始菜单 / 任务栏共用。
 */
export function AppIcon({ app, size = 24, ...rest }) {
  const [broken, setBroken] = useState(false);
  if (app.iconUrl && !broken) {
    return (
      <img
        className="app-icon-img"
        src={app.iconUrl}
        width={size}
        height={size}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
      />
    );
  }
  const Icon = app.icon || IconPlugin;
  return <Icon size={size} {...rest} />;
}
