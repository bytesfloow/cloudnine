import React, { Suspense, lazy } from 'react';
import Finder from './Finder.jsx';
import ErrorBoundary from '../ErrorBoundary.jsx';
import EditorSkeleton from './EditorSkeleton.jsx';
import { WINDOW_ENTRIES, appByWindowType } from '../apps/registry.jsx';

// 窗口组件映射从应用注册表派生（apps/registry.jsx 里每个应用的 load 字段）。
// core: true 的类型（finder）是桌面主路径，随主包加载；其余按需分包，减小首屏体积。
const CORE_COMPONENTS = { finder: Finder };

const lazyCache = new Map();
function componentFor(windowType) {
  if (CORE_COMPONENTS[windowType]) return CORE_COMPONENTS[windowType];
  if (!lazyCache.has(windowType)) {
    const entry = appByWindowType(windowType);
    lazyCache.set(windowType, entry?.load ? lazy(entry.load) : null);
  }
  return lazyCache.get(windowType);
}

// 启动时自检：表里的窗口类型必须要么有组件加载器、要么标记为随主包加载，
// 漏一个就是「菜单里有、点开是未知窗口类型」，让它在开发期就暴露。
const orphans = WINDOW_ENTRIES.filter((a) => !a.load && !CORE_COMPONENTS[a.windowType]);
if (orphans.length) {
  console.warn('[apps] 应用注册表里有条目既没有 load 也不是 core 组件:', orphans.map((a) => a.id));
}

// 懒加载期间的占位：编辑器有自己的骨架屏（和真实布局同尺寸，不会只剩一行 loading 干等），
// 其它窗口继续用通用转圈。骨架组件本身不带 CodeMirror 依赖，可以随主包进来。
function WindowFallback({ windowType }) {
  if (windowType === 'editor') return <EditorSkeleton />;
  return <div className="finder-loading"><div className="boot-spinner" /></div>;
}

export function renderWindow(win) {
  const C = componentFor(win.type);
  if (!C) return <div className="win-missing">未知窗口类型：{win.type}</div>;
  return (
    <ErrorBoundary label={win.type} resetKey={`${win.id}:${win.props?.path || win.props?.pluginId || ''}`}>
      <Suspense fallback={<WindowFallback windowType={win.type} />}>
        <C win={win} />
      </Suspense>
    </ErrorBoundary>
  );
}
