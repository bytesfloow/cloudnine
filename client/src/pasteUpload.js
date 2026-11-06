import { getState, bus, notify, setClipboard, confirmDialog, showDialog } from './store.js';
import { addUpload, pickFiles, notifyTransfer } from './transfers.js';

// F-09a 粘贴上传：把系统剪贴板里复制的文件，通过 Ctrl+V 上传到「当前文件夹」。
//
// 能力边界（必须实测，见 scripts/paste-probe.html）：
//   Chrome/Edge 会在 paste 事件的 clipboardData.files 里给出 File（CF_HDROP → isolated filesystem）；
//   Firefox/Safari 不给，且异步 Clipboard API 也读不到系统剪贴板的文件列表，因此后者只做降级：
//   提示 + 打开上传选择器（目标目录已预填）。不引入扩展/本地客户端。

const CONFIRM_COUNT = 20;                  // 超过则二次确认
const CONFIRM_SIZE = 100 * 1024 * 1024;   // 单文件 >100MB 二次确认（仅防误操作，非服务端上限）
const NOTICE_COUNT = 50;                   // 超过则额外提示「已入队」
const DEDUPE_MS = 1500;                    // 屏蔽键盘连发导致的重复粘贴

// 浏览器对剪贴板位图（截图）给的 File.name 通常是 image.png 这类占位名
const PLACEHOLDER_NAME = /^(image|paste|clipboard|screenshot|snip)[\w-]*\.(png|jpe?g|gif|webp|bmp)$/i;

let hintedFallback = false;
let lastKey = '';
let lastAt = 0;

function isChromium() {
  const brands = navigator.userAgentData?.brands;
  if (brands?.length) return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(b.brand));
  const ua = navigator.userAgent || '';
  return /Edg\/|Chrome\/|Chromium\//.test(ua) && !/Firefox\/|FxiOS\//.test(ua);
}

// 输入框 / 终端 / 编辑器 / 弹窗 / 菜单里按 Ctrl+V 必须保持原义，不接管
function isEditableTarget(t) {
  if (!t || !t.tagName) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    || !!t.closest('.xterm, .cm-editor, .dialog, .dropdown, .popover, .context-menu');
}

// 目标目录：激活访达窗口的 cwd；无窗口 / 焦点在桌面 → 主目录（Q12）。
// 返回 null 表示「非访达窗口获得焦点」，这种情况不接管。
function pasteTarget() {
  const s = getState();
  const win = s.windows.find((w) => w.id === s.focusId);
  if (win && win.type !== 'finder') return null;
  if (win) {
    const p = win.props || {};
    if (p.pasteBlocked) return { blocked: p.pasteBlocked };
    return { dir: p.cwd || '', windowId: win.id };
  }
  return { dir: s.homeRel || '', windowId: null };
}

function imageExt(type) {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/svg+xml') return 'svg';
  return 'png';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 从资源管理器复制来的文件保留原名；剪贴板位图（截图）生成「粘贴图片-时间戳.png」。
// 统一只遍历 clipboardData.files，不再遍历 items，避免截图被上传两次。
function normalizeFile(f, i, total) {
  const name = f.name || '';
  const placeholder = !name || PLACEHOLDER_NAME.test(name);
  if (!placeholder) return f;
  const suffix = total > 1 ? `-${i + 1}` : '';
  if (!String(f.type || '').startsWith('image/')) {
    return new File([f], `粘贴文件-${stamp()}${suffix}`, { type: f.type || 'application/octet-stream' });
  }
  return new File([f], `粘贴图片-${stamp()}${suffix}.${imageExt(f.type)}`, { type: f.type, lastModified: Date.now() });
}

function fallback(dir, reason) {
  notify({
    type: 'info',
    title: '无法直接粘贴文件',
    body: `${reason}。已打开上传对话框，目标目录：/${dir || ''}`,
    ms: 6000,
  });
  // 必须在用户手势（paste 事件）内同步调用；跨 await 后 input.click() 可能被浏览器拦截
  pickFiles(dir);
}

async function uploadFiles(files, target) {
  const dir = target.dir;
  const big = files.some((f) => f.size > CONFIRM_SIZE);
  if (files.length > CONFIRM_COUNT || big) {
    const ok = await confirmDialog({
      title: '确认粘贴上传',
      message: `即将把 ${files.length} 个文件（含大文件）上传到 /${dir || ''}，确定继续吗？`,
      okText: '开始上传',
    });
    if (!ok) return;
  }
  if (files.length > NOTICE_COUNT) {
    notifyTransfer({ type: 'info', title: '已加入上传队列', body: `${files.length} 个文件，按现有队列并发上传`, ms: 6000 });
  }
  const ready = files.map((f, i) => normalizeFile(f, i, files.length));
  for (const f of ready) addUpload(f, dir);
  // 一次成功的粘贴上传后清空内部剪贴板，避免后续 Ctrl+V 反复撞车
  setClipboard(null);
  // 点击「开始上传」通知可直接打开传输窗口查看进度（对齐文件选择器上传入口）
  notifyTransfer({ type: 'info', title: '开始上传', body: `${ready.length} 个文件 → /${dir || ''}`, ms: 3000 });
}

export function installPasteUpload() {
  const onPaste = async (e) => {
    const st = getState();
    // 模态层（确认框、二选一框、快速预览、右键菜单）打开时不接管，避免后台误触发上传
    if (!st.user || st.dialog || st.quickLook || st.contextMenu) return;
    if (isEditableTarget(e.target)) return;
    const d = e.clipboardData;
    if (!d) return;
    const target = pasteTarget();
    if (!target) return;

    const files = Array.from(d.files || []);
    const types = Array.from(d.types || []);
    const cb = getState().clipboard;

    if (files.length) {
      e.preventDefault();
      if (target.blocked) {
        notify({ type: 'error', title: '无法粘贴上传', body: `请先退出「${target.blocked}」视图，进入一个普通文件夹` });
        return;
      }
      const key = files.map((f) => `${f.name}:${f.size}`).join('|');
      const now = Date.now();
      if (key === lastKey && now - lastAt < DEDUPE_MS) return;
      lastKey = key; lastAt = now;

      // 内部剪贴板优先：两者同时存在时给二选一，默认动作交给用户明确选择
      if (target.windowId && cb) {
        const choice = await showDialog({
          kind: 'paste-choice',
          title: '粘贴到当前文件夹',
          message: `系统剪贴板里有 ${files.length} 个文件；系统内剪贴板里有 ${cb.paths?.length ?? 0} 项（${cb.mode === 'cut' ? '剪切' : '复制'}）。要执行哪一个？`,
          uploadText: `上传系统文件（${files.length}）`,
          internalText: `粘贴内部项（${cb.paths?.length ?? 0}）`,
        });
        if (choice === 'internal') {
          bus.emit('win-action', { windowId: target.windowId, action: 'paste' });
          return;
        }
        if (choice !== 'upload') return;
      }
      await uploadFiles(files, target);
      return;
    }

    // 没拿到文件：内部剪贴板优先，保持原有 Ctrl+V 行为不变（内部粘贴仍走菜单/右键）
    if (cb) return;
    const fileLike = types.some((t) => /^(Files|text\/uri-list)$/i.test(t));
    const hasContent = types.some((t) => !/^(Files|text\/uri-list)$/i.test(t));
    if (fileLike) {
      // Chromium 识别到剪贴板文件却没交出内容（版本差异 / 企业 DLP 策略）
      e.preventDefault();
      fallback(target.dir, '浏览器识别到剪贴板文件，但未交出文件内容');
      return;
    }
    if (!isChromium() && !hasContent && !hintedFallback) {
      // 非 Chromium 且这次粘贴没有任何文本/图片内容：Firefox 复制文件后粘贴即为此形态
      hintedFallback = true;
      e.preventDefault();
      fallback(target.dir, '当前浏览器不支持从系统剪贴板直接粘贴文件（建议使用 Chrome / Edge）');
    }
  };

  document.addEventListener('paste', onPaste);
  return () => document.removeEventListener('paste', onPaste);
}
