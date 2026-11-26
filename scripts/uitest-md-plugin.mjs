#!/usr/bin/env node
/**
 * CloudNine 插件系统 · 「Markdown」示例插件端到端验收
 *
 * 覆盖：
 *   欢迎态（file === null）→ 新建文件（真写盘）→ 双击 .md 走文件关联（defaultFor）
 *   → 三态切换（编辑 / 分栏 / 预览）+ 记住上次选择 + 分割条拖动
 *   → 编辑器（语法高亮 / 行号 / Tab 缩进 / 列表续行 / Ctrl+B I K ` S）
 *   → GFM 预览（标题 / 表格 / 任务列表 / 代码块高亮 / 引用 / 分隔线 / 行内代码 / 删除线 / 链接）
 *   → 消毒（<img onerror>、<script>、javascript:、data:text/html、data: 图片）
 *   → 大纲（点击跳转，预览与编辑两种目标）+ 分栏滚动联动
 *   → 脏标记（标题 * ）→ Ctrl+S 保存 → 磁盘文件真实变更（读临时 FILE_ROOT 核对）
 *   → 大文件（>1MB）只读预览 → 本地相对图片实测 → 亮 / 暗主题 → 560px 窄窗
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全在系统临时目录，端口 8702，跑完清理。
 *   插件用 scripts/plugin-dev-install.mjs md --dir <临时 PLUGINS_DIR> 装进去（与 zip 安装后同布局）。
 *
 * 依赖：puppeteer-core（不含 Chromium，复用系统 Chrome）
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-md-plugin.mjs
 *   node scripts/uitest-md-plugin.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-md-plugin.mjs --url http://127.0.0.1:8499/ --user u --password p
 *   node scripts/uitest-md-plugin.mjs --keep
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

const PORT = Number(arg('port', 8702));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/md'));

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

// ================= 1. 干净环境 =================
let child = null;
let tmpRoot = null;
let serverEnv = null;
let dataDir = null;
let filesRoot = null;
let pluginsDir = null;

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
  return log;
}

// 用开发期安装脚本装插件（--dir 指到临时 PLUGINS_DIR，不碰用户的 server/data）
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

const NOTE_MD = [
  '# CloudNine Markdown 自测',
  '',
  '这是一段用于验收的**示例文档**，含 *斜体*、~~删除线~~ 与 `行内代码`。',
  '',
  '## 列表与任务',
  '',
  '- 无序项一',
  '- 无序项二',
  '  - 嵌套项',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '',
  '- [x] 已完成的任务',
  '- [ ] 未完成的任务',
  '',
  '## 表格',
  '',
  '| 名称 | 数量 | 说明 |',
  '| :--- | ---: | :---: |',
  '| 苹果 | 12 | 红色 |',
  '| 香蕉 | 3 | 黄色 |',
  '',
  '## 代码块',
  '',
  '```js',
  '// 注释一行',
  'const answer = 42;',
  'function greet(name) {',
  '  return "hi " + name;',
  '}',
  '```',
  '',
  '> 引用：Markdown 里的引用块',
  '> 第二行同样在引用里',
  '',
  '---',
  '',
  '[CloudNine 示例站](https://example.com/docs)',
  '',
  '[危险的链接](javascript:alert(1))',
  '',
  '[相对链接](./other.md)',
  '',
  '![本地图片](./local-image.png)',
  '',
  '### 小结',
  '',
  '结论：都还好。',
  '',
  ...Array.from({ length: 40 }, (_, i) => `段落 ${i + 1}：用来把文档拉长，好验证编辑 ↔ 预览的滚动联动。`),
  '',
].join('\n');

const XSS_MD = [
  '# 消毒自测',
  '',
  '<img src=x onerror="window.__pwned=1">',
  '',
  '<script>window.__pwned=2</script>',
  '',
  '<svg onload="window.__pwned=5"></svg>',
  '',
  '[点我](javascript:window.__pwned=3)',
  '',
  '[数据](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19wd25lZD00PC9zY3JpcHQ+)',
  '',
  '![内联图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)',
  '',
  '**正常粗体** 与 <b>裸标签</b> 都要按文本显示。',
  '',
].join('\n');

async function prepareEnv() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-md-uitest-'));
  dataDir = join(tmpRoot, 'data');
  filesRoot = join(tmpRoot, 'files');
  pluginsDir = join(dataDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(join(filesRoot, 'docs'), { recursive: true });

  writeFileSync(join(filesRoot, 'note.md'), NOTE_MD, 'utf8');
  writeFileSync(join(filesRoot, 'alt.markdown'), '# 另一种扩展名\n\n.mdown / .markdown 也要能用。\n', 'utf8');
  writeFileSync(join(filesRoot, 'xss.md'), XSS_MD, 'utf8');
  // > 1MB：宿主 fs.readText 只会给前 512KB（truncated=true），插件据此进只读预览
  const bigLine = ('大文件行 '.repeat(30) + 'lorem ipsum dolor sit amet '.repeat(40) + '\n');
  writeFileSync(join(filesRoot, 'big.md'), bigLine.repeat(1200), 'utf8');
  writeFileSync(join(filesRoot, 'readme.txt'), 'cloudnine md uitest\n');

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
    SITE_NAME: 'CloudNine Markdown 自测',
  };
  await startServer();
  console.log(`${DIM}临时数据目录：${tmpRoot}${RESET}`);
  console.log(`${DIM}临时 FILE_ROOT：${filesRoot}${RESET}`);
}

async function cleanup() {
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

const readFileRoot = (name) => {
  const f = join(filesRoot, name);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

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

  // ---------- 宿主侧小工具 ----------
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
  const windowSnapshot = () => page.evaluate(() => [...document.querySelectorAll('.window')].map((w) => ({
    title: (w.querySelector('.window-title')?.innerText || '').trim(),
    frame: !!w.querySelector('iframe.plugin-frame'),
  })));
  const closeAllWindows = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(250);
  };
  const pluginFrame = async (ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      // 用 DOM 里的 iframe 元素取 contentFrame：page.frames() 在关窗/重开时会留下已脱立的旧帧，
      // 拿错帧会让“打字打在旧窗口里”这种假阳性看着像通过
      const iframes = await page.$$('.window iframe.plugin-frame').catch(() => []);
      const el = iframes[iframes.length - 1];
      if (el) {
        const f = await el.contentFrame().catch(() => null);
        if (f) {
          const alive = await f.evaluate(() => !!(window.cloudnine && document.getElementById('app')))
            .catch(() => false);
          if (alive) return f;
        }
      }
      await sleep(200);
    }
    return null;
  };
  // 插件里 #editor 有值 + 欢迎态隐藏 才算就绪
  const waitFrameReady = async (f, ms = 20000) => f.waitForFunction(
    () => document.getElementById('welcome') && (document.getElementById('welcome').hidden
      || /没有加载到插件 SDK|初始化失败/.test(document.getElementById('welcome-error').textContent)),
    { timeout: ms, polling: 100 },
  ).then(() => true).catch(() => false);

  // 在 iframe 元素上做真实鼠标点击（沙箱 iframe 里没有用户激活时 focus() 会被拒）
  const frameOffset = () => page.evaluate(() => {
    const all = document.querySelectorAll('.window iframe.plugin-frame');
    const b = all[all.length - 1].getBoundingClientRect();
    return { x: b.x, y: b.y };
  });
  const rectInFrame = (f, sel) => (f && f.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel));
  const clickInFrame = async (f, sel, dy = 0) => {
    const r = await rectInFrame(f, sel);
    if (!r) throw new Error(`找不到元素：${sel}`);
    const off = await frameOffset();
    await page.mouse.click(off.x + r.x + Math.min(r.w / 2, 40), off.y + r.y + r.h / 2 + dy);
    await sleep(90);
  };
  const key = async (combo) => { await page.keyboard.down('Control'); await page.keyboard.press(combo); await page.keyboard.up('Control'); };

  const openFileEntry = async (name) => {
    const box = await centerOf(`.desktop-icon[data-entry="${name}"]`);
    if (!box) throw new Error(`桌面上找不到文件图标：${name}`);
    await dblclickAt(box.x, box.y);
    await sleep(600);
    const f = await pluginFrame();
    if (!f) return null;
    await waitFrameReady(f);
    return f;
  };
  const openPluginApp = async () => {
    const box = await centerOf('.desktop-appicon[data-app="plugin:md"]');
    if (!box) throw new Error('桌面上找不到 Markdown 插件图标');
    await dblclickAt(box.x, box.y);
    await sleep(500);
    const f = await pluginFrame();
    if (!f) return null;
    await waitFrameReady(f);
    return f;
  };

  const mdState = (f) => f.evaluate(() => (window.__mdState ? window.__mdState() : null));
  const previewInfo = (f) => f.evaluate(() => {
    const pv = document.getElementById('preview');
    return {
      html: pv.innerHTML,
      text: pv.textContent || '',
      h: [...pv.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({ tag: h.tagName, text: h.textContent.trim() })),
      table: pv.querySelector('table') ? {
        th: [...pv.querySelectorAll('thead th')].map((c) => c.textContent.trim()),
        rows: pv.querySelectorAll('tbody tr').length,
        firstCell: pv.querySelector('tbody td')?.textContent.trim() || '',
        align: pv.querySelector('tbody td')?.style.textAlign || '',
        aligns: [...pv.querySelectorAll('tbody tr:first-child td')].map((c) => c.style.textAlign || ''),
      } : null,
      tasks: [...pv.querySelectorAll('li.task')].map((li) => ({
        checked: !!li.querySelector('input[type=checkbox]')?.checked,
        text: li.textContent.trim(),
      })),
      code: pv.querySelector('.md-code') ? {
        lang: pv.querySelector('.md-code-lang')?.textContent.trim(),
        body: pv.querySelector('pre')?.textContent || '',
        kw: pv.querySelectorAll('.c-kw').length,
        str: pv.querySelectorAll('.c-str').length,
        com: pv.querySelectorAll('.c-com').length,
        scrolls: pv.querySelector('pre') ? pv.querySelector('pre').scrollWidth >= pv.querySelector('pre').clientWidth : false,
      } : null,
      quote: !!pv.querySelector('blockquote'),
      hr: !!pv.querySelector('hr'),
      inlineCode: pv.querySelector('p code')?.textContent || '',
      del: [...pv.querySelectorAll('del')].map((d) => d.textContent),
      strong: [...pv.querySelectorAll('strong')].map((d) => d.textContent),
      em: [...pv.querySelectorAll('em')].map((d) => d.textContent),
      links: [...pv.querySelectorAll('a')].map((a) => ({
        href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'),
        text: a.textContent.trim(),
      })),
      deadLinks: [...pv.querySelectorAll('.md-link-off')].map((s) => ({ text: s.textContent.trim(), title: s.getAttribute('title') || '' })),
      missingImgs: [...pv.querySelectorAll('.md-img-missing')].map((s) => s.textContent.trim()),
      imgs: [...pv.querySelectorAll('img')].map((i) => ({
        src: i.getAttribute('src'), onerror: i.getAttribute('onerror'),
      })),
      scripts: pv.querySelectorAll('script').length,
      wide: pv.scrollWidth - pv.clientWidth,
    };
  });

  console.log(`${BOLD}CloudNine Markdown 插件自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);

  // ---------- 1. 安装 + 服务端插件对象 ----------
  section('安装（plugin-dev-install）与服务端插件对象');
  if (OWN_SERVER) {
    check('plugin-dev-install 把 md 插件铺进临时 PLUGINS_DIR',
      existsSync(join(pluginsDir, 'md', 'plugin.json')) && existsSync(join(pluginsDir, 'md', 'icon.svg')));
  }
  const apiPlugins = await (await fetch(`${URL_BASE}/api/plugins`, { headers: { cookie: `cloudnine_sid=${sid}` } })).json();
  const md = (apiPlugins.plugins || []).find((p) => p.id === 'md');
  check('GET /api/plugins 里有 md，名字 / 版本正确', md && md.name === 'Markdown' && md.version === '1.0.0', JSON.stringify(md));
  check('fileTypes / defaultFor = .md .markdown .mdown（双击直接进本插件）',
    JSON.stringify(md?.fileTypes) === JSON.stringify(['.md', '.markdown', '.mdown'])
    && JSON.stringify(md?.defaultFor) === JSON.stringify(['.md', '.markdown', '.mdown']),
    JSON.stringify({ fileTypes: md?.fileTypes, defaultFor: md?.defaultFor }));
  check('权限含 storage / fs.read / fs.write / clipboard.write',
    ['storage', 'fs.read', 'fs.write', 'clipboard.write'].every((p) => (md?.permissions || []).includes(p)),
    JSON.stringify(md?.permissions));
  check('entryUrl / iconUrl 由服务端签名拼接',
    /^\/pa\/[0-9a-f]{32}\/md\/index\.html$/.test(md?.entryUrl || '') && /icon\.svg$/.test(md?.iconUrl || ''),
    `${md?.entryUrl} ${md?.iconUrl}`);
  check('窗口初始尺寸 1040×680 / 最小 560×380 / 多开', md?.window?.width === 1040
    && md?.window?.height === 680 && md?.window?.minWidth === 560 && md?.window?.minHeight === 380 && md?.window?.multi === true,
    JSON.stringify(md?.window));

  // ---------- 2. 桌面图标 ----------
  section('桌面虚拟图标');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  const iconOk = await page.waitForSelector('.desktop-appicon[data-app="plugin:md"]', { timeout: 15000 })
    .then(() => true).catch(() => false);
  check('桌面出现 Markdown 虚拟图标', iconOk);
  const iconMeta = await page.evaluate(() => {
    const el = document.querySelector('.desktop-appicon[data-app="plugin:md"]');
    return {
      label: el?.querySelector('.di-label')?.textContent.trim() || '',
      img: el?.querySelector('img')?.getAttribute('src') || '',
    };
  });
  check('图标标签 = Markdown，图标来自 /pa 的 icon.svg',
    iconMeta.label === 'Markdown' && /^\/pa\/[0-9a-f]{32}\/md\/icon\.svg$/.test(iconMeta.img), JSON.stringify(iconMeta));
  await page.waitForSelector('.desktop-icon[data-entry="note.md"]', { timeout: 15000 }).catch(() => {});
  await shot('桌面-图标');

  // ---------- 3. 欢迎态（file === null） ----------
  section('欢迎态（从桌面图标启动，file 为 null）');
  let frame = await openPluginApp();
  check('双击插件图标打开窗口（iframe 沙箱）', !!frame);
  const attrs = await page.evaluate(() => {
    const f = document.querySelector('.window .plugin-window iframe.plugin-frame');
    return f ? {
      sandbox: f.getAttribute('sandbox'), title: f.getAttribute('title'), src: f.getAttribute('src'),
      winTitle: document.querySelector('.window .window-title')?.innerText.trim() || '',
    } : null;
  });
  check('iframe sandbox 恰为 "allow-scripts allow-forms"（不含 allow-same-origin）',
    attrs?.sandbox === 'allow-scripts allow-forms', attrs?.sandbox);
  check('未标脏时窗口标题没有 *（= Markdown）', attrs?.winTitle === 'Markdown', attrs?.winTitle);
  const welcomeState = frame ? await frame.evaluate(() => ({
    visible: !document.getElementById('welcome').hidden,
    sub: document.getElementById('welcome-sub').textContent.trim(),
    nameValue: document.getElementById('new-name').value,
    newEnabled: !document.getElementById('new-btn').disabled,
    docName: document.getElementById('doc-name').textContent.trim(),
    hasDoc: !!window.__mdState().doc,
    headingCount: document.querySelectorAll('#outline-list .outline-item').length,
  })) : null;
  check('欢迎态可见，文案提示「还没有打开文件」',
    welcomeState?.visible && /还没有打开文件/.test(welcomeState.sub), JSON.stringify(welcomeState));
  check('欢迎态下 cn:init 的 file 为 null（没有打开文档）', welcomeState?.hasDoc === false, JSON.stringify(welcomeState));
  check('新建输入框默认「未命名.md」且按钮可用', welcomeState?.nameValue === '未命名.md' && welcomeState.newEnabled, JSON.stringify(welcomeState));
  check('欢迎态大纲为空（0 条标题）', welcomeState?.headingCount === 0, String(welcomeState?.headingCount));
  await shot('欢迎态');

  // 新建文件：真的写盘
  await clickInFrame(frame, '#new-name');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('welcome-new.md');
  await clickInFrame(frame, '#new-btn');
  const created = await frame.waitForFunction(() => document.getElementById('welcome').hidden, { timeout: 8000 })
    .then(() => true).catch(() => false);
  const createdState = created ? await frame.evaluate(() => ({
    docName: document.getElementById('doc-name').textContent.trim(),
    doc: window.__mdState().doc,
    save: document.getElementById('st-save').textContent.trim(),
  })) : null;
  check('新建后欢迎态消失、文档名变成 welcome-new.md',
    created && createdState?.docName === 'welcome-new.md' && createdState?.doc?.rel === 'welcome-new.md',
    JSON.stringify(createdState));
  check('新建的文件真的落到磁盘（临时 FILE_ROOT/welcome-new.md）', readFileRoot('welcome-new.md') === '');
  const titleAfterNew = await page.evaluate(() => document.querySelector('.window .window-title')?.innerText.trim() || '');
  check('新建后窗口标题 = 文件名', titleAfterNew === 'welcome-new.md', titleAfterNew);
  await closeAllWindows();

  // ---------- 4. 文件关联打开 ----------
  section('文件关联打开（双击 note.md → defaultFor）');
  frame = await openFileEntry('note.md');
  check('双击 note.md 直接用本插件打开（不是内置编辑器）', !!frame);
  const opened = frame ? await frame.evaluate(() => ({
    doc: window.__mdState().doc,
    mode: window.__mdState().mode,
    textLen: document.getElementById('editor').value.length,
    dirty: document.getElementById('st-save').dataset.state,
    saveText: document.getElementById('st-save').textContent.trim(),
    welcomeHidden: document.getElementById('welcome').hidden,
  })) : null;
  check('cn:init 的 file.rel = note.md，插件自己用 fs.readText 读了内容',
    opened?.doc?.rel === 'note.md' && opened?.textLen > 500, JSON.stringify(opened));
  check('编辑器内容与磁盘原文一致', frame && (await frame.evaluate(() => document.getElementById('editor').value)) === NOTE_MD);
  const titleOpened = await page.evaluate(() => document.querySelector('.window .window-title')?.innerText.trim() || '');
  check('窗口标题变成文件名，未标脏没有 *', titleOpened === 'note.md', titleOpened);
  check('刚打开时不脏（状态栏「已保存」）', opened?.dirty === 'saved' && opened?.saveText === '已保存', JSON.stringify(opened));
  check('默认视图是分栏（编辑 + 预览两栏都在）',
    opened?.mode === 'split' && await frame.evaluate(() => {
      const e = document.querySelector('.pane-edit').getBoundingClientRect();
      const p = document.querySelector('.pane-preview').getBoundingClientRect();
      return e.width > 50 && p.width > 50;
    }), JSON.stringify(opened));
  await shot('分栏态-note');

  // 高亮层与 textarea 的行高 / 折行必须一致，否则光标会飘：用 scrollHeight 对齐来卡住
  const metrics = await frame.evaluate(() => ({
    ta: document.getElementById('editor').scrollHeight,
    hl: document.getElementById('hl').scrollHeight,
    taFont: getComputedStyle(document.getElementById('editor')).font,
    hlFont: getComputedStyle(document.getElementById('hl')).font,
    taPad: getComputedStyle(document.getElementById('editor')).paddingLeft,
    hlPad: getComputedStyle(document.getElementById('hl')).paddingLeft,
  }));
  check('高亮层与 textarea 字体 / 内边距 / 总高一致（光标不会飘）',
    metrics.taFont === metrics.hlFont && metrics.taPad === metrics.hlPad
    && Math.abs(metrics.ta - metrics.hl) <= 4, JSON.stringify(metrics));

  // .markdown / .mdown 也声明了 fileTypes/defaultFor
  await closeAllWindows();
  frame = await openFileEntry('alt.markdown');
  const altState = frame ? await mdState(frame) : null;
  const altPreview = frame ? await frame.evaluate(() => document.querySelector('#preview h1')?.textContent.trim()) : null;
  check('.markdown 扩展名也走本插件，并按 markdown 渲染',
    altState?.doc?.rel === 'alt.markdown' && altPreview === '另一种扩展名', JSON.stringify({ altState, altPreview }));

  // 渲染边界：setext 标题 / ~~~ 围栏 / start>1 有序列表 / 嵌套引用 / 硬换行 / 转义竖线
  const CRAFTED = [
    'Setext 一级',
    '============',
    '',
    'Setext 二级',
    '------------',
    '',
    '~~~py',
    'def go(x):',
    '    return x + 1',
    '~~~',
    '',
    '3. 第三项',
    '4. 第四项',
    '',
    '> 外层引用',
    '>',
    '> > 内层引用',
    '',
    '硬换行行尾两个空格  ',
    '换到下一行',
    '',
    '| a \\| b | c |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
  ].join('\n');
  const originalAlt = await frame.evaluate(() => document.getElementById('editor').value);
  await frame.evaluate((txt) => {
    const ta = document.getElementById('editor');
    ta.value = txt;                       // 模拟粘贴：走真正的 input 事件，而不是绕过应用逻辑
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, CRAFTED);
  await sleep(400);
  const edge = await frame.evaluate(() => {
    const pv = document.getElementById('preview');
    return {
      h1: pv.querySelector('h1')?.textContent.trim(),
      h2: pv.querySelector('h2')?.textContent.trim(),
      fenceLang: pv.querySelector('.md-code-lang')?.textContent.trim(),
      fenceKw: pv.querySelectorAll('.c-kw').length,
      olStart: pv.querySelector('ol')?.getAttribute('start'),
      olItems: pv.querySelectorAll('ol > li').length,
      quoteDepth: pv.querySelectorAll('blockquote blockquote').length,
      brs: pv.querySelectorAll('p br').length,
      cell: pv.querySelector('thead th')?.textContent.trim(),
      wide: pv.scrollWidth - pv.clientWidth,
    };
  });
  check('setext 标题（=== / ---）渲染成 h1 / h2', edge.h1 === 'Setext 一级' && edge.h2 === 'Setext 二级',
    JSON.stringify(edge));
  check('~~~ 围栏代码块可以，语言标签 + 关键字高亮', edge.fenceLang === 'py' && edge.fenceKw >= 1, JSON.stringify(edge));
  check('有序列表 start=3 保留、两项都在', edge.olStart === '3' && edge.olItems === 2, JSON.stringify(edge));
  check('嵌套引用 / 行尾两空格的硬换行 / 表头里的转义竖线都正常',
    edge.quoteDepth === 1 && edge.brs >= 1 && edge.cell === 'a | b', JSON.stringify(edge));
  check('这批边界语法也没有横向溢出', edge.wide <= 0, String(edge.wide));
  // 恢复原文（不能保存，否则这个文件就不是测试预期的那份了）
  await frame.evaluate((txt) => {
    const ta = document.getElementById('editor');
    ta.value = txt;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, originalAlt);
  await sleep(250);
  const altDirty = await frame.evaluate(() => window.__mdState().dirty);
  check('恢复原文后不再脏（关窗不会弹确认）', altDirty === false, String(altDirty));
  await closeAllWindows();
  frame = await openFileEntry('note.md');
  await waitFrameReady(frame);

  // ---------- 5. GFM 预览 ----------
  section('GFM 预览渲染');
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(320);
  const pv = await previewInfo(frame);
  check('三态切到「预览」：编辑器隐藏、预览占满、状态栏显示「预览」',
    await frame.evaluate(() => getComputedStyle(document.querySelector('.pane-edit')).display === 'none'
      && document.getElementById('st-mode').textContent.trim() === '预览'
      && document.querySelector('[data-mode="preview"]').getAttribute('aria-pressed') === 'true'));
  check('标题层级 h1 / h2 / h3 都渲染出来',
    pv.h.filter((h) => h.tag === 'H1').length === 1 && pv.h.filter((h) => h.tag === 'H2').length === 3
    && pv.h.filter((h) => h.tag === 'H3').length === 1, JSON.stringify(pv.h.map((h) => h.tag)));
  check('表格：3 列 / 2 行数据 / 每列对齐方式生效（left / right / center）',
    pv.table && pv.table.th.length === 3 && pv.table.rows === 2 && pv.table.firstCell === '苹果'
    && JSON.stringify(pv.table.aligns) === JSON.stringify(['left', 'right', 'center']),
    JSON.stringify(pv.table));
  check('任务列表：一条已勾选、一条未勾选',
    pv.tasks.length === 2 && pv.tasks[0].checked === true && pv.tasks[1].checked === false, JSON.stringify(pv.tasks));
  check('代码块带语言标签 js + 基础高亮（关键字 / 字符串 / 注释）',
    pv.code?.lang === 'js' && pv.code.kw > 2 && pv.code.str > 0 && pv.code.com > 0, JSON.stringify(pv.code));
  check('代码块内容原样保留（含 42 与 greet）', /42/.test(pv.code?.body || '') && /greet/.test(pv.code?.body || ''),
    (pv.code?.body || '').slice(0, 60));
  check('引用块 / 分隔线 / 行内代码都在', pv.quote && pv.hr && pv.inlineCode === '行内代码',
    JSON.stringify({ quote: pv.quote, hr: pv.hr, code: pv.inlineCode }));
  check('粗体 / 斜体 / 删除线都渲染', pv.strong.includes('示例文档') && pv.em.includes('斜体')
    && pv.del.includes('删除线'), JSON.stringify({ strong: pv.strong, em: pv.em, del: pv.del }));
  check('外链带 target=_blank 和 rel="noopener noreferrer"',
    pv.links.length === 1 && pv.links[0].href === 'https://example.com/docs'
    && pv.links[0].target === '_blank' && pv.links[0].rel === 'noopener noreferrer', JSON.stringify(pv.links));
  check('相对链接 / javascript: 链接都不生成 href（变成不可点的文本）',
    pv.deadLinks.length === 2 && !pv.html.includes('javascript:')
    && pv.deadLinks.every((d) => /已忽略/.test(d.title)), JSON.stringify(pv.deadLinks));
  check('本地相对图片渲染成占位框（不是破图，文案不惊悚）',
    pv.missingImgs.length === 1 && /本地图片暂不支持预览/.test(pv.missingImgs[0]), JSON.stringify(pv.missingImgs));
  check('预览没有横向溢出（长表格 / 代码块自己滚）', pv.wide <= 0, String(pv.wide));
  await shot('纯预览-GFM');

  // ---------- 6. 大纲 ----------
  section('大纲（H1-H6 树 + 点击跳转）');
  const outlineInfo = await frame.evaluate(() => ({
    count: document.querySelectorAll('#outline-list .outline-item').length,
    counter: document.getElementById('outline-count').textContent.trim(),
    levels: [...document.querySelectorAll('#outline-list .outline-item')].map((b) => b.dataset.level),
    texts: [...document.querySelectorAll('#outline-list .outline-item')].map((b) => b.textContent.replace(/^#+/, '').trim()),
    hashes: [...document.querySelectorAll('#outline-list .outline-item .ol-hash')].map((s) => s.textContent),
  }));
  check('大纲条目数 = 标题数（5），计数徽标一致', outlineInfo.count === 5 && outlineInfo.counter === '5',
    JSON.stringify(outlineInfo));
  check('大纲层级正确（1,2,2,2,3）且 # 记号与级别对应',
    JSON.stringify(outlineInfo.levels) === JSON.stringify(['1', '2', '2', '2', '3'])
    && outlineInfo.hashes[0] === '#' && outlineInfo.hashes[1] === '##' && outlineInfo.hashes[4] === '###',
    JSON.stringify({ levels: outlineInfo.levels, hashes: outlineInfo.hashes }));
  await shot('大纲-预览态');

  // 预览态点最后一个大纲项（### 小结，靠近文末）
  await frame.evaluate(() => {
    const items = document.querySelectorAll('#outline-list .outline-item');
    items[items.length - 1].click();
  });
  await sleep(350);
  const jumped = await frame.evaluate(() => {
    const pane = document.getElementById('preview-pane');
    const h = document.querySelector('h3');
    const pr = pane.getBoundingClientRect();
    const hr = h.getBoundingClientRect();
    return { scrollTop: pane.scrollTop, inView: hr.top >= pr.top - 4 && hr.top < pr.bottom };
  });
  check('点大纲「小结」→ 预览滚动到该标题（在视口内）',
    jumped.scrollTop > 0 && jumped.inView, JSON.stringify(jumped));

  // ---------- 7. 三态 + 记忆 + 分割条 ----------
  section('三态切换 / 记住上次选择 / 分割条拖动');
  await frame.evaluate(() => document.querySelector('[data-mode="edit"]').click());
  await sleep(220);
  const editMode = await frame.evaluate(() => ({
    mode: window.__mdState().mode,
    previewHidden: getComputedStyle(document.querySelector('.pane-preview')).display === 'none',
    editorVisible: document.querySelector('.pane-edit').getBoundingClientRect().width > 200,
    label: document.getElementById('st-mode').textContent.trim(),
    pressed: [...document.querySelectorAll('[data-mode]')].filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.dataset.mode),
  }));
  check('切到「编辑」：只剩编辑器，aria-pressed 只有 edit',
    editMode.mode === 'edit' && editMode.previewHidden && editMode.editorVisible
    && editMode.label === '编辑' && JSON.stringify(editMode.pressed) === JSON.stringify(['edit']),
    JSON.stringify(editMode));
  await shot('编辑态');

  await frame.evaluate(() => document.querySelector('[data-mode="split"]').click());
  await sleep(200);
  // 拖动分割条（真的按鼠标）
  const splitBefore = await frame.evaluate(() => ({
    pct: document.documentElement.style.getPropertyValue('--split'),
    editW: Math.round(document.querySelector('.pane-edit').getBoundingClientRect().width),
  }));
  const sp = await rectInFrame(frame, '#splitter');
  const off0 = await frameOffset();
  await page.mouse.move(off0.x + sp.x + sp.w / 2, off0.y + sp.y + sp.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(off0.x + sp.x + sp.w / 2 + i * 14, off0.y + sp.y + sp.h / 2);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(200);
  const splitAfter = await frame.evaluate(() => ({
    pct: document.documentElement.style.getPropertyValue('--split'),
    editW: Math.round(document.querySelector('.pane-edit').getBoundingClientRect().width),
    stored: document.getElementById('app').className,
  }));
  const pctNum = parseFloat(splitAfter.pct);
  check('拖动分割条：--split 变大、编辑区真的变宽',
    pctNum > parseFloat(splitBefore.pct || '0') && splitAfter.editW > splitBefore.editW + 30,
    JSON.stringify({ before: splitBefore, after: splitAfter }));
  check('分割条比例被夹在 20%-80%（不会把某一侧拖没）', pctNum >= 20 && pctNum <= 80, splitAfter.pct);

  // 拖回去，后续截图保持一个好看的 50/50（同时验证双向拖动）
  const sp2 = await rectInFrame(frame, '#splitter');
  const off1 = await frameOffset();
  await page.mouse.move(off1.x + sp2.x + sp2.w / 2, off1.y + sp2.y + sp2.h / 2);
  await page.mouse.down();
  const dragOn = await mdState(frame);
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(off1.x + sp2.x + sp2.w / 2 - i * 14, off1.y + sp2.y + sp2.h / 2);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(200);
  const splitBack = await frame.evaluate(() => ({
    pct: document.documentElement.style.getPropertyValue('--split'),
    editW: Math.round(document.querySelector('.pane-edit').getBoundingClientRect().width),
    previewW: Math.round(document.querySelector('.pane-preview').getBoundingClientRect().width),
  }));
  check('反向拖回去也生效（编辑区变窄、预览变宽，两侧都有宽度）',
    dragOn?.dragging === true && parseFloat(splitBack.pct) < pctNum && splitBack.editW < splitAfter.editW
    && splitBack.previewW > 120, JSON.stringify({ dragOn, splitBack }));
  const pctBack = parseFloat(splitBack.pct);

  // 记住上次选择：切到预览 → 关窗 → 重开同一文件
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(500);
  await closeAllWindows();
  frame = await openFileEntry('note.md');
  const remembered = frame ? await mdState(frame) : null;
  check('关窗重开后记住上次的视图（预览）', remembered?.mode === 'preview', JSON.stringify(remembered));
  await frame.evaluate(() => document.querySelector('[data-mode="split"]').click());
  await sleep(250);
  const restoredSplit = await frame.evaluate(() => document.documentElement.style.getPropertyValue('--split'));
  check('分割条比例也记住了（不是回到 50%）', Math.abs(parseFloat(restoredSplit) - pctBack) < 1.5,
    `now=${restoredSplit} before=${splitBack.pct}`);

  // ---------- 8. 滚动联动 ----------
  section('分栏滚动联动（编辑 → 预览、预览 → 编辑）');
  await frame.evaluate(() => {
    const ta = document.getElementById('editor');
    ta.scrollTop = Math.round(ta.scrollHeight * 0.45);
  });
  await sleep(400);
  const sync1 = await frame.evaluate(() => ({
    editor: Math.round(document.getElementById('editor').scrollTop),
    preview: Math.round(document.getElementById('preview-pane').scrollTop),
  }));
  check('编辑器往下滚 → 预览跟着滚（>0）', sync1.editor > 100 && sync1.preview > 80, JSON.stringify(sync1));
  await frame.evaluate(() => { document.getElementById('preview-pane').scrollTop = 40; });
  await sleep(400);
  const sync2 = await frame.evaluate(() => ({
    editor: Math.round(document.getElementById('editor').scrollTop),
    preview: Math.round(document.getElementById('preview-pane').scrollTop),
  }));
  check('预览往上滚 → 编辑器跟着回到开头附近', sync2.preview < 60 && sync2.editor < 400, JSON.stringify(sync2));

  // ---------- 9. 编辑器：行号 / Tab / 列表续行 / 快捷键 ----------
  section('编辑器：行号 / Tab 缩进 / 列表续行 / 快捷键');
  await frame.evaluate(() => document.querySelector('[data-mode="edit"]').click());
  await sleep(200);
  await frame.evaluate(() => document.getElementById('btn-linenums').click());
  await sleep(200);
  const gutter = await frame.evaluate(() => {
    const lines = document.querySelectorAll('#hl .ln');
    const first = lines[1];
    const cs = first ? getComputedStyle(first, '::before') : null;
    return {
      linenums: document.getElementById('app').classList.contains('linenums'),
      gutterW: getComputedStyle(document.documentElement).getPropertyValue('--gutter-w').trim(),
      lineCount: lines.length,
      numbers: [...lines].slice(0, 3).map((l) => l.dataset.n),
      hasGutter: first ? cs.width : '0px',
      boxSizing: first ? cs.boxSizing : '',
      padRight: first ? cs.paddingRight : '',
    };
  });
  check('行号装订线用 border-box + 右内边距（数字不会贴在正文上）',
    gutter.boxSizing === 'border-box' && parseFloat(gutter.padRight) >= 10, JSON.stringify(gutter));
  check('行号开关：linenums class + 每行带 data-n 序号 + 左侧留出装订线',
    gutter.linenums && gutter.lineCount > 40 && gutter.numbers[0] === '1' && gutter.numbers[2] === '3'
    && parseFloat(gutter.hasGutter) > 20, JSON.stringify(gutter));
  await shot('编辑态-行号');

  // 光标移到文末，开始往里加内容（后面统一验证保存）
  await clickInFrame(frame, '#editor');
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type('\n\n## 快捷键与保存\n\n');

  // 当前行内容的辅助函数（行首 → 光标）
  const currentLine = () => frame.evaluate(() => {
    const ta = document.getElementById('editor');
    const pos = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
    return ta.value.slice(lineStart, pos);
  });
  // 光标所在行整行内容
  const fullLine = () => frame.evaluate(() => {
    const ta = document.getElementById('editor');
    const pos = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = ta.value.indexOf('\n', pos);
    if (lineEnd < 0) lineEnd = ta.value.length;
    return ta.value.slice(lineStart, lineEnd);
  });

  // Tab：打一行 → 回行首 → Tab 插两个空格 → Shift+Tab 反缩进
  await page.keyboard.type('tabbed-line');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  const tabbed = await fullLine();
  check('Tab 在光标处插入两个空格缩进', tabbed === '  tabbed-line', JSON.stringify(tabbed));
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  const untabbed = await fullLine();
  check('Shift+Tab 反缩进（去掉两个空格）', untabbed === 'tabbed-line', JSON.stringify(untabbed));
  await page.keyboard.press('End');

  // 列表续行：新行只打文字，标记应该由回车自动补上
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- 续行项一');
  await page.keyboard.press('Enter');
  await page.keyboard.type('续行项二');
  const listCont = await currentLine();
  check('列表回车自动续行（新行自动以 "- " 开头）', /^- 续行项二$/.test(listCont), JSON.stringify(listCont));

  // 空条目再回车：退出列表（标记被去掉）
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const exited = await currentLine();
  check('空列表项再回车就退出列表（行首不再有标记）', exited.trim() === '', JSON.stringify(exited));

  // 任务项续行
  await page.keyboard.type('- [ ] 任务一');
  await page.keyboard.press('Enter');
  await page.keyboard.type('任务二');
  const taskCont = await currentLine();
  check('任务项回车续行带上 "- [ ] "', /^- \[ \] 任务二$/.test(taskCont), JSON.stringify(taskCont));

  // 快捷键：每个都新起一行，避免上一次的包裹影响下一次
  const newLine = async () => {
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  };
  await newLine();
  await page.keyboard.down('Control'); await page.keyboard.press('b'); await page.keyboard.up('Control');
  const boldPlaceholder = await frame.evaluate(() => {
    const ta = document.getElementById('editor');
    return {
      sel: ta.value.slice(ta.selectionStart, ta.selectionEnd),
      before: ta.value.slice(ta.selectionStart - 2, ta.selectionStart),
      after: ta.value.slice(ta.selectionEnd, ta.selectionEnd + 2),
    };
  });
  check('Ctrl+B 插入 **粗体** 并把占位文字选中（可直接打字替换）',
    boldPlaceholder.sel === '粗体' && boldPlaceholder.before === '**' && boldPlaceholder.after === '**',
    JSON.stringify(boldPlaceholder));
  await page.keyboard.type('加粗文本');

  await newLine();
  await page.keyboard.down('Control'); await page.keyboard.press('i'); await page.keyboard.up('Control');
  await page.keyboard.type('斜体文本');

  await newLine();
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  const linkPlaceholder = await frame.evaluate(() => {
    const ta = document.getElementById('editor');
    const pos = ta.selectionStart;
    return { sel: ta.value.slice(pos, ta.selectionEnd), tail: ta.value.slice(ta.selectionEnd, ta.selectionEnd + 10) };
  });
  check('Ctrl+K 插入 [链接文字](https://) 并选中链接文字',
    linkPlaceholder.sel === '链接文字' && linkPlaceholder.tail.startsWith('](https://'),
    JSON.stringify(linkPlaceholder));
  await page.keyboard.type('链接文字');

  await newLine();
  await page.keyboard.down('Control'); await page.keyboard.press('Backquote'); await page.keyboard.up('Control');
  await page.keyboard.type('const x = 1;');

  const shortcuts = await frame.evaluate(() => {
    const lines = document.getElementById('editor').value.split('\n').map((l) => l.trim());
    return {
      bold: lines.includes('**加粗文本**'),
      em: lines.includes('*斜体文本*'),
      link: lines.includes('[链接文字](https://)'),
      fence: lines.includes('```') && lines.includes('const x = 1;'),
      lines: lines.slice(-12),
    };
  });
  check('Ctrl+B 的占位文字被真实输入替换（独立一行 **加粗文本**）', shortcuts.bold, JSON.stringify(shortcuts.lines));
  check('Ctrl+I 斜体 / Ctrl+K 链接 / Ctrl+` 代码块都插对了',
    shortcuts.em && shortcuts.link && shortcuts.fence, JSON.stringify(shortcuts.lines));

  // ---------- 10. 脏标记 + 保存 ----------
  section('脏标记 → Ctrl+S 保存 → 磁盘真实变更');
  // 脏标记是宿主 React 渲染的，要轮询等一拍（不能死等固定时长）
  const waitPluginTitle = (pred, ms = 6000) => page.waitForFunction((src) => {
    const re = new RegExp(src);
    return [...document.querySelectorAll('.window')]
      .filter((w) => w.querySelector('iframe.plugin-frame'))
      .some((w) => re.test((w.querySelector('.window-title')?.innerText || '').trim()));
  }, { timeout: ms, polling: 100 }, pred).then(() => true).catch(() => false);
  const dirtyTitleOk = await waitPluginTitle('^\\*');
  const dirtyState = await page.evaluate(() => {
    const wins = [...document.querySelectorAll('.window')].filter((w) => w.querySelector('iframe.plugin-frame'));
    return wins.map((w) => (w.querySelector('.window-title')?.innerText || '').trim());
  });
  const dirtyStatus = await frame.evaluate(() => ({
    state: document.getElementById('st-save').dataset.state,
    text: document.getElementById('st-save').textContent.trim(),
    saveEnabled: !document.getElementById('btn-save').disabled,
  }));
  check('编辑后窗口标题带 *（宿主标脏）',
    dirtyTitleOk && dirtyState.length === 1 && /^\*/.test(dirtyState[0]), JSON.stringify(dirtyState));
  check('状态栏显示「未保存」、保存按钮可用', dirtyStatus.state === 'dirty' && dirtyStatus.text === '未保存' && dirtyStatus.saveEnabled,
    JSON.stringify(dirtyStatus));
  await shot('脏状态');

  const beforeSave = readFileRoot('note.md');
  check('保存前磁盘还是旧内容（脏标记不是假的）', beforeSave === NOTE_MD && !/快捷键与保存/.test(beforeSave));

  await key('KeyS');
  const saved = await frame.waitForFunction(() => document.getElementById('st-save').textContent.trim() === '已保存',
    { timeout: 8000, polling: 100 }).then(() => true).catch(() => false);
  const titleAfterSave = await page.evaluate(() => {
    const wins = [...document.querySelectorAll('.window')].filter((w) => w.querySelector('iframe.plugin-frame'));
    return (wins[wins.length - 1]?.querySelector('.window-title')?.innerText || '').trim();
  });
  const saveTitleOk = await waitPluginTitle('^note\\.md$');
  const afterSave = readFileRoot('note.md');
  check('Ctrl+S 后状态栏回到「已保存」', saved);
  check('保存后标题的 * 消失', saveTitleOk && titleAfterSave === 'note.md', titleAfterSave);
  check('磁盘文件真的被改写：含新加的「## 快捷键与保存」与代码块',
    /## 快捷键与保存/.test(afterSave || '') && /```\nconst x = 1;\n```/.test(afterSave || ''),
    (afterSave || '').slice(-300));
  check('保存的内容包含快捷键插入的语法（加粗 / 链接 / 任务项）',
    /\*\*加粗文本\*\*/.test(afterSave) && /\[链接文字\]\(https:\/\/\)/.test(afterSave) && /- \[ \] 任务二/.test(afterSave),
    '');
  check('保存后磁盘字节数变多（不是把文件写空）', (afterSave || '').length > (beforeSave || '').length + 100,
    `${(beforeSave || '').length} → ${(afterSave || '').length}`);
  await shot('保存后');
  await closeAllWindows();

  // ---------- 11. 消毒 ----------
  section('消毒（原始 HTML / javascript: / data: URL）');
  frame = await openFileEntry('xss.md');
  check('xss.md 用插件打开', !!frame);
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(350);
  const xss = await previewInfo(frame);
  const pwned = await frame.evaluate(() => window.__pwned);
  check('注入的 <script> / <img onerror> / <svg onload> 一个都没执行（window.__pwned undefined）',
    typeof pwned === 'undefined', String(pwned));
  check('预览里没有 script 元素、没有带 onerror 的 img', xss.scripts === 0 && xss.imgs.length === 0
    && !/onerror/i.test(xss.html.replace(/onerror=|&lt;img src=x/g, '')), JSON.stringify({ scripts: xss.scripts, imgs: xss.imgs }));
  check('javascript: / data:text/html 链接没有生成 href', xss.links.length === 0 && xss.deadLinks.length === 2
    && !/javascript:/i.test(xss.html), JSON.stringify(xss.deadLinks));
  check('预览 HTML 里不含 data:text/html', !/data:text\/html/i.test(xss.html));
  check('data: 图片被拦成占位框（不是内联图）', xss.missingImgs.length === 1
    && /内联图|本地图片暂不支持/.test(xss.missingImgs[0]), JSON.stringify(xss.missingImgs));
  check('原始 HTML 按文本显示（<img / <script 只出现在文本里）',
    /<img src=x onerror/.test(xss.text) && /<script>window.__pwned=2<\/script>/.test(xss.text),
    (xss.text || '').slice(0, 120));
  check('正常的 **粗体** 在消毒后仍然是对的（不是一刀切全丢）', xss.strong.includes('正常粗体'), JSON.stringify(xss.strong));
  await shot('消毒-预览');

  // 编辑态对照：源码里恶意内容仍在（只是不执行）
  await frame.evaluate(() => document.querySelector('[data-mode="edit"]').click());
  await sleep(220);
  const srcStillThere = await frame.evaluate(() => document.getElementById('editor').value);
  check('源码里的恶意片段没有被静默删掉（编辑态仍可见，只是不会执行）',
    /<img src=x onerror=/.test(srcStillThere) && /javascript:/.test(srcStillThere));
  await closeAllWindows();

  // ---------- 12. 本地相对图片实测 ----------
  section('本地相对路径图片的真实行为（宿主限制）');
  frame = await openFileEntry('note.md');
  const imgProbe = await frame.evaluate(() => new Promise((resolve) => {
    const src = './local-image.png';
    const img = new Image();
    const done = (r) => resolve({ src, absolute: new URL(src, document.baseURI).href, ...r });
    img.onload = () => done({ loaded: true, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done({ loaded: false, error: 'error' });
    setTimeout(() => done({ loaded: false, error: 'timeout' }), 4000);
    img.src = src;
  }));
  check('相对路径图片在沙箱 iframe 里加载不出来（实测结论，写进汇报）', imgProbe.loaded === false, JSON.stringify(imgProbe));
  check('相对路径被解析成插件包内的假路径（/pa/<token>/md/…）',
    /\/pa\/[0-9a-f]{32}\/md\/local-image\.png$/.test(imgProbe.absolute), imgProbe.absolute);
  const imgConsole = consoleErrors.filter((m) => /Failed to load resource|404/i.test(m));
  console.log(`${DIM}    相对图片的控制台报错：${imgConsole.slice(-2).join(' | ') || '（无）'}${RESET}`);
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(300);
  check('插件自己的预览没有发这个请求（用的是占位框，不会刷 404）',
    (await previewInfo(frame)).missingImgs.length >= 1);
  await closeAllWindows();

  // ---------- 13. 大文件只读 ----------
  section('大文件（>1MB）只读预览');
  frame = await openFileEntry('big.md');
  const bigState = await frame.waitForFunction(() => window.__mdState && window.__mdState().readOnly, { timeout: 20000 })
    .then(() => true).catch(() => false);
  const big = bigState ? await frame.evaluate(() => ({
    st: window.__mdState(),
    banner: !document.getElementById('banner').hidden,
    bannerText: document.getElementById('banner-text').textContent.trim(),
    readOnly: document.getElementById('editor').readOnly,
    modeLabel: document.getElementById('st-mode').textContent.trim(),
    editDisabled: document.querySelector('[data-mode="edit"]').disabled,
    splitDisabled: document.querySelector('[data-mode="split"]').disabled,
    saveDisabled: document.getElementById('btn-save').disabled,
    saveText: document.getElementById('st-save').textContent.trim(),
    previewLen: document.getElementById('preview').textContent.length,
  })) : null;
  check('大文件进入只读预览（readOnly + 提示条）', big?.st.readOnly === true && big?.banner === true, JSON.stringify(big?.st));
  check('提示条说明「只返回前 512KB / 禁止保存」，不惊悚', /512 KB/.test(big?.bannerText || '')
    && /只能预览/.test(big?.bannerText || ''), big?.bannerText);
  check('只读时强制预览态、编辑/分栏按钮禁用、保存按钮禁用',
    big?.modeLabel === '预览' && big?.editDisabled && big?.splitDisabled && big?.saveDisabled, JSON.stringify(big));
  check('大文件仍然渲染出预览内容（不是空白）', (big?.previewLen || 0) > 1000, String(big?.previewLen));
  await shot('大文件-只读');
  await closeAllWindows();

  // ---------- 14. 主题 ----------
  section('跟随宿主亮 / 暗主题');
  frame = await openFileEntry('note.md');
  await frame.evaluate(() => document.querySelector('[data-mode="split"]').click());
  await sleep(320);
  const hostToken = (name) => page.evaluate((n) => {
    const d = document.createElement('div');
    d.style.color = `var(${n})`;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, name);
  const pluginTheme = () => frame.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      accent: (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim(),
      scheme: document.documentElement.style.colorScheme,
      codeBg: getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim(),
    };
  });
  const setHostTheme = async (label) => {
    if (!await page.$('.account-popover')) {
      await page.evaluate(() => document.querySelector('.tray-account')?.click());
      await page.waitForSelector('.account-popover', { timeout: 5000 }).catch(() => {});
    }
    const res = await page.evaluate((t) => {
      const btn = [...document.querySelectorAll('.account-popover .dropdown-item')]
        .find((b) => (b.textContent || '').includes(t));
      if (!btn) return { clicked: false, theme: document.documentElement.dataset.theme };
      btn.click();
      return { clicked: true, theme: document.documentElement.dataset.theme };
    }, label);
    await page.evaluate(() => {
      const f = document.querySelector('.window .plugin-frame');
      if (f) f.blur();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });
    await page.keyboard.press('Escape');
    await sleep(400);
    return res;
  };

  await setHostTheme('浅色主题');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 8000 }).catch(() => {});
  const lightBg = await hostToken('--bg');
  let light = await pluginTheme();
  for (let i = 0; i < 30 && light.bg !== lightBg; i++) { await sleep(150); light = await pluginTheme(); }
  check('亮色：插件背景 = 宿主 --bg、正文色 = --text',
    light.bg === lightBg && light.color === await hostToken('--text'), `宿主=${lightBg} 插件=${light.bg} ${light.color}`);
  check('亮色：原生控件配色 = light', light.scheme === 'light', light.scheme);
  await shot('亮色-分栏');

  await setHostTheme('深色主题');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 8000 }).catch(() => {});
  const darkBg = await hostToken('--bg');
  let dark = await pluginTheme();
  for (let i = 0; i < 40 && dark.bg !== darkBg; i++) { await sleep(150); dark = await pluginTheme(); }
  check('暗色：插件背景跟着变成宿主 --bg（实时切换，不用重开窗口）',
    dark.bg === darkBg && dark.bg !== light.bg, `${light.bg} → ${dark.bg}`);
  check('暗色：强调色 / 派生代码底色都跟着换（不是写死的颜色）',
    dark.accent === await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    && dark.codeBg !== light.codeBg, JSON.stringify({ light: light.codeBg, dark: dark.codeBg }));
  check('暗色：原生控件配色 = dark', dark.scheme === 'dark', dark.scheme);
  await shot('暗色-分栏');
  await frame.evaluate(() => document.querySelector('[data-mode="preview"]').click());
  await sleep(300);
  await shot('暗色-预览');
  await setHostTheme('浅色主题');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 8000 }).catch(() => {});
  await closeAllWindows();

  // ---------- 15. 窄窗口 560px ----------
  section('窄窗口 560px（不横向溢出）');
  await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('cloudnine-win-geom') || '{}');
    all['plugin:md'] = { x: 16, y: 60, w: 560, h: 560 };
    localStorage.setItem('cloudnine-win-geom', JSON.stringify(all));
  });
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icon[data-entry="note.md"]', { timeout: 20000 });
  frame = await openFileEntry('note.md');
  await sleep(300);
  const narrow = await frame.evaluate(() => {
    const doc = document.documentElement;
    return {
      winW: Math.round(document.querySelector('.window')?.getBoundingClientRect().width || 0),
      docOverflow: doc.scrollWidth - doc.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      toolbar: [...document.querySelectorAll('.toolbar .seg button, .toolbar .btn')].every((b) => b.offsetWidth > 0),
      statusVisible: document.querySelector('.statusbar').offsetWidth > 0,
      outlineShown: getComputedStyle(document.getElementById('outline')).display !== 'none',
      editorVisible: document.querySelector('.pane-edit').getBoundingClientRect().width > 40,
    };
  });
  const winW = await page.evaluate(() => Math.round(document.querySelector('.window')?.getBoundingClientRect().width || 0));
  check('宿主窗口收敛到 560px（manifest minWidth）', Math.abs(winW - 560) <= 1, String(winW));
  check('窄窗口没有横向溢出（doc / body scrollWidth 不超过可视宽）',
    narrow.docOverflow <= 0 && narrow.bodyOverflow <= 0, JSON.stringify(narrow));
  check('窄窗口工具条 / 状态栏都还在，按钮没被挤掉', narrow.toolbar && narrow.statusVisible, JSON.stringify(narrow));
  check('窄窗口里大纲默认收成抽屉（不挡正文）', narrow.outlineShown === false, JSON.stringify(narrow));
  await shot('窄窗-560');
  // 抽屉里点一下大纲能跳，且点完自动收起
  await frame.evaluate(() => document.getElementById('btn-outline').click());
  await sleep(200);
  const drawerOpen = await frame.evaluate(() => getComputedStyle(document.getElementById('outline')).display !== 'none');
  await frame.evaluate(() => document.querySelector('#outline-list .outline-item').click());
  await sleep(250);
  const drawerClosed = await frame.evaluate(() => getComputedStyle(document.getElementById('outline')).display === 'none');
  check('窄窗口点「大纲」浮出抽屉，点条目后自动收起', drawerOpen && drawerClosed, `${drawerOpen} ${drawerClosed}`);
  await closeAllWindows();

  // ---------- 16. 控制台 ----------
  section('控制台');
  const ignorable = badResponses.filter((u) => /favicon\.ico|local-image\.png/.test(u));
  const realBad = badResponses.filter((u) => !/favicon\.ico|local-image\.png/.test(u));
  const realErrors = consoleErrors.filter((m) => !/Failed to load resource|local-image\.png/.test(m));
  if (ignorable.length) console.log(`${DIM}    预期内 404：${ignorable.join(', ')}${RESET}`);
  check('浏览器控制台无 JS 错误、无意外 4xx/5xx（不含实测的本地图片 404）',
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
