import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLogin } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 「关于本系统」铭牌用到的实时数据。
 *
 * 为什么单独一个接口：/api/state 没有鉴权（未登录也要能查初始化状态），
 * 内存占用、主目录、进程时长这些不该跟着它裸奔出去。这个路由整体挂 requireLogin，
 * 和 fs.js 的做法一致。
 *
 * 这里只放**会变**的值。版本号来自 /api/state（config.version → 根 package.json），
 * 文件根目录 / 端口这类静态信息在 /api/about，别在两边各抄一份。
 */
export const systemRouter = Router();
systemRouter.use(requireLogin);

/**
 * 读一次 .git/HEAD 并缓存：部署机是 git 检出，进程运行期间 HEAD 不会变
 * （升级 = 重新部署 + 重启）。拿不到就返回 null —— 前端显示「—」，绝不编一个。
 *
 * 从本文件所在目录向上找 .git：进程 cwd 可能是 server/、仓库根或别处，
 * 不能假设 cwd 就是检出根。也支持 worktree / submodule 的 .git 文件（gitdir: ...）。
 */
function resolveGitDir(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      // worktree：.git 是文本文件，内容形如 `gitdir: /path/to/repo/.git/worktrees/x`
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) return path.resolve(dir, m[1].trim());
        return null;
      }
    } catch { /* 这一层没有 .git，继续往上 */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function readCommit(start) {
  try {
    const gitDir = resolveGitDir(start);
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null; // detached HEAD
    const refName = ref[1].trim();
    try {
      const sha = fs.readFileSync(path.join(gitDir, ...refName.split('/')), 'utf8').trim();
      return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null;
    } catch {
      // 分支刚提交、ref 还没有独立文件时会落在 packed-refs 里
      try {
        for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
          const m = /^([0-9a-f]{7,40})\s+(.+)$/.exec(line.trim());
          if (m && m[2] === refName) return m[1].slice(0, 7);
        }
      } catch { /* 没有 packed-refs */ }
      return null;
    }
  } catch {
    return null;
  }
}

const COMMIT = readCommit(__dirname);
// 启动时刻只算一次：按请求反推的话，每次都会因 uptime 取整抖动几百毫秒，
// 而铭牌上的「启动于」是个固定事实。
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

systemRouter.get('/system', (req, res) => {
  const uptimeSec = Math.round(process.uptime());
  const mem = process.memoryUsage();
  res.json({
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    nodeVersion: process.version,
    os: { totalmem: os.totalmem(), freemem: os.freemem() },
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    platform: process.platform,
    commit: COMMIT,
  });
});
