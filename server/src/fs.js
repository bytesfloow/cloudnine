import { Router } from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config, dirs, toAbs, toRel } from './config.js';
import { safeJoin, sanitizeName, modeStr, uid, err, uniqueName, existsSync } from './util.js';
import { getDB, saveDB } from './db.js';
import { requireLogin } from './auth.js';

export const fsRouter = Router();
fsRouter.use(requireLogin);

const R = () => config.fileRoot;

// ---------- 废纸篓（数据目录 trash/，manifest 记录原始路径） ----------
const TRASH_MANIFEST = () => path.join(config.dataDir, 'trash.json');

function loadTrash() {
  try { return JSON.parse(fs.readFileSync(TRASH_MANIFEST(), 'utf8')); } catch { return []; }
}
function saveTrash(list) {
  const tmp = TRASH_MANIFEST() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, TRASH_MANIFEST());
}

async function moveOrCopy(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fsp.cp(src, dst, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else throw e;
  }
}

export async function cleanTrash() {
  const list = loadTrash();
  const keep = [];
  const cutoff = Date.now() - config.trashRetentionDays * 24 * 3600 * 1000;
  for (const item of list) {
    if (item.deletedAt < cutoff) {
      await fsp.rm(path.join(dirs.trash, item.trashName), { recursive: true, force: true }).catch(() => {});
    } else keep.push(item);
  }
  if (keep.length !== list.length) saveTrash(keep);
  return keep.length;
}

// ---------- 条目信息 ----------
async function statEntry(full, name) {
  const st = await fsp.lstat(full);
  let type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file';
  let size = st.size, mtimeMs = st.mtimeMs, target = null;
  if (type === 'symlink') {
    try {
      const t = await fsp.stat(full);
      size = t.size; mtimeMs = t.mtimeMs;
      if (t.isDirectory()) type = 'dir';
      target = await fsp.readlink(full).catch(() => null);
    } catch { type = 'broken'; }
  }
  return {
    name, type, size, mtimeMs,
    birthtimeMs: st.birthtimeMs, atimeMs: st.atimeMs,
    mode: st.mode & 0o7777, modeStr: modeStr(st.mode),
    uid: st.uid, gid: st.gid,
    hidden: name.startsWith('.'), target,
  };
}

// ---------- 目录浏览 ----------
fsRouter.get('/fs/list', async (req, res, next) => {
  try {
    const dir = safeJoin(R(), req.query.path);
    const names = await fsp.readdir(dir).catch((e) => {
      if (e.code === 'EACCES') throw err(403, '无访问权限');
      if (e.code === 'ENOENT') throw err(404, '目录不存在');
      if (e.code === 'ENOTDIR') throw err(400, '不是目录');
      throw e;
    });
    const entries = [];
    for (const name of names) {
      try { entries.push(await statEntry(path.join(dir, name), name)); } catch { /* 单个条目失败不影响整体 */ }
    }
    let free = null, total = null;
    try { const s = await fsp.statfs(dir); free = s.bsize * s.bavail; total = s.bsize * s.blocks; } catch { /* 忽略 */ }
    res.json({ path: String(req.query.path || ''), entries, free, total });
  } catch (e) { next(e); }
});

fsRouter.get('/fs/stat', async (req, res, next) => {
  try {
    const full = safeJoin(R(), req.query.path);
    const st = await statEntry(full, path.basename(full));
    res.json({ ...st, path: toRel(full), dir: toRel(path.dirname(full)) });
  } catch (e) { next(e); }
});

// ---------- 新建 / 重命名 ----------
fsRouter.post('/fs/mkdir', async (req, res, next) => {
  try {
    const rel = String(req.body?.path || '').replace(/\/+$/, '');
    if (!rel) throw err(400, '路径不能为空');
    const full = safeJoin(R(), rel);
    if (existsSync(full)) throw err(409, '同名文件或文件夹已存在');
    await fsp.mkdir(full, { recursive: true });
    res.json({ ok: true, path: toRel(full) });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/touch', async (req, res, next) => {
  try {
    const full = safeJoin(R(), req.body?.path);
    if (existsSync(full)) throw err(409, '同名文件已存在');
    await fsp.writeFile(full, '');
    res.json({ ok: true, path: toRel(full) });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/rename', async (req, res, next) => {
  try {
    const full = safeJoin(R(), req.body?.path);
    const newName = sanitizeName(req.body?.newName);
    const target = path.join(path.dirname(full), newName);
    if (existsSync(target)) throw err(409, '目标名称已存在');
    await fsp.rename(full, target);
    res.json({ ok: true, path: toRel(target) });
  } catch (e) { next(e); }
});

// ---------- 移动 / 复制（含同名冲突策略） ----------
async function transferEntries(paths, destRel, policy, doMove) {
  const destDir = safeJoin(R(), destRel);
  const results = [];
  for (const rel of paths || []) {
    const src = safeJoin(R(), rel);
    const name = path.basename(src);
    const dst = path.join(destDir, name);
    try {
      if (src === dst || path.dirname(src) === destDir && doMove) { results.push({ name, action: 'same' }); continue; }
      const exists = existsSync(dst);
      if (exists) {
        if (policy === 'skip') { results.push({ name, action: 'skipped' }); continue; }
        if (policy === 'rename') {
          const nn = uniqueName(destDir, name);
          const ndst = path.join(destDir, nn);
          if (doMove) await moveOrCopy(src, ndst); else await fsp.cp(src, ndst, { recursive: true });
          results.push({ name, action: 'renamed', to: toRel(ndst) });
          continue;
        }
        // overwrite
        await fsp.rm(dst, { recursive: true, force: true });
      }
      if (doMove) await moveOrCopy(src, dst);
      else await fsp.cp(src, dst, { recursive: true });
      results.push({ name, action: exists ? 'overwritten' : 'moved' });
    } catch (e) {
      results.push({ name, action: 'error', error: e.message });
    }
  }
  return results;
}

fsRouter.post('/fs/move', async (req, res, next) => {
  try {
    const results = await transferEntries(req.body?.paths, req.body?.dest, req.body?.policy || 'rename', true);
    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/copy', async (req, res, next) => {
  try {
    const results = await transferEntries(req.body?.paths, req.body?.dest, req.body?.policy || 'rename', false);
    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

// ---------- 删除与废纸篓 ----------
fsRouter.post('/fs/trash', async (req, res, next) => {
  try {
    const list = loadTrash();
    let count = 0;
    for (const rel of req.body?.paths || []) {
      const full = safeJoin(R(), rel);
      if (!existsSync(full) && !fs.lstatSync && !fs.existsSync) continue;
      const name = path.basename(full);
      const id = uid();
      const trashName = `${id}__${name}`;
      await moveOrCopy(full, path.join(dirs.trash, trashName));
      let type = 'file';
      try { type = (await fsp.lstat(path.join(dirs.trash, trashName))).isDirectory() ? 'dir' : 'file'; } catch { /* 忽略 */ }
      list.push({ id, trashName, name, origRel: toRel(full), deletedAt: Date.now(), type });
      count++;
    }
    saveTrash(list);
    res.json({ ok: true, count, trashCount: list.length });
  } catch (e) { next(e); }
});

fsRouter.get('/fs/trash/list', async (req, res, next) => {
  try {
    const list = loadTrash();
    const entries = [];
    for (const item of list) {
      const full = path.join(dirs.trash, item.trashName);
      try {
        const st = await fsp.lstat(full);
        entries.push({ ...item, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* 文件已被外部清理 */ }
    }
    res.json({ entries });
  } catch (e) { next(e); }
});

fsRouter.get('/fs/trash/count', async (req, res, next) => {
  try { res.json({ count: loadTrash().length }); } catch (e) { next(e); }
});

fsRouter.post('/fs/trash/restore', async (req, res, next) => {
  try {
    const list = loadTrash();
    const restored = [];
    for (const id of req.body?.ids || []) {
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) continue;
      const item = list[idx];
      const src = path.join(dirs.trash, item.trashName);
      const origAbs = safeJoin(R(), item.origRel);
      const destDir = path.dirname(origAbs);
      await fsp.mkdir(destDir, { recursive: true });
      const name = existsSync(origAbs) ? uniqueName(destDir, item.name) : item.name;
      await moveOrCopy(src, path.join(destDir, name));
      list.splice(idx, 1);
      restored.push({ id, name });
    }
    saveTrash(list);
    res.json({ ok: true, restored, trashCount: list.length });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/trash/empty', async (req, res, next) => {
  try {
    const list = loadTrash();
    for (const item of list) {
      await fsp.rm(path.join(dirs.trash, item.trashName), { recursive: true, force: true }).catch(() => {});
    }
    saveTrash([]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/trash/delete', async (req, res, next) => {
  try {
    const list = loadTrash();
    const ids = new Set(req.body?.ids || []);
    for (const item of list.filter((x) => ids.has(x.id))) {
      await fsp.rm(path.join(dirs.trash, item.trashName), { recursive: true, force: true }).catch(() => {});
    }
    const keep = list.filter((x) => !ids.has(x.id));
    saveTrash(keep);
    res.json({ ok: true, trashCount: keep.length });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/delete', async (req, res, next) => {
  try {
    const count = (req.body?.paths || []).length;
    for (const rel of req.body?.paths || []) {
      const full = safeJoin(R(), rel);
      await fsp.rm(full, { recursive: true, force: true });
    }
    res.json({ ok: true, count });
  } catch (e) { next(e); }
});

// ---------- 权限 ----------
fsRouter.post('/fs/chmod', async (req, res, next) => {
  try {
    const full = safeJoin(R(), req.body?.path);
    const mode = Number(req.body?.mode);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw err(400, '权限值不合法');
    await fsp.chmod(full, mode);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/chown', async (req, res, next) => {
  try {
    if (process.platform === 'win32') throw err(400, '当前平台不支持 chown');
    const full = safeJoin(R(), req.body?.path);
    const uidNum = req.body?.uid == null ? undefined : Number(req.body.uid);
    const gidNum = req.body?.gid == null ? undefined : Number(req.body.gid);
    await fsp.chown(full, uidNum, gidNum);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 文本读取 / 写入 ----------
fsRouter.get('/fs/read', async (req, res, next) => {
  try {
    const full = safeJoin(R(), req.query.path);
    const st = await fsp.stat(full);
    if (st.isDirectory()) throw err(400, '不能读取目录');
    const max = Math.min(Number(req.query.maxKB) || 512, 2048) * 1024;
    const fh = await fsp.open(full, 'r');
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      let encoding = 'utf-8', content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        try { content = new TextDecoder('gb18030').decode(buf); encoding = 'gb18030'; }
        catch { content = buf.toString('latin1'); encoding = 'latin1'; }
      }
      res.json({ content, encoding, truncated: st.size > len, size: st.size, mtimeMs: st.mtimeMs });
    } finally { await fh.close(); }
  } catch (e) { next(e); }
});

fsRouter.post('/fs/write', async (req, res, next) => {
  try {
    const full = safeJoin(R(), req.body?.path);
    const { content, baseMtimeMs, force } = req.body || {};
    if (typeof content !== 'string') throw err(400, '内容不能为空');
    let st = null;
    try { st = await fsp.stat(full); } catch { /* 新文件 */ }
    if (st && st.isDirectory()) throw err(400, '目标路径是目录');
    if (st && !force && baseMtimeMs != null && Math.abs(st.mtimeMs - Number(baseMtimeMs)) > 100) {
      return res.status(409).json({ error: '文件已在外部变更', code: 'conflict', mtimeMs: st.mtimeMs });
    }
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.wfm-tmp-${uid()}`);
    await fsp.writeFile(tmp, content, 'utf-8');
    await fsp.rename(tmp, full);
    const nst = await fsp.stat(full);
    res.json({ ok: true, mtimeMs: nst.mtimeMs, size: nst.size });
  } catch (e) { next(e); }
});

// ---------- 搜索 ----------
fsRouter.get('/fs/search', async (req, res, next) => {
  try {
    const baseDir = safeJoin(R(), req.query.path);
    const q = String(req.query.q || '').toLowerCase();
    if (!q) return res.json({ results: [] });
    const results = [];
    const cap = 3000;
    const walk = async (dir, depth) => {
      if (depth > 8 || results.length >= cap) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        if (results.length >= cap) return;
        const full = path.join(dir, d.name);
        if (d.name.toLowerCase().includes(q)) {
          try {
            const st = await fsp.lstat(full);
            results.push({ rel: toRel(full), name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs });
          } catch { /* 忽略 */ }
        }
        if (d.isDirectory() && !d.isSymbolicLink()) await walk(full, depth + 1);
      }
    };
    await walk(baseDir, 0);
    res.json({ results, truncated: results.length >= cap });
  } catch (e) { next(e); }
});

// ---------- 最近打开 / 主目录 ----------
fsRouter.get('/fs/recent', async (req, res, next) => {
  try { res.json({ items: (getDB().recents || []).slice(0, 30) }); } catch (e) { next(e); }
});

fsRouter.post('/fs/recent', async (req, res, next) => {
  try {
    const { path: rel, name } = req.body || {};
    if (!rel) throw err(400, '缺少路径');
    const db = getDB();
    db.recents = [{ path: toRel(safeJoin(R(), rel)), name: String(name || path.basename(String(rel))), at: Date.now() },
      ...(db.recents || []).filter((x) => x.path !== toRel(safeJoin(R(), rel)))].slice(0, 30);
    saveDB();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

fsRouter.get('/fs/home', async (req, res, next) => {
  try {
    const rel = toRel(os.homedir());
    res.json({ homeRel: rel.startsWith('..') ? '' : rel });
  } catch (e) { next(e); }
});
