import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import { spawn as cpSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { getDB } from './db.js';
import { config, toAbs, defaultCwd } from './config.js';

// 优先使用 node-pty（完整 TTY 语义）；未安装时退化为管道 shell
let pty = null;
try { pty = (await import('node-pty')).default; } catch { /* fallback below */ }

// ConPTY DLL 路径不会调用 node-pty 里有缺陷的 _getConsoleProcessList()；
// Windows 10 1903（18362）+ 才支持，旧系统继续走默认路径并由下面的生命周期保护兜底。
function preferConptyDll() {
  if (process.platform !== 'win32') return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(os.release());
  return m ? Number(m[3]) >= 18362 : false;
}

function sessionFromRequest(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.cloudnine_sid;
  const s = token && getDB().sessions[token];
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

export function setupTerminal(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/term')) return;
    if (!sessionFromRequest(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let proc = null;
    let closed = false;
    let exited = false;
    let ready = false;
    let pendingKill = null;
    const outBuf = [];
    let outTimer = null;

    const flush = () => {
      if (!outBuf.length) return;
      // 必须先合并原始字节再整体编码：分别编码会因块长度非 3 的倍数产生非法 base64
      const data = Buffer.concat(outBuf).toString('base64');
      outBuf.length = 0;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'out', data }));
    };
    const killProc = (p) => {
      if (!p || exited) return;
      try { p.isPipe ? p.child.kill() : p.kill(); } catch { /* 忽略同步错误 */ }
    };
    const cancelPendingKill = () => {
      if (!pendingKill) return;
      clearTimeout(pendingKill.timer);
      pendingKill = null;
    };
    // node-pty 在收到首帧数据前 kill 会排队到 ready 后执行；若 shell 在 ready 前
    // 已自行退出，那个延迟 kill 会落到已消失的 PID 上（ConPTY 的 AttachConsole failed）。
    // 所以这里自己等 ready / exit，保证不对已退出的 PTY 再调用 kill。
    const terminate = () => {
      if (!proc) return; // stop 与 close 可能连着来，已经在终止流程里就不要重复调度
      const p = proc;
      proc = null;
      if (exited) return;
      if (p.isPipe || ready || process.platform !== 'win32') return killProc(p);
      const timer = setTimeout(() => {
        if (pendingKill?.proc === p) { pendingKill = null; killProc(p); }
      }, 2000);
      timer.unref?.();
      pendingKill = { proc: p, timer };
    };
    // node-pty onData 传入 string，child_process 传入 Buffer，统一转 Buffer 再编码
    const onData = (chunk) => {
      ready = true;
      if (pendingKill) {
        const p = pendingKill.proc;
        cancelPendingKill();
        killProc(p);
      }
      outBuf.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
      if (!outTimer) outTimer = setTimeout(() => { outTimer = null; flush(); }, 12);
    };
    const onExit = (code) => {
      if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
      closed = true;
      exited = true;
      cancelPendingKill();
      proc = null;
    };

    ws.on('message', (raw) => {
      if (closed) return;
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === 'start' && !proc) {
        const shell = config.defaultShell;
        // 访达/右键携带的目录优先；否则用默认工作目录（用户主目录或文件根目录）
        // 不可传 undefined —— 那会让 PTY 继承服务端进程目录（安装目录）
        let cwdAbs = msg.cwd ? toAbs(msg.cwd) : defaultCwd();
        try {
          if (!fs.existsSync(cwdAbs) || !fs.statSync(cwdAbs).isDirectory()) cwdAbs = defaultCwd();
        } catch { cwdAbs = defaultCwd(); }
        const env = { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8', COLORTERM: 'truecolor' };
        const cols = Math.max(2, Number(msg.cols) || 80);
        const rows = Math.max(2, Number(msg.rows) || 24);
        try {
          if (pty) {
            const opts = { name: 'xterm-256color', cols, rows, cwd: cwdAbs, env };
            if (preferConptyDll()) opts.useConptyDll = true;
            let p;
            try {
              p = pty.spawn(shell, [], opts);
            } catch (e) {
              // 少数系统虽然版本号够但缺少 ConPTY.dll，退回默认实现
              if (!opts.useConptyDll) throw e;
              delete opts.useConptyDll;
              p = pty.spawn(shell, [], opts);
            }
            proc = p;
            p.onData(onData);
            p.onExit(({ exitCode }) => onExit(exitCode));
          } else {
            const c = cpSpawn(shell, process.platform === 'win32' ? [] : ['-i'], { cwd: cwdAbs, env });
            proc = { isPipe: true, child: c };
            c.stdout.on('data', onData);
            c.stderr.on('data', onData);
            c.on('exit', (code) => onExit(code));
            c.on('error', () => onExit(-1));
          }
          if (config.auditCommands) {
            console.log('[terminal:audit]', JSON.stringify({ startedAt: new Date().toISOString(), ip: req.socket.remoteAddress, shell }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: 'exit', error: `无法启动 Shell：${e.message}` }));
        }
        return;
      }

      if (!proc) return;
      if (msg.type === 'in' && msg.data) {
        const buf = Buffer.from(msg.data, 'base64');
        if (proc.isPipe) proc.child.stdin.write(buf);
        else proc.write(buf);
      } else if (msg.type === 'resize') {
        const cols = Math.max(2, Number(msg.cols) || 80);
        const rows = Math.max(2, Number(msg.rows) || 24);
        if (!proc.isPipe && proc.resize) proc.resize(cols, rows);
      } else if (msg.type === 'stop') {
        terminate();
      }
    });

    ws.on('close', () => {
      try { clearTimeout(outTimer); flush(); } catch { /* 忽略 */ }
      terminate();
    });
    ws.on('error', () => {});
  });

  return wss;
}
