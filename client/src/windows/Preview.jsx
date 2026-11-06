import React, { useEffect, useState } from 'react';
import { useStore, setWindowTitle, updateWindowProps, openWindow, notify, basename, fmtSize, fmtTime, fileCat, extname } from '../store.js';
import { api } from '../api.js';
import { FileIcon, IconChevron } from '../icons.jsx';
import ImageViewer, { useImageView, MIN_ZOOM, MAX_ZOOM } from './ImageViewer.jsx';

// 图片缩放/旋转工具组：预览窗口底部统一操作条与快速预览共用
function ZoomTools({ view }) {
  return (
    <div className="preview-zoom">
      <button className="btn btn-small" onClick={() => view.setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))} title="缩小">−</button>
      <span className="preview-zoom-val">{Math.round(view.zoom * 100)}%</span>
      <button className="btn btn-small" onClick={() => view.setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))} title="放大">＋</button>
      <button className="btn btn-small" onClick={() => view.reset()} title="适应窗口（双击图片可复位）">适应</button>
      <button className="btn btn-small" onClick={() => view.setRotate((r) => (r + 90) % 360)}>旋转</button>
    </div>
  );
}

// 缩放/旋转/平移状态：预览窗口把缩放工具并入底部统一操作条，故由窗口持有并下传；
// 快速预览/移动端未传 view 时，由本组件自持状态。
function useViewState(controlled) {
  const local = useImageView();
  return controlled || local;
}

// 预览内容组件：桌面预览窗口、快速预览、移动端共用
export function PreviewContent({ path, compact = false, onEdit, view }) {
  const cat = fileCat(path, 'file');
  const v = useViewState(view);
  const [mdView, setMdView] = useState('render');
  const [text, setText] = useState(null);
  const [archiveEntries, setArchiveEntries] = useState(null);
  const [officeHtml, setOfficeHtml] = useState(null);
  const [stat, setStat] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError(''); setText(null); setArchiveEntries(null); setOfficeHtml(null);
    // 受控模式（预览窗口）由窗口在切换文件时重置缩放/旋转
    if (!view) v.reset();
    if (!view) v.setRotate(0);
    api.stat(path).then(setStat).catch(() => {});
    if (['text', 'code'].includes(cat)) {
      api.read(path).then((r) => setText(r)).catch((e) => setError(e.message));
    } else if (cat === 'archive') {
      api.archiveList(path).then((r) => setArchiveEntries(r.entries)).catch((e) => setArchiveEntries({ error: e.message }));
    }
  }, [path]);

  if (error) return <div className="preview-error">⚠️ {error}</div>;

  const src = api.downloadUrl(path, true);

  if (cat === 'image') {
    return (
      <div className="preview-image">
        {/* 滚轮/双指缩放 + 拖拽平移，由 ImageViewer 承载手势 */}
        <ImageViewer src={src} alt={basename(path)} view={v} />
        {/* 缩放工具统一放在窗口底部操作条里；独立使用时（快速预览/移动端）才自带 */}
        {!view && (
          <div className="preview-toolbar">
            <ZoomTools view={v} />
            <span className="preview-hint">
              <span className="hint-fine">滚轮缩放 · </span>拖动平移 ·{' '}
              <span className="hint-fine">双击复位</span>
              <span className="hint-coarse">双指缩放 · 双击复位</span>
            </span>
          </div>
        )}
      </div>
    );
  }
  if (cat === 'video') return <video className="preview-media" src={src} controls autoPlay />;
  if (cat === 'audio') return (
    <div className="preview-audio">
      <div className="audio-art">♪</div>
      <audio src={src} controls autoPlay />
    </div>
  );
  if (cat === 'pdf') return <iframe className="preview-pdf" src={src} title={basename(path)} />;

  if (cat === 'text' || cat === 'code') {
    if (!text) return <Spin />;
    const isMd = extname(path) === 'md';
    return (
      <div className="preview-text">
        {isMd && (
          <div className="preview-toolbar">
            <button className={`btn btn-small${mdView === 'render' ? ' active' : ''}`} onClick={() => setMdView('render')}>渲染</button>
            <button className={`btn btn-small${mdView === 'source' ? ' active' : ''}`} onClick={() => setMdView('source')}>源码</button>
            {onEdit && <button className="btn btn-small" onClick={onEdit}>编辑</button>}
          </div>
        )}
        {isMd && mdView === 'render'
          ? <MdRender source={text.content} />
          : <pre className={`preview-pre mono${cat === 'code' ? ' code' : ''}`}>{text.content}{text.truncated ? '\n\n…（文件过大，已截断显示）' : ''}</pre>}
        {onEdit && !isMd && (
          <div className="preview-toolbar">
            <button className="btn btn-small" onClick={onEdit}>用编辑器打开</button>
          </div>
        )}
      </div>
    );
  }
  if (cat === 'csv') {
    if (!text) return <Spin />;
    const sep = extname(path) === 'tsv' ? '\t' : ',';
    const rows = text.content.split('\n').slice(0, 1000).map((l) => l.split(sep));
    return (
      <div className="preview-csv">
        <table>
          <thead><tr>{rows[0]?.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (cat === 'archive') {
    return (
      <div className="preview-archive">
        {archiveEntries?.error ? <div className="preview-error">⚠️ {archiveEntries.error}</div> : (
          <table className="archive-table">
            <thead><tr><th>包内路径</th><th>大小</th></tr></thead>
            <tbody>
              {(archiveEntries || []).map((e, i) => (
                <tr key={i}><td>{e.name}</td><td>{e.dir ? '—' : fmtSize(e.size)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  if (cat === 'office') {
    const e = extname(path);
    if (!officeHtml && !error) {
      loadOffice(e, src).then(setOfficeHtml).catch((err2) => setError(`无法在线预览：${err2.message}，请下载后查看`));
    }
    if (officeHtml?.error) return (
      <div className="preview-error">⚠️ {officeHtml.error}
        <div><button className="btn btn-small" onClick={() => window.open(api.downloadUrl(path))}>下载文件</button></div>
      </div>
    );
    return <div className="preview-office" dangerouslySetInnerHTML={{ __html: officeHtml?.html || '' }} />;
  }
  // 其他/未知：文件信息卡
  return (
    <div className="preview-unknown">
      <FileIcon name={path} type="file" size={64} />
      <h3>{basename(path)}</h3>
      {stat && (
        <table className="about-table">
          <tbody>
            <tr><td>大小</td><td>{fmtSize(stat.size)}</td></tr>
            <tr><td>修改时间</td><td>{fmtTime(stat.mtimeMs)}</td></tr>
            <tr><td>权限</td><td className="mono">{stat.modeStr}</td></tr>
          </tbody>
        </table>
      )}
      <button className="btn btn-primary" onClick={() => window.open(api.downloadUrl(path))}>下载文件</button>
    </div>
  );
}

async function loadOffice(ext, src) {
  try {
    if (ext === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const res = await fetch(src);
      const buf = await res.arrayBuffer();
      const r = await mammoth.convertToHtml({ arrayBuffer: buf });
      return { html: r.value };
    }
    if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const res = await fetch(src);
      const buf = await res.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      let html = '';
      for (const name of wb.SheetNames.slice(0, 5)) {
        html += `<h4>${name}</h4>` + XLSX.utils.sheet_to_html(wb.Sheets[name]);
      }
      return { html };
    }
    return { error: '该格式暂不支持在线预览' };
  } catch (e) {
    return { error: `预览失败：${e.message}` };
  }
}

function MdRender({ source }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    import('marked').then(({ marked }) => setHtml(marked.parse(source, { breaks: true })));
  }, [source]);
  return <div className="md-render" dangerouslySetInnerHTML={{ __html: html }} />;
}

const Spin = () => <div className="finder-loading"><div className="boot-spinner" /></div>;

// 预览窗口（含同目录导航）
export default function PreviewWindow({ win }) {
  const { path, siblings, index } = win.props;
  const s = useStore();
  // 缩放/旋转/平移由窗口持有：工具统一收敛到底部操作条，不再浮在图片上方
  const view = useImageView();
  useEffect(() => { setWindowTitle(win.id, basename(path)); }, [path, win.id]);
  // 切换文件时重置缩放/旋转/平移
  useEffect(() => { view.reset(); view.setRotate(0); }, [path]);

  const nav = (delta) => {
    if (!siblings || siblings.length < 2) return;
    const n = (index + delta + siblings.length) % siblings.length;
    updateWindowProps(win.id, { path: siblings[n], index: n });
  };

  const isImage = fileCat(path, 'file') === 'image';

  return (
    <div className="preview-window">
      {siblings?.length > 1 && (
        <div className="preview-nav">
          <button className="tb-btn" onClick={() => nav(-1)} title="上一个"><IconChevron dir="left" /></button>
          <span className="preview-nav-count">{(index ?? 0) + 1} / {siblings.length}</span>
          <button className="tb-btn" onClick={() => nav(1)} title="下一个"><IconChevron /></button>
        </div>
      )}
      <div className="preview-body">
        <PreviewContent
          path={path}
          view={view}
          onEdit={() => openWindow('editor', { path, name: basename(path) })}
        />
      </div>
      {/* 统一操作条：缩放/旋转 与 下载/复制路径 收拢在一起（文件名只在窗口标题栏出现一次） */}
      <div className="preview-actions">
        {isImage && <ZoomTools view={view} />}
        {isImage && <span className="preview-sep" />}
        <button className="btn btn-small" onClick={() => window.open(api.downloadUrl(path))}>下载</button>
        <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText('/' + path).then(() => notify({ title: '路径已复制' }))}>复制路径</button>
      </div>
    </div>
  );
}
