#!/usr/bin/env node
/**
 * CloudNine 插件管理器（设置 → 插件）端到端自测
 *
 * 覆盖：
 *   设置窗口入口（开始菜单底部「设置」）→ 插件分区 → 列出已装插件（名称 / 版本 / 权限中文标签 /
 *   文件关联 / manifest 非法的目录）→ 上传 zip 安装（进行中状态 + 进度条 + 成功提示）→
 *   **不刷新页面**列表即时新增、桌面图标即时出现 → 重复上传 409 → 「已存在 vX，是否覆盖？」→
 *   取消则什么都不变 / 确认则版本更新 → 卸载二次确认（取消仍在 / 确认后消失，界面提示会删本地数据）→
 *   桌面图标同步消失、插件私有数据文件被删、该插件的窗口自动关掉 →
 *   错误态（网络失败 / zip 超 8MB / manifest 非法）→ 600px 宽不横溢 → 暗色主题 → 空态。
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全部落在系统临时目录，
 *   端口 8655，跑完杀进程 + 删目录。
 *
 * 用法：
 *   node scripts/uitest-plugin-manager.mjs
 *   node scripts/uitest-plugin-manager.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-plugin-manager.mjs --url http://127.0.0.1:8499/ --user u --password p
 *   node scripts/uitest-plugin-manager.mjs --keep     # 保留临时目录（排障用）
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- 解析 puppeteer-core ----------
function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    resolve(ROOT, '..', '.uitest', 'node_modules', 'puppeteer-core'),
    resolve(ROOT, '..', '..', '.uitest', 'node_modules', 'puppeteer-core'),
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

const DEFAULT_CHROME = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome';

const PORT = Number(arg('port', 8655));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', process.env.CHROME || DEFAULT_CHROME);
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/plugin-manager'));

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
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

// ================= 1. 造 zip（store 方法，无第三方依赖） =================
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** entries: [{ name, data }] → store 方法的 zip Buffer（yauzl 读它没问题） */
function makeZip(entries) {
  const DOS_TIME = 0;            // 00:00:00
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);       // version needed
    lh.writeUInt16LE(0x0800, 6);   // UTF-8 名字
    lh.writeUInt16LE(0, 8);        // store
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);       // version made by
    ch.writeUInt16LE(20, 6);       // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);       // extra
    ch.writeUInt16LE(0, 32);       // comment
    ch.writeUInt16LE(0, 34);       // disk
    ch.writeUInt16LE(0, 36);       // internal attr
    ch.writeUInt32LE(0, 38);       // external attr
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, cd, eocd]);
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a7cff"/><path d="M10 11h12M10 16h12M10 21h7" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`;

function pluginPage(version) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>速记本</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:16px;background:var(--panel-bg,#fff);color:var(--text,#1b1b1b)}</style></head>
<body>
<h2 style="margin:0 0 8px">速记本</h2>
<div>版本：<b id="ver">${version}</b></div>
<div id="status">等待宿主…</div>
<script src="/plugin-sdk/v1/cloudnine.js"><\/script>
<script>
(async function () {
  await cloudnine.ready();
  document.getElementById('status').textContent = '已就绪';
})();
<\/script>
</body></html>`;
}

function pluginZip(version, extraBytes = 0) {
  const manifest = {
    id: 'notes',
    name: '速记本',
    version,
    description: '设置里安装的测试插件',
    author: '插件管理自测',
    icon: 'icon.svg',
    entry: 'index.html',
    window: { width: 560, height: 420, minWidth: 400, minHeight: 300, multi: false },
    permissions: ['storage', 'notify'],
    fileTypes: ['.note'],
  };
  const entries = [
    { name: 'plugin.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'index.html', data: pluginPage(version) },
    { name: 'icon.svg', data: ICON_SVG },
  ];
  // 上传进度需要一个不太小的包（7MB，仍在 8MB 上限内）——只在测「安装中」那一次用
  if (extraBytes > 0) entries.push({ name: 'filler.bin', data: Buffer.alloc(extraBytes, 0x61) });
  return makeZip(entries);
}

// ================= 2. 干净环境 =================
let child = null;
let tmpRoot = null;
let pluginsDir = null;
let pluginDataDir = null;

async function waitServer(base, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
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

async function startOwnServer() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-plugmgr-uitest-'));
  const dataDir = join(tmpRoot, 'data');
  const filesRoot = join(tmpRoot, 'files');
  pluginsDir = join(dataDir, 'plugins');
  pluginDataDir = join(dataDir, 'plugin-data');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(join(filesRoot, 'docs'), { recursive: true });
  writeFileSync(join(filesRoot, 'readme.txt'), 'cloudnine plugin manager uitest\n');

  // 已装插件：示例 hello（列表里必须先有一个）
  cpSync(join(ROOT, 'examples', 'plugins', 'hello'), join(pluginsDir, 'hello'), { recursive: true });
  // manifest 非法的目录：列表接口不能 500，而是进 invalid 并在设置里如实展示原因
  mkdirSync(join(pluginsDir, 'broken'), { recursive: true });
  writeFileSync(join(pluginsDir, 'broken', 'plugin.json'), JSON.stringify({
    id: 'broken', name: '坏插件', version: '1.0.0', permissions: ['files.read'],
  }, null, 2));
  writeFileSync(join(pluginsDir, 'broken', 'index.html'), '<!DOCTYPE html><html><body>broken</body></html>');

  // 待上传的包：v1 / v2 / 带 7MB 填充的 v1 / 9MB 超限包
  const pkgDir = join(tmpRoot, 'pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'notes-1.0.0.zip'), pluginZip('1.0.0'));
  writeFileSync(join(pkgDir, 'notes-2.0.0.zip'), pluginZip('2.0.0'));
  writeFileSync(join(pkgDir, 'notes-big.zip'), pluginZip('1.0.0', 7 * 1024 * 1024));
  writeFileSync(join(pkgDir, 'too-big.zip'), Buffer.alloc(9 * 1024 * 1024, 0x41));

  child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PLUGINS_DIR: pluginsDir,
      PLUGIN_DATA_DIR: pluginDataDir,
      FILE_ROOT: filesRoot,
      SITE_NAME: 'CloudNine 插件管理自测',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
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
  console.log(`${DIM}临时数据目录：${tmpRoot}${RESET}`);
  return pkgDir;
}

async function cleanup() {
  if (child && !child.killed) {
    child.kill();
    await sleep(300);
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  if (tmpRoot && !KEEP) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 上偶发占用：留着不影响 */ }
  } else if (tmpRoot) {
    console.log(`${DIM}已保留临时目录：${tmpRoot}${RESET}`);
  }
}

// ================= 3. 浏览器流程 =================
let browser = null;

async function main() {
  const pkgDir = OWN_SERVER ? await startOwnServer() : null;
  const sid = await ensureAccount(URL_BASE);

  mkdirSync(OUT_DIR, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.setCookie({
    name: 'cloudnine_sid', value: sid, domain: new URL(URL_BASE).hostname, path: '/', httpOnly: true,
  });

  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

  // 请求拦截：用来（a）把安装请求拖住，稳定拍到「安装中」；（b）人为制造一次网络失败
  let holdInstallMs = 0;
  let failNextInstall = false;
  let installRequests = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/plugins/install')) {
      installRequests += 1;
      if (failNextInstall) { failNextInstall = false; req.abort('failed').catch(() => {}); return; }
      if (holdInstallMs > 0) {
        const ms = holdInstallMs;
        holdInstallMs = 0;
        setTimeout(() => req.continue().catch(() => {}), ms);
        return;
      }
    }
    req.continue().catch(() => {});
  });

  let shotIdx = 0;
  const shot = async (label) => {
    const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
    currentShot = name;
    console.log(`${DIM}    📸 ${name}${RESET}`);
    return name;
  };

  // ---------- 小工具 ----------
  const openSettings = async () => {
    if (await page.$('.settings-window')) return;
    await page.evaluate(() => document.querySelector('.tb-start')?.click());
    await page.waitForSelector('.startmenu', { timeout: 8000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.startmenu .sm-foot-btn')].find((b) => b.innerText.includes('设置'))?.click();
    });
    await page.waitForSelector('.settings-window', { timeout: 10000 });
    await page.waitForSelector('.plug-panel', { timeout: 10000 });
    await sleep(200);
  };
  const openSection = async (key) => {
    await page.evaluate((k) => document.querySelector(`.set-nav-item[data-section="${k}"]`)?.click(), key);
    await sleep(150);
  };
  const rowsOf = () => page.evaluate(() => [...document.querySelectorAll('.plug-row')].map((r) => ({
    id: r.dataset.plugin,
    name: r.querySelector('.plug-name')?.innerText.trim() || '',
    ver: r.querySelector('.plug-ver')?.innerText.trim() || '',
    perms: [...r.querySelectorAll('.plug-perm')].map((e) => e.dataset.perm || e.innerText.trim()),
    permLabels: [...r.querySelectorAll('.plug-perm')].map((e) => e.innerText.trim()),
    ftypes: r.querySelector('.plug-ftypes')?.innerText.trim() || '',
    author: r.querySelector('.plug-author')?.innerText.trim() || '',
  })));
  const statusText = () => page.evaluate(() => ({
    ok: document.querySelector('.plug-status.ok')?.innerText.trim() || '',
    bad: document.querySelector('.plug-status.bad')?.innerText.trim() || '',
  }));
  const dialogText = () => page.evaluate(() => {
    const d = document.querySelector('.dialog');
    if (!d) return null;
    return {
      title: d.querySelector('h3')?.innerText.trim() || '',
      message: d.querySelector('.dialog-message')?.innerText.trim() || '',
      buttons: [...d.querySelectorAll('.dialog-actions .btn')].map((b) => b.innerText.trim()),
    };
  });
  const clickDialog = (label) => page.evaluate((l) => {
    const btns = [...document.querySelectorAll('.dialog .dialog-actions .btn')];
    const b = btns.find((x) => x.innerText.trim() === l) || btns.find((x) => x.innerText.includes(l));
    b?.click();
    return !!b;
  }, label);
  const waitNoDialog = () => page.waitForFunction(() => !document.querySelector('.dialog'), { timeout: 8000 }).catch(() => {});
  const upload = async (file) => {
    const input = await page.waitForSelector('.plug-file-input', { timeout: 8000 });
    await input.uploadFile(file);
  };
  const desktopIcon = (pluginId) => page.evaluate((id) => {
    const el = document.querySelector(`.desktop-appicon[data-app="plugin:${id}"]`);
    return el ? { label: el.querySelector('.di-label')?.innerText.trim() || '', icon: el.querySelector('img')?.getAttribute('src') || '' } : null;
  }, pluginId);
  const rowEl = (id) => page.waitForSelector(`.plug-row[data-plugin="${id}"]`, { timeout: 8000 });

  console.log(`${BOLD}CloudNine 插件管理自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);

  // ---------- A. 启动 + 入口 ----------
  section('设置窗口入口');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  await page.waitForSelector('.desktop-appicon[data-app="plugin:hello"]', { timeout: 15000 }).catch(() => {});

  const entryProbe = await page.evaluate(async () => {
    const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tb-start')?.click();
    await tick(300);
    const btns = [...document.querySelectorAll('.startmenu .sm-foot-btn')].map((b) => b.innerText.trim());
    const pinned = document.querySelectorAll('.startmenu .sm-app').length;
    [...document.querySelectorAll('.startmenu .sm-foot-btn')].find((b) => b.innerText.includes('设置'))?.click();
    await tick(500);
    return {
      btns,
      pinned,
      opened: !!document.querySelector('.settings-window'),
      menuClosed: !document.querySelector('.startmenu'),
    };
  });
  check('开始菜单底部有「设置」入口', entryProbe.btns.some((t) => t.includes('设置')), entryProbe.btns.join(','));
  check('内置已固定仍是 7 项（设置没有挤进 sm-app）', entryProbe.pinned === 7, String(entryProbe.pinned));
  check('点「设置」打开设置窗口并收起开始菜单', entryProbe.opened && entryProbe.menuClosed, JSON.stringify(entryProbe));
  await page.waitForSelector('.plug-panel', { timeout: 10000 });

  const layout = await page.evaluate(() => ({
    navs: [...document.querySelectorAll('.set-nav-item')].map((b) => b.dataset.section),
    active: document.querySelector('.set-nav-item.active')?.dataset.section || '',
    title: document.querySelector('.window-title')?.innerText.trim() || '',
  }));
  check('设置窗口有分区导航（插件 / 外观 / 关于）',
    JSON.stringify(layout.navs) === JSON.stringify(['plugins', 'appearance', 'about']), layout.navs.join(','));
  check('默认落在「插件」分区', layout.active === 'plugins', layout.active);
  check('窗口标题是「设置」', layout.title === '设置', layout.title);

  // ---------- B. 列表 ----------
  section('已装插件列表');
  await page.waitForSelector('.plug-row', { timeout: 10000 }).catch(() => {});
  let rows = await rowsOf();
  const hello = rows.find((r) => r.id === 'hello');
  check('列出已装的 hello 插件', !!hello, rows.map((r) => r.id).join(','));
  check('列表项显示插件名与版本', hello?.name === '你好 CloudNine' && hello?.ver === 'v1.0.0', JSON.stringify(hello));
  check('列表项显示作者', hello?.author === 'CloudNine', hello?.author);
  check('权限显示成中文标签（storage = 本地存储）',
    hello?.perms.includes('storage') && hello?.permLabels.includes('本地存储'), JSON.stringify(hello?.permLabels));
  check('显示文件关联能力（hello 不关联 → 明确写出来）',
    /不关联文件类型/.test(hello?.ftypes || ''), hello?.ftypes);
  const iconSrc = await page.evaluate(() => document.querySelector('.plug-row[data-plugin="hello"] .plug-icon-img')?.getAttribute('src') || '');
  check('图标用服务端 iconUrl（<img>，不是内联 SVG）', /^\/pa\/[0-9a-f]{32}\/hello\/icon\.svg$/.test(iconSrc), iconSrc);

  const invalidRow = await page.evaluate(() => {
    const el = document.querySelector('.plug-invalid-row');
    return el ? { dir: el.dataset.dir, text: el.innerText.trim() } : null;
  });
  check('manifest 非法的目录单独列出并带原因',
    invalidRow?.dir === 'broken' && /权限|permission/i.test(invalidRow.text), JSON.stringify(invalidRow));
  await shot('设置-插件列表');

  // ---------- C. 安装（含进行中状态） ----------
  section('安装插件（上传中 → 成功 → 列表与桌面即时刷新）');
  const beforeDesktop = await desktopIcon('notes');
  check('安装前桌面上没有 notes 图标', beforeDesktop === null);

  if (!pkgDir) {
    console.log(`${YELLOW}    跳过上传用例（--url 模式没有本地临时包，需以自起服务方式跑）${RESET}`);
  } else {
    holdInstallMs = 1800; // 拖住请求，让「安装中」稳定可见
    await upload(join(pkgDir, 'notes-big.zip'));
    const busyOk = await page.waitForSelector('.plug-progress', { timeout: 6000 }).then(() => true).catch(() => false);
    const busyText = await page.evaluate(() => ({
      label: document.querySelector('.plug-progress-label')?.innerText.trim() || '',
      pct: document.querySelector('.plug-progress-pct')?.innerText.trim() || '',
      disabledPick: !!document.querySelector('.plug-pick')?.disabled,
    }));
    check('上传中显示「正在安装」与进度条', busyOk && /正在安装/.test(busyText.label), JSON.stringify(busyText));
    check('上传中安装按钮被禁用（不会重复提交）', busyText.disabledPick);
    await shot('设置-安装中');

    // 等这次安装落地
    await page.waitForFunction(() => !!document.querySelector('.plug-row[data-plugin="notes"]'), { timeout: 30000 });
    await sleep(300);
    rows = await rowsOf();
    const notes1 = rows.find((r) => r.id === 'notes');
    check('安装成功：列表**不刷新**就多出 notes', !!notes1, rows.map((r) => r.id).join(','));
    check('新插件版本是 v1.0.0', notes1?.ver === 'v1.0.0', notes1?.ver);
    check('新插件权限显示为中文（本地存储 / 发送通知）',
      notes1?.permLabels.includes('本地存储') && notes1?.permLabels.includes('发送通知'),
      JSON.stringify(notes1?.permLabels));
    check('新插件显示文件关联（可打开 .note）', /\.note/.test(notes1?.ftypes || ''), notes1?.ftypes);
    const afterDesktop = await desktopIcon('notes');
    check('安装后桌面图标**立即**出现（无需刷新页面）', !!afterDesktop, JSON.stringify(afterDesktop));
    check('桌面图标用的是插件自己的 iconUrl', /\/pa\/[0-9a-f]{32}\/notes\/icon\.svg$/.test(afterDesktop?.icon || ''), afterDesktop?.icon);
    const st = await statusText();
    check('安装成功给出可读提示', /已安装/.test(st.ok), st.ok);
    await shot('设置-安装完成');
  }

  // ---------- D. 重复安装 409 → 覆盖确认 ----------
  section('重复安装（409 → 覆盖确认）');
  if (pkgDir) {
    await upload(join(pkgDir, 'notes-1.0.0.zip'));
    await page.waitForSelector('.dialog', { timeout: 15000 }).catch(() => {});
    await sleep(320); // 等弹框的 0.18s 入场动画跑完，否则截到半透明的一帧
    const dlg1 = await dialogText();
    check('重复安装弹「插件已存在」确认框', dlg1?.title === '插件已存在', JSON.stringify(dlg1));
    check('确认文案里带旧版本号', /v1\.0\.0/.test(dlg1?.message || ''), dlg1?.message);
    check('确认框有「覆盖安装 / 取消」两个选择',
      (dlg1?.buttons || []).includes('覆盖安装') && (dlg1?.buttons || []).includes('取消'), (dlg1?.buttons || []).join(','));
    await shot('设置-覆盖确认-取消前');

    await clickDialog('取消');
    await waitNoDialog();
    await sleep(400);
    rows = await rowsOf();
    check('选「取消」后列表没有变化（仍只有一份 notes，版本不变）',
      rows.filter((r) => r.id === 'notes').length === 1 && rows.find((r) => r.id === 'notes')?.ver === 'v1.0.0',
      JSON.stringify(rows.filter((r) => r.id === 'notes')));
    const allIds = rows.map((r) => r.id);
    check('取消后没有多出重复条目', allIds.length === new Set(allIds).size, allIds.join(','));

    // 再来一次，这次确认覆盖成 2.0.0
    await upload(join(pkgDir, 'notes-2.0.0.zip'));
    await page.waitForSelector('.dialog', { timeout: 15000 });
    const dlg2 = await dialogText();
    check('再次重复安装仍弹覆盖确认', /已存在/.test(dlg2?.message || ''), dlg2?.message);
    await clickDialog('覆盖安装');
    await waitNoDialog();
    await page.waitForFunction(() => {
      const r = document.querySelector('.plug-row[data-plugin="notes"] .plug-ver');
      return r && r.innerText.trim() === 'v2.0.0';
    }, { timeout: 30000 }).catch(() => {});
    rows = await rowsOf();
    const notes2 = rows.find((r) => r.id === 'notes');
    check('选「覆盖安装」后版本更新为 v2.0.0', notes2?.ver === 'v2.0.0', notes2?.ver);
    check('覆盖后列表里仍然只有一条 notes', rows.filter((r) => r.id === 'notes').length === 1);
    const st2 = await statusText();
    check('覆盖安装给出「覆盖了旧版本」的提示', /覆盖/.test(st2.ok), st2.ok);
    await shot('设置-覆盖后版本更新');
  }

  // ---------- E. 打开插件窗口 ----------
  section('从列表直接打开插件');
  {
    await page.evaluate(() => document.querySelector('.plug-row[data-plugin="notes"] .plug-open')?.click());
    const winOk = await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 })
      .then(() => true).catch(() => false);
    check('点「打开」启动插件窗口', winOk);
    const src = await page.evaluate(() => document.querySelector('.window .plugin-window iframe.plugin-frame')?.getAttribute('src') || '');
    check('插件窗口 iframe 指向该插件的 /pa entryUrl', /\/pa\/[0-9a-f]{32}\/notes\/index\.html$/.test(src), src);
    const sandbox = await page.evaluate(() => document.querySelector('.window .plugin-window iframe.plugin-frame')?.getAttribute('sandbox') || '');
    check('插件 iframe 仍然没有 allow-same-origin', sandbox === 'allow-scripts allow-forms', sandbox);
  }

  // ---------- F. 窄宽度 ----------
  section('600px 宽窗口不横溢');
  {
    // 视口宽度不能低于 768（那是移动端形态，桌面壳不会渲染）；
    // 真正要验的是「窗口被拉到 600px」——几何按类型持久化在 localStorage，
    // 这里直接种一份 600px 的几何，重进设置就是 600 宽的窗口（与手动拖动边一样）。
    await page.evaluate(() => {
      const key = 'cloudnine-win-geom';
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all.settings = { x: 60, y: 40, w: 600, h: 640 };
      localStorage.setItem(key, JSON.stringify(all));
    });
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.desktop-icons', { timeout: 20000 });
    await openSettings();
    const ov = await page.evaluate(() => {
      const win = document.querySelector('.settings-window');
      const main = document.querySelector('.set-main');
      const rows = [...document.querySelectorAll('.plug-row')];
      return {
        winW: Math.round(win.getBoundingClientRect().width),
        mainOverflow: main.scrollWidth - main.clientWidth,
        rowOverflow: Math.max(0, ...rows.map((r) => r.scrollWidth - r.clientWidth)),
        bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rows: rows.length,
      };
    });
    check('窗口宽度确实是 600px（并已装 2 个插件）', ov.winW >= 594 && ov.winW <= 600 && ov.rows >= 2, JSON.stringify(ov));
    check('600px 下内容区没有横向溢出', ov.mainOverflow <= 0 && ov.rowOverflow <= 0 && ov.bodyOverflow <= 0, JSON.stringify(ov));
    await shot('设置-600px宽');
    // 还原默认几何，后续截图用正常 760 宽
    await page.evaluate(() => {
      const key = 'cloudnine-win-geom';
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      delete all.settings;
      localStorage.setItem(key, JSON.stringify(all));
    });
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.desktop-icons', { timeout: 20000 });
    await openSettings();
  }

  // ---------- G. 错误态 ----------
  section('错误态（网络失败 / 超 8MB / manifest 非法）');
  if (pkgDir) {
    failNextInstall = true;
    await upload(join(pkgDir, 'notes-2.0.0.zip'));
    const netErr = await page.waitForFunction(
      () => document.querySelector('.plug-status.bad')?.innerText || '', { timeout: 15000 },
    ).then((h) => h.jsonValue()).catch(() => '');
    check('上传时网络失败 → 显示可读的错误文案', /网络|失败/.test(netErr), netErr);
    // 收尾：可能残留 409 弹窗（不会，请求是被 abort 的），确认没有弹窗挡路
    await waitNoDialog();

    const beforeCount = installRequests;
    await upload(join(pkgDir, 'too-big.zip'));
    await sleep(500);
    const tooBig = await page.evaluate(() => document.querySelector('.plug-status.bad')?.innerText.trim() || '');
    check('zip 超过 8 MB → 前端直接拦下并报真实体积', /8 MB/.test(tooBig) && /超过/.test(tooBig), tooBig);
    check('超限包没有被发出去（没有产生安装请求）', installRequests === beforeCount, `${beforeCount} → ${installRequests}`);

    // 修好一个坏目录不该让整个列表挂掉：这里只验状态持续可读
    const stillRows = (await rowsOf()).map((r) => r.id);
    check('出错之后列表仍然可用（hello / notes 都还在）',
      stillRows.includes('hello') && stillRows.includes('notes'), stillRows.join(','));
  }

  // ---------- H. 卸载 ----------
  section('卸载（二次确认 + 数据目录 + 桌面图标同步）');
  if (pkgDir) {
    // 先写入一点插件私有数据，卸载之后应当被一起删掉
    const put = await fetch(`${URL_BASE}/api/plugins/notes/storage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `cloudnine_sid=${sid}` },
      body: JSON.stringify({ data: { memo: '要跟着插件一起消失' } }),
    });
    const dataFile = join(pluginDataDir, 'notes.json');
    check('已写入插件私有数据文件（卸载前存在）', put.ok && existsSync(dataFile), `${put.status}`);

    await rowEl('notes');
    await page.evaluate(() => document.querySelector('.plug-row[data-plugin="notes"] .plug-remove')?.click());
    await page.waitForSelector('.dialog', { timeout: 8000 });
    await sleep(320); // 同上：避开入场动画
    const dlg3 = await dialogText();
    check('卸载前弹二次确认', dlg3?.title === '卸载插件', JSON.stringify(dlg3));
    check('确认文案提示会删除该插件的本地数据', /本地数据/.test(dlg3?.message || ''), dlg3?.message);
    await shot('设置-卸载确认');

    await clickDialog('取消');
    await waitNoDialog();
    await sleep(300);
    check('选「取消」后插件仍在列表里', (await rowsOf()).some((r) => r.id === 'notes'));
    check('选「取消」后桌面图标也还在', (await desktopIcon('notes')) !== null);

    await page.evaluate(() => document.querySelector('.plug-row[data-plugin="notes"] .plug-remove')?.click());
    await page.waitForSelector('.dialog', { timeout: 8000 });
    await clickDialog('卸载');
    await waitNoDialog();
    await page.waitForFunction(() => !document.querySelector('.plug-row[data-plugin="notes"]'), { timeout: 15000 }).catch(() => {});
    await sleep(400);
    check('确认卸载后列表立即移除该插件', !(await rowsOf()).some((r) => r.id === 'notes'));
    check('卸载后桌面图标**立即**消失（无需刷新）', (await desktopIcon('notes')) === null);
    check('该插件的窗口被一起关掉', await page.evaluate(() => document.querySelectorAll('.window .plugin-window').length === 0));
    check('插件私有数据文件已被删除', !existsSync(dataFile));
    check('插件目录已从磁盘删除', !existsSync(join(pluginsDir, 'notes')));
    const st3 = await statusText();
    check('卸载成功给出可读提示', /已卸载/.test(st3.ok), st3.ok);
    await shot('设置-卸载后');
  }

  // ---------- I. 暗色 ----------
  section('暗色主题');
  {
    await openSection('appearance');
    await page.evaluate(() => document.querySelector('[data-theme-choice="dark"]')?.click());
    await sleep(300);
    // 回到插件分区再量颜色（这时 .plug-name / .plug-row 才在 DOM 里）
    await openSection('plugins');
    await sleep(250);
    const dark = await page.evaluate(() => {
      const lum = (c) => {
        const m = String(c).match(/[\d.]+/g) || [];
        const [r, g, b] = m.map(Number);
        return 0.299 * r + 0.587 * g + 0.114 * b;
      };
      const nav = document.querySelector('.set-nav');
      const name = document.querySelector('.plug-name');
      const row = document.querySelector('.plug-row');
      return {
        attr: document.documentElement.dataset.theme,
        navLum: lum(getComputedStyle(nav).backgroundColor),
        rowLum: lum(getComputedStyle(row).backgroundColor),
        nameLum: lum(getComputedStyle(name).color),
      };
    });
    check('切到深色主题生效', dark.attr === 'dark', dark.attr);
    check('暗色下侧栏 / 卡片是深底、插件名是亮字（对比够看）',
      dark.navLum < 90 && dark.rowLum < 90 && dark.nameLum > 150, JSON.stringify(dark));
    await shot('设置-暗色');
    await openSection('appearance');
    await page.evaluate(() => document.querySelector('[data-theme-choice="light"]')?.click());
    await sleep(200);
    await openSection('plugins');
  }

  // ---------- J. 空态 ----------
  section('空态（一个插件都没装）');
  {
    await page.evaluate(() => document.querySelector('.plug-row[data-plugin="hello"] .plug-remove')?.click());
    await page.waitForSelector('.dialog', { timeout: 8000 });
    await clickDialog('卸载');
    await waitNoDialog();
    await page.waitForSelector('.plug-empty', { timeout: 15000 }).catch(() => {});
    const empty = await page.evaluate(() => ({
      text: document.querySelector('.plug-empty')?.innerText.trim() || '',
      rows: document.querySelectorAll('.plug-row').length,
      badge: !!document.querySelector('.set-nav-count'),
      icon: !!document.querySelector('.desktop-appicon[data-app="plugin:hello"]'),
    }));
    check('卸载到 0 个时显示空态文案', /还没有安装任何插件/.test(empty.text), empty.text);
    check('空态时列表 0 行、导航计数角标消失', empty.rows === 0 && !empty.badge, JSON.stringify(empty));
    check('空态时桌面上那个插件的图标也没了', !empty.icon);
    await shot('设置-空态');
  }

  // ---------- K. 控制台 ----------
  section('控制台');
  const ignorable = badResponses.filter((u) => /favicon\.ico/.test(u)
    || (/\/api\/plugins\/install/.test(u) && /^(409|413)/.test(u)));
  const realBad = badResponses.filter((u) => !ignorable.includes(u));
  // 人为 abort 的那一次上传必然有一条 net::ERR_FAILED，不算缺陷
  const realErrors = consoleErrors
    .filter((m) => !/Failed to load resource/.test(m))
    .filter((m) => !/net::ERR_FAILED|ERR_ABORTED/.test(m));
  if (ignorable.length) console.log(`${DIM}    忽略 favicon / 409 覆盖确认：${ignorable.length} 条${RESET}`);
  check('浏览器控制台无 JS 错误、无无关 4xx/5xx',
    realErrors.length === 0 && realBad.length === 0,
    JSON.stringify({ errors: realErrors.slice(0, 3), responses: realBad.slice(0, 5) }));

  await page.screenshot({ path: join(OUT_DIR, '99-final.png') });
}

// ================= 4. 收尾 =================
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
