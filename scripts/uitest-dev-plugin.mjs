#!/usr/bin/env node
/**
 * CloudNine 插件系统 · **dev 模式**端到端验收（vite dev server + 临时后端）
 *
 * ⚠️ 本套件专跑 dev（vite dev server，5173 那一套），**不能当生产测试的替代**：
 *    生产构建（client/dist + express）那套仍由 uitest-plugins / uitest-todo /
 *    uitest-json-plugin 覆盖。反过来也一样 —— 那三个套件全绿也证明不了 dev 能用。
 *
 * 为什么需要它（2026-11 真实事故）：
 *   client/vite.config.js 的 server.proxy 当时只代理了 /api 与 /ws。dev 下插件 iframe
 *   请求 /pa/<token>/<id>/index.html 落进 vite，被 SPA fallback 回成 vite 自己的
 *   index.html（带 @vite/client、/src/main.jsx、@react-refresh）→ iframe 是 opaque
 *   origin（故意不给 allow-same-origin）→ 这些脚本被 CORS 全拦 → 插件永远不发 cn:ready
 *   → 外壳 10 秒后弹「插件无法加载：10 秒内没有响应」。功能一套都没少，纯粹是代理漏配。
 *
 * 覆盖：
 *   1. dev 下的服务端路由代理：/pa 插件资源（真插件 HTML，不是 vite index.html）、
 *      /plugin-sdk/v1/cloudnine.js、以及 token 错误时由后端出的 404（而不是 vite 的 200）
 *   2. 「JSON 工具」真能打开：沙箱 iframe 加载 → 收到 cn:ready → 渲染出欢迎态文案，
 *      不是错误面板
 *   3. 「待办事项」真能打开：新输入框可用、加一条 → 落盘到 <PLUGIN_DATA_DIR>/todo.json；
 *      刷新页面重开数据仍在
 *   4. 控制台：**不得出现 CORS 报错**（`Access to script ... blocked by CORS policy`），
 *      无 JS 错误、无无关 4xx/5xx
 *
 * 环境隔离（不碰本机正在跑的 5173 / 8480，也不 kill 任何别人的进程）：
 *   - 自己起一个后端（默认 8741），DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT
 *     全在临时目录（为避开本机 esbuild 的 `Access is denied`，临时目录放仓库内 testroot/，
 *     不是系统 TEMP；跑完删）
 *   - 自己起一个 vite dev（默认 5273，--strictPort），CLOUDNINE_API 指向上面那个后端，
 *     CLOUDNINE_CACHE_DIR 指向临时目录（不和本机 dev 抢 node_modules/.vite）
 *   - 插件用 `scripts/plugin-dev-install.mjs <id> --dir <临时 PLUGINS_DIR>` 装，是真包
 *   - 跑完杀自己那两个子进程 + 删临时目录；截图落 shots/dev-plugin/
 *
 * 依赖：puppeteer-core（不含 Chromium，复用系统 Chrome）
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-dev-plugin.mjs
 *   node scripts/uitest-dev-plugin.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-dev-plugin.mjs --vite-port 5288 --port 8755   # 端口冲突时换一组
 *   node scripts/uitest-dev-plugin.mjs --keep                        # 保留临时目录（排障用）
 */

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const API_PORT = Number(arg('port', 8741));        // 临时后端
const VITE_PORT = Number(arg('vite-port', 5273));  // 临时 vite dev
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DEV_BASE = `http://127.0.0.1:${VITE_PORT}`;
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/dev-plugin'));

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
let apiChild = null;
let viteChild = null;
let tmpRoot = null;
const logs = { api: [], vite: [] };

async function waitHttp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

// 用「开发期安装脚本」装真插件（与仓库里手装 / zip 安装后的磁盘布局一致）
function installPlugin(id) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'plugin-dev-install.mjs'), id, '--dir', join(tmpRoot, 'data', 'plugins')], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`${RED}plugin-dev-install.mjs ${id} 失败（${r.status}）${RESET}\n${r.stdout || ''}${r.stderr || ''}`);
    process.exit(2);
  }
  console.log(`${DIM}    已安装插件 ${id}：${(r.stdout || '').split('\n')[0].trim()}${RESET}`);
}

async function startEnv() {
  // 临时目录**故意放在仓库内**的 testroot/（gitignored）而不是系统 TEMP：
  // 本机 esbuild 往 C:\Users\…\AppData\Local\Temp 下写产物会报 `Access is denied`
  // （vite 会在缓存目录里跑 esbuild 预构建，落在 TEMP 里就整套起不来）。
  const tmpBase = join(ROOT, 'testroot');
  mkdirSync(tmpBase, { recursive: true });
  tmpRoot = mkdtempSync(join(tmpBase, 'uitest-dev-plugin-'));
  const dataDir = join(tmpRoot, 'data');
  const filesRoot = join(tmpRoot, 'files');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  mkdirSync(filesRoot, { recursive: true });
  writeFileSync(join(filesRoot, 'readme.txt'), 'cloudnine dev plugin uitest\n');

  installPlugin('json');
  installPlugin('todo');

  // ---- 临时后端 ----
  apiChild = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PLUGINS_DIR: join(dataDir, 'plugins'),
      PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
      FILE_ROOT: filesRoot,
      SITE_NAME: 'CloudNine dev 插件自测',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiChild.stdout.on('data', (d) => logs.api.push(String(d)));
  apiChild.stderr.on('data', (d) => logs.api.push(String(d)));

  if (!await waitHttp(`${API_BASE}/api/state`, 30000)) {
    console.error(`${RED}临时后端 30 秒内没有起来${RESET}\n${logs.api.join('').slice(-4000)}`);
    process.exit(2);
  }
  console.log(`${DIM}临时后端：${API_BASE}（DATA_DIR=${dataDir}）${RESET}`);

  // ---- 临时 vite dev（独立缓存目录，不抢本机 dev 的 .vite）----
  const viteBin = join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    console.error(`${RED}找不到 ${viteBin}，请先 npm --prefix client install${RESET}`);
    process.exit(2);
  }
  viteChild = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: join(ROOT, 'client'),
    env: {
      ...process.env,
      CLOUDNINE_API: API_BASE,
      CLOUDNINE_CACHE_DIR: join(tmpRoot, 'vite-cache'),
      // esbuild 的临时产物（含上面那个缓存目录里的预构建输出）跟着临时目录走，别碰系统 TEMP
      TEMP: tmpRoot,
      TMP: tmpRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteChild.stdout.on('data', (d) => logs.vite.push(String(d)));
  viteChild.stderr.on('data', (d) => logs.vite.push(String(d)));

  // 首次预打包（CodeMirror 全家桶）在一个空缓存目录里要一会儿，给足 120 秒
  if (!await waitHttp(`${DEV_BASE}/`, 120000)) {
    console.error(`${RED}vite dev 120 秒内没有起来${RESET}\n${logs.vite.join('').slice(-4000)}`);
    await cleanup();
    process.exit(2);
  }
  console.log(`${DIM}临时 vite dev：${DEV_BASE}（CLOUDNINE_API=${API_BASE}）${RESET}`);
}

async function cleanup() {
  for (const child of [viteChild, apiChild]) {
    if (child && !child.killed) {
      try { child.kill(); } catch { /* 已退出 */ }
    }
  }
  await sleep(400);
  for (const child of [viteChild, apiChild]) {
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  }
  if (tmpRoot && !KEEP) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 上偶发占用：留着不影响 */ }
  } else if (tmpRoot) {
    console.log(`${DIM}已保留临时目录：${tmpRoot}${RESET}`);
  }
}

// ---------- 登录（走 dev 的代理，顺便验证 /api 仍然通） ----------
async function ensureAccount(sid) {
  const post = async (p, body) => {
    const r = await fetch(`${DEV_BASE}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return {
      status: r.status,
      text,
      sid: (r.headers.get('set-cookie') || '').match(/cloudnine_sid=([^;]+)/)?.[1] || null,
    };
  };
  const st = await (await fetch(`${DEV_BASE}/api/state`)).json();
  if (!st.initialized) await post('/api/init', { username: USERNAME, password: PASSWORD });
  const login = await post('/api/login', { username: USERNAME, password: PASSWORD });
  if (!login.sid) throw new Error(`登录失败（${login.status}）：${login.text.slice(0, 200)}`);
  return login.sid;
}

// ================= 2. 代理与路由（不依赖浏览器，直接打 dev 端口） =================
async function probeProxy(sid, plugins) {
  section('dev 下的服务端路由代理');

  const htmlText = async (url) => {
    const r = await fetch(url);
    return { status: r.status, type: r.headers.get('content-type') || '', csp: r.headers.get('content-security-policy') || '', body: await r.text() };
  };

  // 对照：vite 自己的 SPA fallback 确实存在（这正是不代理 /pa 时的坑）
  const spa = await htmlText(`${DEV_BASE}/this-route-does-not-exist`);
  check('对照：dev 下不存在的页面路由由 vite SPA fallback 出 index.html（含 @vite/client）',
    spa.status === 200 && /@vite\/client/.test(spa.body), `${spa.status} ${spa.body.slice(0, 80)}`);

  const json = plugins.find((p) => p.id === 'json') || {};
  const tok = (String(json.entryUrl || '').match(/^\/pa\/([0-9a-f]{32})\//) || [])[1] || '';
  check('插件列表里 /pa entryUrl 的 token 形如 32 位 hex', !!tok, json.entryUrl);

  if (!tok) return;

  const pa = await htmlText(`${DEV_BASE}/pa/${tok}/json/index.html`);
  check('/pa/<token>/json/index.html 经 dev 返回 200', pa.status === 200, String(pa.status));
  check('/pa 返回的是插件自己的 HTML（含 /plugin-sdk 引用）', /\/plugin-sdk\/v1\/cloudnine\.js/.test(pa.body), pa.body.slice(0, 120));
  check('/pa 返回的不是 vite 的 index.html（不含 @vite/client）', !pa.body.includes('@vite/client'), pa.body.slice(0, 200));
  check('/pa 返回的不是 vite 的 index.html（不含 /src/main.jsx）', !pa.body.includes('/src/main.jsx'), '');
  check('/pa 的 Content-Type 是 text/html，且透传了 CSP sandbox',
    /text\/html/.test(pa.type) && /sandbox/.test(pa.csp), `${pa.type} | ${pa.csp}`);

  const icon = await fetch(`${DEV_BASE}/pa/${tok}/json/icon.svg`);
  check('/pa/<token>/json/icon.svg 经 dev 返回 200 图片', icon.status === 200 && /svg/.test(icon.headers.get('content-type') || ''),
    `${icon.status} ${icon.headers.get('content-type')}`);

  // 关键：/pa 必须整段交给后端 —— 连 404 也得是后端出的纯文本，不能被 vite 兜成 200 的 index.html
  const badTok = await htmlText(`${DEV_BASE}/pa/${'0'.repeat(32)}/json/index.html`);
  check('token 错误的 /pa 由后端起判定（404 + 非 HTML 兜底，不是 vite 的 200）',
    badTok.status === 404 && !/<!DOCTYPE html>/i.test(badTok.body), `${badTok.status} ${badTok.body.slice(0, 60)}`);

  const sdk = await htmlText(`${DEV_BASE}/plugin-sdk/v1/cloudnine.js`);
  check('/plugin-sdk/v1/cloudnine.js 经 dev 返回 200 JS', sdk.status === 200 && /javascript/.test(sdk.type), `${sdk.status} ${sdk.type}`);
  check('SDK 内容真的是插件 SDK（含 cn:ready 与 cloudnine 全局）',
    /cn:ready/.test(sdk.body) && /cloudnine/i.test(sdk.body), sdk.body.slice(0, 80));

  const apis = await (await fetch(`${DEV_BASE}/api/plugins`, { headers: { cookie: `cloudnine_sid=${sid}` } })).json();
  check('/api 代理仍通（dev 下能拿到插件列表）', Array.isArray(apis.plugins) && apis.plugins.length >= 2,
    JSON.stringify((apis.plugins || []).map((p) => p.id)));
}

// ================= 3. 浏览器流程 =================
let browser = null;

async function main() {
  await startEnv();
  const sid = await ensureAccount();
  const listed = await (await fetch(`${DEV_BASE}/api/plugins`, { headers: { cookie: `cloudnine_sid=${sid}` } })).json();
  const plugins = listed.plugins || [];

  mkdirSync(OUT_DIR, { recursive: true });

  await probeProxy(sid, plugins);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.setCookie({
    name: 'cloudnine_sid', value: sid, domain: new URL(DEV_BASE).hostname, path: '/', httpOnly: true,
  });

  const consoleAll = [];
  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (m) => {
    consoleAll.push(`${m.type()}: ${m.text()}`);
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
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

  const dblclickAt = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };
  const appIconCenter = (id) => page.evaluate((pid) => {
    const r = document.querySelector(`.desktop-appicon[data-app="plugin:${pid}"]`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  const openPlugin = async (id) => {
    const box = await appIconCenter(id);
    await dblclickAt(box.x, box.y);
    await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 }).catch(() => {});
  };
  const frameOf = async (id) => {
    for (let i = 0; i < 80; i++) {
      const f = page.frames().find((x) => x.url().includes('/pa/') && x.url().includes(`/${id}/`));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  // 插件收到 cn:init 后会给自己打 data-cn-host="1"（todo / json 两个示例都这么做）
  const waitHost = async (f, ms = 12000) => {
    if (!f) return false;
    return f.waitForFunction(() => document.documentElement.dataset.cnHost === '1', { timeout: ms, polling: 100 })
      .then(() => true).catch(() => false);
  };
  const closeAllWindows = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(250);
  };
  // 一段用例中断也不能把后面的断言（尤其是「控制台无 CORS 报错」）一起带走：
  // 断掉的段单独记一条失败，继续跑。
  const guard = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 160);
      failed.push([`${label}（流程中断）`, msg, currentShot]);
      console.log(`${RED}  ✗${RESET} ${label}（流程中断）  ${YELLOW}${msg}${RESET}`);
    }
  };

  console.log(`${BOLD}CloudNine 插件 dev 模式自测${RESET}  页面: ${DEV_BASE}  接口: ${API_BASE}  截图: ${OUT_DIR}`);

  // ---------- 首屏（就是 dev 的 vite 页面）----------
  section('dev 首屏');
  await page.goto(DEV_BASE, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.desktop-icons', { timeout: 30000 });
  check('dev 页面正常渲染桌面（vite 出的 shell）', true);

  // ---------- JSON 工具 ----------
  section('「JSON 工具」在 dev 下真能打开');
  await guard('「JSON 工具」dev 开窗流程', async () => {
    const jsonIcon = await page.waitForSelector('.desktop-appicon[data-app="plugin:json"]', { timeout: 20000 })
      .then(() => true).catch(() => false);
    check('桌面出现 plugin:json 图标', jsonIcon);
    await shot('桌面-JSON工具图标');

    await openPlugin('json');
    const jsonFrame = await frameOf('json');
    check('双击后 iframe 已创建指向 /pa/…/json/index.html', !!jsonFrame, page.frames().map((f) => f.url()).join(' | '));
    const jsonAttrs = await page.evaluate(() => {
      const f = document.querySelector('.window .plugin-window iframe.plugin-frame');
      return f ? { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') } : null;
    });
    check('iframe src 用服务端 entryUrl（/pa/<32hex>/json/index.html）',
      /^\/pa\/[0-9a-f]{32}\/json\/index\.html$/.test(jsonAttrs?.src || ''), jsonAttrs?.src);
    check('iframe 仍是沙箱（allow-scripts allow-forms，无 allow-same-origin）',
      jsonAttrs?.sandbox === 'allow-scripts allow-forms', jsonAttrs?.sandbox);

    const jsonReady = await waitHost(jsonFrame);
    check('dev 下插件收到 cn:ready（documentElement.dataset.cnHost = 1）', jsonReady, '');
    // 状态栏文案要在 cn:ready 之后才被改写（json 插件：setMsg('就绪：…')）
    if (jsonFrame) {
      await jsonFrame.waitForFunction(
        () => /就绪/.test(document.getElementById('sb-msg')?.textContent || ''),
        { timeout: 8000, polling: 100 },
      ).catch(() => {});
    }
    const jsonUi = jsonFrame ? await jsonFrame.evaluate(() => ({
      title: document.querySelector('#pane-welcome .wtitle')?.textContent.trim() || '',
      msg: document.getElementById('sb-msg')?.textContent.trim() || '',
      errorPanel: !!document.querySelector('.fatal, .err-banner'),
      bodyText: (document.body.innerText || '').slice(0, 80),
    })).catch(() => null) : null;
    check('插件渲染出自己的界面（欢迎态标题「JSON 工具」）', jsonUi?.title === 'JSON 工具', JSON.stringify(jsonUi));
    check('插件提示已连上宿主（含「就绪」，不是「未连接宿主」）',
      /就绪/.test(jsonUi?.msg || '') && !/未连接宿主/.test(jsonUi?.msg || ''), jsonUi?.msg);

    // 足够久地待着：如果代理漏了，10 秒后外壳会翻成「插件无法加载」错误面板
    await sleep(4000);
    const errPanel = await page.evaluate(() => {
      const el = document.querySelector('.window .plugin-error');
      return el ? el.innerText.trim().slice(0, 120) : null;
    });
    check('超过 cn:ready 超时窗口后仍无「插件无法加载」错误面板', errPanel === null, String(errPanel));
    const devConsoleErrors = consoleAll.filter((m) => /@vite\/client|src\/main\.jsx|@react-refresh/.test(m));
    check('插件 iframe 没有去请求 vite 自己的脚本（无 @vite/client / main.jsx / react-refresh 报错）',
      devConsoleErrors.length === 0, devConsoleErrors.slice(0, 2).join(' | '));
    await shot('JSON工具-已就绪');

    await closeAllWindows();
  });

  // ---------- 待办事项 ----------
  section('「待办事项」在 dev 下真能打开');
  await guard('「待办事项」dev 开窗流程', async () => {
    const todoIcon = await page.waitForSelector('.desktop-appicon[data-app="plugin:todo"]', { timeout: 20000 })
      .then(() => true).catch(() => false);
    check('桌面出现 plugin:todo 图标', todoIcon);
    await openPlugin('todo');
    const todoFrame = await frameOf('todo');
    check('双击后 todo 的 iframe 指向 /pa/…/todo/index.html', !!todoFrame, page.frames().map((f) => f.url()).join(' | '));
    const todoReady = await waitHost(todoFrame);
    check('todo 也收到 cn:ready', todoReady);

    const inputEnabled = todoFrame ? await todoFrame.waitForFunction(
      () => document.getElementById('new-input') && !document.getElementById('new-input').disabled,
      { timeout: 12000, polling: 100 },
    ).then(() => true).catch(() => false) : false;
    check('todo 的输入框在 cn:ready 后启用（SDK 通路可用）', inputEnabled);
    const statusText = todoFrame ? await todoFrame.$eval('#status', (el) => el.textContent.trim()).catch(() => '') : '';
    check('todo 状态显示「已就绪」', /已就绪/.test(statusText), statusText);

    if (inputEnabled) {
      const TEXT = 'dev 代理自测';
      await todoFrame.$eval('#new-input', (el) => { el.focus(); });
      await page.keyboard.type(TEXT);
      await page.keyboard.press('Enter');
      const added = todoFrame.waitForFunction(
        (t) => [...document.querySelectorAll('#list .todo-item .todo-text')].some((e) => e.textContent.trim() === t),
        { timeout: 8000, polling: 100 }, TEXT,
      ).then(() => true).catch(() => false);
      check('在 dev 下新增一条待办并渲染出来', await added, TEXT);
      const savedOk = todoFrame.waitForFunction(
        () => /已保存/.test(document.getElementById('status').textContent),
        { timeout: 8000, polling: 100 },
      ).then(() => true).catch(() => false);
      check('新增触发落盘（状态显示「已保存」）', await savedOk);
      const dataFile = join(tmpRoot, 'data', 'plugin-data', 'todo.json');
      const raw = existsSync(dataFile) ? readFileSync(dataFile, 'utf8') : '';
      check('待办真落到 <PLUGIN_DATA_DIR>/todo.json（不是内存）', raw.includes(TEXT), raw.slice(0, 120));
      await shot('待办事项-已新增');

      // 刷新页面重开：dev 下 storage 通路仍正常
      await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
      await page.waitForSelector('.desktop-appicon[data-app="plugin:todo"]', { timeout: 30000 }).catch(() => {});
      await openPlugin('todo');
      const todoFrame2 = await frameOf('todo');
      await waitHost(todoFrame2);
      const stillThere = todoFrame2 ? await todoFrame2.waitForFunction(
        (t) => [...document.querySelectorAll('#list .todo-item .todo-text')].some((e) => e.textContent.trim() === t),
        { timeout: 12000, polling: 100 }, TEXT,
      ).then(() => true).catch(() => false) : false;
      check('刷新 dev 页面后重开 todo，数据仍在', stillThere);
      await shot('待办事项-刷新后仍在');
    } else {
      failed.push(['待办事项：新增/持久化（前置步骤未就绪，已跳过）', '输入框未启用', currentShot]);
    }
  });

  // ---------- 控制台 ----------
  section('控制台（本套件的核心防线）');
  const corsLines = consoleAll.filter((m) => /CORS|Access to script|blocked by CORS policy|cross-origin/i.test(m));
  check('控制台没有任何 CORS / 「Access to script … blocked」报错',
    corsLines.length === 0, corsLines.slice(0, 3).join(' | '));

  const ignorable = badResponses.filter((u) => /favicon\.ico/.test(u));
  const realBad = badResponses.filter((u) => !/favicon\.ico/.test(u));
  if (ignorable.length) console.log(`${DIM}    忽略 favicon 404：${ignorable.length} 条${RESET}`);
  check('dev 下没有无关的 4xx/5xx 响应', realBad.length === 0, realBad.slice(0, 5).join(' | '));

  const realErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
  check('dev 下没有 JS 报错 / pageerror', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

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
  exitCode = exitCode || 1;
}
process.exit(exitCode);
