import React from 'react';

/**
 * 错误边界：捕获子树渲染/生命周期抛出的异常。
 *
 * 背景：此前预览窗口里有一个未定义变量（compact），双击文件即触发 ReferenceError，
 * React 会卸载整棵树 —— 整个桌面直接白屏，访达、菜单栏、Dock 全部消失。
 * 加上边界后，单个窗口出错只会让该窗口显示错误提示，其余界面照常可用。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[渲染异常]', this.props.label || '', error, info?.componentStack || '');
  }

  // 窗口内容变化（如预览切换到另一个文件）后重置错误，允许重新渲染
  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = error?.message || String(error);
    // full：整页级兜底（App 根节点），给出刷新入口，避免用户面对纯白屏
    if (this.props.full) {
      return (
        <div className="app-error">
          <div className="app-error-box">
            <div className="app-error-icon">⚠️</div>
            <p className="app-error-title">界面出现异常</p>
            <pre className="app-error-msg mono">{message}</pre>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>刷新页面</button>
          </div>
        </div>
      );
    }
    return (
      <div className="win-error">
        <div className="win-error-icon">⚠️</div>
        <p className="win-error-title">该窗口渲染出错</p>
        <pre className="win-error-msg mono">{message}</pre>
        <button className="btn" onClick={() => this.setState({ error: null })}>重试</button>
      </div>
    );
  }
}
