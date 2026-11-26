#!/usr/bin/env node
/**
 * CloudNine 插件系统 · 「待办事项」示例插件端到端验收（第三期）
 *
 * 覆盖：
 *   桌面虚拟图标 → 双击开窗（标题 / iframe sandbox）→ 新增 3 条 → 勾选完成（剩余计数 / 已完成筛选）
 *   → 改文字（双击进入编辑 + Esc 取消）→ 刷新页面后数据还在（核对 <PLUGIN_DATA_DIR>/todo.json 落盘）
 *   → 重启服务进程后数据还在（真持久化，不是内存）→ 删除 / 清除已完成
 *   → 亮色 / 暗色主题各一张（插件界面必须跟随宿主）→ 窄宽度不错位
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全部落在系统临时目录，
 *   examples/plugins/todo 复制进去当已安装插件，端口 8699，跑完杀进程 + 删目录。
 *
 * 依赖（puppeteer-core 不含 Chromium，复用系统 Chrome）：
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-todo.mjs
 *   node scripts/uitest-todo.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-todo.mjs --url http://127.0.0.1:8499/ --user u --password p   # 复用已起好的实例（不测重启）
 *   node scripts/uitest-todo.mjs --keep                # 保留临时目录（排障用）
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

const PORT = Number(arg('port', 8699));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/todo'));

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
let child = null;
let tmpRoot = null;
let serverEnv = null;
let dataDir = null;

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

async function stopServer() {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise((res) => {
    const done = () => res();
    c.once('exit', done);
    try { c.kill('SIGTERM'); } catch { /* 已退出 */ }
    setTimeout(() => {
      try { c.kill('SIGKILL'); } catch { /* 已退出 */ }
      res();
    }, 6000);
  });
  // 端口要真正释放，否则下一次 spawn 会 EADDRINUSE
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      await fetch(`${URL_BASE}/api/state`, { signal: AbortSignal.timeout(400) });
      await sleep(200);
    } catch {
      return; // 连不上了 = 端口已释放
    }
  }
}

async function prepareEnv() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-todo-uitest-'));
  dataDir = join(tmpRoot, 'data');
  const filesRoot = join(tmpRoot, 'files');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  mkdirSync(join(filesRoot, 'docs'), { recursive: true });
  writeFileSync(join(filesRoot, 'readme.txt'), 'cloudnine todo uitest\n');

  // 「安装」示例插件：与 zip 安装后的磁盘布局一致（<PLUGINS_DIR>/<id>/plugin.json）
  const src = join(ROOT, 'examples', 'plugins', 'todo');
  if (!existsSync(join(src, 'plugin.json'))) {
    console.error(`找不到示例插件：${src}`);
    process.exit(2);
  }
  cpSync(src, join(dataDir, 'plugins', 'todo'), { recursive: true });

  serverEnv = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PLUGINS_DIR: join(dataDir, 'plugins'),
    PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
    FILE_ROOT: filesRoot,
    SITE_NAME: 'CloudNine 待办自测',
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
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 上偶发占用：留着不影响 */ }
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

const todoFile = () => join(dataDir, 'plugin-data', 'todo.json');
const readTodoFile = () => {
  const f = todoFile();
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'invalid-json'; }
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

  const dblclickAt = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };
  const appIconCenter = () => page.evaluate(() => {
    const r = document.querySelector('.desktop-appicon[data-app="plugin:todo"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const closeAllWindows = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(250);
  };
  const todoFrame = async () => {
    for (let i = 0; i < 80; i++) {
      const f = page.frames().find((x) => x.url().includes('/pa/') && x.url().includes('/todo/'));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  // 等插件把数据渲染出来（宿主 cn:init → storage.get → 首次渲染）
  const waitReady = async (f, ms = 15000) => {
    const ok = await f.waitForFunction(
      () => document.getElementById('new-input') && !document.getElementById('new-input').disabled,
      { timeout: ms, polling: 100 },
    ).then(() => true).catch(() => false);
    return ok;
  };
  const readTodo = (f) => f.evaluate(() => {
    const all = [...document.querySelectorAll('#list .todo-item')];
    const visible = all.filter((li) => !li.hidden);
    const txt = (li) => (li.querySelector('.todo-text')?.textContent || '').trim();
    return {
      total: Number(document.getElementById('cnt-all').textContent),
      active: Number(document.getElementById('cnt-active').textContent),
      done: Number(document.getElementById('cnt-done').textContent),
      visibleCount: visible.length,
      visibleTexts: visible.map(txt),
      visibleDone: visible.map((li) => li.dataset.done === '1'),
      allTexts: all.map(txt),
      remaining: document.getElementById('remaining').textContent.trim(),
      status: document.getElementById('status').textContent.trim(),
      emptyHidden: document.getElementById('empty').hidden,
      emptyTitle: document.getElementById('empty-title').textContent.trim(),
      clearDisabled: document.getElementById('clear-done').disabled,
      pressed: [...document.querySelectorAll('[data-filter]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.filter),
    };
  });
  const waitTodo = async (f, fn, ms = 8000) => f.waitForFunction(fn, { timeout: ms, polling: 100 }).then(() => true).catch(() => false);
  const waitSaved = (f) => f.waitForFunction(
    () => /已保存/.test(document.getElementById('status').textContent), { timeout: 8000, polling: 100 },
  ).then(() => true).catch(() => false);
  const setFilter = (f, which) => f.evaluate((w) => {
    document.querySelector(`[data-filter="${w}"]`).click();
  }, which);
  // 这个 puppeteer-core 版本的 Frame 没有 click/press：一律用 $eval 点 + 先 focus 再走 page.keyboard
  const clickIn = (f, sel) => f.$eval(sel, (el) => el.click());
  const typeIn = async (f, sel, text) => {
    await f.$eval(sel, (el) => { el.focus(); });
    await page.keyboard.type(text);
  };
  const itemAction = (f, text, act) => f.evaluate((t, a) => {
    const li = [...document.querySelectorAll('#list .todo-item')]
      .find((x) => (x.querySelector('.todo-text')?.textContent || '').trim() === t);
    if (!li) return false;
    const el = a === 'check' ? li.querySelector('.todo-check') : li.querySelector(`[data-act="${a}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, text, act);
  const textCenter = async (f, text) => {
    const r = await f.evaluate((t) => {
      const li = [...document.querySelectorAll('#list .todo-item')]
        .find((x) => (x.querySelector('.todo-text')?.textContent || '').trim() === t);
      if (!li) return null;
      const b = li.querySelector('.todo-text').getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, text);
    if (!r) return null;
    const off = await page.evaluate(() => {
      const b = document.querySelector('.window .plugin-frame').getBoundingClientRect();
      return { x: b.x, y: b.y };
    });
    return { x: off.x + r.x + Math.min(r.w / 2, 30), y: off.y + r.y + r.h / 2 };
  };
  const openTodo = async () => {
    const box = await appIconCenter();
    await dblclickAt(box.x, box.y);
    const ok = await page.waitForSelector('.window .plugin-window iframe.plugin-frame', { timeout: 15000 })
      .then(() => true).catch(() => false);
    if (!ok) return null;
    return todoFrame();
  };

  console.log(`${BOLD}CloudNine 待办事项插件自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);

  // ---------- 1. 桌面虚拟图标 ----------
  section('桌面虚拟应用图标');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  const iconOk = await page.waitForSelector('.desktop-appicon[data-app="plugin:todo"]', { timeout: 15000 })
    .then(() => true).catch(() => false);
  check('登录后桌面出现「待办事项」虚拟图标', iconOk);
  const iconMeta = await page.evaluate(() => {
    const el = document.querySelector('.desktop-appicon[data-app="plugin:todo"]');
    return {
      label: el?.querySelector('.di-label')?.textContent.trim() || '',
      img: el?.querySelector('img')?.getAttribute('src') || '',
      title: el?.getAttribute('title') || '',
    };
  });
  check('图标标签 / 提示都是插件名「待办事项」',
    iconMeta.label === '待办事项' && iconMeta.title === '待办事项', JSON.stringify(iconMeta));
  check('图标来自服务端拼好的 /pa iconUrl（不是内置通用图标）',
    /^\/pa\/[0-9a-f]{32}\/todo\/icon\.svg$/.test(iconMeta.img), iconMeta.img);
  await shot('桌面-待办图标');

  // ---------- 2. 双击开窗 + 沙箱 iframe ----------
  section('双击开窗 / iframe 沙箱属性');
  let frame = await openTodo();
  check('双击图标打开插件窗口（窗口里是 iframe）', !!frame);
  const attrs = await page.evaluate(() => {
    const f = document.querySelector('.window .plugin-window iframe.plugin-frame');
    if (!f) return null;
    return {
      sandbox: f.getAttribute('sandbox'),
      title: f.getAttribute('title'),
      src: f.getAttribute('src'),
      winTitle: document.querySelector('.window .window-title')?.innerText.trim() || '',
      winW: Math.round(document.querySelector('.window').getBoundingClientRect().width),
      winH: Math.round(document.querySelector('.window').getBoundingClientRect().height),
    };
  });
  check('窗口标题 = 「待办事项」', attrs?.winTitle === '待办事项', attrs?.winTitle);
  check('iframe title = 插件名', attrs?.title === '待办事项', attrs?.title);
  check('iframe sandbox 恰为 "allow-scripts allow-forms"', attrs?.sandbox === 'allow-scripts allow-forms', attrs?.sandbox);
  check('iframe src 用服务端 entryUrl（含 /pa token）', /^\/pa\/[0-9a-f]{32}\/todo\/index\.html$/.test(attrs?.src || ''), attrs?.src);
  check('窗口初始尺寸取 manifest 的 720×560（视口够大时不收敛）',
    Math.abs((attrs?.winW || 0) - 720) <= 1 && Math.abs((attrs?.winH || 0) - 560) <= 1,
    `${attrs?.winW}×${attrs?.winH}`);
  check('插件已就绪（输入框可用，说明 cn:init + storage.get 都通了）', await waitReady(frame));
  const initial = await readTodo(frame);
  check('空列表：空状态可见、计数全 0、清除已完成禁用',
    !initial.emptyHidden && initial.total === 0 && initial.remaining.includes('暂无')
    && initial.clearDisabled && initial.emptyTitle.length > 0,
    JSON.stringify(initial));
  await shot('插件窗口-空状态');

  // ---------- 3. 新增 3 条 ----------
  section('新增 3 条（回车 2 条 + 按钮 1 条）');
  const addViaEnter = async (text) => {
    await typeIn(frame, '#new-input', text);
    await page.keyboard.press('Enter');
    await sleep(150);
  };
  await addViaEnter('买牛奶');
  await addViaEnter('写周报');
  // 第 3 条走「添加」按钮
  await typeIn(frame, '#new-input', '倒垃圾');
  await clickIn(frame, '#add-btn');
  const added = await waitTodo(frame, () => document.getElementById('cnt-all').textContent === '3')
    .then(() => readTodo(frame));
  check('列表 3 条（顺序为最新在前）', added.visibleCount === 3 && added.total === 3, JSON.stringify(added.visibleTexts));
  check('三条文本与输入一致',
    JSON.stringify(added.visibleTexts) === JSON.stringify(['倒垃圾', '写周报', '买牛奶']), JSON.stringify(added.visibleTexts));
  check('剩余计数 = 剩余 3 项未完成', added.remaining === '剩余 3 项未完成', added.remaining);
  check('底部计数：全部 3 / 未完成 3 / 已完成 0',
    added.total === 3 && added.active === 3 && added.done === 0, JSON.stringify(added));
  check('新增后空状态消失', added.emptyHidden);
  check('改动已落盘（输入框变空、状态「已保存」）',
    await waitSaved(frame) && (await frame.$eval('#new-input', (el) => el.value)) === '',
    added.status);
  await shot('插件窗口-新增3条');

  // ---------- 4. 勾选 1 条 ----------
  section('勾选完成 / 剩余计数 / 已完成筛选');
  check('勾选「买牛奶」', await itemAction(frame, '买牛奶', 'check'));
  const done1 = await waitTodo(frame, () => document.getElementById('cnt-done').textContent === '1')
    .then(() => readTodo(frame));
  check('该条变为已完成（data-done=1）',
    done1.visibleTexts.indexOf('买牛奶') === done1.visibleDone.indexOf(true), JSON.stringify(done1));
  check('剩余计数 = 剩余 2 项未完成', done1.remaining === '剩余 2 项未完成', done1.remaining);
  check('底部计数跟着变：未完成 2 / 已完成 1',
    done1.active === 2 && done1.done === 1, JSON.stringify(done1));
  await setFilter(frame, 'done');
  const filtered = await waitTodo(frame, () => document.getElementById('cnt-done').textContent === '1')
    .then(() => readTodo(frame));
  check('筛选「已完成」只剩 1 条（就是买牛奶）',
    filtered.visibleCount === 1 && filtered.visibleTexts[0] === '买牛奶', JSON.stringify(filtered.visibleTexts));
  check('筛选按钮的 aria-pressed 正确（只有「已完成」按下）',
    JSON.stringify(filtered.pressed) === JSON.stringify(['done']), JSON.stringify(filtered.pressed));
  await shot('插件窗口-已完成筛选');
  await setFilter(frame, 'active');
  const activeOnly = await readTodo(frame);
  check('筛选「未完成」剩 2 条', activeOnly.visibleCount === 2, JSON.stringify(activeOnly.visibleTexts));
  await setFilter(frame, 'all');
  check('切回「全部」是 3 条', (await readTodo(frame)).visibleCount === 3);

  // ---------- 5. 改文字 ----------
  section('改文字（双击进入编辑 / Enter 提交 / Esc 取消）');
  const target = await textCenter(frame, '写周报');
  check('找到「写周报」这一行', !!target);
  if (target) await dblclickAt(target.x, target.y);
  const editOk = await frame.waitForSelector('.todo-edit-input', { timeout: 5000 }).then(() => true).catch(() => false);
  check('双击文字进入编辑态（出现内联输入框且已全选）',
    editOk && await frame.$eval('.todo-edit-input', (el) => el.value === el.value && el.selectionEnd - el.selectionStart === el.value.length));
  await page.keyboard.type('写周报（v2）');
  await page.keyboard.press('Enter');
  const edited = await waitTodo(frame, () => [...document.querySelectorAll('#list .todo-item .todo-text')]
    .some((el) => el.textContent.trim() === '写周报（v2）')).then(() => readTodo(frame));
  check('内容确实改成「写周报（v2）」且原文字消失',
    edited.allTexts.includes('写周报（v2）') && !edited.allTexts.includes('写周报'), JSON.stringify(edited.allTexts));
  check('编辑后仍是 3 条、计数不变', edited.total === 3 && edited.done === 1, JSON.stringify(edited));

  // Esc 取消：改成别的再回退（用真实双击进入编辑，验证键盘输入真的落在输入框里）
  const cancelTarget = await textCenter(frame, '买牛奶');
  check('找到「买牛奶」这一行（准备测 Esc 取消）', !!cancelTarget);
  if (cancelTarget) await dblclickAt(cancelTarget.x, cancelTarget.y);
  await frame.waitForSelector('.todo-edit-input', { timeout: 5000 }).catch(() => {});
  await page.keyboard.type('不该保留的文字');
  const typedInEdit = await frame.$eval('.todo-edit-input', (el) => el.value).catch(() => '');
  check('编辑态确实拿到了焦点（键盘输入落在内联输入框里）', typedInEdit === '不该保留的文字', typedInEdit);
  await page.keyboard.press('Escape');
  await sleep(300);
  const cancelled = await readTodo(frame);
  check('Esc 取消编辑：文字没有被改掉',
    cancelled.allTexts.includes('买牛奶') && !cancelled.allTexts.some((t) => t.includes('不该保留')), JSON.stringify(cancelled.allTexts));
  check('取消后回到列表（编辑框消失）', await page.evaluate(() => true)
    && await frame.evaluate(() => !document.querySelector('.todo-edit-input')));
  await waitSaved(frame);
  await shot('插件窗口-改文字');

  // ---------- 6. 刷新页面后数据还在 ----------
  section('刷新页面重开窗口（读回 storage）');
  const onDisk = readTodoFile();
  check('插件私有数据落在 <PLUGIN_DATA_DIR>/todo.json',
    onDisk && Array.isArray(onDisk.items) && onDisk.items.length === 3, JSON.stringify(onDisk)?.slice(0, 160));
  const diskItem = (onDisk?.items || []).find((it) => it.text === '写周报（v2）');
  check('落盘内容包含改动后的文字与完成状态',
    !!diskItem && diskItem.done === false
    && (onDisk?.items || []).find((it) => it.text === '买牛奶')?.done === true,
    JSON.stringify(onDisk?.items));

  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-appicon[data-app="plugin:todo"]', { timeout: 20000 });
  frame = await openTodo();
  const reloadReady = frame ? await waitReady(frame) : false;
  const afterReload = reloadReady && frame ? await readTodo(frame) : null;
  check('刷新后重开窗口：3 条都还在',
    afterReload && afterReload.visibleCount === 3 && afterReload.total === 3, JSON.stringify(afterReload?.visibleTexts));
  check('刷新后完成状态还在（买牛奶已完成 / 剩余 2 项未完成）',
    afterReload && afterReload.remaining === '剩余 2 项未完成' && afterReload.done === 1, JSON.stringify(afterReload));
  check('刷新后改过的文字还在（写周报（v2））',
    (afterReload?.allTexts || []).includes('写周报（v2）'), JSON.stringify(afterReload?.allTexts));
  await shot('刷新后-数据仍在');

  // ---------- 7. 重启服务进程 ----------
  if (OWN_SERVER) {
    section('重启服务进程后再打开（真持久化）');
    await closeAllWindows();
    await stopServer();
    await startServer();
    check('服务进程已重启并重新可用', await waitServer(URL_BASE, 20000));
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.desktop-appicon[data-app="plugin:todo"]', { timeout: 20000 }).catch(() => {});
    frame = await openTodo();
    const restartReady = frame ? await waitReady(frame) : false;
    const afterRestart = restartReady && frame ? await readTodo(frame) : null;
    check('重启后桌面图标还在、窗口能打开', !!frame);
    check('重启后 3 条数据全在（不是内存里的）',
      afterRestart && afterRestart.visibleCount === 3 && afterRestart.total === 3 && afterRestart.done === 1,
      JSON.stringify(afterRestart));
    check('重启后文字与剩余计数不变',
      (afterRestart?.allTexts || []).includes('写周报（v2）') && afterRestart?.remaining === '剩余 2 项未完成',
      JSON.stringify(afterRestart));
    await shot('重启服务-数据仍在');
  } else {
    console.log(`${DIM}（复用外部实例，跳过重启服务用例）${RESET}`);
  }

  // ---------- 8. 删除 / 清除已完成 ----------
  section('删除一条 / 清除已完成');
  check('删除「倒垃圾」', await itemAction(frame, '倒垃圾', 'delete'));
  const afterDelete = await waitTodo(frame, () => document.getElementById('cnt-all').textContent === '2')
    .then(() => readTodo(frame));
  check('删除后剩 2 条', afterDelete.total === 2 && afterDelete.visibleCount === 2, JSON.stringify(afterDelete.allTexts));
  check('删除一条未完成项后剩余计数变 1',
    afterDelete.remaining === '剩余 1 项未完成', afterDelete.remaining);
  check('「清除已完成」可用', afterDelete.clearDisabled === false);
  await clickIn(frame, '#clear-done');
  const afterClear = await waitTodo(frame, () => document.getElementById('cnt-all').textContent === '1')
    .then(() => readTodo(frame));
  check('清除已完成后只剩 1 条（写周报（v2））',
    afterClear.total === 1 && afterClear.allTexts[0] === '写周报（v2）', JSON.stringify(afterClear.allTexts));
  check('清除已完成后按钮变禁用（没有已完成项）', afterClear.clearDisabled === true);
  await waitSaved(frame);
  const diskFinal = readTodoFile();
  check('清除后的状态也落盘了（todo.json 只剩 1 条未完成）',
    diskFinal && diskFinal.items.length === 1 && diskFinal.items[0].text === '写周报（v2）' && diskFinal.items[0].done === false,
    JSON.stringify(diskFinal?.items));
  await shot('插件窗口-清除已完成');

  // ---------- 9. 明暗主题 ----------
  section('跟随宿主主题（亮 / 暗）');
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
      tokenCount: document.documentElement.style.length,
    };
  });
  // 账户菜单（任务栏右端头像）切主题。焦点可能还在插件 iframe 里，页面收不到键盘事件，
  // 所以关弹层前先把焦点交回宿主页面，否则下一步点「头像」会把弹层又切掉。
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

  const lightSwitch = await setHostTheme('浅色主题');
  check('账户菜单可以切主题（宿主 UI 本身可用）', lightSwitch.clicked && lightSwitch.theme === 'light',
    JSON.stringify(lightSwitch));

  await setHostTheme('浅色主题');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 8000 }).catch(() => {});
  const lightHostBg = await hostToken('--bg');
  const lightHostText = await hostToken('--text');
  let lightTheme = await pluginTheme();
  for (let i = 0; i < 30 && lightTheme.bg !== lightHostBg; i++) { await sleep(150); lightTheme = await pluginTheme(); }
  check('亮色：插件背景 = 宿主 --bg（跟随注入的主题变量）',
    lightTheme.bg === lightHostBg, `宿主=${lightHostBg} 插件=${lightTheme.bg}`);
  check('亮色：插件正文色 = 宿主 --text', lightTheme.color === lightHostText,
    `宿主=${lightHostText} 插件=${lightTheme.color}`);
  const hostAccentLight = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('亮色：--accent 与宿主一致', lightTheme.accent === hostAccentLight, `${hostAccentLight} vs ${lightTheme.accent}`);
  check('亮色：原生控件配色 = light', lightTheme.scheme === 'light', lightTheme.scheme);
  await shot('亮色主题-插件跟随');

  const darkSwitch = await setHostTheme('深色主题');
  check('账户菜单切到深色主题生效', darkSwitch.clicked && darkSwitch.theme === 'dark', JSON.stringify(darkSwitch));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 8000 }).catch(() => {});
  // 主题切换后宿主广播 theme-changed → cn:theme → SDK 重设变量；等它真的变过来
  const hostDarkBg = await hostToken('--bg');
  let darkTheme = await pluginTheme();
  for (let i = 0; i < 40 && darkTheme.bg !== hostDarkBg; i++) { await sleep(150); darkTheme = await pluginTheme(); }
  check('暗色：插件背景跟着变成宿主 --bg（live 切换，不用重开窗口）',
    darkTheme.bg === hostDarkBg, `宿主=${hostDarkBg} 插件=${darkTheme.bg}`);
  check('暗色：与亮色确实不同（不是亮色硬编码）',
    darkTheme.bg !== lightTheme.bg, `${lightTheme.bg} → ${darkTheme.bg}`);
  check('暗色：插件正文色 = 宿主 --text', darkTheme.color === await hostToken('--text'),
    `插件=${darkTheme.color}`);
  check('暗色：原生控件配色 = dark', darkTheme.scheme === 'dark', darkTheme.scheme);
  await shot('暗色主题-插件跟随');
  await setHostTheme('浅色主题');

  // ---------- 10. 窄宽度 ----------
  section('窄宽度（380px 窗口，不错位）');
  await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('cloudnine-win-geom') || '{}');
    all['plugin:todo'] = { x: 24, y: 60, w: 380, h: 520 };
    localStorage.setItem('cloudnine-win-geom', JSON.stringify(all));
  });
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-appicon[data-app="plugin:todo"]', { timeout: 20000 });
  frame = await openTodo();
  const narrowReady = frame ? await waitReady(frame) : false;
  const hostWin = await page.evaluate(() => {
    const w = document.querySelector('.window');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const narrowFrame = narrowReady && frame ? await frame.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    inputVisible: !!document.getElementById('new-input').offsetWidth,
    addVisible: !!document.getElementById('add-btn').offsetWidth,
    filterVisible: [...document.querySelectorAll('[data-filter]')].every((b) => b.offsetWidth > 0),
    clearVisible: !!document.getElementById('clear-done').offsetWidth,
    footVisible: !!document.querySelector('.foot').offsetWidth,
    actionsOpacity: getComputedStyle(document.querySelector('#list .todo-item .todo-actions') || document.body).opacity,
    listCount: document.querySelectorAll('#list .todo-item').length,
  })) : null;
  const narrow = hostWin && narrowFrame ? { ...hostWin, ...narrowFrame } : null;
  check('窗口实际宽度收敛到 380px', narrow && Math.abs(narrow.w - 380) <= 1, String(narrow?.w));
  check('窄宽度下没有横向溢出（doc/body scrollWidth 不超过可视宽）',
    narrow && narrow.docOverflow <= 0 && narrow.bodyOverflow <= 0, JSON.stringify(narrow));
  check('窄宽度下输入框 / 添加 / 三个筛选 / 清除 / 底栏都还看得见',
    narrow && narrow.inputVisible && narrow.addVisible && narrow.filterVisible && narrow.clearVisible && narrow.footVisible,
    JSON.stringify(narrow));
  check('窄宽度下条目动作按钮常显（触屏/窄窗没有 hover）',
    narrow && narrow.actionsOpacity === '1', String(narrow?.actionsOpacity));
  check('窄窗口里数据仍在', narrow && narrow.listCount === 1, String(narrow?.listCount));
  await shot('窄窗口-380px');

  // ---------- 11. 控制台 ----------
  section('控制台');
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
