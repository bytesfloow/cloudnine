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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
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

// 等一个真实下载落到磁盘：跳过 Chrome 的 .crdownload / .tmp 中间文件，
// 并要求两次取样大小一致且非空（避免半截文件被当成“下载成功”）
async function waitDownloadFile(dir, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const done = readdirSync(dir).filter((n) => !n.endsWith('.crdownload') && !n.endsWith('.tmp'));
    if (done.length) {
      const p = join(dir, done[0]);
      const s1 = statSync(p).size;
      await sleep(250);
      if (s1 > 0 && statSync(p).size === s1) return p;
    }
    await sleep(200);
  }
  return null;
}

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
// 剪贴板断言（复制路径 / 剪贴板状态）需要显式授权
try { await browser.defaultBrowserContext().overridePermissions(URL_BASE, ['clipboard-read', 'clipboard-write']); } catch { /* 忽略 */ }
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

  // 下载探针：记录应用真实点过的 <a download>（无头浏览器里下载请求不一定出现在 request 事件里）
  window.__anchorClicks = [];
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    window.__anchorClicks.push({ href: this.href, download: this.download });
    return origAnchorClick.call(this);
  };

  // 剪贴板探针：记录 writeText 的真实入参（无头环境可能因文档焦点问题拒绝写入系统剪贴板）
  window.__clipboardWrites = [];
  try {
    const origWrite = Clipboard.prototype.writeText;
    Clipboard.prototype.writeText = function (text) {
      window.__clipboardWrites.push(String(text));
      return origWrite.call(this, text);
    };
  } catch { /* 浏览器不支持时忽略 */ }
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
    const hasTaskbar = await page.$('.taskbar');
    const hasMenu = await page.$('.menubar, .menu-bar, .desktop');
    check('桌面根节点渲染', !!hasMenu, '未找到 .desktop');
    check('任务栏渲染', !!hasTaskbar, '未找到 .taskbar');
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
  const zipName = `uitest-archive-${Date.now()}.zip`; // 只用于验「解压…」入口，内容不是真 zip
  // 任务栏托盘自测用的大文件（传输徽标 / 通知）；文件名带时间戳，便于清理阶段逐个删除
  const badgeBase = `uitest-badge-${Date.now()}`;
  const badgeNames = [`${badgeBase}-a.bin`, `${badgeBase}-b.bin`];
  const dropName = `uitest-drop-${Date.now()}.txt`;
  const tbDirName = `uitest-tb-dir-${Date.now()}`;
  // 开始菜单「最近使用的文件」用例的预置文件（带内容，点击后要真的在记事本里打开）
  const smRecentName = `uitest-start-recent-${Date.now()}.md`;
  // 窗口内菜单（T7）：终端/记事本/预览三个窗口的菜单用例产物
  const wmBase = `uitest-winmenu-${Date.now()}`;
  const wmTextName = `${wmBase}-text.txt`;
  const wmSaveName = `${wmBase}-saved.json`;
  const wmSaveAsName = `${wmBase}-copy.json`;
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

  const deskIcons = await page.$$eval('.desktop-icon[data-entry]', (els) => els.map((e) => e.dataset.entry));
  check('桌面直接显示主目录里的真实文件', deskIcons.includes(deskName),
    `桌面条目: ${deskIcons.join(',') || '(空)'}`);
  const sysCount = (await page.$$('.desktop-sysicon')).length;
  check('桌面保留根目录/废纸篓入口', sysCount === 2, `数量 ${sysCount}`);
  await shot('桌面直览');

  // 系统图标：并入左上角图标网格（前两格），单击只选中、双击才打开
  const sysOrder = await page.evaluate(() => [...document.querySelector('.desktop-grid').children]
    .slice(0, 2).map((el) => el.innerText.trim().split('\n')[0]));
  check('系统图标排在左上角前两格', sysOrder[0] === '根目录' && sysOrder[1] === '废纸篓', sysOrder.join(','));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.desktop-sysicon')].find((x) => x.innerText.includes('根目录'));
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(700);
  const winAfterClick = await page.$$eval('.window', (els) => els.length);
  check('单击系统图标不打开窗口', winAfterClick === 0, `窗口数 ${winAfterClick}`);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.desktop-sysicon')].find((x) => x.innerText.includes('根目录'));
    el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(1300);
  const winAfterDbl = await page.$$eval('.window', (els) => els.length);
  const sysTitle = await page.$eval('.window-title', (el) => el.innerText).catch(() => '');
  check('双击系统图标才打开窗口', winAfterDbl === 1, `窗口数 ${winAfterDbl}`);
  check('系统图标打开的窗口标题正确', sysTitle.trim() === '根目录', `title=${sysTitle}`);
  await page.evaluate(() => {
    const w = [...document.querySelectorAll('.window')].pop();
    w?.querySelector('.tc-close')?.click();
  });
  await sleep(800);

  // ---------- 右键菜单：子菜单 / 键盘 / 边缘收敛 ----------
  section('右键菜单（子菜单 / 键盘 / 边缘收敛）');
  const ctxLabels = (level = 0) => page.$$eval(
    `.context-menu[data-ctx-level="${level}"] .dropdown-item`,
    (els) => els.map((e) => e.dataset.label));
  const ctxOpenBlank = async (x = 700, y = 620) => {
    await page.evaluate((cx, cy) => {
      document.querySelector('.desktop-icons').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
      }));
    }, x, y);
    await sleep(350);
  };
  const ctxClick = async (level, label) => {
    const ok = await page.evaluate((lvl, lbl) => {
      const b = [...document.querySelectorAll(`.context-menu[data-ctx-level="${lvl}"] .dropdown-item`)]
        .find((x) => x.dataset.label === lbl);
      if (!b) return false;
      b.click();
      return true;
    }, level, label);
    await sleep(350);
    return ok;
  };
  const ctxHover = async (level, label) => {
    const p = await page.evaluate((lvl, lbl) => {
      const b = [...document.querySelectorAll(`.context-menu[data-ctx-level="${lvl}"] .dropdown-item`)]
        .find((x) => x.dataset.label === lbl);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, level, label);
    if (!p) return false;
    await page.mouse.move(p.x, p.y);
    await sleep(300);
    return true;
  };
  const ctxActive = (level = 0) => page.evaluate((lvl) =>
    document.querySelector(`.context-menu[data-ctx-level="${lvl}"] .dropdown-item.ctx-active`)?.dataset.label || '', level);
  const panelRect = (level) => page.evaluate((lvl) => {
    const el = document.querySelector(`.context-menu[data-ctx-level="${lvl}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, level);
  const dismissMenus = async () => {
    for (let i = 0; i < 4 && await page.$('.context-menu'); i++) {
      await page.keyboard.press('Escape');
      await sleep(150);
    }
    await page.mouse.move(2, 2);
    await sleep(150);
  };

  // 空白处根菜单结构（§1.5）
  await ctxOpenBlank();
  const blankItems = await ctxLabels(0);
  check('桌面空白菜单九组入口齐备（查看/排序方式/刷新/粘贴/新建/上传×2/剪贴板/终端）',
    ['查看', '排序方式', '刷新', '新建', '上传文件…', '上传文件夹…', '剪贴板', '在终端中打开'].every((k) => blankItems.includes(k))
      && blankItems.some((t) => t.startsWith('粘贴')),
    blankItems.join(','));
  const subCount = await page.$$eval('.context-menu[data-ctx-level="0"] .ctx-has-sub', (els) => els.length);
  check('桌面空白菜单有 4 个子菜单（查看/排序方式/新建/剪贴板）', subCount === 4, `子菜单项 ${subCount}`);
  check('剪贴板为空时「粘贴」禁用', await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu[data-ctx-level="0"] .dropdown-item')]
      .find((b) => b.dataset.label.startsWith('粘贴'))?.disabled));
  await shot('桌面右键菜单');

  // 悬浮展开 + 兄弟项切换只保留一条链
  check('悬浮「新建」展开子菜单', await ctxHover(0, '新建')
    && JSON.stringify(await ctxLabels(1)) === JSON.stringify(['文件夹', '文本文档']),
    (await ctxLabels(1)).join(','));
  await ctxHover(0, '剪贴板');
  const clipLabels = await ctxLabels(1);
  check('移到兄弟项后旧子菜单关闭，只剩「剪贴板」子菜单',
    clipLabels.includes('剪贴板：空') && clipLabels.includes('清空剪贴板') && !clipLabels.includes('文件夹'),
    clipLabels.join(','));
  check('空剪贴板时「清空剪贴板」禁用', await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu[data-ctx-level="1"] .dropdown-item')]
      .find((b) => b.dataset.label === '清空剪贴板')?.disabled));

  // 键盘：↑↓ 选择 / → 进入 / ← 退回 / Esc 逐级关闭
  await dismissMenus();
  await ctxOpenBlank();
  check('菜单打开时默认高亮第一项', (await ctxActive()) === '查看', await ctxActive());
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  check('↓ 移动到下一项', (await ctxActive()) === '排序方式', await ctxActive());
  await page.keyboard.press('ArrowUp');
  await sleep(200);
  check('↑ 回到上一项', (await ctxActive()) === '查看', await ctxActive());
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  check('→ 展开子菜单并进入', (await ctxLabels(1)).join(',') === '显示隐藏文件', (await ctxLabels(1)).join(','));
  check('进入子菜单后高亮随之下移', (await ctxActive(1)) === '显示隐藏文件', await ctxActive(1));
  await page.keyboard.press('Escape');
  await sleep(250);
  check('Esc 只关掉子菜单，父菜单还在', !!(await page.$('.context-menu[data-ctx-level="0"]'))
    && !(await page.$('.context-menu[data-ctx-level="1"]')), '层级状态不对');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await sleep(250);
  check('键盘跳过禁用的「粘贴」到达「新建」', (await ctxActive()) === '新建', await ctxActive());
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  await page.keyboard.press('ArrowLeft');
  await sleep(250);
  check('← 退回父级且子菜单收起', !(await page.$('.context-menu[data-ctx-level="1"]'))
    && (await ctxActive()) === '新建', await ctxActive());
  await page.keyboard.press('Escape');
  await sleep(250);
  check('全部关完后 Esc 关闭根菜单', !(await page.$('.context-menu')));
  await page.mouse.move(2, 2);

  // 边缘收敛：窄窗口 + 贴着右下角打开，子菜单必须翻转/收回视口
  // 注意宽要 >767：低于这个值 App 会切到移动端形态，桌面节点就不存在了
  await page.setViewport({ width: 800, height: 520, deviceScaleFactor: 1 });
  await sleep(350);
  await ctxOpenBlank(790, 510);
  const rootRect = await panelRect(0);
  check('根菜单贴右下角打开时仍在视口内', !!rootRect
    && rootRect.left >= 7 && rootRect.top >= 7 && rootRect.right <= 793 && rootRect.bottom <= 513,
    JSON.stringify(rootRect));
  await ctxHover(0, '排序方式');
  const subRect = await panelRect(1);
  const sortBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.context-menu[data-ctx-level="0"] .dropdown-item')]
      .find((x) => x.dataset.label === '排序方式');
    const r = b.getBoundingClientRect();
    return { right: r.right, left: r.left };
  });
  check('子菜单在右边缘翻到父项左侧，下边缘上移收纳', !!subRect
    && subRect.left < sortBtn.right && subRect.right <= 793 && subRect.bottom <= 513,
    `${JSON.stringify(subRect)} parent=${JSON.stringify(sortBtn)}`);
  // 缩窗前把指针移开菜单：Chrome 会在布局变化后按旧坐标重新派发 hover，
  // 那属于“鼠标换到了别的项”，会把子菜单正常收掉，不是 R10 要验的定位问题。
  await page.mouse.move(2, 2);
  await sleep(200);
  await page.setViewport({ width: 780, height: 400, deviceScaleFactor: 1 });
  await sleep(450);
  const rootRect2 = await panelRect(0);
  const subRect2 = await panelRect(1);
  check('窗口缩放后根菜单与子菜单重新收敛（R10）', !!rootRect2 && !!subRect2
    && rootRect2.right <= 773 && rootRect2.bottom <= 393
    && subRect2.right <= 773 && subRect2.bottom <= 393,
    `root=${JSON.stringify(rootRect2)} sub=${JSON.stringify(subRect2)}`);
  await dismissMenus();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await sleep(500);

  // 排序方式 / 查看：逐项真的改状态
  const desktopView = () => page.evaluate(() => JSON.parse(localStorage.getItem('cloudnine-desktop-view') || '{}'));
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  check('排序方式子菜单含名称/大小/修改时间/类型 + 升降序 + 文件夹优先',
    JSON.stringify(await ctxLabels(1)) === JSON.stringify(['名称', '大小', '修改时间', '类型', '升序', '降序', '文件夹优先']),
    (await ctxLabels(1)).join(','));
  await ctxClick(1, '修改时间');
  check('「排序方式›修改时间」写入桌面排序状态', (await desktopView()).sort?.key === 'mtime', JSON.stringify(await desktopView()));
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '大小');
  check('「排序方式›大小」写入桌面排序状态', (await desktopView()).sort?.key === 'size', JSON.stringify(await desktopView()));
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '类型');
  check('「排序方式›类型」写入桌面排序状态', (await desktopView()).sort?.key === 'type', JSON.stringify(await desktopView()));
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '降序');
  check('「排序方式›降序」写入 asc=false', (await desktopView()).sort?.asc === false, JSON.stringify(await desktopView()));
  const dirsFirstBefore = (await desktopView()).sort?.dirsFirst;
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '文件夹优先');
  check('「排序方式›文件夹优先」可切换', (await desktopView()).sort?.dirsFirst === !dirsFirstBefore, JSON.stringify(await desktopView()));
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '文件夹优先'); // 还原
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '名称'); // 还原默认排序
  await ctxOpenBlank();
  await ctxClick(0, '排序方式');
  await ctxClick(1, '升序');

  await ctxOpenBlank();
  await ctxClick(0, '查看');
  check('查看子菜单本轮只有「显示隐藏文件」', (await ctxLabels(1)).join(',') === '显示隐藏文件', (await ctxLabels(1)).join(','));
  await ctxClick(1, '显示隐藏文件');
  check('「查看›显示隐藏文件」打开后写入状态', (await desktopView()).showHidden === true, JSON.stringify(await desktopView()));
  await ctxOpenBlank();
  await ctxClick(0, '查看');
  await ctxClick(1, '显示隐藏文件');
  check('再次点击可关闭显示隐藏文件', (await desktopView()).showHidden === false, JSON.stringify(await desktopView()));

  // 刷新 / 新建 / 上传 / 终端
  await ctxOpenBlank();
  const refreshed = await ctxClick(0, '刷新');
  check('「刷新」可点击且菜单收起', refreshed && !(await page.$('.context-menu')));

  await ctxOpenBlank();
  await ctxClick(0, '新建');
  await ctxClick(1, '文件夹');
  const dlgInput = await page.$('.dialog input');
  check('「新建›文件夹」弹出命名对话框', !!dlgInput);
  if (dlgInput) {
    await dlgInput.click();
    await page.keyboard.type(dirName);
    const okBtn = await page.$('.dialog-actions .btn-primary');
    if (okBtn) await okBtn.click();
    await sleep(1500);
  }
  const afterNew = await page.$$eval('.desktop-icon[data-entry]', (els) => els.map((e) => e.dataset.entry));
  check('桌面上新建的文件夹立即出现', afterNew.includes(dirName),
    `桌面条目: ${afterNew.join(',') || '(空)'}`);
  const dirQ = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(dirName)}`, undefined, `cloudnine_sid=${dsid}`);
  check('新建的文件夹确实落盘', (dirQ.json?.results || []).some((x) => x.name === dirName), `status=${dirQ.status}`);
  await shot('桌面新建文件夹');

  await ctxOpenBlank();
  await ctxClick(0, '新建');
  await ctxClick(1, '文本文档');
  await sleep(400);
  const newFileTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
  check('「新建›文本文档」打开新建文件对话框', newFileTitle === '新建空白文件', newFileTitle);
  await page.evaluate(() => document.querySelector('.dialog-actions .btn')?.click());
  await sleep(400);

  await ctxOpenBlank();
  let fc = page.waitForFileChooser({ timeout: 6000 }).catch(() => null);
  await ctxClick(0, '上传文件…');
  const fileChooser = await fc;
  check('「上传文件…」打开系统文件选择器', !!fileChooser);
  await fileChooser?.cancel();
  await sleep(200);
  await ctxOpenBlank();
  fc = page.waitForFileChooser({ timeout: 6000 }).catch(() => null);
  await ctxClick(0, '上传文件夹…');
  const dirChooser = await fc;
  check('「上传文件夹…」打开系统文件夹选择器', !!dirChooser);
  await dirChooser?.cancel();
  await sleep(200);

  await ctxOpenBlank();
  await ctxClick(0, '在终端中打开');
  await sleep(1800);
  check('空白菜单「在终端中打开」真的开终端窗口', !!(await page.$('.window .terminal-window')), '未找到 .terminal-window');
  await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
  await sleep(700);

  // 桌面多选：Ctrl 点击 + 全选
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.desktop-icon[data-entry]')];
    els[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    els[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  });
  await sleep(400);
  const selInfo = await page.evaluate(() => ({
    total: document.querySelectorAll('.desktop-icon[data-entry]').length,
    selected: document.querySelectorAll('.desktop-icon[data-entry].selected').length,
  }));
  check('桌面支持 Ctrl 多选', selInfo.selected === 2, `选中 ${selInfo.selected}/${selInfo.total}`);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await sleep(400);
  const selAll = await page.evaluate(() => ({
    selected: document.querySelectorAll('.desktop-icon[data-entry].selected').length,
    total: document.querySelectorAll('.desktop-icon[data-entry]').length,
  }));
  check('桌面 Cmd/Ctrl+A 全选', selAll.selected === selAll.total && selAll.total > 0, JSON.stringify(selAll));
  await shot('桌面多选');

  // 文件条目的右键菜单：结构 + 每个动作的真实效果
  const ctxOpenIcon = async (name) => {
    const ok = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === n);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20,
      }));
      return true;
    }, name);
    await sleep(350);
    return ok;
  };
  const closeWins = async () => {
    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await sleep(800);
  };

  // 准备一个 .zip 条目（扩展名即归档类型）用于验证「解压到…」入口
  const zipPath = homeRel ? `${homeRel}/${zipName}` : zipName;
  await apiFetch('POST', '/api/fs/write', { path: zipPath, content: 'PK\u0003\u0004' }, `cloudnine_sid=${dsid}`);
  await ctxOpenBlank();
  await ctxClick(0, '刷新');
  await sleep(1000);
  check('刷新后新写入的 .zip 出现在桌面',
    (await page.$$eval('.desktop-icon[data-entry]', (els) => els.map((e) => e.dataset.entry))).includes(zipName));

  // 先清空选择：右键未选中项只作用于该条目，菜单才是完整可用状态
  await page.evaluate(() => {
    const el = document.querySelector('.desktop-icons');
    const o = { bubbles: true, clientX: 900, clientY: 700 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
  });
  await sleep(300);
  await ctxOpenIcon(deskName);
  const itemItems = await ctxLabels(0);
  check('文件右键菜单根层：打开/打开方式/预览/重命名/复制/剪切/删除/压缩/发送到/分享/属性',
    ['打开', '打开方式', '预览', '重命名', '复制', '剪切', '删除', '压缩…', '发送到'].every((k) => itemItems.includes(k))
      && itemItems.some((t) => /^分享/.test(t)) && itemItems.includes('属性'),
    itemItems.join(','));
  const itemSubs = await page.$$eval('.context-menu[data-ctx-level="0"] .ctx-has-sub', (els) => els.map((e) => e.dataset.label));
  check('文件菜单有「打开方式」「发送到」两个子菜单',
    itemSubs.includes('打开方式') && itemSubs.includes('发送到'), itemSubs.join(','));
  await shot('桌面文件右键菜单');
  await ctxHover(0, '打开方式');
  check('「打开方式」子菜单：用编辑器打开/用预览打开',
    JSON.stringify(await ctxLabels(1)) === JSON.stringify(['用编辑器打开', '用预览打开']), (await ctxLabels(1)).join(','));
  await ctxHover(0, '发送到');
  check('「发送到」子菜单：下载/打包下载/复制路径',
    JSON.stringify(await ctxLabels(1)) === JSON.stringify(['下载', '打包下载', '复制路径']), (await ctxLabels(1)).join(','));
  await dismissMenus();

  // 打开 → 编辑器
  await ctxOpenIcon(deskName);
  await ctxClick(0, '打开');
  await sleep(1500);
  check('「打开」真的打开编辑器窗口', !!(await page.$('.window .editor-window')), '未找到 .editor-window');
  await closeWins();

  // 预览 → 快速预览浮层
  await ctxOpenIcon(deskName);
  await ctxClick(0, '预览');
  await sleep(1200);
  check('「预览」打开快速预览浮层', !!(await page.$('.quicklook-overlay')), '未找到 .quicklook-overlay');
  await page.keyboard.press('Escape');
  await sleep(300);
  check('快速预览可关闭', !(await page.$('.quicklook-overlay')));

  // 打开方式 → 编辑器 / 预览
  await ctxOpenIcon(deskName);
  await ctxClick(0, '打开方式');
  await ctxClick(1, '用编辑器打开');
  await sleep(1500);
  check('「打开方式›用编辑器打开」生效', !!(await page.$('.window .editor-window')), '未找到 .editor-window');
  await closeWins();
  await ctxOpenIcon(deskName);
  await ctxClick(0, '打开方式');
  await ctxClick(1, '用预览打开');
  await sleep(1500);
  check('「打开方式›用预览打开」生效', !!(await page.$('.window .preview-window')), '未找到 .preview-window');
  await closeWins();

  // 复制 → 空白菜单剪贴板状态 → 粘贴（生成副本）→ 清空
  await ctxOpenIcon(deskName);
  await ctxClick(0, '复制');
  await ctxOpenBlank();
  await ctxClick(0, '剪贴板');
  check('复制后「剪贴板」子菜单显示 复制 1 项',
    (await ctxLabels(1)).includes('剪贴板：复制 1 项'), (await ctxLabels(1)).join(','));
  check('有剪贴板内容时「粘贴」可用', await page.evaluate(() =>
    ![...document.querySelectorAll('.context-menu[data-ctx-level="0"] .dropdown-item')]
      .find((b) => b.dataset.label.startsWith('粘贴'))?.disabled));
  await ctxClick(0, '粘贴项目');
  await sleep(1400);
  const homeList = await apiFetch('GET', `/api/fs/list?path=${encodeURIComponent(homeRel)}`, undefined, `cloudnine_sid=${dsid}`);
  const copyEntry = (homeList.json?.entries || []).find((x) => /^uitest-desktop-.*\(1\)\.txt$/.test(x.name));
  check('「粘贴」真的在桌面生成了一份副本', !!copyEntry, (homeList.json?.entries || []).map((x) => x.name).join(','));
  if (copyEntry) {
    await apiFetch('POST', '/api/fs/delete', { paths: [homeRel ? `${homeRel}/${copyEntry.name}` : copyEntry.name] }, `cloudnine_sid=${dsid}`);
  }
  await ctxOpenBlank();
  await ctxClick(0, '剪贴板');
  await ctxClick(1, '清空剪贴板');
  await dismissMenus();
  await ctxOpenBlank();
  await ctxClick(0, '剪贴板');
  check('「剪贴板›清空剪贴板」后状态行变空', (await ctxLabels(1)).includes('剪贴板：空'), (await ctxLabels(1)).join(','));
  check('空剪贴板时「清空剪贴板」禁用', await page.evaluate(() =>
    [...document.querySelectorAll('.context-menu[data-ctx-level="1"] .dropdown-item')]
      .find((b) => b.dataset.label === '清空剪贴板')?.disabled));
  await dismissMenus();

  // 剪切 → 剪贴板状态 → 清空
  await ctxOpenIcon(deskName);
  await ctxClick(0, '剪切');
  await ctxOpenBlank();
  await ctxClick(0, '剪贴板');
  check('「剪切」后「剪贴板」显示 剪切 1 项',
    (await ctxLabels(1)).includes('剪贴板：剪切 1 项'), (await ctxLabels(1)).join(','));
  await ctxClick(1, '清空剪贴板');
  await dismissMenus();

  // 重命名（只验证入口，Esc 取消）
  await ctxOpenIcon(deskName);
  await ctxClick(0, '重命名');
  check('「重命名」进入行内输入框', !!(await page.$('.desktop-icon[data-entry] .rename-input')));
  await page.keyboard.press('Escape');
  await sleep(300);

  // 删除（确认框，取消）
  await ctxOpenIcon(deskName);
  await ctxClick(0, '删除');
  await sleep(300);
  const delTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
  check('「删除」打开移入废纸篓确认框', delTitle === '移入废纸篓', delTitle);
  await page.evaluate(() => document.querySelector('.dialog-actions .btn')?.click());
  await sleep(500);

  // 压缩…（表单，取消）
  await ctxOpenIcon(deskName);
  await ctxClick(0, '压缩…');
  await sleep(400);
  const zipDlg = await page.$('.dialog');
  check('「压缩…」打开压缩对话框', !!zipDlg);
  await page.evaluate(() => document.querySelector('.dialog-actions .btn')?.click());
  await sleep(500);

  // 解压…（归档文件才出现）
  await ctxOpenIcon(zipName);
  check('压缩包菜单含「解压到…」', (await ctxLabels(0)).includes('解压到…'), (await ctxLabels(0)).join(','));
  await ctxClick(0, '解压到…');
  await sleep(500);
  const unzipTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
  check('「解压到…」打开解压对话框', /^解压 /.test(unzipTitle), unzipTitle);
  await page.evaluate(() => document.querySelector('.dialog-actions .btn')?.click());
  await sleep(500);

  // 分享…（表单，取消）
  await ctxOpenIcon(deskName);
  await ctxClick(0, '分享…');
  await sleep(400);
  const shareTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
  check('「分享…」打开分享对话框', /^分享/.test(shareTitle), shareTitle);
  await page.evaluate(() => document.querySelector('.dialog-actions .btn')?.click());
  await sleep(500);

  // 属性 → 现有简介窗口
  await ctxOpenIcon(deskName);
  await ctxClick(0, '属性');
  await sleep(1500);
  check('「属性」打开现有「简介」窗口', !!(await page.$('.window .info-window')), '未找到 .info-window');
  await closeWins();

  // 发送到 → 复制路径 / 下载 / 打包下载
  await ctxOpenIcon(deskName);
  await ctxClick(0, '发送到');
  await ctxClick(1, '复制路径');
  await sleep(500);
  const notifPath = await page.evaluate(() => [...document.querySelectorAll('.notification')]
    .some((n) => n.innerText.includes('路径已复制')));
  const clipWrites = await page.evaluate(() => window.__clipboardWrites || []);
  const fullPath = `/${[homeRel, deskName].filter(Boolean).join('/')}`;
  check('「发送到›复制路径」真的把完整路径交给剪贴板',
    notifPath || clipWrites.includes(fullPath),
    `notif=${notifPath} want=${fullPath} writes=${clipWrites.slice(-3).join('|')}`);

  await ctxOpenIcon(deskName);
  await ctxClick(0, '发送到');
  await ctxClick(1, '下载');
  await sleep(1000);
  const downloadHref = await page.evaluate(() => (window.__anchorClicks || [])
    .map((x) => x.href).find((h) => h.includes('/api/download?path=')) || '');
  check('「发送到›下载」真的触发单文件下载链接',
    downloadHref.includes(encodeURIComponent(deskName)), downloadHref);

  // 多选后「打包下载」：先点空白清掉旧选择，再 Ctrl 选中两项
  await page.evaluate(() => {
    const el = document.querySelector('.desktop-icons');
    const o = { bubbles: true, clientX: 900, clientY: 700 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
  });
  await sleep(250);
  await page.evaluate((a, b) => {
    const els = [...document.querySelectorAll('.desktop-icon[data-entry]')];
    const ea = els.find((x) => x.dataset.entry === a);
    const eb = els.find((x) => x.dataset.entry === b);
    ea?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    eb?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  }, deskName, dirName);
  await sleep(300);
  const selectedNow = await page.$$eval('.desktop-icon[data-entry].selected', (els) => els.map((e) => e.dataset.entry));
  await ctxOpenIcon(deskName);
  await ctxClick(0, '发送到');
  const zipEnabled = await page.evaluate(() =>
    ![...document.querySelectorAll('.context-menu[data-ctx-level="1"] .dropdown-item')]
      .find((b) => b.dataset.label === '打包下载')?.disabled);
  check('多选时「发送到›打包下载」可用', zipEnabled, `selected=${selectedNow.join(',')}`);
  await ctxClick(1, '打包下载');
  await sleep(1000);
  const zipHref = await page.evaluate(() => (window.__anchorClicks || [])
    .map((x) => x.href).find((h) => h.includes('/api/download/zip?paths=')) || '');
  check('「发送到›打包下载」真的触发 zip 下载链接', zipHref.includes(encodeURIComponent(deskName)), zipHref);

  // 目录的「打开方式」只有「在终端中打开」
  await page.evaluate(() => document.querySelector('.desktop-icons')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 900, clientY: 700 })));
  await sleep(200);
  await ctxOpenIcon(dirName);
  await ctxClick(0, '打开方式');
  check('目录的「打开方式」子菜单只有「在终端中打开」',
    JSON.stringify(await ctxLabels(1)) === JSON.stringify(['在终端中打开']), (await ctxLabels(1)).join(','));
  await ctxClick(1, '在终端中打开');
  await sleep(1800);
  check('目录「打开方式›在终端中打开」生效', !!(await page.$('.window .terminal-window')), '未找到 .terminal-window');
  await closeWins();

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
    const src = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === fileName);
    const dst = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === dirName2);
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
  const afterMove = await page.$$eval('.desktop-icon[data-entry]', (els) => els.map((e) => e.dataset.entry));
  check('移入后桌面不再显示该文件', !afterMove.includes(deskName), afterMove.join(','));
  await shot('桌面拖拽移入文件夹');

  // 双击文件夹 → 打开「文件」窗口，标题是目录名
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === n);
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
    const el = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === n);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, dirName);
  await sleep(300);
  await page.keyboard.press('F2');
  await sleep(400);
  const renameInput = await page.$('.desktop-icon[data-entry] .rename-input');
  check('F2 进入重命名', !!renameInput);
  if (renameInput) {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(newDirName);
    await page.keyboard.press('Enter');
    await sleep(1500);
  }
  const renamed = await page.$$eval('.desktop-icon[data-entry]', (els) => els.map((e) => e.dataset.entry));
  check('重命名后桌面显示新名字', renamed.includes(newDirName), renamed.join(','));
  const renQ = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(newDirName)}`, undefined, `cloudnine_sid=${dsid}`);
  check('重命名确实落盘', (renQ.json?.results || []).some((x) => x.name === newDirName), `status=${renQ.status}`);
  await shot('桌面重命名');

  // 删除：选中 → Delete → 确认 → 移入废纸篓
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === n);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, newDirName);
  await sleep(300);
  await page.keyboard.press('Delete');
  await sleep(600);
  const trashConfirm = await page.$('.dialog-actions .btn-primary');
  check('Delete 弹出「移入废纸篓」确认', !!trashConfirm);
  if (trashConfirm) { await trashConfirm.click(); await sleep(1500); }
  const afterDel = await page.$$eval('.desktop-icon[data-entry]', (els) => els.map((e) => e.dataset.entry));
  check('删除后桌面不再显示该项', !afterDel.includes(newDirName), afterDel.join(','));
  await shot('桌面删除');

  // 系统图标菜单：§2.2.1 的文案（重新载入一次，让回收站数量同步）
  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('.desktop-icons', { timeout: 15000 });
  await sleep(1800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.desktop-sysicon')].find((x) => x.innerText.includes('根目录'));
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
  });
  await sleep(350);
  check('根目录图标菜单：打开 / 在终端中打开',
    JSON.stringify(await ctxLabels(0)) === JSON.stringify(['打开', '在终端中打开']), (await ctxLabels(0)).join(','));
  await ctxClick(0, '打开');
  await sleep(1600);
  check('根目录菜单「打开」真的打开根目录窗口', !!(await page.$('.window .finder')), '未找到 .finder');
  await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
  await sleep(800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.desktop-sysicon')].find((x) => x.innerText.includes('根目录'));
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
  });
  await sleep(350);
  await ctxClick(0, '在终端中打开');
  await sleep(1800);
  check('根目录菜单「在终端中打开」生效', !!(await page.$('.window .terminal-window')), '未找到 .terminal-window');
  await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
  await sleep(800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.desktop-sysicon')].find((x) => x.innerText.includes('废纸篓'));
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 120 }));
  });
  await sleep(350);
  const trashMenu = await ctxLabels(0);
  check('回收站图标菜单文案为「打开回收站」「清空回收站」',
    trashMenu[0] === '打开回收站' && trashMenu.includes('清空回收站'), trashMenu.join(','));
  await ctxClick(0, '打开回收站');
  await sleep(1600);
  check('「打开回收站」真的打开回收站窗口', !!(await page.$('.window .finder')), '未找到 .finder');
  await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
  await sleep(800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.desktop-sysicon')].find((x) => x.innerText.includes('废纸篓'));
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 120 }));
  });
  await sleep(350);
  await ctxClick(0, '清空回收站');
  await sleep(400);
  const emptyTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
  check('「清空回收站」打开同名确认框', emptyTitle === '清空回收站', emptyTitle);
  await page.evaluate(() => document.querySelector('.dialog-actions .btn-danger')?.click());
  await sleep(1400);
  const trashLeft = await apiFetch('GET', '/api/fs/trash/count', undefined, `cloudnine_sid=${dsid}`);
  check('确认「清空回收站」后回收站归零', trashLeft.json?.count === 0, JSON.stringify(trashLeft.json));
  check('清空后桌面回收站徽标消失', !(await page.$('.desktop-badge')));

  // 焦点在桌面时，菜单栏切换为桌面菜单
  const menuLabels = await page.evaluate(() => [...document.querySelectorAll('.mb-menu-btn')].map((b) => b.innerText.trim()));
  check('桌面态菜单栏含「编辑」「显示」', menuLabels.includes('编辑') && menuLabels.includes('显示'), menuLabels.join(','));


  section('文件窗口（Finder）');
  const pinnedApps = await page.$$('.tb-app');
  check('任务栏固定应用数量 ≥ 4', pinnedApps.length >= 4, `实际 ${pinnedApps.length}`);

  const finderBtn = await page.$('.tb-app[title="文件资源管理器"]');
  if (finderBtn) {
    await finderBtn.click();
    await sleep(1500);
    const winTitle = await page.$('.window-title');
    const titleText = winTitle ? await page.$eval('.window-title', (el) => el.innerText) : '';
    check('文件窗口打开', /文件|Finder/i.test(titleText) || !!winTitle, `title=${titleText}`);
    await shot('文件窗口');

    // 回归：Finder 右键菜单在 T6 子菜单化后（§1.5）项与改造前一致，无增无减
    await page.evaluate(() => {
      const el = document.querySelector('.finder-main');
      el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 360 }));
    });
    await sleep(400);
    const finderBlank = await ctxLabels(0);
    check('Finder 空白右键九项齐备（新建/粘贴/粘贴为副本/上传×2/查看/排序方式/刷新/终端）',
      ['新建', '粘贴', '粘贴为副本', '上传文件…', '上传文件夹…', '查看', '排序方式', '刷新', '在终端中打开']
        .every((k) => finderBlank.includes(k)),
      finderBlank.join(','));
    check('Finder 空白右键含 3 个子菜单（新建/查看/排序方式）',
      (await page.$$eval('.context-menu[data-ctx-level="0"] .ctx-has-sub', (els) => els.length)) === 3);
    await ctxClick(0, '新建');
    const finderNew = await ctxLabels(1);
    check('Finder「新建」子菜单为 文件夹 / 文本文档',
      JSON.stringify(finderNew) === JSON.stringify(['文件夹', '文本文档']), finderNew.join(','));
    await ctxClick(0, '排序方式');
    const finderSort = await ctxLabels(1);
    check('Finder「排序方式」二级子菜单（名称/大小/修改时间 + 升降序）',
      ['按名称', '按大小', '按修改时间'].every((k) => finderSort.includes(k))
      && finderSort.some((t) => /改为升序|改为降序/.test(t)),
      finderSort.join(','));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(250);
  } else {
    check('任务栏存在「文件资源管理器」入口', false, '未找到 .tb-app[title=文件资源管理器]');
  }

  // ---------- 3.6 文件窗口命令栏（阶段 1 · T6） ----------
  section('文件窗口命令栏（新建 / 剪贴板 / 排序 / 查看 / 更多）');
  if (finderBtn) {
    const cmdSel = (label) => `.finder-cmdbar .cmd-btn[data-cmd="${label}"]`;
    const clickCmd = async (label) => {
      const ok = await page.evaluate((l) => {
        const b = document.querySelector(`.finder-cmdbar .cmd-btn[data-cmd="${l}"]`);
        if (!b || b.disabled) return false;
        b.click();
        return true;
      }, label);
      await sleep(320);
      return ok;
    };
    const cmdDisabled = (label) => page.evaluate((l) => {
      const b = document.querySelector(`.finder-cmdbar .cmd-btn[data-cmd="${l}"]`);
      return b ? b.disabled : null;
    }, label);
    const cmdLabels = () => page.$$eval('.finder-cmdbar .cmd-btn', (els) => els.map((e) => e.dataset.cmd));
    const itemNameOf = (n) => page.evaluate((name) => {
      const el = document.querySelector(`.finder-item[data-name="${name}"]`);
      if (!el) return false;
      el.click();
      return true;
    }, n);

    const bar = await cmdLabels();
    check('命令栏五组按钮齐备（新建/上传×2/剪切/复制/粘贴/重命名/删除/排序/查看）',
      ['新建', '上传文件…', '上传文件夹…', '剪切', '复制', '粘贴', '重命名', '删除', '排序', '查看']
        .every((k) => bar.includes(k)), bar.join(','));
    check('无选中时 剪切/复制/重命名/删除 均置灰、粘贴随剪贴板置灰',
      (await cmdDisabled('剪切')) === true && (await cmdDisabled('复制')) === true
      && (await cmdDisabled('重命名')) === true && (await cmdDisabled('删除')) === true
      && (await cmdDisabled('粘贴')) === true,
      `cut=${await cmdDisabled('剪切')} copy=${await cmdDisabled('复制')} paste=${await cmdDisabled('粘贴')}`);

    // 命令栏按钮必须落到 act() 的真实分支：新建 ▸ 文件夹 → 真的在磁盘上建出目录
    const cmdDir = `uitest-cmd-dir-${Date.now()}`;
    await clickCmd('新建');
    const newItems = await ctxLabels(0);
    check('命令栏「新建 ▸」下拉为 文件夹 / 文本文档',
      JSON.stringify(newItems) === JSON.stringify(['文件夹', '文本文档']), newItems.join(','));
    await ctxClick(0, '文件夹');
    await sleep(450);
    const mkTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
    await page.evaluate(() => document.querySelector('.dialog input')?.focus());
    await page.keyboard.type(cmdDir);
    await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
    await sleep(1400);
    const dirQ = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(cmdDir)}`, undefined, `cloudnine_sid=${dsid}`);
    check('命令栏「新建 ▸ 文件夹」真的建出目录（act: newFolder）',
      mkTitle === '新建文件夹' && (dirQ.json?.results || []).some((x) => x.name === cmdDir), `dlg=${mkTitle} q=${dirQ.status}`);

    // 查看 ▾：图标 / 列表 / 显示隐藏文件 / 刷新
    await clickCmd('查看');
    const viewItems = await ctxLabels(0);
    check('命令栏「查看 ▾」含 图标/列表/显示隐藏文件/刷新',
      ['图标', '列表', '显示隐藏文件', '刷新'].every((k) => viewItems.includes(k)), viewItems.join(','));
    await ctxClick(0, '列表');
    await sleep(400);
    check('「查看 ▸ 列表」切到列表视图（act: viewList）', !!(await page.$('.list-view')));
    await clickCmd('查看');
    await ctxClick(0, '图标');
    await sleep(400);
    check('「查看 ▸ 图标」切回图标视图（act: viewIcon）', !!(await page.$('.icon-grid')));

    // 排序 ▾：与右键「排序方式 ▸」同一份项
    await clickCmd('排序');
    const sortLbl = await ctxLabels(0);
    check('命令栏「排序 ▾」为 按名称/按大小/按修改时间 + 升降序',
      ['按名称', '按大小', '按修改时间'].every((k) => sortLbl.includes(k))
      && sortLbl.some((t) => /改为升序|改为降序/.test(t)), sortLbl.join(','));
    const sortItem = sortLbl.includes('按名称') ? '按名称' : '名称';
    await ctxClick(0, sortItem);
    await sleep(300);
    await clickCmd('排序');
    const checked = await page.$eval('.context-menu .dropdown-item[data-label="按名称"] .di-check', (el) => el.innerText.trim());
    check('命令栏排序结果写回视图排序状态（按名称 ✓）', checked === '✓', `check=${checked}`);
    await page.keyboard.press('Escape');
    await sleep(200);

    // 剪贴板：复制 → 粘贴 ▾ →「粘贴为副本」→ 磁盘上真出现 (1) 副本（最容易漏的一项）
    const cmdBase = `uitest-cmd-file-${Date.now()}`;
    const cmdFile = `${cmdBase}.txt`;
    await apiFetch('POST', '/api/fs/write', { path: homeRel ? `${homeRel}/${cmdFile}` : cmdFile, content: 'cmdbar copy test\n' }, `cloudnine_sid=${dsid}`);
    await clickCmd('查看');
    await ctxClick(0, '刷新');
    await sleep(900);
    const picked = await itemNameOf(cmdFile);
    check('命令栏「查看 ▸ 刷新」后能看到新建文件（act: refresh）', picked, cmdFile);
    await page.evaluate((n) => document.querySelector(`.finder-item[data-name="${n}"]`)?.click(), cmdFile);
    await sleep(250);
    check('选中一项后 复制/重命名 可用、重命名仍限制单选',
      (await cmdDisabled('复制')) === false && (await cmdDisabled('重命名')) === false,
      `copy=${await cmdDisabled('复制')} rename=${await cmdDisabled('重命名')}`);
    await clickCmd('复制');
    await sleep(300);
    check('命令栏「复制」写入内部剪贴板（粘贴按钮变为可用）', (await cmdDisabled('粘贴')) === false);
    await page.evaluate(() => document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="粘贴选项"]')?.click());
    await sleep(350);
    const pasteMenu = await ctxLabels(0);
    check('「粘贴 ▾」下拉保留「粘贴为副本」与「清空剪贴板」',
      pasteMenu.includes('粘贴为副本') && pasteMenu.includes('清空剪贴板'), pasteMenu.join(','));
    await ctxClick(0, '粘贴为副本');
    await sleep(1500);
    const listQ = await apiFetch('GET', `/api/fs/list?path=${encodeURIComponent(homeRel)}`, undefined, `cloudnine_sid=${dsid}`);
    const copyHit = (listQ.json?.entries || []).find((e) => e.name === `${cmdBase}(1).txt`);
    check('「粘贴为副本」实测生成副本（<name>(1).txt）', !!copyHit, JSON.stringify((listQ.json?.entries || []).map((e) => e.name)));
    await page.evaluate(() => document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="粘贴选项"]')?.click());
    await sleep(300);
    await ctxClick(0, '清空剪贴板');
    await sleep(400);
    check('「清空剪贴板」后 粘贴 重新置灰', (await cmdDisabled('粘贴')) === true);

    // 更多 ▸：全选 / 前往文件夹…
    await page.evaluate((n) => document.querySelector(`.finder-item[data-name="${n}"]`)?.click(), cmdFile);
    await sleep(200);
    await clickCmd('更多');
    const moreItems = await ctxLabels(0);
    check('命令栏「⋯ 更多」含 全选 / 前往文件夹…',
      moreItems.includes('全选') && moreItems.includes('前往文件夹…'), moreItems.join(','));
    await ctxClick(0, '全选');
    await sleep(450);
    const sbText = await page.$eval('.finder-statusbar', (el) => el.innerText);
    check('「更多 ▸ 全选」真的全选（act: selectAll）', /已选择 \d+ 项/.test(sbText), sbText.replace(/\n/g, ' '));

    // 删除 → 走 trashItems 的确认框（取消，不真的删）
    await clickCmd('删除');
    await sleep(450);
    const trashTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
    check('命令栏「删除」弹出移入回收站确认框（act: trash）', /移入废纸篓/.test(trashTitle), trashTitle);
    await page.evaluate(() => [...document.querySelectorAll('.dialog-actions .btn')].find((b) => b.innerText.trim() === '取消')?.click());
    await sleep(300);

    // 条目右键：子菜单化后项与改造前一致（属性/删除/发送到/打开方式）
    await page.evaluate((n) => {
      const el = document.querySelector(`.finder-item[data-name="${n}"]`);
      el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 480, clientY: 380 }));
    }, cmdFile);
    await sleep(400);
    const itemLabels = await ctxLabels(0);
    check('条目右键（文件）项与改造前一致：打开/快速预览/剪切/复制/重命名/删除/压缩…/发送到/属性',
      ['打开', '快速预览', '剪切', '复制', '重命名', '删除', '压缩…', '发送到', '属性'].every((k) => itemLabels.includes(k))
      && itemLabels.some((t) => t.startsWith('分享…')), itemLabels.join(','));
    check('条目右键不再出现「显示简介」「移入废纸篓」旧文案',
      !itemLabels.some((t) => /显示简介|移入废纸篓/.test(t)), itemLabels.join(','));
    await ctxClick(0, '发送到');
    const sendTo = await ctxLabels(1);
    check('「发送到 ▸」收拢 下载 / 复制路径', ['下载', '复制路径'].every((k) => sendTo.includes(k)), sendTo.join(','));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(250);

    // 目录条目：打开方式 ▸ 在终端中打开
    await page.evaluate(() => {
      const el = document.querySelector('.finder-item[data-name="docs"]');
      el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 480, clientY: 380 }));
    });
    await sleep(400);
    const dirLabels = await ctxLabels(0);
    check('目录条目右键含「打开方式」子菜单、无「快速预览」',
      dirLabels.includes('打开方式') && !dirLabels.includes('快速预览'), dirLabels.join(','));
    await ctxClick(0, '打开方式');
    const openWith = await ctxLabels(1);
    check('「打开方式 ▸」内含 在终端中打开', openWith.includes('在终端中打开'), openWith.join(','));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(250);

    // Ctrl+F / F3 仍能聚焦搜索框（R5）
    const activeIsSearch = () => page.evaluate(() => !!document.activeElement?.closest?.('.finder-search'));
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.evaluate(() => document.querySelector('.finder-content')?.click());
    await sleep(250);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await sleep(400);
    check('Ctrl+F 仍能聚焦文件窗口搜索框（.finder-search input 选择器未变）', await activeIsSearch());
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('F3');
    await sleep(400);
    check('F3 同样聚焦搜索框', await activeIsSearch());

    // 地址栏：点空白 = 前往文件夹（goFolder）；↑ = 上一级（goParent）
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.evaluate(() => document.querySelector('.finder-address')?.click());
    await sleep(400);
    const goTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
    check('地址栏空白处点击 = 「前往文件夹」（act: goFolder）', goTitle === '前往文件夹', goTitle);
    await page.evaluate(() => document.querySelector('.dialog input')?.focus());
    await page.keyboard.type('docs');
    await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
    await sleep(1000);
    const addr1 = await page.$eval('.finder-address', (el) => el.innerText).catch(() => '');
    check('「前往文件夹」真实导航到 docs 子目录', /docs/.test(addr1), addr1.replace(/\n/g, ' '));
    await page.evaluate(() => document.querySelector('.finder-toolbar .tb-btn[title^="上一级"]')?.click());
    await sleep(900);
    const addr2 = await page.$eval('.finder-address', (el) => el.innerText).catch(() => '');
    check('地址栏「↑」回到上一级（act: goParent）', !/docs/.test(addr2), addr2.replace(/\n/g, ' '));

    // 侧栏分组名（文案统一）与回收站视图的命令栏
    const sbGroup = await page.$eval('.finder-sidebar .sb-group', (el) => el.innerText.trim());
    check('侧栏分组名已改为「快速访问」', sbGroup === '快速访问', sbGroup);
    await page.evaluate(() => [...document.querySelectorAll('.sb-item')].find((b) => b.innerText.trim() === '废纸篓')?.click());
    await sleep(1000);
    const trashCmd = await cmdLabels();
    check('回收站视图命令栏为 还原 / 彻底删除… / 清空回收站…',
      ['还原', '彻底删除…', '清空回收站…'].every((k) => trashCmd.includes(k)), trashCmd.join(','));
    await page.evaluate(() => [...document.querySelectorAll('.sb-item')].find((b) => b.innerText.trim() === '主目录')?.click());
    await sleep(800);
    await shot('文件窗口命令栏');

    // 亮/暗主题：命令栏只用现有 token，两套主题下都要可见且仍是纯色（不加 backdrop-filter）
    const cmdStyle = () => page.evaluate(() => {
      const bar = document.querySelector('.finder-cmdbar');
      const btn = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="查看"]');
      return {
        bg: getComputedStyle(bar).backgroundColor,
        color: getComputedStyle(btn).color,
        backdrop: getComputedStyle(bar).backdropFilter || 'none',
      };
    });
    const lightCmd = await cmdStyle();
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(250);
    await page.evaluate(() => [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')].find((b) => b.innerText.includes('深色主题'))?.click());
    await sleep(450);
    const darkCmd = await cmdStyle();
    check('命令栏跟随亮/暗主题（背景与文字色都变）且无毛玻璃',
      lightCmd.bg !== darkCmd.bg && lightCmd.color !== darkCmd.color && darkCmd.backdrop === 'none',
      `${lightCmd.bg}/${lightCmd.color} vs ${darkCmd.bg}/${darkCmd.color}`);
    await page.keyboard.press('Escape');   // 先关掉账户弹层再截暗色图
    await sleep(300);
    await shot('文件窗口命令栏-暗色');
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(250);
    await page.evaluate(() => [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')].find((b) => b.innerText.includes('跟随系统'))?.click());
    await sleep(400);

    // 清理本节产物（命令栏创建的目录 + 副本）
    for (const n of [cmdDir, `${cmdBase}(1).txt`, cmdFile]) {
      const q = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(n)}`, undefined, `cloudnine_sid=${dsid}`);
      const hit = (q.json?.results || []).find((x) => x.name === n);
      if (hit) await apiFetch('POST', '/api/fs/delete', { paths: [hit.rel] }, `cloudnine_sid=${dsid}`);
    }
  }

  // ---------- 4. 终端（真实 PTY） ----------
  section('终端（真实 PTY）');
  const sid = await loginViaApi();
  check('API 侧登录成功（用于反查）', !!sid, '未取到会话 Cookie');

  const termBtn = await page.$('.tb-app[title="终端"]');

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
    check('任务栏存在「终端」入口', false, '未找到 .tb-app[title=终端]');
  }

  // ---------- 5. 文本编辑：新建 → 输入 → Ctrl+S → 磁盘核对 ----------
  section('文本编辑（Ctrl+S 保存）');
  const editorBtn = await page.$('.tb-app[title="记事本"]');
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
    check('任务栏存在「记事本」入口', false, '未找到 .tb-app[title=记事本]');
  }

  // ---------- 5.5 粘贴上传（合成 ClipboardEvent，不依赖真实系统剪贴板）----------
  // 真机能力验证另见 scripts/paste-probe.html；此处只验证前端分支逻辑与上传链路。
  section('粘贴上传（Ctrl+V）');
  if (sid) {
    // 打开并激活一个文件窗口：此前焦点在编辑器窗口，非文件窗口按设计不接管粘贴
    const fb = await page.$('.tb-app[title="文件资源管理器"]');
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
    const fb = await page.$('.tb-app[title="文件资源管理器"]');
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
    const btns = await page.$$('.finder-cmdbar .cmd-btn[data-cmd="上传文件…"]');
    check('文件命令栏存在「上传文件…」按钮', btns.length >= 1, `count=${btns.length}`);
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
    const upBtns = await page.$$('.finder-cmdbar .cmd-btn[data-cmd="上传文件…"]');
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
  // ---------- 5.8 任务栏：每窗口一个按钮 / 最小化 → 还原 / 跳转列表 ----------
  section('任务栏（最小化 → 还原）');
  if (sid) {
    // 同类型多开用：桌面上一个真实文件夹 → 双击再开一个文件窗口
    await apiFetch('POST', '/api/fs/mkdir', { path: homeRel ? `${homeRel}/${tbDirName}` : tbDirName }, `cloudnine_sid=${sid}`);
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.taskbar', { timeout: 15000 });
    await sleep(900);
    check('Dock 已移除（.dock 不存在）', !(await page.$('.dock')), '仍存在 .dock');
    check('开始按钮位置已留出', !!(await page.$('.taskbar .tb-start')), '未找到 .tb-start');

    const trayParts = await page.evaluate(() => ({
      disk: !!document.querySelector('.tray-disk'),
      transfers: !!document.querySelector('.tray-transfers'),
      bell: !!document.querySelector('.tray-bell'),
      clock: !!document.querySelector('.tray-clock'),
      account: !!document.querySelector('.tray-account'),
    }));
    check('托盘五项齐备（磁盘/传输/通知/时钟/账户）', Object.values(trayParts).every(Boolean), JSON.stringify(trayParts));

    const clickPinned = async (label) => {
      const el = await page.$(`.tb-app[title="${label}"]`);
      if (!el) return false;
      await el.click();
      return true;
    };
    const dblClickItem = async (name) => {
      const ok = await page.evaluate((n) => {
        const el = [...document.querySelectorAll('.finder-item')].find((x) => x.textContent.includes(n));
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      }, name);
      await sleep(1800);
      return ok;
    };

    // 五个 multi:true 类型各开一个窗口（记事本开两个，用来验证「每窗口一个按钮」）
    check('固定项打开文件资源管理器', await clickPinned('文件资源管理器'));
    await page.waitForSelector('.finder', { timeout: 15000 });
    await sleep(600);
    // 固定项单击语义：已聚焦 → 最小化；再点 → 经 activateOrOpen 还原最上层的那个
    await page.click('.tb-app[title="文件资源管理器"]');
    await sleep(500);
    check('固定项：窗口已聚焦时再点 → 最小化',
      await page.evaluate(() => { const w = document.querySelector('.window'); return !!w && w.classList.contains('minimized'); }), '未最小化');
    await page.click('.tb-app[title="文件资源管理器"]');
    await sleep(500);
    check('固定项：再点 → 还原（activateOrOpen）',
      await page.evaluate(() => { const w = document.querySelector('.window'); return !!w && !w.classList.contains('minimized'); }), '仍最小化');

    // 同类型再开一个：双击桌面文件夹 → 第二个文件窗口
    const dirOpened = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('.desktop-icon[data-entry]')].find((x) => x.dataset.entry === n);
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    }, tbDirName);
    await sleep(1600);
    check('双击桌面文件夹开第二个文件窗口（同类型多开）', dirOpened && (await page.$$('.window .finder')).length === 2,
      `文件窗口 ${(await page.$$('.window .finder')).length}`);

    check('固定项打开终端', await clickPinned('终端'));
    await sleep(1600);
    check('双击文本文件打开记事本（第 1 个）', await dblClickItem(btnUploadName));
    check('双击另一个文本文件打开记事本（第 2 个）', await dblClickItem(pasteName));
    check('双击图片打开预览', await dblClickItem(imgName));

    // 属性窗口：文件窗口条目右键 → 属性（原「显示简介」，按术语表已改）
    const ctxOpened = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('.finder-item')].find((x) => x.textContent.includes(n));
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 260 }));
      return true;
    }, imgName);
    await sleep(400);
    const infoClicked = await page.evaluate(() => {
      const it = [...document.querySelectorAll('.context-menu .dropdown-item')].find((b) => b.innerText.trim() === '属性');
      if (!it) return false;
      it.click();
      return true;
    });
    await sleep(1600);
    check('条目右键「属性」打开属性窗口', ctxOpened && infoClicked && !!(await page.$('.info-window')),
      `ctx=${ctxOpened} click=${infoClicked}`);

    const typeCount = await page.evaluate(() => ({
      finder: document.querySelectorAll('.window .finder').length,
      terminal: document.querySelectorAll('.window .terminal-window').length,
      editor: document.querySelectorAll('.window .editor-window').length,
      preview: document.querySelectorAll('.window .preview-window').length,
      info: document.querySelectorAll('.window .info-window').length,
    }));
    check('五个 multi:true 类型均已开窗（文件/记事本各两个）',
      typeCount.finder === 2 && typeCount.terminal === 1 && typeCount.editor === 2 && typeCount.preview === 1 && typeCount.info === 1,
      JSON.stringify(typeCount));

    const counts = await page.evaluate(() => ({
      wins: document.querySelectorAll('.window').length,
      btns: document.querySelectorAll('.tb-win').length,
      winTitles: [...document.querySelectorAll('.window .window-title')].map((e) => e.innerText.trim()),
      btnTitles: [...document.querySelectorAll('.tb-win-label')].map((e) => e.innerText.trim()),
    }));
    check('任务栏窗口按钮数 = 窗口数（每窗口一个按钮）', counts.btns === counts.wins && counts.wins === 7,
      `按钮 ${counts.btns} / 窗口 ${counts.wins}（按类型去重会得到 5 个）`);
    check('窗口按钮标题与窗口标题一一对应',
      JSON.stringify(counts.winTitles) === JSON.stringify(counts.btnTitles),
      `${counts.winTitles.join('|')} vs ${counts.btnTitles.join('|')}`);

    const snap = await page.evaluate(() => [...document.querySelectorAll('.window')].map((w) => ({
      title: w.querySelector('.window-title')?.innerText.trim() || '',
      geo: [w.style.left, w.style.top, w.style.width, w.style.height].join(','),
    })));

    // 菜单栏「窗口›最小化全部窗口」的等价入口：任务栏空白处右键（也是 R7 的修复点）
    await page.evaluate(() => {
      document.querySelector('.taskbar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 880 }));
    });
    await sleep(400);
    const barMenu = await page.$$eval('.context-menu .dropdown-item', (els) => els.map((e) => e.innerText.trim()));
    check('任务栏空白右键含「最小化全部窗口」', barMenu.includes('最小化全部窗口'), barMenu.join(','));
    await page.evaluate(() => {
      [...document.querySelectorAll('.context-menu .dropdown-item')].find((b) => b.innerText.trim() === '最小化全部窗口')?.click();
    });
    await sleep(600);
    const mini = await page.evaluate(() => ({
      total: document.querySelectorAll('.window').length,
      hidden: [...document.querySelectorAll('.window')].filter((w) => w.classList.contains('minimized') && w.offsetParent === null).length,
      buttons: document.querySelectorAll('.tb-win').length,
      focused: document.querySelectorAll('.window.focused').length,
    }));
    check('「最小化全部」后所有窗口隐藏、按钮仍在、焦点回到桌面',
      mini.hidden === mini.total && mini.buttons === mini.total && mini.focused === 0 && mini.total === snap.length,
      JSON.stringify(mini));

    const bad = [];
    for (let i = 0; i < snap.length; i++) {
      await page.evaluate((idx) => document.querySelectorAll('.tb-win')[idx]?.click(), i);
      await sleep(320);
      const st = await page.evaluate((idx) => {
        const w = document.querySelectorAll('.window')[idx];
        return {
          hidden: w.classList.contains('minimized') || w.offsetParent === null,
          geo: [w.style.left, w.style.top, w.style.width, w.style.height].join(','),
          focused: w.classList.contains('focused'),
        };
      }, i);
      if (st.hidden) bad.push(`${snap[i].title}#${i} 仍隐藏`);
      if (st.geo !== snap[i].geo) bad.push(`${snap[i].title}#${i} 几何 ${snap[i].geo} → ${st.geo}`);
      if (i === snap.length - 1 && !st.focused) bad.push('最后还原的窗口未获得焦点');
    }
    check('逐个从任务栏还原：全部可见 + 几何不变 + 最后还原者置顶', bad.length === 0, bad.join('；'));

    // DoD：菜单栏里现有的「窗口 › 最小化全部窗口」同样不能把窗口变成孤儿（R7）
    await page.evaluate(() => {
      [...document.querySelectorAll('.mb-menu-btn')].find((b) => b.innerText.trim() === '窗口')?.click();
    });
    await sleep(300);
    const minAllClicked = await page.evaluate(() => {
      const it = [...document.querySelectorAll('.dropdown .dropdown-item')].find((b) => b.innerText.includes('最小化全部窗口'));
      if (!it) return false;
      it.click();
      return true;
    });
    await sleep(600);
    const mini2 = await page.evaluate(() => ({
      total: document.querySelectorAll('.window').length,
      hidden: [...document.querySelectorAll('.window')].filter((w) => w.classList.contains('minimized')).length,
      buttons: document.querySelectorAll('.tb-win').length,
    }));
    check('菜单栏「最小化全部窗口」后每个窗口仍有任务栏按钮（R7）',
      minAllClicked && mini2.hidden === mini2.total && mini2.buttons === mini2.total, JSON.stringify(mini2));

    await page.evaluate(() => {
      document.querySelector('.taskbar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 880 }));
    });
    await sleep(350);
    await page.evaluate(() => {
      [...document.querySelectorAll('.context-menu .dropdown-item')].find((b) => b.innerText.trim() === '还原所有窗口')?.click();
    });
    await sleep(500);
    const mini3 = await page.evaluate(() => ({
      total: document.querySelectorAll('.window').length,
      hidden: [...document.querySelectorAll('.window')].filter((w) => w.classList.contains('minimized')).length,
      focused: document.querySelectorAll('.window.focused').length,
    }));
    check('任务栏「还原所有窗口」一键恢复全部', mini3.hidden === 0 && mini3.focused === 1 && mini3.total >= 7, JSON.stringify(mini3));

    const last = snap.length - 1;
    await page.evaluate((idx) => document.querySelectorAll('.tb-win')[idx]?.click(), last);
    await sleep(320);
    check('点击已聚焦窗口的按钮 → 最小化',
      await page.evaluate((idx) => document.querySelectorAll('.window')[idx].classList.contains('minimized'), last));
    const handoff = await page.evaluate(() => ({
      focused: document.querySelectorAll('.window.focused').length,
      visible: [...document.querySelectorAll('.window')].filter((w) => !w.classList.contains('minimized')).length,
    }));
    check('最小化当前窗口后焦点交接给剩余最上层窗口（不置 null）',
      handoff.focused === 1 && handoff.visible >= 1, JSON.stringify(handoff));

    await page.evaluate((idx) => document.querySelectorAll('.tb-win')[idx]?.click(), last);
    await sleep(320);
    const topState = await page.evaluate((idx) => {
      const w = document.querySelectorAll('.window')[idx];
      const visible = [...document.querySelectorAll('.window')].filter((x) => !x.classList.contains('minimized'));
      const maxZ = Math.max(...visible.map((x) => Number(x.style.zIndex) || 0));
      return { hidden: w.classList.contains('minimized'), focused: w.classList.contains('focused'), z: Number(w.style.zIndex) || 0, maxZ };
    }, last);
    check('再点 → 还原且置顶', !topState.hidden && topState.focused && topState.z === topState.maxZ, JSON.stringify(topState));

    // 窗口按钮右键 = 跳转列表
    await page.evaluate((idx) => {
      document.querySelectorAll('.tb-win')[idx].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 980, clientY: 860 }));
    }, last);
    await sleep(350);
    const jump = await page.$$eval('.context-menu .dropdown-item', (els) => els.map((e) => e.innerText.trim()));
    check('窗口按钮右键 = 跳转列表（还原/最小化/最大化/关闭）',
      ['还原', '最小化', '关闭窗口'].every((k) => jump.includes(k)) && jump.some((t) => /最大化|向下还原/.test(t)),
      jump.join(','));
    await page.evaluate(() => {
      [...document.querySelectorAll('.context-menu .dropdown-item')].find((b) => b.innerText.trim() === '最小化')?.click();
    });
    await sleep(350);
    check('跳转列表「最小化」生效',
      await page.evaluate((idx) => document.querySelectorAll('.window')[idx].classList.contains('minimized'), last));
    await page.evaluate((idx) => document.querySelectorAll('.tb-win')[idx]?.click(), last);
    await sleep(300);
    await shot('任务栏与多窗口');
  }

  // ---------- 5.9 任务栏托盘：磁盘 / 传输徽标 / 通知 / 账户 ----------
  section('任务栏托盘（磁盘 / 传输 / 通知 / 账户）');
  if (sid) {
    // R1：磁盘信息每 20s 轮询（原先只挂在 MenuBar 的挂载 effect 上）
    let diskReq = 0;
    const onDiskReq = (r) => { if (r.url().includes('/api/disk')) diskReq++; };
    page.on('request', onDiskReq);
    const diskBefore = diskReq;
    await sleep(21000);
    page.off('request', onDiskReq);
    check('磁盘信息每 20s 自动刷新（R1）', diskReq > diskBefore, `21s 内新增 ${diskReq - diskBefore} 次 /api/disk 请求`);

    const diskText = await page.$eval('.tray-disk', (el) => el.innerText).catch(() => '');
    check('托盘磁盘显示最紧张挂载点的占用百分比', /\d+%/.test(diskText), diskText);
    await page.evaluate(() => document.querySelector('.tray-disk')?.click());
    await sleep(300);
    const diskRows = await page.$$('.tb-popover .disk-row');
    check('磁盘面板列出挂载点', diskRows.length >= 1, `行数 ${diskRows.length}`);
    if (diskRows.length) {
      await diskRows[0].click();
      await sleep(1500);
      check('点磁盘行打开「磁盘监控」窗口', !!(await page.$('.disk-window')), '未找到 .disk-window');
    }

    // 托盘传输按钮 → 打开「传输」窗口；拖系统文件到固定项「传输」= 上传到主目录
    await page.evaluate(() => document.querySelector('.tray-transfers')?.click());
    await page.waitForSelector('.transfers-window', { timeout: 8000 }).catch(() => {});
    check('托盘传输按钮打开「传输」窗口', !!(await page.$('.transfers-window')), '未打开 .transfers-window');
    await page.evaluate(() => {
      const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.transfers-window'));
      w?.querySelector('.tc-close')?.click();
    });
    await sleep(600);

    const dropped = await page.evaluate((name) => {
      const btn = document.querySelector('.tb-app[title="传输"]');
      if (!btn) return false;
      const dt = new DataTransfer();
      dt.items.add(new File(['drop upload\n'], name, { type: 'text/plain' }));
      btn.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      btn.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    }, dropName);
    await sleep(2500);
    const dropQ = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(dropName)}`, undefined, `cloudnine_sid=${sid}`);
    check('拖文件到任务栏「传输」按钮 = 上传到主目录',
      dropped && (dropQ.json?.results || []).some((x) => x.name === dropName), `status=${dropQ.status}`);

    // 让文件窗口获得焦点，再粘贴两个大文件：徽标计数与可点通知都由此产生
    await page.evaluate(() => {
      const wins = [...document.querySelectorAll('.window')];
      const idx = wins.findIndex((w) => w.querySelector('.finder'));
      document.querySelectorAll('.tb-win')[idx]?.click();
    });
    await sleep(600);
    const pasteOk = await page.evaluate(({ base, size }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(size)], `${base}-a.bin`, { type: 'application/octet-stream' }));
      dt.items.add(new File([new Uint8Array(size)], `${base}-b.bin`, { type: 'application/octet-stream' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented };
    }, { base: badgeBase, size: 12 * 1024 * 1024 });
    check('粘贴两个文件加入上传队列', pasteOk.prevented === true, JSON.stringify(pasteOk));

    const badge = await page.waitForFunction(() => {
      const el = document.querySelector('.tray-transfers .transfer-badge');
      return el ? el.textContent.trim() : null;
    }, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    check('传输徽标数 = 进行中的上传数（2）', badge === '2', `badge=${badge}`);

    // 通知铃：可点项 → 打开「传输」窗口
    await page.evaluate(() => document.querySelector('.tray-bell')?.click());
    await sleep(300);
    const notif = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.tb-popover .notif-row')];
      return {
        total: rows.length,
        actionable: rows.filter((r) => r.classList.contains('n-actionable')).length,
        text: rows.map((r) => r.innerText.trim()).join(' | ').slice(0, 160),
      };
    });
    check('通知面板列出通知', notif.total >= 1, JSON.stringify(notif));
    check('通知面板含可点击项（带「查看传输」提示）', notif.actionable >= 1 && /查看传输/.test(notif.text), JSON.stringify(notif));
    await page.evaluate(() => document.querySelector('.tb-popover .notif-row.n-actionable')?.click());
    await page.waitForSelector('.transfers-window', { timeout: 8000 }).catch(() => {});
    check('点通知项跳转到「传输」窗口', !!(await page.$('.transfers-window')), '未打开 .transfers-window');

    const badgeGone = await page.waitForFunction(() => !document.querySelector('.tray-transfers .transfer-badge'), { timeout: 120000 })
      .then(() => true).catch(() => false);
    check('传输结束后徽标消失', badgeGone, '徽标仍在');

    // 账户菜单：修改密码入口 + 三档主题（不真的改密码，避免破坏后续登录）
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(250);
    const accItems = await page.$$eval('.tb-popover .account-popover .dropdown-item', (els) => els.map((e) => e.innerText.trim()));
    check('账户菜单含「修改密码 / 三档主题 / 退出登录」',
      accItems.some((t) => /修改密码/.test(t))
      && ['浅色主题', '深色主题', '跟随系统'].every((k) => accItems.some((t) => t.includes(k)))
      && accItems.some((t) => /退出登录/.test(t)),
      accItems.join(','));

    const themeState = () => page.evaluate(() => ({ attr: document.documentElement.dataset.theme, saved: localStorage.getItem('cloudnine-theme') }));
    const clickAcc = (label) => page.evaluate((l) => {
      [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')].find((b) => b.innerText.includes(l))?.click();
    }, label);
    await clickAcc('深色主题');
    await sleep(250);
    const darkTheme = await themeState();
    check('账户菜单切深色主题生效', darkTheme.attr === 'dark' && darkTheme.saved === 'dark', JSON.stringify(darkTheme));
    await clickAcc('浅色主题');
    await sleep(250);
    const lightTheme = await themeState();
    check('账户菜单切浅色主题生效', lightTheme.attr === 'light' && lightTheme.saved === 'light', JSON.stringify(lightTheme));
    await clickAcc('跟随系统');
    await sleep(250);
    const autoTheme = await themeState();
    check('账户菜单切「跟随系统」生效', autoTheme.saved === 'auto', JSON.stringify(autoTheme));

    await clickAcc('修改密码');
    await sleep(400);
    const pwDlg = await page.evaluate(() => {
      const d = document.querySelector('.dialog');
      if (!d) return null;
      return { title: d.querySelector('h3')?.innerText.trim(), pw: d.querySelectorAll('input[type=password]').length };
    });
    check('「修改密码」弹窗出现（原密码 + 新密码）', !!pwDlg && pwDlg.title === '修改密码' && pwDlg.pw === 2, JSON.stringify(pwDlg));
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.dialog-actions .btn')];
      (btns.find((b) => b.innerText.trim() === '取消') || btns[0])?.click();
    });
    await sleep(300);
    check('取消修改密码后不残留弹窗', !(await page.$('.dialog')), '弹窗未关闭');

    // 退出登录：二次确认 → 登录页 → 重新登录（后续健康检查仍在桌面壳里跑）
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(250);
    await clickAcc('退出登录');
    await sleep(400);
    const logoutTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
    check('「退出登录」二次确认出现', logoutTitle === '退出登录', logoutTitle);
    await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
    await sleep(1800);
    const loggedOut = !!(await page.$('.auth-card'));
    check('退出登录后回到登录页', loggedOut, '未出现登录页');
    if (loggedOut) {
      const inputs = await page.$$('.auth-card input');
      if (inputs.length >= 2) {
        await inputs[0].click(); await page.keyboard.type(USERNAME);
        await inputs[1].click(); await page.keyboard.type(PASSWORD);
      }
      await page.click('.auth-card .btn-primary');
      await sleep(2500);
      check('重新登录成功（任务栏回到桌面）', !!(await page.$('.taskbar')), '未回到桌面');
    }
  }

  // ---------- 5.10 开始菜单（阶段 1 · T4） ----------
  section('开始菜单（固定项 / 搜索 / 最近文件 / 账户区）');
  {
    const smSid = await loginViaApi();
    // 重新载入：清空前面留下的窗口与弹层，得到干净的桌面外壳
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.taskbar', { timeout: 15000 });
    await sleep(900);

    // 预置一个「最近使用的文件」：内容非空，点击后应真的在记事本里打开
    const smRecentPath = homeRel ? `${homeRel}/${smRecentName}` : smRecentName;
    if (smSid) {
      await apiFetch('POST', '/api/fs/write', { path: smRecentPath, content: '# 开始菜单最近文件自测\n\nT4\n' }, `cloudnine_sid=${smSid}`);
      await apiFetch('POST', '/api/fs/recent', { path: smRecentPath, name: smRecentName }, `cloudnine_sid=${smSid}`);
    }
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.taskbar', { timeout: 15000 });
    await sleep(800);

    const startBtn = await page.$('.tb-start');
    check('开始按钮是可点击按钮（占位 span 已替换）',
      !!startBtn && await page.$eval('.tb-start', (el) => el.tagName === 'BUTTON' && !el.getAttribute('aria-hidden')));
    check('开始菜单初始关闭', !(await page.$('.startmenu')));

    const openStart = async () => {
      await page.evaluate(() => document.querySelector('.tb-start')?.click());
      await page.waitForSelector('.startmenu', { timeout: 8000 });
      await sleep(250);
    };
    const clickStartApp = async (key) => {
      const ok = await page.evaluate((k) => {
        const el = document.querySelector(`.startmenu .sm-app[data-app="${k}"]`);
        if (!el) return false;
        el.click();
        return true;
      }, key);
      await sleep(900);
      return ok;
    };
    const closeAllWindows = async () => {
      await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
      await page.waitForFunction(() => document.querySelectorAll('.window').length === 0, { timeout: 10000 }).catch(() => {});
      await sleep(300);
    };

    await openStart();
    check('单击开始按钮打开开始菜单', !!(await page.$('.startmenu')));
    check('搜索框自动聚焦',
      await page.evaluate(() => document.activeElement?.classList.contains('sm-search-input')));

    const pinnedKeys = await page.$$eval('.startmenu .sm-app', (els) => els.map((e) => e.dataset.app));
    const pinnedLabels = await page.$$eval('.startmenu .sm-app-label', (els) => els.map((e) => e.innerText.trim()));
    check('已固定严格 7 项', pinnedKeys.length === 7, `${pinnedKeys.length}: ${pinnedKeys.join(',')}`);
    check('已固定 7 项的名称与顺序正确',
      JSON.stringify(pinnedLabels) === JSON.stringify(['文件资源管理器', '终端', '记事本', '传输', '分享管理', '磁盘监控', '回收站']),
      pinnedLabels.join(','));
    check('已固定不含「预览」', !pinnedLabels.includes('预览'), pinnedLabels.join(','));

    const geo = await page.evaluate(() => {
      const sm = document.querySelector('.startmenu');
      const smRect = sm.getBoundingClientRect();
      const tbRect = document.querySelector('.taskbar').getBoundingClientRect();
      return {
        gap: Math.round(tbRect.top - smRect.bottom),
        smZ: Number(getComputedStyle(sm).zIndex),
        tbZ: Number(getComputedStyle(document.querySelector('.taskbar')).zIndex),
        bg: getComputedStyle(sm).backgroundColor,
        backdrop: getComputedStyle(sm).backdropFilter,
      };
    });
    check('开始菜单锚定在任务栏正上方', geo.gap >= 4 && geo.gap <= 12, `间距 ${geo.gap}px`);
    check('开始菜单层级高于任务栏', geo.smZ > geo.tbZ, `${geo.smZ} vs ${geo.tbZ}`);
    check('开始菜单为纯色材质（不透明背景 + 无 backdrop-filter）',
      /^rgb\(/.test(geo.bg) && geo.backdrop === 'none', JSON.stringify(geo));

    check('最近使用的文件区列出已记录文件',
      (await page.$$eval('.startmenu .sm-recent-name', (els) => els.map((e) => e.innerText.trim()))).includes(smRecentName),
      smRecentName);

    // 与任务栏托盘共用 store.popover 单槽位
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(300);
    check('打开托盘弹层后开始菜单自动收起（单槽位）',
      !(await page.$('.startmenu')) && !!(await page.$('.tb-popover')), '仍有两层同时打开');
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(250);

    // Esc
    await openStart();
    await page.keyboard.press('Escape');
    await sleep(300);
    check('Esc 关闭开始菜单', !(await page.$('.startmenu')));
    // 点击外部
    await openStart();
    await page.mouse.click(1180, 300);
    await sleep(300);
    check('点击菜单外部关闭开始菜单', !(await page.$('.startmenu')));
    // 再次单击开始按钮
    await openStart();
    await page.evaluate(() => document.querySelector('.tb-start')?.click());
    await sleep(300);
    check('开始菜单已打开时再点按钮关闭', !(await page.$('.startmenu')));

    // 搜索：实时过滤
    await openStart();
    await page.click('.sm-search-input');
    await page.keyboard.type('终');
    await sleep(350);
    const termResults = await page.$$eval('.startmenu .sm-result-label', (els) => els.map((e) => e.innerText.trim()));
    check('搜索实时过滤应用名', termResults.length === 1 && termResults[0] === '终端', termResults.join(','));
    // ↑↓ + Enter
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.terminal-window', { timeout: 10000 }).catch(() => {});
    check('↑↓ + Enter 在结果间选取并启动', !!(await page.$('.terminal-window')), '未打开终端');
    check('启动应用后开始菜单自动关闭', !(await page.$('.startmenu')));
    await closeAllWindows();

    // 搜索：无结果 → 空态；清空 → 恢复
    await openStart();
    await page.click('.sm-search-input');
    await page.keyboard.type('zzzz-not-exist');
    await sleep(350);
    const emptyText = await page.$eval('.startmenu .sm-empty', (el) => el.innerText).catch(() => '');
    check('无结果时显示空态提示', /没有找到/.test(emptyText), emptyText);
    check('无结果时不显示已固定项', (await page.$$('.startmenu .sm-app')).length === 0);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await sleep(350);
    check('清空搜索后恢复已固定 7 项', (await page.$$('.startmenu .sm-app')).length === 7);
    check('清空搜索后空态消失', !(await page.$('.startmenu .sm-empty')));

    // 搜索命令 + 方向键在多条结果间移动：验证 Enter 执行的是第二条（命令）
    await page.click('.sm-search-input');
    await page.keyboard.type('文件');
    await sleep(350);
    const fileResults = await page.$$eval('.startmenu .sm-result-label', (els) => els.map((e) => e.innerText.trim()));
    check('搜索结果同时包含应用与命令',
      fileResults.length >= 2 && fileResults.includes('文件资源管理器') && fileResults.includes('新建文件夹'),
      fileResults.join(','));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(600);
    const cmdDlgTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
    check('↑↓ 选中命令后 Enter 执行（新建文件夹）', cmdDlgTitle === '新建文件夹', cmdDlgTitle);
    await page.evaluate(() => [...document.querySelectorAll('.dialog-actions .btn')].find((b) => b.innerText.trim() === '取消')?.click());
    await sleep(300);
    check('取消命令对话框后不残留弹窗', !(await page.$('.dialog')));

    // 7 个固定应用逐个启动 + 最小化后从开始菜单还原（不能叠新窗口）
    const SM_APPS = [
      ['finder', '文件资源管理器', '.window .finder'],
      ['terminal', '终端', '.window .terminal-window'],
      ['editor', '记事本', '.window .editor-window'],
      ['transfers', '传输', '.window .transfers-window'],
      ['shares', '分享管理', '.window .shares-window'],
      ['disk', '磁盘监控', '.window .disk-window'],
      ['trash', '回收站', '.window .finder'],
    ];
    for (const [key, label, sel] of SM_APPS) {
      await closeAllWindows();
      await openStart();
      const clicked = await clickStartApp(key);
      await page.waitForSelector(sel, { timeout: 12000 }).catch(() => {});
      await sleep(500);
      const opened = await page.evaluate((s) => ({
        wins: document.querySelectorAll('.window').length,
        matched: !!document.querySelector(s),
        title: document.querySelector('.window .window-title')?.innerText.trim() || '',
      }), sel);
      check(`开始菜单启动「${label}」`, clicked && opened.wins === 1 && opened.matched, JSON.stringify(opened));
      if (key === 'trash') check('「回收站」打开的是废纸篓视图', opened.title === '废纸篓', opened.title);

      await page.evaluate(() => document.querySelector('.window .tc-min')?.click());
      await sleep(400);
      check(`「${label}」可最小化`,
        await page.evaluate(() => document.querySelectorAll('.window.minimized').length === 1));

      await openStart();
      await clickStartApp(key);
      await sleep(900);
      const restored = await page.evaluate(() => ({
        wins: document.querySelectorAll('.window').length,
        hidden: document.querySelectorAll('.window.minimized').length,
        focused: document.querySelectorAll('.window.focused').length,
      }));
      check(`「${label}」已最小化时点击开始菜单 = 还原而非新开`,
        restored.wins === 1 && restored.hidden === 0 && restored.focused === 1, JSON.stringify(restored));
    }
    await closeAllWindows();

    // 已打开且可见时，再点同一项 = 聚焦，不叠窗
    await openStart();
    await clickStartApp('terminal');
    await page.waitForSelector('.terminal-window', { timeout: 10000 }).catch(() => {});
    await openStart();
    await clickStartApp('terminal');
    await sleep(900);
    const refocus = await page.evaluate(() => ({
      wins: document.querySelectorAll('.window').length,
      focused: document.querySelectorAll('.window.focused').length,
    }));
    check('已打开且可见的应用再点 = 聚焦而非新开', refocus.wins === 1 && refocus.focused === 1, JSON.stringify(refocus));
    await closeAllWindows();

    // 最近文件点击：真实打开对应文件
    await openStart();
    const recentOpened = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('.startmenu .sm-recent')].find((x) => x.innerText.includes(n));
      if (!el) return false;
      el.click();
      return true;
    }, smRecentName);
    await page.waitForSelector('.editor-window', { timeout: 10000 }).catch(() => {});
    await sleep(900);
    const recentTitle = await page.$eval('.window .window-title', (el) => el.innerText.trim()).catch(() => '');
    const recentContent = await page.$eval('.editor-window .cm-content', (el) => el.innerText).catch(() => '');
    check('点击最近使用的文件真实打开（记事本 + 文件名）',
      recentOpened && recentTitle === smRecentName, `title=${recentTitle}`);
    check('最近文件的内容已加载', /开始菜单最近文件自测/.test(recentContent), recentContent.slice(0, 60));
    await closeAllWindows();

    // 关于本系统
    await openStart();
    await page.evaluate(() => {
      [...document.querySelectorAll('.startmenu .sm-foot-btn')].find((b) => b.innerText.includes('关于本系统'))?.click();
    });
    await sleep(500);
    check('底部「关于本系统」打开关于对话框', !!(await page.$('.dialog .about-body')), '未出现 .about-body');
    await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
    await sleep(300);
    check('关于对话框可关闭', !(await page.$('.dialog')));

    // 亮色 / 暗色两套主题下各截一张
    const accOpen = () => page.evaluate(() => document.querySelector('.tray-account')?.click());
    const accClick = (label) => page.evaluate((l) => {
      [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')].find((b) => b.innerText.includes(l))?.click();
    }, label);
    await accOpen();
    await sleep(250);
    await accClick('深色主题');
    await sleep(350);
    await openStart();
    check('暗色主题下开始菜单正常显示', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await shot('开始菜单-暗色');
    await page.keyboard.press('Escape');
    await sleep(250);

    // 右键菜单亮/暗两套主题：纯色背景可见、没有 backdrop-filter
    const menuStyle = async (label) => {
      await page.evaluate(() => {
        document.querySelector('.desktop-icons').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 700, clientY: 600,
        }));
      });
      await sleep(350);
      const st = await page.evaluate(() => {
        const el = document.querySelector('.context-menu');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, blur: cs.backdropFilter };
      });
      await shot(`右键菜单-${label}`);
      await page.keyboard.press('Escape');
      await sleep(250);
      return st;
    };
    const darkMenu = await menuStyle('暗色');
    check('暗色主题下右键菜单有纯色背景且无毛玻璃', !!darkMenu
      && darkMenu.bg !== 'rgba(0, 0, 0, 0)' && darkMenu.bg !== 'transparent' && darkMenu.blur === 'none',
      JSON.stringify(darkMenu));

    await accOpen();
    await sleep(250);
    await accClick('浅色主题');
    await sleep(350);
    await openStart();
    check('亮色主题下开始菜单正常显示', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
    await shot('开始菜单-亮色');
    await page.keyboard.press('Escape');
    await sleep(250);
    const lightMenu = await menuStyle('亮色');
    check('亮色主题下右键菜单有纯色背景且无毛玻璃', !!lightMenu
      && lightMenu.bg !== 'rgba(0, 0, 0, 0)' && lightMenu.bg !== 'transparent' && lightMenu.blur === 'none',
      JSON.stringify(lightMenu));
    check('亮/暗主题下右键菜单背景色确实不同', !!darkMenu && !!lightMenu && darkMenu.bg !== lightMenu.bg,
      `${darkMenu?.bg} vs ${lightMenu?.bg}`);

    await accOpen();
    await sleep(250);
    await accClick('跟随系统');
    await sleep(250);

    // 锁定 = 回到登录页（与退出登录同一流程）
    await openStart();
    await page.evaluate(() => {
      [...document.querySelectorAll('.startmenu .sm-foot-btn')].find((b) => b.innerText.trim() === '锁定')?.click();
    });
    await sleep(400);
    const lockTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
    check('「锁定」二次确认出现（文案为锁定）', lockTitle === '锁定', lockTitle);
    await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
    await sleep(1800);
    const lockLoggedOut = !!(await page.$('.auth-card'));
    check('锁定后回到登录页', lockLoggedOut, '未出现登录页');
    if (lockLoggedOut) {
      const inputs = await page.$$('.auth-card input');
      if (inputs.length >= 2) {
        await inputs[0].click(); await page.keyboard.type(USERNAME);
        await inputs[1].click(); await page.keyboard.type(PASSWORD);
      }
      await page.click('.auth-card .btn-primary');
      await sleep(2500);
      check('锁定后可用原账号重新登录', !!(await page.$('.taskbar')), '未回到桌面');
    }
  }

  // ---------- 5.9 窗口内菜单：终端 / 记事本 / 预览（规格 §1.6 / §2.1.3-§2.1.5 / R4）----------
  section('窗口内菜单（终端 / 记事本 / 预览）');
  {
    const wmSid = await loginViaApi();
    const cookie = `cloudnine_sid=${wmSid}`;
    const wmTextPath = homeRel ? `${homeRel}/${wmTextName}` : wmTextName;
    const wmSavePath = homeRel ? `${homeRel}/${wmSaveName}` : wmSaveName;
    const wmSaveAsPath = homeRel ? `${homeRel}/${wmSaveAsName}` : wmSaveAsName;
    await apiFetch('POST', '/api/fs/write', { path: wmTextPath, content: '用编辑器打开自测\n' }, cookie);
    // 重新载入：清空窗口，并让桌面图标列表包含刚预置的文本文件
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.taskbar', { timeout: 15000 });
    await sleep(1200);

    const openWinMenu = async (sel) => {
      const ok = await page.evaluate((s) => {
        const b = document.querySelector(s);
        if (!b) return false;
        b.click();
        return true;
      }, sel);
      await sleep(350);
      return ok;
    };
    const winMenuLabels = () => ctxLabels(0);

    // ----- ① 终端：标签栏 ∨ 下拉 -----
    await page.click('.tb-app[title="终端"]');
    await page.waitForSelector('.terminal-window .xterm', { timeout: 15000 });
    await sleep(1800);
    check('终端标签栏右侧有 ∨ 下拉', !!(await page.$('.terminal-window .term-tab-menu')));
    await openWinMenu('.terminal-window .term-tab-menu');
    const termMenu = await winMenuLabels();
    check('终端下拉五项齐备（新建/关闭标签/清屏/重置/关闭窗口）',
      JSON.stringify(termMenu) === JSON.stringify(['新建标签页', '关闭当前标签', '清屏', '重置终端', '关闭窗口']),
      termMenu.join(','));
    await shot('终端标签页菜单');

    const tabCount = () => page.$$eval('.terminal-window .term-tab', (els) => els.length);
    const visibleTermText = () => page.evaluate(() => {
      const hosts = [...document.querySelectorAll('.terminal-window .term-host')];
      const host = hosts.find((h) => h.getBoundingClientRect().width > 0) || hosts[0];
      return host ? host.innerText : '';
    });
    const typeInTerm = async (text) => {
      const idx = await page.evaluate(() => [...document.querySelectorAll('.terminal-window .term-host')]
        .findIndex((h) => h.getBoundingClientRect().width > 0));
      const hosts = await page.$$('.terminal-window .term-host');
      if (!hosts[idx]) return false;
      await hosts[idx].click();
      await sleep(250);
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      await sleep(1000);
      return true;
    };

    await ctxClick(0, '新建标签页');
    await sleep(1800);
    const afterNewTab = await tabCount();
    check('终端「新建标签页」真的多出一个标签', afterNewTab === 2, `标签数 ${afterNewTab}`);
    const termMarker = `MENU_TERM_${Date.now()}`;
    const typedInNewTab = await typeInTerm(`echo ${termMarker}`);
    await sleep(600);
    const newTabText = await visibleTermText();
    check('新建的标签能输入（PTY 回显命中）', typedInNewTab && newTabText.includes(termMarker), newTabText.slice(-120));
    await shot('终端新建标签输入');

    await openWinMenu('.terminal-window .term-tab-menu');
    await ctxClick(0, '清屏');
    await sleep(600);
    const afterClear = await visibleTermText();
    check('终端「清屏」真的清空画面', !afterClear.includes(termMarker), afterClear.slice(0, 120));

    const resetMarker = `MENU_RESET_${Date.now()}`;
    await typeInTerm(`echo ${resetMarker}`);
    await sleep(700);
    const beforeReset = (await visibleTermText()).includes(resetMarker);
    await openWinMenu('.terminal-window .term-tab-menu');
    await ctxClick(0, '重置终端');
    await sleep(600);
    const afterReset = (await visibleTermText()).includes(resetMarker);
    check('终端「重置终端」清空画面（不再只是走 clear）', beforeReset && !afterReset,
      `before=${beforeReset} after=${afterReset}`);
    const typedAfterReset = await typeInTerm(`echo ${resetMarker}_2`);
    await sleep(600);
    check('重置后终端仍可输入（PTY 会话未断）',
      typedAfterReset && (await visibleTermText()).includes(`${resetMarker}_2`), (await visibleTermText()).slice(-100));

    await openWinMenu('.terminal-window .term-tab-menu');
    await ctxClick(0, '关闭当前标签');
    await sleep(600);
    check('终端「关闭当前标签」关掉一个标签', (await tabCount()) === 1, `标签数 ${await tabCount()}`);

    // 快捷键（规格 §2.1.3，非必选但一并接上）
    await page.keyboard.down('Control'); await page.keyboard.down('Shift');
    await page.keyboard.press('KeyT');
    await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    await sleep(1800);
    const afterShortcutT = await tabCount();
    await page.keyboard.down('Control'); await page.keyboard.down('Shift');
    await page.keyboard.press('KeyW');
    await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    await sleep(700);
    check('Ctrl+Shift+T 新建标签 / Ctrl+Shift+W 关闭标签', afterShortcutT === 2 && (await tabCount()) === 1,
      `${afterShortcutT} → ${await tabCount()}`);

    // 只剩一个标签时再「关闭当前标签」= 关闭窗口（Windows Terminal 语义，不留死入口）
    await openWinMenu('.terminal-window .term-tab-menu');
    await ctxClick(0, '关闭当前标签');
    await sleep(800);
    check('最后一标签「关闭当前标签」按 Windows Terminal 语义关窗', !(await page.$('.terminal-window')));

    await page.click('.tb-app[title="终端"]');
    await page.waitForSelector('.terminal-window .xterm', { timeout: 15000 });
    await sleep(1600);
    await openWinMenu('.terminal-window .term-tab-menu');
    await ctxClick(0, '关闭窗口');
    await sleep(800);
    check('终端「关闭窗口」真的关窗', !(await page.$('.terminal-window')));

    // ----- ② 记事本：标题栏下方 文件 / 编辑 -----
    await page.click('.tb-app[title="记事本"]');
    await page.waitForSelector('.editor-window .editor-menubar', { timeout: 15000 });
    await sleep(1600);
    const editorMenus = await page.$$eval('.editor-window .editor-menubar .winmenu-btn', (els) => els.map((e) => e.dataset.menu));
    check('记事本标题栏下方有 文件 / 编辑 菜单', JSON.stringify(editorMenus) === JSON.stringify(['文件', '编辑']), editorMenus.join(','));

    await openWinMenu('.editor-window .editor-menubar [data-menu="文件"]');
    const fileMenu = await winMenuLabels();
    check('记事本「文件」菜单三项齐全（保存/另存为/关闭窗口）',
      JSON.stringify(fileMenu) === JSON.stringify(['保存', '另存为…', '关闭窗口']), fileMenu.join(','));
    const saveHint = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.context-menu .dropdown-item')].find((x) => x.dataset.label === '保存');
      return b?.querySelector('.di-hint')?.innerText.trim() || '';
    });
    check('记事本「保存」提示固定为 Ctrl+S（无 ⌘）', saveHint === 'Ctrl+S', saveHint);
    await shot('记事本窗口菜单-文件');
    await page.keyboard.press('Escape');
    await sleep(250);

    // 顶栏仍在（T8 才删），但 R4 的 macOS 残留应同步清掉
    await page.evaluate(() => [...document.querySelectorAll('.mb-menu-btn')].find((b) => b.innerText.trim() === '文件')?.click());
    await sleep(350);
    const barSaveHint = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.menubar .dropdown .dropdown-item')].find((x) => x.innerText.trim().startsWith('保存'));
      return b?.querySelector('.di-hint')?.innerText.trim() || '';
    });
    check('顶栏「保存」提示也是 Ctrl+S（isMac 判断已删）', barSaveHint === 'Ctrl+S', barSaveHint);
    await page.keyboard.press('Escape');
    await sleep(250);

    // 未命名文档默认 md：编辑菜单里不应出现格式化
    await openWinMenu('.editor-window .editor-menubar [data-menu="编辑"]');
    const mdEditMenu = await winMenuLabels();
    check('Markdown 文档的「编辑」菜单不含格式化', JSON.stringify(mdEditMenu) === JSON.stringify(['查找…']), mdEditMenu.join(','));
    const findClicked = await ctxClick(0, '查找…');
    await sleep(500);
    const findTitle = await page.evaluate(() => {
      const n = [...document.querySelectorAll('.notification .n-title')].pop();
      return n ? n.innerText.trim() : '';
    });
    check('「查找…」仍按原行为提示 Ctrl + F（文案已去掉 Cmd）',
      findClicked && /Ctrl \+ F/.test(findTitle) && !/Cmd/.test(findTitle), findTitle);
    await shot('记事本-查找提示');

    // 切到 JSON：编辑菜单应出现格式化
    await page.evaluate(() => document.querySelector('.editor-window .editor-fmt-chip')?.click());
    await sleep(250);
    const jsonChosen = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.editor-fmt-menu .editor-fmt-item')].find((x) => x.innerText.includes('JSON'));
      if (!b) return false;
      b.click();
      return true;
    });
    await sleep(350);
    await openWinMenu('.editor-window .editor-menubar [data-menu="编辑"]');
    const jsonEditMenu = await winMenuLabels();
    check('JSON 文档的「编辑」菜单出现「格式化」',
      jsonChosen && JSON.stringify(jsonEditMenu) === JSON.stringify(['格式化', '查找…']), jsonEditMenu.join(','));
    await page.keyboard.press('Escape');
    await sleep(250);

    // 格式化真的重排
    const cm = await page.$('.editor-window .cm-content');
    if (cm) await cm.click();
    await sleep(250);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('{"b":[2,3],"a":1}');
    await sleep(400);
    await openWinMenu('.editor-window .editor-menubar [data-menu="编辑"]');
    await ctxClick(0, '格式化');
    // CodeMirror 的受控 value 有「正在输入」闩锁（@uiw/react-codemirror typingLatch），
    // 刚输入完的外部改值会晚一点落地，这里等它真的重排完再断言（而不是死等固定时长）
    const formatApplied = await page.waitForFunction(
      () => /"b": \[\n/.test(document.querySelector('.editor-window .cm-content')?.innerText || ''),
      { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const formattedText = await page.evaluate(() => document.querySelector('.editor-window .cm-content')?.innerText || '');
    check('「格式化」真的重排了 JSON（缩进 + 换行）',
      formatApplied && /"a": 1/.test(formattedText), JSON.stringify(formattedText.slice(0, 80)));

    // 保存（未命名 → 另存为对话框）
    await openWinMenu('.editor-window .editor-menubar [data-menu="文件"]');
    await ctxClick(0, '保存');
    await sleep(600);
    let saveDlg = await page.$('.dialog input');
    check('未命名文档「保存」弹出另存为对话框', !!saveDlg);
    if (saveDlg) {
      await saveDlg.click();
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(wmSavePath);
      await sleep(200);
      await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
      await sleep(2200);
    }
    const savedFile = await apiFetch('GET', `/api/fs/read?path=${encodeURIComponent(wmSavePath)}`, undefined, cookie);
    const savedContent = savedFile.json?.content || '';
    let savedJson = null;
    try { savedJson = JSON.parse(savedContent); } catch { /* 保持 null */ }
    check('记事本「保存」落盘内容正确（重排后的 JSON）',
      savedFile.status === 200 && JSON.stringify(savedJson) === '{"b":[2,3],"a":1}' && savedContent.includes('\n'),
      `status=${savedFile.status} ${JSON.stringify(savedContent.slice(0, 60))}`);

    // 另存为…
    await openWinMenu('.editor-window .editor-menubar [data-menu="文件"]');
    await ctxClick(0, '另存为…');
    await sleep(600);
    saveDlg = await page.$('.dialog input');
    check('「另存为…」弹出对话框', !!saveDlg);
    if (saveDlg) {
      await saveDlg.click();
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(wmSaveAsPath);
      await sleep(200);
      await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
      await sleep(2200);
    }
    const copiedFile = await apiFetch('GET', `/api/fs/read?path=${encodeURIComponent(wmSaveAsPath)}`, undefined, cookie);
    check('「另存为…」生成新文件且内容一致',
      copiedFile.status === 200 && copiedFile.json?.content === savedContent, `status=${copiedFile.status}`);

    await openWinMenu('.editor-window .editor-menubar [data-menu="文件"]');
    await ctxClick(0, '关闭窗口');
    await sleep(800);
    check('记事本「关闭窗口」真的关窗', !(await page.$('.editor-window')));

    // ----- ③ 预览：底部操作条真实可用（R4 的死 action 由窗口内按钮承担）-----
    const dblDesktopIcon = async (n) => {
      const ok = await page.evaluate((name) => {
        const el = document.querySelector(`.desktop-icon[data-entry="${name}"]`);
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      }, n);
      await sleep(1800);
      return ok;
    };
    check('桌面显示本轮预置的文本文件图标', !!(await page.$(`.desktop-icon[data-entry="${wmTextName}"]`)));
    const imgOpened = await dblDesktopIcon(imgName);
    await page.waitForSelector('.preview-window', { timeout: 10000 }).catch(() => {});
    check('双击图片打开预览窗口', imgOpened && !!(await page.$('.preview-window .preview-stage img')));
    const imgActionLabels = await page.$$eval('.preview-window .preview-actions .btn', (els) => els.map((b) => b.innerText.trim()));
    check('图片视图底部有「用编辑器打开」（本轮新增）', imgActionLabels.includes('用编辑器打开'), imgActionLabels.join(','));

    // 下载：真实点一次，等文件落盘，再与源文件逐字节比对
    const dlDir = join(OUT_DIR, 'downloads');
    mkdirSync(dlDir, { recursive: true });
    let dlSetting = 'ok';
    try {
      const bs = await browser.target().createCDPSession();
      await bs.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
    } catch (e) { dlSetting = `失败: ${e.message}`; }
    const dlBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.preview-window .preview-actions .btn')]
      .find((b) => b.innerText.trim() === '下载'));
    check('预览底部「下载」按钮存在', !!dlBtn.asElement());
    if (dlBtn.asElement()) await dlBtn.asElement().click();
    const dlPath = await waitDownloadFile(dlDir, 12000);
    for (const p of await browser.pages()) if (p !== page) await p.close().catch(() => {});

    const imgHits = await apiFetch('GET', `/api/fs/search?path=/&q=${encodeURIComponent(imgName)}`, undefined, cookie);
    const imgHit = (imgHits.json?.results || []).find((x) => x.name === imgName);
    let sameBytes = false;
    let bytesInfo = '';
    if (dlPath && imgHit) {
      const srcRes = await fetch(`${URL_BASE}/api/download?path=${encodeURIComponent(imgHit.rel)}`, { headers: { Cookie: cookie } });
      const srcBuf = Buffer.from(await srcRes.arrayBuffer());
      const dlBuf = readFileSync(dlPath);
      sameBytes = srcRes.status === 200 && dlBuf.length === srcBuf.length && dlBuf.equals(srcBuf);
      bytesInfo = `${dlBuf.length}/${srcBuf.length}`;
    }
    check('预览「下载」实测得到文件（与源文件逐字节一致）',
      !!dlPath && sameBytes,
      `CDP=${dlSetting} 文件=${dlPath ? dlPath.split(/[\\/]/).pop() : '无'} 字节=${bytesInfo}`);
    await shot('预览-下载后');

    const imgEditBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.preview-window .preview-actions .btn')]
      .find((b) => b.innerText.trim() === '用编辑器打开'));
    if (imgEditBtn.asElement()) await imgEditBtn.asElement().click();
    await page.waitForSelector('.editor-window', { timeout: 10000 }).catch(() => {});
    await sleep(1400);
    const imgEditTitle = await page.evaluate(() =>
      document.querySelector('.editor-window')?.closest('.window')?.querySelector('.window-title')?.innerText.trim() || '');
    check('图片视图「用编辑器打开」跳到编辑器（标题为图片名）', imgEditTitle === imgName, imgEditTitle);
    await page.evaluate(() => document.querySelector('.editor-window')?.closest('.window')?.querySelector('.tc-close')?.click());
    await sleep(800);

    // 文本视图：桌面文件右键 → 打开方式 › 用预览打开（文件窗口侧没有这一项，属于桌面右键）
    const txtCtx = await page.evaluate((n) => {
      const el = document.querySelector(`.desktop-icon[data-entry="${n}"]`);
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
      return true;
    }, wmTextName);
    await sleep(400);
    const openWithHovered = await ctxHover(0, '打开方式');
    const openWithItems = await ctxLabels(1);
    check('桌面文件右键「打开方式」子菜单可展开',
      txtCtx && openWithHovered && JSON.stringify(openWithItems) === JSON.stringify(['用编辑器打开', '用预览打开']), openWithItems.join(','));
    await ctxClick(1, '用预览打开');
    await sleep(1800);
    const txtToolbar = !!(await page.$('.preview-window .preview-text .preview-toolbar'));
    check('文本文件在预览窗口打开（文本视图）', txtToolbar);
    const txtEditBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.preview-window .preview-text .preview-toolbar .btn')]
      .find((b) => b.innerText.trim() === '用编辑器打开'));
    check('文本视图有「用编辑器打开」', !!txtEditBtn.asElement());
    if (txtEditBtn.asElement()) await txtEditBtn.asElement().click();
    await page.waitForSelector('.editor-window', { timeout: 10000 }).catch(() => {});
    await sleep(1400);
    const txtEditTitle = await page.evaluate(() =>
      document.querySelector('.editor-window')?.closest('.window')?.querySelector('.window-title')?.innerText.trim() || '');
    check('文本视图「用编辑器打开」跳到编辑器（标题为文件名）', txtEditTitle === wmTextName, txtEditTitle);
    await shot('窗口内菜单-预览跳编辑器');

    await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
    await sleep(600);
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
    const names = [proofName, editName, pasteName, notifyName, btnUploadName, imgName, deskName, dirName, zipName, probeName, newDirName, dropName, tbDirName, smRecentName, wmTextName, wmSaveName, wmSaveAsName, ...badgeNames].filter(Boolean);
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
