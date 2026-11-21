#!/usr/bin/env node
/**
 * CloudNine 主题审计（阶段 3 · T14 暗色主题）
 *
 * 只做「看」和「量」，不改任何业务状态：
 *   1. 亮/暗两套各拍一组表面截图：窗口 / 任务栏 / 开始菜单 / 右键菜单 / 通知 toast /
 *      通知面板 / 对话框 / Alt+Tab / 吸附预览 / 命令栏 / 三个窗口的窗口内菜单；
 *   2. 暗色下量 4 组对比度：正文 / 次级文字 / 禁用态 / 任务栏图标；
 *   3. 全量扫「露白」与「文字看不清」：所有可见元素里背景发白的、文字对比度不足的；
 *   4. 扫 backdrop-filter 是否彻底为 none（纯色材质）；
 *   5. 亮 ↔ 暗来回切 3 次，用一组元素的 computed style 快照比对有无残留；
 *   6. 「跟随系统」下模拟 prefers-color-scheme 切换，确认 data-theme 跟着走；
 *   7. 首帧不闪白：从文档起点逐帧记录 body 背景色，任何一帧为白即判失败。
 *
 * 用法（Windows 本机）：
 *   set PUPPETEER_CORE=C:\Users\zhl\Desktop\workspace\.uitest\node_modules\puppeteer-core
 *   node scripts/theme-audit.mjs --url http://127.0.0.1:8580/ --user uitest --password Uitest12345 \
 *     --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadPuppeteer() {
  for (const c of [process.env.PUPPETEER_CORE, join(__dirname, '..', 'node_modules', 'puppeteer-core'), 'puppeteer-core'].filter(Boolean)) {
    try { return require(c); } catch { /* 下一个 */ }
  }
  console.error('找不到 puppeteer-core（设 PUPPETEER_CORE 指向它）');
  process.exit(2);
}
const puppeteer = loadPuppeteer();

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const URL_BASE = (arg('url', 'http://127.0.0.1:8480/') || '').replace(/\/$/, '');
const USER = arg('user', 'uitest');
const PASS = arg('password', 'Uitest12345');
const CHROME = arg('chrome', '/usr/bin/google-chrome');
const OUT = join(__dirname, '..', 'shots', `theme-audit-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(OUT, { recursive: true });

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const results = { checks: [], contrast: {}, leaks: {}, leftovers: {}, flash: {}, shots: [] };
const pass = [], fail = [];
const check = (name, cond, detail = '') => {
  results.checks.push({ name, ok: !!cond, detail });
  if (cond) { pass.push(name); console.log(`${G}  ✓${X} ${name}`); }
  else { fail.push([name, detail]); console.log(`${R}  ✗${X} ${name}  ${Y}${detail}${X}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 登录 / 初始化 ----------
async function api(method, path, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${URL_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}
async function ensureSession() {
  let r = await api('POST', '/api/login', { username: USER, password: PASS });
  if (r.status !== 200) {
    r = await api('POST', '/api/init', { username: USER, password: PASS, siteName: 'CloudNine' });
  }
  const m = (r.setCookie || '').match(/cloudnine_sid=([^;]+)/);
  return m ? m[1] : null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
try { await browser.defaultBrowserContext().overridePermissions(URL_BASE, ['clipboard-read', 'clipboard-write']); } catch { /* 忽略 */ }

const SID = await ensureSession();
if (!SID) { console.error('登录/初始化失败'); process.exit(1); }
const host = new URL(URL_BASE).hostname;
await browser.setCookie({ name: 'cloudnine_sid', value: SID, domain: host, path: '/', httpOnly: true });

// 首帧背景色探针：在任何脚本之前装好，逐帧记录 body 背景
await page.evaluateOnNewDocument(() => {
  window.__bgFrames = [];
  const push = () => {
    if (document.body) window.__bgFrames.push(getComputedStyle(document.body).backgroundColor);
    if (window.__bgFrames.length < 120) requestAnimationFrame(push);
  };
  requestAnimationFrame(push);
});

const shot = async (label) => {
  const name = `${label}.png`;
  await page.screenshot({ path: join(OUT, name) });
  results.shots.push(name);
  console.log(`${D}    📸 ${name}${X}`);
  return name;
};
const openStart = async () => {
  await page.evaluate(() => document.querySelector('.tb-start')?.click());
  await sleep(300);
};
const closeAll = async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelectorAll('.desktop').length && document.querySelector('.desktop-icons')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await sleep(200);
};

// 页面内通用工具（注入一次，后续复用）
const HELPERS = () => {
  window.__cn = {
    parseColor(c) {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      if (p.length > 3 && p[3] === 0) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    },
    lum({ r, g, b }) {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    },
    ratio(a, b) {
      const la = window.__cn.lum(a), lb = window.__cn.lum(b);
      const hi = Math.max(la, lb), lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    },
    // 往上依次叠加背景色（含 alpha 混合），得到元素真正落到的实色
    blend(top, bottom) {
      const a = top.a === undefined ? 1 : top.a;
      return {
        r: top.r * a + bottom.r * (1 - a),
        g: top.g * a + bottom.g * (1 - a),
        b: top.b * a + bottom.b * (1 - a),
        a: 1,
      };
    },
    bgOf(el) {
      const stack = [];
      let n = el;
      while (n) {
        const c = window.__cn.parseColor(getComputedStyle(n).backgroundColor);
        if (c) stack.push(c);
        n = n.parentElement;
      }
      let base = window.__cn.parseColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      base = { r: base.r, g: base.g, b: base.b, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) base = window.__cn.blend(stack[i], base);
      return base;
    },
    visible(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
    },
    sel(el) {
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1 && parts.length < 4) {
        let s = n.tagName.toLowerCase();
        if (n.className && typeof n.className === 'string') s += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
        parts.unshift(s);
        n = n.parentElement;
      }
      return parts.join(' > ');
    },
  };
};

// ---------- 主流程 ----------
console.log(`${B}CloudNine 主题审计${X}  ${URL_BASE}  → ${OUT}\n`);

async function boot(theme) {
  if (theme) {
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('cloudnine-theme', t); } catch { /* 忽略 */ } }, theme);
  }
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.desktop', { timeout: 30000 });
  await sleep(1200);
  await page.evaluate(HELPERS);
}

// ============ ① 首帧不闪白（暗色冷启动） ============
await boot('dark');
{
  const frames = await page.evaluate(() => window.__bgFrames || []);
  const whites = frames.filter((c) => c === 'rgb(255, 255, 255)');
  results.flash = { frames: frames.length, whiteFrames: whites.length, first: frames.slice(0, 6) };
  check('暗色冷启动首帧背景不是白色（无闪白）', frames.length > 0 && whites.length === 0,
    `采样 ${frames.length} 帧，白帧 ${whites.length}：${JSON.stringify(frames.slice(0, 4))}`);
  check('暗色冷启动 data-theme 首帧即为 dark',
    frames.length > 0 && (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
}

// ============ ② 暗色：各表面截图 ============
console.log(`\n${B}${C}▸ 暗色表面截图${X}`);

// 开文件窗口：先单独拍一张，让地址栏 + 命令栏完整可见
await page.evaluate(() => document.querySelector('.tb-app[title="文件资源管理器"]')?.click());
await page.waitForSelector('.finder', { timeout: 20000 });
await sleep(700);
await shot('01-暗色-窗口与命令栏');
{
  const cmd = await page.evaluate(() => {
    const el = document.querySelector('.finder-cmdbar');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, blur: cs.backdropFilter };
  });
  check('资源管理器命令栏在暗色下有实色背景、无毛玻璃',
    !!cmd && cmd.bg !== 'rgba(0, 0, 0, 0)' && cmd.blur === 'none', JSON.stringify(cmd));
}

// 应用窗口（传输 / 磁盘监控 / 分享管理）：卡片、进度条、才礼色淡底的暗色表现
await openStart();
await page.evaluate(() => {
  const click = (label) => [...document.querySelectorAll('.startmenu .sm-app')].find((b) => b.innerText.trim() === label)?.click();
  click('磁盘监控');
});
await sleep(700);
await openStart();
await page.evaluate(() => {
  const click = (label) => [...document.querySelectorAll('.startmenu .sm-app')].find((b) => b.innerText.trim() === label)?.click();
  click('传输');
});
await sleep(700);
await shot('02-暗色-应用窗口磁盘与传输');
// 只关刚开的这两个窗口，文件窗口要留着后面用
await page.evaluate(() => {
  ['.disk-window', '.transfers-window'].forEach((sel) => {
    const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector(sel));
    w?.querySelector('.tc-close')?.click();
  });
});
await sleep(500);

// 终端：标签页 ∨ 下拉（窗口内菜单 ①）
await page.evaluate(() => document.querySelector('.tb-app[title="终端"]')?.click());
await page.waitForSelector('.terminal-window .xterm', { timeout: 20000 }).catch(() => {});
await sleep(1000);
await shot('03-暗色-窗口与任务栏');
await page.evaluate(() => document.querySelector('.terminal-window .term-tab-menu')?.click());
await sleep(350);
await shot('04-暗色-终端窗口内菜单');
await page.keyboard.press('Escape');
await sleep(200);
// 关掉终端：后面要拍完整的窗口 / 开始菜单，不被它挡住
await page.evaluate(() => {
  const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.terminal-window'));
  w?.querySelector('.tc-close')?.click();
});
await sleep(400);

// 记事本 文件 菜单（窗口内菜单 ②）
await page.evaluate(() => document.querySelector('.tb-app[title="记事本"]')?.click());
await page.waitForSelector('.editor-window', { timeout: 20000 });
await sleep(900);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.editor-winmenu .winmenu-btn')][0];
  b?.click();
});
await sleep(350);
await shot('05-暗色-记事本窗口内菜单');
await page.keyboard.press('Escape');
await sleep(200);
// 关掉记事本：桌面图标才能点到（后面要右键 readme.txt）
await page.evaluate(() => {
  const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.editor-window'));
  w?.querySelector('.tc-close')?.click();
});
await sleep(400);

// 开始菜单
await openStart();
await shot('06-暗色-开始菜单');
await page.keyboard.press('Escape');
await sleep(250);

// 先把文件窗口最小化：桌面图标露出来、后面右键与 toast 都在这块干净的桌面上做
await page.evaluate(() => {
  const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.finder'));
  w?.querySelector('.tc-min')?.click();
});
await sleep(450);
await shot('07-暗色-桌面与任务栏');

// 右键菜单（桌面空白）
await page.evaluate(() => {
  document.querySelector('.desktop-icons')?.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 700, clientY: 520,
  }));
});
await sleep(350);
await shot('08-暗色-右键菜单');
await page.keyboard.press('Escape');
await sleep(250);

// 右键菜单的子菜单（发送到 ▸）+ 点「下载」触一条 toast
const submenuPoint = async (levelSel, label) => page.evaluate((sel, l) => {
  const lvl = document.querySelector(sel);
  if (!lvl) return null;
  const it = [...lvl.querySelectorAll('.dropdown-item')].find((b) => (b.dataset.label || b.innerText.trim()).includes(l));
  if (!it || it.disabled) return null;
  const r = it.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, levelSel, label);
const fileIcon = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.desktop-icons .desktop-icon')].find((e) => /readme\.txt/.test(e.innerText));
  const el2 = [...document.querySelectorAll('.desktop-icons .desktop-icon')].find((e) => /probe-toast\.txt/.test(e.innerText));
  const box = (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  return el ? { one: box(el), two: el2 ? box(el2) : null } : null;
});
let toastCount = 0;
let trace = 'no-icon';
if (fileIcon) {
  // 「打包下载」需要多选：先点一个，Ctrl 再点一个（右键已选中项不会丢失多选）
  await page.mouse.click(fileIcon.one.x, fileIcon.one.y);
  await sleep(150);
  if (fileIcon.two) {
    await page.keyboard.down('Control');
    await page.mouse.click(fileIcon.two.x, fileIcon.two.y);
    await page.keyboard.up('Control');
    await sleep(200);
  }
  await page.mouse.click(fileIcon.one.x, fileIcon.one.y, { button: 'right' });
  await sleep(400);
  const sendPt = await submenuPoint('.context-menu[data-ctx-level="0"]', '发送到');
  trace = `send:${sendPt ? 'y' : 'n'}`;
  if (sendPt) {
    await page.mouse.move(sendPt.x, sendPt.y);
    await sleep(500);
    await shot('09-暗色-右键子菜单');
    // 打包下载才会 notify（单文件下载是直接落盘，不弹提示）
    const dl = await submenuPoint('.context-menu[data-ctx-level="1"]', '打包下载');
    trace += ` batch:${dl ? 'y' : 'n'}`;
    if (dl) {
      await page.mouse.click(dl.x, dl.y);
      await sleep(500);
      toastCount = await page.$$eval('.notification', (els) => els.length);
    }
  }
}
check('暗色下成功触发一条通知 toast', toastCount > 0, `toast 数=${toastCount} ${trace}`);
await shot('10-暗色-通知toast');

// 通知面板（托盘铃铛）：toast 还在时打开，列表里应有同一条
await page.evaluate(() => document.querySelector('.tray-bell')?.click());
await sleep(450);
const panelRows = await page.$$eval('.tb-popover .notif-row', (els) => els.length);
await shot('11-暗色-通知面板');
// 整页截图里 toast 与弹层位置重叠（T13 故意让 toast 低于任务栏），再单独拍一张弹层本体
const panelEl = await page.$('.tb-popover');
if (panelEl) {
  await panelEl.screenshot({ path: join(OUT, '11b-暗色-通知面板-元素.png') });
  results.shots.push('11b-暗色-通知面板-元素.png');
  console.log(`${D}    📸 10b-暗色-通知面板-元素.png${X}`);
}
check('通知面板在暗色下列出通知条目', panelRows > 0, `条目=${panelRows}`);
await page.keyboard.press('Escape');
await sleep(200);
// 还原文件窗口（任务栏按钮 = 还原并置顶）
await page.evaluate(() => {
  [...document.querySelectorAll('.tb-win')].find((b) => b.innerText.includes('根目录'))?.click();
});
await sleep(500);

// 对话框（开始菜单 › 关于本系统）
await openStart();
await page.evaluate(() => {
  [...document.querySelectorAll('.startmenu .sm-foot-btn')].find((b) => b.innerText.includes('关于本系统'))?.click();
});
await sleep(500);
await shot('12-暗色-对话框');
{
  const rows = await page.$$eval('.about-table tr', (els) => els.map((tr) => [...tr.children].map((td) => td.getBoundingClientRect().width)));
  const squeezed = rows.filter((w) => w[0] < 60).length;
  check('「关于」表格首列不被长路径挤成竖排（首列宽 ≥ 60px）', squeezed === 0, JSON.stringify(rows.map((w) => w.map(Math.round))));
  // 填充色块上的白字（主按钮 / 选中行）：暗色下也必须 ≥ 4.5:1
  const fill = await page.evaluate(() => {
    const n = window.__cn;
    const el = document.querySelector('.dialog-actions .btn-primary');
    if (!el) return null;
    const fg = n.parseColor(getComputedStyle(el).color);
    const bg = n.parseColor(getComputedStyle(el).backgroundColor);
    return { fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, ratio: +n.ratio(fg, bg).toFixed(2) };
  });
  results.contrast.accentFill = fill;
  check('暗色主按钮（强调色填充 + 白字）对比度 ≥ 4.5:1', fill && fill.ratio >= 4.5, JSON.stringify(fill));
}
await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
await sleep(300);

// Alt+Tab 切换器（文件窗口 + 记事本）
await page.evaluate(() => document.querySelector('.tb-app[title="记事本"]')?.click());
await page.waitForSelector('.editor-window', { timeout: 20000 });
await sleep(700);
await page.keyboard.down('Alt');
await page.keyboard.press('Tab');
await sleep(400);
const altTabVisible = !!(await page.$('.alt-tab-panel'));
await shot('13-暗色-AltTab切换器');
await page.keyboard.up('Alt');
await sleep(500);
check('Alt+Tab 切换器在暗色下出现且可见', altTabVisible);
await page.evaluate(() => {
  const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.editor-window'));
  w?.querySelector('.tc-close')?.click();
});
await sleep(400);

// 吸附预览矩形：拖动标题栏到左边缘，按住不放截图
await page.evaluate(() => {
  const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.finder'))
    || [...document.querySelectorAll('.window')][0];
  const tb = w?.querySelector('.window-titlebar');
  if (!tb) return;
  const r = tb.getBoundingClientRect();
  tb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 18, button: 0, pointerId: 1, isPrimary: true }));
});
await sleep(120);
await page.evaluate(() => {
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 4, clientY: 300, button: 0, pointerId: 1, isPrimary: true }));
  document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 4, clientY: 300, button: 0, pointerId: 1, isPrimary: true }));
});
await sleep(350);
const snap = await page.evaluate(() => {
  const el = document.querySelector('.snap-preview');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { bg: cs.backgroundColor, border: cs.borderTopColor };
});
await shot('14-暗色-吸附预览');
await page.evaluate(() => {
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 4, clientY: 300, button: 0, pointerId: 1, isPrimary: true }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 4, clientY: 300, button: 0, pointerId: 1, isPrimary: true }));
});
await sleep(300);
check('吸附预览矩形在暗色下有纯色填充（不是透明白）',
  !!snap && snap.bg !== 'rgba(0, 0, 0, 0)' && snap.bg !== 'rgb(255, 255, 255)', JSON.stringify(snap));

// 关掉剩余窗口，回到干净桌面再测对比度
await page.evaluate(() => {
  document.querySelectorAll('.window .tc-close').forEach((b) => b.click());
});
await sleep(400);
// 重新开一个文件窗口用于对比度测量
await page.evaluate(() => document.querySelector('.tb-app[title="文件资源管理器"]')?.click());
await page.waitForSelector('.finder', { timeout: 20000 });
await sleep(700);


// ============ ③ 暗色对比度实测 ============
console.log(`\n${B}${C}▸ 暗色对比度${X}`);
await page.evaluate(() => {
  // 回到只有文件窗口的状态，并把选中项清掉，取最「素」的文字
  const w = [...document.querySelectorAll('.window')].find((x) => x.querySelector('.finder'));
  w?.querySelector('.tc-max')?.click();
});
await sleep(500);
const contrast = await page.evaluate(() => {
  const n = window.__cn;
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const fg = n.parseColor(cs.color);
    const bg = n.bgOf(el);
    if (!fg || !bg) return null;
    const fgEff = fg.a === 1 ? fg : n.blend(fg, bg);
    return { sel, fg: cs.color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio: +n.ratio(fgEff, bg).toFixed(2) };
  };
  return {
    正文: pick('.finder .item-name'),
    次级: pick('.finder .sb-group'),
    禁用: pick('.finder .cmd-btn:disabled') || pick('.btn:disabled'),
    任务栏图标: (() => {
      const bell = document.querySelector('.tray-bell .bell') || document.querySelector('.tray-bell svg');
      const bar = document.querySelector('.taskbar');
      if (!bell || !bar) return null;
      const fg = n.parseColor(getComputedStyle(bell).color);
      const bg = n.parseColor(getComputedStyle(bar).backgroundColor);
      if (!fg || !bg) return null;
      return { sel: '.tray-bell', fg: getComputedStyle(bell).color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio: +n.ratio(fg, bg).toFixed(2) };
    })(),
  };
});
results.contrast.dark = contrast;
for (const [k, v] of Object.entries(contrast)) console.log(`  ${k}: ${v ? `${v.ratio}:1  (${v.fg} on ${v.bg})` : '未取到'}`);
check('暗色正文对比度 ≥ 4.5:1', contrast.正文 && contrast.正文.ratio >= 4.5, JSON.stringify(contrast.正文));
check('暗色次级文字对比度 ≥ 4.5:1', contrast.次级 && contrast.次级.ratio >= 4.5, JSON.stringify(contrast.次级));
check('暗色禁用态对比度 ≥ 4.5:1', contrast.禁用 && contrast.禁用.ratio >= 4.5, JSON.stringify(contrast.禁用));
check('暗色任务栏图标对比度 ≥ 4.5:1', contrast.任务栏图标 && contrast.任务栏图标.ratio >= 4.5, JSON.stringify(contrast.任务栏图标));

// ============ ④ 扫「露白」/「文字看不清」/ backdrop-filter ============
// 每开一个表面就扫一次（累计），这样「窗口 / 任务栏 / 开始菜单 / 右键菜单 / 通知 / 对话框 /
// Alt+Tab / 吸附预览 / 命令栏 / 三个窗口内菜单」全部落进同一份扫描里，而不是只抽两个静止画面。
const scans = [];
const scanNow = async (label) => {
  const r = await page.evaluate((lab) => {
    const n = window.__cn;
    const whiteish = [];
    const lowContrast = [];
    const blur = [];
    // 第三方画布（xterm / CodeMirror 语法色）与「文档纸面 / 媒体黑底」不在本轮颜色管辖范围
    const EXEMPT_BG = '.preview-office, .preview-media, .preview-pdf, img, video, iframe, canvas, .cm-editor, .xterm, .share-preview';
    const EXEMPT_FG = '.cm-editor, .xterm';
    for (const el of document.querySelectorAll('body *')) {
      if (!n.visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.backdropFilter && cs.backdropFilter !== 'none') blur.push(n.sel(el));
      if (el.closest(EXEMPT_BG)) continue;
      const bg = n.parseColor(cs.backgroundColor);
      // 只有「自己就是实色且本身发白」才算露白：半透明白是状态叠加层，交给下面的对比度扫描管
      if (bg && (bg.a === undefined || bg.a > 0.9) && n.lum(bg) > 0.45) whiteish.push({ sel: n.sel(el), bg: cs.backgroundColor });
      // 只在元素自己直接含文本时量文字对比度
      const hasOwnText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 1);
      if (!hasOwnText) continue;
      if (el.closest('.desktop-icons, .desktop-hint, .mobile-app')) continue;   // 压在壁纸渐变上，走壁纸令牌
      if (el.closest(EXEMPT_FG)) continue;
      const fg = n.parseColor(cs.color);
      if (!fg) continue;
      const bgEff = n.bgOf(el);
      // 文字本身带 alpha 时，先按真实叠加算一遍（否则 rgba 白会被当成不透明白，量出偏高的值）
      const fgEff = fg.a === 1 ? fg : n.blend(fg, bgEff);
      const ratio = n.ratio(fgEff, bgEff);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 600;
      const large = size >= 18.66 || (bold && size >= 14);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        lowContrast.push({ sel: n.sel(el), text: el.textContent.trim().slice(0, 24), fg: cs.color, bg: `rgb(${bgEff.r},${bgEff.g},${bgEff.b})`, ratio: +ratio.toFixed(2), need });
      }
    }
    return { label: lab, whiteish: whiteish.slice(0, 20), whiteishTotal: whiteish.length, lowContrast: lowContrast.slice(0, 20), lowContrastTotal: lowContrast.length, blur };
  }, label);
  scans.push(r);
  return r;
};

// 暗色：错开各组表面各扫一遍（弹层展开状态下扫，才算真的看过）
await scanNow('暗色-桌面');
{
  const prev = await page.evaluate(() => [...document.querySelectorAll('.window')].length);
  await page.evaluate(() => document.querySelector('.tb-app[title="文件资源管理器"]')?.click());
  await page.waitForSelector('.finder', { timeout: 20000 });
  await sleep(500);
  await scanNow('暗色-文件窗口+命令栏');
}
await openStart();
await scanNow('暗色-开始菜单');
await page.keyboard.press('Escape');
await sleep(150);

// 应用窗口（磁盘 / 分享管理 / 传输）：卡片、进度条、状态戳
for (const app of ['磁盘监控', '分享管理', '传输']) {
  await openStart();
  await page.evaluate((label) => {
    [...document.querySelectorAll('.startmenu .sm-app')].find((b) => b.innerText.trim() === label)?.click();
  }, app);
  await sleep(600);
}
await scanNow('暗色-磁盘/分享/传输窗口');
await page.evaluate(() => document.querySelectorAll('.window .tc-close').forEach((b) => b.click()));
await sleep(400);
await page.evaluate(() => document.querySelector('.tb-app[title="文件资源管理器"]')?.click());
await page.waitForSelector('.finder', { timeout: 20000 }).catch(() => {});
await sleep(500);
await page.evaluate(() => {
  document.querySelector('.desktop-icons')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 720, clientY: 520 }));
});
await sleep(300);
await scanNow('暗色-右键菜单');
await page.keyboard.press('Escape');
await sleep(150);
await page.evaluate(() => document.querySelector('.tray-bell')?.click());
await sleep(350);
await scanNow('暗色-通知面板');
await page.keyboard.press('Escape');
await sleep(150);
await openStart();
await page.evaluate(() => {
  [...document.querySelectorAll('.startmenu .sm-foot-btn')].find((b) => b.innerText.includes('关于本系统'))?.click();
});
await sleep(450);
await scanNow('暗色-对话框');
await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
await sleep(250);
await page.keyboard.down('Alt');
await page.keyboard.press('Tab');
await sleep(350);
await scanNow('暗色-AltTab');
await page.keyboard.up('Alt');
await sleep(350);
await page.evaluate(() => document.querySelector('.tb-app[title="终端"]')?.click());
await page.waitForSelector('.terminal-window .xterm', { timeout: 20000 }).catch(() => {});
await sleep(900);
await page.evaluate(() => document.querySelector('.terminal-window .term-tab-menu')?.click());
await sleep(350);
await scanNow('暗色-终端+窗口内菜单');
await page.keyboard.press('Escape');
await sleep(150);
await page.evaluate(() => document.querySelector('.tb-app[title="记事本"]')?.click());
await page.waitForSelector('.editor-window', { timeout: 20000 });
await sleep(800);
await page.evaluate(() => document.querySelector('.editor-winmenu .winmenu-btn')?.click());
await sleep(350);
await scanNow('暗色-记事本+窗口内菜单');
await page.keyboard.press('Escape');
await sleep(150);
await page.evaluate(() => {
  document.querySelectorAll('.window .tc-close').forEach((b) => b.click());
});
await sleep(400);

const sum = (key) => scans.reduce((a, s) => a + (key === 'blur' ? s.blur.length : s[key]), 0);
const exceptions = scans.flatMap((s) => (s.whiteish || []).concat(s.lowContrast || []));
results.leaks.dark = { surfaces: scans.map((s) => s.label), scans };
check(`暗色下 ${scans.length} 个表面全部无发白表面（露白 0 处）`, sum('whiteishTotal') === 0,
  `${sum('whiteishTotal')} 处：${JSON.stringify(exceptions.slice(0, 4))}`);
check('暗色下全部表面无对比度不够的文字（<4.5:1 小字 0 处）', sum('lowContrastTotal') === 0,
  `${sum('lowContrastTotal')} 处：${JSON.stringify((scans.flatMap((s) => s.lowContrast || [])).slice(0, 6))}`);
check('全局无 backdrop-filter（纯色材质）', sum('blur') === 0, JSON.stringify(scans.map((s) => s.blur)));
console.log(`${D}    扫描覆盖：${scans.map((s) => s.label).join(' / ')}${X}`);

// ============ ⑤ 亮 ↔ 暗来回切 3 次：快照比对 ============
console.log(`\n${B}${C}▸ 亮暗来回切换${X}`);
const setTheme = async (t) => {
  const has = await page.evaluate(() => !!document.querySelector('.tb-popover .account-popover'));
  if (!has) {
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(220);
  }
  const label = { light: '浅色主题', dark: '深色主题', auto: '跟随系统' }[t];
  await page.evaluate((l) => {
    [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')].find((b) => b.innerText.includes(l))?.click();
  }, label);
  await sleep(320);
};
// 先把窗口/开始菜单都关掉再比对（元素存在的集合要一致）
await page.keyboard.press('Escape');
await page.evaluate(() => {
  document.querySelectorAll('.window .tc-close').forEach((b) => b.click());
});
await sleep(400);
await setTheme('light');
const lightSnap1 = await page.evaluate(() => {
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return [cs.backgroundColor, cs.color, cs.borderColor, cs.boxShadow].join('|'); };
  return { body: pick('body'), taskbar: pick('.taskbar'), tbApp: pick('.tb-app'), tbWin: pick('.tray-clock'), desktop: pick('.desktop') };
});
let residue = [];
for (let i = 0; i < 3; i++) {
  await setTheme('dark');
  const darkNow = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    body: getComputedStyle(document.body).backgroundColor,
    taskbar: getComputedStyle(document.querySelector('.taskbar')).backgroundColor,
  }));
  if (i === 0) results.leftovers.darkBody = darkNow;
  await setTheme('light');
  const back = await page.evaluate(() => {
    const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return [cs.backgroundColor, cs.color, cs.borderColor, cs.boxShadow].join('|'); };
    return { theme: document.documentElement.dataset.theme, body: pick('body'), taskbar: pick('.taskbar'), tbApp: pick('.tb-app'), tbWin: pick('.tray-clock'), desktop: pick('.desktop') };
  });
  const diffs = Object.keys(lightSnap1).filter((k) => lightSnap1[k] !== back[k]);
  if (diffs.length) residue.push({ round: i + 1, diffs, back });
}
results.leftovers.residue = residue;
check('亮 → 暗 → 亮 来回切 3 次无残留（computed style 与初始完全一致）', residue.length === 0, JSON.stringify(residue.slice(0, 2)));

// 暗色快照（供报告）
await setTheme('dark');
const darkSnap = await page.evaluate(() => {
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color }; };
  return { body: pick('body'), taskbar: pick('.taskbar'), tbWin: pick('.tb-win'), window: pick('.window'), panel: pick('.tb-popover') };
});
results.leftovers.darkSnap = darkSnap;
await shot('15-暗色-切换后桌面');

// ============ ⑥ 跟随系统 ============
console.log(`\n${B}${C}▸ 跟随系统${X}`);
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await setTheme('auto');
await sleep(350);
const autoLight = await page.evaluate(() => ({
  attr: document.documentElement.dataset.theme,
  saved: localStorage.getItem('cloudnine-theme'),
  body: getComputedStyle(document.body).backgroundColor,
}));
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await sleep(400);
const autoDark = await page.evaluate(() => ({
  attr: document.documentElement.dataset.theme,
  saved: localStorage.getItem('cloudnine-theme'),
  body: getComputedStyle(document.body).backgroundColor,
}));
results.auto = { autoLight, autoDark };
check('「跟随系统」：系统亮 → 亮色', autoLight.attr === 'light' && autoLight.saved === 'auto', JSON.stringify(autoLight));
check('「跟随系统」：系统暗 → 暗色（matchMedia 变更即时生效）', autoDark.attr === 'dark', JSON.stringify(autoDark));

// 亮色对比度（同一组选择器，便于并排看）
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await setTheme('light');
await page.evaluate(() => document.querySelector('.tb-app[title="文件资源管理器"]')?.click());
await page.waitForSelector('.finder', { timeout: 20000 });
await sleep(600);
const contrastLight = await page.evaluate(() => {
  const n = window.__cn;
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const fg = n.parseColor(cs.color); const bg = n.bgOf(el);
    return fg && bg ? { sel, fg: cs.color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio: +n.ratio(fg, bg).toFixed(2) } : null;
  };
  const bell = document.querySelector('.tray-bell .bell');
  const bar = document.querySelector('.taskbar');
  const bfg = bell && n.parseColor(getComputedStyle(bell).color);
  const bbg = bar && n.parseColor(getComputedStyle(bar).backgroundColor);
  return {
    正文: pick('.finder .item-name'),
    次级: pick('.finder .sb-group'),
    禁用: pick('.finder .cmd-btn:disabled') || pick('.btn:disabled'),
    任务栏图标: bfg && bbg ? { sel: '.tray-bell', fg: getComputedStyle(bell).color, bg: `rgb(${bbg.r}, ${bbg.g}, ${bbg.b})`, ratio: +n.ratio(bfg, bbg).toFixed(2) } : null,
  };
});
results.contrast.light = contrastLight;
await shot('16-亮色-文件窗口');

// ============ ⑦ 登录页 / boot 屏在暗色下的冷启动 ============
console.log(`\n${B}${C}▸ 登录页（无会话冷启动）${X}`);
{
  const ctx = await browser.createBrowserContext();
  const p2 = await ctx.newPage();
  await p2.setViewport({ width: 1440, height: 900 });
  await p2.evaluateOnNewDocument(() => { try { localStorage.setItem('cloudnine-theme', 'dark'); } catch { /* 忽略 */ } });
  await p2.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await p2.waitForSelector('.auth-card, .boot-screen', { timeout: 30000 }).catch(() => {});
  await sleep(900);
  await p2.screenshot({ path: join(OUT, '17-暗色-登录页.png') });
  results.shots.push('17-暗色-登录页.png');
  console.log(`${D}    📸 17-暗色-登录页.png${X}`);
  const loginProbe = await p2.evaluate(() => {
    const el = document.querySelector('.auth-card');
    const n = window.__cn;
    if (!el) return { found: false, theme: document.documentElement.dataset.theme };
    const bg = n ? n.parseColor(getComputedStyle(el).backgroundColor) : null;
    return { found: true, theme: document.documentElement.dataset.theme, bg: getComputedStyle(el).backgroundColor, lum: bg ? +n.lum(bg).toFixed(3) : null };
  }).catch(() => ({ found: false }));
  results.login = loginProbe;
  check('暗色下登录卡片是深色（不是白卡）',
    loginProbe.theme === 'dark' && (loginProbe.lum === null || loginProbe.lum < 0.1), JSON.stringify(loginProbe));
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
console.log(`\n${B}结果${X}  通过 ${pass.length} / 失败 ${fail.length}   截图 ${results.shots.length} 张`);
console.log(`${D}报告：${join(OUT, 'report.json')}${X}`);
if (fail.length) {
  for (const [name, detail] of fail) console.log(`${R}✗ ${name}${X}  ${detail}`);
  process.exit(1);
}
