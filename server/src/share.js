import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mime from 'mime-types';
import { config, toRel } from './config.js';
import { randomToken, uid, err, resolveShareTarget } from './util.js';
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

// 分享只发单个普通文件：目录、软链接、路径经过软链接一律拒绝（见 util.resolveShareTarget）
async function requireShareTarget(s) {
  try {
    return await resolveShareTarget(config.fileRoot, s.path);
  } catch (e) {
    // 创建后文件被删 → 链接还在但内容没了，用 410 区别于「非法路径」
    if (e.status === 404) throw err(410, '该分享的文件已不存在', 'share_gone');
    throw e;
  }
}

// ================= 管理端（需登录） =================
export const shareAdminRouter = Router();
shareAdminRouter.use(requireLogin);

shareAdminRouter.get('/shares', (req, res) => {
  res.json({ shares: getDB().shares.filter((s) => !s.canceled) });
});

shareAdminRouter.post('/shares', async (req, res, next) => {
  try {
    const { path: rel, expiresIn, password, allowDownload = true, maxDownloads, note } = req.body || {};
    // 目录 / 软链接 / 经过软链接 → 400，错误码区分原因，前端直接展示后端中文原因
    const { abs, stat } = await resolveShareTarget(config.fileRoot, rel);
    const s = {
      id: uid(),
      token: randomToken(20),
      path: toRel(abs),
      name: path.basename(abs),
      size: stat.size,
      createdAt: Date.now(),
      expiresAt: expiresIn ? Date.now() + Number(expiresIn) * 1000 : null,
      passwordHash: password ? bcrypt.hashSync(String(password), 10) : null,
      allowDownload: !!allowDownload,
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
      name: s.name, size: s.size, note: s.note,
      expiresAt: s.expiresAt, allowDownload: s.allowDownload,
      requiresPassword: !!s.passwordHash,
    });
  } catch (e) { next(e); }
});

sharePublicRouter.get('/share/:token/file', async (req, res, next) => {
  try {
    const s = findShare(req.params.token);
    checkPassword(s, req);
    const inline = req.query.inline === '1';
    if (!inline && !s.allowDownload) throw err(403, '该分享不允许下载', 'no_download');
    // 创建后目标可能被换成目录或软链，所以每次请求都重新校验，并按 realpath 读取
    const { real, stat: st } = await requireShareTarget(s);

    if (!inline) { s.downloads++; saveDB(); }
    const name = path.basename(real);
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
        return fs.createReadStream(real, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
    }
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  } catch (e) { next(e); }
});
