import { Router } from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import bcrypt from 'bcryptjs';
import archiver from 'archiver';
import mime from 'mime-types';
import { config, toAbs, toRel } from './config.js';
import { safeJoin, sanitizeName, randomToken, uid, err, uniqueName } from './util.js';
import { getDB, saveDB } from './db.js';
import { requireLogin } from './auth.js';

function findShare(token) {
  const s = getDB().shares.find((x) => x.token === token);
  if (!s || s.canceled) throw err(404, '链接不存在或已取消', 'not_found');
  if (s.expiresAt && s.expiresAt < Date.now()) throw err(410, '链接已过期', 'expired');
  if (s.maxDownloads && s.downloads >= s.maxDownloads) throw err(410, '已达下载次数上限', 'max_downloads');
  return s;
}

function checkPassword(s, req) {
  if (!s.passwordHash) return;
  const pw = req.headers['x-share-password'] || req.query.pw || '';
  if (!bcrypt.compareSync(String(pw), s.passwordHash)) throw err(401, '需要访问密码', 'need_password');
}

function shareAbsDir(s) { return safeJoin(config.fileRoot, s.path); }

// ================= 管理端（需登录） =================
export const shareAdminRouter = Router();
shareAdminRouter.use(requireLogin);

shareAdminRouter.get('/shares', (req, res) => {
  res.json({ shares: getDB().shares.filter((s) => !s.canceled) });
});

shareAdminRouter.post('/shares', (req, res, next) => {
  try {
    const { path: rel, expiresIn, password, allowDownload = true, allowUpload = false, maxDownloads, note } = req.body || {};
    const abs = safeJoin(config.fileRoot, rel);
    const st = fs.statSync(abs);
    const s = {
      id: uid(),
      token: randomToken(20),
      path: toRel(abs),
      name: path.basename(abs),
      isDir: st.isDirectory(),
      size: st.size,
      createdAt: Date.now(),
      expiresAt: expiresIn ? Date.now() + Number(expiresIn) * 1000 : null,
      passwordHash: password ? bcrypt.hashSync(String(password), 10) : null,
      allowDownload: !!allowDownload,
      allowUpload: !!allowUpload,
      maxDownloads: maxDownloads ? Number(maxDownloads) : null,
      downloads: 0,
      note: String(note || '').slice(0, 200),
      canceled: false,
    };
    getDB().shares.push(s);
    saveDB();
    res.json({ ok: true, share: s });
  } catch (e) { next(e); }
});

shareAdminRouter.patch('/shares/:id', (req, res, next) => {
  try {
    const s = getDB().shares.find((x) => x.id === req.params.id);
    if (!s) throw err(404, '分享不存在');
    const b = req.body || {};
    if (b.action === 'cancel') s.canceled = true;
    if (b.expiresIn !== undefined) s.expiresAt = b.expiresIn ? Date.now() + Number(b.expiresIn) * 1000 : null;
    if (b.allowDownload !== undefined) s.allowDownload = !!b.allowDownload;
    if (b.allowUpload !== undefined) s.allowUpload = !!b.allowUpload;
    if (b.maxDownloads !== undefined) s.maxDownloads = b.maxDownloads ? Number(b.maxDownloads) : null;
    saveDB();
    res.json({ ok: true, share: s });
  } catch (e) { next(e); }
});

shareAdminRouter.delete('/shares/:id', (req, res, next) => {
  try {
    const db = getDB();
    db.shares = db.shares.filter((x) => x.id !== req.params.id);
    saveDB();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

shareAdminRouter.post('/shares/cleanup', (req, res, next) => {
  try {
    const db = getDB();
    const before = db.shares.length;
    db.shares = db.shares.filter((s) => !s.canceled && !(s.expiresAt && s.expiresAt < Date.now()) && !(s.maxDownloads && s.downloads >= s.maxDownloads));
    saveDB();
    res.json({ ok: true, removed: before - db.shares.length });
  } catch (e) { next(e); }
});

// ================= 公开访问（无需登录，凭令牌） =================
export const sharePublicRouter = Router();

sharePublicRouter.get('/share/:token/meta', (req, res, next) => {
  try {
    const s = findShare(req.params.token);
    checkPassword(s, req);
    res.json({
      name: s.name, isDir: s.isDir, size: s.size, note: s.note,
      expiresAt: s.expiresAt, allowDownload: s.allowDownload, allowUpload: s.allowUpload,
      requiresPassword: !!s.passwordHash,
    });
  } catch (e) { next(e); }
});

sharePublicRouter.get('/share/:token/list', async (req, res, next) => {
  try {
    const s = findShare(req.params.token);
    checkPassword(s, req);
    if (!s.isDir) throw err(400, '该分享不是文件夹');
    const dir = safeJoin(shareAbsDir(s), req.query.sub || '');
    const names = await fsp.readdir(dir).catch(() => []);
    const entries = [];
    for (const name of names) {
      try {
        const st = await fsp.stat(path.join(dir, name));
        entries.push({ name, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* 忽略 */ }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
    res.json({ entries });
  } catch (e) { next(e); }
});

sharePublicRouter.get('/share/:token/file', async (req, res, next) => {
  try {
    const s = findShare(req.params.token);
    checkPassword(s, req);
    const inline = req.query.inline === '1';
    if (!inline && !s.allowDownload) throw err(403, '该分享不允许下载', 'no_download');
    const full = safeJoin(shareAbsDir(s), req.query.sub || '');
    const st = await fsp.stat(full);
    if (st.isDirectory()) throw err(400, '目录请使用打包下载');

    if (!inline) { s.downloads++; saveDB(); }
    const name = path.basename(full);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime.lookup(name) || 'application/octet-stream');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? Math.max(0, st.size - parseInt(m[2] || '0', 10)) : parseInt(m[1], 10);
        let end = m[1] === '' ? st.size - 1 : (m[2] === '' || parseInt(m[2], 10) >= st.size) ? st.size - 1 : parseInt(m[2], 10);
        if (start > end || start >= st.size) {
          res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
          return res.end();
        }
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`).setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
    }
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  } catch (e) { next(e); }
});

sharePublicRouter.get('/share/:token/zip', async (req, res, next) => {
  try {
    const s = findShare(req.params.token);
    checkPassword(s, req);
    if (!s.allowDownload) throw err(403, '该分享不允许下载', 'no_download');
    const dir = safeJoin(shareAbsDir(s), req.query.sub || '');
    const name = `${path.basename(dir)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="share.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
    s.downloads++; saveDB();
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', () => {});
    res.on('close', () => archive.abort());
    archive.pipe(res);
    archive.directory(dir, path.basename(dir));
    await archive.finalize();
  } catch (e) { next(e); }
});

// 允许上传的分享：单请求投递（raw body，上限 100 MB）
const rawBody = express.raw({ type: () => true, limit: '101mb' });
sharePublicRouter.put('/share/:token/upload', rawBody, async (req, res, next) => {
  try {
    const s = findShare(req.params.token);
    checkPassword(s, req);
    if (!s.allowUpload) throw err(403, '该分享不允许上传');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw err(400, '空内容');
    const name = uniqueName(shareAbsDir(s), sanitizeName(path.basename(String(req.query.name || `投递文件-${Date.now()}`))));
    await fsp.writeFile(path.join(shareAbsDir(s), name), req.body);
    res.json({ ok: true, name });
  } catch (e) { next(e); }
});
