import { Router } from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { extract as tarExtract } from 'tar-stream';
import { config, toAbs, toRel } from './config.js';
import { safeJoin, uid, err, uniqueName, walkFiles, sanitizeName } from './util.js';
import { requireLogin } from './auth.js';

export const mediaRouter = Router();
mediaRouter.use(requireLogin);

// ================= 磁盘监控 =================
function statfsInfo(mount, fstype, s) {
  const total = Number(s.bsize) * Number(s.blocks);
  const free = Number(s.bsize) * Number(s.bavail);
  const used = total - free;
  // Windows 跨盘符时 path.relative 会返回绝对路径（如 D:/），需一并判定为根外
  const rel = toRel(mount);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return {
    mount, mountRel: outside ? null : rel, fstype,
    total, free, used,
    usePct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    inodes: Number(s.files) || null, inodesFree: Number(s.ffree) || null,
  };
}

export async function listMounts() {
  const out = [];
  if (process.platform === 'win32') {
    for (let L = 65; L <= 90; L++) {
      const drive = `${String.fromCharCode(L)}:\\`;
      try {
        await fsp.access(drive);
        const s = await fsp.statfs(drive);
        out.push(statfsInfo(drive, 'ntfs', s));
      } catch { /* 盘符不存在或读取失败 */ }
    }
    return out;
  }
  let raw = '';
  try { raw = await fsp.readFile('/proc/mounts', 'utf8'); } catch { return out; }
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const cols = line.split(' ');
    if (cols.length < 3) continue;
    const mnt = cols[1].replace(/\\040/g, ' ').replace(/\\134/g, '\\');
    const type = cols[2];
    if (!/^\//.test(mnt) || seen.has(mnt)) continue;
    if (!/^(ext[234]|xfs|btrfs|zfs|f2fs|jfs|reiserfs|ntfs3?|vfat|exfat|fuse\.blk|overlay)$/.test(type)) continue;
    seen.add(mnt);
    try { out.push(statfsInfo(mnt, type, await fsp.statfs(mnt))); } catch { /* 忽略 */ }
  }
  return out.sort((a, b) => a.mount.length - b.mount.length);
}

mediaRouter.get('/disk', async (req, res, next) => {
  try {
    const mounts = await listMounts();
    res.json({ mounts });
  } catch (e) { next(e); }
});

// ================= 后台任务（压缩/解压） =================
export const jobs = new Map(); // id -> {id,type,label,progress,status,error,resultRel}

function newJob(type, label) {
  const id = uid();
  const job = { id, type, label, progress: 0, status: 'running', createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}
setInterval(() => {
  const cutoff = Date.now() - 3600 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff && j.status !== 'running') jobs.delete(id);
}, 600 * 1000).unref();

mediaRouter.get('/jobs', async (req, res, next) => {
  try {
    res.json({ jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt) });
  } catch (e) { next(e); }
});

// ---------- 压缩 ----------
mediaRouter.post('/archive/create', async (req, res, next) => {
  try {
    const { paths, format = 'zip', destDir = '', name, level } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) throw err(400, '未选择文件');
    const fmt = ['zip', 'tar.gz', 'tar'].includes(format) ? format : 'zip';
    const destAbsDir = safeJoin(config.fileRoot, destDir);
    const outName = uniqueName(destAbsDir, sanitizeName(name || 'archive') + (fmt === 'zip' ? '.zip' : fmt === 'tar.gz' ? '.tar.gz' : '.tar'));
    const outAbs = path.join(destAbsDir, outName);

    const job = newJob('compress', `压缩 ${paths.length} 项 → ${outName}`);
    res.json({ ok: true, jobId: job.id });

    // 异步执行
    (async () => {
      try {
        let total = 0, done = 0;
        for (const rel of paths) {
          const st = await fsp.stat(safeJoin(config.fileRoot, rel));
          if (st.isDirectory()) total += (await walkFiles(safeJoin(config.fileRoot, rel))).length + 1;
          else total++;
        }
        const archive = fmt === 'zip'
          ? archiver('zip', { zlib: { level: Number(level) ?? 6 } })
          : fmt === 'tar.gz' ? archiver('tar', { gzip: { level: 6 } }) : archiver('tar');
        const tmpOut = outAbs + '.cloudnine-tmp';
        const ws = fs.createWriteStream(tmpOut);
        archive.on('entry', () => { done++; job.progress = total ? Math.round((done / total) * 100) : 0; });
        archive.on('error', (e) => { throw e; });
        archive.pipe(ws);
        for (const rel of paths) {
          const abs = safeJoin(config.fileRoot, rel);
          const st = await fsp.lstat(abs);
          if (st.isDirectory()) archive.directory(abs, path.basename(abs));
          else if (st.isFile()) archive.file(abs, { name: path.basename(abs) });
        }
        await archive.finalize();
        await new Promise((resolve, reject) => ws.on('close', resolve).on('error', reject));
        await fsp.rename(tmpOut, outAbs);
        job.status = 'done'; job.progress = 100; job.resultRel = toRel(outAbs);
      } catch (e) {
        job.status = 'error'; job.error = e.message;
        await fsp.rm(outAbs + '.cloudnine-tmp', { force: true }).catch(() => {});
      }
    })();
  } catch (e) { next(e); }
});

// ---------- 压缩包内列表（zip） ----------
function zipEntries(abs) {
  return new Promise((resolve, reject) => {
    yauzl.open(abs, { lazyEntries: true, autoClose: true }, (e, zipfile) => {
      if (e) return reject(err(400, '无法读取压缩包（可能已损坏或格式不受支持）'));
      const out = [];
      zipfile.on('entry', (entry) => {
        out.push({ name: entry.fileName, size: entry.uncompressedSize, dir: /\/$/.test(entry.fileName) });
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

mediaRouter.get('/archive/list', async (req, res, next) => {
  try {
    const abs = safeJoin(config.fileRoot, req.query.path);
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.zip') return res.json({ entries: await zipEntries(abs) });
    if (/\.(tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/.test(abs.toLowerCase())) {
      const entries = [];
      try {
        await new Promise((resolve, reject) => {
          const ex = tarExtract();
          ex.on('entry', (header, s, cb) => { entries.push({ name: header.name, size: header.size, dir: header.type === 'directory' }); s.resume(); cb(); });
          ex.on('finish', resolve); ex.on('error', reject);
          decompressStream(abs.toLowerCase(), abs).then((s) => s.pipe(ex)).catch(reject);
        });
      } catch (e) { throw e.status ? e : err(400, '无法读取压缩包'); }
      return res.json({ entries });
    }
    throw err(400, '暂不支持在线浏览该格式包内列表');
  } catch (e) { next(e); }
});

// ---------- 解压 ----------
function sanitizeEntryName(name) {
  let n = String(name).replace(/\\/g, '/');
  n = n.replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(n)) n = n.slice(2).replace(/^\/+/, '');
  if (n.split('/').includes('..')) throw err(400, `压缩包含危险路径：${name}`);
  return n;
}

function spawnToolOrThrow(tool, args = []) {
  const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let failed = false;
  child.on('error', () => { failed = true; child.stdout.emit('error', new Error(`缺少系统组件 ${tool}，无法处理该格式`)); });
  child.stderr.on('data', () => {});
  return child.stdout;
}

async function toolExists(tool) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const c = spawn(cmd, [tool]);
    c.on('close', (code) => resolve(code === 0));
    c.on('error', () => resolve(false));
  });
}

// 根据压缩包后缀返回解压后的可读流（gz/bz2/xz 依赖系统工具）
async function decompressStream(lower, abs) {
  if (/\.gz$/.test(lower)) return fs.createReadStream(abs).pipe(zlib.createGunzip());
  if (/\.bz2$/.test(lower)) {
    if (!(await toolExists('bunzip2'))) throw err(400, '缺少系统组件 bunzip2，无法处理 bz2 格式');
    return spawn('bunzip2', ['-d', '-c', abs]).stdout;
  }
  if (/\.xz$/.test(lower)) {
    if (!(await toolExists('xz'))) throw err(400, '缺少系统组件 xz，无法处理 xz 格式');
    return spawn('xz', ['-d', '-c', abs]).stdout;
  }
  return fs.createReadStream(abs);
}

mediaRouter.post('/archive/extract', async (req, res, next) => {
  try {
    const { path: archiveRel, destDir = '', intoSubdir = true, entries: onlyEntries } = req.body || {};
    const archiveAbs = safeJoin(config.fileRoot, archiveRel);
    const lower = archiveAbs.toLowerCase();
    let dest = safeJoin(config.fileRoot, destDir || toRel(path.dirname(archiveAbs)));
    if (intoSubdir) dest = path.join(dest, path.basename(archiveAbs).replace(/\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|gz|bz2|xz|7z|rar)$/i, ''));
    await fsp.mkdir(dest, { recursive: true });

    const job = newJob('extract', `解压 ${path.basename(archiveAbs)}`);
    res.json({ ok: true, jobId: job.id, destRel: toRel(dest) });

    const capBytes = config.maxExtractMB * 1024 * 1024;
    const capCount = 100000;
    const filter = (name) => {
      if (!onlyEntries || !onlyEntries.length) return true;
      return onlyEntries.some((x) => name === x || name.startsWith(x.endsWith('/') ? x : x + '/'));
    };
    const mkFile = async (name) => {
      const safe = sanitizeEntryName(name);
      const out = safeJoin(dest, safe);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      return out;
    };

    (async () => {
      try {
        if (lower.endsWith('.zip')) {
          const all = await zipEntries(archiveAbs);
          const files = all.filter((e) => !e.dir && filter(e.name));
          let done = 0, bytes = 0;
          await new Promise((resolve, reject) => {
            yauzl.open(archiveAbs, { lazyEntries: true, autoClose: true }, (e, zipfile) => {
              if (e) return reject(err(400, '无法读取压缩包'));
              zipfile.on('entry', (entry) => {
                if (/\/$/.test(entry.fileName) || !filter(entry.fileName)) return zipfile.readEntry();
                bytes += entry.uncompressedSize;
                if (bytes > capBytes) { zipfile.close(); return reject(err(400, '解压总量超过上限，已终止（疑似压缩炸弹）')); }
                if (++done > capCount) { zipfile.close(); return reject(err(400, '解压文件数量超过上限，已终止')); }
                zipfile.openReadStream(entry, async (e2, rs) => {
                  if (e2) return reject(e2);
                  try {
                    const out = await mkFile(entry.fileName);
                    const ws = fs.createWriteStream(out);
                    rs.pipe(ws);
                    ws.on('close', () => { job.progress = Math.round((done / Math.max(files.length, 1)) * 100); zipfile.readEntry(); });
                    ws.on('error', reject);
                  } catch (e3) { reject(e3); }
                });
              });
              zipfile.on('end', resolve);
              zipfile.on('error', reject);
              zipfile.readEntry();
            });
          });
        } else if (/\.(tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/.test(lower)) {
          let bytes = 0, count = 0;
          await new Promise((resolve, reject) => {
            const ex = tarExtract();
            ex.on('entry', async (header, s, cb) => {
              try {
                if (!filter(header.name)) { s.resume(); return cb(); }
                bytes += header.size || 0;
                if (bytes > capBytes) return reject(err(400, '解压总量超过上限，已终止（疑似压缩炸弹）'));
                if (++count > capCount) return reject(err(400, '解压文件数量超过上限，已终止'));
                job.progress = Math.min(95, count % 100);
                if (header.type === 'directory') { await fsp.mkdir(await mkFile(header.name), { recursive: true }); s.resume(); return cb(); }
                const out = await mkFile(header.name);
                const ws = fs.createWriteStream(out);
                s.pipe(ws);
                ws.on('close', () => cb());
                ws.on('error', cb);
              } catch (e) { reject(e); }
            });
            ex.on('finish', resolve);
            ex.on('error', reject);
            decompressStream(lower, archiveAbs).then((s) => s.pipe(ex)).catch(reject);
          });
        } else if (lower.endsWith('.gz')) {
          const out = await mkFile(path.basename(archiveAbs).replace(/\.gz$/i, ''));
          await fsp.writeFile(out, await fsp.readFile(archiveAbs).then((b) => zlib.gunzipSync(b)));
        } else if (/\.(bz2|xz|7z|rar)$/.test(lower)) {
          const tools = { '.bz2': 'bunzip2', '.xz': 'xz', '.7z': '7z', '.rar': 'unrar' };
          const extKey = Object.keys(tools).find((k) => lower.endsWith(k));
          const tool = tools[extKey];
          if (!(await toolExists(tool))) throw err(400, `缺少系统组件 ${tool}，无法解压该格式（请安装后重试）`);
          if (extKey === '.7z' || extKey === '.rar') {
            await new Promise((resolve, reject) => {
              const args = extKey === '.7z' ? ['x', `-o${dest}`, '-y', archiveAbs] : ['x', '-y', archiveAbs, `${dest}/`];
              const c = spawn(tool, args);
              let stderr = '';
              c.stderr.on('data', (d) => { stderr += d; });
              c.on('close', (code) => (code === 0 ? resolve() : reject(err(400, `解压失败：${stderr.slice(-300)}`))));
              c.on('error', reject);
            });
          } else {
            const out = await mkFile(path.basename(archiveAbs).replace(/\.(bz2|xz)$/i, ''));
            await new Promise((resolve, reject) => {
              const c = spawn(tool, ['-d', '-k', '-c', archiveAbs]);
              const ws = fs.createWriteStream(out);
              c.stdout.pipe(ws);
              c.on('close', (code) => (code === 0 ? resolve() : reject(err(400, `${tool} 解压失败`))));
              c.on('error', reject);
            });
          }
        } else {
          throw err(400, '不支持的压缩格式');
        }
        job.status = 'done'; job.progress = 100; job.resultRel = toRel(dest);
      } catch (e) {
        job.status = 'error'; job.error = e.status ? e.message : `解压失败：${e.message}`;
      }
    })();
  } catch (e) { next(e); }
});
