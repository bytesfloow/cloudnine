#!/usr/bin/env node
/**
 * @group plugin
 * CloudNine 插件系统 · 「Markdown 本地图片」端到端验收（fs.readBinary，docs/plugins.md §6.2.1）
 *
 * 覆盖：
 *   → 相对路径 png 真渲染（naturalWidth > 0）+ 控制台没有 404
 *   → 子目录图片（基准 = 当前 md 所在目录，不是 FILE_ROOT、也不是插件包目录）
 *   → 嵌套目录里的 md：同名 a.png 解析到自己那一层（dirname 基准的真凭据）
 *   → svg 能显示；http(s) 外链照常 <img>（本脚本自带一个真实 http 图片服务）
 *   → 9MB 假图 → 「太大」占位；.txt 当图片 → 「不支持的图片类型」占位
 *   → 同一张图引用两次只请求一次（数宿主 /api/download + 插件侧 imgRequests）
 *   → 懒加载：文档末尾的图在滚动到附近之前不发请求
 *   → SDK 契约：返回 {dataUrl,mime,bytes} / 根相对路径 / 不存在 / 类型 / 上限 / .. 拒绝
 *   → 暗色主题下图片边框与底色（截图 + 计算样式）
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全在系统临时目录，端口 8705，跑完清理。
 *
 * 依赖：puppeteer-core（不含 Chromium，复用系统 Chrome）
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-md-images.mjs
 *   node scripts/uitest-md-images.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-md-images.mjs --keep
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- 解析 puppeteer-core ----------
function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    resolve(ROOT, '..', '.uitest', 'node_modules', 'puppeteer-core'),
    resolve(ROOT, 'node_modules', 'puppeteer-core'),
    'puppeteer-core',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* 继续尝试下一个 */ }
  }
  console.error('找不到 puppeteer-core。请先安装：');
  console.error('  cd .. && mkdir -p .uitest && cd .uitest && npm install puppeteer-core');
  process.exit(2);
}

const puppeteer = loadPuppeteer();

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const PORT = Number(arg('port', 8705));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/md-images'));

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m';
const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const passed = [];
const failed = [];
let currentShot = '';

function check(name, cond, detail = '') {
  if (cond) {
    passed.push(name);
    console.log(`${GREEN}  ✓${RESET} ${name}`);
  } else {
    failed.push([name, detail, currentShot]);
    console.log(`${RED}  ✗${RESET} ${name}  ${YELLOW}${detail}${RESET}`);
    if (currentShot) console.log(`${DIM}    📎 见截图 ${currentShot}${RESET}`);
  }
  return !!cond;
}
function section(t) { console.log(`\n${BOLD}${CYAN}▸ ${t}${RESET}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 0. 造真图片（零依赖：手写最小 PNG） =================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 8-bit RGB 纯色 PNG（不依赖任何图形库；浏览器解得开就够了）
function makePng(w, h, [r, g, b]) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18" viewBox="0 0 24 18">',
  '<rect width="24" height="18" rx="3" fill="#2f6fd0"/>',
  '<circle cx="12" cy="9" r="5" fill="#ffd25e"/>',
  '</svg>',
].join('');

// ================= 1. 干净环境 =================
let child = null;
let tmpRoot = null;
let serverEnv = null;
let dataDir = null;
let filesRoot = null;
let pluginsDir = null;
let ext = null;          // 外链图片的小 http 服务
const EXT_W = 37;

async function waitServer(base, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function startServer() {
  const log = [];
  child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: join(ROOT, 'server'),
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`${RED}服务进程退出（${code}）${RESET}\n${log.join('')}`);
  });
  if (!await waitServer(URL_BASE)) {
    console.error(`${RED}服务 30 秒内没有起来${RESET}\n${log.join('').slice(-4000)}`);
    await cleanup();
    process.exit(2);
  }
}

// 外链图片：真的起一个 http 服务（不依赖公网，测试离线也能跑）
function startExtServer(png) {
  return new Promise((res) => {
    const srv = http.createServer((req, rp) => {
      if ((req.url || '').split('?')[0] === '/ext.png') {
        rp.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-cache' });
        rp.end(png);
        return;
      }
      rp.writeHead(404);
      rp.end('nope');
    });
    srv.listen(0, '127.0.0.1', () => {
      srv.unref?.();
      res({ port: srv.address().port, close: () => srv.close() });
    });
  });
}

function installPlugin() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(ROOT, 'scripts', 'plugin-dev-install.mjs'), 'md', '--dir', pluginsDir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { out += String(d); });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`plugin-dev-install 退出 ${code}\n${out}`))));
  });
}

const FILLER = Array.from({ length: 45 }, (_, i) => `段落 ${i + 1}：用来把图片推到视口之外，验证懒加载不是一句空话。`).join('\n\n');

function docText(extPort) {
  return [
    '# 本地图片自测',
    '',
    `同目录的 png（${EXT_W} 之外的另一张，41×41）：`,
    '',
    '![本地 png](./a.png)',
    '',
    '同一张图再引用一次（应该只请求一次）：',
    '',
    '![再来一次](./a.png)',
    '',
    '子目录图片（基准 = 当前 md 所在目录）：',
    '',
    '![子目录](./sub/x.png)',
    '',
    'SVG 也能显示：',
    '',
    '![矢量图](./pic.svg)',
    '',
    '超过上限的图：',
    '',
    '![超大图](./huge.png)',
    '',
    '把文本当图片引用：',
    '',
    '![不是图片](./note.txt)',
    '',
    '外链图片（http）照常直连：',
    '',
    `![外链](http://127.0.0.1:${extPort}/ext.png)`,
    '',
    '文件不存在：',
    '',
    '![不存在](./nope.png)',
    '',
    FILLER,
    '',
    '文档末尾的图（懒加载：没滚到这里之前不应发请求）：',
    '',
    '![远处的图](./far.png)',
    '',
  ].join('\n');
}

async function prepareEnv() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-mdimg-uitest-'));
  dataDir = join(tmpRoot, 'data');
  filesRoot = join(tmpRoot, 'files');
  pluginsDir = join(dataDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(join(filesRoot, 'sub'), { recursive: true });
  mkdirSync(join(filesRoot, 'nested'), { recursive: true });

  // 外链图片：先起小 http 服务，拿到端口再写 md
  ext = await startExtServer(makePng(EXT_W, EXT_W, [200, 60, 60]));

  // 主文档在根目录：双击桌面图标就能打开
  writeFileSync(join(filesRoot, 'images.md'), docText(ext.port), 'utf8');
  writeFileSync(join(filesRoot, 'a.png'), makePng(41, 41, [40, 120, 220]));       // 41×41：主文档用的那张
  writeFileSync(join(filesRoot, 'sub', 'x.png'), makePng(5, 5, [30, 180, 90]));    // 5×5：子目录里的
  writeFileSync(join(filesRoot, 'pic.svg'), SVG, 'utf8');
  writeFileSync(join(filesRoot, 'note.txt'), 'this is not an image\n', 'utf8');
  writeFileSync(join(filesRoot, 'far.png'), makePng(9, 9, [210, 180, 40]));        // 9×9：文档末尾
  // 9MB 假 png：扩展名是 .png（MIME 白名单能过），体积超上限 → PAYLOAD_TOO_LARGE
  writeFileSync(join(filesRoot, 'huge.png'), Buffer.alloc(9 * 1024 * 1024, 0x41));

  // 嵌套目录：同名 a.png 是 3×3 —— 只有「基准 = md 所在目录」才会渲染成 3×3
  writeFileSync(join(filesRoot, 'nested', 'a.png'), makePng(3, 3, [220, 120, 30]));
  writeFileSync(join(filesRoot, 'nested', 'doc.md'), '# 嵌套目录里的同名图\n\n![同名图](./a.png)\n', 'utf8');

  const out = await installPlugin();
  if (!existsSync(join(pluginsDir, 'md', 'index.html'))) {
    throw new Error(`插件没装上：${pluginsDir}\n${out}`);
  }

  serverEnv = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PLUGINS_DIR: pluginsDir,
    PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
    FILE_ROOT: filesRoot,
    SITE_NAME: 'CloudNine Markdown 图片自测',
  };
  await startServer();
  console.log(`${DIM}临时数据目录：${tmpRoot}${RESET}`);
  console.log(`${DIM}临时 FILE_ROOT：${filesRoot}${RESET}`);
  console.log(`${DIM}外链图片服务：http://127.0.0.1:${ext.port}/ext.png${RESET}`);
}

async function cleanup() {
  try { ext?.close(); } catch { /* 已关 */ }
  if (child && !child.killed) {
    child.kill();
    await sleep(300);
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  if (tmpRoot && !KEEP) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 上偶发占用 */ }
  } else if (tmpRoot) {
    console.log(`${DIM}已保留临时目录：${tmpRoot}${RESET}`);
  }
}

async function ensureAccount(base) {
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, sid: (r.headers.get('set-cookie') || '').match(/cloudnine_sid=([^;]+)/)?.[1] || null };
  };
  const st = await (await fetch(`${base}/api/state`)).json();
  if (!st.initialized) await post('/api/init', { username: USERNAME, password: PASSWORD });
  const login = await post('/api/login', { username: USERNAME, password: PASSWORD });
  if (!login.sid) throw new Error(`登录失败（${login.status}）：${login.text.slice(0, 200)}`);
  return login.sid;
}

// ================= 2. 浏览器流程 =================
let browser = null;
let page = null;
let sid = null;

async function main() {
  if (OWN_SERVER) await prepareEnv();
  sid = await ensureAccount(URL_BASE);

  mkdirSync(OUT_DIR, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.setCookie({
    name: 'cloudnine_sid', value: sid, domain: new URL(URL_BASE).hostname, path: '/', httpOnly: true,
  });

  const consoleErrors = [];
  const badResponses = [];
  const downloads = [];      // 宿主替插件发的每一次 fs.readBinary → /api/download
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/download')) {
      try { downloads.push(decodeURIComponent(new URL(u).searchParams.get('path') || '')); } catch { downloads.push(u); }
    }
  });
  const dlCount = (rel) => downloads.filter((p) => p === rel).length;

  let shotIdx = 0;
  const shot = async (label) => {
    const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
    currentShot = name;
    console.log(`${DIM}    📸 ${name}${RESET}`);
    return name;
  };

  const dblclickAt = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };
  const centerOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  const closeAllWindows = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(250);
  };
  const pluginFrame = async (ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const iframes = await page.$$('.window iframe.plugin-frame').catch(() => []);
      const el = iframes[iframes.length - 1];
      if (el) {
        const f = await el.contentFrame().catch(() => null);
        if (f) {
          const alive = await f.evaluate(() => !!(window.cloudnine && document.getElementById('app'))).catch(() => false);
          if (alive) return f;
        }
      }
      await sleep(200);
    }
    return null;
  };
  const waitFrameReady = async (f, ms = 20000) => f.waitForFunction(
    () => document.getElementById('welcome') && (document.getElementById('welcome').hidden
      || /没有加载到插件 SDK|初始化失败/.test(document.getElementById('welcome-error').textContent)),
    { timeout: ms, polling: 100 },
  ).then(() => true).catch(() => false);

  const openFileEntry = async (name) => {
    const box = await centerOf(`.desktop-icon[data-entry="${name}"]`);
    if (!box) throw new Error(`桌面上找不到文件图标：${name}`);
    await dblclickAt(box.x, box.y);
    await sleep(700);
    const f = await pluginFrame();
    if (!f) return null;
    await waitFrameReady(f);
    return f;
  };

  const mdState = (f) => f.evaluate(() => (window.__mdState ? window.__mdState() : null));

  // 预览里每张图的当前形态：真图（带 naturalWidth）还是占位（带文案）
  const imgReport = (f) => f.evaluate(() => {
    const pv = document.getElementById('preview');
    return {
      imgs: [...pv.querySelectorAll('img')].map((i) => ({
        rel: i.getAttribute('data-img') || '',
        src: (i.getAttribute('src') || '').slice(0, 40),
        naturalWidth: i.naturalWidth,
        naturalHeight: i.naturalHeight,
        local: i.classList.contains('md-img-local'),
      })),
      pending: [...pv.querySelectorAll('.md-img-ph')].map((s) => s.getAttribute('data-img')),
      missing: [...pv.querySelectorAll('.md-img-missing')].map((s) => ({
        rel: s.querySelector('.md-img-name')?.textContent.trim() || '',
        text: s.textContent.trim(),
      })),
    };
  });

  // 等某张图变成真图（data URL 是本地生成的，解码很快，但仍然要轮询等它落地）
  const waitImg = (f, rel, ms = 15000) => f.waitForFunction((r) => {
    const i = document.querySelector(`#preview img[data-img="${r}"]`);
    return !!i && i.naturalWidth > 0;
  }, { timeout: ms, polling: 100 }, rel).then(() => true).catch(() => false);
  const waitMissing = (f, rel, ms = 15000) => f.waitForFunction((r) => {
    return [...document.querySelectorAll('#preview .md-img-missing .md-img-name')]
      .some((n) => n.textContent.trim() === r);
  }, { timeout: ms, polling: 100 }, rel).then(() => true).catch(() => false);

  // 懒加载是设计的一部分：先把目标滚进视口（否则永远等不到请求）
  const scrollToImg = (f, rel) => f.evaluate((r) => {
    const el = document.querySelector(`#preview [data-img="${r}"]`)
      || [...document.querySelectorAll('#preview .md-img-missing .md-img-name')]
        .find((n) => n.textContent.trim() === r)?.parentElement;
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  }, rel).catch(() => false);
  const scrollToSel = (f, sel) => f.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  }, sel).catch(() => false);

  console.log(`${BOLD}CloudNine Markdown 本地图片自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);
  console.log(`${DIM}期望尺寸：a.png=41 sub/x.png=5 pic.svg=24×18 far.png=9 外链=${EXT_W} nested/a.png=3${RESET}`);

  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  await page.waitForSelector('.desktop-icon[data-entry="images.md"]', { timeout: 15000 });

  // ---------- 1. 打开文档 ----------
  section('1. 打开 images.md（相对路径图片）');
  let frame = await openFileEntry('images.md');
  check('双击 images.md 用 md 插件打开', !!frame);
  const base = frame ? await mdState(frame) : null;
  check('相对路径的基准 = md 所在目录（根目录时 baseDir 为 ""）', base?.doc?.rel === 'images.md' && base?.baseDir === '',
    JSON.stringify({ doc: base?.doc, baseDir: base?.baseDir }));

  // ---------- 2. 相对路径 png ----------
  section('2. 相对路径 png 真渲染（宿主 fs.readBinary → data URL）');
  const aOk = await waitImg(frame, 'a.png');
  const rep1 = await imgReport(frame);
  const aImg = rep1.imgs.find((i) => i.rel === 'a.png');
  check('![](./a.png) 渲染成真图（naturalWidth = 41，不是破图 / 占位）', aOk && aImg?.naturalWidth === 41,
    JSON.stringify({ aOk, aImg, pending: rep1.pending }));
  check('图片 src 是 data:image/png;base64（不是 /pa 的假路径、不是外链）',
    /^data:image\/png;base64,/.test(aImg?.src || '') && aImg?.local === true, aImg?.src);
  check('这张图没有刷 404（/api/download 返回 200）',
    !badResponses.some((u) => /api\/download/.test(u) && /a\.png/.test(u)), badResponses.slice(0, 4).join(' | '));

  // ---------- 3. 子目录 + svg + 外链 ----------
  section('3. 子目录图片 / SVG / http(s) 外链');
  await scrollToImg(frame, 'sub/x.png');
  const subOk = await waitImg(frame, 'sub/x.png');
  await scrollToImg(frame, 'pic.svg');
  const svgOk = await waitImg(frame, 'pic.svg');
  await scrollToSel(frame, '#preview img[src^="http"]');
  await sleep(600);
  const rep2 = await imgReport(frame);
  const subImg = rep2.imgs.find((i) => i.rel === 'sub/x.png');
  const svgImg = rep2.imgs.find((i) => i.rel === 'pic.svg');
  const extImg = rep2.imgs.find((i) => /127\.0\.0\.1/.test(i.src) || i.rel === '');
  check('![](./sub/x.png) 正常（基准 = md 所在目录，解析成 sub/x.png）',
    subOk && subImg?.naturalWidth === 5, JSON.stringify(subImg));
  check('svg 能显示（image/svg+xml，naturalWidth = 24）',
    svgOk && svgImg?.naturalWidth === 24 && /^data:image\/svg\+xml;base64,/.test(svgImg?.src || ''),
    JSON.stringify(svgImg));
  check('http(s) 外链照旧直连 <img>（不走 fs.readBinary，naturalWidth = 37）',
    !!extImg && extImg.naturalWidth === EXT_W && !extImg.local, JSON.stringify(extImg));
  check('外链图片没有被宿主代读（/api/download 里没有 ext.png）', !downloads.some((p) => /ext\.png/.test(p)),
    downloads.join(', '));
  await shot('相对路径-子目录-svg-外链');

  // ---------- 4. 太大 / 类型不对 ----------
  section('4. 失败分类：太大 / 不支持的类型 / 不存在');
  await scrollToImg(frame, 'huge.png');
  const hugePlaceholder = await waitMissing(frame, 'huge.png');
  await scrollToImg(frame, 'note.txt');
  const txtPlaceholder = await waitMissing(frame, 'note.txt');
  await scrollToImg(frame, 'nope.png');
  const nopePlaceholder = await waitMissing(frame, 'nope.png');
  const rep3 = await imgReport(frame);
  const hugeMiss = rep3.missing.find((m) => m.rel === 'huge.png');
  const txtMiss = rep3.missing.find((m) => m.rel === 'note.txt');
  const nopeMiss = rep3.missing.find((m) => m.rel === 'nope.png');
  const imgs = (await mdState(frame))?.imgs || [];
  const hugeEntry = imgs.find((i) => i.rel === 'huge.png');
  const txtEntry = imgs.find((i) => i.rel === 'note.txt');
  check('9MB 图 → 占位写「太大 / 超过上限」（不是「不支持本地图片」）',
    hugePlaceholder && /太大/.test(hugeMiss?.text || '') && /超过/.test(hugeMiss?.text || '')
    && !/暂不支持/.test(hugeMiss?.text || ''), JSON.stringify(hugeMiss));
  check('宿主回 PAYLOAD_TOO_LARGE 并带真实体积（message 里有 9.00 MB 与上限）',
    hugeEntry?.code === 'PAYLOAD_TOO_LARGE' && /9\.00 MB/.test(JSON.stringify(hugeEntry)), JSON.stringify(hugeEntry));
  check('.txt 当图片 → 「不支持的图片类型（text/plain）」',
    txtPlaceholder && /不支持的图片类型/.test(txtMiss?.text || '') && /text\/plain/.test(txtMiss?.text || ''),
    JSON.stringify(txtMiss));
  check('宿主回 UNSUPPORTED_TYPE（不是笼统的 FAILED）', txtEntry?.code === 'UNSUPPORTED_TYPE', JSON.stringify(txtEntry));
  check('不存在的文件 → 「找不到这张图片」（对应码是 FS_NOT_FOUND）',
    nopePlaceholder && /找不到这张图片/.test(nopeMiss?.text || ''), JSON.stringify(nopeMiss));
  check('失败的占位不会写「本地图片暂不支持」这种一刀切文案',
    ![hugeMiss, txtMiss, nopeMiss].some((m) => /暂不支持/.test(m?.text || '')));
  await shot('失败分类-太大-类型-不存在');

  // ---------- 5. 同一张图只请求一次 ----------
  section('5. 缓存：同一张图多处引用只请求一次');
  const aCount = dlCount('a.png');
  const st5 = await mdState(frame);
  check('![](./a.png) 引用两次，宿主只被要了 1 次', aCount === 1, `downloads=${JSON.stringify(downloads)}`);
  check('插件侧 imgRequests 计数 = 各 rel 去重后的数量（a.png 只算一次）',
    (st5?.imgRequests || 0) === new Set(downloads).size, JSON.stringify({ req: st5?.imgRequests, downloads }));
  // 强制重渲染（切模式）后仍不复用新请求
  await frame.evaluate(() => document.querySelector('[data-mode="split"]').click());
  await sleep(400);
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(600);
  check('切换视图重渲染后仍走缓存（a.png 还是只请求过 1 次）', dlCount('a.png') === 1, `count=${dlCount('a.png')}`);

  // ---------- 6. 懒加载 ----------
  section('6. 懒加载：视口外的图不发请求');
  // 先回到顶部，让“远图是否已被请求”的结论不受前面滚动的影响
  await frame.evaluate(() => { document.getElementById('preview-pane').scrollTop = 0; });
  await sleep(400);
  check('文档末尾的 far.png 在滚动到附近之前没有被请求',
    !downloads.includes('far.png') && !(await mdState(frame))?.imgs?.some((i) => i.rel === 'far.png'),
    `downloads=${JSON.stringify(downloads)}`);
  await frame.evaluate(() => {
    const pane = document.getElementById('preview-pane');
    pane.scrollTop = pane.scrollHeight;
  });
  const farOk = await waitImg(frame, 'far.png', 12000);
  check('滚到底部后 far.png 才发请求并真渲染（naturalWidth = 9）', farOk && dlCount('far.png') === 1,
    `farOk=${farOk} count=${dlCount('far.png')}`);
  await shot('懒加载-滚到底部');
  // 渲染阶段的网络快照（后面的 SDK 契约检查、重开窗口都会再发请求，不能拿最终计数来断言缓存）
  const renderDownloads = downloads.slice();

  // ---------- 7. SDK 契约 ----------
  section('7. SDK 契约（fs.readBinary 的返回 / 白名单 / 上限 / 路径规则）');
  const aBytes = statSync(join(filesRoot, 'a.png')).size;
  const sdk = await frame.evaluate(() => (async () => {
    const out = {};
    try {
      const r = await window.cloudnine.fs.readBinary('a.png');
      out.ok = {
        prefix: String(r.dataUrl).slice(0, 22),
        mime: r.mime,
        bytes: r.bytes,
        len: String(r.dataUrl).length,
      };
    } catch (e) { out.ok = { code: e.code, message: e.message }; }
    // 根相对路径：以 / 开头 = 从 FILE_ROOT 算起（宿主归一成安全 rel）
    try {
      const r = await window.cloudnine.fs.readBinary('/sub/x.png');
      out.rootRel = { mime: r.mime, bytes: r.bytes };
    } catch (e) { out.rootRel = { code: e.code, message: e.message }; }
    try { await window.cloudnine.fs.readBinary('note.txt'); out.txt = { code: 'NO_ERROR' }; }
    catch (e) { out.txt = { code: e.code, message: e.message }; }
    try { await window.cloudnine.fs.readBinary('huge.png', { maxBytes: 1024 * 1024 }); out.tiny = { code: 'NO_ERROR' }; }
    catch (e) { out.tiny = { code: e.code, message: e.message }; }
    try { await window.cloudnine.fs.readBinary('nope.png'); out.nope = { code: 'NO_ERROR' }; }
    catch (e) { out.nope = { code: e.code, message: e.message }; }
    try { await window.cloudnine.fs.readBinary('../secret.png'); out.dots = { code: 'NO_ERROR' }; }
    catch (e) { out.dots = { code: e.code, message: e.message }; }
    try { await window.cloudnine.fs.readBinary('a.png', { maxBytes: 0 }); out.badMax = { code: 'NO_ERROR' }; }
    catch (e) { out.badMax = { code: e.code, message: e.message }; }
    return out;
  })());
  check('返回 {dataUrl, mime, bytes}：data:image/png;base64、bytes 与磁盘一致',
    sdk.ok?.prefix === 'data:image/png;base64,' && sdk.ok?.mime === 'image/png' && sdk.ok?.bytes === aBytes,
    JSON.stringify(sdk.ok));
  check('以 / 开头的根相对路径也能读（/sub/x.png → sub/x.png）',
    sdk.rootRel?.mime === 'image/png' && sdk.rootRel?.bytes > 0, JSON.stringify(sdk.rootRel));
  check('非图片类型 → UNSUPPORTED_TYPE（message 点明真实 MIME）',
    sdk.txt?.code === 'UNSUPPORTED_TYPE' && /text\/plain/.test(sdk.txt?.message || ''), JSON.stringify(sdk.txt));
  check('maxBytes 生效：9MB 图请求 1MB → PAYLOAD_TOO_LARGE',
    sdk.tiny?.code === 'PAYLOAD_TOO_LARGE' && /1\.00 MB/.test(sdk.tiny?.message || ''), JSON.stringify(sdk.tiny));
  check('不存在的文件 → FS_NOT_FOUND', sdk.nope?.code === 'FS_NOT_FOUND', JSON.stringify(sdk.nope));
  check('带 .. 的路径 → INVALID_ARGUMENT（宿主不放行穿越）', sdk.dots?.code === 'INVALID_ARGUMENT',
    JSON.stringify(sdk.dots));
  check('maxBytes 不合法（0）→ INVALID_ARGUMENT', sdk.badMax?.code === 'INVALID_ARGUMENT',
    JSON.stringify(sdk.badMax));

  // ---------- 8. 嵌套目录：dirname 基准的真凭据 ----------
  section('8. 嵌套目录里的 md：同名 a.png 解到它自己那一层');
  await closeAllWindows();
  const openFinder = async () => {
    await page.evaluate(() => document.querySelector('.tb-app[title="文件资源管理器"]')?.click());
    await page.waitForSelector('.window .finder-item', { timeout: 15000 }).catch(() => {});
    await sleep(500);
  };
  const dblclickInsideFinder = async (name) => {
    await page.evaluate((n) => {
      const el = document.querySelector(`.window .finder-item[data-name="${n}"]`);
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }, name);
    await sleep(900);
  };
  await openFinder();
  await dblclickInsideFinder('nested');
  await dblclickInsideFinder('doc.md');
  frame = await pluginFrame();
  if (frame) await waitFrameReady(frame);
  const nestedState = frame ? await mdState(frame) : null;
  check('嵌套目录的 doc.md 用插件打开（file.rel = nested/doc.md）',
    nestedState?.doc?.rel === 'nested/doc.md' && nestedState?.baseDir === 'nested',
    JSON.stringify({ doc: nestedState?.doc, baseDir: nestedState?.baseDir }));
  const nestedOk = frame ? await waitImg(frame, 'nested/a.png') : false;
  const nestedRep = frame ? await imgReport(frame) : { imgs: [] };
  const nestedImg = nestedRep.imgs.find((i) => i.rel === 'nested/a.png');
  check('同一句 ![](./a.png) 在 nested/ 里解析成 nested/a.png（3×3，不是根目录那张 41×41）',
    nestedOk && nestedImg?.naturalWidth === 3, JSON.stringify(nestedImg));
  await shot('嵌套目录-dirname基准');
  await closeAllWindows();

  // ---------- 9. 暗色 ----------
  section('9. 暗色主题（不刺眼：轻边框 + 底色）');
  frame = await openFileEntry('images.md');
  await waitImg(frame, 'a.png');
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(400);
  const setHostTheme = async (label) => {
    if (!await page.$('.account-popover')) {
      await page.evaluate(() => document.querySelector('.tray-account')?.click());
      await page.waitForSelector('.account-popover', { timeout: 5000 }).catch(() => {});
    }
    await page.evaluate((t) => {
      const btn = [...document.querySelectorAll('.account-popover .dropdown-item')]
        .find((b) => (b.textContent || '').includes(t));
      btn?.click();
      return !!btn;
    }, label);
    await page.evaluate(() => {
      const f = document.querySelector('.window .plugin-frame');
      if (f) f.blur();
      document.activeElement?.blur?.();
    });
    await page.keyboard.press('Escape');
    await sleep(500);
  };
  await setHostTheme('深色主题');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const darkImg = await frame.evaluate(() => {
    const i = document.querySelector('#preview img[data-img="a.png"]');
    const ph = document.querySelector('#preview .md-img-ph');
    const cs = i ? getComputedStyle(i) : null;
    const root = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.style.colorScheme,
      bg: cs?.backgroundColor || '',
      border: cs?.borderTopColor || '',
      panel: (root.getPropertyValue('--input-bg') || '').trim(),
      hasPh: !!ph,
    };
  });
  check('暗色下图片有轻边框 + 底色（不是透明裸图糊成一片）',
    darkImg.theme === 'dark' && darkImg.border && darkImg.border !== 'rgba(0, 0, 0, 0)'
    && darkImg.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(darkImg));
  await shot('暗色-图片');
  await setHostTheme('浅色主题');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 8000 }).catch(() => {});
  await sleep(300);
  await onceAgainPreview();
  await closeAllWindows();

  // 切回浅色后重开一次，让最终截图是亮的
  frame = await openFileEntry('images.md');
  await waitImg(frame, 'a.png');
  await sleep(400);
  await shot('浅色-最终');

  // ---------- 10. 控制台 ----------
  section('10. 控制台 / 网络');
  // nope.png 是我们故意引用的不存在文件：宿主 /api/download 会回 404，属于预期内
  const expected = (u) => /favicon\.ico|nope\.png/.test(u);
  const realBad = badResponses.filter((u) => !expected(u));
  const realErrors = consoleErrors.filter((m) => !/Failed to load resource|nope\.png|favicon\.ico/.test(m));
  if (badResponses.length !== realBad.length) {
    console.log(`${DIM}    预期内 4xx：${badResponses.filter(expected).join(', ')}${RESET}`);
  }
  check('控制台无 JS 错误、无意外 4xx/5xx（a.png / sub/x.png / svg 都没有 404）',
    realErrors.length === 0 && realBad.length === 0,
    JSON.stringify({ errors: realErrors.slice(0, 3), responses: realBad.slice(0, 5) }));
  check('每张本地图只被宿主读了一次（a.png ×1 / sub/x.png ×1 / pic.svg ×1 / far.png ×1）',
    ['a.png', 'sub/x.png', 'pic.svg', 'far.png'].every((p) => renderDownloads.filter((x) => x === p).length === 1),
    JSON.stringify(renderDownloads));

  async function onceAgainPreview() {
    if (!frame) return;
    await frame.evaluate(() => document.querySelector('[data-mode="preview"]')?.click()).catch(() => {});
    await sleep(300);
  }

  await page.screenshot({ path: join(OUT_DIR, '99-final.png') });
}

// ================= 3. 收尾 =================
let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error(`${RED}流程异常：${e?.stack || e}${RESET}`);
  failed.push(['流程异常', String(e?.message || e), currentShot]);
  exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* 忽略 */ }
  await cleanup();
}

console.log(`\n${BOLD}结果${RESET}  通过 ${GREEN}${passed.length}${RESET} · 失败 ${failed.length ? RED : DIM}${failed.length}${RESET}  截图目录 ${OUT_DIR}`);
if (failed.length) {
  for (const [name, detail, s] of failed) console.log(`${RED}  ✗${RESET} ${name}  ${detail}${s ? `  📎 ${s}` : ''}`);
  process.exit(exitCode || 1);
}
process.exit(exitCode);
