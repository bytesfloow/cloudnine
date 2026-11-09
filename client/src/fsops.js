// 桌面与「文件」窗口共用的文件操作。
// 桌面改为直接呈现主目录后，两处需要的能力完全一致，集中在这里避免行为分叉。
import {
  bus, notify, setClipboard, openWindow, openFile, promptDialog, confirmDialog,
  getState, basename, dirname, joinPath, fileCat,
} from './store.js';
import { api } from './api.js';
import { addUpload, pickFiles } from './transfers.js';

// ---------- 新建 / 上传 ----------

// 新建文件夹 / 空白文件；返回创建后的路径，取消或失败返回 null
export async function createItem(cwd, kind) {
  const isDir = kind === 'dir';
  const v = await promptDialog({
    title: isDir ? '新建文件夹' : '新建空白文件',
    fields: [{
      key: 'name', label: '名称', required: true, autofocus: true,
      placeholder: isDir ? '文件夹名称' : '文件名称.md',
    }],
  });
  if (!v?.name) return null;
  const p = joinPath(cwd, v.name);
  try {
    if (isDir) await api.mkdir(p); else await api.touch(p);
  } catch (e) {
    notify({ type: 'error', title: '创建失败', body: e.message });
    return null;
  }
  bus.emit('fs:changed', cwd);
  return p;
}

// 系统文件选择器上传
export const uploadTo = (cwd, folder = false) => pickFiles(cwd, folder);

// 拖入的文件直接进上传队列
export function uploadDropped(cwd, files, keepRelative = false) {
  for (const f of files) addUpload(f, cwd, keepRelative ? (f.webkitRelativePath || f.name) : '');
}

// ---------- 剪贴板 ----------

export const copyToClipboard = (paths, cwd) => setClipboard('copy', paths, cwd);
export const cutToClipboard = (paths, cwd) => setClipboard('cut', paths, cwd);

export async function pasteInto(cwd) {
  const cb = getState().clipboard;
  if (!cb) return false;
  try {
    if (cb.mode === 'copy') await api.copy(cb.paths, cwd);
    else await api.move(cb.paths, cwd);
    if (cb.mode === 'cut') setClipboard(null);
    bus.emit('fs:changed', cwd);
    bus.emit('fs:changed', cb.cwd);
    return true;
  } catch (e) {
    notify({ type: 'error', title: '粘贴失败', body: e.message });
    return false;
  }
}

// ---------- 删除 / 重命名 ----------

// 移入废纸篓（paths 与 names 一一对应，names 只用于确认文案）
export async function trashItems(paths, names) {
  if (!paths.length) return false;
  const ok = await confirmDialog({
    title: '移入废纸篓',
    message: names.length === 1
      ? `要将“${names[0]}”移入废纸篓吗？`
      : `要将选中的 ${names.length} 项移入废纸篓吗？`,
    okText: '移入废纸篓',
  });
  if (!ok) return false;
  try {
    await api.trash(paths);
    bus.emit('fs:changed', dirname(paths[0]));
    bus.emit('fs:changed', '__trash__');
    return true;
  } catch (e) {
    notify({ type: 'error', title: '删除失败', body: e.message });
    return false;
  }
}

export async function renameItem(path, newName) {
  if (!newName) return false;
  try {
    await api.rename(path, newName);
    bus.emit('fs:changed', dirname(path));
    return true;
  } catch (e) {
    notify({ type: 'error', title: '重命名失败', body: e.message });
    return false;
  }
}

// ---------- 下载 / 压缩 ----------

export function downloadItem(path) {
  const a = document.createElement('a');
  a.href = api.downloadUrl(path);
  a.download = '';
  a.click();
}

export function downloadItems(paths) {
  const a = document.createElement('a');
  a.href = api.zipUrl(paths);
  a.download = '';
  a.click();
  notify({ type: 'info', title: '开始打包下载', body: `${paths.length} 项，浏览器将下载 zip 文件` });
}

export async function compressItems(paths, destDir) {
  const v = await promptDialog({
    title: '压缩',
    wide: true,
    fields: [
      { key: 'format', label: '格式', type: 'select', value: 'zip', options: [{ value: 'zip', label: 'zip' }, { value: 'tar.gz', label: 'tar.gz' }, { value: 'tar', label: 'tar' }] },
      { key: 'name', label: '文件名（不含扩展名）', value: basename(paths[0]) || 'archive' },
    ],
    okText: '开始压缩',
  });
  if (!v) return false;
  try {
    await api.archiveCreate({ paths, format: v.format, destDir, name: v.name || 'archive' });
    notify({ type: 'info', title: '压缩任务已开始', body: '进度可在传输窗口查看' });
    openWindow('transfers');
    return true;
  } catch (e) {
    notify({ type: 'error', title: '压缩失败', body: e.message });
    return false;
  }
}

export async function extractItem(path, destDir) {
  const v = await promptDialog({
    title: `解压 ${basename(path)}`,
    wide: true,
    fields: [
      { key: 'destDir', label: '解压到（目录）', value: destDir },
      { key: 'intoSubdir', label: '解压到以包名命名的子目录', type: 'checkbox', value: true },
    ],
    okText: '开始解压',
  });
  if (!v) return false;
  try {
    await api.archiveExtract({ path, destDir: v.destDir || destDir, intoSubdir: !!v.intoSubdir });
    notify({ type: 'info', title: '解压任务已开始', body: '进度可在传输窗口查看' });
    openWindow('transfers');
    return true;
  } catch (e) {
    notify({ type: 'error', title: '解压失败', body: e.message });
    return false;
  }
}

// ---------- 分享 / 路径 ----------

export async function shareItem(path, name) {
  const v = await promptDialog({
    title: `分享“${name}”`,
    wide: true,
    fields: [
      { key: 'expiresIn', label: '有效期', type: 'select', value: '604800', options: [
        { value: '3600', label: '1 小时' }, { value: '86400', label: '1 天' }, { value: '604800', label: '7 天' },
        { value: '2592000', label: '30 天' }, { value: '', label: '永久' },
      ] },
      { key: 'password', label: '访问密码（可选）', type: 'text' },
      { key: 'allowDownload', label: '允许下载', type: 'checkbox', value: true },
      { key: 'allowUpload', label: '允许他人上传到此目录', type: 'checkbox', value: false },
      { key: 'maxDownloads', label: '下载次数上限（可选）', type: 'number' },
      { key: 'note', label: '备注（可选）', type: 'text' },
    ],
    okText: '创建分享',
  });
  if (!v) return false;
  try {
    const r = await api.shareCreate({
      path,
      expiresIn: v.expiresIn || null,
      password: v.password || null,
      allowDownload: !!v.allowDownload,
      allowUpload: !!v.allowUpload,
      maxDownloads: v.maxDownloads || null,
      note: v.note,
    });
    const url = `${location.origin}/s/${r.share.token}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    notify({ type: 'success', title: '分享链接已创建并复制', body: url });
    return true;
  } catch (e) {
    notify({ type: 'error', title: '创建分享失败', body: e.message });
    return false;
  }
}

export function copyPathText(path) {
  navigator.clipboard?.writeText('/' + path)
    .then(() => notify({ title: '路径已复制' }))
    .catch(() => {});
}

// ---------- 打开 ----------

// 文件夹打开「文件」窗口；文件按类型分流到编辑器 / 预览
export function openEntry(entry, cwd) {
  const path = joinPath(cwd, entry.name);
  if (entry.type === 'dir') {
    openWindow('finder', { cwd: path });
    return;
  }
  openFile(path, entry.name);
}

// 是否为可解压的归档包
export const isArchive = (entry) => entry.type !== 'dir' && fileCat(entry.name) === 'archive';
