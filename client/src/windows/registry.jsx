import React, { Suspense, lazy } from 'react';
import Finder from './Finder.jsx';
import ErrorBoundary from '../ErrorBoundary.jsx';

// 核心窗口（文件）随桌面加载；其余按需分包，减小首屏体积
const TerminalWindow = lazy(() => import('./Terminal.jsx'));
const EditorWindow = lazy(() => import('./Editor.jsx'));
const PreviewWindow = lazy(() => import('./Preview.jsx'));
const InfoWindow = lazy(() => import('./Info.jsx'));
const TransfersWindow = lazy(() => import('./Transfers.jsx'));
const SharesWindow = lazy(() => import('./Shares.jsx'));
const DiskWindow = lazy(() => import('./Disk.jsx'));

const REGISTRY = {
  finder: Finder,
  terminal: TerminalWindow,
  editor: EditorWindow,
  preview: PreviewWindow,
  info: InfoWindow,
  transfers: TransfersWindow,
  shares: SharesWindow,
  disk: DiskWindow,
};

export function renderWindow(win) {
  const C = REGISTRY[win.type];
  if (!C) return <div className="win-missing">未知窗口类型：{win.type}</div>;
  return (
    <ErrorBoundary label={win.type} resetKey={`${win.id}:${win.props?.path || ''}`}>
      <Suspense fallback={<div className="finder-loading"><div className="boot-spinner" /></div>}>
        <C win={win} />
      </Suspense>
    </ErrorBoundary>
  );
}
