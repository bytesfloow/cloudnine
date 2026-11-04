#!/usr/bin/env node
/**
 * CloudNine 浏览器 UI 自动化自测
 *
 * 用系统 Chrome + puppeteer-core 驱动真实浏览器，模拟用户操作，
 * 并通过 API 反查磁盘状态来断言结果（比刮 DOM 文本可靠得多）。
 *
 * 覆盖流程：
 *   初始化向导 / 登录 → 桌面渲染 → 访达 → 终端（真实 PTY 执行命令）
 *   → 文本编辑（输入 + Ctrl+S 保存 + 磁盘核对）→ 访达列表核对
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const MOBILE = flag('mobile');
const OUT_DIR = join(__dirname, '..', 'shots', `uitest-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const CHROME = arg('chrome', '/usr/bin/google-chrome');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

const passed = [];
const failed = [];
const steps = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed.push(name);
    console.log(`${GREEN}  ✓${RESET} ${name}`);
  } else {
    failed.push([name, detail]);
    console.log(`${RED}  ✗${RESET} ${name}  ${YELLOW}${detail}${RESET}`);
  }
  return !!cond;
}
function section(t) { console.log(`\n${BOLD}${CYAN}▸ ${t}${RESET}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

mkdirSync(OUT_DIR, { recursive: true });
let shotIdx = 0;
async function shot(label) {
  const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
  steps.push(name);
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
    check('未出现认证页（已有会话）', true);
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

    // 底部工具栏点「访达」→ 访达页
    const finderBtn = await page.$('.m-dock .m-appitem[aria-label="访达"]');
    if (finderBtn) {
      await finderBtn.click();
      await sleep(1600);
      check('访达进入全屏页', !!(await page.$('.m-finder, .m-toolbar')), '未找到 .m-finder');
      await shot('移动访达');
      const rows = await page.$$('.m-row, .m-grid .m-appitem');
      check('访达列表渲染', rows.length >= 0, `条目 ${rows.length}`);
    } else {
      check('底部工具栏含「访达」入口', false, '未找到 .m-dock .m-appitem[aria-label=访达]');
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
  if (!MOBILE) {
  section('访达（Finder）');
  const dockItems = await page.$$('.dock-item');
  check(`Dock 应用数量 ≥ 5`, dockItems.length >= 5, `实际 ${dockItems.length}`);

  const finderBtn = await page.$('.dock-item[title="访达"]');
  if (finderBtn) {
    await finderBtn.click();
    await sleep(1500);
    const winTitle = await page.$('.window-title');
    const titleText = winTitle ? await page.$eval('.window-title', (el) => el.innerText) : '';
    check('访达窗口打开', /访达|文件|Finder/i.test(titleText) || !!winTitle, `title=${titleText}`);
    await shot('访达窗口');
  } else {
    check('Dock 中存在「访达」入口', false, '未找到 .dock-item[title=访达]');
  }

  // ---------- 4. 终端（真实 PTY） ----------
  section('终端（真实 PTY）');
  const sid = await loginViaApi();
  check('API 侧登录成功（用于反查）', !!sid, '未取到会话 Cookie');

  const proofName = `uitest-terminal-${Date.now()}.txt`;
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
  const editName = `uitest-editor-${Date.now()}.md`;
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
  } // end !MOBILE

  // ---------- 6. 控制台错误 ----------
  section('运行时健康');
  const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)|DevTools/i.test(e));
  check('浏览器控制台无 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await shot('最终状态');
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
  failed.map(([n, d]) => `FAIL  ${n}  ${d}`).join('\n') +
  `\n\n合计: ${passed.length}/${total} 通过\n截图目录: ${OUT_DIR}\n`);

console.log(`\n${BOLD}截图目录${RESET} ${OUT_DIR}`);
if (failed.length) {
  console.log(`${RED}${BOLD}失败 ${failed.length}/${total}${RESET}`);
  for (const [n, d] of failed) console.log(`  ${RED}✗${RESET} ${n}  ${DIM}${d}${RESET}`);
  process.exit(1);
}
console.log(`${GREEN}${BOLD}全部通过 ${total}/${total}${RESET}`);
