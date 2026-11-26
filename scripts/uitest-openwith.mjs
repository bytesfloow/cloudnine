#!/usr/bin/env node
/**
 * CloudNine 插件系统 · 文件关联自测（第四期：fileTypes / defaultFor / ui.markDirty）
 *
 * 覆盖：
 *   a. 声明 fileTypes 的插件进入「打开方式 ▸」候选；没有 fileTypes 的插件不进去
 *   b. 双击 .json → 由声明 defaultFor 的插件打开；cn:init 的 file.rel 与真实路径一致，
 *      插件用 fs.readText(file.rel) 能读出原文
 *   c. defaultFor 生效时直接进插件；同一扩展名被多个插件抢 → 回退内置（编辑器）
 *   d. 「打开方式」里手动选插件也能打开（该扩展名没有默认程序时）
 *   e. ui.markDirty(true) → 标题带 *；点 X 弹确认（取消不关 / 关闭才关）；ui.close 在脏时被拒；
 *      页面 beforeunload 被拦截（false → 不再拦）；多个脏窗口只弹一次确认
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / PLUGINS_DIR / PLUGIN_DATA_DIR / FILE_ROOT 全在系统临时目录，端口 8644，跑完清理。
 *   探针插件全部由本脚本在临时目录里生成（仓库里只有 examples/plugins/filelink-probe/ 一份示例）。
 *
 * 依赖：puppeteer-core（不含 Chromium，复用系统 Chrome）
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-openwith.mjs
 *   node scripts/uitest-openwith.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-openwith.mjs --url http://127.0.0.1:8499/ --user u --password p
 *   node scripts/uitest-openwith.mjs --keep
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
    try { return require(c); } catch { /* 继续尝试 */ }
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

const PORT = Number(arg('port', 8644));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/openwith'));

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

// 探针插件：清单不同，页面共用 examples/plugins/filelink-probe 的那一份
const PROBES = [
  // .json 的唯一默认程序：双击 .json 应该直接进它
  {
    id: 'filelink-probe', name: '文件关联探针', fileTypes: ['.json'], defaultFor: ['.json'], fromExample: true,
  },
  // 只是「打开方式」候选，不是默认程序
  { id: 'filelink-md', name: 'Markdown 探针', fileTypes: ['.md'] },
  // 没有 fileTypes：不许出现在打开方式里
  { id: 'filelink-nofiles', name: '无关联探针' },
  // 两个插件抢同一个扩展名 → 不默认，回退内置
  { id: 'filelink-conflict-a', name: '冲突甲', fileTypes: ['.log'], defaultFor: ['.log'] },
  { id: 'filelink-conflict-b', name: '冲突乙', fileTypes: ['.log'], defaultFor: ['.log'] },
];

function installProbe(pluginsDir, p) {
  const dir = join(pluginsDir, p.id);
  if (p.fromExample) {
    cpSync(join(ROOT, 'examples', 'plugins', 'filelink-probe'), dir, { recursive: true });
    const file = join(dir, 'plugin.json');
    const manifest = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    manifest.id = p.id;
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    return;
  }
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'examples', 'plugins', 'filelink-probe', 'index.html'), join(dir, 'index.html'));
  const manifest = {
    id: p.id,
    name: p.name,
    version: '1.0.0',
    description: '文件关联自测探针',
    author: 'CloudNine',
    entry: 'index.html',
    window: { width: 640, height: 520, minWidth: 420, minHeight: 320, multi: true },
    permissions: ['fs.read'],
    onDesktop: true,
    inStartMenu: true,
  };
  if (p.fileTypes) manifest.fileTypes = p.fileTypes;
  if (p.defaultFor) manifest.defaultFor = p.defaultFor;
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
}

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
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-openwith-uitest-'));
  const dataDir = join(tmpRoot, 'data');
  const filesRoot = join(tmpRoot, 'files');
  const pluginsDir = join(dataDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(join(filesRoot, 'sub'), { recursive: true });

  writeFileSync(join(filesRoot, 'data.json'), JSON.stringify({ marker: 'cloudnine-json-probe', n: 42 }, null, 2));
  writeFileSync(join(filesRoot, 'second.json'), JSON.stringify({ marker: 'cloudnine-json-second' }, null, 2));
  writeFileSync(join(filesRoot, 'note.md'), '# 关联测试\n\nmarkdown 内容\n');
  writeFileSync(join(filesRoot, 'debug.log'), 'log line 1\n');
  writeFileSync(join(filesRoot, 'plain.txt'), 'plain text\n');
  writeFileSync(join(filesRoot, 'sub', 'nested.json'), '{"where":"sub"}');
  for (const p of PROBES) installProbe(pluginsDir, p);

  child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PLUGINS_DIR: pluginsDir,
      PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
      FILE_ROOT: filesRoot,
      SITE_NAME: 'CloudNine 文件关联自测',
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

  // ---------- 小工具 ----------
  const centerOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);

  // CDP 里要拿到真正的 dblclick，两次 press 的 clickCount 必须分别是 1 / 2
  const dblclickAt = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };

  const dblclickEntry = async (name) => {
    const box = await centerOf(`.desktop-icon[data-entry="${name}"]`);
    if (!box) throw new Error(`桌面上找不到文件图标：${name}`);
    await dblclickAt(box.x, box.y);
    await sleep(600);
  };

  const rightClickEntry = async (name) => {
    const box = await centerOf(`.desktop-icon[data-entry="${name}"]`);
    if (!box) throw new Error(`桌面上找不到文件图标：${name}`);
    await page.mouse.click(box.x, box.y, { button: 'right' });
    await page.waitForSelector('.context-menu', { timeout: 5000 }).catch(() => {});
    await sleep(150);
  };

  // 右键菜单 → 「打开方式 ▸」子菜单里的候选标签
  const openWithLabels = async (name) => {
    await rightClickEntry(name);
    const has = await page.evaluate(() => !!document.querySelector('.context-menu [data-label="打开方式"]'));
    if (!has) return { found: false, labels: [] };
    await page.evaluate(() => document.querySelector('.context-menu [data-label="打开方式"]').click());
    await page.waitForFunction(() => !!document.querySelector('.context-menu[data-ctx-level="1"]'), { timeout: 4000 }).catch(() => {});
    await sleep(150);
    const labels = await page.evaluate(() => [...document.querySelectorAll('.context-menu[data-ctx-level="1"] .dropdown-item')]
      .map((e) => e.dataset.label || e.innerText.trim()));
    return { found: true, labels };
  };

  const closeMenu = async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(1200, 700).catch(() => {});
    await sleep(200);
  };

  const pluginFrame = async (pluginId) => {
    for (let i = 0; i < 60; i++) {
      const f = page.frames().find((x) => x.url().includes('/pa/') && x.url().includes(`/${pluginId}/`));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };

  // 等探针页面进入就绪状态，并取回它拿到的 file 对象 + 读到的内容
  const probeState = async (pluginId) => {
    const f = await pluginFrame(pluginId);
    if (!f) return null;
    for (let i = 0; i < 60; i++) {
      const st = await f.evaluate(() => ({
        ready: !!(window.__probe && window.__probe.ready),
        file: (window.__probe && window.__probe.file) || null,
        content: document.getElementById('content')?.textContent || '',
        name: document.getElementById('file-name')?.textContent || '',
        ext: document.getElementById('file-ext')?.textContent || '',
      })).catch(() => null);
      if (st?.ready && st.content && !/等待|（等待/.test(st.content)) return st;
      await sleep(250);
    }
    return null;
  };

  const windowSnapshot = () => page.evaluate(() => [...document.querySelectorAll('.window')].map((w) => ({
    title: (w.querySelector('.window-title')?.innerText || '').trim(),
    plugin: w.querySelector('iframe.plugin-frame')?.getAttribute('src') || '',
    editor: !!w.querySelector('.editor-area, .codemirror, .cm-editor, .monaco-editor, .editor-wrap, textarea'),
  })));

  const closeAllWindows = async () => {
    // 脏窗口点 X 会弹确认：先全部按「关闭」处理，直到没有窗口
    for (let i = 0; i < 6; i++) {
      const n = await page.evaluate(() => {
        document.querySelectorAll('.window .tc-close').forEach((b) => b.click());
        return document.querySelectorAll('.window').length;
      });
      await sleep(250);
      const dlg = await page.evaluate(() => !!document.querySelector('.dialog'));
      if (dlg) {
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('.dialog .dialog-actions .btn')];
          (btns.find((b) => /关闭|确定|好/.test(b.innerText)) || btns[btns.length - 1])?.click();
        });
        await sleep(250);
        continue;
      }
      if (!n) break;
    }
    await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 8000 }).catch(() => {});
    await sleep(200);
  };

  const dismissDialog = async () => {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.dialog .dialog-actions .btn')];
      (btns.find((b) => /取消/.test(b.innerText)) || btns[0])?.click();
    });
    await sleep(250);
  };

  console.log(`${BOLD}CloudNine 文件关联自测${RESET}  目标: ${URL_BASE}  截图: ${OUT_DIR}`);

  // ---------- 预置：登录后桌面就绪 ----------
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  await page.waitForSelector('.desktop-icon[data-entry="data.json"]', { timeout: 15000 });

  // ---------- a. 「打开方式」候选集合 ----------
  section('a. 打开方式候选（fileTypes 决定进不进）');
  const jsonMenu = await openWithLabels('data.json');
  check('右键 .json → 「打开方式」子菜单存在', jsonMenu.found, JSON.stringify(jsonMenu));
  check('内置两项仍在最前（用编辑器打开 / 用预览打开）',
    jsonMenu.labels[0] === '用编辑器打开' && jsonMenu.labels[1] === '用预览打开', jsonMenu.labels.join(' | '));
  check('声明 fileTypes:[".json"] 的插件出现在打开方式里',
    jsonMenu.labels.includes('用「文件关联探针」打开'), jsonMenu.labels.join(' | '));
  check('没有 fileTypes 的插件不在打开方式里（.json）',
    !jsonMenu.labels.some((l) => /无关联探针/.test(l)), jsonMenu.labels.join(' | '));
  check('.json 的打开方式里没有 .md / .log 的插件（按扩展名精确匹配）',
    !jsonMenu.labels.some((l) => /Markdown 探针|冲突甲|冲突乙/.test(l)), jsonMenu.labels.join(' | '));
  await shot('a-打开方式-json');
  await closeMenu();

  const logMenu = await openWithLabels('debug.log');
  check('同扩展名两个插件都进打开方式（冲突时用户仍可手动选）',
    logMenu.labels.includes('用「冲突甲」打开') && logMenu.labels.includes('用「冲突乙」打开'),
    logMenu.labels.join(' | '));
  await shot('a-打开方式-冲突');
  await closeMenu();

  const txtMenu = await openWithLabels('plain.txt');
  check('没有任何插件声明 .txt 时打开方式只剩内置两项',
    txtMenu.found && txtMenu.labels.length === 2, txtMenu.labels.join(' | '));
  await closeMenu();

  const mdMenu = await openWithLabels('note.md');
  check('声明 fileTypes:[".md"] 但没 defaultFor 的插件也进打开方式',
    mdMenu.labels.includes('用「Markdown 探针」打开'), mdMenu.labels.join(' | '));
  await closeMenu();

  // ---------- b. 双击 .json → defaultFor 生效 ----------
  section('b/c. 双击 .json（defaultFor 生效）');
  await dblclickEntry('data.json');
  const jsonWin = await page.waitForSelector('.window iframe.plugin-frame', { timeout: 15000 }).then(() => true).catch(() => false);
  check('双击 .json 打开了插件窗口（不是编辑器）', jsonWin);
  const winsAfterJson = await windowSnapshot();
  check('只有一个窗口，且不含内置编辑器', winsAfterJson.length === 1 && !winsAfterJson[0].editor,
    JSON.stringify(winsAfterJson));
  check('窗口标题 = 插件名（未标脏时没有 *）', winsAfterJson[0]?.title === '文件关联探针', winsAfterJson[0]?.title);
  const stJson = await probeState('filelink-probe');
  check('cn:init 的 file.rel 与真实路径一致（data.json）', stJson?.file?.rel === 'data.json', JSON.stringify(stJson?.file));
  check('file.name / file.ext 正确', stJson?.file?.name === 'data.json' && stJson?.file?.ext === '.json',
    JSON.stringify(stJson?.file));
  check('插件用 fs.readText(file.rel) 读出了原文（含 marker）',
    /cloudnine-json-probe/.test(stJson?.content || ''), (stJson?.content || '').slice(0, 80));
  await shot('b-双击json-进插件');

  // 同一插件 + 同一文件再双击：只聚焦，不叠第二个窗口
  await dblclickEntry('data.json');
  const wins2 = await windowSnapshot();
  check('同一文件再双击只复用已有窗口（不叠第二个）', wins2.length === 1, `窗口数=${wins2.length}`);
  await closeAllWindows();

  // number 类型也能正常：sub 目录双击还是文件资源管理器（插件不抢目录）
  await dblclickEntry('sub');
  await sleep(500);
  const folderWin = await windowSnapshot();
  check('双击文件夹仍开文件资源管理器（插件不抢目录）',
    folderWin.length === 1 && !folderWin[0].plugin, JSON.stringify(folderWin));
  await closeAllWindows();

  // ---------- c. 无 defaultFor → 内置行为不变 ----------
  section('c. 没有默认程序时保持内置行为');
  await dblclickEntry('note.md');
  await sleep(700);
  const mdWins = await windowSnapshot();
  check('双击 .md（无 defaultFor）打开内置编辑器，不开插件',
    mdWins.length === 1 && !mdWins[0].plugin && mdWins[0].editor, JSON.stringify(mdWins));
  await shot('c-md-无默认-内置编辑器');
  await closeAllWindows();

  // ---------- c2. defaultFor 冲突 → 回退内置 ----------
  await dblclickEntry('debug.log');
  await sleep(700);
  const logWins = await windowSnapshot();
  check('两个插件抢 .log 的 defaultFor → 双击回退内置编辑器（不是插件）',
    logWins.length === 1 && !logWins[0].plugin && logWins[0].editor, JSON.stringify(logWins));
  await shot('c-冲突-回退内置');
  await closeAllWindows();

  // ---------- d. 打开方式里手动选插件 ----------
  section('d. 「打开方式」手动选插件打开');
  await rightClickEntry('note.md');
  await page.evaluate(() => document.querySelector('.context-menu [data-label="打开方式"]').click());
  await page.waitForFunction(() => !!document.querySelector('.context-menu[data-ctx-level="1"]'), { timeout: 4000 }).catch(() => {});
  await sleep(150);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.context-menu[data-ctx-level="1"] .dropdown-item')]
      .find((e) => /Markdown 探针/.test(e.dataset.label || e.innerText));
    btn?.click();
  });
  await page.waitForSelector('.window iframe.plugin-frame', { timeout: 15000 }).catch(() => {});
  const stMd = await probeState('filelink-md');
  check('打开方式 → 插件窗口已打开（Markdown 探针）', !!stMd, JSON.stringify(await windowSnapshot()));
  check('打开方式打开的 file.rel = note.md', stMd?.file?.rel === 'note.md', JSON.stringify(stMd?.file));
  check('打开方式打开也能读到原文（markdown 内容）', /markdown 内容/.test(stMd?.content || ''), (stMd?.content || '').slice(0, 60));
  await shot('d-打开方式-手动选插件');
  await closeAllWindows();

  // ---------- e. ui.markDirty / 关闭确认 / beforeunload ----------
  section('e. ui.markDirty：标题 * / X 确认 / ui.close 被拒');
  await dblclickEntry('data.json');
  const dirtyFrame = await pluginFrame('filelink-probe');
  check('重新打开插件窗口（脏状态用例）', !!dirtyFrame);
  await dirtyFrame.click('#dirty-on');
  await sleep(500);
  const dirtyTitle = await page.evaluate(() => (document.querySelector('.window .window-title')?.innerText || '').trim());
  check('markDirty(true) 后标题前带 *', dirtyTitle.startsWith('*') && /文件关联探针/.test(dirtyTitle), dirtyTitle);
  await shot('e-脏状态-标题星号');

  // ui.close 在脏状态下被拒（宿主不替用户丢数据）
  await dirtyFrame.click('#close-btn');
  await sleep(500);
  const closeRes = await dirtyFrame.$eval('#close-result', (el) => el.textContent.trim()).catch(() => '');
  check('脏状态下 ui.close 被拒绝（UNSAVED_CHANGES）', closeRes === 'UNSAVED_CHANGES', closeRes);
  check('被拒后窗口还开着', (await windowSnapshot()).length === 1, JSON.stringify(await windowSnapshot()));
  // 探针 800ms 后会自己清脏再关闭，这里等到它关掉
  await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 6000 }).catch(() => {});
  check('探针清脏后再调 ui.close 能关掉窗口', (await windowSnapshot()).length === 0);

  // X 确认：取消 → 不关；确认 → 关
  await dblclickEntry('data.json');
  const f2 = await pluginFrame('filelink-probe');
  await f2.click('#dirty-on');
  await sleep(400);
  await page.evaluate(() => document.querySelector('.window .tc-close').click());
  await page.waitForSelector('.dialog', { timeout: 4000 }).catch(() => {});
  const dlgText = await page.evaluate(() => (document.querySelector('.dialog')?.innerText || '').trim());
  check('脏窗口点 X 弹「未保存的更改」确认框', /未保存的更改/.test(dlgText), dlgText.replace(/\n/g, ' / ').slice(0, 90));
  await shot('e-关闭确认');
  await dismissDialog();
  const afterCancel = await windowSnapshot();
  check('确认框点「取消」→ 窗口不关', afterCancel.length === 1 && afterCancel[0].title.startsWith('*'),
    JSON.stringify(afterCancel));

  await page.evaluate(() => document.querySelector('.window .tc-close').click());
  await page.waitForSelector('.dialog', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.dialog .dialog-actions .btn')];
    (btns.find((b) => /关闭/.test(b.innerText)) || btns[btns.length - 1])?.click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 6000 }).catch(() => {});
  check('确认框点「关闭」→ 窗口关掉', (await windowSnapshot()).length === 0);

  // 多个脏窗口：点 A 的 X 只弹一次确认，B 不受影响
  section('e. 多个脏窗口不弹窗炸弹');
  await dblclickEntry('data.json');
  await dblclickEntry('second.json');
  await sleep(800);
  const twoWins = await windowSnapshot();
  check('两个不同文件的两个插件窗口同时存在', twoWins.length === 2 && twoWins.every((w) => w.plugin),
    JSON.stringify(twoWins.map((w) => w.plugin)));
  const probeFrames = page.frames().filter((f) => f.url().includes('/filelink-probe/'));
  // 在 iframe 里直接派发 DOM 点击：两个窗口会互相遮挡，按坐标点会打到上面那个
  for (const f of probeFrames) {
    await f.evaluate(() => document.getElementById('dirty-on')?.click()).catch(() => {});
  }
  await sleep(600);
  const dirtyCount = await page.evaluate(() => [...document.querySelectorAll('.window .window-title')]
    .filter((el) => el.innerText.trim().startsWith('*')).length);
  check('两个窗口都进入脏状态（标题都有 *）', dirtyCount === 2, `脏标题数=${dirtyCount}`);

  await page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('iframe.plugin-frame'));
    w?.querySelector('.tc-close')?.click();
  });
  await page.waitForSelector('.dialog', { timeout: 4000 }).catch(() => {});
  const multiDlg = await page.evaluate(() => document.querySelectorAll('.dialog').length);
  check('两个脏窗口时点 X：只弹一个确认框', multiDlg === 1, String(multiDlg));
  await page.screenshot({ path: join(OUT_DIR, 'e-一次确认.png') });
  console.log(`${DIM}    📸 e-一次确认.png${RESET}`);
  await dismissDialog();
  const stillTwo = await windowSnapshot();
  check('取消后两个脏窗口都还在（另一个没被牵连）', stillTwo.length === 2, `窗口数=${stillTwo.length}`);
  await closeAllWindows();

  // ---------- e. beforeunload（真实刷新，走浏览器原生确认框） ----------
  section('e. beforeunload 拦截');
  let buDialogType = '';
  const onDialog = async (d) => {
    if (d.type() === 'beforeunload') buDialogType = d.type();
    try { await d.dismiss(); } catch { /* 已经关掉 */ }
  };
  page.on('dialog', onDialog);

  // ① 干净状态：不该拦，刷新真的会发生
  await dblclickEntry('data.json');
  await pluginFrame('filelink-probe');
  await page.mouse.click(720, 400); // 一次真实用户手势，Chrome 才允许弹 beforeunload 框
  await sleep(200);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await sleep(1200);
  check('没有脏窗口时 beforeunload 不拦（没有弹框）', buDialogType === '', buDialogType || '(没有弹框)');
  const reloaded = await page.evaluate(() => document.querySelectorAll('.window').length === 0
    && !!document.querySelector('.desktop-icons')).catch(() => false);
  check('没有脏窗口时刷新真的发生了（页面重载，桌面重新渲染）', reloaded);

  // ② 脏状态：必须拦
  buDialogType = '';
  await page.waitForSelector('.desktop-icon[data-entry="data.json"]', { timeout: 15000 });
  await dblclickEntry('data.json');
  const f3 = await pluginFrame('filelink-probe');
  await f3.click('#dirty-on');
  await sleep(500);
  await page.mouse.click(720, 400);
  await sleep(200);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await sleep(1500);
  check('有脏窗口时刷新被 beforeunload 拦住（浏览器弹原生确认框）', buDialogType === 'beforeunload',
    buDialogType || '(没有弹框)');
  const survived = await page.evaluate(() => document.querySelectorAll('.window').length).catch(() => 0);
  check('取消刷新后页面没有跳走（窗口都还在）', survived === 1, `窗口数=${survived}`);
  page.off('dialog', onDialog);
  await page.screenshot({ path: join(OUT_DIR, 'e-刷新被拦.png') });
  console.log(`${DIM}    📸 e-刷新被拦.png${RESET}`);

  // ---------- 控制台 ----------
  section('控制台');
  const ignoble = badResponses.filter((u) => /favicon\.ico/.test(u));
  const realBad = badResponses.filter((u) => !/favicon\.ico/.test(u));
  const realErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
  if (ignoble.length) console.log(`${DIM}    忽略 favicon 404：${ignoble.length} 条${RESET}`);
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
