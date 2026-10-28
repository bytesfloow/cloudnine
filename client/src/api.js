// API 封装：所有请求携带 Cookie；401 时抛出 AuthError 由上层处理
export class AuthError extends Error {}

async function request(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body && !(opts.body instanceof FormData) && typeof opts.body === 'object' && !(opts.body instanceof Blob)
      ? { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      : opts.headers || {},
    ...opts,
    body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof Blob) && !(opts.body instanceof FormData)
      ? JSON.stringify(opts.body)
      : opts.body,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const e = new Error(data?.error || `请求失败（${res.status}）`);
    e.status = res.status;
    e.code = data?.code;
    if (res.status === 401) e.auth = true;
    throw e;
  }
  return data;
}

const post = (url, body, opts) => request(url, { method: 'POST', body, ...opts });

export const api = {
  // 认证
  state: () => request('/api/state'),
  init: (data) => post('/api/init', data),
  login: (data) => post('/api/login', data),
  logout: () => post('/api/logout'),
  changePassword: (data) => post('/api/account/password', data),
  about: () => request('/api/about'),

  // 文件系统
  list: (path) => request(`/api/fs/list?path=${encodeURIComponent(path)}`),
  stat: (path) => request(`/api/fs/stat?path=${encodeURIComponent(path)}`),
  mkdir: (path) => post('/api/fs/mkdir', { path }),
  touch: (path) => post('/api/fs/touch', { path }),
  rename: (path, newName) => post('/api/fs/rename', { path, newName }),
  move: (paths, dest, policy) => post('/api/fs/move', { paths, dest, policy }),
  copy: (paths, dest, policy) => post('/api/fs/copy', { paths, dest, policy }),
  trash: (paths) => post('/api/fs/trash', { paths }),
  deleteForever: (paths) => post('/api/fs/delete', { paths }),
  trashList: () => request('/api/fs/trash/list'),
  trashCount: () => request('/api/fs/trash/count'),
  trashRestore: (ids) => post('/api/fs/trash/restore', { ids }),
  trashEmpty: () => post('/api/fs/trash/empty'),
  trashDelete: (ids) => post('/api/fs/trash/delete', { ids }),
  chmod: (path, mode) => post('/api/fs/chmod', { path, mode }),
  chown: (path, uid, gid) => post('/api/fs/chown', { path, uid, gid }),
  read: (path, maxKB) => request(`/api/fs/read?path=${encodeURIComponent(path)}${maxKB ? `&maxKB=${maxKB}` : ''}`),
  write: (data) => post('/api/fs/write', data),
  search: (path, q) => request(`/api/fs/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`),
  recents: () => request('/api/fs/recent'),
  addRecent: (path, name) => post('/api/fs/recent', { path, name }),
  home: () => request('/api/fs/home'),

  // 上传
  uploadInit: (data) => post('/api/upload/init', data),
  uploadChunk: (id, blob) => request(`/api/upload/chunk/${id}`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } }),
  uploadFinish: (id) => post(`/api/upload/finish/${id}`),
  uploadAbort: (id) => post(`/api/upload/abort/${id}`),
  uploadStatus: (id) => request(`/api/upload/status/${id}`),

  // 下载
  downloadUrl: (path, inline) => `/api/download?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`,
  zipUrl: (paths) => `/api/download/zip?paths=${encodeURIComponent(JSON.stringify(paths))}`,

  // 磁盘 / 任务 / 压缩
  disk: () => request('/api/disk'),
  jobs: () => request('/api/jobs'),
  archiveCreate: (data) => post('/api/archive/create', data),
  archiveExtract: (data) => post('/api/archive/extract', data),
  archiveList: (path) => request(`/api/archive/list?path=${encodeURIComponent(path)}`),

  // 分享（管理端）
  shares: () => request('/api/shares'),
  shareCreate: (data) => post('/api/shares', data),
  shareUpdate: (id, data) => request(`/api/shares/${id}`, { method: 'PATCH', body: data }),
  shareDelete: (id) => request(`/api/shares/${id}`, { method: 'DELETE' }),
  sharesCleanup: () => post('/api/shares/cleanup'),
};
