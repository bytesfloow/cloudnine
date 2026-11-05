import { api } from './api.js';
import { getState, setState, nextId, notify, fmtSize, basename } from './store.js';

// 分片上传引擎：队列 + 并发 2 + 断点续传 + 重试
const CHUNK = 4 * 1024 * 1024;
const CONCURRENCY = 2;
const RETRIES = 3;

export function addUpload(file, destDir, relativePath = '') {
  const item = {
    id: nextId(),
    name: relativePath ? relativePath : file.name,
    displayName: basename(relativePath || file.name),
    size: file.size,
    destDir,
    file,
    relativePath,
    uploaded: 0,
    status: 'pending', // pending|uploading|paused|done|error|canceled
    speed: 0,
    error: '',
    uploadId: null,
    finalPath: '',
  };
  setState((s) => ({ transfers: [item, ...s.transfers] }));
  pump();
  return item.id;
}

// 打开系统文件选择器并把选中文件加入上传队列（供访达工具栏/右键菜单与粘贴上传降级复用）
export function pickFiles(destDir, folder = false) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.webkitdirectory = true;
  input.onchange = () => {
    for (const f of input.files) addUpload(f, destDir, folder ? (f.webkitRelativePath || f.name) : '');
  };
  input.click();
}

export function pauseUpload(id) {
  const it = getState().transfers.find((x) => x.id === id);
  if (it && it.status === 'uploading') {
    it._abort?.abort();
    patch(id, { status: 'paused' });
  }
}
export function resumeUpload(id) {
  const it = getState().transfers.find((x) => x.id === id);
  if (it && (it.status === 'paused' || it.status === 'error')) {
    patch(id, { status: 'pending', error: '' });
    pump();
  }
}
export async function cancelUpload(id) {
  const it = getState().transfers.find((x) => x.id === id);
  if (!it) return;
  if (it.status === 'uploading') it._abort?.abort();
  if (it.uploadId) api.uploadAbort(it.uploadId).catch(() => {});
  patch(id, { status: 'canceled' });
  pump();
}
export function clearFinishedUploads() {
  setState((s) => ({ transfers: s.transfers.filter((x) => !['done', 'canceled'].includes(x.status)) }));
}

function patch(id, fields) {
  setState((s) => ({ transfers: s.transfers.map((x) => (x.id === id ? { ...x, ...fields } : x)) }));
}
function get(id) { return getState().transfers.find((x) => x.id === id); }

function pump() {
  const items = getState().transfers;
  const active = items.filter((x) => x.status === 'uploading').length;
  let slots = CONCURRENCY - active;
  for (const it of items) {
    if (slots <= 0) break;
    if (it.status === 'pending') { slots--; runItem(it); }
  }
}

async function runItem(it0) {
  const it = it0;
  patch(it.id, { status: 'uploading' });
  const ac = new AbortController();
  patch(it.id, { _abort: ac });

  let lastTime = Date.now();
  let lastBytes = 0;

  try {
    // init（断点续传：重用 uploadId）
    let offset = it.uploaded || 0;
    if (!it.uploadId) {
      const r = await api.uploadInit({
        destDir: it.destDir,
        name: it.displayName,
        size: it.size,
        relativePath: it.relativePath,
        policy: 'auto',
      });
      if (r.skip) { patch(it.id, { status: 'done', uploaded: it.size, finalPath: 'skipped' }); return pump(); }
      patch(it.id, { uploadId: r.uploadId, uploaded: r.offset });
      offset = r.offset;
    } else {
      const st = await api.uploadStatus(it.uploadId);
      offset = st.offset;
      patch(it.id, { uploaded: offset });
    }

    while (offset < it.size) {
      if (get(it.id)?.status !== 'uploading') return pump(); // 被暂停/取消
      const end = Math.min(offset + CHUNK, it.size);
      const blob = it.file.slice(offset, end);
      const r = await api.uploadChunk(it.uploadId, blob);
      offset = r.offset;
      const now = Date.now();
      const speed = (offset - lastBytes) / Math.max(0.2, (now - lastTime) / 1000);
      lastTime = now; lastBytes = offset;
      patch(it.id, { uploaded: offset, speed: it.size > CHUNK ? speed : 0 });
    }

    const fin = await api.uploadFinish(it.uploadId);
    patch(it.id, { status: 'done', uploaded: it.size, finalPath: fin.path, speed: 0 });
    notify({ type: 'success', title: '上传完成', body: it.displayName });
    const { bus } = await import('./store.js');
    bus.emit('fs:changed', it.destDir);
  } catch (e) {
    if (get(it.id)?.status === 'canceled') return pump();
    if (e.name === 'AbortError' || get(it.id)?.status === 'paused') return pump();
    const tries = (it._tries || 0) + 1;
    it._tries = tries;
    if (tries <= RETRIES && !['canceled'].includes(get(it.id)?.status)) {
      await new Promise((r) => setTimeout(r, 800 * tries));
      return runItem(get(it.id) || it);
    }
    patch(it.id, { status: 'error', error: e.message, speed: 0 });
    notify({ type: 'error', title: '上传失败', body: `${it.displayName}：${e.message}` });
  } finally {
    pump();
  }
}

export function uploadStats() {
  const items = getState().transfers;
  const active = items.filter((x) => x.status === 'uploading' || x.status === 'pending');
  return {
    activeCount: active.length,
    totalProgress: active.length
      ? Math.round(active.reduce((a, x) => a + (x.size ? Math.min(x.uploaded / x.size, 1) : 0), 0) / active.length * 100)
      : 0,
  };
}

export function fmtProgress(it) {
  const pct = it.size ? Math.min(100, Math.round((it.uploaded / it.size) * 100)) : (it.status === 'done' ? 100 : 0);
  return pct;
}
export const fmtUploaded = (it) => `${fmtSize(it.uploaded)} / ${fmtSize(it.size)}`;
