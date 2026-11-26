#!/usr/bin/env node
/**
 * CloudNine 插件系统 · 前端外壳自测（第二期）
 *
 * 覆盖：桌面虚拟应用图标 → 双击开窗 → 沙箱 iframe（sandbox / 主题注入 / postMessage 协议）
 *       → storage 持久化（刷新后仍在）→ 拖动窗口时 iframe 不抢指针 → 开始菜单「插件」分组
 *       → 任务栏运行中按钮 → 关闭再打开 → 右键「从桌面移除」。
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全部落在系统临时目录，
 *   把 examples/plugins/hello 复制成已安装插件，端口用 8599，跑完杀进程 + 删目录。
 *
 * 依赖（puppeteer-core 不含 Chromium，复用系统 Chrome）：
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-plugins.mjs                       # 自起环境
 *   node scripts/uitest-plugins.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-plugins.mjs --url http://127.0.0.1:8499/ --user u --password p   # 复用已起好的实例
 *   node scripts/uitest-plugins.mjs --keep                # 保留临时目录（排障用）
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
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

const PORT = Number(arg('port', 8599));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/plugins'));

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

// ================= 1. 干净环境 =================

// 探针插件的页面：自动把 9 个 method 的成败 / 错误码写进 #log，ui.setTitle / ui.close 用按钮触发
const PROBE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>接口探针</title>
<style>body{font:13px/1.6 system-ui, sans-serif;margin:0;padding:12px;background:#fff;color:#1b1b1b}
.line{font-family:Consolas, monospace; font-size:11.5px; white-space:pre-wrap; word-break:break-all}
#log{max-height:320px;overflow:auto}</style></head>
<body>
<div id="log"></div>
<div style="margin-top:10px;display:flex;gap:8px">
  <button id="title-btn">ui.setTitle</button>
  <button id="close-btn">ui.close</button>
</div>
<script src="/plugin-sdk/v1/cloudnine.js"><\/script>
<script>
(function () {
  var log = function (k, v) {
    var d = document.createElement('div');
    d.className = 'line';
    d.dataset.k = k;
    d.textContent = k + '=' + (typeof v === 'string' ? v : JSON.stringify(v));
    document.getElementById('log').appendChild(d);
  };
  var fail = function (k) { return function (e) { log(k + '.err', (e && e.code) || String(e)); }; };
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && d.type === 'cn:result') log('result.' + d.id, d.ok ? 'ok' : 'fail');
  });
  (async function () {
    await cloudnine.ready();
    log('pid', cloudnine.pluginId);
    try { var a = await cloudnine.fs.list(''); log('fs.list.ok', String((a.entries || []).length)); } catch (e) { log('fs.list.err', e.code); }
    try { var b = await cloudnine.fs.readText('readme.txt'); log('fs.readText.ok', /cloudnine plugins uitest/.test(b.text || '') ? 'content' : 'bad'); } catch (e) { log('fs.readText.err', e.code); }
    try { await cloudnine.fs.readText('../outside.txt'); log('fs.traverse.ok', 'BAD'); } catch (e) { log('fs.traverse.err', e.code); }
    try { await cloudnine.fs.list('/etc'); log('fs.absolute.ok', 'BAD'); } catch (e) { log('fs.absolute.err', e.code); }
    try { await cloudnine.fs.writeText('probe-write.txt', 'x'); log('fs.write.ok', 'BAD'); } catch (e) { log('fs.write.err', e.code); }
    try { await cloudnine.storage.get(); log('storage.get.ok', 'BAD'); } catch (e) { log('storage.get.err', e.code); }
    try { await cloudnine.storage.set({ a: 1 }); log('storage.set.ok', 'BAD'); } catch (e) { log('storage.set.err', e.code); }
    try { await cloudnine.clipboard.writeText('x'); log('clipboard.ok', 'BAD'); } catch (e) { log('clipboard.err', e.code); }
    try { var n = await cloudnine.notify('探针', '没有 notify 权限时应被忽略'); log('notify.value', JSON.stringify(n)); } catch (e) { log('notify.err', e.code); }
    try { await cloudnine.call('bogus.method'); log('unknown.ok', 'BAD'); } catch (e) { log('unknown.err', e.code); }
    document.getElementById('title-btn').onclick = function () {
      cloudnine.ui.setTitle('探针标题').then(function (r) { log('ui.setTitle.ok', JSON.stringify(r)); }, fail('ui.setTitle'));
    };
    document.getElementById('close-btn').onclick = function () { cloudnine.ui.close(); };
  })();
})();
<\/script>
</body></html>`;
let child = null;
let tmpRoot = null;

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
  if (!st.initialized) {
    await post('/api/init', { username: USERNAME, password: PASSWORD });
  }
  const login = await post('/api/login', { username: USERNAME, password: PASSWORD });
  if (!login.sid) throw new Error(`登录失败（${login.status}）：${login.text.slice(0, 200)}`);
  return login.sid;
}

async function startOwnServer() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-plugins-uitest-'));
  const dataDir = join(tmpRoot, 'data');
  const filesRoot = join(tmpRoot, 'files');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  mkdirSync(join(filesRoot, 'docs'), { recursive: true });
  writeFileSync(join(filesRoot, 'readme.txt'), 'cloudnine plugins uitest\n');
  writeFileSync(join(filesRoot, 'docs', 'note.md'), '# note\n');
  mkdirSync(join(filesRoot, '支撑目录'), { recursive: true });

  // 「安装」示例插件：判定逻辑与 zip 安装后的磁盘布局一致（<PLUGINS_DIR>/<id>/plugin.json）
  cpSync(join(ROOT, 'examples', 'plugins', 'hello'), join(dataDir, 'plugins', 'hello'), { recursive: true });
  // 探针插件（只在临时目录里生成，不进仓库）：把 9 个 method / 参数校验 / 错误码全走一遍，
  // 权限只声明 fs.read，其余能力必须被宿主拒。
  const probeDir = join(dataDir, 'plugins', 'probe');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, 'plugin.json'), JSON.stringify({
    id: 'probe', name: '接口探针', version: '1.0.0',
    window: { width: 640, height: 520, minWidth: 400, minHeight: 300, multi: false },
    permissions: ['fs.read'], onDesktop: true, inStartMenu: true,
  }, null, 2));
  writeFileSync(join(probeDir, 'index.html'), PROBE_HTML);

  // 没接 SDK 的插件：用来验证「10 秒没 cn:ready → 错误面板 + 重新加载」
  const nosdkDir = join(dataDir, 'plugins', 'nosdk');
  mkdirSync(nosdkDir, { recursive: true });
  writeFileSync(join(nosdkDir, 'plugin.json'), JSON.stringify({
    id: 'nosdk', name: '不接 SDK 的插件', version: '1.0.0', onDesktop: true, inStartMenu: false,
  }, null, 2));
  writeFileSync(join(nosdkDir, 'index.html'), '<!DOCTYPE html><html lang="zh-CN"><body style="font:14px system-ui;padding:16px">没有引入插件 SDK 的页面</body></html>');

  child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PLUGINS_DIR: join(dataDir, 'plugins'),
      PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
      FILE_ROOT: filesRoot,
      SITE_NAME: 'CloudNine 插件自测',
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

// ================= 2. 浏览器流程 =================
let browser = null;

async function main() {
  if (OWN_SERVER) await startOwnServer();
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

  let shotIdx = 0;
  const shot = async (label) => {
    const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
    currentShot = name;
    console.log(`${DIM}    📸 ${name}${RESET}`);
    return name;
  };

  const pluginFrame = async () => {
    for (let i = 0; i < 60; i++) {
      const f = page.frames().find((x) => x.url().includes('/pa/') && x.url().includes('/hello/'));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  const winRect = () => page.evaluate(() => {    const w = document.querySelector('.window');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // CDP 里要拿到真正的 dblclick，必须给两次 press 的 clickCount 分别设 1 / 2
  const dblclickAt = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };
  const appIconCenter = () => page.evaluate(() => {
    const r = document.querySelector('.desktop-appicon[data-app="plugin:hello"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const closeAllWindows = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(250);
  };

  console.log(`${BOLD}CloudNine 插件外壳自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);

  // ---------- a. 桌面虚拟应用图标 ----------
  section('桌面虚拟应用图标');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  const iconOk = await page.waitForSelector('.desktop-appicon[data-app="plugin:hello"]', { timeout: 15000 })
    .then(() => true).catch(() => false);
  check('桌面出现 hello 插件的虚拟应用图标', iconOk);

  const layout = await page.evaluate(() => {
    const grid = document.querySelector('.desktop-grid');
    const kids = [...(grid?.children || [])];
    return {
      order: kids.map((el) => (el.classList.contains('desktop-sysicon') ? 'sys'
        : el.classList.contains('desktop-appicon') ? 'app'
          : el.dataset.entry ? 'file' : 'other')),
      label: document.querySelector('.desktop-appicon[data-app="plugin:hello"] .di-label')?.innerText.trim() || '',
      img: document.querySelector('.desktop-appicon[data-app="plugin:hello"] img')?.getAttribute('src') || '',
      sysCount: document.querySelectorAll('.desktop-sysicon').length,
    };
  });

  // 虚拟图标（插件）整体夹在「系统图标」与「真实文件图标」之间，顺序不受排序设置影响
  const firstFile = layout.order.indexOf('file');
  check('虚拟图标排在系统图标之后、真实文件图标之前',
    layout.order.slice(0, layout.sysCount).every((k) => k === 'sys')
    && layout.order[layout.sysCount] === 'app'
    && firstFile > 0
    && !layout.order.slice(firstFile).includes('app'),
    layout.order.join(','));
  check('图标标签是插件名', layout.label === '你好 CloudNine', layout.label);
  check('图标用的是服务端拼好的 /pa iconUrl', /^\/pa\/[0-9a-f]{32}\/hello\/icon\.svg$/.test(layout.img), layout.img);

  // 虚拟图标不进文件选中集：单击只活自己，文件选中集保持空
  const selProbe = await page.evaluate(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 120));
    document.querySelector('.desktop-icon[data-entry]')?.click();
    await tick();
    const fileSelBefore = document.querySelectorAll('.desktop-icon[data-entry].selected').length;
    document.querySelector('.desktop-appicon[data-app="plugin:hello"]')?.click();
    await tick();
    return {
      fileSelBefore,
      appSel: document.querySelectorAll('.desktop-appicon.selected').length,
      fileSel: document.querySelectorAll('.desktop-icon[data-entry].selected').length,
    };
  });
  check('单击虚拟图标只选中自己、不把文件带进选中集',
    selProbe.appSel === 1 && selProbe.fileSel === 0,
    JSON.stringify(selProbe));
  await shot('桌面-插件图标');

  // ---------- b. 双击开窗 + iframe 沙箱 ----------
  section('双击开窗 / iframe 沙箱属性');
  {
    const box = await appIconCenter();
    await dblclickAt(box.x, box.y);
  }
  const winOk = await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 })
    .then(() => true).catch(() => false);
  check('双击图标打开插件窗口（窗口里是 iframe）', winOk);

  const iframeAttrs = await page.evaluate(() => {
    const f = document.querySelector('.window .plugin-window iframe.plugin-frame');
    if (!f) return null;
    return {
      sandbox: f.getAttribute('sandbox'),
      sameOrigin: /allow-same-origin/.test(f.getAttribute('sandbox') || ''),
      referrer: f.getAttribute('referrerpolicy'),
      title: f.getAttribute('title'),
      src: f.getAttribute('src'),
      winTitle: document.querySelector('.window .window-title')?.innerText.trim() || '',
    };
  });
  check('sandbox 恰为 "allow-scripts allow-forms"', iframeAttrs?.sandbox === 'allow-scripts allow-forms', iframeAttrs?.sandbox);
  check('sandbox 不含 allow-same-origin', iframeAttrs && !iframeAttrs.sameOrigin);
  check('referrerpolicy=no-referrer', iframeAttrs?.referrer === 'no-referrer', iframeAttrs?.referrer);
  check('iframe title = 插件名', iframeAttrs?.title === '你好 CloudNine', iframeAttrs?.title);
  check('iframe src 用服务端 entryUrl（含 /pa token）', /^\/pa\/[0-9a-f]{32}\/hello\/index\.html$/.test(iframeAttrs?.src || ''), iframeAttrs?.src);
  check('窗口标题 = 插件名', iframeAttrs?.winTitle === '你好 CloudNine', iframeAttrs?.winTitle);
  await shot('插件窗口-已打开');

  // ---------- c. 主题注入 ----------
  section('cn:init / 主题变量注入');
  const frame = await pluginFrame();
  check('插件 iframe 已加载（能找到 /pa/.../hello/ 的 frame）', !!frame, page.frames().map((f) => f.url()).join(' | '));
  let theme = null;
  if (frame) {
    // 插件自己在 cn:ready 后把 pid 写上，等到它非空 = 宿主 cn:init 已经送达并被 SDK 应用
    for (let i = 0; i < 50; i++) {
      const pid = await frame.$eval('#pid', (el) => el.textContent.trim()).catch(() => '');
      if (pid === 'hello') break;
      await sleep(200);
    }
    theme = await frame.evaluate(() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const inline = {};
      for (let i = 0; i < root.style.length; i++) {
        const name = root.style[i];
        if (name.startsWith('--')) inline[name] = root.style.getPropertyValue(name).trim();
      }
      return {
        inlineCount: Object.keys(inline).length,
        accentInline: inline['--accent'] || '',
        accentComputed: (cs.getPropertyValue('--accent') || '').trim(),
        panelComputed: (cs.getPropertyValue('--panel-bg') || '').trim(),
        bgComputed: (cs.getPropertyValue('--bg') || '').trim(),
        pid: document.getElementById('pid')?.textContent.trim() || '',
        status: document.getElementById('status')?.textContent.trim() || '',
      };
    });
  }
  const hostAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('cn:init 里的 pluginId 已送达（插件读到 hello）', theme?.pid === 'hello', theme?.pid);
  check('documentElement 上注入了成批真实 CSS 变量（≥ 10 个）', (theme?.inlineCount || 0) >= 10, `${theme?.inlineCount} 个`);
  check('注入值是宿主当前主题的真实取值（--accent 与宿主一致）',
    !!theme?.accentInline && theme.accentInline === hostAccent && theme.accentComputed === hostAccent,
    `宿主=${hostAccent} 插件=${theme?.accentInline}/${theme?.accentComputed}`);
  check('--panel-bg / --bg 也已注入', !!theme?.panelComputed && !!theme?.bgComputed, JSON.stringify(theme));
  await shot('插件窗口-主题注入');

  // ---------- d. storage 持久化 ----------
  section('storage 持久化（3 次点击 → 刷新后仍为 3）');
  const readCount = async () => (frame ? frame.$eval('#count', (el) => el.textContent.trim()).catch(() => '') : '');
  const count0 = await readCount();
  check('初始计数为 0', count0 === '0', count0);
  for (let i = 0; i < 3; i++) {
    await frame.click('#hit');
    await sleep(400);
  }
  const count3 = await readCount();
  check('点 3 次计数 = 3', count3 === '3', count3);
  const statusText = await frame.$eval('#status', (el) => el.textContent.trim()).catch(() => '');
  check('插件提示「已就绪」（storage 读写通了）', /已就绪/.test(statusText), statusText);
  await shot('插件窗口-计数3');
  if (OWN_SERVER) {
    const dataFile = join(tmpRoot, 'data', 'plugin-data', 'hello.json');
    const raw = existsSync(dataFile) ? readFileSync(dataFile, 'utf8') : '';
    check('插件私有数据落在 <PLUGIN_DATA_DIR>/hello.json', /"count"\s*:\s*3/.test(raw), raw.slice(0, 120));
  }

  // ---------- 刷新页面 / 重开窗口 ----------
  section('刷新页面后重开窗口（storage 仍在）');
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-appicon[data-app="plugin:hello"]', { timeout: 20000 });
  const box2 = await appIconCenter();
  await dblclickAt(box2.x, box2.y);
  await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 }).catch(() => {});
  const frame2 = await pluginFrame();
  let countAfterReload = '';
  for (let i = 0; i < 40; i++) {
    countAfterReload = frame2 ? await frame2.$eval('#count', (el) => el.textContent.trim()).catch(() => '') : '';
    if (countAfterReload === '3') break;
    await sleep(250);
  }
  check('刷新页面重开窗口后计数仍为 3（storage 持久化）', countAfterReload === '3', countAfterReload);
  await shot('插件窗口-刷新后计数3');

  // ---------- e. 拖动窗口：iframe 不抢指针 ----------
  section('拖动窗口（iframe 必须让出指针）');
  const before = await winRect();
  const grabX = before.x + before.w / 2;
  const grabY = before.y + 16;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 40, grabY + 20, { steps: 4 });
  await sleep(120);
  const midState = await page.evaluate(() => {
    const f = document.querySelector('.window .plugin-window iframe.plugin-frame');
    const w = document.querySelector('.window');
    return {
      interacting: !!document.querySelector('.window.interacting'),
      iframePointer: f ? getComputedStyle(f).pointerEvents : 'no-iframe',
      cursor: w ? getComputedStyle(w).cursor : '',
    };
  });
  // 继续把指针拖到 iframe 内容区域（垂直 +180px），若 iframe 抢了指针，位置不会再变
  await page.mouse.move(grabX + 120, grabY + 180, { steps: 8 });
  await sleep(150);
  const midRect = await winRect();
  await page.mouse.up();
  await sleep(300);
  const after = await winRect();
  check('拖动期间窗口上挂 interacting 状态类', midState.interacting);
  check('拖动期间 iframe 的 pointer-events = none（不再吞指针）', midState.iframePointer === 'none', midState.iframePointer);
  check('指针进入 iframe 区域后窗口仍跟着移动', Math.abs(midRect.x - before.x) > 40 && Math.abs(midRect.y - before.y) > 100,
    `before=${JSON.stringify(before)} mid=${JSON.stringify(midRect)}`);
  check('松开后窗口位置确实改变并落库', (after.x !== before.x || after.y !== before.y) && Math.abs(after.x - (before.x + 120)) < 3,
    `before=(${before.x},${before.y}) after=(${after.x},${after.y})`);
  check('松开后 interacting 状态类被移除', await page.evaluate(() => !document.querySelector('.window.interacting')));
  await shot('插件窗口-拖动后');

  // ---------- f. 开始菜单 ----------
  section('开始菜单「插件」分组');
  await page.evaluate(() => document.querySelector('.tb-start')?.click());
  await page.waitForSelector('.startmenu', { timeout: 8000 });
  await sleep(250);
  const sm = await page.evaluate(() => ({
    builtin: [...document.querySelectorAll('.startmenu .sm-app')].map((e) => e.dataset.app),
    builtinLabels: [...document.querySelectorAll('.startmenu .sm-app-label')].map((e) => e.innerText.trim()),
    pluginTitles: [...document.querySelectorAll('.startmenu .sm-section-title')].map((e) => e.innerText.trim()),
    plugins: [...document.querySelectorAll('.startmenu .sm-plugin-app')].map((e) => e.dataset.plugin),
  }));
  check('内置已固定仍是 7 项（插件没混进 sm-app）', sm.builtin.length === 7, sm.builtin.join(','));
  check('内置 7 项名称与顺序不变',
    JSON.stringify(sm.builtinLabels) === JSON.stringify(['文件资源管理器', '终端', '记事本', '传输', '分享管理', '磁盘监控', '回收站']),
    sm.builtinLabels.join(','));
  check('出现「插件」分组标题', sm.pluginTitles.some((t) => t.startsWith('插件')), sm.pluginTitles.join(' | '));
  check('开始菜单里有 hello 插件项', sm.plugins.includes('hello'), sm.plugins.join(','));
  await shot('开始菜单-插件分组');
  await page.keyboard.press('Escape');
  await sleep(250);

  // ---------- g. 任务栏 ----------
  section('任务栏');
  const tb = await page.evaluate(() => ({
    pinned: [...document.querySelectorAll('.tb-app')].map((e) => e.getAttribute('title')),
    wins: [...document.querySelectorAll('.tb-win')].map((e) => e.innerText.trim()),
  }));
  check('任务栏固定项仍是 4 个', tb.pinned.length === 4, tb.pinned.join(','));
  check('打开的插件窗口在任务栏有「每窗口一个按钮」', tb.wins.includes('你好 CloudNine'), tb.wins.join(','));
  // 最小化 / 还原语义与内置窗口一致
  await page.evaluate(() => [...document.querySelectorAll('.tb-win')].find((b) => b.innerText.includes('你好 CloudNine'))?.click());
  await sleep(400);
  const minState = await page.evaluate(() => document.querySelectorAll('.window.minimized').length);
  await page.evaluate(() => [...document.querySelectorAll('.tb-win')].find((b) => b.innerText.includes('你好 CloudNine'))?.click());
  await sleep(500);
  const restoreState = await page.evaluate(() => ({
    min: document.querySelectorAll('.window.minimized').length,
    focused: document.querySelectorAll('.window.focused').length,
  }));
  check('点任务栏按钮能最小化插件窗口', minState === 1, String(minState));
  check('再点一次能还原并聚焦', restoreState.min === 0 && restoreState.focused === 1, JSON.stringify(restoreState));
  await shot('任务栏-插件窗口按钮');

  // ---------- h. 关闭再打开 ----------
  section('关闭再打开');
  await page.evaluate(() => document.querySelector('.window .tc-close')?.click());
  await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const closed = await page.evaluate(() => document.querySelectorAll('.window').length);
  check('点关闭按钮窗口消失', closed === 0, String(closed));
  await page.evaluate(() => {
    const el = document.querySelector('.desktop-appicon[data-app="plugin:hello"]');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 }).catch(() => {});
  const frame3 = await pluginFrame();
  let reopened = null;
  for (let i = 0; i < 40; i++) {
    reopened = frame3 ? await frame3.evaluate(() => ({
      count: document.getElementById('count')?.textContent.trim() || '',
      status: document.getElementById('status')?.textContent.trim() || '',
      accent: (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim(),
    })).catch(() => null) : null;
    if (reopened?.count === '3' && /已就绪/.test(reopened.status)) break;
    await sleep(250);
  }
  check('关闭后重新打开内容正常（计数 3 / 状态已就绪 / 主题仍在）',
    reopened?.count === '3' && /已就绪/.test(reopened?.status || '') && !!reopened?.accent, JSON.stringify(reopened));
  await shot('插件窗口-重新打开');

  // ---------- 右键菜单：只有「打开」「从桌面移除」 ----------
  section('虚拟图标的右键菜单');
  await closeAllWindows();
  await page.evaluate(() => {
    const el = document.querySelector('.desktop-appicon[data-app="plugin:hello"]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2),
    }));
  });
  await page.waitForSelector('.context-menu', { timeout: 5000 }).catch(() => {});
  const menu = await page.evaluate(() => [...document.querySelectorAll('.context-menu .dropdown-item')]
    .map((e) => e.dataset.label || e.innerText.trim()).filter(Boolean));
  check('右键菜单只有「打开」「从桌面移除」',
    JSON.stringify(menu) === JSON.stringify(['打开', '从桌面移除']), menu.join(','));
  await shot('右键菜单-虚拟图标');
  await page.evaluate(() => document.querySelector('.context-menu [data-label="从桌面移除"]')?.click());
  await sleep(400);
  check('「从桌面移除」后图标消失',
    await page.evaluate(() => !document.querySelector('.desktop-appicon[data-app="plugin:hello"]')));
  await page.evaluate(() => localStorage.removeItem('cloudnine-desktop-apps-hidden'));
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-appicon[data-app="plugin:hello"]', { timeout: 20000 }).catch(() => {});
  check('清掉本地名单后图标回来（移除只是本地名单，没卸载插件）',
    await page.evaluate(() => !!document.querySelector('.desktop-appicon[data-app="plugin:hello"]')));

  // ---------- 9 个 method / 参数校验 / 错误码（探针插件，权限只有 fs.read）----------
  section('宿主 method 与错误码（探针插件）');
  await closeAllWindows();
  {
    const box3 = await page.evaluate(() => {
      const r = document.querySelector('.desktop-appicon[data-app="plugin:probe"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await dblclickAt(box3.x, box3.y);
    await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 }).catch(() => {});
    let frameP = null;
    for (let i = 0; i < 60 && !frameP; i++) {
      frameP = page.frames().find((x) => x.url().includes('/probe/')) || null;
      if (!frameP) await sleep(200);
    }
    check('探针插件窗口已打开', !!frameP, page.frames().map((f) => f.url()).join(' | '));

    const readLog = async () => {
      if (!frameP) return {};
      return frameP.evaluate(() => {
        const out = {};
        document.querySelectorAll('#log .line').forEach((d) => { out[d.dataset.k] = (d.textContent.split('=').slice(1).join('=') || '').trim(); });
        return out;
      }).catch(() => ({}));
    };
    let probe = {};
    for (let i = 0; i < 60; i++) {
      probe = await readLog();
      if (probe['unknown.err'] !== undefined) break;
      await sleep(200);
    }
    const want = {
      pid: 'probe',
      'fs.list.ok': '3',                 // '' 根目录下：readme.txt / docs / 支撑目录
      'fs.readText.ok': 'content',
      'fs.traverse.err': 'INVALID_ARGUMENT',
      'fs.absolute.err': 'INVALID_ARGUMENT',
      'fs.write.err': 'PERMISSION_DENIED',
      'storage.get.err': 'PERMISSION_DENIED',
      'storage.set.err': 'PERMISSION_DENIED',
      'clipboard.err': 'PERMISSION_DENIED',
      'unknown.err': 'NOT_SUPPORTED',
    };
    for (const [k, v] of Object.entries(want)) {
      check(`接口探针 ${k} = ${v}`, probe[k] === v, String(probe[k]));
    }
    check('无 notify 权限：忽略并返回 ignored（不抛错）', /ignored/.test(probe['notify.value'] || ''), probe['notify.value']);
    check('fs.list 返回 entry 结构（name/dir/size/mtime）',
      await frameP.evaluate(async () => {
        const r = await window.cloudnine.fs.list('');
        const e = (r.entries || [])[0] || {};
        return ['name', 'dir', 'size', 'mtime'].every((k) => k in e);
      }).catch(() => false));

    // 伪造消息：宿主必须用 source + origin 双校验丢弃（origin 不是 'null'，source 也不是 iframe）
    await page.evaluate(() => {
      window.postMessage({ type: 'cn:call', id: 'forged-1', method: 'fs.list', params: { path: '' } }, '*');
      window.postMessage({ type: 'cn:call', id: 'forged-2', method: 'ui.close' }, '*');
    });
    await sleep(500);
    const afterForge = await readLog();
    check('宿主丢弃伪造的 cn:call（没回 result、窗口没被关）',
      !afterForge['result.forged-1'] && !afterForge['result.forged-2']
      && await page.evaluate(() => document.querySelectorAll('.window').length === 1),
      JSON.stringify({ r1: afterForge['result.forged-1'], r2: afterForge['result.forged-2'] }));

    // ui.setTitle：真的改宿主窗口标题
    await frameP.click('#title-btn');
    await sleep(400);
    const titleNow = await page.evaluate(() => document.querySelector('.window .window-title')?.innerText.trim() || '');
    check('ui.setTitle 改掉宿主窗口标题', titleNow === '探针标题', titleNow);
    await shot('探针插件-接口校验');

    // ui.close：真的关窗
    await frameP.click('#close-btn');
    await sleep(500);
    check('ui.close 关掉自己的窗口', await page.evaluate(() => document.querySelectorAll('.window').length === 0));
  }

  // ---------- 加载兑底：10 秒没 cn:ready / 加载失败 → 错误面板 + 重新加载 ----------
  section('加载兑底（没接 SDK 的插件）');
  await closeAllWindows();
  {
    const box4 = await page.evaluate(() => {
      const r = document.querySelector('.desktop-appicon[data-app="plugin:nosdk"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await dblclickAt(box4.x, box4.y);
    const errOk = await page.waitForSelector('.window .plugin-error', { timeout: 16000 }).then(() => true).catch(() => false);
    const errText = await page.$eval('.plugin-error', (el) => el.innerText).catch(() => '');
    check('10 秒没收到 cn:ready → 显示错误面板', errOk && /cn:ready/.test(errText), errText.slice(0, 80));
    check('错误面板带「重新加载」按钮', /重新加载/.test(errText));
    await shot('插件错误面板');
    await page.evaluate(() => document.querySelector('.plugin-error-retry')?.click());
    await sleep(800);
    check('点「重新加载」重建 iframe（错误面板消失）',
      await page.evaluate(() => !!document.querySelector('.window .plugin-frame') && !document.querySelector('.window .plugin-error')));
    await closeAllWindows();
  }

  // ---------- 移动端：插件不参与外壳 ----------
  section('移动端（插件不加载）');
  {
    const mp = await browser.newPage();
    await mp.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const mErrors = [];
    const pluginRequests = [];
    mp.on('console', (m) => { if (m.type() === 'error') mErrors.push(m.text()); });
    mp.on('pageerror', (e) => mErrors.push(`pageerror: ${e.message}`));
    mp.on('request', (r) => { if (r.url().includes('/api/plugins')) pluginRequests.push(r.url()); });
    await mp.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    const homeOk = await mp.waitForSelector('.m-home', { timeout: 20000 }).then(() => true).catch(() => false);
    await sleep(600);
    check('移动端正常启动（主屏幕渲染出来了）', homeOk);
    check('移动端不请求 /api/plugins（插件模块没被拉起）', pluginRequests.length === 0, pluginRequests.join(','));
    check('移动端没有桌面虚拟图标 / 插件窗口', await mp.evaluate(() => !document.querySelector('.desktop-appicon') && !document.querySelector('.plugin-frame')));
    const mReal = mErrors.filter((m) => !/Failed to load resource/.test(m));
    check('移动端控制台无 JS 错误', mReal.length === 0, mReal.slice(0, 3).join(' | '));
    await mp.screenshot({ path: join(OUT_DIR, '13-移动端-无插件.png') });
    console.log(`${DIM}    📸 13-移动端-无插件.png${RESET}`);
    await mp.close();
  }

  // ---------- 控制台 ----------
  section('控制台');
  // 浏览器自动请求的 favicon 不在用例范围内（个浏览器都这样）；其余 4xx/5xx 与 JS 报错一律算失败
  const ignorable = badResponses.filter((u) => /favicon\.ico/.test(u));
  const realBad = badResponses.filter((u) => !/favicon\.ico/.test(u));
  const realErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
  if (ignorable.length) console.log(`${DIM}    忽略 favicon 404：${ignorable.length} 条${RESET}`);
  check('浏览器控制台无 JS 错误、无无关 4xx/5xx',
    realErrors.length === 0 && realBad.length === 0,
    JSON.stringify({ errors: realErrors.slice(0, 3), responses: realBad.slice(0, 5) }));

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
