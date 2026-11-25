#!/usr/bin/env node
/**
 * CloudNine 终端剪贴板自测（复制 / 粘贴 / 右键菜单）
 *
 * 为什么单独一支脚本、而不是塞进 uitest.mjs：
 *   终端的复制粘贴整条链路都挂在「安全上下文」上 —— 生产是 http://<IP>，Chrome 在那里
 *   navigator.clipboard 整个不存在。这种退化只会在纯 http 下暴露，而 uitest 默认跑
 *   127.0.0.1（安全上下文），根本走不到那条路。所以这里两条路都做了断言，并且要求对
 *   局域网 IP 再跑一遍。
 *
 * 固定 29 项断言（不适用于当前上下文的项算「跳过」，不计通过/失败）：
 *   能不能「选中」先看得到 —— 拖拽要出现选择框且高亮颜色与终端底色不同（只比
 *   getSelection() 会漏掉「选中了但看不见」这种假绿）；双击选词 / 三击选行 /
 *   Ctrl+C 仍是 SIGINT、Ctrl+V 仍是 0x16 / Ctrl+Shift+C 复制中文多行不错字不多换行 /
 *   Ctrl+Shift+V 粘贴（多行先确认、单行直贴、取消不留残行、贴完焦点回终端）/ 、
 *   右键菜单两项、打开瞬间不高亮、悬停跟着指针走 / 纯 http 下右键「粘贴」用 textarea 兜底。
 *
 * 用法：
 *   PUPPETEER_CORE=/path/to/puppeteer-core \
 *   node scripts/terminal-clipboard.mjs --url http://<IP>/ --user <账号> --password <密码>
 *   Windows 本机：--chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
 *
 * 参数与 uitest.mjs / theme-audit.mjs 一致：--url（默认 127.0.0.1:8480）、--user、--password、
 * --chrome（默认 /usr/bin/google-chrome）。退出码 0=全过，1=有失败项，2=环境问题（找不到
 * puppeteer / 登录失败 / 终端不是 bash）。
 *
 * 前提：终端 shell 是 bash（Linux 部署天然满足）。Ctrl+V 的 quoted-insert 和 sleep 在
 * cmd.exe 下不存在，硬兼容会让断言失真；Windows 上验证请用 SHELL=C:\Windows\System32\wsl.exe
 * 起服务端。
 *
 * 剪贴板内容怎么造、怎么读：不碰宿主系统剪贴板（headless Chrome 未必接得上，本机实测
 * Set-Clipboard 都会 Access denied），一律在同一个页面里用原生 Ctrl+C / Ctrl+V，
 * 走的是用户真实的 paste 事件链路。
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
const OUT = join(__dirname, '..', 'shots', `terminal-clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(OUT, { recursive: true });

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const results = { url: URL_BASE, capability: null, clipboard: [], checks: [], shots: [] };
const pass = [], fail = [], skipped = [];
const check = (name, cond, detail = '') => {
  results.checks.push({ name, ok: !!cond, detail });
  if (cond) { pass.push(name); console.log(`${G}  ✓${X} ${name}`); }
  else { fail.push([name, detail]); console.log(`${R}  ✗${X} ${name}  ${Y}${detail}${X}`); }
};
// 当前上下文用不到的分支：留位置但不计入通过/失败，避免「安全上下文里 21 项、纯 http 里 23 项」的漂移
const skip = (name, why) => {
  results.checks.push({ name, ok: null, skipped: true, detail: why });
  skipped.push(name);
  console.log(`${D}  – ${name}（跳过：${why}）${X}`);
};
const section = (t) => console.log(`\n${B}${C}▸ ${t}${X}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');

// ---------- 登录 / 初始化（走 API，比驱动向导稳） ----------
async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${URL_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}
async function ensureSession() {
  let r = await api('POST', '/api/login', { username: USER, password: PASS });
  if (r.status !== 200) r = await api('POST', '/api/init', { username: USER, password: PASS, siteName: 'CloudNine' });
  const m = (r.setCookie || '').match(/cloudnine_sid=([^;]+)/);
  return m ? m[1] : null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 860, deviceScaleFactor: 1 });
// 安全上下文（localhost / https）下把读剪贴板权限显式授给测试源，否则 readText 会以「没权限」失败，
// 落到兜底框上，这条分支就测不到「有 API 时直接读」。纯 http 源上 Chrome 会忽略这个授权。
try { await browser.defaultBrowserContext().overridePermissions(URL_BASE, ['clipboard-read', 'clipboard-write']); } catch { /* 忽略 */ }

const SID = await ensureSession();
if (!SID) {
  console.error('登录/初始化失败：检查 --user / --password，或实例是否可写');
  await browser.close();
  process.exit(2);
}
await browser.setCookie({ name: 'cloudnine_sid', value: SID, domain: new URL(URL_BASE).hostname, path: '/', httpOnly: true });

const shot = async (label) => {
  const name = `${label}.png`;
  await page.screenshot({ path: join(OUT, name) });
  results.shots.push(name);
  console.log(`${D}    📸 ${name}${X}`);
};

const rows = () => page.evaluate(() => [...document.querySelectorAll('.terminal-window .xterm-rows > div')]
  .map((d) => d.textContent).join('\n').replace(/\s+$/, ''));
const dialogText = () => page.$eval('.dialog', (el) => el.innerText).catch(() => '');
const activeTag = () => page.evaluate(() => document.activeElement?.tagName || '?');
const focusedInTerm = () => page.evaluate(() => !!document.activeElement?.closest?.('.xterm'));
const combo = async (key, shift = false) => {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await sleep(350);
};

// 在页面里的真实 textarea 上用原生 Ctrl+C 写剪贴板（等同用户从别的应用复制）
async function setClipboard(text) {
  await page.evaluate((t) => {
    let ta = document.getElementById('cn-probe-clip');
    if (!ta) { ta = document.createElement('textarea'); ta.id = 'cn-probe-clip'; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0.01'; document.body.appendChild(ta); }
    ta.value = t; ta.focus(); ta.select();
  }, text);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyC'); await page.keyboard.up('Control');
  await page.evaluate(() => document.getElementById('cn-probe-clip')?.remove());
  await sleep(150);
}
// 用原生 Ctrl+V 把剪贴板读回来，验证里面到底是什么（textarea 会把 CRLF 归一成 LF）
async function readClipboard() {
  await page.evaluate(() => {
    let ta = document.getElementById('cn-probe-read');
    if (!ta) { ta = document.createElement('textarea'); ta.id = 'cn-probe-read'; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0.01'; document.body.appendChild(ta); }
    ta.value = ''; ta.focus();
  });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
  await sleep(200);
  const val = await page.evaluate(() => {
    const ta = document.getElementById('cn-probe-read');
    const out = ta ? ta.value : null;
    ta?.remove();
    return out;
  });
  results.clipboard.push(val);
  await page.click('.terminal-window .xterm'); // 焦点还给终端（会清选区）
  return val;
}

// 按整行文本划选两行：只认 textContent 完全相等的行，避免命中命令行里同样的字
async function selectRows(needles) {
  const rects = await page.evaluate((ns) => {
    const els = [...document.querySelectorAll('.terminal-window .xterm-rows > div')];
    const pick = (n) => {
      const el = els.find((r) => r.textContent.trim() === n);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const spans = [...el.querySelectorAll('span')].filter((s) => s.textContent.trim());
      const last = spans[spans.length - 1];
      return { top: r.top + r.height / 2, left: r.left + 1, right: (last ? last.getBoundingClientRect().right : r.right) + 2 };
    };
    return { a: pick(ns[0]), b: pick(ns[1]) };
  }, needles);
  if (!rects.a || !rects.b) return rects;
  await page.mouse.move(rects.a.left, rects.a.top);
  await page.mouse.down();
  await page.mouse.move(rects.b.right, rects.a.top, { steps: 6 });
  await page.mouse.move(rects.b.right, rects.b.top, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  return rects;
}

console.log(`${B}CloudNine 终端剪贴板自测${X}  ${URL_BASE}`);

try {
  // ---------- 打开终端 + 环境确认 ----------
  section('打开终端 / 环境');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.taskbar', { timeout: 30000 });
  await page.evaluate(() => document.querySelector('.tb-app[title="终端"]')?.click());
  await page.waitForSelector('.terminal-window .xterm', { timeout: 30000 });

  // 能力探测（不是断言，是「这台浏览器走哪条路」的现场记录）
  results.capability = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    clipboard: !!navigator.clipboard,
    readText: !!(navigator.clipboard && navigator.clipboard.readText),
    writeText: !!(navigator.clipboard && navigator.clipboard.writeText),
  }));
  const cap = results.capability;
  console.log(`  安全上下文=${cap.secureContext}  navigator.clipboard=${cap.clipboard}  readText=${cap.readText}  writeText=${cap.writeText}`);
  if (cap.readText) {
    console.log(`${Y}  当前是安全上下文（localhost / https）：读剪贴板会走 Clipboard API。${X}`);
    console.log(`${Y}  生产是纯 http，没有这条路 —— 务必再用 --url http://<局域网IP>/ 跑一遍。${X}`);
  }

  // 等提示符，再确认 shell 是 bash（sleep / quoted-insert 都是 bash 语义）
  for (let i = 0; i < 40; i++) {
    if (/[$#>]\s*$/.test(await rows())) break;
    await sleep(250);
  }
  await page.click('.terminal-window .xterm');
  await page.keyboard.type('echo CN_SHELL_$BASH_VERSION');
  await page.keyboard.press('Enter');
  await sleep(900);
  if (!/CN_SHELL_\d+\.\d+/.test(await rows())) {
    console.error(`\n${R}终端不是 bash：Ctrl+V 的 quoted-insert / sleep 在 cmd.exe 下不存在，断言会失真。${X}`);
    console.error('Linux 部署天然满足；Windows 本机验证请用 SHELL=C:\\Windows\\System32\\wsl.exe 起服务端。');
    await shot('00-shell-not-bash');
    await browser.close();
    process.exit(2);
  }

  // ---------- ① Ctrl+C / Ctrl+V 语义 ----------
  section('终端语义（Ctrl+C / Ctrl+V 不能被抢）');
  await page.keyboard.type('sleep 60');
  await page.keyboard.press('Enter');
  await sleep(900);
  await combo('KeyC');
  await sleep(600);
  await page.keyboard.type('echo AFTER_INT');
  await page.keyboard.press('Enter');
  await sleep(900);
  const afterEcho = await rows();
  check('Ctrl+C 中断 sleep 60（提示符回来且能继续执行）', /AFTER_INT/.test(afterEcho), afterEcho.slice(-160));

  await setClipboard('echo HIJACKED_BY_PASTE');
  await page.click('.terminal-window .xterm');
  await sleep(200);
  await combo('KeyV');
  await sleep(400);
  const afterCtrlV = await rows();
  check('Ctrl+V 没有粘贴剪贴板（终端语义未被抢）', !/HIJACKED_BY_PASTE/.test(afterCtrlV), afterCtrlV.slice(-200));
  // bash 的 quoted-insert：^V 之后的键被原样插入，屏幕上出现 ^U → 说明 0x16 真的进了 shell
  await combo('KeyU');
  await sleep(300);
  const afterQuote = await rows();
  check('Ctrl+V 送的是 0x16（readline quoted-insert，屏幕上出现 ^U）', /\^U/.test(afterQuote), afterQuote.slice(-120));
  await page.keyboard.press('Escape');
  await sleep(200);
  await shot('01-ctrlv-quoted');

  // ---------- ② 选中文本（拖拽 / 双击 / 三击）----------
  // 这一段是上一版缺的那块：「能不能选中」必须看得到高亮，而不是只比较 getSelection()。
  section('选中文本（拖拽 / 双击 / 三击）');
  await page.keyboard.type('clear');
  await page.keyboard.press('Enter');
  await sleep(500);
  await page.keyboard.type("printf 'alpha beta\\n中文第一行\\n中文第二行\\n'");
  await page.keyboard.press('Enter');
  await sleep(900);

  // 选择框：既要存在（宽高 > 1px），颜色也不能和终端底色一样（否则就是「选中了但看不见」）
  const selBoxes = () => page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.terminal-window .xterm-selection div')]
      .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
    const cs = boxes[0] ? getComputedStyle(boxes[0]).backgroundColor : null;
    const vp = document.querySelector('.terminal-window .xterm-viewport');
    return {
      boxes: boxes.length,
      color: cs,
      termBg: vp ? getComputedStyle(vp).backgroundColor : null,
      token: getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
    };
  });
  const rowRect = (needle) => page.evaluate((n) => {
    const el = [...document.querySelectorAll('.terminal-window .xterm-rows > div')].find((r) => r.textContent.trim() === n);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top + r.height / 2, left: r.left };
  }, needle);

  const rects = await selectRows(['中文第一行', '中文第二行']);
  const sel = await selBoxes();
  console.log(`  选择框=${sel.boxes} 高亮色=${sel.color} 终端底色=${sel.termBg}(${sel.token})`);
  check('拖拽后确实形成了选择区域', !!(rects.a && rects.b) && sel.boxes > 0, JSON.stringify({ rects, sel }));
  check('选中高亮看得见（与终端底色不同、不是透明）', !!sel.color && sel.color !== 'rgba(0, 0, 0, 0)' && sel.color !== sel.termBg, JSON.stringify(sel));
  if (rects.a && rects.b) {
    await shot('02-selection');
    await combo('KeyC', true);
    await sleep(400);
    const clip = await readClipboard();
    console.log(`  剪贴板内容 = ${JSON.stringify(clip)}`);
    check('Ctrl+Shift+C 复制内容与选中文本一致（中文两行、不丢字）', norm(clip) === '中文第一行\n中文第二行', JSON.stringify(clip));
    check('复制内容没有多余的前后换行', norm(clip) === norm(clip).trim(), JSON.stringify(norm(clip)));
    const toastFail = await page.$$eval('.notification', (ns) => ns.some((n) => /复制失败/.test(n.innerText))).catch(() => false);
    check('复制后没有「复制失败」提示', !toastFail);
    await shot('03-copied');
  }

  // 双击选词（puppeteer 24+ 的点击次数参数叫 count，不是 clickCount）
  const alpha = await rowRect('alpha beta');
  if (alpha) {
    await page.mouse.click(alpha.left + 30, alpha.top, { count: 2 });
    await sleep(400);
    await combo('KeyC', true);
    await sleep(400);
    const word = await readClipboard();
    check('双击选中一个词', norm(word) === 'alpha', JSON.stringify(word));
  } else {
    check('双击选中一个词', false, '没找到 alpha beta 行');
  }

  // 三击选整行
  const cnRow = await rowRect('中文第一行');
  if (cnRow) {
    await page.mouse.click(cnRow.left + 20, cnRow.top, { count: 3 });
    await sleep(400);
    await combo('KeyC', true);
    await sleep(400);
    const line = await readClipboard();
    check('三击选中整行', norm(line) === '中文第一行', JSON.stringify(line));
  } else {
    check('三击选中整行', false, '没找到中文输出行');
  }

  // ---------- ③ 右键菜单 ----------
  section('终端右键菜单（不能是桌面/浏览器全局菜单）');
  const box = await page.$eval('.terminal-window .term-host', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const activeLabel = () => page.evaluate(() => document.querySelector('.context-menu .dropdown-item.ctx-active')?.dataset.label || '');
  const itemRect = (idx) => page.evaluate((i) => {
    const b = [...document.querySelectorAll('.context-menu .dropdown-item')][i];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, idx);

  // 无选区先看「打开瞬间的高亮」：上一版这里因为初始游标落在第一个可用项上，
  // 一弹出「粘贴」就是蓝底，然后鼠标悬到置灰的「复制」上也不会变。
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(400);
  const menu = await page.$$eval('.context-menu .dropdown-item', (els) => els.map((e) => ({ label: e.innerText.trim().replace(/\n/g, ' / '), disabled: e.disabled })));
  console.log(`  无选区时菜单项 = ${JSON.stringify(menu)}`);
  check('右键弹出终端的复制/粘贴菜单（两项，不是桌面全局菜单）', menu.length === 2 && /复制/.test(menu[0].label) && /粘贴/.test(menu[1].label), JSON.stringify(menu));
  await shot('04-context-menu-open');
  check('菜单打开瞬间没有任何项被高亮', (await activeLabel()) === '', await activeLabel());
  const copyPos = await itemRect(0);
  if (copyPos) { await page.mouse.move(copyPos.x, copyPos.y, { steps: 4 }); await sleep(300); }
  check('鼠标移到置灰的「复制」上仍不高亮任何项', (await activeLabel()) === '', await activeLabel());
  const pastePos = await itemRect(1);
  if (pastePos) { await page.mouse.move(pastePos.x, pastePos.y, { steps: 4 }); await sleep(300); }
  check('鼠标移到可用项时高亮跟着走', (await activeLabel()) === '粘贴', await activeLabel());
  await shot('05-context-menu-hover');
  await page.keyboard.press('Escape');
  await sleep(250);

  // 有选区：复制可用且结果一致
  const rects2 = await selectRows(['中文第一行', '中文第二行']);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(400);
  const menuWithSel = await page.$$eval('.context-menu .dropdown-item', (els) => els.map((e) => ({ label: e.innerText.trim().replace(/\n/g, ' / '), disabled: e.disabled })));
  check('有选区时「复制」可用', menuWithSel[0] && menuWithSel[0].disabled === false, JSON.stringify(menuWithSel[0]));
  if (rects2.a && rects2.b) {
    const item = await page.$$('.context-menu .dropdown-item');
    if (item[0]) await item[0].click();
    await sleep(400);
    const clipFromMenu = await readClipboard();
    check('菜单「复制」与快捷键复制结果一致', norm(clipFromMenu) === '中文第一行\n中文第二行', JSON.stringify(clipFromMenu));
  } else {
    check('菜单「复制」与快捷键复制结果一致', false, '没能重新划选');
  }

  // ---------- ④ 多行粘贴：确认 + 取消不残留 ----------
  section('多行粘贴（先确认；取消不留残行）');
  await page.keyboard.press('Escape');
  await sleep(200);
  await setClipboard('echo LINE_ONE\necho LINE_TWO');
  await page.click('.terminal-window .xterm');
  await sleep(200);
  const beforePaste = await rows();
  await combo('KeyV', true);
  await sleep(700);
  const dt = await dialogText();
  check('粘贴多行时弹出确认框', /多行/.test(dt) && /2 行/.test(dt), dt.slice(0, 160));
  await shot('05-multiline-confirm');
  const cancelBtn = await page.$$('.dialog-actions .btn');
  if (cancelBtn[0]) await cancelBtn[0].click();
  await sleep(600);
  const afterCancel = await rows();
  check('取消后终端没有任何残留（屏幕与粘贴前一致）', afterCancel === beforePaste, `before=${JSON.stringify(beforePaste.slice(-80))} after=${JSON.stringify(afterCancel.slice(-80))}`);
  check('取消后确认框关闭', !(await page.$('.dialog')));
  await page.click('.terminal-window .xterm');
  await page.keyboard.press('Enter');
  await sleep(500);
  const afterEnter = await rows();
  check('取消后按 Enter 不会执行半行内容', !/LINE_ONE|LINE_TWO/.test(afterEnter), afterEnter.slice(-160));
  await shot('06-after-cancel');

  // ---------- ⑤ 多行粘贴确认后执行 ----------
  await page.click('.terminal-window .xterm');
  await combo('KeyV', true);
  await sleep(700);
  const okBtn = await page.$$('.dialog-actions .btn-primary');
  if (okBtn[0]) await okBtn[0].click();
  await sleep(1200);
  const afterMulti = await rows();
  check('确认后两行都真的执行了', /LINE_ONE/.test(afterMulti) && /LINE_TWO/.test(afterMulti), afterMulti.slice(-240));
  check('粘贴后终端重新拿到焦点（可以直接接着敲）', await focusedInTerm(), `focus=${await activeTag()}`);
  await shot('07-multiline-pasted');

  // ---------- ⑥ 单行粘贴不打扰 ----------
  section('单行粘贴（不弹确认）');
  await setClipboard('echo SINGLE_LINE_OK');
  await page.click('.terminal-window .xterm');
  await sleep(200);
  await combo('KeyV', true);
  await sleep(600);
  check('单行粘贴不弹确认框', !(await page.$('.dialog')));
  await page.keyboard.press('Enter');
  await sleep(900);
  const afterSingle = await rows();
  check('单行粘贴直接执行', /SINGLE_LINE_OK/.test(afterSingle), afterSingle.slice(-200));
  await shot('08-single-line');

  // ---------- ⑦ 菜单「粘贴」：两条上下文的出口不同，断言同一条底线 ----------
  section('右键菜单粘贴（有 API 直接读 / 无 API 走 textarea 兜底）');
  await setClipboard('echo VIA_MENU');
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(350);
  const pasteItem = await page.$$('.context-menu .dropdown-item');
  if (pasteItem[1]) await pasteItem[1].click();
  await sleep(800);
  const hasTa = !!(await page.$('.dialog textarea'));
  if (cap.readText) {
    // 安全上下文：直接 API 读，不该弹兜底框
    check('菜单「粘贴」不静默失败（安全上下文下直接读 API）', !hasTa, (await dialogText()).slice(0, 160) || '出现了兜底框');
    skip('没有剪贴板 API 时给出可粘贴输入框（而不是静默失败）', '当前是安全上下文，走不到兜底路径');
    skip('粘贴框自动获得焦点（可以直接 Ctrl+V）', '同上');
    skip('粘贴框里读到了系统剪贴板内容', '同上');
    await page.keyboard.press('Enter');
    await sleep(900);
    check('菜单粘贴真的送到终端', /VIA_MENU/.test(await rows()), (await rows()).slice(-200));
    await page.keyboard.press('Escape');
  } else {
    // 纯 http：execCommand('paste') 对网页禁用，只能给用户一个真 textarea 让他自己按 Ctrl+V
    check('菜单「粘贴」不静默失败（没有 API 时给出可粘贴输入框）', hasTa, (await dialogText()).slice(0, 160) || '既没弹框也没内容');
    check('粘贴框自动获得焦点（可以直接 Ctrl+V）', (await activeTag()) === 'TEXTAREA', `focus=${await activeTag()}`);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
    await sleep(300);
    const taVal = await page.$eval('.dialog textarea', (el) => el.value).catch(() => null);
    check('粘贴框里读到了系统剪贴板内容', taVal === 'echo VIA_MENU', JSON.stringify(taVal));
    await shot('09-paste-prompt');
    const pOk = await page.$('.dialog-actions .btn-primary');
    if (pOk) await pOk.click();
    await sleep(600);
    await page.keyboard.press('Enter');
    await sleep(900);
    check('菜单粘贴真的送到终端', /VIA_MENU/.test(await rows()), (await rows()).slice(-200));
    await shot('10-menu-pasted');
  }

  // ---------- ⑧ 无选区时复制项置灰 ----------
  section('无选区时「复制」置灰');
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(350);
  const menu2 = await page.$$eval('.context-menu .dropdown-item', (els) => els.map((e) => ({ label: e.innerText.trim().replace(/\n/g, ' / '), disabled: e.disabled })));
  check('无选区时「复制」置灰', menu2[0] && menu2[0].disabled === true, JSON.stringify(menu2));
  await page.keyboard.press('Escape');
} catch (e) {
  console.error(`\n${R}执行中断：${e?.message || e}${X}`);
  await page.screenshot({ path: join(OUT, 'error.png') }).catch(() => {});
  results.error = String(e?.stack || e);
  await browser.close();
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  process.exit(2);
}

await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
console.log(`\n${B}结果${X}  通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skipped.length}   截图 ${results.shots.length} 张`);
console.log(`${D}报告：${join(OUT, 'report.json')}${X}`);
if (fail.length) {
  for (const [name, detail] of fail) console.log(`${R}✗ ${name}${X}  ${detail}`);
  process.exit(1);
}
