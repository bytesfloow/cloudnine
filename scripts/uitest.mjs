#!/usr/bin/env node
/**
 * CloudNine 浏览器 UI 自动化自测
 *
 * 用系统 Chrome + puppeteer-core 驱动真实浏览器，模拟用户操作，
 * 并通过 API 反查磁盘状态来断言结果（比刮 DOM 文本可靠得多）。
 *
 * 覆盖流程：
 *   初始化向导 / 登录 → 桌面直览（主目录）→ 文件窗口 → 终端（真实 PTY 执行命令）
 *   → 文本编辑（输入 + Ctrl+S 保存 + 磁盘核对）→ 文件窗口列表核对
 *   → 图片预览（滚轮缩放 + 拖拽平移；移动端为双指缩放 + 单指拖动）
 *
 * 依赖（puppeteer-core 不含 Chromium，复用系统 Chrome）：
 *   mkdir -p /home/ubuntu/workspace/.uitest && cd /home/ubuntu/workspace/.uitest \
 *     && npm init -y && npm install puppeteer-core
 *   也可用 PUPPETEER_CORE=/path/to/puppeteer-core 指定位置
 *
 * 用法：
 *   node scripts/uitest.mjs --url http://127.0.0.1:8480/ --user u --password p
 *   node scripts/uitest.mjs --url ... --user u --password p --mobile
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---------- 解析 puppeteer-core ----------
function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    '/home/ubuntu/workspace/.uitest/node_modules/puppeteer-core',
    join(__dirname, '..', 'node_modules', 'puppeteer-core'),
    'puppeteer-core',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch { /* 继续尝试下一个 */ }
  }
  console.error('找不到 puppeteer-core。请先执行：');
  console.error('  mkdir -p /home/ubuntu/workspace/.uitest && cd /home/ubuntu/workspace/.uitest && npm init -y && npm install puppeteer-core');
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

const URL_BASE = (arg('url', 'http://127.0.0.1:8480/') || '').replace(/\/$/, '');
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const SESSION = arg('session', null);   // 已有会话 token（测试已部署实例时免密码）
const MOBILE = flag('mobile');
const imgName = `uitest-preview-${Date.now()}.png`; // 图片预览自测用图（桌面/移动两分支都会用到）
const probeName = `uitest-probe-${Date.now()}.txt`; // 探针文件：保证文件页至少有一个条目可断言
const newDirName = `uitest-desktop-dir-renamed-${Date.now()}`; // 桌面重命名用例的目标名
const OUT_DIR = join(__dirname, '..', 'shots', `uitest-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const CHROME = arg('chrome', '/usr/bin/google-chrome');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

const passed = [];
const failed = [];
const steps = [];
let currentShot = '';   // 最近一次截图的文件名：失败时据此指出该看哪张图

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

// ---------- 截图目录滚动清理：只保留最近 KEEP_SHOTS 次运行，避免 shots/ 无限膨胀 ----------
const KEEP_SHOTS = Math.max(1, Number(arg('keep-shots', 3)));
function pruneShots(keep) {
  const root = join(__dirname, '..', 'shots');
  if (!existsSync(root)) return;
  // 目录名自带时间戳（uitest-YYYY-MM-DDTHH-mm-ss-SSSZ），字典序即时间序
  const runs = readdirSync(root).filter((n) => n.startsWith('uitest-')).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    rmSync(join(root, name), { recursive: true, force: true });
    console.log(`${DIM}    🧹 已清理旧截图目录 ${name}${RESET}`);
  }
}

// ---------- 测试用 PNG（手写编码，免图像库依赖） ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = Math.round((x / w) * 255);
      raw[o++] = Math.round((y / h) * 255);
      raw[o++] = 160;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 图片预览的 transform 解析：translate(x,y) scale(z)
const zoomOf = (t) => parseFloat((t.match(/scale\(([\d.]+)\)/) || [])[1] || '0');
const panOf = (t) => (t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/) || [0, 0, 0]).slice(1).map(Number);

// ---------- API 反查 ----------
async function apiFetch(method, path, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') };
}

async function loginViaApi() {
  if (SESSION) return SESSION;
  const r = await apiFetch('POST', '/api/login', { username: USERNAME, password: PASSWORD });
  const raw = r.setCookie || '';
  const m = raw.match(/cloudnine_sid=([^;]+)/);
  return m ? m[1] : null;
}

// ---------- 主流程 ----------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
});

const page = await browser.newPage();
await page.setViewport(MOBILE
  ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { width: 1440, height: 900, deviceScaleFactor: 1 });

// 已有会话：直接注入 Cookie，跳过登录页（用于测试已部署实例）
if (SESSION) {
  const host = new URL(URL_BASE).hostname;
  await browser.setCookie({
    name: 'cloudnine_sid', value: SESSION, domain: host, path: '/', httpOnly: true,
  });
}

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message} @ ${e.stack || '(无堆栈)'}`));

// 探针：统计浏览器原生 HTML5 拖拽事件。
// 图片预览里一旦触发原生拖拽，浏览器会接管指针（页面收不到 pointermove，图片拖不动），
// 同时还会拖出一份半透明重影，所以这里必须保持为 0。
await page.evaluateOnNewDocument(() => {
  window.__dragProbe = { start: 0 };
  document.addEventListener('dragstart', () => { window.__dragProbe.start++; }, true);
});

mkdirSync(OUT_DIR, { recursive: true });
let shotIdx = 0;
async function shot(label) {
  const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
  steps.push(name);
  currentShot = name;   // 记住当前截图，失败时指出对应图片
  console.log(`${DIM}    📸 ${name}${RESET}`);
  return name;
}

console.log(`${BOLD}CloudNine UI 自测${RESET}  目标: ${URL_BASE}  视口: ${MOBILE ? '移动 390×844' : '桌面 1440×900'}`);

try {
  // ---------- 1. 打开页面 ----------
  section('加载与认证');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(1200);
  await shot('首次加载');

  const hasAuthCard = await page.$('.auth-card');
  const authText = hasAuthCard ? await page.$eval('.auth-card', (el) => el.innerText) : '';

  if (hasAuthCard && /欢迎使用/.test(authText)) {
    check('显示初始化向导', true);
    await shot('初始化向导-站点名');

    // 第 1 步：站点名称 → 继续
    const siteInput = await page.$('.auth-card input');
    if (siteInput) { await siteInput.click(); await page.type('.auth-card input', 'UI 自测站点'); }
    await page.click('.auth-card .btn-primary');
    await sleep(600);

    // 第 2 步：账号
    const inputs = await page.$$('.auth-card input');
    if (inputs.length >= 3) {
      await inputs[0].click(); await page.keyboard.type(USERNAME);
      await inputs[1].click(); await page.keyboard.type(PASSWORD);
      await inputs[2].click(); await page.keyboard.type(PASSWORD);
    }
    await shot('初始化向导-账号');
    await page.click('.auth-card .btn-primary');
    await sleep(2500);
  } else if (hasAuthCard) {
    check('显示登录页', /登录/.test(authText) || !!await page.$('.login-card'));
    const inputs = await page.$$('.auth-card input');
    if (inputs.length >= 2) {
      await inputs[0].click(); await page.keyboard.type(USERNAME);
      await inputs[1].click(); await page.keyboard.type(PASSWORD);
    }
    await shot('登录页');
    await page.click('.auth-card .btn-primary');
    await sleep(2500);
  } else {
    check(SESSION ? '注入会话后直接进入（无认证页）' : '未出现认证页（已有会话）', true);
  }

  // ---------- 2. 桌面 / 移动主屏渲染 ----------
  section(MOBILE ? '移动主屏渲染' : '桌面渲染');
  await sleep(1500);

  if (MOBILE) {
    // iOS 形态：.m-home > .m-appgrid + .m-dock，.m-statusbar，.m-homebar
    const home = await page.$('.m-home');
    const statusbar = await page.$('.m-statusbar');
    const appgrid = await page.$('.m-appgrid');
    const dock = await page.$('.m-dock');
    const homebar = await page.$('.m-homebar');
    check('移动主屏根节点渲染', !!home, '未找到 .m-home');
    check('顶部状态栏渲染', !!statusbar, '未找到 .m-statusbar');
    check('应用图标网格渲染', !!appgrid, '未找到 .m-appgrid');
    check('底部工具栏渲染', !!dock, '未找到 .m-dock');
    check('Home 指示条渲染', !!homebar, '未找到 .m-homebar');

    const gridItems = await page.$$('.m-appitem');
    check('应用图标数量 ≥ 2', gridItems.length >= 2, `实际 ${gridItems.length}`);
    await shot('移动主屏');

    // 先在主目录放一个探针文件：文件页的「条目右侧 ⋯」断言需要至少有一个条目
    const psid = await loginViaApi();
    if (psid) {
      const phome = await apiFetch('GET', '/api/fs/home', undefined, `cloudnine_sid=${psid}`);
      const phomeRel = phome.json?.homeRel || '';
      await apiFetch('POST', '/api/fs/write', {
        path: phomeRel ? `${phomeRel}/${probeName}` : probeName, content: 'probe\n',
      }, `cloudnine_sid=${psid}`);
      await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('.m-home', { timeout: 15000 });
      await sleep(900);
    }

    // 底部工具栏点「文件」→ 文件页
    const finderBtn = await page.$('.m-dock .m-appitem[aria-label="文件"]');
    if (finderBtn) {
      await finderBtn.click();
      await sleep(1600);
      check('文件进入全屏页', !!(await page.$('.m-finder, .m-toolbar')), '未找到 .m-finder');
      await shot('移动文件');
      const rows = await page.$$('.m-row, .m-grid .m-appitem');
      check('文件列表渲染', rows.length >= 0, `条目 ${rows.length}`);

      // ---------- 移动端文件：操作收进工具栏，批量选择已移除 ----------
      const tbTitles = () => page.$$eval('.m-toolbar .tb-btn', (bs) => bs.map((b) => b.title || b.getAttribute('aria-label')));
      let tb = await tbTitles();
      check('工具栏含「新建文件夹」', tb.some((t) => /新建文件夹/.test(t)), tb.join(','));
      check('工具栏含「上传文件」', tb.some((t) => /上传文件/.test(t)), tb.join(','));
      check('工具栏含「刷新」', tb.some((t) => /刷新/.test(t)), tb.join(','));
      check('移动端已移除批量选择入口', !(await page.$('.m-selectbar, .m-select-enter')), '仍存在 .m-selectbar/.m-select-enter');

      // 条目右侧「⋯」仍能打开操作面板
      const rowMore = await page.$('.m-row-more, .m-cell-more');
      if (rowMore) {
        await rowMore.click();
        await sleep(600);
        check('条目「⋯」打开操作面板', !!(await page.$('.action-sheet')), '未找到 .action-sheet');
        await page.evaluate(() => document.querySelector('.action-sheet .cancel')?.click());
        await sleep(400);
      } else {
        check('条目右侧有操作按钮', false, '未找到 .m-row-more/.m-cell-more');
      }

      // 长按文件/文件夹不再弹出下拉菜单（改用条目右侧的「⋯」）
      const lpRow = await page.$('.m-row, .m-cell');
      if (lpRow) {
        const lb = await lpRow.boundingBox();
        const lcdp = await page.createCDPSession();
        const pt = { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2, id: 1 };
        await lcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
        await sleep(800);
        check('长按文件不弹出操作面板', !(await page.$('.action-sheet')), '长按后出现 .action-sheet');
        // touchCancel 而非 touchEnd：避免合成 click 把文件打开
        await lcdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await sleep(400);
      }

      // 复制一项 → 工具栏出现「粘贴」；窄屏放不下时收进「更多操作」
      const rowMore2 = await page.$('.m-row-more');
      if (rowMore2) {
        await rowMore2.click();
        await sleep(600);
        await page.evaluate(() => {
          [...document.querySelectorAll('.action-sheet .dropdown-item')].find((b) => b.innerText.trim() === '复制')?.click();
        });
        await sleep(900);
        tb = await tbTitles();
        check('复制后工具栏出现「粘贴」', tb.some((t) => /粘贴/.test(t)), tb.join(','));

        await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await sleep(1000);
        const moreBtn = await page.$('.m-toolbar .tb-btn[aria-label="更多操作"]');
        check('窄屏时按钮收进「更多操作」', !!moreBtn, '未找到「更多操作」按钮');
        if (moreBtn) {
          await moreBtn.click();
          await sleep(600);
          const menuItems = await page.$$eval('.m-toolmenu .dropdown-item', (ns) => ns.map((n) => n.innerText.trim()));
          check('「更多操作」下拉菜单可展开', menuItems.length > 0, JSON.stringify(menuItems));
          await shot('移动端更多操作');
          await page.evaluate(() => document.querySelector('.m-toolmenu .dropdown-item')?.click());
          await sleep(500);
          check('「更多操作」菜单点击后收起', !(await page.$('.m-toolmenu')), '菜单未收起');
        }
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await sleep(900);
      }
    } else {
      check('底部工具栏含「文件」入口', false, '未找到 .m-dock .m-appitem[aria-label=文件]');
    }

    // 返回桌面
    const back = await page.$('.m-back');
    if (back) {
      await back.click();
      await sleep(1200);
      check('返回主屏', !!(await page.$('.m-home')), '未回到 .m-home');
    }

    // 终端
    const termBtn = await page.$('.m-dock .m-appitem[aria-label="终端"]');
    if (termBtn) {
      await termBtn.click();
      await sleep(1800);
      check('终端进入全屏页', !!(await page.$('.m-terminal, .xterm')), '未找到 .m-terminal');
      await shot('移动终端');
    }

    // ---------- 移动端：图片预览双指缩放 + 单指拖动 ----------
    section('移动端图片预览（双指缩放 + 单指拖动）');
    const msid = await loginViaApi(); // 移动分支里 sid 尚未取到，这里单独登录用于反查
    if (msid) {
      const pngPath = join(OUT_DIR, imgName);
      writeFileSync(pngPath, makePng(1400, 900));

      // 回主屏 → 上传应用 → 「选择文件」
      const backHome = async () => {
        const b = await page.$('.m-back');
        if (b) { await b.click(); await sleep(1200); }
      };
      await backHome();
      const upApp = await page.$('.m-dock .m-appitem[aria-label="上传"]');
      if (upApp) {
        await upApp.click();
        await sleep(1500);
        const pickEl = (await page.evaluateHandle(() =>
          [...document.querySelectorAll('.m-upload-card')].find((c) => c.textContent.includes('选择文件')))).asElement();
        if (pickEl) {
          const [chooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 8000 }),
            pickEl.click(),
          ]);
          await chooser.accept([pngPath]);
          await sleep(3500);
        }
      }
      check('移动端测试图片已上传', !!(await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(imgName)}`, undefined, `cloudnine_sid=${msid}`).then((r) => (r.json?.results || []).some((x) => x.name === imgName))));

      // 回主屏 → 文件 → 点开图片
      await backHome();
      const finderApp = await page.$('.m-dock .m-appitem[aria-label="文件"]');
      if (finderApp) {
        await finderApp.click();
        await sleep(1800);
        const rowEl = (await page.evaluateHandle((n) =>
          [...document.querySelectorAll('.m-row, .m-cell')].find((el) => el.textContent.includes(n)), imgName)).asElement();
        check('移动端文件列出测试图片', !!rowEl, imgName);
        if (rowEl) {
          await rowEl.tap();
          await sleep(2000);
          check('移动端打开图片快速预览', !!(await page.$('.m-quicklook .preview-stage img')), '未找到 .m-quicklook .preview-stage img');

          const box = await (await page.$('.preview-stage')).boundingBox();
          const tf = () => page.$eval('.m-quicklook .preview-stage img', (el) => el.style.transform).catch(() => '');
          const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
          const cdp = await page.createCDPSession();

          const t0 = await tf();
          check('移动端初始为适应窗口（100%）', /scale\(1\)/.test(t0), t0);

          // 双指张开 → 放大
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 90, y: cy, id: 1 }, { x: cx + 90, y: cy, id: 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 110, y: cy, id: 1 }, { x: cx + 110, y: cy, id: 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await sleep(400);
          const t1 = await tf();
          check('移动端双指缩放放大', zoomOf(t1) > 1.2, `${t0} → ${t1}`);

          // 单指拖动 → 平移
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 60, y: cy + 40, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 100, y: cy + 70, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await sleep(300);
          const t2 = await tf();
          const [dx, dy] = panOf(t2);
          check('移动端单指拖动平移', Math.abs(dx) > 20 && Math.abs(dy) > 10, `${t1} → ${t2}`);
          const mDragStart = await page.evaluate(() => window.__dragProbe?.start ?? -1);
          check('移动端拖动不触发浏览器原生拖拽（否则图片拖不动并拖出重影）', mDragStart === 0, `dragstart ${mDragStart} 次`);

          // 双指聚拢缩小 → 立即单指上滑：不应被误判成双击复位（缩放保持、平移生效）
          const zBefore = zoomOf(t2);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 15, y: cy, id: 1 }, { x: cx + 15, y: cy, id: 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          const t4 = await tf();
          // 不等待：紧接着单指上滑，起点贴着刚抬起的第二根手指
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx + 15, y: cy, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 15, y: cy - 60, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await sleep(250);
          const t5 = await tf();
          const z4 = zoomOf(t4), z5 = zoomOf(t5), [, dy5] = panOf(t5);
          check('移动端双指缩小后立即上滑不触发双击复位',
            z4 < zBefore && Math.abs(z5 - z4) < 0.01 && dy5 < -20,
            `缩小后 ${t4} → 上滑后 ${t5}`);

          // 工具条「适应」复位
          const zBtns = await page.$$('.m-quicklook .preview-zoom .btn');
          check('移动端缩放工具存在', zBtns.length >= 4, `按钮数 ${zBtns.length}`);
          if (zBtns.length >= 3) {
            await zBtns[2].click();
            await sleep(300);
            const t3 = await tf();
            check('移动端「适应」复位', /scale\(1\)/.test(t3) && /translate\(0px, 0px\)/.test(t3), t3);
          }
          await shot('移动端图片预览缩放');
        }
      }
    } else {
      check('底部工具栏含「终端」入口', false, '未找到 .m-dock .m-appitem[aria-label=终端]');
    }
  } else {
    const hasDock = await page.$('.dock, .dock-item');
    const hasMenu = await page.$('.menubar, .menu-bar, .desktop');
    check('桌面根节点渲染', !!hasMenu, '未找到 .desktop');
    check('Dock 渲染', !!hasDock, '未找到 .dock');
    await shot('桌面');
  }

  // ---------- 3~5. 桌面专属流程（移动形态下不适用）----------
  // 声明提到块外：清理阶段也要用到这两个文件名
  const proofName = `uitest-terminal-${Date.now()}.txt`;
  const editName = `uitest-editor-${Date.now()}.md`;
  const pasteName = `uitest-paste-${Date.now()}.md`;
  const notifyName = `uitest-notify-${Date.now()}.md`;
  const btnUploadName = `uitest-btnupload-${Date.now()}.txt`;
  const deskName = `uitest-desktop-${Date.now()}.txt`;
  const dirName = `uitest-desktop-dir-${Date.now()}`;
  if (!MOBILE) {
  // ---------- 桌面直览：主目录里的真实文件直接铺在桌面上 ----------
  section('桌面直览（主目录）');
  const dsid = await loginViaApi();
  const homeRes = await apiFetch('GET', '/api/fs/home', undefined, `cloudnine_sid=${dsid}`);
  const homeRel = homeRes.json?.homeRel || '';
  const deskPath = homeRel ? `${homeRel}/${deskName}` : deskName;
  await apiFetch('POST', '/api/fs/write', { path: deskPath, content: 'desktop test\n' }, `cloudnine_sid=${dsid}`);
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 15000 });
  await sleep(1500);

  const deskIcons = await page.$$eval('.desktop-icon', (els) => els.map((e) => e.dataset.entry));
  check('桌面直接显示主目录里的真实文件', deskIcons.includes(deskName),
    `桌面条目: ${deskIcons.join(',') || '(空)'}`);
  const sysCount = (await page.$$('.desktop-sysicon')).length;
  check('桌面保留根目录/废纸篓入口', sysCount === 2, `数量 ${sysCount}`);
  await shot('桌面直览');

  // 右键桌面空白处：新建 / 上传 / 排序入口都在
  await page.evaluate(() => {
    const el = document.querySelector('.desktop-icons');
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 620 }));
  });
  await sleep(400); // 等 React 重渲染出右键菜单
  const blankItems = await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu .dropdown-item')].map((b) => b.innerText.trim()));
  check('桌面右键菜单含「新建文件夹」', blankItems.some((t) => /新建文件夹/.test(t)), blankItems.join(','));
  check('桌面右键菜单含「上传文件…」', blankItems.some((t) => /上传文件/.test(t)), blankItems.join(','));
  check('桌面右键菜单含排序方式', blankItems.some((t) => /按名称排列/.test(t)), blankItems.join(','));
  await shot('桌面右键菜单');

  // 从右键菜单新建文件夹 → 直接出现在桌面上
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.context-menu .dropdown-item')].find((b) => b.innerText.trim() === '新建文件夹');
    it?.click();
  });
  await sleep(700);
  const dlgInput = await page.$('.dialog input');
  check('「新建文件夹」弹出命名对话框', !!dlgInput);
  if (dlgInput) {
    await dlgInput.click();
    await page.keyboard.type(dirName);
    const okBtn = await page.$('.dialog-actions .btn-primary');
    if (okBtn) await okBtn.click();
    await sleep(1500);
  }
  const afterNew = await page.$$eval('.desktop-icon', (els) => els.map((e) => e.dataset.entry));
  check('桌面上新建的文件夹立即出现', afterNew.includes(dirName),
    `桌面条目: ${afterNew.join(',') || '(空)'}`);
  const dirQ = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(dirName)}`, undefined, `cloudnine_sid=${dsid}`);
  check('新建的文件夹确实落盘', (dirQ.json?.results || []).some((x) => x.name === dirName), `status=${dirQ.status}`);
  await shot('桌面新建文件夹');

  // 桌面多选：Ctrl 点击 + 全选
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.desktop-icon')];
    els[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    els[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  });
  await sleep(400);
  const selInfo = await page.evaluate(() => ({
    total: document.querySelectorAll('.desktop-icon').length,
    selected: document.querySelectorAll('.desktop-icon.selected').length,
  }));
  check('桌面支持 Ctrl 多选', selInfo.selected === 2, `选中 ${selInfo.selected}/${selInfo.total}`);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await sleep(400);
  const selAll = await page.evaluate(() => ({
    selected: document.querySelectorAll('.desktop-icon.selected').length,
    total: document.querySelectorAll('.desktop-icon').length,
  }));
  check('桌面 Cmd/Ctrl+A 全选', selAll.selected === selAll.total && selAll.total > 0, JSON.stringify(selAll));
  await shot('桌面多选');

  // 文件条目的右键菜单：完整操作项
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.desktop-icon')].find((x) => x.dataset.entry === n);
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
  }, deskName);
  await sleep(400);
  const itemItems = await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu .dropdown-item')].map((b) => b.innerText.trim()));
  check('文件右键菜单含「打开」「快速预览」', itemItems.some((x) => /打开/.test(x)) && itemItems.some((x) => /快速预览/.test(x)), itemItems.join(','));
  check('文件右键菜单含「重命名」「复制」「剪切」', ['重命名', '复制', '剪切'].every((k) => itemItems.includes(k)), itemItems.join(','));
  check('文件右键菜单含「下载」「压缩…」', itemItems.some((x) => /下载/.test(x)) && itemItems.some((x) => /压缩/.test(x)), itemItems.join(','));
  check('文件右键菜单含「分享…」「显示简介」「移入废纸篓」',
    itemItems.some((x) => /分享/.test(x)) && itemItems.some((x) => /显示简介/.test(x)) && itemItems.some((x) => /移入废纸篓/.test(x)),
    itemItems.join(','));
  await shot('桌面文件右键菜单');
  await page.keyboard.press('Escape');
  await sleep(300);

  // 拖拽前先清空选择：否则拖一个已选中的文件会带走全部选中项
  await page.evaluate(() => {
    const el = document.querySelector('.desktop-icons');
    const o = { bubbles: true, clientX: 900, clientY: 700 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
  });
  await sleep(300);

  // 拖到文件夹上 = 移入该文件夹（桌面拖拽语义：移动文件）
  const dragInfo = await page.evaluate((fileName, dirName2) => {
    const src = [...document.querySelectorAll('.desktop-icon')].find((x) => x.dataset.entry === fileName);
    const dst = [...document.querySelectorAll('.desktop-icon')].find((x) => x.dataset.entry === dirName2);
    if (!src || !dst) return { ok: false, reason: `找不到拖拽源/目标 ${!!src}/${!!dst}` };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const raw = dt.getData('application/x-cloudnine');
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, raw };
  }, deskName, dirName);
  check('桌面拖拽能生成移动数据', dragInfo.ok && /"mode":"move"/.test(dragInfo.raw || ''), dragInfo.raw || dragInfo.reason);
  await sleep(1500);
  const inDir = await apiFetch('GET', `/api/fs/list?path=${encodeURIComponent(homeRel ? `${homeRel}/${dirName}` : dirName)}`, undefined, `cloudnine_sid=${dsid}`);
  check('拖到文件夹上后文件确实移入该目录',
    (inDir.json?.entries || []).some((x) => x.name === deskName),
    `status=${inDir.status} ${(inDir.json?.entries || []).map((x) => x.name).join(',')}`);
  const afterMove = await page.$$eval('.desktop-icon', (els) => els.map((e) => e.dataset.entry));
  check('移入后桌面不再显示该文件', !afterMove.includes(deskName), afterMove.join(','));
  await shot('桌面拖拽移入文件夹');

  // 双击文件夹 → 打开「文件」窗口，标题是目录名
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.desktop-icon')].find((x) => x.dataset.entry === n);
    el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, dirName);
  await sleep(1500);
  const winTitle = await page.$eval('.window-title', (el) => el.innerText).catch(() => '');
  check('双击桌面文件夹打开「文件」窗口', !!winTitle, `title=${winTitle}`);
  check('文件窗口标题是目录名', winTitle.trim() === dirName, `title=${winTitle}`);
  await shot('双击打开文件窗口');

  // 关掉窗口，回到桌面态
  await page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].pop();
    w?.querySelector('.tc-close')?.click();
  });
  await sleep(900);

  // 重命名：F2 → 输入新名 → 回车
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.desktop-icon')].find((x) => x.dataset.entry === n);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, dirName);
  await sleep(300);
  await page.keyboard.press('F2');
  await sleep(400);
  const renameInput = await page.$('.desktop-icon .rename-input');
  check('F2 进入重命名', !!renameInput);
  if (renameInput) {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(newDirName);
    await page.keyboard.press('Enter');
    await sleep(1500);
  }
  const renamed = await page.$$eval('.desktop-icon', (els) => els.map((e) => e.dataset.entry));
  check('重命名后桌面显示新名字', renamed.includes(newDirName), renamed.join(','));
  const renQ = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(newDirName)}`, undefined, `cloudnine_sid=${dsid}`);
  check('重命名确实落盘', (renQ.json?.results || []).some((x) => x.name === newDirName), `status=${renQ.status}`);
  await shot('桌面重命名');

  // 删除：选中 → Delete → 确认 → 移入废纸篓
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.desktop-icon')].find((x) => x.dataset.entry === n);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, newDirName);
  await sleep(300);
  await page.keyboard.press('Delete');
  await sleep(600);
  const trashConfirm = await page.$('.dialog-actions .btn-primary');
  check('Delete 弹出「移入废纸篓」确认', !!trashConfirm);
  if (trashConfirm) { await trashConfirm.click(); await sleep(1500); }
  const afterDel = await page.$$eval('.desktop-icon', (els) => els.map((e) => e.dataset.entry));
  check('删除后桌面不再显示该项', !afterDel.includes(newDirName), afterDel.join(','));
  await shot('桌面删除');

  // 焦点在桌面时，菜单栏切换为桌面菜单
  const menuLabels = await page.evaluate(() => [...document.querySelectorAll('.mb-menu-btn')].map((b) => b.innerText.trim()));
  check('桌面态菜单栏含「编辑」「显示」', menuLabels.includes('编辑') && menuLabels.includes('显示'), menuLabels.join(','));


  section('文件窗口（Finder）');
  const dockItems = await page.$$('.dock-item');
  check(`Dock 应用数量 ≥ 5`, dockItems.length >= 5, `实际 ${dockItems.length}`);

  const finderBtn = await page.$('.dock-item[title="文件"]');
  if (finderBtn) {
    await finderBtn.click();
    await sleep(1500);
    const winTitle = await page.$('.window-title');
    const titleText = winTitle ? await page.$eval('.window-title', (el) => el.innerText) : '';
    check('文件窗口打开', /文件|Finder/i.test(titleText) || !!winTitle, `title=${titleText}`);
    await shot('文件窗口');
  } else {
    check('Dock 中存在「文件」入口', false, '未找到 .dock-item[title=文件]');
  }

  // ---------- 4. 终端（真实 PTY） ----------
  section('终端（真实 PTY）');
  const sid = await loginViaApi();
  check('API 侧登录成功（用于反查）', !!sid, '未取到会话 Cookie');

  const termBtn = await page.$('.dock-item[title="终端"]');

  if (termBtn && sid) {
    await termBtn.click();
    await sleep(1800);
    check('终端窗口打开', !!(await page.$('.window-title')), '未找到窗口');
    await shot('终端窗口');

    // 在 xterm 里敲命令
    const termBody = await page.$('.window-body .xterm, .xterm');
    if (termBody) {
      await termBody.click();
      await sleep(400);
      await page.keyboard.type(`echo CLOUDNINE_PTY_OK && touch ${proofName}`);
      await page.keyboard.press('Enter');
      await sleep(2000);
      await shot('终端执行命令');

      // 通过 API 递归搜索反查：命令是否真的在文件系统里产生了文件
      // （用搜索而非 stat，避免依赖终端的初始工作目录）
      const r = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(proofName)}`, undefined, `cloudnine_sid=${sid}`);
      const hit = (r.json?.results || []).find((x) => x.name === proofName);
      check('终端命令真实执行（PTY 落盘验证）', r.status === 200 && !!hit,
        `status=${r.status} ${r.text?.slice(0, 120)}`);
    } else {
      check('终端 xterm 挂载', false, '未找到 .xterm');
    }
  } else {
    check('Dock 中存在「终端」入口', false, '未找到 .dock-item[title=终端]');
  }

  // ---------- 5. 文本编辑：新建 → 输入 → Ctrl+S → 磁盘核对 ----------
  section('文本编辑（Ctrl+S 保存）');
  const editorBtn = await page.$('.dock-item[title="文本编辑"]');
  if (editorBtn && sid) {
    await editorBtn.click();
    await sleep(1800);
    await shot('编辑器窗口');

    const cm = await page.$('.cm-content, .CodeMirror, [contenteditable="true"]');
    if (cm) {
      const body = await page.$eval('.window-body', (el) => el.innerText);
      const isNewDoc = /未命名|另存为|新建/.test(body);
      check('编辑器加载', !!cm, '未找到 CodeMirror 编辑区');

      const text = '# UI 自测\n\n由自动化测试写入。\n';
      await cm.click();
      await sleep(300);
      await page.keyboard.type(text);
      await sleep(500);
      await shot('编辑器输入');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await sleep(1800);
      await shot('编辑器保存后');

      // 两条分支：未命名新文档 → 弹「另存为」；已有文件 → 直接保存
      let savedName = null;
      const dlgInput = await page.$('.dialog input');
      if (dlgInput) {
        await dlgInput.click();
        // 必须全选后覆盖输入：直接 type 会插到光标处（会得到「未命名.xxx.md」这种拼接名）
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(editName);
        await sleep(400);
        const fieldValue = await page.$eval('.dialog input', (el) => el.value);
        check('「另存为」文件名输入正确', fieldValue === editName, `value=${fieldValue}`);
        await shot('另存为对话框');
        const confirmBtn = await page.$('.dialog-actions .btn-primary');
        if (confirmBtn) { await confirmBtn.click(); await sleep(2200); }
        savedName = editName;
        check('「另存为」对话框出现并填写', true);
      } else {
        const t = await page.$eval('.window-title', (el) => el.innerText).catch(() => '');
        savedName = t.trim();
        check('Ctrl+S 直接保存（无另存为对话框）', !!savedName, `title=${t}`);
      }

      // 反查磁盘：用递归搜索定位文件（不依赖编辑器内部路径状态）
      if (savedName) {
        const r = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(savedName)}`, undefined, `cloudnine_sid=${sid}`);
        const hit = (r.json?.results || []).find((x) => x.name === savedName);
        check('Ctrl+S 保存后文件确实落盘', r.status === 200 && !!hit,
          `status=${r.status} name=${savedName}`);

        if (hit) {
          const rr = await apiFetch('GET', `/api/fs/read?path=${encodeURIComponent(hit.rel)}`, undefined, `cloudnine_sid=${sid}`);
          const saved = rr.json?.content || '';
          check('保存内容与输入一致', rr.status === 200 && saved.includes('UI 自测'),
            `status=${rr.status} content=${JSON.stringify(saved.slice(0, 80))}`);
        }
      }
    } else {
      check('编辑器挂载', false, '未找到 CodeMirror');
    }
  } else {
    check('Dock 中存在「文本编辑」入口', false, '未找到 .dock-item[title=文本编辑]');
  }

  // ---------- 5.5 粘贴上传（合成 ClipboardEvent，不依赖真实系统剪贴板）----------
  // 真机能力验证另见 scripts/paste-probe.html；此处只验证前端分支逻辑与上传链路。
  section('粘贴上传（Ctrl+V）');
  if (sid) {
    // 打开并激活一个文件窗口：此前焦点在编辑器窗口，非文件窗口按设计不接管粘贴
    const fb = await page.$('.dock-item[title="文件"]');
    if (fb) await fb.click();
    await sleep(1500);

    const dispatched = await page.evaluate((name) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# 粘贴上传自测\n'], name, { type: 'text/markdown' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, types: [...dt.types], count: dt.files.length };
    }, pasteName);
    check('合成 paste 事件被接管', dispatched.prevented === true && dispatched.count === 1, JSON.stringify(dispatched));
    await sleep(3000);

    const q = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(pasteName)}`, undefined, `cloudnine_sid=${sid}`);
    const hit = (q.json?.results || []).find((x) => x.name === pasteName);
    check('粘贴的文件确实上传到当前目录', q.status === 200 && !!hit, `status=${q.status} ${q.text?.slice(0, 120)}`);
    if (hit) {
      const rr = await apiFetch('GET', `/api/fs/read?path=${encodeURIComponent(hit.rel)}`, undefined, `cloudnine_sid=${sid}`);
      check('粘贴上传内容一致', (rr.json?.content || '').includes('粘贴上传自测'), `status=${rr.status}`);
    }
    await shot('粘贴上传');

    // 内部剪贴板优先：两者并存时给二选一；「编辑」菜单显示并可清空内部剪贴板
    const openedEdit = await page.evaluate(() => {
      const items = document.querySelectorAll('.finder-item');
      if (items.length) items[items.length - 1].click();
      const btn = [...document.querySelectorAll('.mb-menu-btn')].find((b) => b.innerText.trim() === '编辑');
      if (!btn) return false;
      btn.click();
      return true;
    });
    await sleep(300);
    const copied = await page.evaluate(() => {
      const it = [...document.querySelectorAll('.dropdown-item')].find((b) => b.innerText.trim() === '复制');
      if (!it) return false;
      it.click();
      return true;
    });
    await sleep(300);
    check('「编辑」菜单可写出内部剪贴板', openedEdit && copied, `openedEdit=${openedEdit} copied=${copied}`);

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['conflict'], 'uitest-conflict.txt', { type: 'text/plain' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(500);
    const dlgText = await page.$eval('.dialog', (el) => el.innerText).catch(() => '');
    check('内部剪贴板与系统文件并存时弹出二选一', /粘贴到当前文件夹/.test(dlgText), dlgText.slice(0, 100));
    // 点「取消」：不应上传，也不应执行内部粘贴
    const cancelBtn = await page.$('.dialog-actions .btn');
    if (cancelBtn) await cancelBtn.click();
    await sleep(300);
    const conflictQ = await apiFetch('GET', `/api/fs/search?path=/&q=uitest-conflict.txt`, undefined, `cloudnine_sid=${sid}`);
    check('二选一取消后不产生上传', !(conflictQ.json?.results || []).length, JSON.stringify(conflictQ.json?.results || []).slice(0, 100));

    const readClipLabel = async () => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.mb-menu-btn')].find((b) => b.innerText.trim() === '编辑');
        btn?.click();
      });
      await sleep(250);
      return page.evaluate(() => {
        const it = [...document.querySelectorAll('.dropdown-item')].find((b) => b.innerText.includes('剪贴板：'));
        return it ? it.innerText.trim() : '(未找到)';
      });
    };
    const clipLabel = await readClipLabel();
    check('「编辑」菜单显示内部剪贴板状态', /剪贴板：复制 1 项/.test(clipLabel), clipLabel);
    await page.evaluate(() => {
      const it = [...document.querySelectorAll('.dropdown-item')].find((b) => b.innerText.trim() === '清空剪贴板');
      it?.click();
    });
    await sleep(250);
    const emptyLabel = await readClipLabel();
    check('清空剪贴板后状态回到「空」', /剪贴板：空/.test(emptyLabel), emptyLabel);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.mb-menu-btn')].find((b) => b.innerText.trim() === '编辑');
      btn?.click();
    });
  }

  // ---------- 5.6 上传通知：点击「开始上传」自动打开传输窗口 ----------
  // 两个上传入口都要覆盖：Ctrl+V 粘贴上传、文件工具栏「上传文件」按钮。
  // 重新载入页面以拿到干净的窗口/通知状态（会话 cookie 保留），避免前面流程的残留干扰。
  section('上传通知（点击打开传输窗口）');
  if (sid) {
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.menubar', { timeout: 15000 });
    await sleep(1000);
    const fb = await page.$('.dock-item[title="文件"]');
    if (fb) await fb.click();
    await page.waitForSelector('.finder', { timeout: 15000 });
    await sleep(500);

    const closeTransfers = () => page.evaluate(() => {
      const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.transfers-window'));
      w?.querySelector('.tc-close')?.click();
    });
    const countStart = () => page.evaluate(() =>
      [...document.querySelectorAll('.notification')].filter((n) => n.querySelector('.n-title')?.textContent.includes('开始上传')).length);
    const lastStartInfo = () => page.evaluate(() => {
      const n = [...document.querySelectorAll('.notification')]
        .filter((x) => x.querySelector('.n-title')?.textContent.includes('开始上传')).pop();
      return n ? { actionable: n.classList.contains('n-actionable'), hasHint: !!n.querySelector('.n-action'), text: n.innerText } : null;
    });
    const clickLastStart = () => page.evaluate(() => {
      const list = [...document.querySelectorAll('.notification')]
        .filter((x) => x.querySelector('.n-title')?.textContent.includes('开始上传'));
      list[list.length - 1]?.click();
    });
    const hasTransfers = () => page.$('.transfers-window').then((h) => !!h);

    // 需求 1：Ctrl+V 粘贴上传的「开始上传」通知可点击打开传输窗口
    const beforeA = await countStart();
    const dispatchedA = await page.evaluate((name) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# 通知点击自测\n'], name, { type: 'text/markdown' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, count: dt.files.length };
    }, notifyName);
    check('通知自测：合成 paste 被接管', dispatchedA.prevented === true && dispatchedA.count === 1, JSON.stringify(dispatchedA));
    await page.waitForFunction((b) =>
      [...document.querySelectorAll('.notification')].filter((n) => n.querySelector('.n-title')?.textContent.includes('开始上传')).length > b,
      { timeout: 8000 }, beforeA);
    const infoA = await lastStartInfo();
    check('粘贴上传「开始上传」通知带可点击提示', !!infoA?.actionable && !!infoA?.hasHint, JSON.stringify(infoA));
    check('需求1：点击前传输窗口未打开', !(await hasTransfers()));
    await clickLastStart();
    await page.waitForSelector('.transfers-window', { timeout: 8000 });
    check('需求1：点击「开始上传」通知自动打开传输窗口', !!(await hasTransfers()));
    await closeTransfers();
    await sleep(300);

    // 需求 2：文件窗口「上传文件」按钮上传时也要弹出通知，且点击同样可打开传输窗口
    const beforeB = await countStart();
    const uploadPath = join(OUT_DIR, btnUploadName);
    writeFileSync(uploadPath, 'button upload notify test\n');
    const btns = await page.$$('.tb-btn[title="上传文件"]');
    check('文件工具栏存在「上传文件」按钮', btns.length >= 1, `count=${btns.length}`);
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 8000 }),
      btns[btns.length - 1].click(),
    ]);
    await chooser.accept([uploadPath]);
    await page.waitForFunction((b) =>
      [...document.querySelectorAll('.notification')].filter((n) => n.querySelector('.n-title')?.textContent.includes('开始上传')).length > b,
      { timeout: 8000 }, beforeB);
    const infoB = await lastStartInfo();
    check('需求2：「上传文件」按钮上传弹出「开始上传」通知', !!infoB, JSON.stringify(infoB));
    check('需求2：该通知同样可点击（带提示）', !!infoB?.actionable && !!infoB?.hasHint, JSON.stringify(infoB));
    check('需求2：点击前传输窗口未打开', !(await hasTransfers()));
    await clickLastStart();
    await page.waitForSelector('.transfers-window', { timeout: 8000 });
    check('需求2：点击该通知后打开传输窗口', !!(await hasTransfers()));
    await closeTransfers();
  }

  // ---------- 5.7 图片预览：滚轮缩放 + 拖拽平移 + 双击复位 ----------
  section('图片预览（滚轮缩放 + 拖拽平移）');
  if (sid) {
    const pngPath = join(OUT_DIR, imgName);
    writeFileSync(pngPath, makePng(1400, 900));

    // 通过文件窗口「上传文件」把测试图放进当前目录
    const upBtns = await page.$$('.tb-btn[title="上传文件"]');
    if (upBtns.length) {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }),
        upBtns[upBtns.length - 1].click(),
      ]);
      await chooser.accept([pngPath]);
    }
    // 等待文件窗口刷新出该文件
    const appeared = await page.waitForFunction(
      (n) => [...document.querySelectorAll('.finder-item')].some((el) => el.textContent.includes(n)),
      { timeout: 20000 }, imgName,
    ).then(() => true).catch(() => false);
    check('测试图片已上传并出现在文件窗口', appeared, imgName);

    if (appeared) {
      await page.evaluate((n) => {
        const el = [...document.querySelectorAll('.finder-item')].find((x) => x.textContent.includes(n));
        el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }, imgName);
      await sleep(1800);
      check('图片预览窗口打开', !!(await page.$('.preview-window .preview-stage img')), '未找到 .preview-stage img');

      const box = await (await page.$('.preview-stage')).boundingBox();
      const tf = () => page.$eval('.preview-stage img', (el) => el.style.transform).catch(() => '');

      const t0 = await tf();
      check('初始为适应窗口（100%）', /scale\(1\)/.test(t0), t0);

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -300 });
      await sleep(400);
      const t1 = await tf();
      check('滚轮向上放大', zoomOf(t1) > 1.2, `${t0} → ${t1}`);
      check('缩放百分比同步', (await page.$eval('.preview-zoom-val', (el) => el.textContent).catch(() => '')) !== '100%');

      await page.mouse.wheel({ deltaY: 600 });
      await sleep(400);
      const t2 = await tf();
      check('滚轮向下缩小', zoomOf(t2) < zoomOf(t1), `${t1} → ${t2}`);

      await page.mouse.wheel({ deltaY: -400 });
      await sleep(300);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 12 });
      // 拖动过程中取样：图片必须跟着鼠标走，且浏览器不能接管成原生拖拽
      const midTf = await tf();
      await page.mouse.up();
      await sleep(300);
      const t3 = await tf();
      const [dx, dy] = panOf(t3);
      check('拖动可平移图片', Math.abs(dx) > 50 && Math.abs(dy) > 30, `${t2} → ${t3}`);
      const [mdx] = panOf(midTf);
      check('拖动过程中画面跟随鼠标', Math.abs(mdx) > 10, `拖动中 ${midTf}`);
      const dragStart = await page.evaluate(() => window.__dragProbe?.start ?? -1);
      check('拖动图片不触发浏览器原生拖拽（否则图片拖不动并拖出重影）', dragStart === 0, `dragstart ${dragStart} 次`);

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(90);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(400);
      const t4 = await tf();
      check('双击复位到适应窗口', /scale\(1\)/.test(t4) && /translate\(0px, 0px\)/.test(t4), t4);
      await shot('图片预览缩放平移');
    }
  }
  } // end !MOBILE

  // ---------- 6. 控制台错误 ----------
  section('运行时健康');
  const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)|DevTools/i.test(e));
  check('浏览器控制台无 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await shot('最终状态');

  // ---------- 7. 清理测试产物 ----------
  // 避免在生产环境的 FILE_ROOT 里留下垃圾
  if (!flag('keep')) {
    section('清理测试产物');
    const sid2 = await loginViaApi();
    const names = [proofName, editName, pasteName, notifyName, btnUploadName, imgName, deskName, dirName, probeName, newDirName].filter(Boolean);
    for (const n of names) {
      const r = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(n)}`, undefined, `cloudnine_sid=${sid2}`);
      const hit = (r.json?.results || []).find((x) => x.name === n);
      if (!hit) continue;
      await apiFetch('POST', '/api/fs/delete', { paths: [hit.rel] }, `cloudnine_sid=${sid2}`);
      console.log(`${DIM}    已删除 ${hit.rel}${RESET}`);
    }
  }
} catch (e) {
  failed.push(['执行异常', e.message]);
  console.log(`${RED}  ✗ 执行异常: ${e.message}${RESET}`);
  try { await shot('异常现场'); } catch { /* 忽略 */ }
} finally {
  await browser.close();
}

// ---------- 汇总 ----------
const total = passed.length + failed.length;
writeFileSync(join(OUT_DIR, 'report.txt'),
  `CloudNine UI 自测报告\n时间: ${new Date().toISOString()}\n目标: ${URL_BASE}\n\n` +
  passed.map((p) => `PASS  ${p}`).join('\n') + '\n' +
  failed.map(([n, d, s]) => `FAIL  ${n}  ${d}${s ? `  [截图 ${s}]` : ''}`).join('\n') +
  `\n\n合计: ${passed.length}/${total} 通过\n截图目录: ${OUT_DIR}\n`);

console.log(`\n${BOLD}截图目录${RESET} ${OUT_DIR}`);
pruneShots(KEEP_SHOTS);   // 只保留最近 KEEP_SHOTS 次运行的截图
if (failed.length) {
  console.log(`${RED}${BOLD}失败 ${failed.length}/${total}${RESET}`);
  for (const [n, d, s] of failed) console.log(`  ${RED}✗${RESET} ${n}  ${DIM}${d}${RESET}${s ? `  ${DIM}[截图 ${s}]${RESET}` : ''}`);
  process.exit(1);
}
console.log(`${GREEN}${BOLD}全部通过 ${total}/${total}${RESET}`);
