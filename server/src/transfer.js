import { Router } from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import archiver from 'archiver';
import mime from 'mime-types';
import { config, dirs, toAbs, toRel } from './config.js';
import { safeJoin, sanitizeName, uid, err, uniqueName } from './util.js';
import { requireLogin } from './auth.js';

export const transferRouter = Router();
transferRouter.use(requireLogin);

// ================= 分片上传 =================
// init → PUT chunk*（顺序追加）→ finish；断点续传：init 传 uploadId 续传 .part
const uploads = new Map(); // id -> {destDir, finalName, partPath, received, size}

transferRouter.post('/upload/init', async (req, res, next) => {
  try {
    const { destDir, name, size, relativePath, policy, uploadId } = req.body || {};
    let dest = safeJoin(config.fileRoot, destDir || '');
    const rawName = path.basename(String(relativePath || name || ''));
    const fileName = sanitizeName(rawName);
    const maxBytes = config.maxUploadMB * 1024 * 1024;
    if (size && Number(size) > maxBytes) throw err(413, `文件超过大小上限（${config.maxUploadMB} MB）`);

    // 保留相对目录结构（文件夹上传）
    const subDir = path.posix.dirname(String(relativePath || '').replace(/\\/g, '/'));
    if (relativePath && subDir && subDir !== '.') {
      dest = safeJoin(dest, subDir);
      await fsp.mkdir(dest, { recursive: true });
    }

    let finalName = fileName;
    const exists = fs.existsSync(path.join(dest, fileName));
    if (exists) {
      if (policy === 'skip') return res.json({ skip: true });
      if (policy !== 'overwrite') finalName = uniqueName(dest, fileName); // 默认自动重命名
    }

    const id = (uploadId && fs.existsSync(path.join(dirs.uploads, String(uploadId) + '.part'))) ? String(uploadId) : uid();
    const partPath = path.join(dirs.uploads, id + '.part');
    let received = 0;
    try { received = (await fsp.stat(partPath)).size; } catch { /* 新上传 */ }

    uploads.set(id, { destDir: dest, finalName, partPath, received, size: Number(size) || 0 });
    res.json({ uploadId: id, finalName, offset: received });
  } catch (e) { next(e); }
});

const rawBody = express.raw({ type: () => true, limit: '17mb' });

transferRouter.put('/upload/chunk/:id', rawBody, async (req, res, next) => {
  try {
    const rec = uploads.get(req.params.id);
    if (!rec) throw err(404, '上传会话不存在或已过期');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw err(400, '空分片');
    if (rec.size && rec.received + req.body.length > rec.size + 1024 * 1024) throw err(413, '超出声明大小');
    await fsp.appendFile(rec.partPath, req.body);
    rec.received += req.body.length;
    res.json({ offset: rec.received });
  } catch (e) { next(e); }
});

transferRouter.post('/upload/finish/:id', async (req, res, next) => {
  try {
    const rec = uploads.get(req.params.id);
    if (!rec) throw err(404, '上传会话不存在或已过期');
    const target = path.join(rec.destDir, rec.finalName);
    try { await fsp.rename(rec.partPath, target); }
    catch (e) {
      if (e.code === 'EXDEV') { await fsp.copyFile(rec.partPath, target); await fsp.rm(rec.partPath, { force: true }); }
      else throw e;
    }
    const st = await fsp.stat(target);
    uploads.delete(req.params.id);
    res.json({ path: toRel(target), name: rec.finalName, size: st.size });
  } catch (e) { next(e); }
});

transferRouter.post('/upload/abort/:id', async (req, res, next) => {
  try {
    const rec = uploads.get(req.params.id);
    if (rec) { await fsp.rm(rec.partPath, { force: true }).catch(() => {}); uploads.delete(req.params.id); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

transferRouter.get('/upload/status/:id', async (req, res, next) => {
  try {
    const rec = uploads.get(req.params.id);
    if (!rec) throw err(404, '上传会话不存在');
    res.json({ offset: rec.received });
  } catch (e) { next(e); }
});

// ================= 下载（Range 支持） =================
transferRouter.get('/download', async (req, res, next) => {
  try {
    const full = safeJoin(config.fileRoot, req.query.path);
    const st = await fsp.stat(full);
    if (st.isDirectory()) throw err(400, '目录请使用打包下载');
    const inline = req.query.inline === '1';
    const name = path.basename(full);
    const ctype = mime.lookup(name) || 'application/octet-stream';

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', ctype);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start == null) { // suffix range: 最后 N 字节
          start = Math.max(0, st.size - (end || 0)); end = st.size - 1;
        } else if (end == null || end >= st.size) end = st.size - 1;
        if (start > end || start >= st.size) {
          res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
          return res.end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Content-Length', end - start + 1);
        const stream = fs.createReadStream(full, { start, end });
        stream.on('error', () => res.destroy());
        return stream.pipe(res);
      }
    }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (e) { next(e); }
});

// 多选/文件夹打包 zip 流式下载：GET /api/download/zip?paths=["a","b"]
transferRouter.get('/download/zip', async (req, res, next) => {
  try {
    let paths;
    try { paths = JSON.parse(String(req.query.paths || '[]')); } catch { throw err(400, '参数错误'); }
    if (!Array.isArray(paths) || !paths.length) throw err(400, '未选择文件');
    if (paths.length > 50) throw err(400, '一次最多打包 50 个项目');

    const zipName = `archive-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    const ascii = zipName.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (e) => { next(e); });
    res.on('close', () => archive.abort());
    archive.pipe(res);
    for (const rel of paths) {
      const full = safeJoin(config.fileRoot, rel);
      const st = await fsp.lstat(full).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) archive.directory(full, path.basename(full));
      else if (st.isFile()) archive.file(full, { name: path.basename(full) });
    }
    await archive.finalize();
  } catch (e) { next(e); }
});
