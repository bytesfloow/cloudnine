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

// ================= 流错误的统一处理 =================
// 裸 pipe() 不转发错误：源流报错时如果没有人监听 'error'，Node 会把它当成未捕获异常，
// 整个进程直接退出（这些链路大多跑在流回调里，index.js 的 next(e) 根本接不到）。
// 因此本文件里每条 pipe 都必须做到三件事：
//   1. 源流 'error' → dest.destroy(e)，让错误只有一个出口；
//   2. dest 'error' → 只处理一次（onceError）；
//   3. 失败后把已经写了一半的文件清掉。
function onceError(fn) {
  let called = false;
  return (e) => { if (called) return; called = true; fn(e); };
}

/** 关掉写流并等它真的关闭（Windows 上文件句柄没释放就删不掉半成品），最多等 1 秒 */
function closeWriter(s) {
  return new Promise((resolve) => {
    if (!s || s.destroyed) return resolve();
    const t = setTimeout(resolve, 1000);
    s.once('close', () => { clearTimeout(t); resolve(); });
    s.destroy();
  });
}

/** 把一个可读流写进文件：成功 resolve，失败（含源头错误）reject，且不会漏掉 'error' 事件 */
function writeEntry(src, out) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(out);
    const fail = onceError((e) => { closeWriter(ws).then(() => reject(e)); });
    src.on('error', (e) => ws.destroy(e)); // 源头错误（zip 条目数据损坏、tar 截断）统一交给写流
    ws.on('error', fail);
    ws.on('finish', () => resolve());
    src.pipe(ws);
  });
}

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

// ---------- 启动自愈：清理进程中断遗留的压缩临时文件（*.cloudnine-tmp，无点前缀；上传 tmp 带点前缀+uid 不受影响） ----------
export async function cleanOrphanTmp() {
  const root = config.fileRoot;
  const walk = async (dir, depth) => {
    if (depth > 8) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { await walk(full, depth + 1); continue; }
      if (it.name.endsWith('.cloudnine-tmp')) {
        await fsp.rm(full, { force: true }).catch(() => {});
        console.log(`[media] 清理遗留临时文件: ${toRel(full)}`);
      }
    }
  };
  await walk(root, 0);
}

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
      let ws = null; // 失败清理时要用，所以声明在 try 外面
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
        archive.on('entry', () => { done++; job.progress = total ? Math.round((done / total) * 100) : 0; });
        // 先挂监听再 pipe：两者之间不能留出「错误没人管」的空档。
        // 以前是 pipe 之后才 ws.on('error')，中间那段（下面每项 lstat 的 await）一旦写盘出错就是未捕获异常。
        ws = fs.createWriteStream(tmpOut);
        const written = new Promise((resolve, reject) => {
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
        // 压缩器出错（源文件读不到等）→ 转成写流的 error，走同一个出口
        archive.on('error', (e) => ws.destroy(e));
        archive.pipe(ws);
        for (const rel of paths) {
          const abs = safeJoin(config.fileRoot, rel);
          const st = await fsp.lstat(abs);
          if (st.isDirectory()) archive.directory(abs, path.basename(abs));
          else if (st.isFile()) archive.file(abs, { name: path.basename(abs) });
        }
        await archive.finalize();
        await written;
        await fsp.rename(tmpOut, outAbs);
        job.status = 'done'; job.progress = 100; job.resultRel = toRel(outAbs);
      } catch (e) {
        job.status = 'error'; job.error = e.message;
        // 先停写流并等句柄释放，再删半成品压缩包（否则 Windows 上删不掉）
        await closeWriter(ws);
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
        const src = await decompressStream(abs.toLowerCase(), abs);
        const ex = tarExtract();
        let settled = false;
        const done = new Promise((resolve, reject) => {
          ex.on('entry', (header, s, cb) => {
            entries.push({ name: header.name, size: header.size, dir: header.type === 'directory' });
            s.on('error', (e) => ex.destroy(e)); // 条目流自己的错误也要抬上来，不能沉默
            s.resume();
            cb();
          });
          ex.on('finish', () => { if (!settled) { settled = true; resolve(); } });
          ex.on('close', () => { if (!settled) { settled = true; resolve(); } });
          ex.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
        });
        // 这里的错误以前是接不到的：.catch(reject) 只接 Promise，接不到流的 'error' 事件。
        // 头部截断的 .tar.gz 会让 gunzip 抛错且没人监听 → 直接崩进程。
        src.on('error', (e) => ex.destroy(e));
        src.pipe(ex);
        await done;
      } catch (e) { throw e.status ? e : err(400, '无法读取压缩包（可能已损坏或格式不受支持）'); }
      return res.json({ entries });
    }
    throw err(400, '暂不支持在线浏览该格式包内列表');
  } catch (e) { next(e); }
});

// ---------- 解压 ----------
/** 解压链里的错误文案：zlib / tar-stream 的原始报错是英文的，换成使用者看得懂的中文 */
function archiveErrMsg(e) {
  const m = String(e?.message || e || '');
  if (/unexpected end of (file|stream)|incorrect header check|invalid (distance|code|uncompressed)|Z_BUF_ERROR|invalid tar header|bad archive/i.test(m)) {
    return '压缩包数据不完整或已损坏（可能上传/下载中断，或压缩包本身已损坏）';
  }
  return m;
}

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
  // 先确认文件真的能读：createReadStream 的 ENOENT 是异步事件，等到没人监听的时刻就更麻烦
  const st = await fsp.stat(abs).catch((e) => {
    throw e.code === 'ENOENT' ? err(404, '压缩包不存在') : err(400, `无法读取压缩包（${e.code || e.message}）`);
  });
  if (!st.isFile()) throw err(400, '不是普通文件');
  if (/\.gz$/.test(lower)) {
    const rs = fs.createReadStream(abs);
    const gz = zlib.createGunzip();
    // 读盘中途出错（磁盘错误、文件被外部删掉）要传给下游，否则是未处理的 'error'
    rs.on('error', (e) => gz.destroy(e));
    return rs.pipe(gz);
  }
  if (/\.bz2$/.test(lower)) {
    if (!(await toolExists('bunzip2'))) throw err(400, '缺少系统组件 bunzip2，无法处理 bz2 格式');
    return spawnDecompressor('bunzip2', ['-d', '-c', abs]);
  }
  if (/\.xz$/.test(lower)) {
    if (!(await toolExists('xz'))) throw err(400, '缺少系统组件 xz，无法处理 xz 格式');
    return spawnDecompressor('xz', ['-d', '-c', abs]);
  }
  return fs.createReadStream(abs);
}

/** 起一个系统解压工具，把它的 stdout 当成可读流返回；子进程的错误必须转成流上的 error */
function spawnDecompressor(tool, args) {
  const c = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  c.stderr.on('data', () => {});
  // 子进程起不来（组件被卸载 / 权限不足）：不转成流错误就是未捕获的 'error' → 崩进程
  c.on('error', (e) => c.stdout.destroy(err(400, `无法启动系统组件 ${tool}（${e.code || e.message}）`)));
  // 退出码非 0 = 数据损坏或中途失败：下游拿到的是截断数据，必须报错而不是当正常结束
  c.on('close', (code) => { if (code !== 0) c.stdout.destroy(err(400, `${tool} 解压失败（退出码 ${code}），压缩包可能已损坏`)); });
  return c.stdout;
}

mediaRouter.post('/archive/extract', async (req, res, next) => {
  try {
    const { path: archiveRel, destDir = '', intoSubdir = true, entries: onlyEntries } = req.body || {};
    const archiveAbs = safeJoin(config.fileRoot, archiveRel);
    const lower = archiveAbs.toLowerCase();
    let dest = safeJoin(config.fileRoot, destDir || toRel(path.dirname(archiveAbs)));
    if (intoSubdir) dest = path.join(dest, path.basename(archiveAbs).replace(/\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|gz|bz2|xz|7z|rar)$/i, ''));
    // dest 是不是本次新建的：失败回滚时，自己新建的目录可以整个删掉
    const destWasCreated = !fs.existsSync(dest);
    await fsp.mkdir(dest, { recursive: true });

    const job = newJob('extract', `解压 ${path.basename(archiveAbs)}`);
    res.json({ ok: true, jobId: job.id, destRel: toRel(dest) });

    const capBytes = config.maxExtractMB * 1024 * 1024;
    const capCount = 100000;
    const filter = (name) => {
      if (!onlyEntries || !onlyEntries.length) return true;
      return onlyEntries.some((x) => name === x || name.startsWith(x.endsWith('/') ? x : x + '/'));
    };
    // 本次解压写到磁盘的路径。失败时按这份清单回滚：
    // 以前失败只把 job 标成 error，半个压缩包 / 半个解压结果就永远留在目录里。
    const written = [];
    const createdDirs = [];
    const cleanupPartial = async () => {
      try {
        // dest 是我们刚建的目录 → 整个删掉最干净（7z/rar 自己写字，无法逐项跟踪）
        if (destWasCreated) return await fsp.rm(dest, { recursive: true, force: true });
        for (const f of written) await fsp.rm(f, { recursive: true, force: true }).catch(() => {});
        for (const d of createdDirs.slice().reverse()) await fsp.rmdir(d).catch(() => {});
      } catch (e2) {
        console.error('[media] 清理解压残留失败:', e2.message);
      }
    };
    const mkFile = async (name) => {
      const safe = sanitizeEntryName(name);
      const out = safeJoin(dest, safe);
      const dir = path.dirname(out);
      if (!fs.existsSync(dir)) createdDirs.push(dir);
      await fsp.mkdir(dir, { recursive: true });
      written.push(out);
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
              if (e) return reject(err(400, '无法读取压缩包（可能已损坏或格式不受支持）'));
              let settled = false;
              // 出错后立即停止读条目：否则 zipfile 会继续解压，和失败清理互相踩
              const fail = onceError((e2) => {
                settled = true;
                try { zipfile.close(); } catch { /* 已经关了 */ }
                reject(e2);
              });
              zipfile.on('entry', (entry) => {
                if (settled) return;
                if (/\/$/.test(entry.fileName) || !filter(entry.fileName)) return zipfile.readEntry();
                bytes += entry.uncompressedSize;
                if (bytes > capBytes) return fail(err(400, '解压总量超过上限，已终止（疑似压缩炸弹）'));
                if (++done > capCount) return fail(err(400, '解压文件数量超过上限，已终止'));
                zipfile.openReadStream(entry, (e2, rs) => {
                  if (e2) return fail(e2);
                  (async () => {
                    const out = await mkFile(entry.fileName);
                    // 以前条目流出错（zip 数据损坏）没人监听 'error' → 未捕获异常崩进程
                    await writeEntry(rs, out);
                    if (settled) return;
                    job.progress = Math.round((done / Math.max(files.length, 1)) * 100);
                    zipfile.readEntry();
                  })().catch(fail);
                });
              });
              zipfile.on('end', () => { if (!settled) { settled = true; resolve(); } });
              zipfile.on('error', fail);
              zipfile.readEntry();
            });
          });
        } else if (/\.(tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/.test(lower)) {
          let bytes = 0, count = 0;
          const ex = tarExtract();
          let src = null;
          let settled = false;
          const finished = new Promise((resolve, reject) => {
            const fail = onceError((e) => {
              settled = true;
              reject(e);
              if (src) src.destroy();
              ex.destroy();
            });
            ex.on('entry', (header, s, cb) => {
              if (settled) { s.resume(); return cb(); }
              (async () => {
                if (!filter(header.name)) { s.resume(); return cb(); }
                bytes += header.size || 0;
                if (bytes > capBytes) throw err(400, '解压总量超过上限，已终止（疑似压缩炸弹）');
                if (++count > capCount) throw err(400, '解压文件数量超过上限，已终止');
                job.progress = Math.min(95, count % 100);
                if (header.type === 'directory') { await fsp.mkdir(await mkFile(header.name), { recursive: true }); s.resume(); return cb(); }
                const out = await mkFile(header.name);
                // 以前 s.pipe(ws) 没挂 s 的 'error'，tar 数据截断时就是未捕异常
                await writeEntry(s, out);
                cb();
              })().catch((e) => {
                s.resume();
                fail(e); // 自己抬到 fail，不指望 tar-stream 一定会把 cb(err) 转成 'error'
                try { cb(e); } catch { /* 已经结束 */ }
              });
            });
            ex.on('finish', () => { if (!settled) { settled = true; resolve(); } });
            ex.on('close', () => { if (!settled) { settled = true; resolve(); } });
            ex.on('error', fail);
          });
          try {
            src = await decompressStream(lower, archiveAbs);
          } catch (e) {
            ex.destroy(); // 还没灌数据就失败：让 finished 结束，别留一个永远 pending 的 Promise
            await finished.catch(() => {});
            throw e;
          }
          // 解压流的错误（gunzip 数据损坏、bunzip2 退出码非 0）必须转发给 tar；
          // 以前 .then((s) => s.pipe(ex)).catch(reject) 接不到流的 'error' 事件
          src.on('error', (e) => ex.destroy(e));
          src.pipe(ex);
          await finished;
        } else if (lower.endsWith('.gz')) {
          // 单文件 .gz：以前是 readFile + gunzipSync —— 先把整个 .gz 读进内存、再同步解压，
          // 一个 1GB 高压缩比的包会先卡死事件循环再 OOM。现在边读边解边写，保留 maxExtractMB 上限。
          const out = await mkFile(path.basename(archiveAbs).replace(/\.gz$/i, ''));
          const rs = fs.createReadStream(archiveAbs);
          const gz = zlib.createGunzip();
          const ws = fs.createWriteStream(out);
          let total = 0;
          await new Promise((resolve, reject) => {
            let settled = false;
            const fail = onceError((e) => {
              settled = true;
              rs.destroy();
              gz.destroy();
              ws.destroy();
              closeWriter(ws).then(() => reject(e)); // 等句柄释放再拒绝，调用方好清半成品
            });
            // 读盘错误、gunzip 错误、写盘错误：三个都接到同一个出口
            rs.on('error', (e) => gz.destroy(e));
            gz.on('error', fail);
            ws.on('error', fail);
            // 压缩炸弹防护：不预先知道解压后多大，只能边解边计数，超限立即中止
            gz.pipe(ws);
            gz.on('data', (chunk) => {
              if (settled) return;
              total += chunk.length;
              if (total > capBytes) fail(err(400, '解压总量超过上限，已终止（疑似压缩炸弹）'));
            });
            ws.on('finish', () => { if (!settled) { settled = true; resolve(); } });
            rs.pipe(gz);
          });
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
              const fail = onceError((e) => { closeWriter(ws).then(() => reject(e)); });
              c.stderr.on('data', () => {});
              // 以前 c.stdout.pipe(ws) 两端都没挂 'error'：写盘失败或工具起不来都直接崩进程；
              // 而且不看退出码，损坏的包会「成功」产出一个截断文件
              c.stdout.on('error', (e) => ws.destroy(e));
              ws.on('error', fail);
              ws.on('finish', () => resolve());
              c.on('error', (e) => fail(err(400, `无法启动系统组件 ${tool}（${e.code || e.message}）`)));
              c.on('close', (code) => { if (code !== 0) fail(err(400, `${tool} 解压失败（退出码 ${code}），压缩包可能已损坏`)); });
              c.stdout.pipe(ws);
            });
          }
        } else {
          throw err(400, '不支持的压缩格式');
        }
        job.status = 'done'; job.progress = 100; job.resultRel = toRel(dest);
      } catch (e) {
        job.status = 'error'; job.error = e.status ? e.message : `解压失败：${archiveErrMsg(e)}`;
        await cleanupPartial(); // 不要留下半个解压结果
      }
    })();
  } catch (e) { next(e); }
});
