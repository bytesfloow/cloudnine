#!/usr/bin/env node
/**
 * CloudNine 统一测试入口（零新依赖，只用 Node 标准库）
 *
 * 为什么要有它：
 *   自测脚本原本散在 scripts/ 里，各写各的端口/临时目录/Chrome 路径，没人记得全跑一遍。
 *   2026-11 两次事故（vite dev 的 /pa 代理漏配、截断读取把整篇 UTF-8 当 GB18030）
 *   都是「那条路径当天没人跑」。这里把它们收成一个命令，并且让「新加一个套件」不用改本文件。
 *
 * 用法：
 *   node scripts/run-tests.mjs                 # 全部套件（串行）
 *   node scripts/run-tests.mjs --list          # 只列套件，不跑
 *   node scripts/run-tests.mjs --only=core,mobile
 *   node scripts/run-tests.mjs --group=plugin
 *   node scripts/run-tests.mjs --no-build      # client/dist 缺失也不自动构建
 *   node scripts/run-tests.mjs --keep          # 保留各套件的临时目录（透传 --keep）
 *   node scripts/run-tests.mjs --json          # 末尾多打一份 JSON（给 CI 用）
 *   node scripts/run-tests.mjs --timeout=1800  # 单个套件超时（秒），默认按类型给
 *
 * 设计约束：
 *   - 串行：套件各自起端口/临时目录，并跑会互相干扰（也抢 CPU，Chrome 会抖）。
 *   - 本进程**不启动**用户的 dev / 生产实例，也永不使用 8480 / 5173。
 *     只有 core / mobile / plugins-smoke 这三个「只吃 --url、自己不起服务」的套件，
 *     才由测试夹具在本进程内起一个临时实例（随机端口 + testroot/ 下的临时目录，跑完杀掉）。
 *   - TEMP/TMP 一律指到 testroot/build-tmp：本机 esbuild 写系统 TEMP 会被 Access is denied。
 *
 * 自动发现规则见 docs/testing.md。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPTS = join(__dirname);
const TESTROOT = join(ROOT, 'testroot');

const C = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
};

// ======================= 参数 =======================

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  if (eq >= 0) return hit.slice(eq + 1);
  const i = argv.indexOf(hit);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : def;
};
const flag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const OPTS = {
  list: flag('list'),
  only: String(arg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
  group: String(arg('group', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
  noBuild: flag('no-build'),
  keep: flag('keep'),
  json: flag('json'),
  timeout: Number(arg('timeout', 0)) || 0,
  help: flag('help') || flag('h'),
};

if (OPTS.help) {
  console.log(`CloudNine 统一测试入口

  --list               列出所有套件（含分组 / 条数 / 依赖），不执行
  --only=a,b           只跑指定套件（id 见 --list）
  --group=core,plugin  只跑指定分组
  --no-build           client/dist 缺失时不自动 npm run build
  --keep               透传 --keep 给套件，保留它们自己的临时目录
  --json               末尾输出 JSON 汇总
  --timeout=<秒>       单个套件超时（默认浏览器套件 900s、非浏览器 300s）
  --help               本帮助`);
  process.exit(0);
}

// ======================= 套件表 =======================
// 自动发现：scripts/uitest*.mjs + scripts/plugins_smoke.py。
// 新套件只要放进去就会被发现；这里只登记「分组」与「是否要 runner 提供临时实例」
// 这类靠文件名猜不出来的信息（猜得出来就走下面的默认值）。

const KNOWN = {
  core: { groups: ['core'], fixture: true, title: '桌面 UI 全集（浏览器）' },
  mobile: { groups: ['core'], fixture: true, title: '移动端 UI 用例（--mobile）' },
  plugins: { groups: ['plugin'], title: '插件外壳接入（沙箱 / 协议 / 主题注入）' },
  todo: { groups: ['plugin'], title: '示例插件 todo 端到端' },
  openwith: { groups: ['plugin'], title: '文件关联 / 打开方式 / markDirty' },
  'json-plugin': { groups: ['plugin'], title: '示例插件 json 端到端' },
  'md-plugin': { groups: ['plugin'], title: '示例插件 markdown 端到端' },
  'dev-plugin': { groups: ['plugin'], title: 'vite dev 代理 + 插件开窗（dev 模式）' },
  'plugins-smoke': { groups: ['plugin', 'express'], fixture: true, python: true, title: '插件服务端 API 冒烟（python）' },
  'encoding-truncation': { groups: ['express'], title: '读取解码 / 截断（大文件中不乱码）' },
};

// 未知套件的启发式：先看文件头 40 行里的 `@group` 注释，再按文件名猜。
function guessGroups(id, idLower, head) {
  const m = head.match(/@group\s+([a-z0-9,_-]+)/i);
  if (m) return m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (/plugin|openwith|todo|extension/.test(idLower)) return ['plugin'];
  if (/encoding|smoke|api|server|express/.test(idLower)) return ['express'];
  return ['core'];
}

// 默认端口：直接从脚本源码里读 `Number(arg('port', N))` / `arg('vite-port', N)`，
// **不是手抄的常量表** —— 套件改了端口，这里跟着变，不会静默漂。
// 自己不起服务的套件（夹具/ python 冒烟）没有声明端口，返回空数组。
function detectPorts(file) {
  let src = '';
  try { src = readFileSync(join(SCRIPTS, file), 'utf8'); } catch { return []; }
  const ports = [];
  for (const m of src.matchAll(/arg\(\s*'(?:vite-)?port'\s*,\s*(\d{2,5})\s*\)/g)) {
    const n = Number(m[1]);
    if (!ports.includes(n)) ports.push(n);
  }
  return ports;
}

function discover() {
  const suites = [];
  const files = readdirSync(SCRIPTS).filter((n) => /^uitest.*\.mjs$/.test(n)).sort();
  for (const file of files) {
    const id = file === 'uitest.mjs'
      ? 'core'
      : file.replace(/^uitest-/, '').replace(/\.mjs$/, '');
    const known = KNOWN[id] || {};
    const head = readFileSync(join(SCRIPTS, file), 'utf8').slice(0, 4000);
    suites.push({
      id,
      file,
      kind: 'node',
      args: [],
      needsFixture: !!known.fixture || /@needs-fixture/i.test(head),
      ports: detectPorts(file),
      groups: known.groups || guessGroups(id, id.toLowerCase(), head),
      title: known.title || firstDocLine(head) || file,
    });
    // 移动端是同一个文件的另一条路：作为独立条目注册（分组仍属 core）
    if (id === 'core') {
      const mk = KNOWN.mobile;
      suites.push({
        id: 'mobile',
        file,
        kind: 'node',
        args: ['--mobile'],
        needsFixture: true,
        ports: [],
        groups: mk.groups,
        title: mk.title,
      });
    }
  }
  if (existsSync(join(SCRIPTS, 'plugins_smoke.py'))) {
    const known = KNOWN['plugins-smoke'];
    suites.push({
      id: 'plugins-smoke',
      file: 'plugins_smoke.py',
      kind: 'python',
      args: [],
      needsFixture: true,
      ports: [],
      groups: known.groups,
      title: known.title,
    });
  }
  return suites;
}

function firstDocLine(head) {
  const lines = head.split('\n');
  // 文件头第一行 `*` 开头的非空说明文字（跳过 shebang / 标题行）
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/^\s*\*?\s?/, '').trim();
    if (t && !t.startsWith('#!/') && !/^CloudNine/.test(t)) return t.slice(0, 60);
  }
  return '';
}

let SUITES = discover();

function select(suites) {
  let out = suites;
  if (OPTS.only.length) {
    const want = new Set(OPTS.only.map((s) => s.toLowerCase()));
    const unknown = OPTS.only.filter((s) => !suites.some((x) => x.id.toLowerCase() === s.toLowerCase()));
    if (unknown.length) {
      console.error(`${C.red}未知套件：${unknown.join(', ')}${C.reset}`);
      console.error(`${C.dim}可选：${suites.map((s) => s.id).join(', ')}${C.reset}`);
      process.exit(1);
    }
    out = out.filter((s) => want.has(s.id.toLowerCase()));
  }
  if (OPTS.group.length) {
    const want = new Set(OPTS.group.map((s) => s.toLowerCase()));
    const unknown = OPTS.group.filter((g) => !suites.some((s) => s.groups.includes(g.toLowerCase())));
    if (unknown.length) {
      console.error(`${C.red}未知分组：${unknown.join(', ')}${C.reset}`);
      console.error(`${C.dim}可选：${[...new Set(suites.flatMap((s) => s.groups))].join(', ')}${C.reset}`);
      process.exit(1);
    }
    out = out.filter((s) => s.groups.some((g) => want.has(g)));
  }
  return out;
}

// ======================= 小工具 =======================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// 子进程登记表：Ctrl-C 时要连夹具实例一起收干净，不能留一个占着端口的后端
const ACTIVE = new Set();

// 终端里对齐中文：CJK / 全角算两列
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));

function tail(lines, n) {
  return lines.slice(Math.max(0, lines.length - n));
}

// ======================= 预检 =======================

const ENV = { ...process.env };

// TEMP/TMP 落在仓库内（gitignored）：本机 esbuild 删系统 TEMP 里的临时文件会被拒
const BUILD_TMP = join(TESTROOT, 'build-tmp');
mkdirSync(BUILD_TMP, { recursive: true });
ENV.TEMP = BUILD_TMP;
ENV.TMP = BUILD_TMP;
ENV.CI = '1';
// python 子套件：Windows 控制台默认 cp936，管道里读到的是 GBK 字节 → 中文全乱、
// 而且汇总行解析不出来（条数会被当成 0/0）
ENV.PYTHONIOENCODING = 'utf-8';
ENV.PYTHONUTF8 = '1';
// 让子进程的 npm/子套件知道自己在统一 runner 下（脚本不依赖它，只用于日志排查）
ENV.CLOUDNINE_TEST_RUNNER = '1';

function findChrome() {
  const explicit = ENV.CLOUDNINE_TEST_CHROME || ENV.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [ENV['PROGRAMFILES'], ENV['PROGRAMFILES(X86)'], ENV['LOCALAPPDATA']]) {
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.find((p) => p && existsSync(p)) || null;
}

function findPuppeteer() {
  const candidates = [
    ENV.PUPPETEER_CORE,
    resolve(ROOT, '..', '.uitest', 'node_modules', 'puppeteer-core'),
    resolve(ROOT, 'node_modules', 'puppeteer-core'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(join(p, 'package.json'))) || null;
}

function findPython() {
  if (ENV.CLOUDNINE_TEST_PYTHON) return ENV.CLOUDNINE_TEST_PYTHON;
  for (const exe of ['python', 'python3', 'py']) {
    const r = spawnSync(exe, ['--version'], { stdio: 'ignore', windowsHide: true });
    if (r && r.status === 0) return exe;
  }
  return null;
}

// ======================= 临时实例夹具 =======================
// 只有「自己不起服务、只吃 --url」的套件（core / mobile / plugins-smoke）需要它。
// 端口随机（且绝不等于 8480 / 5173），数据目录在 testroot/ 下，跑完整棵删掉。

async function pickPort(banned) {
  for (let i = 0; i < 40; i++) {
    const port = await new Promise((res) => {
      const srv = net.createServer();
      srv.once('error', () => res(0));
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => res(p));
      });
    });
    if (port && !banned.includes(port)) return port;
  }
  throw new Error('找不到可用端口');
}

// ======================= 端口预检 =======================
// 套件的默认端口（8599 / 8733 …）是写死的。如果上一个实例没清掉，新实例会
// 「跑在别人的服务上」：初始计数不为 0、断言对着旧数据跑，看着绿其实是假绿。
// 所以开跑前先探一下，占了就 fail-fast，不静默继续。
async function portInUse(port) {
  return await new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(true));      // EADDRINUSE / EACCES 都当「不能用」
    srv.once('listening', () => srv.close(() => res(false)));
    srv.listen({ port, host: '0.0.0.0', exclusive: true });
  });
}

async function blockedPorts(suite) {
  const busy = [];
  for (const port of suite.ports) {
    if (await portInUse(port)) busy.push(port);
  }
  return busy;
}

async function waitHttp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function startFixture(logLabel) {
  const dir = join(TESTROOT, `runner-${stamp()}-${Math.random().toString(36).slice(2, 7)}`);
  const dataDir = join(dir, 'data');
  const fileRoot = join(dir, 'files');
  const buildTmp = join(dir, 'tmp');
  for (const d of [dataDir, fileRoot, buildTmp, join(fileRoot, 'docs')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fileRoot, 'readme.txt'), 'cloudnine test fixture\n');
  writeFileSync(join(fileRoot, 'docs', 'note.txt'), 'fixture doc\n');

  const port = await pickPort([8480, 5173]);
  const logFile = join(dir, 'server.log');
  const logLines = [];
  const child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...ENV,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      FILE_ROOT: fileRoot,
      PLUGINS_DIR: join(dataDir, 'plugins'),
      PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
      // 本机默认 shell 是 cmd.exe，套件里的 `touch` / readline ^V 用例会假失败；
      // 有 WSL bash 就显式指过去（用户自己设了 SHELL 就尊重用户）
      ...(process.platform === 'win32' && !ENV.SHELL && existsSync('C:\\Windows\\System32\\wsl.exe')
        ? { SHELL: 'C:\\Windows\\System32\\wsl.exe' }
        : {}),
      TEMP: buildTmp,
      TMP: buildTmp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const onData = (buf) => {
    const s = String(buf);
    logLines.push(...s.split(/\r?\n/).filter(Boolean));
    if (logLines.length > 4000) logLines.splice(0, logLines.length - 4000);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  ACTIVE.add(child.pid);
  child.once('exit', () => ACTIVE.delete(child.pid));

  const url = `http://127.0.0.1:${port}/`;
  const ready = await waitHttp(`${url}api/state`, 90000);
  try { writeFileSync(logFile, logLines.join('\n')); } catch { /* 忽略 */ }

  const stop = async () => {
    try { killTree(child.pid); } catch { /* 忽略 */ }
    await sleep(300);
    if (!OPTS.keep) {
      for (let i = 0; i < 10; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); }
      }
    } else {
      console.log(`${C.dim}    夹具保留：${dir}${C.reset}`);
    }
  };

  if (!ready) {
    console.log(`${C.red}夹具实例起不来（${logLabel}）：${url}${C.reset}`);
    for (const l of tail(logLines, 20)) console.log(`${C.dim}    ${l}${C.reset}`);
    await stop();
    return null;
  }
  return { url, port, dir, extra: { PLUGINS_DIR: join(dataDir, 'plugins'), FILE_ROOT: fileRoot }, logLines, stop };
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* 忽略 */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ } }
}

// ======================= 运行一个套件 =======================

const DEFAULT_TIMEOUT = { node: 900, python: 300 };

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function parseCounts(raw) {
  const text = stripAnsi(raw);
  let m;
  // uitest.mjs 全绿：`全部通过 454/454` / 有失败：`失败 3/454`
  if ((m = text.match(/全部通过\s+(\d+)\s*\/\s*(\d+)/))) return { passed: +m[1], total: +m[2] };
  if ((m = text.match(/失败\s+(\d+)\s*\/\s*(\d+)/))) return { passed: +m[2] - +m[1], total: +m[2] };
  // python 冒烟：`结果：61/61 通过，0 失败`
  if ((m = text.match(/(\d+)\s*\/\s*(\d+)\s*通过/))) return { passed: +m[1], total: +m[2] };
  // 插件类套件：`结果  通过 122 · 失败 0`
  if ((m = text.match(/通过\s+(\d+)\s*·\s*失败\s+(\d+)/))) return { passed: +m[1], total: +m[1] + +m[2] };
  return null;
}

function runSuite(suite, index, total) {
  const label = `${index}/${total}`;
  console.log(`\n${C.bold}${C.cyan}▶ ${label} ${suite.id}${C.reset} ${C.dim}(${suite.groups.join('/')}) ${suite.title}${C.reset}`);

  const timeoutSec = OPTS.timeout || DEFAULT_TIMEOUT[suite.kind] || 900;
  const args = suite.kind === 'python'
    ? [join('scripts', suite.file), ...suite.args]
    : [join(SCRIPTS, suite.file), ...suite.args];

  return new Promise((res) => {
    const lines = [];
    const started = Date.now();
    let timedOut = false;
    let child = null;
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      res(payload);
    };

    (async () => {
      // 需要外部实例的套件：runner 起夹具，把 --url / --chrome / 插件目录传进去
      let fixture = null;
      const argvFinal = [...args];
      if (suite.needsFixture) {
        fixture = await startFixture(suite.id);
        if (!fixture) {
          settle({ suite, status: 'fail', reason: '夹具实例启动失败', passed: 0, total: 0, ms: Date.now() - started, code: 1, lines: ['夹具实例启动失败'] });
          return;
        }
        argvFinal.push('--url', fixture.url);
        if (suite.kind === 'python') {
          argvFinal.push('--plugins-dir', fixture.extra.PLUGINS_DIR);
        } else {
          argvFinal.push('--user', 'uitest', '--password', 'Uitest12345');
        }
      }
      if (suite.kind === 'node' && CHROME) argvFinal.push('--chrome', CHROME);
      if (OPTS.keep && suite.kind === 'node') argvFinal.push('--keep');

      const cmd = suite.kind === 'python' ? PYTHON : process.execPath;
      child = spawn(cmd, argvFinal, {
        cwd: ROOT,
        env: ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      const onData = (buf) => {
        const s = String(buf);
        process.stdout.write(s);           // 实时吐出来：浏览器套件一跑几分钟，黑屏最难受
        for (const l of s.split(/\r?\n/)) if (l.trim() !== '') lines.push(l);
        if (lines.length > 8000) lines.splice(0, lines.length - 8000);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      ACTIVE.add(child.pid);
      child.once('exit', () => ACTIVE.delete(child.pid));

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutSec * 1000);

      const done = async (code, signal) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        let status = 'pass';
        let reason = '';
        if (timedOut) { status = 'fail'; reason = `超时 ${timeoutSec}s`; }
        else if (code !== 0) { status = 'fail'; reason = signal ? `被信号 ${signal} 中断` : `退出码 ${code}`; }
        const counts = parseCounts(lines.join('\n'));
        // 套件自己说「通过 N/total」但退出码非 0（或反过来）→ 以退出码为准，但条数照抄
        await (fixture ? fixture.stop() : Promise.resolve());
        settle({ suite, status, reason, ms, code: code ?? -1, ...(counts || { passed: 0, total: 0 }), lines });
      };
      child.on('exit', (code, signal) => { done(code, signal); });
      child.on('error', async (e) => {
        clearTimeout(timer);
        lines.push(`spawn 失败：${e.message}`);
        await (fixture ? fixture.stop() : Promise.resolve());
        settle({ suite, status: 'fail', reason: e.message, passed: 0, total: 0, ms: Date.now() - started, code: -1, lines });
      });
    })().catch(async (e) => {
      settle({ suite, status: 'fail', reason: e.message, passed: 0, total: 0, ms: Date.now() - started, code: -1, lines: [e.message] });
    });
  });
}

// ======================= 主流程 =======================

let CHROME = null;
let PUPPETEER = null;
let PYTHON = null;

function printSuiteList(suites) {
  const rows = suites.map((s) => ({
    id: s.id,
    file: s.file,
    groups: s.groups.join(','),
    ports: s.ports.length ? s.ports.join(',') : '随机',
    needs: s.kind === 'python' ? 'python' : (s.needsFixture ? 'chrome+夹具' : 'chrome'),
  }));
  const w1 = Math.max(6, ...rows.map((r) => width(r.id)));
  const w2 = Math.max(4, ...rows.map((r) => width(r.file)));
  const w3 = Math.max(6, ...rows.map((r) => width(r.groups)));
  const w5 = Math.max(8, ...rows.map((r) => width(r.ports)));
  const w4 = Math.max(4, ...rows.map((r) => width(r.needs)));
  console.log(`${C.bold}${pad('套件', w1)}  ${pad('文件', w2)}  ${pad('分组', w3)}  ${pad('默认端口', w5)}  ${pad('依赖', w4)}  说明${C.reset}`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    console.log(`${pad(r.id, w1)}  ${pad(r.file, w2)}  ${pad(r.groups, w3)}  ${pad(r.ports, w5)}  ${pad(r.needs, w4)}  ${C.dim}${suites[i].title}${C.reset}`);
  }
  const groups = [...new Set(suites.flatMap((s) => s.groups))];
  console.log(`\n${C.dim}共 ${suites.length} 个套件 · 分组：${groups.join(' / ')}${C.reset}`);
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    console.error(`${C.red}Node.js ${process.version} 太老：CloudNine 需要 ≥ 18${C.reset}`);
    process.exit(1);
  }

  SUITES = select(SUITES);

  if (OPTS.list) {
    console.log(`${C.bold}CloudNine 测试套件${C.reset}\n`);
    printSuiteList(SUITES);
    return 0;
  }

  CHROME = findChrome();
  PUPPETEER = findPuppeteer();
  if (PUPPETEER && !ENV.PUPPETEER_CORE) ENV.PUPPETEER_CORE = PUPPETEER;
  PYTHON = findPython();

  // 预检信息：一眼看出这台机器缺什么
  const mark = (ok, text) => `${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${text}`;
  console.log(`${C.bold}CloudNine 测试入口${C.reset}`);
  console.log(`  ${mark(true, `Node ${process.version}`)}   ${mark(!!CHROME, CHROME ? `Chrome ${CHROME}` : '未找到 Chrome（浏览器套件将被跳过）')}`);
  console.log(`  ${mark(!!PUPPETEER, PUPPETEER ? `puppeteer-core ${PUPPETEER}` : '未找到 puppeteer-core（浏览器套件将被跳过）')}   ${mark(!!PYTHON, PYTHON ? `python ${PYTHON}` : '未找到 python（plugins-smoke 将被跳过）')}`);

  const browserOk = !!(CHROME && PUPPETEER);

  // client/dist：不存在就自动构建（--no-build 时只警告）
  const distExisted = existsSync(join(ROOT, 'client', 'dist'));
  if (!distExisted) {
    if (OPTS.noBuild) {
      console.log(`  ${C.yellow}!${C.reset} client/dist 不存在（--no-build：不构建，生产构建类套件会失败）`);
    } else {
      console.log(`\n${C.bold}client/dist 不存在 → npm run build${C.reset}`);
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(npm, ['run', 'build'], { cwd: ROOT, env: ENV, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) {
        console.error(`${C.red}构建失败（退出码 ${r.status}），无法继续${C.reset}`);
        process.exit(1);
      }
    }
  } else {
    console.log(`  ${C.dim}client/dist 已存在，跳过构建${C.reset}`);
  }

  const results = [];
  let i = 0;
  for (const suite of SUITES) {
    i++;
    // 依赖不满足 → 明确跳过；全跳过也要非零退出，所以记 unable
    if (suite.kind === 'node' && !browserOk) {
      const why = !CHROME ? '找不到 Chrome' : '找不到 puppeteer-core';
      console.log(`\n${C.bold}${C.yellow}⊘ ${i}/${SUITES.length} ${suite.id}${C.reset} ${C.yellow}跳过：${why}${C.reset}`);
      results.push({ suite, status: 'unable', reason: why, passed: 0, total: 0, ms: 0, code: -1, lines: [] });
      continue;
    }
    if (suite.kind === 'python' && !PYTHON) {
      console.log(`\n${C.bold}${C.yellow}⊘ ${i}/${SUITES.length} ${suite.id}${C.reset} ${C.yellow}跳过：找不到 python${C.reset}`);
      results.push({ suite, status: 'unable', reason: '找不到 python', passed: 0, total: 0, ms: 0, code: -1, lines: [] });
      continue;
    }
    // 端口预检：套件的默认端口被占 → 跑上去就是「跑在别人的服务上」，数字全是假的
    const busy = await blockedPorts(suite);
    if (busy.length) {
      const reason = `端口 ${busy.join(' / ')} 已被占用，另一个测试实例可能在跑`;
      console.log(`\n${C.bold}${C.yellow}⊘ ${i}/${SUITES.length} ${suite.id}${C.reset} ${C.yellow}跳过：${reason}${C.reset}`);
      console.log(`${C.dim}    先清掉占用：Windows netstat -ano | findstr :${busy[0]} → taskkill /PID <pid> /F；macOS/Linux：lsof -i :${busy[0]} → kill <pid>${C.reset}`);
      results.push({ suite, status: 'blocked', reason, passed: 0, total: 0, ms: 0, code: -1, lines: [] });
      continue;
    }
    const r = await runSuite(suite, i, SUITES.length);
    results.push(r);
    const secs = (r.ms / 1000).toFixed(1);
    if (r.status === 'pass') {
      console.log(`${C.green}✔ ${i}/${SUITES.length} ${suite.id}${C.reset} ${C.dim}${r.passed}/${r.total} · ${secs}s${C.reset}`);
    } else {
      console.log(`${C.red}✘ ${i}/${SUITES.length} ${suite.id}${C.reset} ${C.red}${r.reason || '失败'}${C.reset} ${C.dim}${r.passed}/${r.total} · ${secs}s${C.reset}`);
      const n = Number(arg('fail-lines', 40));
      console.log(`${C.dim}--- 最后 ${n} 行输出（${suite.id}）---${C.reset}`);
      for (const l of tail(r.lines, n)) console.log(`${C.dim}${l}${C.reset}`);
    }
  }

  // ---------- 汇总表 ----------
  const totalMs = results.reduce((n, r) => n + r.ms, 0);
  const rows = results.map((r) => ({
    id: r.suite.id,
    groups: r.suite.groups.join(','),
    ports: r.suite.ports.length ? r.suite.ports.join(',') : '随机',
    counts: `${r.passed}/${r.total}`,
    time: `${(r.ms / 1000).toFixed(1)}s`,
    result: r.status === 'pass' ? '通过' : (r.status === 'blocked' ? '跳过(端口)' : (r.status === 'unable' ? '跳过' : '失败')),
  }));
  const w1 = Math.max(6, ...rows.map((r) => width(r.id)));
  const w2 = Math.max(6, ...rows.map((r) => width(r.groups)));
  const w5 = Math.max(8, ...rows.map((r) => width(r.ports)));
  const w3 = Math.max(6, ...rows.map((r) => width(r.counts)));
  const w4 = Math.max(4, ...rows.map((r) => width(r.time)));

  console.log(`\n${C.bold}汇总${C.reset}`);
  console.log(`${C.bold}${pad('套件', w1)}  ${pad('分组', w2)}  ${pad('默认端口', w5)}  ${pad('通过', w3)}  ${pad('耗时', w4)}  结果${C.reset}`);
  for (const r of rows) {
    const color = r.result === '通过' ? C.green : (r.result === '失败' ? C.red : C.yellow);
    console.log(`${pad(r.id, w1)}  ${pad(r.groups, w2)}  ${pad(r.ports, w5)}  ${pad(r.counts, w3)}  ${pad(r.time, w4)}  ${color}${r.result}${C.reset}`);
  }

  const failed = results.filter((r) => r.status === 'fail');
  const blocked = results.filter((r) => r.status === 'blocked');
  const unable = results.filter((r) => r.status === 'unable');
  const passed = results.filter((r) => r.status === 'pass');
  const passedChecks = passed.reduce((n, r) => n + r.passed, 0);
  const totalChecks = results.reduce((n, r) => n + r.total, 0);
  console.log(`\n${C.bold}合计${C.reset} ${passed.length} 通过 · ${failed.length} 失败 · ${unable.length + blocked.length} 跳过 · ${(totalMs / 1000).toFixed(1)}s · 用例 ${passedChecks}/${totalChecks}`);
  for (const r of failed) console.log(`  ${C.red}✘${C.reset} ${r.suite.id}  ${r.reason}`);
  for (const r of blocked) console.log(`  ${C.yellow}⊘${C.reset} ${r.suite.id}  ${r.reason}`);

  if (OPTS.json) {
    console.log(`\n${C.dim}JSON:${C.reset} ${JSON.stringify({
      ok: failed.length === 0 && unable.length === 0 && blocked.length === 0,
      ranAt: new Date().toISOString(),
      node: process.version,
      chrome: CHROME,
      puppeteer: PUPPETEER,
      python: PYTHON,
      totalMs,
      suites: results.map((r) => ({
        id: r.suite.id,
        file: r.suite.file,
        groups: r.suite.groups,
        ports: r.suite.ports,
        status: r.status,
        passed: r.passed,
        total: r.total,
        ms: r.ms,
        exitCode: r.code,
        reason: r.reason || null,
      })),
    })}`);
  }

  // 失败 → 1；端口被占 / 依赖缺失导致全跳过 → 也非零（什么都没验证，不能算通过）
  if (failed.length || blocked.length || unable.length) return 1;
  if (!results.length) return 1;
  return 0;
}

process.on('SIGINT', () => {
  console.log(`\n${C.yellow}中断：正在收抬子进程${C.reset}`);
  for (const pid of ACTIVE) killTree(pid);
  try { rmSync(BUILD_TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(130), 500);
});

main().then((code) => {
  if (!OPTS.keep) {
    try { rmSync(BUILD_TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  process.exit(code);
}).catch((e) => {
  console.error(`${C.red}runner 异常：${e?.stack || e}${C.reset}`);
  process.exit(1);
});
