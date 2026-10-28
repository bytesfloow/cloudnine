import React, { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';
import { php } from '@codemirror/lang-php';
import { rust } from '@codemirror/lang-rust';
import { useStore, bus, getState, setWindowTitle, updateWindowProps, markDirty, confirmDialog, promptDialog, notify, basename, joinPath, fmtSize, extname } from '../store.js';
import { api } from '../api.js';

function langExtension(name) {
  const e = extname(name);
  switch (e) {
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'jsx': return javascript({ jsx: true });
    case 'ts': return javascript({ typescript: true });
    case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'json': return json();
    case 'yaml': case 'yml': case 'toml': return yaml();
    case 'md': case 'markdown': return markdown();
    case 'py': return python();
    case 'html': case 'htm': case 'xml': case 'vue': case 'svg': return html();
    case 'css': return css();
    case 'sql': return sql();
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': return cpp();
    case 'java': return java();
    case 'go': return go();
    case 'php': return php();
    case 'rs': return rust();
    default: return [];
  }
}

export default function EditorWindow({ win }) {
  const { path, name } = win.props;
  const s = useStore();
  const [doc, setDoc] = useState('');
  const [savedDoc, setSavedDoc] = useState('');
  const [meta, setMeta] = useState({}); // mtimeMs, encoding, size, truncated
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const savingRef = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const dirty = doc !== savedDoc && !loading;

  useEffect(() => { setWindowTitle(win.id, `${dirty ? '● ' : ''}${name || '未命名'}`); markDirty(win.id, dirty); }, [dirty, name, win.id]);
  useEffect(() => () => markDirty(win.id, false), [win.id]);
  useEffect(() => { updateWindowProps(win.id, { path }); }, [path]);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    setLoading(true);
    api.read(path).then((r) => {
      setDoc(r.content);
      setSavedDoc(r.content);
      setMeta({ mtimeMs: r.mtimeMs, encoding: r.encoding, size: r.size, truncated: r.truncated });
      setLoading(false);
    }).catch((e) => { setError(e.message); setLoading(false); });
  }, [path]);

  // 保存（菜单 / 快捷键 / 关闭前）
  async function save(force = false) {
    if (!path || savingRef.current) return;
    savingRef.current = true;
    try {
      const r = await api.write({ path, content: docRef.current, baseMtimeMs: meta.mtimeMs, force });
      setSavedDoc(docRef.current);
      setMeta((m) => ({ ...m, mtimeMs: r.mtimeMs, size: r.size }));
      notify({ type: 'success', title: '已保存', body: name });
    } catch (e) {
      if (e.code === 'conflict') {
        const ok = await confirmDialog({
          title: '文件已在外部变更',
          message: '该文件可能已被终端或其他设备修改。直接保存将覆盖外部更改。',
          danger: true, okText: '覆盖保存', cancelText: '取消',
        });
        if (ok) return save(true);
      } else {
        notify({ type: 'error', title: '保存失败', body: e.message });
      }
    } finally {
      savingRef.current = false;
    }
  }

  useEffect(() => bus.on('editor-save', ({ windowId }) => { if (windowId === win.id) save(); }), [win.id, meta.mtimeMs]);
  useEffect(() => bus.on('win-action', ({ windowId, action }) => {
    if (windowId !== win.id) return;
    if (action === 'save') save();
    else if (action === 'saveAs') saveAs();
    else if (action === 'find') notify({ type: 'info', title: '使用 Ctrl/Cmd + F 打开查找替换' });
  }), [win.id]);

  async function saveAs() {
    const v = await promptDialog({
      title: '另存为',
      fields: [{ key: 'p', label: '目标路径', value: path || joinPath(getState().homeRel || '', name || '未命名.txt'), autofocus: true }],
      okText: '保存',
    });
    if (!v?.p) return;
    const target = String(v.p).replace(/^\/+|\/+$/g, '');
    try {
      await api.write({ path: target, content: docRef.current });
      updateWindowProps(win.id, { path: target, name: basename(target) });
      setSavedDoc(docRef.current);
      notify({ type: 'success', title: '已另存为', body: target });
    } catch (e) { notify({ type: 'error', title: '另存为失败', body: e.message }); }
  }

  if (loading) return <div className="editor-window loading"><div className="boot-spinner" /></div>;
  if (error) return <div className="editor-window"><div className="finder-empty"><p>⚠️ {error}</p></div></div>;

  const dark = s.theme === 'dark' || (s.theme === 'auto' && document.documentElement.dataset.theme === 'dark');

  return (
    <div className="editor-window">
      {meta.truncated && <div className="editor-banner">文件较大，仅显示前一部分（只读预览）。请下载后查看完整内容。</div>}
      <div className="editor-cm">
        <CodeMirror
          value={doc}
          theme={dark ? oneDark : 'light'}
          extensions={[...[langExtension(name || '')].filter(Boolean), EditorView.lineWrapping]}
          basicSetup={{ foldGutter: true, highlightActiveLine: !meta.truncated }}
          editable={!meta.truncated}
          readOnly={meta.truncated}
          onChange={(v) => setDoc(v)}
          onUpdate={(u) => {
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              setCursor({ line: line.number, col: head - line.from + 1 });
            }
          }}
          height="100%"
          style={{ height: '100%' }}
        />
      </div>
      <div className="editor-statusbar">
        <span className="mono ellipsis">{path ? `/${path}` : '未命名'}</span>
        <span>{cursor.line}:{cursor.col}</span>
        <span>{meta.encoding || 'utf-8'}</span>
        <span>{fmtSize(meta.size)}</span>
        <span className={dirty ? 'editor-dirty' : ''}>{dirty ? '未保存' : '已保存'}</span>
        <button className="btn btn-small" onClick={() => save()}>保存</button>
        <button className="btn btn-small" onClick={saveAs}>另存为</button>
      </div>
    </div>
  );
}
