import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { useStore, bus, getState, setWindowTitle, updateWindowProps, markDirty, confirmDialog, promptDialog, notify, basename, dirname, joinPath, fmtSize, extname } from '../store.js';
import { api } from '../api.js';
import WindowMenu from './WindowMenu.jsx';
import EditorSkeleton from './EditorSkeleton.jsx';

// 文件写盘成功后通知同页其它视图刷新；格式切换/另存为可能同时影响旧、新两个目录
function notifyFileChanged(...paths) {
  const dirs = new Set(paths.filter((p) => p != null).map((p) => dirname(String(p))));
  dirs.forEach((dir) => bus.emit('fs:changed', dir));
}

// langExtension：按扩展名懒加载对应的语言包。
// 以前这里把 14 个语言包全部静态 import，整块编辑器 chunk 被撑到 1.17MB(gzip 398KB)；
// 而一次只有一种文件类型，等于每次打开都把用不到的十几个语言包一起下载 + 解析。
// 现在改成 dynamic import：只有真正要用的那一个语言包会离开主 chunk。
// 返回 Promise<Extension|null>，null = 纯文本（不高亮）。
function langExtension(e) {
  switch (e) {
    case 'js': case 'mjs': case 'cjs': return import('@codemirror/lang-javascript').then((m) => m.javascript());
    case 'jsx': return import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true }));
    case 'ts': return import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true }));
    case 'tsx': return import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true }));
    case 'json': return import('@codemirror/lang-json').then((m) => m.json());
    case 'yaml': case 'yml': case 'toml': return import('@codemirror/lang-yaml').then((m) => m.yaml());
    case 'md': case 'markdown': return import('@codemirror/lang-markdown').then((m) => m.markdown());
    case 'py': return import('@codemirror/lang-python').then((m) => m.python());
    case 'html': case 'htm': case 'xml': case 'vue': case 'svg': return import('@codemirror/lang-html').then((m) => m.html());
    case 'css': return import('@codemirror/lang-css').then((m) => m.css());
    case 'sql': return import('@codemirror/lang-sql').then((m) => m.sql());
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': return import('@codemirror/lang-cpp').then((m) => m.cpp());
    case 'java': return import('@codemirror/lang-java').then((m) => m.java());
    case 'go': return import('@codemirror/lang-go').then((m) => m.go());
    case 'php': return import('@codemirror/lang-php').then((m) => m.php());
    case 'rs': return import('@codemirror/lang-rust').then((m) => m.rust());
    default: return Promise.resolve(null);
  }
}

// 本期支持切换的文件格式
const FORMATS = ['md', 'json', 'html', 'txt'];
const FMT_LABELS = { md: 'Markdown', json: 'JSON', html: 'HTML', txt: '纯文本' };

// 由文件名推断格式（htm/xhtml→html、markdown→md、无扩展名→txt）
function fmtOf(name) {
  const e = extname(name);
  if (e === 'htm' || e === 'xhtml') return 'html';
  if (e === 'markdown') return 'md';
  return e || 'txt';
}

// 替换/追加扩展名
function withExt(name, fmt) {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name) + '.' + fmt;
}

export default function EditorWindow({ win }) {
  // 本地路径覆盖：改名（格式切换/另存为）后立即指向新文件，不依赖外部 props 回流（移动端 props 为本地 state 不会更新）
  const [loc, setLoc] = useState(null); // { path, name }
  const path = loc?.path ?? win.props.path;
  const name = loc?.name ?? win.props.name;
  const s = useStore();
  const [doc, setDoc] = useState('');
  const [savedDoc, setSavedDoc] = useState('');
  const [meta, setMeta] = useState({}); // mtimeMs, encoding, size, truncated
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [fmt, setFmtState] = useState(() => (win.props.name ? fmtOf(win.props.name) : 'md')); // 新建文档默认 Markdown
  const [fmtMenu, setFmtMenu] = useState(false);
  // 当前语言包（懒加载）：null = 纯文本 / 还在路上。先出壳建编辑器，语言包到了再配上，
  // 不把「打开窗口」卡在一个语言包的下载上。
  const [langExt, setLangExt] = useState(null);
  // 左下角状态：平时空白；有改动常驻「未保存」；保存成功才闪「已保存」2 秒
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef(null);
  const savingRef = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const dirty = doc !== savedDoc && !loading;

  // 待落盘的格式切换：文件已在磁盘 且 当前格式 ≠ 打开时的扩展名格式
  const fmtPending = !!path && fmt !== fmtOf(name);

  function setFmt(f) { setFmtState(f); setFmtMenu(false); }

  useEffect(() => () => clearTimeout(flashTimer.current), []);
  useEffect(() => {
    if (dirty) {
      clearTimeout(flashTimer.current);
      if (savedFlash) setSavedFlash(false);
    } else if (savedFlash) {
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2000);
    }
  }, [dirty, savedFlash]);

  useEffect(() => { setWindowTitle(win.id, `${dirty ? '● ' : ''}${name || '未命名'}`); markDirty(win.id, dirty); }, [dirty, name, win.id]);
  useEffect(() => () => markDirty(win.id, false), [win.id]);
  useEffect(() => { updateWindowProps(win.id, { path }); }, [path]);
  useEffect(() => { updateWindowProps(win.id, { fmt }); }, [fmt]);
  // 文件名变化（格式保存/另存为）后，重置当前格式与菜单状态；未命名（新建）保持默认 md
  useEffect(() => { if (!name) return; setFmtState(fmtOf(name)); setFmtMenu(false); }, [name]);
  // 点击其他区域关闭格式菜单
  useEffect(() => {
    if (!fmtMenu) return;
    const close = () => setFmtMenu(false);
    const t = setTimeout(() => document.addEventListener('click', close), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', close); };
  }, [fmtMenu]);

  // 主动切换文件指向（格式保存/另存为）时跳过重新加载，保留当前编辑缓冲
  const skipLoadRef = useRef(false);
  useEffect(() => {
    if (skipLoadRef.current) { skipLoadRef.current = false; return; }
    if (!path) { setLoading(false); return; }
    setLoading(true);
    api.read(path).then((r) => {
      setDoc(r.content);
      setSavedDoc(r.content);
      setMeta({ mtimeMs: r.mtimeMs, encoding: r.encoding, size: r.size, truncated: r.truncated });
      setLoading(false);
    }).catch((e) => { setError(e.message); setLoading(false); });
  }, [path]);

  function followTarget(target, targetName) {
    skipLoadRef.current = true;
    setLoc({ path: target, name: targetName });
    updateWindowProps(win.id, { path: target, name: targetName });
  }

  // 保存（菜单 / Ctrl+S / 关闭前）。格式已切换时先重命名扩展名，再写入内容
  // 返回 true=已保存 / false=失败或取消（关闭窗口流程据此决定是否关闭）
  async function save(force = false, skipRename = false) {
    if (savingRef.current) return false;
    if (!path) return await saveAs();
    savingRef.current = true;
    try {
      let target = path;
      let targetName = name;
      if (fmtPending && !skipRename) {
        target = withExt(path, fmt);
        targetName = basename(target);
        try {
          await api.rename(path, targetName); // 目标已存在时服务端报 409
        } catch (e) {
          notify({ type: 'error', title: '格式切换失败', body: e.message });
          return false;
        }
      }
      try {
        const r = await api.write({ path: target, content: docRef.current, baseMtimeMs: meta.mtimeMs, force });
        if (target !== path) followTarget(target, targetName);
        setSavedDoc(docRef.current);
        setMeta((m) => ({ ...m, mtimeMs: r.mtimeMs, size: r.size }));
        setSavedFlash(true);
        notifyFileChanged(path, target);
        return true;
      } catch (e) {
        // 已重命名但写入失败：编辑器跟随新文件，避免指向已不存在的旧路径
        if (target !== path) followTarget(target, targetName);
        if (e.code === 'conflict') {
          const ok = await confirmDialog({
            title: '文件已在外部变更',
            message: '该文件可能已被终端或其他设备修改。直接保存将覆盖外部更改。',
            danger: true, okText: '覆盖保存', cancelText: '取消',
          });
          if (ok) return await save(true, true);
          return false;
        } else {
          notify({ type: 'error', title: '保存失败', body: e.message });
          return false;
        }
      }
    } finally {
      savingRef.current = false;
    }
  }

  // Ctrl+S 保存 / Ctrl+Shift+S 另存为：捕获阶段拦截，编辑器内输入时同样生效，并阻止浏览器默认保存对话框
  const saveRef = useRef(() => {});
  saveRef.current = save;
  const saveAsRef = useRef(() => {});
  saveAsRef.current = saveAs;
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey && !e.altKey && String(e.key).toLowerCase() === 's') {
        const st = getState();
        if (st.focusId && st.focusId !== win.id) return; // 仅当前焦点窗口响应
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) saveAsRef.current();
        else saveRef.current();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [win.id]);

  // 要点亮语言包时才去拉：一种文件类型只下载它自己的那一份，切格式会跟着换
  useEffect(() => {
    let alive = true;
    setLangExt(null);
    langExtension(fmt).then((ext) => { if (alive) setLangExt(ext); }).catch(() => { if (alive) setLangExt(null); });
    return () => { alive = false; };
  }, [fmt]);
  // 熊数组每次渲染都是新对象，会让 @uiw/react-codemirror 每帧重配一次编辑器；只跟着语言包变
  const cmExtensions = useMemo(() => [langExt, EditorView.lineWrapping].filter(Boolean), [langExt]);

  // 格式化：JSON 重排缩进；HTML 用 js-beautify 美化
  // js-beautify（184KB）只有真的点「格式化」处理 HTML 时才需要，按需加载，不进编辑器主 chunk
  async function formatDoc() {
    if (meta.truncated || (fmt !== 'json' && fmt !== 'html')) return;
    const text = docRef.current;
    try {
      let out;
      if (fmt === 'json') {
        out = JSON.stringify(JSON.parse(text), null, 2);
        if (/\n$/.test(text)) out += '\n';
      } else {
        const beautify = (await import('js-beautify')).default;
        out = beautify.html(text, { indent_size: 2, wrap_line_length: 0, preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: /\n$/.test(text) });
      }
      setDoc(out);
    } catch (e) {
      notify({ type: 'error', title: '格式化失败', body: e.message });
    }
  }

  useEffect(() => bus.on('editor-save', async ({ windowId, done }) => {
    if (windowId !== win.id) return;
    const ok = await save();
    done?.(ok);
  }), [win.id, meta.mtimeMs, path, name, fmt]);
  useEffect(() => bus.on('win-action', ({ windowId, action }) => {
    if (windowId !== win.id) return;
    if (action === 'save') save();
    else if (action === 'saveAs') saveAs();
    else if (action === 'format') formatDoc();
    else if (action === 'find') notify({ type: 'info', title: '使用 Ctrl + F 打开查找替换' });
  }), [win.id, meta.mtimeMs, path, name, fmt]);

  // 另存为。返回 true=已保存 / false=取消或失败
  async function saveAs() {
    const defName = name ? withExt(name, fmt) : `未命名.${fmt}`;
    const v = await promptDialog({
      title: '另存为',
      fields: [{ key: 'p', label: '目标路径', value: path || joinPath(getState().homeRel || '', defName), autofocus: true }],
      okText: '保存',
    });
    if (!v?.p) return false;
    const target = String(v.p).replace(/^\/+|\/+$/g, '');
    try {
      await api.write({ path: target, content: docRef.current });
      followTarget(target, basename(target));
      setSavedDoc(docRef.current);
      setSavedFlash(true);
      notifyFileChanged(path, target);
      return true;
    } catch (e) { notify({ type: 'error', title: '另存为失败', body: e.message }); return false; }
  }

  // 首次打开：先出壳（窗口内菜单 + 骨架 + 状态栏），chunk / 文件内容到位再换成编辑器
  if (loading) return <EditorSkeleton label="正在读取文件" />;
  if (error) return <div className="editor-window"><div className="finder-empty"><p>⚠️ {error}</p></div></div>;

  const dark = s.theme === 'dark' || (s.theme === 'auto' && document.documentElement.dataset.theme === 'dark');

  // 窗口内菜单（§1.6 / §2.1.4）：与文件命令栏 / 终端标签菜单走同一条 win-action 通道
  const act = (action) => bus.emit('win-action', { windowId: win.id, action });
  const fileMenu = [
    { label: '保存', hint: 'Ctrl+S', action: () => act('save') },
    { label: '另存为…', hint: 'Ctrl+Shift+S', action: () => act('saveAs') },
    '-',
    { label: '关闭窗口', hint: 'Ctrl+W', action: () => act('closeWin') },
  ];
  // 格式化只对 json / html 出现（与状态栏按钮同一条件）；截断的只读预览没有意义
  const editMenu = [
    ...(fmt === 'json' || fmt === 'html'
      ? [{ label: '格式化', disabled: !!meta.truncated, action: () => act('format') }, '-']
      : []),
    { label: '查找…', hint: 'Ctrl+F', action: () => act('find') },
  ];

  return (
    <div className="editor-window">
      {meta.truncated && <div className="editor-banner">文件较大，仅显示前一部分（只读预览）。请下载后查看完整内容。</div>}
      <div className="editor-winmenu" role="group" aria-label="记事本菜单">
        <WindowMenu label="文件" title="文件" items={fileMenu} />
        <WindowMenu label="编辑" title="编辑" items={editMenu} />
      </div>
      <div className="editor-cm">
        <CodeMirror
          value={doc}
          theme={dark ? oneDark : 'light'}
          extensions={cmExtensions}
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
        <span className={`es-state${dirty ? ' editor-dirty' : savedFlash ? ' saved' : ''}`}>{dirty ? '未保存' : savedFlash ? '已保存' : ''}</span>
        <span>{cursor.line}:{cursor.col}</span>
        <div className="editor-fmt">
          <button
            className={`editor-fmt-chip${fmtPending ? ' pending' : ''}`}
            title={`当前格式：${FMT_LABELS[fmt] || fmt}${fmtPending ? '（保存时生效）' : ''}`}
            disabled={meta.truncated}
            onClick={(e) => { e.stopPropagation(); setFmtMenu((v) => !v); }}
          >{fmt}</button>
          {fmtMenu && (
            <div className="editor-fmt-menu" onClick={(e) => e.stopPropagation()}>
              {FORMATS.map((f) => (
                <button key={f} className={`editor-fmt-item${f === fmt ? ' active' : ''}`} onClick={() => setFmt(f)}>
                  <span>{FMT_LABELS[f]}</span>
                  <span className="editor-fmt-ext mono">.{f}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="es-enc">{meta.encoding || 'utf-8'}</span>
        <span className="es-size">{fmtSize(meta.size)}</span>
        {(fmt === 'json' || fmt === 'html') && !meta.truncated && <button className="btn btn-small" onClick={formatDoc}>格式化</button>}
        <button className="btn btn-small" onClick={() => save()}>保存</button>
        <button className="btn btn-small" onClick={saveAs}>另存为</button>
      </div>
    </div>
  );
}
