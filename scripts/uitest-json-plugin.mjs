#!/usr/bin/env node
/**
 * CloudNine 插件 · 「JSON 工具」（examples/plugins/json）端到端验收
 *
 * 覆盖：
 *   1. 桌面虚拟图标 → 欢迎态（新建空白文档）
 *   2. 文件关联：双击 .json 直接进插件，内容 / 标题 / 行号正确（插件自己 fs.readText）
 *   3. 文本视图：语法高亮、自动配对、Tab 缩进、行列定位、Ctrl+F 搜索并高亮命中
 *   4. 树视图：默认展开 2 层、类型着色、子项条数、折叠、点节点复制 JSONPath、大数组分页
 *   5. 格式化 / 选区格式化 / 压缩 / 键名排序，脏标记，保存后磁盘文件真实变更
 *   6. 非法 JSON：行列 + 期望 token、错误高亮、禁止保存、Ctrl+S 明确报「语法错误未保存」
 *   7. 边界：.jsonc 注释、空文件、>2MB 只读 +「仍然编辑」、非 UTF-8
 *   8. 脏状态关窗确认（取消不关 / 关闭才关）
 *   9. 亮 / 暗主题跟随、窄窗口（560px）不错位、控制台无 JS 错误
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全在系统临时目录，端口 8733，跑完清理。
 *
 * 依赖：puppeteer-core（不含 Chromium，复用系统 Chrome）
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-json-plugin.mjs
 *   node scripts/uitest-json-plugin.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-json-plugin.mjs --url http://127.0.0.1:8499/ --user u --password p
 *   node scripts/uitest-json-plugin.mjs --keep
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- puppeteer-core ----------
function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    resolve(ROOT, '..', '.uitest', 'node_modules', 'puppeteer-core'),
    resolve(ROOT, 'node_modules', 'puppeteer-core'),
    'puppeteer-core',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* 继续试下一个 */ }
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

const PORT = Number(arg('port', 8733));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/json'));

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
const section = (t) => console.log(`\n${BOLD}${CYAN}▸ ${t}${RESET}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 1. 干净环境 =================
let child = null;
let tmpRoot = null;
let serverEnv = null;
let dataDir = null;
let filesRoot = null;

const SAMPLE = {
  name: 'cloudnine',
  version: 2,
  server: { port: 8480, host: '127.0.0.1', tls: { enabled: false } },
  tags: ['alpha', 'beta', 'gamma'],
  users: [{ id: 1, name: '张三' }, { id: 2, name: '李四' }],
  note: null,
};
// 格式化用的文档：故意与磁盘上的 sample.json 不同（否则「整篇替换」不会产生脏状态）
const EDIT_DOC = {
  name: 'cloudnine',
  version: 2,
  server: { port: 8480, host: '127.0.0.1', tls: { enabled: false } },
  tags: ['alpha', 'beta', 'gamma'],
  users: [{ id: 1, name: '张三' }],
  note: null,
  added: true,
};
const TREE_DOC = {
  server: { port: 8480, host: '127.0.0.1', tls: { enabled: false } },
  tags: ['a', 'b', 'c'],
  users: [{ id: 1, name: '张三' }],
  note: null,
};

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

async function prepareEnv() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-json-uitest-'));
  dataDir = join(tmpRoot, 'data');
  filesRoot = join(tmpRoot, 'files');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  mkdirSync(join(filesRoot, 'data'), { recursive: true });

  // ---- 测试文档 ----
  // 1) 正常文档（紧凑单行，方便验证「格式化前」）
  writeFileSync(join(filesRoot, 'sample.json'), JSON.stringify(SAMPLE));
  // 2) 树视图用（有嵌套 / 数组 / null / 中文）
  writeFileSync(join(filesRoot, 'tree.json'), JSON.stringify(TREE_DOC, null, 2) + '\n');
  // 3) 非法 JSON：第 4 行少了逗号
  writeFileSync(join(filesRoot, 'broken.json'), '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}\n');
  // 4) JSONC：注释 + 尾逗号
  writeFileSync(join(filesRoot, 'notes.jsonc'),
    '{\n  // 这是一条注释\n  "name": "cloudnine",\n  "list": [1, 2, 3,],\n  /* 块注释 */\n  "ok": true\n}\n');
  // 5) 空文件
  writeFileSync(join(filesRoot, 'empty.json'), '');
  // 6) 非 UTF-8（GBK 编码的「你」）
  writeFileSync(join(filesRoot, 'gbk.json'),
    Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xC4, 0xE3]), Buffer.from('"}')]));
  // 7) 大数组（1200 项，小体积，用来验树视图分页）
  const nums = [];
  for (let i = 0; i < 1200; i++) nums.push(i % 977);
  writeFileSync(join(filesRoot, 'bigarray.json'), JSON.stringify({ big: nums }));
  // 8) 3.4MB（以前被 2MB 门槛挡住 → 现在整份可编辑、可保存，顺带验 >1MB 写入）
  const bigNums = [];
  for (let i = 0; i < 520000; i++) bigNums.push((i * 7919) % 1000000);
  writeFileSync(join(filesRoot, 'huge.json'), '{"big":[' + bigNums.join(',') + ']}');
  // 9) 1.2MB：超过旧的 512KB 读取上限，但远低于 8MB 工具上限 → 应正常可编辑
  const medNums = [];
  for (let i = 0; i < 200000; i++) medNums.push((i * 7919) % 1000000);
  writeFileSync(join(filesRoot, 'medium.json'),
    '{\n  "meta": { "name": "medium", "count": 200000 },\n  "nums": [' + medNums.join(',') + ']\n}\n');
  // 10) > 8MB：超过工具上限 → 只读 + 真实尺寸提示
  const overNums = [];
  for (let i = 0; i < 1400000; i++) overNums.push((i * 7919) % 1000000);
  writeFileSync(join(filesRoot, 'oversize.json'), '{"big":[' + overNums.join(',') + ']}');
  // 11) 子目录里的文档（验证 rel 带目录）
  writeFileSync(join(filesRoot, 'data', 'conf.json'), '{"from":"subdir"}\n');

  const src = join(ROOT, 'examples', 'plugins', 'json');
  if (!existsSync(join(src, 'plugin.json'))) {
    console.error(`找不到示例插件：${src}`);
    process.exit(2);
  }
  cpSync(src, join(dataDir, 'plugins', 'json'), { recursive: true });

  serverEnv = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PLUGINS_DIR: join(dataDir, 'plugins'),
    PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
    FILE_ROOT: filesRoot,
    SITE_NAME: 'CloudNine JSON 工具自测',
  };
  await startServer();
  console.log(`${DIM}临时数据目录：${tmpRoot}${RESET}`);
}

async function cleanup() {
  if (child && !child.killed) {
    child.kill();
    await sleep(300);
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  if (tmpRoot && !KEEP) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 偶发占用：留着不影响 */ }
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

// ================= 2. 浏览器 =================
let browser = null;
let page = null;

const diskPath = (rel) => join(filesRoot, rel);
const readDisk = (rel) => readFileSync(diskPath(rel), 'utf8');

async function main() {
  if (OWN_SERVER) await prepareEnv();
  const sid = await ensureAccount(URL_BASE);

  mkdirSync(OUT_DIR, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  // 插件点节点复制 JSONPath 走宿主 navigator.clipboard：先把权限打开，才能回读校验
  const ORIGIN = new URL(URL_BASE).origin;
  try {
    await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write']);
  } catch (e) {
    console.log(`${DIM}（overridePermissions 失败：${e.message}）${RESET}`);
  }
  // headless 下 writeText 还要浏览器级授权（clipboard-sanitized-write）
  try {
    const bs = await browser.target().createCDPSession();
    await bs.send('Browser.grantPermissions', {
      origin: ORIGIN,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (e) {
    console.log(`${DIM}（Browser.grantPermissions 失败：${e.message}）${RESET}`);
  }
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.setCookie({
    name: 'cloudnine_sid', value: sid, domain: new URL(URL_BASE).hostname, path: '/', httpOnly: true,
  });

  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`); });

  let shotIdx = 0;
  const shot = async (label) => {
    const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
    currentShot = name;
    console.log(`${DIM}    📸 ${name}${RESET}`);
    return name;
  };

  // ---------- 通用交互 ----------
  const centerOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);

  // CDP 里要拿到真正的 dblclick：两次 press 的 clickCount 必须分别是 1 / 2
  const dblclickAt = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };

  const dblclickEntry = async (name) => {
    const box = await centerOf(`.desktop-icon[data-entry="${name}"]`);
    if (!box) throw new Error(`桌面上找不到文件图标：${name}`);
    await dblclickAt(box.x, box.y);
    await sleep(400);
  };

  const pluginFrames = () => page.frames().filter((f) => f.url().includes('/pa/') && f.url().includes('/json/'));

  const frameState = (f) => f.evaluate(() => (window.__json ? window.__json.state() : null)).catch(() => null);

  // 按文档名找当前窗口的 iframe（关闭旧窗口后残留的 frame 会被 evaluate 失败过滤掉）
  const frameOf = async (name, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      for (const f of pluginFrames()) {
        const st = await frameState(f);
        if (st && st.ready && st.name === name) return f;
      }
      await sleep(150);
    }
    return null;
  };

  const state = async (f) => (await frameState(f)) || {};
  const waitState = async (f, fn, ms = 8000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      last = await frameState(f);
      if (last && fn(last)) return last;
      await sleep(100);
    }
    return last;
  };

  const closeAllWindows = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(250);
  };

  // iframe 在页面里的偏移（frame 内坐标 → 页面坐标）
  const frameOffset = async (frame) => {
    const src = frame.url();
    return page.evaluate((s) => {
      const list = [...document.querySelectorAll('iframe.plugin-frame')];
      const f = list.find((x) => x.getAttribute('src') === s) || list[list.length - 1];
      if (!f) return null;
      const b = f.getBoundingClientRect();
      return { x: b.x, y: b.y };
    }, src);
  };

  const rectInFrame = (frame, sel) => frame.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);

  const clickInFrame = async (frame, sel, opts = {}) => {
    const r = await rectInFrame(frame, sel);
    if (!r) throw new Error(`插件里找不到元素：${sel}`);
    const off = await frameOffset(frame);
    if (!off) throw new Error('找不到 iframe 在页面里的位置');
    const x = off.x + r.x + (opts.dx != null ? opts.dx : Math.min(r.w / 2, 40));
    const y = off.y + r.y + r.h / 2;
    await page.mouse.click(x, y, opts);
    await sleep(120);
    return { x, y };
  };

  const clickInFrameDbl = async (frame, sel) => {
    const r = await rectInFrame(frame, sel);
    const off = await frameOffset(frame);
    await dblclickAt(off.x + r.x + Math.min(r.w / 2, 40), off.y + r.y + r.h / 2);
    await sleep(120);
  };

  // 点编辑器（真实点击 = 给沙箱 iframe 用户激活，之后 focus / 键盘才不会被 Chrome 拒）
  const focusEditor = async (frame) => {
    await clickInFrame(frame, '#code-input');
    return frame.evaluate(() => document.activeElement && document.activeElement.id);
  };

  const selectAll = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await sleep(60);
  };

  let cdp = null;
  try { cdp = await page.createCDPSession(); } catch { cdp = null; }
  // 这个版本的 puppeteer-core 没有 keyboard.insertText：直接走 CDP Input.insertText
  // （相当于粘贴 / 输入法提交，不会触发 keydown 的自动配对逻辑）
  const insertText = async (text) => {
    if (cdp) {
      try { await cdp.send('Input.insertText', { text }); return; } catch { /* 走兜底 */ }
    }
    for (const ch of text) await page.keyboard.sendCharacter(ch);
  };

  const replaceAllText = async (frame, text) => {
    await focusEditor(frame);
    await selectAll();
    await page.keyboard.press('Backspace');
    await sleep(60);
    if (text) await insertText(text);
    await sleep(250);
  };

  const docText = (f) => f.$eval('#code-input', (el) => el.value);
  const waitTitleStar = async (want, ms = 5000) => {
    const t0 = Date.now();
    let t = '';
    while (Date.now() - t0 < ms) {
      t = await winTitle();
      if ((/^\*/.test(t)) === want) return t;
      await sleep(100);
    }
    return t;
  };

  const winTitle = () => page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].pop();
    return w ? (w.querySelector('.window-title')?.innerText || '').trim() : '';
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

  const hostToken = (name) => page.evaluate((n) => {
    const d = document.createElement('div');
    d.style.color = `var(${n})`;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, name);

  const dialogVisible = () => page.evaluate(() => {
    const d = document.querySelector('.dialog-overlay .dialog');
    return d ? { title: (d.querySelector('h3')?.textContent || '').trim(), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null;
  });

  console.log(`${BOLD}CloudNine JSON 工具插件自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);

  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });

  // ============================================================ 1. 图标 + 欢迎态
  section('桌面虚拟图标 / 欢迎态');
  const iconOk = await page.waitForSelector('.desktop-appicon[data-app="plugin:json"]', { timeout: 15000 })
    .then(() => true).catch(() => false);
  check('桌面出现「JSON 工具」虚拟图标', iconOk);
  const iconMeta = await page.evaluate(() => {
    const el = document.querySelector('.desktop-appicon[data-app="plugin:json"]');
    return {
      label: el?.querySelector('.di-label')?.textContent.trim() || '',
      img: el?.querySelector('img')?.getAttribute('src') || '',
      title: el?.getAttribute('title') || '',
    };
  });
  check('图标标签 / 提示都是「JSON 工具」', iconMeta.label === 'JSON 工具' && iconMeta.title === 'JSON 工具', JSON.stringify(iconMeta));
  check('图标来自 /pa 的 iconUrl（json/icon.svg）',
    /^\/pa\/[0-9a-f]{32}\/json\/icon\.svg$/.test(iconMeta.img), iconMeta.img);

  const appBox = await centerOf('.desktop-appicon[data-app="plugin:json"]');
  await dblclickAt(appBox.x, appBox.y);
  await page.waitForSelector('.window .plugin-frame', { timeout: 15000 });
  let frame = await frameOf('', 15000);
  check('从图标启动打开插件窗口（file === null 的入口）', !!frame);
  const attrs = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.window iframe.plugin-frame')].pop();
    if (!f) return null;
    const w = f.closest('.window');
    const r = w.getBoundingClientRect();
    return {
      sandbox: f.getAttribute('sandbox'),
      src: f.getAttribute('src'),
      title: w.querySelector('.window-title')?.innerText.trim() || '',
      w: Math.round(r.width), h: Math.round(r.height),
    };
  });
  check('iframe sandbox 恰为 "allow-scripts allow-forms"（没有 allow-same-origin）',
    attrs?.sandbox === 'allow-scripts allow-forms', attrs?.sandbox);
  check('iframe src 是服务端拼好的 entryUrl（/pa/<token>/json/index.html）',
    /^\/pa\/[0-9a-f]{32}\/json\/index\.html$/.test(attrs?.src || ''), attrs?.src);
  check('窗口初始尺寸取 manifest 的 980×660',
    Math.abs((attrs?.w || 0) - 980) <= 1 && Math.abs((attrs?.h || 0) - 660) <= 1, `${attrs?.w}×${attrs?.h}`);
  const welcome = await frame.evaluate(() => ({
    visible: !document.getElementById('pane-welcome').hidden,
    text: document.getElementById('pane-welcome').innerText,
    newBtn: !!document.getElementById('btn-new'),
    editorHidden: document.getElementById('pane-text').hidden,
  }));
  check('file === null 时是欢迎态（不是空白编辑器）',
    welcome.visible && welcome.editorHidden, JSON.stringify({ v: welcome.visible, e: welcome.editorHidden }));
  check('欢迎态说明能干什么（文本视图 / 树视图 / 校验 / 格式化）',
    /文本视图/.test(welcome.text) && /树视图/.test(welcome.text) && /校验/.test(welcome.text) && /格式化/.test(welcome.text),
    welcome.text.slice(0, 60));
  check('欢迎态提供「新建空白文档」', welcome.newBtn && /新建空白文档/.test(welcome.text));
  await shot('欢迎态');

  // 新建空白文档
  await clickInFrame(frame, '#btn-new');
  let st = await waitState(frame, (x) => x.view === 'text' && x.hasDoc);
  check('新建空白文档进入文本视图（未命名.json、有起始花括号）',
    st.view === 'text' && st.name === '未命名.json' && st.valid, JSON.stringify({ view: st.view, name: st.name, valid: st.valid }));
  const tpl = await docText(frame);
  check('新文档内容是最小可用的 {} 骨架且未标脏',
    tpl === '{\n  \n}\n' && st.dirty === false, JSON.stringify(tpl) + ' dirty=' + st.dirty);
  const gutterCount = await frame.evaluate(() => document.querySelectorAll('.gutter .ln').length);
  check('行号已渲染（骨架 4 行，含末尾空行）', gutterCount === 4, String(gutterCount));
  const pos0 = await frame.$eval('#sb-pos', (el) => el.textContent);
  check('光标定位在骨架内部（行 2，列 3）', /行 2，列 3/.test(pos0), pos0);
  await closeAllWindows();

  // ============================================================ 2. 文件关联
  section('文件关联：双击 .json 打开');
  await dblclickEntry('sample.json');
  frame = await frameOf('sample.json', 20000);
  check('双击 sample.json 直接由 JSON 插件打开（defaultFor 生效）', !!frame);
  st = await state(frame);
  check('cn:init 的 file.rel 与实际路径一致', st.rel === 'sample.json', String(st.rel));
  check('插件自己 fs.readText 读到了完整内容',
    (await docText(frame)) === readDisk('sample.json'), (await docText(frame)).slice(0, 60));
  check('窗口标题 = 文件名', (await winTitle()) === 'sample.json', await winTitle());
  check('状态栏校验通过（✓ 合法 JSON）', /合法 JSON/.test(await frame.$eval('#sb-valid', (el) => el.textContent)));
  check('行号数量与内容行数一致', await frame.evaluate(() => document.querySelectorAll('.gutter .ln').length) === (await docText(frame)).split('\n').length);
  const hl = await frame.evaluate(() => document.getElementById('code-hl').innerHTML);
  check('语法高亮生效（键名 / 字符串 / 数字 / 字面量各自着色）',
    /class="t-key"/.test(hl) && /class="t-str"/.test(hl) && /class="t-num"/.test(hl) && /class="t-punc"/.test(hl),
    JSON.stringify({ len: hl.length, num: hl.includes('t-num'), bool: hl.includes('t-bool'), head: hl.slice(0, 160), mid: hl.slice(160, 420) }));
  await shot('文本视图-合法JSON');

  // ============================================================ 3. 编辑基础
  section('编辑基础：自动配对 / Tab 缩进 / 行列定位');
  await replaceAllText(frame, '');
  check('清空后编辑器为空', (await docText(frame)) === '');
  await page.keyboard.type('{');
  check('输入 { 自动补上 }', (await docText(frame)) === '{}', await docText(frame));
  await page.keyboard.type('"');
  const pairQuote = await docText(frame);
  check('在 {} 里输入 " 自动补一对引号', pairQuote === '{"\"}' , JSON.stringify(pairQuote));
  await page.keyboard.type('a');
  await page.keyboard.type('"');
  check('再输入 " 跳过已有引号（不会补出第二对）', (await docText(frame)) === '{"a"}', await docText(frame));
  // 从干净状态再验中括号 + Tab 缩进
  await replaceAllText(frame, '');
  await page.keyboard.type('[');
  check('输入 [ 自动补上 ]', (await docText(frame)) === '[]', await docText(frame));
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  const txt = await docText(frame);
  check('Tab 在光标处插入 2 个空格缩进', txt === '[1  ]', JSON.stringify(txt));
  const caretPos = await frame.$eval('#sb-pos', (el) => el.textContent);
  check('状态栏实时显示当前行列', /行 1，列 5/.test(caretPos), caretPos);
  // 回车自动缩进
  await replaceAllText(frame, '');
  await page.keyboard.type('{');
  await page.keyboard.press('Enter');
  await page.keyboard.type('"a": 1');
  await page.keyboard.press('Enter');
  const enterTxt = await docText(frame);
  check('回车自动缩进（花括号后换行带缩进）', enterTxt.startsWith('{\n  "a": 1\n'), JSON.stringify(enterTxt));

  // ============================================================ 4. 格式化 / 压缩 / 保存
  section('格式化 / 选区格式化 / 压缩 / 保存');
  await replaceAllText(frame, JSON.stringify(EDIT_DOC));
  st = await waitState(frame, (x) => x.chars === JSON.stringify(EDIT_DOC).length);
  const dirtyTitle = await waitTitleStar(true);
  check('整篇替换成紧凑 JSON 后标记为未保存（标题带 *）', st.dirty === true && /^\*/.test(dirtyTitle), dirtyTitle);
  await shot('格式化前-紧凑单行');

  await clickInFrame(frame, '#btn-format');
  st = await waitState(frame, (x) => x.lines > 5);
  let formatted = await docText(frame);
  check('格式化后变成多行（缩进 2 空格）',
    formatted.split('\n').length > 8 && /^  "name": "cloudnine",$/m.test(formatted), formatted.slice(0, 60));
  check('格式化后仍是合法 JSON，且内容语义不变',
    JSON.stringify(JSON.parse(formatted)) === JSON.stringify(EDIT_DOC));
  check('格式化后仍然是脏状态（还没保存）', (await state(frame)).dirty === true);
  await shot('格式化后-2空格缩进');

  // 键名排序
  await clickInFrame(frame, '#btn-sort');
  await clickInFrame(frame, '#btn-format');
  formatted = await docText(frame);
  const topKeys = [...formatted.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
  check('键名排序后顶层键按字典序',
    JSON.stringify(topKeys) === JSON.stringify([...topKeys].sort()), JSON.stringify(topKeys));
  await clickInFrame(frame, '#btn-sort');   // 关掉排序

  // 4 空格缩进
  await frame.select('#indent-sel', '4');
  await clickInFrame(frame, '#btn-format');
  formatted = await docText(frame);
  check('缩进方式切到 4 空格生效', /^    "name": "cloudnine",$/m.test(formatted), formatted.split('\n')[1]);
  await frame.select('#indent-sel', 'tab');
  await clickInFrame(frame, '#btn-format');
  check('缩进方式切到 Tab（\t）生效', /^\t"name": "cloudnine",$/m.test(await docText(frame)), JSON.stringify((await docText(frame)).split('\n')[1]));
  await frame.select('#indent-sel', '2');

  // 选区格式化：只把 {"from":"subdir"} 这一个对象展开
  await replaceAllText(frame, '{"a":{"b":1,"c":2},"z":9}');
  await frame.evaluate(() => {
    const ta = document.getElementById('code-input');
    const s = ta.value.indexOf('{"b"');
    ta.setSelectionRange(s, s + '{"b":1,"c":2}'.length);
  });
  await clickInFrame(frame, '#btn-format');
  const selFmt = await docText(frame);
  check('有选区时只格式化选区（外围保持原样）',
    selFmt.startsWith('{"a":{\n  "b": 1,\n  "c": 2\n},"z":9}') && selFmt.split('\n').length === 4, JSON.stringify(selFmt));
  check('选区格式化后仍合法', (await state(frame)).valid === true);

  // 压缩 + 保存
  await clickInFrame(frame, '#btn-minify');
  const minified = await docText(frame);
  check('压缩成一行（只保留末尾换行）', minified.trim().indexOf('\n') < 0 && minified.trim().length > 10, JSON.stringify(minified));
  await clickInFrame(frame, '#btn-save');
  st = await waitState(frame, (x) => x.dirty === false);
  const cleanTitle = await waitTitleStar(false);
  check('保存后脏标记清除（标题没有 *）', st.dirty === false && !/^\*/.test(cleanTitle), cleanTitle);
  const disk = readDisk('sample.json');
  check('磁盘文件真实变更（读临时 FILE_ROOT 核对）', disk === minified, `${disk.slice(0, 40)} vs ${minified.slice(0, 40)}`);
  check('磁盘内容可被 JSON.parse（没有写坏）', !!JSON.parse(disk));

  // ============================================================ 5. 树视图
  section('树视图：展开层级 / 着色 / 条数 / 复制 JSONPath / 分页');
  await closeAllWindows();
  await dblclickEntry('tree.json');
  frame = await frameOf('tree.json', 20000);
  check('tree.json 打开成功', !!frame);
  await clickInFrame(frame, '#btn-view-tree');
  st = await waitState(frame, (x) => x.view === 'tree');
  const tree = await frame.evaluate(() => {
    const row = (p) => {
      const el = document.querySelector(`.trow[data-path="${p}"]`);
      if (!el) return null;
      return {
        text: el.innerText.trim(),
        count: (el.querySelector('.tcount')?.textContent || '').trim(),
        valCls: (el.lastElementChild?.className || ''),
      };
    };
    return {
      rows: document.querySelectorAll('.trow').length,
      root: row('$'),
      port: row('$.server.port'),
      tls: row('$.server.tls'),
      enabled: row('$.server.tls.enabled'),
      tags0: row('$.tags[0]'),
      note: row('$.note'),
      user0: row('$.users[0].name'),
    };
  });
  check('切到树视图并渲染出节点', st.view === 'tree' && tree.rows > 5, `rows=${tree.rows}`);
  check('默认展开 2 层：$.server.port 可见，但 $.server.tls.enabled 未展开',
    !!tree.port && !tree.enabled, JSON.stringify({ port: !!tree.port, enabled: !!tree.enabled }));
  check('对象节点显示子项条数（tls 1 个键）', tree.tls && /1 个键/.test(tree.tls.count), JSON.stringify(tree.tls));
  check('按类型着色：数字 t-num / 字符串 t-str / null t-null',
    /t-num/.test(tree.port?.valCls || '') && /t-str/.test(tree.tags0?.valCls || '') && /t-null/.test(tree.note?.valCls || ''),
    JSON.stringify([tree.port?.valCls, tree.tags0?.valCls, tree.note?.valCls]));
  await shot('树视图-默认展开2层');

  // 折叠 / 展开
  const caretSel = '.trow[data-path="$.server.tls"] .tcaret';
  await clickInFrame(frame, caretSel);
  const expanded = await frame.evaluate(() => !!document.querySelector('.trow[data-path="$.server.tls.enabled"]'));
  check('点折叠箭头可以展开子节点', expanded === true);
  await clickInFrame(frame, caretSel);
  const collapsed = await frame.evaluate(() => !!document.querySelector('.trow[data-path="$.server.tls.enabled"]'));
  check('再点一次收起', collapsed === false);

  // 点节点复制 JSONPath
  await clickInFrame(frame, '.trow[data-path="$.server.port"]');
  await sleep(400);
  const toastText = await frame.evaluate(() => (document.querySelector('.toast')?.textContent || ''));
  check('点节点提示已复制 JSONPath', /已复制 JSONPath：\$\.server\.port/.test(toastText), toastText);
  let clip = '';
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* 无权限就算了 */ }
  check('系统剪贴板里就是 $.server.port', clip === '$.server.port', clip);
  await shot('树视图-复制JSONPath');
  await clickInFrame(frame, '#btn-view-text');
  const backToText = await frame.evaluate(() => ({
    hidden: document.getElementById('pane-text').hidden,
    treeHidden: document.getElementById('pane-tree').hidden,
    hl: document.getElementById('code-hl').innerHTML.length,
  }));
  check('树 → 文本双向切换：回到文本视图且高亮还在',
    backToText.hidden === false && backToText.treeHidden === true && backToText.hl > 10, JSON.stringify(backToText));

  // 大数组分页
  await closeAllWindows();
  await dblclickEntry('bigarray.json');
  frame = await frameOf('bigarray.json', 20000);
  await clickInFrame(frame, '#btn-view-tree');
  st = await waitState(frame, (x) => x.view === 'tree');
  const pageInfo = await frame.evaluate(() => ({
    rows: document.querySelectorAll('.trow').length,
    more: (document.querySelector('.tmore')?.textContent || '').trim(),
    bigCount: (document.querySelector('.trow[data-path="$.big"] .tcount')?.textContent || '').trim(),
  }));
  check('大数组（1200 项）分页展开：根 + 数组 + 先给 200 项',
    pageInfo.rows === 202 && /还有 1000 项/.test(pageInfo.more), JSON.stringify({ rows: pageInfo.rows, more: pageInfo.more }));
  check('数组节点标出总条数（1200 项）', /1200 项/.test(pageInfo.bigCount), pageInfo.bigCount);
  await clickInFrame(frame, '.tmore');
  const afterMore = await frame.evaluate(() => document.querySelectorAll('.trow').length);
  check('点「显示更多」再展开 200 项', afterMore === 402, String(afterMore));
  await shot('树视图-大数组分页');
  await closeAllWindows();

  // ============================================================ 6. 搜索
  section('Ctrl+F 搜索：命中高亮 + 上下一个');
  await dblclickEntry('tree.json');
  frame = await frameOf('tree.json', 20000);
  await focusEditor(frame);
  await page.keyboard.down('Control');
  await page.keyboard.press('f');
  await page.keyboard.up('Control');
  await sleep(250);
  const findOpen = await frame.evaluate(() => !document.getElementById('findbar').hidden);
  check('Ctrl+F 打开查找栏', findOpen === true);
  await frame.$eval('#find-input', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await frame.$eval('#find-input', (el) => el.focus());
  await page.keyboard.type('e');
  await sleep(300);
  const findInfo = await frame.evaluate(() => ({
    count: document.getElementById('find-count').textContent,
    hits: document.querySelectorAll('#code-hl .hit').length,
    cur: document.querySelectorAll('#code-hl .hit-cur').length,
  }));
  const findNums = (findInfo.count.match(/^(\d+)\/(\d+)$/) || []).slice(1).map(Number);
  check('命中数显示成「当前/总数」且命中多个',
    findNums.length === 2 && findNums[1] > 1 && findNums[0] >= 1, findInfo.count);
  check('命中在文本视图里高亮，且有一个是当前命中',
    findInfo.hits > 1 && findInfo.cur === 1, JSON.stringify(findInfo));
  await shot('搜索命中高亮');
  await frame.$eval('#find-input', (el) => el.focus());
  await page.keyboard.press('Enter');
  await sleep(200);
  const findInfo2 = await frame.evaluate(() => document.getElementById('find-count').textContent);
  const expectNext = findNums.length === 2 ? (findNums[0] % findNums[1]) + 1 : -1;
  check('回车跳到下一个命中（计数前进，到末尾回到 1）',
    findInfo2 === `${expectNext}/${findNums[1]}`, `${findInfo.count} → ${findInfo2}`);
  await clickInFrame(frame, '#find-prev');
  await sleep(200);
  const findInfo3 = await frame.evaluate(() => document.getElementById('find-count').textContent);
  const expectPrev = expectNext === 1 ? findNums[1] : expectNext - 1;
  check('点「上一个」回到前一个命中（1 处回绕到末尾）', findInfo3 === `${expectPrev}/${findNums[1]}`, `${findInfo2} → ${findInfo3}`);
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc 关闭查找栏并清掉命中高亮',
    (await frame.evaluate(() => document.getElementById('findbar').hidden))
    && (await frame.evaluate(() => document.querySelectorAll('#code-hl .hit').length)) === 0);
  await closeAllWindows();

  // ============================================================ 7. 非法 JSON
  section('非法 JSON：行列 + 期望 token + 禁止保存');
  await dblclickEntry('broken.json');
  frame = await frameOf('broken.json', 20000);
  st = await state(frame);
  check('非法 JSON 被识别出来', st.valid === false && !!st.error, JSON.stringify(st.error));
  check('错误带行列（第 4 行 第 3 列）', st.error?.line === 4 && st.error?.col === 3, JSON.stringify(st.error));
  check('错误带期望 token（"," 或 "}"）', /期望/.test(st.error?.message || '') && /或/.test(st.error?.expected || ''), st.error?.message);
  const errBanner = await frame.evaluate(() => (document.querySelector('.banner.danger .bt')?.textContent || '').trim());
  check('顶部横幅明确报语法错误', /语法错误/.test(errBanner) && /第 4 行/.test(errBanner), errBanner);
  const errMark = await frame.evaluate(() => document.querySelectorAll('#code-hl .err').length);
  check('文本视图高亮错误位置', errMark > 0, String(errMark));
  const gutterErr = await frame.evaluate(() => !!document.querySelector('.gutter .err-line'));
  check('行号里也标出错误行', gutterErr === true);
  check('保存按钮被禁用（语法错误时禁止保存）',
    await frame.$eval('#btn-save', (el) => el.disabled) === true);
  await focusEditor(frame);
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await sleep(500);
  const saveMsg = await frame.$eval('#sb-msg', (el) => el.textContent);
  check('Ctrl+S 明确提示「语法错误未保存」，不静默失败',
    /语法错误未保存/.test(saveMsg), saveMsg);
  check('磁盘文件没有被改动', readDisk('broken.json') === '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}\n');
  await shot('文本视图-语法错误提示');
  await clickInFrame(frame, '.banner.danger .bx .btn');
  const jumped = await frame.$eval('#sb-pos', (el) => el.textContent);
  check('点「跳到错误位置」把光标带到错误行列', /行 4，列 3/.test(jumped), jumped);
  await closeAllWindows();

  // ============================================================ 8. 边界：jsonc / 空文件 / 大文件 / 非 UTF-8
  section('边界：.jsonc / 空文件 / 大文件上限 / 非 UTF-8');
  await dblclickEntry('notes.jsonc');
  frame = await frameOf('notes.jsonc', 20000);
  st = await state(frame);
  check('.jsonc 带注释 + 尾逗号被当作 JSONC 正常解析（不报语法错误）',
    st.valid === true && st.jsonc === true, JSON.stringify({ valid: st.valid, jsonc: st.jsonc }));
  const jsoncBanner = await frame.evaluate(() => [...document.querySelectorAll('.banner')].map((b) => b.textContent).join(' | '));
  check('对注释给出中文提示（JSONC 语法 / 格式化会丢注释）', /JSONC|注释/.test(jsoncBanner), jsoncBanner.slice(0, 120));
  check('.jsonc 可以保存（保存按钮可用）',
    await frame.$eval('#btn-save', (el) => el.disabled) === false);
  await shot('JSONC-注释提示');
  await closeAllWindows();

  await dblclickEntry('empty.json');
  frame = await frameOf('empty.json', 20000);
  st = await state(frame);
  const emptyBanner = await frame.evaluate(() => [...document.querySelectorAll('.banner')].map((b) => b.textContent).join(' | '));
  check('空文件不报语法错误，并提示「文件是空的」',
    st.valid === true && /空的/.test(emptyBanner), JSON.stringify({ valid: st.valid, banner: emptyBanner.slice(0, 80) }));
  await closeAllWindows();

  // ---- 3.4MB：以前会被 2MB 门槛挡成只读，现在整份可编辑、可保存（顺带验 >1MB 写入） ----
  await dblclickEntry('huge.json');
  frame = await frameOf('huge.json', 30000);
  st = await state(frame);
  check('3.4MB 文件不再被 2MB 门槛拦成只读（整份读进来）',
    st.readonly === false && st.truncated === false && st.size > 3 * 1024 * 1024,
    JSON.stringify({ size: st.size, truncated: st.truncated, readonly: st.readonly }));
  check('按需请求 maxKB（不是默认 512KB）', st.readKB >= 3000, String(st.readKB));
  const hugeChars = await frame.evaluate(() => document.getElementById('code-input').value.length);
  check('读到的字符数 > 600000（旧的 512KB 上限确实被突破）', hugeChars > 600000, String(hugeChars));
  const bigRender = await frame.evaluate(() => ({
    noHl: document.getElementById('pane-text').classList.contains('no-hl'),
    layerLen: document.getElementById('code-hl').innerHTML.length,
    gutter: document.querySelectorAll('.gutter .ln').length,
    textareaColor: getComputedStyle(document.getElementById('code-input')).color,
  }));
  check('大文档自动关闭语法高亮（彩色层不复制几 MB 文本进 DOM，文字仍可读）',
    bigRender.noHl && bigRender.layerLen === 0
    && bigRender.textareaColor !== 'rgba(0, 0, 0, 0)', JSON.stringify(bigRender));
  await shot('3.4MB-可编辑大文件');

  await clickInFrame(frame, '#btn-save');
  st = await waitState(frame, (x) => x.msg.indexOf('已保存') >= 0, 30000);
  const hugeDisk = readDisk('huge.json');
  check('3.4MB 保存成功（>1MB 写入上限确实放宽了）', /已保存/.test(st.msg), st.msg);
  check('磁盘内容与编辑框一致（3.4MB 回读核对）',
    hugeDisk.length === hugeChars && hugeDisk.slice(0, 20) === (await docText(frame)).slice(0, 20),
    `${hugeDisk.length} vs ${hugeChars}`);
  await closeAllWindows();

  // ---- >8MB：只读 + 真实尺寸 ----
  await dblclickEntry('oversize.json');
  frame = await frameOf('oversize.json', 40000);
  st = await state(frame);
  check('>8MB 文件被识别（内容超过工具上限，只预览一部分）',
    st.truncated === true && st.size > 8 * 1024 * 1024, JSON.stringify({ size: st.size, truncated: st.truncated }));
  check('>8MB 默认只读', st.readonly === true);
  const bigBanner = await frame.evaluate(() => [...document.querySelectorAll('.banner')].map((b) => b.textContent).join(' | '));
  check('只读提示带真实尺寸和工具上限（8.00 MB）',
    /工具上限 8\.00 MB/.test(bigBanner) && new RegExp((st.size / 1024 / 1024).toFixed(2) + ' MB').test(bigBanner),
    bigBanner.slice(0, 160));
  check('>8MB 时保存按钮禁用', await frame.$eval('#btn-save', (el) => el.disabled) === true);
  check('>8MB 时文本输入框 readOnly', await frame.$eval('#code-input', (el) => el.readOnly) === true);
  await shot('大文件-只读提示');

  // 「仍然编辑」→ 弹二次确认（会截断文件），取消后仍然只读
  await clickInFrame(frame, '.banner .bx .btn');
  await sleep(300);
  const modal = await frame.evaluate(() => {
    const m = document.querySelector('.modal-scrim .modal');
    return m ? { text: m.innerText, btns: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null;
  });
  check('点「仍然编辑」弹出「会截断文件」的二次确认',
    !!modal && /丢失|截断/.test(modal.text), JSON.stringify(modal && modal.text.slice(0, 80)));
  check('确认弹层里有「取消」和「我明白，仍然编辑」',
    !!modal && modal.btns.some((b) => /取消/.test(b)) && modal.btns.some((b) => /仍然编辑/.test(b)),
    JSON.stringify(modal?.btns));
  await shot('大文件-仍然编辑二次确认');
  await frame.evaluate(() => {
    const m = document.querySelector('.modal-scrim .modal');
    if (m) [...m.querySelectorAll('button')].find((b) => /取消/.test(b.textContent))?.click();
  });
  await sleep(300);
  check('取消后仍然是只读（没有把文件置于危险状态）',
    (await state(frame)).readonly === true && await frame.$eval('#code-input', (el) => el.readOnly) === true);

  // ---- 宿主上限的直接契约（写 9MB / 剪贴板 300KB 都要拿到可识别错误） ----
  const writeErr = await frame.evaluate(() => window.cloudnine.fs
    .writeText('sample.json', 'x'.repeat(9 * 1024 * 1024))
    .then(() => 'ok', (e) => `${e.code}|${e.message}`));
  check('fs.writeText 超 8MB 回 PAYLOAD_TOO_LARGE，message 带真实体积',
    /^PAYLOAD_TOO_LARGE\|/.test(writeErr) && /9\.00 MB/.test(writeErr) && /8\.00 MB/.test(writeErr), writeErr);
  const clipErr = await frame.evaluate(() => window.cloudnine.clipboard
    .writeText('y'.repeat(300 * 1024))
    .then(() => 'ok', (e) => `${e.code}|${e.message}`));
  check('clipboard.writeText 超 256KB 回 PAYLOAD_TOO_LARGE（不静默失败）',
    /^PAYLOAD_TOO_LARGE\|/.test(clipErr) && /256\.0 KB|256\.0 KB/.test(clipErr), clipErr);
  const sandboxFacts = await frame.evaluate(() => {
    let ls = '';
    try { localStorage.getItem('x'); ls = 'ok'; } catch (e) { ls = e.name; }
    let cf = 'no';
    try { cf = String(window.confirm('沙箱里不该弹出来')); } catch (e) { cf = e.name; }
    return { ls, cf };
  });
  check('沙箱里 localStorage 抛 SecurityError（拿不到存储）', sandboxFacts.ls === 'SecurityError', sandboxFacts.ls);
  check('沙箱里 window.confirm 是空操作（返回 false，不弹框）', sandboxFacts.cf === 'false', sandboxFacts.cf);
  await closeAllWindows();

  // ---- 1.2MB：正常打开 / 格式化 / 保存，磁盘回读一致 ----
  await dblclickEntry('medium.json');
  frame = await frameOf('medium.json', 30000);
  st = await state(frame);
  check('1.2MB JSON 正常可编辑（不截断、不置只读）',
    st.readonly === false && st.truncated === false && st.size > 1024 * 1024
    && st.chars > 600000, JSON.stringify({ size: st.size, chars: st.chars, readonly: st.readonly }));
  check('1.2MB 内容完整：字符数与磁盘一致',
    st.chars === readDisk('medium.json').length, `${st.chars} vs ${readDisk('medium.json').length}`);
  await shot('1.2MB-正常打开可编辑');

  await clickInFrame(frame, '#btn-format');
  st = await waitState(frame, (x) => x.lines > 1000, 30000);
  const mediumFormatted = await docText(frame);
  check('1.2MB 文档格式化成功（多行、缩进 2 空格）',
    mediumFormatted.split('\n').length > 1000 && /^  "/.test(mediumFormatted.split('\n')[1] || ''),
    JSON.stringify({ lines: st.lines, bytes: st.bytes }));
  check('格式化后仍合法（解析出的结构没坏）', st.valid === true);
  await clickInFrame(frame, '#btn-save');
  st = await waitState(frame, (x) => x.dirty === false && x.msg.indexOf('已保存') >= 0, 30000);
  const mediumDisk = readDisk('medium.json');
  check('1.2MB 格式化后保存成功、脏标记清除', st.dirty === false && /已保存/.test(st.msg), st.msg);
  check('磁盘回读与编辑框逐字节一致（1.2MB 全量写入）',
    mediumDisk === mediumFormatted, `${mediumDisk.length} vs ${mediumFormatted.length}`);
  check('磁盘内容能被 JSON.parse', (() => { try { JSON.parse(mediumDisk); return true; } catch { return false; } })());
  await shot('1.2MB-格式化并保存');
  await closeAllWindows();

  await dblclickEntry('gbk.json');
  frame = await frameOf('gbk.json', 20000);
  st = await state(frame);
  check('非 UTF-8 文件按服务端解码结果打开（encoding 不是 utf-8）',
    st.encoding !== 'utf-8', st.encoding);
  const gbkText = await docText(frame);
  check('GBK 内容解码正确（读到「你」）', gbkText.indexOf('你') >= 0, JSON.stringify(gbkText));
  const encBanner = await frame.evaluate(() => [...document.querySelectorAll('.banner')].map((b) => b.textContent).join(' | '));
  check('非 UTF-8 给出中文警告（保存会写成 UTF-8）', /UTF-8/.test(encBanner) && /保存/.test(encBanner), encBanner.slice(0, 140));
  await shot('非UTF8-编码提示');
  await closeAllWindows();

  if (OWN_SERVER) {
    const pluginDataFile = join(dataDir, 'plugin-data', 'json.json');
    check('文档内容不落插件私有存储（插件只声明 fs + clipboard，不用 storage）',
      !existsSync(pluginDataFile), pluginDataFile);
    const hostLs = await page.evaluate(() => JSON.stringify(localStorage));
    check('宿主 localStorage 里没有文档正文（插件不拿 localStorage 存文档）',
      !hostLs.includes('cloudnine') && hostLs.length < 20000, String(hostLs.length));
  }

  // ============================================================ 9. 脏标记 + 关窗确认
  section('脏标记 / 关窗确认');
  await dblclickEntry('tree.json');
  frame = await frameOf('tree.json', 20000);
  await focusEditor(frame);
  await insertText(' ');
  st = await waitState(frame, (x) => x.dirty === true);
  check('编辑后变脏（标题前出现 *）', st.dirty === true && /^\*/.test(await winTitle()), await winTitle());
  check('状态栏出现「未保存」标记', await frame.$eval('#sb-dirty', (el) => !el.hidden));
  await page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].pop();
    w.querySelector('.tc-close').click();
  });
  await sleep(400);
  let dlg = await dialogVisible();
  check('点 X 弹出「未保存的更改」确认', (dlg?.title || '').includes('未保存'), JSON.stringify(dlg));
  await page.evaluate(() => {
    const d = document.querySelector('.dialog-overlay .dialog');
    [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')?.click();
  });
  await sleep(300);
  check('取消后窗口仍在、脏标记还在',
    await page.evaluate(() => document.querySelectorAll('.window').length) === 1
    && /^\*/.test(await winTitle()), await winTitle());
  await page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].pop();
    w.querySelector('.tc-close').click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const d = document.querySelector('.dialog-overlay .dialog');
    [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')?.click();
  });
  const closed = await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 6000 })
    .then(() => true).catch(() => false);
  check('确认「关闭」后窗口真的关掉', closed === true);

  // ============================================================ 10. 主题
  section('跟随宿主主题（亮 / 暗）');
  await setHostTheme('浅色主题');
  await dblclickEntry('sample.json');
  frame = await frameOf('sample.json', 20000);
  const pluginTheme = () => frame.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      accent: (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim(),
      scheme: document.documentElement.style.colorScheme,
    };
  });
  const lightHostBg = await hostToken('--bg');
  let lightTheme = await pluginTheme();
  for (let i = 0; i < 30 && lightTheme.bg !== lightHostBg; i++) { await sleep(150); lightTheme = await pluginTheme(); }
  check('亮色：插件背景 = 宿主 --bg', lightTheme.bg === lightHostBg, `${lightHostBg} vs ${lightTheme.bg}`);
  check('亮色：插件正文色 = 宿主 --text', lightTheme.color === await hostToken('--text'), lightTheme.color);
  await shot('亮色主题');

  const darkSwitch = await setHostTheme('深色主题');
  check('宿主切到深色主题生效', darkSwitch.clicked && darkSwitch.theme === 'dark', JSON.stringify(darkSwitch));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 8000 }).catch(() => {});
  const darkHostBg = await hostToken('--bg');
  let darkTheme = await pluginTheme();
  for (let i = 0; i < 40 && darkTheme.bg !== darkHostBg; i++) { await sleep(150); darkTheme = await pluginTheme(); }
  check('暗色：插件背景跟着变（live 切换，不用重开窗口）', darkTheme.bg === darkHostBg, `${darkHostBg} vs ${darkTheme.bg}`);
  check('暗色：与亮色确实不同（不是硬编码亮色）', darkTheme.bg !== lightTheme.bg, `${lightTheme.bg} → ${darkTheme.bg}`);
  check('暗色：正文色 = 宿主 --text', darkTheme.color === await hostToken('--text'), darkTheme.color);
  check('暗色：原生控件配色 = dark', darkTheme.scheme === 'dark', darkTheme.scheme);
  const darkContrast = await frame.evaluate(() => {
    const lum = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bg = lum(getComputedStyle(document.body).backgroundColor);
    const fg = lum(getComputedStyle(document.getElementById('code-hl')).color);
    return bg == null || fg == null ? null : (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
  });
  check('暗色下正文对比度 ≥ 4.5:1（暗色可读）', darkContrast >= 4.5, String(darkContrast));
  await shot('暗色主题');
  await setHostTheme('浅色主题');
  await closeAllWindows();

  // ============================================================ 11. 窄窗口
  section('窄窗口 560px（不错位、工具条可用）');
  await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('cloudnine-win-geom') || '{}');
    all['plugin:json'] = { x: 24, y: 60, w: 560, h: 600 };
    localStorage.setItem('cloudnine-win-geom', JSON.stringify(all));
  });
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icon[data-entry="sample.json"]', { timeout: 20000 });
  await dblclickEntry('sample.json');
  frame = await frameOf('sample.json', 20000);
  const hostWin = await page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].pop();
    const r = w.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  await clickInFrame(frame, '#btn-view-text');
  const narrow = await frame.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    save: !!document.getElementById('btn-save').offsetWidth,
    format: !!document.getElementById('btn-format').offsetWidth,
    find: !!document.getElementById('btn-find').offsetWidth,
    editor: !!document.getElementById('code-input').offsetWidth,
    gutter: !!document.querySelector('.gutter').offsetWidth,
    status: !!document.querySelector('.statusbar').offsetWidth,
  }));
  check('窗口宽度收敛到 560px', Math.abs(hostWin.w - 560) <= 1, String(hostWin.w));
  check('窄窗口没有横向溢出', narrow.docOverflow <= 0 && narrow.bodyOverflow <= 0, JSON.stringify(narrow));
  check('窄窗口里保存 / 格式化 / 搜索 / 编辑器 / 行号 / 状态栏都还在',
    narrow.save && narrow.format && narrow.find && narrow.editor && narrow.gutter && narrow.status, JSON.stringify(narrow));
  await shot('窄窗口-560px');

  // ============================================================ 12. 控制台
  section('控制台');
  // 本脚本自己会调一次 window.confirm 来验证「沙箱里 confirm 是空操作」，
  // Chrome 为此打的那条 Ignored call 是预期内的，不算插件错误
  const realErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m)
    && !/Ignored call to 'confirm\(\)'/.test(m));
  if (realErrors.length) console.log(`${DIM}    ${JSON.stringify(realErrors.slice(0, 3))}${RESET}`);
  check('浏览器控制台无 JS 错误、无无关 4xx/5xx',
    realErrors.length === 0 && badResponses.length === 0,
    JSON.stringify({ errors: realErrors.slice(0, 3), responses: badResponses.slice(0, 5) }));

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
