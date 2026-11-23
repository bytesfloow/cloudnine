import React, { useEffect, useRef, useState } from 'react';
import { useStore, resolveDialog, activateNotification, fmtSize } from '../store.js';
import { api } from '../api.js';

// 通知堆栈（桌面/移动共用）：登录页等早期阶段也需要展示 notify()
export function Notifications() {
  const s = useStore();
  if (!s.notifications.length) return null;
  return (
    <div className="notification-stack">
      {s.notifications.slice(-4).map((n) => (
        <div key={n.id} className={`notification n-${n.type}${n.onClick ? ' n-actionable' : ''}`} onClick={() => activateNotification(n.id)}>
          <div className="n-title">{n.title}</div>
          {n.body && <div className="n-body">{n.body}</div>}
          {n.actionLabel && <div className="n-action">{n.actionLabel} ›</div>}
        </div>
      ))}
    </div>
  );
}

export default function Dialogs() {
  const s = useStore();
  const dlg = s.dialog;

  // Esc 关闭最上层弹窗（docs §3.1：子菜单 → 菜单 → 开始菜单 → 弹窗逐级关闭）。
  // 表单弹窗由 FormBody 自己处理（它还要处理 Enter），这里兜底其余几类；
  // 「未保存的更改」三选一里 Esc 必须等价于「取消」，不能落到「不保存」。
  useEffect(() => {
    if (!dlg) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      resolveDialog(dlg.kind === 'confirm3' ? 'cancel' : null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dlg?.id]);

  if (!dlg) return null;
  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && dlg.kind !== 'confirm3') resolveDialog(null); }}>
      <div className={`dialog${dlg.wide ? ' wide' : ''}${dlg.kind === 'about' ? ' nameplate' : ''}`}>
        {dlg.title && <h3>{dlg.title}</h3>}
        {dlg.message && <p className="dialog-message">{dlg.message}</p>}
        {dlg.kind === 'confirm' && (
          <div className="dialog-actions">
            <button className="btn" onClick={() => resolveDialog(false)} autoFocus>{dlg.cancelText || '取消'}</button>
            <button className={`btn${dlg.danger ? ' btn-danger' : ' btn-primary'}`} onClick={() => resolveDialog(true)}>{dlg.okText || '好'}</button>
          </div>
        )}
        {dlg.kind === 'confirm3' && (
          <div className="dialog-actions three">
            <button className="btn" onClick={() => resolveDialog('cancel')} autoFocus>取消</button>
            <button className="btn btn-danger" onClick={() => resolveDialog('discard')}>不保存</button>
            <button className="btn btn-primary" onClick={() => resolveDialog('save')}>保存</button>
          </div>
        )}
        {dlg.kind === 'paste-choice' && (
          <div className="dialog-actions three">
            <button className="btn" onClick={() => resolveDialog(null)} autoFocus>取消</button>
            <button className="btn" onClick={() => resolveDialog('upload')}>{dlg.uploadText || '上传系统文件'}</button>
            <button className="btn btn-primary" onClick={() => resolveDialog('internal')}>{dlg.internalText || '粘贴内部文件'}</button>
          </div>
        )}
        {dlg.kind === 'form' && <FormBody dlg={dlg} />}
        {dlg.kind === 'about' && <AboutBody />}
      </div>
    </div>
  );
}

function FormBody({ dlg }) {
  const [values, setValues] = useState(() => {
    const v = {};
    dlg.fields.forEach((f) => { v[f.key] = f.value ?? (f.type === 'checkbox' ? false : ''); });
    return v;
  });
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') resolveDialog(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function submit() {
    for (const f of dlg.fields) {
      if (f.required && !String(values[f.key] ?? '').trim()) {
        setError(`请填写${f.label}`);
        return;
      }
    }
    resolveDialog(values);
  }

  return (
    <>
      <div className="form-fields">
        {dlg.fields.map((f) => (
          <label key={f.key} className={`field field-${f.type}`}>
            {f.type !== 'checkbox' && <span>{f.label}</span>}
            {f.type === 'select' ? (
              <select value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'checkbox' ? (
              <span className="check-row">
                <input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))} />
                <span>{f.label}</span>
              </span>
            ) : f.type === 'textarea' ? (
              <textarea rows={4} value={values[f.key]} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <input
                type={f.type || 'text'}
                value={values[f.key]}
                placeholder={f.placeholder}
                autoFocus={f.autofocus}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
      </div>
      {error && <p className="auth-err">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" onClick={() => resolveDialog(null)}>取消</button>
        <button className={`btn btn-primary${dlg.danger ? ' btn-danger' : ''}`} onClick={submit}>{dlg.okText || '好'}</button>
      </div>
    </>
  );
}

function AboutBody() {
  const s = useStore();
  const [sys, setSys] = useState(null);
  const [meta, setMeta] = useState(null);
  const [mounts, setMounts] = useState([]);
  const [running, setRunning] = useState(null);
  const [copied, setCopied] = useState('');
  const copiedTimer = useRef(null);

  // 只在弹窗挂载期间轮询 /api/system：关闭 = 卸载 = 定时器清掉，
  // 绝不把「看一次关于」变成服务端常驻轮询源。
  // 未登录时不发请求（入口在登录后的开始菜单，这里再加一道，防止被登录页复用后刷 401）。
  useEffect(() => {
    if (!s.user) return undefined;
    let alive = true;
    const pull = () => api.system().then((v) => { if (alive) setSys(v); }).catch(() => {});
    pull();
    const timer = setInterval(pull, 4000);
    api.about().then((m) => { if (alive) setMeta(m); }).catch(() => {});
    api.disk().then((d) => { if (alive) setMounts(d.mounts || []); }).catch(() => {});
    api.jobs().then((j) => { if (alive) setRunning((j.jobs || []).filter((x) => x.status === 'running').length); }).catch(() => {});
    return () => { alive = false; clearInterval(timer); clearTimeout(copiedTimer.current); };
  }, [s.user]);

  // 文件根目录所在分区（mountRel 为空）优先，否则按路径前缀匹配，再退到第一块盘
  const mount = pickMount(mounts, meta?.fileRoot);
  const up = uptimeParts(sys?.uptimeSec);
  const startedAt = sys?.startedAt ? Date.parse(sys.startedAt) : 0;
  const memPct = sys?.os?.totalmem ? Math.min(100, (sys.rss / sys.os.totalmem) * 100) : 0;
  const diskPct = mount?.usePct ?? 0;
  const dbOk = !s.dbDamaged;

  async function copy(key, value) {
    if (!value || value === '—') return;
    const text = String(value);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // 纯 http 局域网不是安全上下文，navigator.clipboard 直接不可用 —— 退回 execCommand
      ok = legacyCopy(text);
    }
    if (!ok) return;
    setCopied(key);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(''), 1200);
  }

  const metaItems = [
    { key: 'commit', k: 'commit', v: sys?.commit || '—' },
    { key: 'node', k: 'node', v: sys?.nodeVersion || '—' },
    { key: 'platform', k: 'platform', v: platformLabel(sys?.platform) },
    { key: 'root', k: '根目录', v: meta?.fileRoot || '—' },
    { key: 'port', k: '端口', v: meta?.port ? String(meta.port) : '—' },
  ];

  return (
    <>
      <button type="button" className="np-close" aria-label="关闭" onClick={() => resolveDialog(null)}>
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
          <path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      <div className="np-body">
        <div className="np-left">
          <StackMark />
          <div className="np-name">{s.siteName || 'CloudNine'}</div>
          <div className="np-ver">v{s.version || '0.0.0'}</div>
          <p className="np-tag">自托管单用户云桌面<br />一个端口，管好整台机器</p>
          <div className="np-links">
            <a href="https://github.com/bytesfloow/cloudnine/tree/main/docs" target="_blank" rel="noreferrer">文档</a>
            <span className="np-sep" aria-hidden="true">·</span>
            <a href="https://github.com/bytesfloow/cloudnine" target="_blank" rel="noreferrer">GitHub</a>
            <span className="np-sep" aria-hidden="true">·</span>
            <a href="https://github.com/bytesfloow/cloudnine/blob/main/LICENSE" target="_blank" rel="noreferrer">License</a>
          </div>
        </div>

        <div className="np-grid">
          <div className="np-cell np-uptime">
            <div className="np-label">运行时长</div>
            <div className="np-value" data-value={sys?.uptimeSec ?? ''}>{sys ? fmtUptime(up) : '—'}</div>
            <div className="np-sub">
              {sys ? `启动于 ${fmtStartedAt(startedAt)} · ${fmtClock(up)}` : '读取中…'}
            </div>
          </div>

          <div className="np-cell np-mem">
            <div className="np-label">内存 · RSS</div>
            <div className="np-value">{sys ? fmtSize(sys.rss) : '—'}</div>
            <div className="np-bar">{sys && <div className="np-fill" style={{ width: `${Math.max(memPct, 0.6)}%` }} />}</div>
            <div className="np-sub">
              {sys ? `占系统 ${memPct < 0.1 ? '<0.1' : memPct.toFixed(1)}% · 堆 ${fmtSize(sys.heapUsed)}` : '读取中…'}
            </div>
          </div>

          <div className="np-cell np-storage">
            <div className="np-label">存储{mount ? ` · ${mountLabel(mount)}` : ''}</div>
            <div className="np-value">
              {mount ? fmtSize(mount.used) : '—'}
              <span className="np-of">/ {mount ? fmtSize(mount.total) : '—'}</span>
            </div>
            <div className="np-bar">
              {mount && <div className={`np-fill${diskPct >= 90 ? ' danger' : diskPct >= 75 ? ' warn' : ''}`} style={{ width: `${Math.max(diskPct, 0.6)}%` }} />}
            </div>
            <div className="np-sub">{mount ? `已用 ${diskPct}%` : '读取中…'}</div>
          </div>

          <div className="np-cell np-health">
            <div className="np-label">健康</div>
            <div className="np-value"><span className={`np-dot${dbOk ? '' : ' bad'}`} />{dbOk ? '正常' : '降级'}</div>
            <div className="np-sub">
              {running == null ? '后台任务 —' : `${running} 个后台任务`} · {dbOk ? '数据库就绪' : '数据库只读'}
            </div>
          </div>
        </div>
      </div>

      <div className="np-meta">
        {metaItems.map((it) => (
          <button
            type="button"
            key={it.key}
            className={`np-meta-item${it.key === 'root' ? ' np-meta-root' : ''}${copied === it.key ? ' is-copied' : ''}`}
            title={`${it.v}（点击复制）`}
            onClick={() => copy(it.key, it.v)}
          >
            <span className="np-meta-k">{it.k}</span>
            <span className="np-meta-v">{it.v}</span>
            {copied === it.key && <span className="np-copied">已复制</span>}
          </button>
        ))}
      </div>
    </>
  );
}

// 老式复制兜底：http 局域网（非安全上下文）下没有 navigator.clipboard
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// 自绘标识「三扇窗」：叠放的三扇窗口 = 一整套桌面；最前面那扇做成强调色实底，
// 标题条 + 一颗端口亮点 = 这台机器上唯一开着的会话。纯几何 SVG，不借图标库，也不拟物。
function StackMark() {
  return (
    <svg className="np-mark" width="44" height="44" viewBox="0 0 48 48" fill="none" role="img" aria-label="CloudNine 标识">
      <g stroke="currentColor" strokeLinejoin="round" strokeLinecap="round">
        <rect x="16" y="6" width="25" height="18" rx="4.5" strokeWidth="2.2" opacity=".5" />
        <path d="M20 10.8h8.5" strokeWidth="2" opacity=".5" />
        <rect x="11" y="13" width="26" height="19" rx="4.5" strokeWidth="2.2" opacity=".85" />
        <path d="M15 17.8h9" strokeWidth="2" opacity=".85" />
      </g>
      <rect x="5.5" y="21.5" width="31" height="20.5" rx="5.5" fill="var(--accent)" />
      {/* 前景窗口的标题条：整条浅色带，20px 下收缩成一条高光，仍能读成「窗口」 */}
      <path d="M11 21.5h20a5.5 5.5 0 0 1 5.5 5.5H5.5A5.5 5.5 0 0 1 11 21.5z" fill="var(--on-accent)" opacity=".22" />
      <circle cx="30.5" cy="32.4" r="3.4" fill="var(--on-accent)" />
    </svg>
  );
}

const two = (n) => String(n).padStart(2, '0');

function uptimeParts(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

// 粗档「3 天 4 小时」；不足一小时才落到分秒，避免小数值看起来像没算
function fmtUptime({ d, h, m, s: sec }) {
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${sec} 秒`;
}

// 精确到秒的同一份时长，用于副行（轮询时看得见在走）
function fmtClock({ d, h, m, s: sec }) {
  if (d > 0) return `${d}天 ${two(h)}:${two(m)}:${two(sec)}`;
  if (h > 0) return `${h}:${two(m)}:${two(sec)}`;
  return `${m}:${two(sec)}`;
}

// 只到「月-日 时:分」：整格的副行只有约 150px，带年份会把秒表挤成省略号
function fmtStartedAt(ms) {
  if (!ms) return '—';
  const t = new Date(ms);
  return `${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
}

// 挂载点用于展示时去掉尾部分隔符：「C:\」→「C:」，Linux 根目录仍显示「/」
function mountLabel(m) {
  return String(m?.mount || '').replace(/[\\/]+$/, '') || '/';
}

function pickMount(mounts, root) {
  if (!mounts.length) return null;
  const exact = mounts.find((m) => m.mountRel === '');
  if (exact) return exact;
  if (root) {
    const hit = mounts
      .filter((m) => m.mount && (root === m.mount || root.startsWith(/[\\/]$/.test(m.mount) ? m.mount : `${m.mount}/`)))
      .sort((a, b) => b.mount.length - a.mount.length)[0];
    if (hit) return hit;
  }
  return mounts[0];
}

function platformLabel(p) {
  if (!p) return '—';
  if (p === 'win32') return 'Windows';
  if (p === 'darwin') return 'macOS';
  if (p === 'linux') return 'Linux';
  return p;
}
