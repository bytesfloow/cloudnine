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

/**
 * 坏清单绝不能当成空清单。以前是 `catch { return [] }`：trash.json 一旦损坏，
 * 废纸篓里所有条目（磁盘上的文件还在）立刻“消失”，cleanTrash 再也回收不到它们，
 * 紧接着任一操作 saveTrash([]) 还会把坏清单原地覆盖 —— 磁盘只增不减，文件永远失联。
 * 现在：只有 ENOENT（从未用过废纸篓）才返回 []；其它错误一律抛出明确原因，
 * 让 /api/fs/trash/* 直接 500，且绝不改名、绝不覆盖 trash.json（用户可能想抢救）。
 */
let trashWarned = false;
function trashManifestCorrupt(detail) {
  if (!trashWarned) {
    trashWarned = true;
    console.error(`[trash] 废纸篓清单不可用：${detail}`);
    console.error(`[trash] 保留原文件不动，废纸篓相关操作全部拒绝；修复或恢复 ${TRASH_MANIFEST()} 后重启服务`);
  }
  return err(500, `废纸篓清单 trash.json 不可用（${detail}）：${TRASH_MANIFEST()}。为避免覆盖已损坏的清单，本次操作已拒绝；请修复或恢复该文件后重启服务。`, 'trash_manifest_corrupt');
}

function loadTrash() {
  let raw;
  try {
    raw = fs.readFileSync(TRASH_MANIFEST(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return []; // 从未用过废纸篓
    throw trashManifestCorrupt(`读取失败 ${e.code || e.message}`);
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw trashManifestCorrupt(`JSON 解析失败 ${e.message}`);
  }
  if (!Array.isArray(list)) throw trashManifestCorrupt('内容不是 JSON 数组');
  return list;
}
/**
 * 写清单：和 db.js 的 writeNow() 同一套序列（tmp → fsync → rename → fsync 目录）。
 * 返回 true/false，自己不抛：调用方要能根据结果决定是否回滚。
 * 以前是裸 writeFileSync + rename：磁盘满会同步抛出（抛在哪个调用点就毁掉哪次请求的中间状态），
 * 而且 rename 先于数据落盘，断电会留下一个 0 字节或半截的 trash.json —— 正是上轮要防的那种损坏。
 */
function saveTrash(list) {
  const tmp = TRASH_MANIFEST() + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(list, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, TRASH_MANIFEST());
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    console.error(`[trash] 写入清单失败（${e.code || e.message}）：${TRASH_MANIFEST()}`);
    return false;
  }
  try {
    const dfd = fs.openSync(config.dataDir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* Windows 等不支持打开目录，忽略 */ }
  return true;
}

function saveTrashOrThrow(list, what) {
  if (saveTrash(list)) return;
  throw err(500, `废纸篓清单 trash.json 写入失败（磁盘已满、只读或权限不足），${what}。请检查磁盘后重试。`, 'trash_manifest_write_failed');
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
  let list;
  try {
    list = loadTrash();
  } catch (e) {
    // 定时任务在 index.js 里是 .catch(() => {}) 静默的，这里必须自己留痕，
    // 否则「保留期回收完全停了」这件事永远没人知道
    console.error('[trash] 本次定时回收跳过:', e.message);
    return 0;
  }
  const keep = [];
  const cutoff = Date.now() - config.trashRetentionDays * 24 * 3600 * 1000;
  let changed = false;
  for (const item of list) {
    const full = path.join(dirs.trash, item.trashName);
    const exists = await fsp.lstat(full).then(() => true).catch(() => false);
    // pending 条目 = 「清单已经写了，文件还没搬进来」，进程在两步之间被杀就会留下它。
    // 文件不在就说明那一步没发生（文件还在原位置），直接丢掉，不会丢数据。
    if (item.pending && !exists) { changed = true; continue; }
    if (item.deletedAt < cutoff) {
      const ok = await fsp.rm(full, { recursive: true, force: true }).then(() => true).catch(() => false);
      if (ok) changed = true;
      else {
        // 删不掉就保留条目，下次再试：否则磁盘上会留下一个清单永远不会碰的孤儿文件
        console.error('[trash] 删除过期条目失败，保留清单条目:', full);
        keep.push(item);
      }
    } else keep.push(item);
  }
  if (changed && !saveTrash(keep)) console.error('[trash] 清理后写回清单失败，下次再试');
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
      if (path.dirname(src) === destDir && doMove) { results.push({ name, action: 'same' }); continue; }
      // 复制到自身所在目录：生成"xxx(1)"式副本名，而非静默跳过（移动到自己仍跳过）
      if (src === dst && !doMove) {
        const nn = uniqueName(destDir, name);
        await fsp.cp(src, path.join(destDir, nn), { recursive: true });
        results.push({ name, action: 'renamed', to: toRel(path.join(destDir, nn)) });
        continue;
      }
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
// 批量删除的恢复目标是：只要有文件进了 trash/，清单里就一定有对应条目
// （哪怕中途失败、哪怕进程被 kill）。做法是「先写清单并 fsync，再移动文件」：
// 移动之前崩溃 → 只多出一条指向不存在文件的 pending 条目（没有数据损失，下一次
// cleanTrash 会把它清掉）；反过来先移动再写清单，一旦在两步之间崩溃就是永久孤儿文件。
fsRouter.post('/fs/trash', async (req, res, next) => {
  try {
    const paths = req.body?.paths || [];
    const list = loadTrash();
    const failed = [];
    const moved = [];
    let count = 0;

    for (const rel of paths) {
      let item = null;
      try {
        const full = safeJoin(R(), rel);
        const name = path.basename(full);
        const id = uid();
        const trashName = `${id}__${name}`;
        // 1) 先往清单里写一条 pending 条目并落盘，再动文件
        item = { id, trashName, name, origRel: toRel(full), deletedAt: Date.now(), type: 'file', pending: true };
        list.push(item);
        if (!saveTrash(list)) {
          list.pop();
          item = null;
          throw err(500, '写入废纸篓清单失败（磁盘已满或只读），文件未移动');
        }
        // 2) 移动。不存在/已被删掉会在这里抛 ENOENT，只影响这一项
        await moveOrCopy(full, path.join(dirs.trash, trashName));
        try { item.type = (await fsp.lstat(path.join(dirs.trash, trashName))).isDirectory() ? 'dir' : 'file'; } catch { /* 类型只是展示用 */ }
        moved.push(item);
        count++;
      } catch (e) {
        // 这一项失败：把刚写进去的条目撒回去（文件没动，清单也不能多出一条）
        if (item) {
          const i = list.indexOf(item);
          if (i >= 0) list.splice(i, 1);
          saveTrash(list);
        }
        const msg = e.code === 'ENOENT' ? '文件不存在（可能已被移动或删除）'
          : e.code === 'EACCES' || e.code === 'EPERM' ? '无权限移动该文件'
          : (e.message || String(e));
        failed.push({ path: typeof rel === 'string' ? rel : String(rel), error: msg });
      }
    }

    // 3) 清掉 pending 标记，一次落盘（这步失败不影响正确性：pending 条目只要文件在就算正常条目）
    if (moved.length) { for (const it of moved) delete it.pending; saveTrash(list); }

    // 现有字段全部保留；新增 failed 逐项结果（老前端不用改）
    res.json({ ok: true, count, trashCount: list.length, failed });
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
    // 文件已经搬回去了；这里失败不能让前端以为什么也没发生
    saveTrashOrThrow(list, `${restored.length} 项已放回原处，但清单未能更新（下次清理前废纸篓可能显示已消失的条目）`);
    res.json({ ok: true, restored, trashCount: list.length });
  } catch (e) { next(e); }
});

fsRouter.post('/fs/trash/empty', async (req, res, next) => {
  try {
    const list = loadTrash();
    for (const item of list) {
      await fsp.rm(path.join(dirs.trash, item.trashName), { recursive: true, force: true }).catch(() => {});
    }
    // 文件已删，清单写不进去就只是残留几条指向不存在文件的条目，不会丢用户数据
    saveTrashOrThrow([], '废纸篓中的文件已删除，但清单未能清空');
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
    saveTrashOrThrow(keep, '选中的文件已删除，但清单未能更新');
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
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.cloudnine-tmp-${uid()}`);
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
