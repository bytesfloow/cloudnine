// 写系统剪贴板：异步 Clipboard API 优先，不可用退回 execCommand('copy')。
//
// 为什么必须留着 execCommand 这条路：生产入口是 http://<局域网IP>，不是安全上下文，
// Chrome 在那里的 navigator.clipboard 直接是 undefined。只写 API 的结果是「本机 localhost
// 能用、实际部署不能用」，所以这里永远是「先试 API，失败再走老路」。
// 读没有等价的兜底（execCommand('paste') 对网页内容禁用），见 windows/termClipboard.js。

// 老式复制兜底：临时 textarea + execCommand。需要调用发生在用户手势里（按键/点击）。
export function legacyCopy(text) {
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

// 返回是否写入成功（失败不抛，调用方负责提示）
export async function writeClipboard(text) {
  const t = String(text ?? '');
  if (!t) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch { /* 非安全上下文 / 无权限 / 文档未聚焦 → 走兜底 */ }
  }
  return legacyCopy(t);
}
