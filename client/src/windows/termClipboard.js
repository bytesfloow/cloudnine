import { notify, confirmDialog, promptDialog } from '../store.js';
import { writeClipboard } from '../clipboard.js';

// 终端剪贴板：Ctrl+Shift+C / Ctrl+Shift+V、右键菜单、移动端「粘贴」键共用这一份实现。
//
// 为什么不按常规直接 navigator.clipboard.readText：
//   生产入口是 http://<局域网IP>，非安全上下文里整个 navigator.clipboard 都不存在，
//   而且没有任何 API 兜底 —— execCommand('paste') 对网页内容是禁用的。能读剪贴板的
//   合法通道只有两条：
//     1) 浏览器原生 paste 事件（用户按 Ctrl+Shift+V / Shift+Insert / 系统右键菜单粘贴时，
//        Chrome 把剪贴板内容放进 event.clipboardData）—— 主路径，零打扰；
//     2) 一个真实 textarea 里的粘贴（用户在输入框里按 Ctrl+V / 手机长按选「粘贴」）
//        —— 没有按键可等的入口（右键菜单、移动端按钮）在非安全上下文下走这条。
//   写剪贴板有 execCommand('copy') 兜底，见 clipboard.js。

// 读剪贴板：返回字符串（可能是 ''）；返回 null 表示这个环境根本没有读能力，调用方另想辙。
// 只给「没有原生 paste 事件可用」的入口（右键菜单 / 移动端按钮）调用。
export async function readClipboardText() {
  const api = navigator.clipboard;
  if (!api || typeof api.readText !== 'function') return null;
  try {
    return await api.readText();
  } catch {
    // 无权限 / 文档未聚焦 / 非安全上下文里的半残实现，一律当成「读不到」
    return null;
  }
}

// 复制选中文本。1) 走 Clipboard API，2) 不行就用 execCommand —— 两条都在用户手势里触发。
export function copyTermSelection(term) {
  if (!term) return;
  const text = term.getSelection();
  if (!text) {
    notify({ type: 'info', title: '没有选中内容', body: '先在终端里划选要复制的文本' });
    return;
  }
  writeClipboard(text).then((ok) => {
    if (!ok) notify({ type: 'error', title: '复制失败', body: '浏览器拒绝了写剪贴板' });
  }).finally(() => term.focus());
}

// 把文本送进终端。多行先确认一次：直接执行一串命令很容易出事，而「取消」必须什么都不写，
// 所以确认框弹之前一个字节都不往 PTY 里发，取消后终端里不会残留半行。
export async function pasteTextToTerm(term, raw) {
  if (!term) return;
  const text = String(raw ?? '');
  if (!text) return;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1) {
    const ok = await confirmDialog({
      title: '粘贴多行内容',
      message: `剪贴板里有 ${lines.length} 行内容，确认后会一次性发送到终端。`,
      okText: '粘贴',
    });
    if (!ok) return;
  }
  // term.paste 会自己处理 \r\n → \r、以及 bracketed paste（shell 开了就先包一层再发）
  try {
    term.paste(text);
    term.focus();
  } catch { /* 确认框开着时窗口被关掉：term 已 dispose，忽略 */ }
}

// 没有原生 paste 事件的入口：先试 Clipboard API，读不到就弹一个只有 textarea 的粘贴框。
export async function pasteFromClipboard(term) {
  if (!term) return;
  const text = await readClipboardText();
  if (text === null) {
    const v = await promptDialog({
      title: '粘贴到终端',
      message: navigator.clipboard?.readText
        ? '浏览器没给读剪贴板的权限。请在下面按 Ctrl+V（手机长按输入框选「粘贴」），再点「粘贴」。'
        : '当前是 http 访问，浏览器不允许网页直接读剪贴板。请在下面按 Ctrl+V（手机长按输入框选「粘贴」），再点「粘贴」。',
      fields: [{ key: 'text', type: 'textarea', placeholder: '在这里按 Ctrl+V…', autofocus: true }],
      okText: '粘贴',
    });
    if (!v) return;
    await pasteTextToTerm(term, v.text);
    return;
  }
  if (!text) {
    notify({ type: 'info', title: '剪贴板里没有文本' });
    return;
  }
  await pasteTextToTerm(term, text);
}
