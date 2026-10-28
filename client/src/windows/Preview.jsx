import React, { useEffect, useState } from 'react';
import { useStore, setWindowTitle, updateWindowProps, openWindow, notify, basename, fmtSize, fmtTime, fileCat, extname } from '../store.js';
import { api } from '../api.js';
import { FileIcon, IconChevron } from '../icons.jsx';

// 预览内容组件：桌面预览窗口、快速预览、移动端共用
export function PreviewContent({ path, compact = false, onEdit }) {
  const cat = fileCat(path, 'file');
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [mdView, setMdView] = useState('render');
  const [text, setText] = useState(null);
  const [archiveEntries, setArchiveEntries] = useState(null);
  const [officeHtml, setOfficeHtml] = useState(null);
  const [stat, setStat] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setZoom(1); setRotate(0); setError(''); setText(null); setArchiveEntries(null); setOfficeHtml(null);
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
        <img src={src} alt={basename(path)} style={{ transform: `scale(${zoom}) rotate(${rotate}deg)`, maxWidth: '100%', maxHeight: '100%' }} />
        <div className="preview-toolbar">
          <button className="btn btn-small" onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="btn btn-small" onClick={() => setZoom((z) => Math.min(8, z + 0.25))}>＋</button>
          <button className="btn btn-small" onClick={() => setZoom(1)}>适应</button>
          <button className="btn btn-small" onClick={() => setRotate((r) => (r + 90) % 360)}>旋转</button>
        </div>
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
  useEffect(() => { setWindowTitle(win.id, basename(path)); }, [path, win.id]);

  const nav = (delta) => {
    if (!siblings || siblings.length < 2) return;
    const n = (index + delta + siblings.length) % siblings.length;
    updateWindowProps(win.id, { path: siblings[n], index: n });
  };

  return (
    <div className="preview-window">
      {!compact && siblings?.length > 1 && (
        <div className="preview-nav">
          <button className="tb-btn" onClick={() => nav(-1)} title="上一个"><IconChevron dir="left" /></button>
          <span>{(index ?? 0) + 1} / {siblings.length}</span>
          <button className="tb-btn" onClick={() => nav(1)} title="下一个"><IconChevron /></button>
          <span className="ellipsis preview-nav-name">{basename(path)}</span>
        </div>
      )}
      <div className="preview-body">
        <PreviewContent
          path={path}
          onEdit={() => openWindow('editor', { path, name: basename(path) })}
        />
      </div>
      <div className="preview-actions">
        <button className="btn btn-small" onClick={() => window.open(api.downloadUrl(path))}>下载</button>
        <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText('/' + path).then(() => notify({ title: '路径已复制' }))}>复制路径</button>
      </div>
    </div>
  );
}
