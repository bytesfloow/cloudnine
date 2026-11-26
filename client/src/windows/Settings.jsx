import React, { useEffect, useRef, useState } from 'react';
import {
  useStore, notify, confirmDialog, setTheme, setDesktopIconSize, openApp, fmtSize,
  loadPlugins, installPlugin, uninstallPlugin, DESKTOP_ICON_SIZES,
} from '../store.js';
import { api } from '../api.js';
import { pluginAppById } from '../apps/registry.jsx';
import { IconPlugin, IconRefresh, IconUpload, IconInfo, IconDoc, IconEye } from '../icons.jsx';

/* ============================================================================
   设置窗口（系统设置）
   ----------------------------------------------------------------------------
   左侧分区导航 + 右侧内容区，分区只是本窗口内部的 state（不是窗口类型），
   材质 / 圆角 / 颜色全部走既有令牌（--sidebar-bg / --panel-bg / --accent …），
   与文件资源管理器的侧栏同一套语言。

   分区：
     插件   列表 / 安装（文件选择 + 拖拽）/ 覆盖确认 / 卸载 / 打开（本期新增的重点）
     外观   主题三档 + 桌面图标大小（复用既有 store 动作，不另存一份偏好）
     关于   站点与服务信息（GET /api/about，与「关于本系统」铭牌同源）

   插件列表的真相在 store.plugins（见 store.js 的插件段）：
   装 / 卸 / 覆盖安装都就地改这一份，桌面图标与开始菜单「插件」分组由它派生，
   所以**不用刷新页面**就能看到变化（旧版要刷新，见 docs/plugins.md §8 第 6 条）。
   ========================================================================== */

const SECTIONS = [
  { key: 'plugins', label: '插件', Icon: IconPlugin },
  { key: 'appearance', label: '外观', Icon: IconEye },
  { key: 'about', label: '关于', Icon: IconInfo },
];

// 权限的中文标签（docs/plugins.md §3 的五个权限，与 manifest 一一对应）
const PERM_LABELS = {
  storage: '本地存储',
  'fs.read': '读取文件',
  'fs.write': '写入文件',
  'clipboard.write': '复制到剪贴板',
  notify: '发送通知',
};

// 服务端 /api/plugins/install 的 body 上限（server/src/plugins.js 的 express.raw limit: '8mb'）
const MAX_ZIP = 8 * 1024 * 1024;

export default function SettingsWindow({ win }) {
  const s = useStore();
  const initial = SECTIONS.some((x) => x.key === win?.props?.section) ? win.props.section : 'plugins';
  const [section, setSection] = useState(initial);

  return (
    <div className="settings-window">
      <nav className="set-nav" aria-label="设置分区">
        <div className="set-nav-head">设置</div>
        {SECTIONS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            data-section={key}
            className={`set-nav-item${section === key ? ' active' : ''}`}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
          >
            <Icon size={16} />
            <span>{label}</span>
            {key === 'plugins' && s.plugins.length > 0 && <span className="set-nav-count">{s.plugins.length}</span>}
          </button>
        ))}
      </nav>
      <div className="set-main">
        {section === 'plugins' && <PluginsPanel />}
        {section === 'appearance' && <AppearancePanel />}
        {section === 'about' && <AboutPanel />}
      </div>
    </div>
  );
}

/* ------------------------------ 插件 ------------------------------ */

const isZip = (name) => /\.zip$/i.test(String(name || ''));

function PluginsPanel() {
  const s = useStore();
  const [busy, setBusy] = useState(null);       // {name, progress} —— 上传中
  const [error, setError] = useState('');       // 可读的失败原因（列表 / 安装 / 卸载）
  const [status, setStatus] = useState('');     // 成功提示
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  // 桌面壳登录时已经拉过一次；万一那次失败了（或设置窗口比它先挂载），这里补一次
  useEffect(() => {
    if (!s.pluginsLoaded) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    setError('');
    const r = await loadPlugins();
    setLoading(false);
    if (!r) setError('读取插件列表失败：网络不可用或登录已过期，请稍后重试。');
  }

  async function handleFile(file, { overwrite = false } = {}) {
    if (!file) return;
    setStatus('');
    // 前端先拦一道，别让用户在 8MB 上传完之后才看到 413
    if (!isZip(file.name)) {
      setError(`「${file.name || '这个文件'}」不是 zip 插件包，只接受 .zip 文件。`);
      return;
    }
    if (file.size > MAX_ZIP) {
      setError(`插件包是 ${fmtSize(file.size)}，超过 8 MB 上限，请精简后重试。`);
      return;
    }
    setError('');
    setBusy({ name: file.name, progress: 0 });
    try {
      const plugin = await installPlugin(file, {
        overwrite,
        onProgress: (p) => setBusy((b) => (b ? { ...b, progress: p } : b)),
      });
      setBusy(null);
      setStatus(`已安装「${plugin.name}」v${plugin.version}${overwrite ? '（覆盖了旧版本）' : ''}。`);
      notify({ type: 'success', title: '插件已安装', body: `${plugin.name} v${plugin.version}` });
    } catch (e) {
      setBusy(null);
      if (e?.status === 409 && !overwrite) {
        // 409 返回体里带机器可读的 id / version（服务端读的是**已安装的那一份** manifest），
        // 不在前端解析文案、也不拿 store 里的版本充数 —— 两边不一致时以服务端为准。
        // 字段缺失时退回通用文案，不允许报错。
        const info = e?.body && typeof e.body === 'object' ? e.body : {};
        const existedId = typeof info.id === 'string' ? info.id : '';
        const existedVer = typeof info.version === 'string' && info.version ? info.version : '';
        const known = existedId ? s.plugins.find((p) => p.id === existedId) : null;
        const label = known?.name || existedId;
        let message;
        if (label && existedVer) message = `已存在「${label}」v${existedVer}，是否用「${file.name}」覆盖安装？`;
        else if (label) message = `已存在「${label}」，是否用「${file.name}」覆盖安装？`;
        else if (existedVer) message = `已存在 v${existedVer} 的同名插件，是否用「${file.name}」覆盖安装？`;
        else message = `已存在同名插件，是否用「${file.name}」覆盖安装？`;
        const ok = await confirmDialog({
          title: '插件已存在',
          message,
          okText: '覆盖安装',
          cancelText: '取消',
          danger: true,
        });
        if (ok) return handleFile(file, { overwrite: true });
        setStatus('已取消覆盖安装，现有插件没有变化。');
        return;
      }
      setError(`安装失败：${e?.message || '未知错误'}`);
    }
  }

  async function handleRemove(p) {
    const ok = await confirmDialog({
      title: '卸载插件',
      message: `确定卸载「${p.name}」v${p.version}？会同时删除该插件的本地数据（storage 里存的内容无法恢复）。`,
      okText: '卸载',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    setStatus('');
    setError('');
    try {
      await uninstallPlugin(p.id);
      setStatus(`已卸载「${p.name}」，它的本地数据也已删除。`);
      notify({ type: 'success', title: '插件已卸载', body: p.name });
    } catch (e) {
      setError(`卸载失败：${e?.message || '未知错误'}`);
    }
  }

  function openPlugin(p) {
    const app = pluginAppById(s.plugins, p.id);
    if (app) openApp(app);
  }

  const invalid = s.pluginsInvalid || [];
  const listError = s.pluginsError || '';
  const shownError = error || (listError ? `读取插件列表失败：${listError}` : '');

  return (
    <div className="plug-panel">
      <div className="section-head">
        <h4>插件<span className="head-count">{s.plugins.length} 个</span></h4>
        <div className="section-actions">
          <button type="button" className="btn btn-small plug-refresh" onClick={refresh} disabled={loading || !!busy}>
            <IconRefresh size={14} /><span>{loading ? '刷新中…' : '刷新'}</span>
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary plug-pick"
            onClick={() => inputRef.current?.click()}
            disabled={!!busy}
          >
            <IconUpload size={14} /><span>安装插件…</span>
          </button>
        </div>
      </div>

      {/* 安装区：文件选择 + 拖拽（同一个入口，两种习惯） */}
      <div
        className={`plug-drop${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
        data-testid="plug-drop"
        role="button"
        tabIndex={busy ? -1 : 0}
        onClick={() => { if (!busy) inputRef.current?.click(); }}
        onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
        onDragEnter={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (busy) return;
          handleFile(e.dataTransfer?.files?.[0]);
        }}
      >
        {busy ? (
          <div className="plug-progress-wrap">
            <div className="plug-progress-top">
              <span className="running-dot" aria-hidden="true" />
              <span className="plug-progress-label">正在安装「{busy.name}」…</span>
              <span className="plug-progress-pct">{Math.round((busy.progress || 0) * 100)}%</span>
            </div>
            <div className={`plug-progress tr-bar${(busy.progress || 0) < 0.02 ? ' indeterminate' : ''}`} data-progress={Math.round((busy.progress || 0) * 100)}>
              <i style={{ width: `${Math.max(4, Math.round((busy.progress || 0) * 100))}%` }} />
            </div>
            <p className="plug-hint">上传完成后服务端要校验并解压，这一步不会再涨进度，请稍等。</p>
          </div>
        ) : (
          <>
            <span className="plug-drop-icon" aria-hidden="true"><IconUpload size={20} /></span>
            <div className="plug-drop-main">
              <div className="plug-drop-title">把插件 zip 拖到这里，或<span className="plug-drop-link">点此选择文件</span></div>
              <div className="plug-drop-sub">只接受 .zip（zip 根目录放 plugin.json，或只放一个顶层目录），单个包上限 8 MB。</div>
            </div>
          </>
        )}
      </div>

      {/* 文件选择放在拖拽区**外面**：input 自己的 click 会冒泡回拖拽区，
          放里面会变成「点一次转两圈」的重复弹框 */}
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="plug-file-input"
        aria-label="选择插件 zip 包"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ''; // 同一个文件再选一次也要能触发 change
          handleFile(f);
        }}
      />

      {/* 操作结果：成功 / 失败都给出真实文案，不吞错误 */}
      <div className="plug-status-area" aria-live="polite">
        {status && <div className="plug-status ok">{status}</div>}
        {shownError && (
          <div className="plug-status bad" role="alert">
            <span>{shownError}</span>
            {listError && !error && <button type="button" className="btn btn-small plug-retry" onClick={refresh}>重试</button>}
          </div>
        )}
      </div>

      {/* manifest 坏掉的目录：列表接口不会 500，而是在 invalid 里给出原因，这里如实展示 */}
      {invalid.length > 0 && (
        <div className="plug-invalid-block">
          <div className="plug-invalid-title">有 {invalid.length} 个插件目录无法加载（manifest 非法）</div>
          {invalid.map((x) => (
            <div className="plug-invalid-row" key={x.dir} data-dir={x.dir}>
              <span className="mono plug-invalid-dir">{x.dir}</span>
              <span className="plug-invalid-err">{x.error}</span>
            </div>
          ))}
          <p className="plug-hint">这些目录不会出现在桌面 / 开始菜单；修好 plugin.json 或删掉目录后点「刷新」。</p>
        </div>
      )}

      {/* 列表 / 空态 */}
      {!s.pluginsLoaded && loading ? (
        <div className="plug-loading"><span className="boot-spinner" /> 正在读取插件列表…</div>
      ) : s.plugins.length === 0 ? (
        <div className="plug-empty">
          <span className="plug-empty-icon"><IconPlugin size={40} /></span>
          <div className="plug-empty-title">还没有安装任何插件</div>
          <div className="plug-empty-sub">插件是纯静态前端包（plugin.json + 入口 HTML），装上后会出现在桌面和开始菜单里。</div>
        </div>
      ) : (
        <div className="plug-list">
          {s.plugins.map((p) => (
            <div className="plug-row" data-plugin={p.id} key={p.id}>
              <div className="plug-icon">
                {p.iconUrl
                  ? <img src={p.iconUrl} alt="" className="plug-icon-img" draggable={false} />
                  : <IconPlugin size={34} />}
              </div>
              <div className="plug-main">
                <div className="plug-title-row">
                  <span className="plug-name ellipsis" title={p.name}>{p.name}</span>
                  <span className="plug-ver mono">v{p.version}</span>
                  {typeof p.size === 'number' && <span className="plug-size">{fmtSize(p.size)}</span>}
                </div>
                <div className="plug-meta">
                  <span className="plug-author ellipsis" title={p.author || ''}>{p.author || '未署名'}</span>
                  <span className="plug-dot" aria-hidden="true">·</span>
                  <span className="plug-id mono ellipsis" title={p.id}>{p.id}</span>
                </div>
                <div className="plug-tags">
                  {(p.permissions || []).length === 0
                    ? <span className="plug-perm none">没有声明权限</span>
                    : p.permissions.map((perm) => (
                      <span className="plug-perm" data-perm={perm} key={perm} title={perm}>
                        {PERM_LABELS[perm] || perm}
                      </span>
                    ))}
                  <span className="plug-ftypes" data-count={(p.fileTypes || []).length}>
                    {(p.fileTypes || []).length > 0
                      ? `可打开 ${p.fileTypes.join(' ')}`
                      : '不关联文件类型'}
                  </span>
                </div>
              </div>
              <div className="plug-actions">
                <button type="button" className="btn btn-small plug-open" disabled={!!busy} onClick={() => openPlugin(p)}>打开</button>
                <button type="button" className="btn btn-small btn-danger plug-remove" disabled={!!busy} onClick={() => handleRemove(p)}>卸载</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 外观 ------------------------------ */

const THEMES = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'auto', label: '跟随系统' },
];

const ICON_SIZE_LABELS = { large: '大图标', medium: '中等图标', small: '小图标' };

function AppearancePanel() {
  const s = useStore();
  return (
    <div className="set-panel">
      <div className="section-head"><h4>外观</h4></div>
      <div className="set-group">
        <div className="set-group-title">主题</div>
        <div className="set-choices">
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              data-theme-choice={t.key}
              className={`set-choice${s.theme === t.key ? ' active' : ''}`}
              onClick={() => setTheme(t.key)}
            >
              <span className="di-check">{s.theme === t.key ? '✓' : ''}</span>{t.label}
            </button>
          ))}
        </div>
        <p className="info-hint">主题会立即生效，并记在本地（下次打开还是这个）。</p>
      </div>
      <div className="set-group">
        <div className="set-group-title">桌面图标大小</div>
        <div className="set-choices">
          {DESKTOP_ICON_SIZES.map((k) => (
            <button
              key={k}
              type="button"
              data-icon-size={k}
              className={`set-choice${s.desktopIconSize === k ? ' active' : ''}`}
              onClick={() => setDesktopIconSize(k)}
            >
              <span className="di-check">{s.desktopIconSize === k ? '✓' : ''}</span>{ICON_SIZE_LABELS[k] || k}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 关于 ------------------------------ */

function AboutPanel() {
  const s = useStore();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.about()
      .then((r) => { if (alive) setInfo(r); })
      .catch((e) => { if (alive) setError(e?.message || '读取失败'); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="set-panel">
      <div className="section-head"><h4>关于</h4></div>
      <div className="about-head">
        <span className="about-logo"><IconDoc size={34} /></span>
        <div>
          <div className="about-title">{s.siteName || info?.siteName || 'CloudNine'}</div>
          <div className="about-sub">自托管浏览器云桌面 · v{info?.version || s.version || '—'}</div>
        </div>
      </div>
      {error ? (
        <div className="plug-status bad" role="alert">读取系统信息失败：{error}</div>
      ) : !info ? (
        <div className="plug-loading"><span className="boot-spinner" /> 正在读取…</div>
      ) : (
        <table className="about-table">
          <tbody>
            <tr><td>当前用户</td><td>{s.user || '—'}</td></tr>
            <tr><td>站点名称</td><td>{info.siteName}</td></tr>
            <tr><td>版本</td><td>{info.version}</td></tr>
            <tr><td>主机名</td><td>{info.hostname}</td></tr>
            <tr><td>运行用户</td><td>{info.runtimeUser}</td></tr>
            <tr><td>平台</td><td>{info.platform}</td></tr>
            <tr><td>文件根目录</td><td className="mono">{info.fileRoot}</td></tr>
            <tr><td>回收站保留</td><td>{info.trashRetentionDays} 天</td></tr>
            <tr><td>已装插件</td><td>{s.plugins.length} 个</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
