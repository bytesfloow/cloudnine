#!/usr/bin/env node
/**
 * 文件资源管理器 · 顶部工具栏改版（方案 A · 紧凑命令栏）端到端验收
 *
 * 覆盖 docs/design/finder-toolbar-v2.md 的 V3「材质分层」验收点：
 *   ① 每个命令按钮都有内联 SVG 图标；宽窗下中文标签全部可见（36 高 / 图标 18 / 字号 13.5·500 / 圆角 10）
 *   ①b 标签零截断：命令按钮标签无 `…`、无 text-overflow、文字真实排版宽度不超出行内盒
 *   ①c 动效三档：进入 70ms / 按下 105ms / 回归 375ms（读 computed transition-duration，不是读源码）
 *   ①d 涟漪：pointerdown 有 .cmd-ripple 节点、500ms 内移除；prefers-reduced-motion 下无涟漪无位移
 *   ①e 材质分层：静默 elev-1（细边框 + 双层投影）+ --fx-btn-bg 底，悬停 elev-2 + 8% 状态层
 *   ② Tab 走一遍工具栏：命中的控件都匹配 :focus-visible 且有 2px outline
 *   ③ 无选中时 剪切/复制/删除 disabled；选中 2 项后可启用并注入「下载」
 *   ④ 后退按钮：初始 disabled，进一级目录后可用
 *   ⑤ 长路径（>8 级）折叠成「首段 … 末两段」，点「…」弹出被折叠的段，点其中一段能跳过去
 *   ⑥ 560px 窗口：无横向溢出、主操作仍有标签、搜索展开时把动作收进「更多」且菜单里一个不少
 *   ⑦ 暗色：命令栏底色 / 文字色 / 按钮底色与描边随令牌变化（compute style 对比，不是看截图）
 *   ⑧ 上传进行中：命令行出现进度胶囊 + 上传按钮自带进度条
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / FILE_ROOT 落在系统临时目录，端口 8711，跑完杀进程 + 删目录。
 *
 * 依赖（puppeteer-core 不含 Chromium，复用系统 Chrome）：
 *   PUPPETEER_CORE=/path/to/puppeteer-core 或 ../../.uitest/node_modules/puppeteer-core
 *
 * 用法：
 *   node scripts/uitest-finder-toolbar.mjs
 *   node scripts/uitest-finder-toolbar.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-finder-toolbar.mjs --url http://127.0.0.1:8499/   # 复用已起好的实例
 *   node scripts/uitest-finder-toolbar.mjs --keep                        # 保留临时目录
 *
 * @group core
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

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

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const PORT = Number(arg('port', 8711));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/finder-toolbar'));

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

async function waitServer(base, ms = 40000) {
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
  child = spawn(process.execPath, [join(ROOT, 'server', 'src', 'index.js')], {
    cwd: join(ROOT, 'server'),
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  if (!await waitServer(URL_BASE)) {
    console.error(`${RED}服务 40 秒内没有起来${RESET}\n${log.join('').slice(-3000)}`);
    await cleanup();
    process.exit(2);
  }
}

async function prepareEnv() {
  if (!existsSync(resolve(ROOT, 'client', 'dist', 'index.html'))) {
    console.error('client/dist 不存在，请先运行 npm run build');
    process.exit(2);
  }
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-finder-toolbar-'));
  dataDir = join(tmpRoot, 'data');
  const filesRoot = join(tmpRoot, 'files');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  mkdirSync(join(filesRoot, 'docs'), { recursive: true });
  mkdirSync(join(filesRoot, 'images'), { recursive: true });
  for (const n of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(filesRoot, n), `finder toolbar ${n}\n`);
  // 10 级深路径：面包屑折叠要有东西可折（>8 级）
  const deep = join(filesRoot, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'deep.txt'), 'deep\n');

  serverEnv = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PLUGINS_DIR: join(dataDir, 'plugins'),
    PLUGIN_DATA_DIR: join(dataDir, 'plugin-data'),
    FILE_ROOT: filesRoot,
    SITE_NAME: 'CloudNine 工具栏自测',
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

// ================= 2. 浏览器流程 =================
let browser = null;
let page = null;
let sid = null;

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
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  let shotIdx = 0;
  await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
  const shot = async (label, opts = {}) => {
    const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT_DIR, name), fullPage: false, ...opts });
    currentShot = name;
    console.log(`${DIM}    📸 ${name}${RESET}`);
    return name;
  };

  const winBox = () => page.evaluate(() => {
    const el = document.querySelector('.window.focused') || document.querySelector('.window');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });

  // 用真实的边缘拖拽改窗口宽度（走 WindowFrame 的 resize 路径，不走 style 后门）
  const resizeFinderTo = async (targetW) => {
    const box = await winBox();
    if (!box) return null;
    if (Math.abs(box.w - targetW) <= 1) return box;
    const sx = box.x + box.w - 2;          // .rh-e 的命中带在窗口内侧（overflow:hidden 会裁掉外侧 3px）
    const sy = box.y + Math.round(box.h / 2);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + (targetW - box.w), sy, { steps: 12 });
    await page.mouse.up();
    await sleep(500);
    return winBox();
  };

  const openFinder = async () => {
    const btn = await page.$('.tb-app[title="文件资源管理器"]');
    if (!btn) return false;
    await btn.click();
    await page.waitForSelector('.window .finder', { timeout: 15000 }).catch(() => {});
    await sleep(700);
    return !!(await page.$('.window .finder'));
  };

  const maximize = async () => {
    const isMax = await page.evaluate(() => !!document.querySelector('.window.focused.maximized'));
    if (!isMax) {
      await page.evaluate(() => document.querySelector('.window.focused .tc-max')?.click());
      await sleep(500);
    }
  };
  const restore = async () => {
    const isMax = await page.evaluate(() => !!document.querySelector('.window.focused.maximized'));
    if (isMax) {
      await page.evaluate(() => document.querySelector('.window.focused .tc-max')?.click());
      await sleep(500);
    }
  };

  const finderW = () => page.evaluate(() => Math.round(document.querySelector('.finder')?.getBoundingClientRect().width || 0));
  const cmdInfo = () => page.$$eval('.finder-cmdbar .cmd-btn', (els) => els.map((e) => {
    const label = e.querySelector('.cmd-label');
    const ico = e.querySelector('svg');
    const cs = getComputedStyle(e);
    return {
      cmd: e.dataset.cmd || '',
      drop: e.dataset.drop || '',
      hasSvg: !!ico,
      label: label ? label.textContent.trim() : '',
      labelShown: !!label && getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0,
      w: Math.round(e.getBoundingClientRect().width),
      h: Math.round(e.getBoundingClientRect().height),
      bg: cs.backgroundColor,
      border: cs.borderTopColor,
      shadow: cs.boxShadow,
      transform: cs.transform,
      color: cs.color,
      radius: cs.borderTopLeftRadius,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      disabled: !!e.disabled,
      iconPx: ico ? Math.round(ico.getBoundingClientRect().width) : 0,
    };
  }));

  // 标签审计（对应 md §8「防自欺」的判定法）：用 Range 量文字的**真实排版宽度**，
  // 与按钮内容盒的右边界比；不用 scrollWidth 当唯一依据 —— 设计刻意不设 overflow:hidden，
  // 真被裁的时候 label 自己的 scrollWidth 反而不报警。
  const labelAudit = () => page.$$eval('.finder-cmdbar .cmd-btn', (els) => els
    .filter((b) => b.getBoundingClientRect().width > 0)
    .map((b) => {
      const lab = b.querySelector('.cmd-label');
      const cs = lab ? getComputedStyle(lab) : null;
      const bb = b.getBoundingClientRect();
      const bcs = getComputedStyle(b);
      let natural = 0;
      if (lab) {
        const r = document.createRange();
        r.selectNodeContents(lab);
        natural = r.getBoundingClientRect().width;
      }
      const lr = lab ? lab.getBoundingClientRect() : null;
      const right = bb.right - parseFloat(bcs.paddingRight) - parseFloat(bcs.borderRightWidth);
      return {
        cmd: b.dataset.cmd,
        text: lab ? lab.textContent.trim() : '',
        shown: !!lab && cs.display !== 'none' && lr.width > 0,
        ellipsis: cs ? cs.textOverflow : '',
        whiteSpace: cs ? cs.whiteSpace : '',
        dots: lab ? (lab.textContent || '').includes('\u2026') : false,
        naturalW: Math.round(natural * 10) / 10,
        labelW: lr ? Math.round(lr.width * 10) / 10 : 0,
        overRight: lr ? Math.round((lr.right - right) * 10) / 10 : 0,
        selfClip: lab ? lab.scrollWidth - lab.clientWidth : 0,
        scrollW: b.scrollWidth,
        clientW: b.clientWidth,
      };
    }));

  // 读某个属性当前的 transition 时长（ms）：v3 用「状态里改 --fx-tdur」实现三档，
  // 所以同一个按钮在 hover / active / 静默三种状态下的 computed 值必须不同。
  const transitionOf = (cmd) => page.evaluate((c) => {
    const b = document.querySelector(`.finder-cmdbar .cmd-btn[data-cmd="${c}"]`);
    if (!b) return null;
    const cs = getComputedStyle(b);
    const props = cs.transitionProperty.split(',').map((s) => s.trim());
    const durs = cs.transitionDuration.split(',').map((s) => s.trim());
    const eases = cs.transitionTimingFunction.split(',').map((s) => s.trim());
    const i = props.indexOf('background-color');
    const ms = (v) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
    return { ms: ms(durs[i < 0 ? 0 : i]), ease: eases[i < 0 ? 0 : i], all: durs.join(' ') };
  }, cmd);

  // 四态快照（v3 的「一变变四样」：底 / 海拔 / 圆角 / 状态层不透明度都是状态的一部分）
  const stateOf = (cmd) => page.evaluate((c) => {
    const b = document.querySelector(`.finder-cmdbar .cmd-btn[data-cmd="${c}"]`);
    if (!b) return null;
    const cs = getComputedStyle(b);
    const layer = getComputedStyle(b, '::before');
    return {
      shadow: cs.boxShadow, radius: cs.borderTopLeftRadius, transform: cs.transform,
      bg: cs.backgroundColor, layer: layer.opacity, layerBg: layer.backgroundColor,
    };
  }, cmd);

  // 探针：把令牌塞进一个临时 div 上读 computed 值（与页面上真正渲染的值同源，不硬编码字面色）
  const probe = (decl) => page.evaluate((d) => {
    const el = document.createElement('div');
    el.style.cssText = d;
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = { color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor, shadow: cs.boxShadow, radius: cs.borderTopLeftRadius };
    el.remove();
    return out;
  }, decl);
  const cmdDisabled = (label) => page.evaluate((l) => {
    const b = document.querySelector(`.finder-cmdbar .cmd-btn[data-cmd="${l}"]`);
    return b ? b.disabled : null;
  }, label);
  const barMetrics = () => page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const box = (sel) => {
      const el = q(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        bg: cs.backgroundColor, color: cs.color,
      };
    };
    return { toolbar: box('.finder-toolbar'), cmdbar: box('.finder-cmdbar'), finder: box('.finder') };
  });

  // ---------- 打开窗口 ----------
  section('打开文件资源管理器（宽窗 = 最大化）');
  await page.waitForSelector('.desktop', { timeout: 20000 });
  await sleep(600);
  const opened = await openFinder();
  check('文件资源管理器窗口已打开', opened, '未找到 .window .finder');
  if (!opened) throw new Error('文件窗口没有打开，后续用例无法继续');
  await maximize();
  const wideW = await finderW();
  check('窗口已最大化（容器宽度 ≥1090，进入「全标签」档）', wideW >= 1090, `finder 宽 ${wideW}`);

  // 等列表加载完（主目录里至少有 3 个文件）
  await page.waitForFunction(() => document.querySelectorAll('.finder-item').length >= 3, { timeout: 15000 }).catch(() => {});
  await sleep(300);

  // ---------- ① 结构：图标 / 标签 / 尺寸 / 材质分层 ----------
  section('① 命令按钮：内联 SVG 图标 + 中文标签 + v3 材质分层的几何与令牌');
  const metrics = await barMetrics();
  check('地址行高 36px / 命令行高 48px（v3 两行式头部）',
    metrics.toolbar?.h === 36 && metrics.cmdbar?.h === 48, JSON.stringify({ addr: metrics.toolbar?.h, cmd: metrics.cmdbar?.h }));

  const wide = await cmdInfo();
  const cmds = wide.map((c) => c.cmd);
  const labelCmds = ['新建', '上传', '剪切', '复制', '粘贴', '重命名', '删除', '排序', '查看'];
  check('命令按钮齐备（五组：主操作/上传/剪贴板/选择/视图；上传文件+上传文件夹已合成「上传 ⌄」一枚）',
    labelCmds.every((k) => cmds.includes(k)) && !cmds.some((k) => /^上传文件|^上传文件夹/.test(k)), cmds.join(','));
  check('每个命令按钮都有内联 SVG 图标（不是文字按钮）',
    wide.length >= 10 && wide.every((c) => c.hasSvg), `${wide.filter((c) => !c.hasSvg).map((c) => c.cmd).join(',') || '全部有图标'} / 共 ${wide.length}`);
  // 「粘贴选项」是分裂按钮的下拉半格（不是一个完整动作），宽窗下「搜索」是隐藏的图标按钮（宽 0）：两者不按 36×36 计量
  const sized = wide.filter((c) => c.cmd !== '粘贴选项' && c.w > 0);
  check('按钮高 36px、图标 18px、字号 13.5px、字重 500、圆角 10px',
    sized.length >= 10 && sized.every((c) => c.h === 36 && c.iconPx === 18 && c.fontSize === '13.5px'
      && /^10px/.test(c.radius) && (c.fontWeight === '500' || c.cmd === '新建')),
    JSON.stringify(sized.filter((c) => !(c.h === 36 && c.iconPx === 18 && c.fontSize === '13.5px' && /^10px/.test(c.radius))).slice(0, 3)));
  check('「粘贴」是分裂按钮（右侧 20px 下拉半格）', wide.find((c) => c.cmd === '粘贴选项')?.w === 20,
    String(wide.find((c) => c.cmd === '粘贴选项')?.w));
  check('≥1090 宽窗下中文标签全部可见（9 枚动作按钮都带可见 label）',
    labelCmds.every((k) => wide.find((c) => c.cmd === k)?.labelShown),
    JSON.stringify(wide.filter((c) => !c.labelShown).map((c) => c.cmd)));

  // v3 材质分层：静默就是一层「浮在条上的卡」——底色 / 描边 / 双层投影全部走 --fx-* 令牌
  const fxBtnBg = await probe('background: var(--fx-btn-bg)');
  const fxBtnLine = await probe('border: 1px solid var(--fx-btn-line)');
  const fxElev1 = await probe('box-shadow: var(--fx-elev-1)');
  const enabledOthers = wide.filter((c) => c.cmd !== '新建' && !c.disabled && c.w > 0);
  check('v3 静默海拔：非主操作按钮底色 = --fx-btn-bg、描边 = --fx-btn-line（白卡 / #303035，不再是透明底）',
    enabledOthers.length >= 3 && enabledOthers.every((c) => c.bg === fxBtnBg.bg && c.border === fxBtnLine.border),
    JSON.stringify({ want: [fxBtnBg.bg, fxBtnLine.border], got: enabledOthers.slice(0, 3).map((c) => `${c.cmd}:${c.bg}/${c.border}`) }));
  check('v3 静默海拔：按钮带 elev-1 双层投影（0 0 2px + 0 Npx Mpx），按下才归零',
    enabledOthers.length >= 3 && enabledOthers.every((c) => c.shadow === fxElev1.shadow),
    JSON.stringify({ want: fxElev1.shadow, got: enabledOthers.slice(0, 2).map((c) => `${c.cmd}:${c.shadow}`) }));

  // 强调色只给主操作，而且仍是蓝色（V1/V2 的近黑主操作会在蓝色选中行旁边读成两个产品）
  const primary = wide.find((c) => c.cmd === '新建');
  const accentBg = await probe('background: var(--accent)');
  check('唯一的主操作「新建」用强调色填充（--accent，保持蓝色、没改成近黑）',
    primary && primary.bg === accentBg.bg && primary.fontWeight === '600',
    JSON.stringify({ bg: primary?.bg, accentBg: accentBg.bg, fw: primary?.fontWeight }));
  const tokens = {
    accent: (await probe('color: var(--accent)')).color,
    danger: (await probe('color: var(--danger-text)')).color,
    text3: (await probe('color: var(--text-3)')).color,
  };
  check('无选中时危险操作「删除」按设计退成禁用灰（--text-3）',
    wide.find((c) => c.cmd === '删除')?.color === tokens.text3,
    JSON.stringify({ del: wide.find((c) => c.cmd === '删除')?.color, text3: tokens.text3 }));

  // v3 不用分组竖线：.cmd-sep 留在 DOM 里当语义分隔，但 display:none，分组靠 14px 留白
  const seps = await page.$$eval('.finder-cmdbar .cmd-sep', (els) => els.map((e) => getComputedStyle(e).display));
  const groupGap = await page.evaluate(() => getComputedStyle(document.querySelector('.finder-cmdbar .cmd-groups')).columnGap);
  check('v3 不画分组竖线（4 条 .cmd-sep 全部 display:none），分组改为 14px 留白',
    seps.length === 4 && seps.every((d) => d === 'none') && groupGap === '14px', JSON.stringify({ seps, groupGap }));

  // ---------- ①b 标签零截断 ----------
  section('①b 标签零截断：无 `…`、无 text-overflow、文字真实宽度不超出行内盒');
  const auditWide = await labelAudit();
  check('所有命令按钮标签不含 `…`（句末标点会被读成「被裁掉了」）',
    auditWide.every((a) => !a.dots), JSON.stringify(auditWide.filter((a) => a.dots).map((a) => a.cmd)));
  check('所有命令按钮标签都没有 text-overflow:ellipsis（放不下就整枚进「更多」）',
    auditWide.every((a) => a.ellipsis !== 'ellipsis'), JSON.stringify(auditWide.filter((a) => a.ellipsis === 'ellipsis').map((a) => a.cmd)));
  check('所有命令按钮 scrollWidth ≤ clientWidth + 1（没有横向溢出藏字）',
    auditWide.every((a) => a.scrollW <= a.clientW + 1), JSON.stringify(auditWide.filter((a) => a.scrollW > a.clientW + 1).map((a) => `${a.cmd}:${a.scrollW}/${a.clientW}`)));
  const shownLabels = auditWide.filter((a) => a.shown);
  check('可见标签的 Range 真实排版宽度没有被压窄、右边界在按钮内（0 处裁切）',
    shownLabels.length >= 9 && shownLabels.every((a) => a.naturalW <= a.labelW + 0.6 && a.overRight <= 0.5 && a.selfClip <= 1),
    JSON.stringify(shownLabels.filter((a) => a.naturalW > a.labelW + 0.6 || a.overRight > 0.5).map((a) => `${a.cmd}:${a.naturalW}/${a.labelW}/${a.overRight}`)));
  check('「上传」一枚覆盖原来两枚（上传文件 / 上传文件夹），菜单里给全称',
    cmds.includes('上传') && (await page.evaluate(() => {
      const b = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="上传"]');
      return !!b && b.dataset.drop === '上传';
    })), cmds.join(','));

  // ---------- ①c 动效三档 ----------
  section('①c 动效三档：进入 70ms / 按下 105ms / 回归 375ms（读 computed transition-duration）');
  const sortBtn = await page.$eval('.finder-cmdbar .cmd-btn[data-cmd="排序"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const idleDur = (await transitionOf('排序'))?.ms;
  const idleState = await stateOf('排序');
  await page.mouse.move(sortBtn.x, sortBtn.y);
  await sleep(240);
  const hoverDur = await transitionOf('排序');
  const hoverState = await stateOf('排序');
  await shot('light-1440-hover');
  await page.mouse.down();
  // 230ms > 按下档 105ms：既读到 duration（时长与已过去多久无关），又读到过渡**终点**的样式
  await sleep(230);
  const pressDur = await transitionOf('排序');
  const pressState = await stateOf('排序');
  await shot('light-1440-press');
  // 按下后先移开再松手：既读到按下态，又不会真的把「排序」菜单点出来
  await page.mouse.move(sortBtn.x, sortBtn.y + 220);
  await page.mouse.up();
  const backDur = await transitionOf('排序');
  await sleep(460);
  const backState = await stateOf('排序');
  check('悬停进入 ≈70ms（Carbon fast-01）', hoverDur && hoverDur.ms >= 60 && hoverDur.ms <= 80, JSON.stringify(hoverDur));
  check('按下 ≈105ms（M3 pressed）', pressDur && pressDur.ms >= 95 && pressDur.ms <= 115, JSON.stringify(pressDur));
  check('回到静默 ≈375ms（M3 release）：离开比进入慢，不是 0ms 硬切',
    backDur && backDur.ms >= 350 && backDur.ms <= 400 && idleDur >= 350 && backDur.ms > hoverDur.ms,
    JSON.stringify({ idle: idleDur, hover: hoverDur?.ms, press: pressDur?.ms, back: backDur?.ms }));
  check('三档曲线不是同一条（进入 / 按下 / 回归各自取 research 的值）',
    hoverDur?.ease !== pressDur?.ease && /cubic-bezier/.test(hoverDur?.ease || ''),
    JSON.stringify({ hover: hoverDur?.ease, press: pressDur?.ease, back: backDur?.ease }));

  // ---------- ①e 状态层与海拔 ----------
  section('①e 状态层与海拔：悬停 elev-2 + 8%，按下 elev-0 + 12% + 圆角 10→8 + 0.5px 下沉');
  const fxElev0 = await probe('box-shadow: var(--fx-elev-0)');
  const fxElev2 = await probe('box-shadow: var(--fx-elev-2)');
  check('静默：elev-1 双层投影 + 圆角 10 + 状态层 0',
    idleState.shadow === fxElev1.shadow && idleState.radius === '10px' && idleState.layer === '0',
    JSON.stringify(idleState));
  check('悬停：抬到 elev-2，并叠 8% M3 状态层（currentColor 覆盖）',
    hoverState.shadow === fxElev2.shadow && Math.abs(parseFloat(hoverState.layer) - 0.08) < 0.012,
    JSON.stringify({ shadow: hoverState.shadow, want: fxElev2.shadow, layer: hoverState.layer }));
  check('按下：海拔降到 elev-0（不是再抬一级）+ 状态层 12%',
    pressState.shadow === fxElev0.shadow && Math.abs(parseFloat(pressState.layer) - 0.12) < 0.015,
    JSON.stringify({ shadow: pressState.shadow, want: fxElev0.shadow, layer: pressState.layer }));
  check('按下：圆角 10→8 + 0.5px 下沉（M3 的 shape morph，不是只换底色）',
    pressState.radius === '8px' && /matrix\(1, 0, 0, 1, 0, 0\.5\)/.test(pressState.transform),
    JSON.stringify({ radius: pressState.radius, transform: pressState.transform }));
  check('松手后回到静默海拔与圆角（elev-1 / 10px / 状态层 0）',
    backState.shadow === fxElev1.shadow && backState.radius === '10px' && backState.layer === '0',
    JSON.stringify(backState));

  // ---------- ①d 涟漪 ----------
  section('①d 涟漪：按下有 .cmd-ripple、500ms 内移除、reduced-motion 下不出现');
  const rippleShot = await page.evaluate(async () => {
    const b = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="排序"]');
    const r = b.getBoundingClientRect();
    const before = b.querySelectorAll('.cmd-ripple').length;
    b.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
    }));
    const nodes = b.querySelectorAll('.cmd-ripple');
    const node = nodes[nodes.length - 1];
    const info = node ? { cls: node.className, dur: getComputedStyle(node).animationDuration, added: nodes.length - before } : null;
    await new Promise((res) => setTimeout(res, 620));
    return { made: !!node, info, left: b.querySelectorAll('.cmd-ripple').length };
  });
  check('按下一枚按钮时真的插入了涟漪节点（.cmd-ripple，105ms 展开）',
    rippleShot.made && rippleShot.info?.added === 1 && /^cmd-ripple/.test(rippleShot.info?.cls || '')
    && Math.abs(parseFloat(rippleShot.info?.dur || '0') * 1000 - 105) <= 5, JSON.stringify(rippleShot));
  check('涟漪播完必须从 DOM 移除（不累积节点）', rippleShot.left === 0, `残留 ${rippleShot.left} 个`);

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await sleep(150);
  const reduced = await page.evaluate(() => {
    const b = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="排序"]');
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    b.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
    }));
    return { made: !!b.querySelector('.cmd-ripple'), dur: cs.transitionDuration.split(',')[0].trim() };
  });
  await page.mouse.move(sortBtn.x, sortBtn.y);
  await page.mouse.down();
  await sleep(80);
  const reducedTf = await page.evaluate(() => getComputedStyle(document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="排序"]')).transform);
  await page.mouse.move(sortBtn.x, sortBtn.y + 220);
  await page.mouse.up();
  await sleep(120);
  check('prefers-reduced-motion: reduce 下不插涟漪节点', reduced.made === false, JSON.stringify(reduced));
  check('prefers-reduced-motion: reduce 下按下没有 0.5px 下沉（transform 保持 none）',
    reducedTf === 'none', reducedTf);
  check('prefers-reduced-motion: reduce 下过渡时长归零（≤1ms）',
    parseFloat(reduced.dur) <= 0.002, reduced.dur);
  await page.emulateMediaFeatures([]);
  await sleep(150);

  await shot('light-1440-wide');

  // ---------- ② focus-visible ----------
  section('② Tab 遍历工具栏：每个控件都有 2px 焦点环');
  let focusShotTaken = false;
  const focusStops = await (async () => {
    // 先 JS 聚焦一个可聚焦控件，再全程用键盘 Tab —— 之后命中的元素必然是 :focus-visible
    await page.evaluate(() => {
      const b = document.querySelector('.finder-toolbar .tb-btn:not(:disabled)');
      b?.focus();
    });
    const out = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      await sleep(60);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const inBar = !!(el.closest('.finder-toolbar') || el.closest('.finder-cmdbar'));
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          cmd: el.dataset?.cmd || (el.querySelector?.('.cmd-label')?.textContent.trim() || el.textContent.trim().slice(0, 8)),
          inBar,
          focusVisible: el.matches(':focus-visible'),
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
          boxShadow: cs.boxShadow,
          borderColor: cs.borderColor,
          // 输入框的焦点环画在外面那层 .finder-search 上（与 base.css 输入框的约定一致）
          wrapShadow: el.closest('.finder-search') ? getComputedStyle(el.closest('.finder-search')).boxShadow : '',
          wrapBorder: el.closest('.finder-search') ? getComputedStyle(el.closest('.finder-search')).borderColor : '',
        };
      });
      if (info?.inBar) out.push(info);
      // 截在命令按钮上（比截在面包屑上更能说明「命令行有焦点环」）
      if (info?.inBar && info.tag === 'button' && /^(新建|上传|剪切|复制|删除|排序|查看|更多)$/.test(info.cmd) && !focusShotTaken) {
        focusShotTaken = true;
        await shot('focus-visible');
      }
    }
    return out;
  })();
  // 按钮类控件 → 2px outline；输入框 → 强调色描边 + 2px 环形阴影（与 base.css 的输入框约定一致）
  const hasRing = (s) => {
    if (!s.focusVisible) return false;
    if (s.tag === 'input') return s.wrapShadow !== 'none' && s.wrapShadow !== '';
    return s.outlineStyle === 'solid' && parseFloat(s.outlineWidth) >= 2;
  };
  const ringIssues = focusStops.filter((s) => !hasRing(s));
  check('Tab 到工具栏的每个控件都匹配 :focus-visible 且 outline ≥2px',
    focusStops.length >= 8 && ringIssues.length === 0,
    `命中 ${focusStops.length} 个：${focusStops.map((s) => s.cmd).join('/')}；异常 ${JSON.stringify(ringIssues.slice(0, 3))}`);
  check('focus 态截图是在工具栏内抓到的（焦点环可见）', focusShotTaken);
  await page.evaluate(() => document.activeElement?.blur?.());
  await sleep(150);

  // ---------- ③ / ④ 禁用态与后退 ----------
  section('③ 无选中时的禁用态 · ④ 后退按钮的历史态');
  // 重新进一次目录，确保 sel 为空
  await page.evaluate(() => [...document.querySelectorAll('.sb-item')].find((b) => b.innerText.trim() === '主目录')?.click());
  await sleep(900);
  const noSel = {
    cut: await cmdDisabled('剪切'), copy: await cmdDisabled('复制'), del: await cmdDisabled('删除'),
    rename: await cmdDisabled('重命名'), paste: await cmdDisabled('粘贴'),
  };
  check('无选中：剪切 / 复制 / 删除 全部 disabled',
    noSel.cut === true && noSel.copy === true && noSel.del === true, JSON.stringify(noSel));
  check('无选中：重命名 disabled、剪贴板为空时粘贴 disabled',
    noSel.rename === true && noSel.paste === true, JSON.stringify(noSel));
  check('无选中时不出现多选注入的「下载」', !(await page.$('.finder-cmdbar .cmd-btn[data-cmd="下载"]')));
  const disabledStyle = await page.evaluate(() => {
    const b = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="剪切"]');
    const cs = getComputedStyle(b);
    return { color: cs.color, opacity: cs.opacity, bg: cs.backgroundColor };
  });
  const text3 = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.color = 'var(--text-3)';
    document.body.appendChild(d);
    const v = getComputedStyle(d).color;
    d.remove();
    return v;
  });
  check('禁用态用 --text-3 上色且不用 opacity 变淡',
    disabledStyle.color === text3 && disabledStyle.opacity === '1', JSON.stringify({ ...disabledStyle, text3 }));
  await shot('light-1440-nosel');

  const backDisabled0 = await page.evaluate(() => document.querySelector('.finder-toolbar .tb-btn[title^="后退"]')?.disabled);
  check('④ 后退按钮在历史第 0 条时 disabled', backDisabled0 === true, String(backDisabled0));
  await page.evaluate(() => {
    document.querySelector('.finder-item[data-name="docs"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(1000);
  const inDocs = await page.evaluate(() => document.querySelector('.finder-address')?.innerText || '');
  const backDisabled1 = await page.evaluate(() => document.querySelector('.finder-toolbar .tb-btn[title^="后退"]')?.disabled);
  check('④ 进入下一级目录后 后退 变可用、地址栏跟着变',
    backDisabled1 === false && /docs/.test(inDocs), JSON.stringify({ backDisabled1, addr: inDocs.replace(/\n/g, ' ').slice(0, 80) }));

  // ---------- ⑤ 长路径折叠 ----------
  section('⑤ 长路径（10 级）面包屑折叠 + 折叠菜单跳转');
  await page.evaluate(() => document.querySelector('.finder-address')?.click());
  await sleep(400);
  const dlgTitle = await page.$eval('.dialog h3', (el) => el.innerText.trim()).catch(() => '');
  check('地址药丸空白处点击仍是「前往文件夹」（行为未变）', dlgTitle === '前往文件夹', dlgTitle);
  await page.evaluate(() => document.querySelector('.dialog input')?.focus());
  await page.keyboard.type('a/b/c/d/e/f/g/h/i/j');
  await page.evaluate(() => document.querySelector('.dialog-actions .btn-primary')?.click());
  await sleep(1200);

  const fold = await page.evaluate(() => {
    const more = document.querySelector('.finder-address .crumb-more');
    const addr = document.querySelector('.finder-address');
    return {
      hasMore: !!more,
      moreText: more ? more.textContent.trim() : '',
      addrText: (addr?.innerText || '').replace(/\n/g, ' '),
      crumbCount: document.querySelectorAll('.finder-address .crumb').length,
    };
  });
  check('⑤ 深路径出现折叠「…」', fold.hasMore && fold.moreText === '…', JSON.stringify(fold));
  check('⑤ 折叠后只留 首段 + 末两段（i / j 可见）',
    /主目录/.test(fold.addrText) && /j$/.test(fold.addrText.trim()) && /i/.test(fold.addrText), fold.addrText);

  await page.evaluate(() => document.querySelector('.finder-address .crumb-more')?.click());
  await sleep(400);
  const foldedItems = await page.$$eval('.context-menu .dropdown-item', (els) => els.map((e) => e.innerText.trim()));
  check('⑤ 点「…」弹出被折叠的段（b–h 共 7 级）',
    ['b', 'c', 'd', 'e', 'f', 'g', 'h'].every((k) => foldedItems.includes(k)), foldedItems.join(','));
  await shot('long-path-folded-menu');
  await page.evaluate(() => {
    [...document.querySelectorAll('.context-menu .dropdown-item')].find((e) => e.innerText.trim() === 'd')?.click();
  });
  await sleep(1000);
  const jumped = await page.evaluate(() => ({
    addr: (document.querySelector('.finder-address')?.innerText || '').replace(/\n/g, ' '),
    items: [...document.querySelectorAll('.finder-item')].map((e) => e.dataset.name),
  }));
  check('⑤ 点折叠菜单里的「d」真的跳过去了（末段是 d）',
    /d\s*$/.test(jumped.addr.trim()) && jumped.items.includes('e'), JSON.stringify({ addr: jumped.addr, items: jumped.items }));

  await page.evaluate(() => [...document.querySelectorAll('.sb-item')].find((b) => b.innerText.trim() === '主目录')?.click());
  await sleep(900);

  // ---------- 多选态 ----------
  section('选中 2 项：动作启用 + 注入「下载」');
  await page.evaluate(() => {
    const [a, b] = ['a.txt', 'b.txt'].map((n) => document.querySelector(`.finder-item[data-name="${n}"]`));
    a?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  });
  await sleep(400);
  const sbText = await page.$eval('.finder-statusbar', (el) => el.innerText.replace(/\n/g, ' '));
  check('状态栏显示「已选择 2 项」', /已选择 2 项/.test(sbText), sbText);
  const sel2 = {
    cut: await cmdDisabled('剪切'), copy: await cmdDisabled('复制'), del: await cmdDisabled('删除'),
    rename: await cmdDisabled('重命名'),
    download: await page.$('.finder-cmdbar .cmd-btn[data-cmd="下载"]').then((h) => !!h),
  };
  check('选中 2 项后 剪切 / 复制 / 删除 均可用',
    sel2.cut === false && sel2.copy === false && sel2.del === false, JSON.stringify(sel2));
  check('选中 2 项后注入「下载」按钮（多选操作），重命名仍限制单选',
    sel2.download === true && sel2.rename === true, JSON.stringify(sel2));
  const delColor = await page.$eval('.finder-cmdbar .cmd-btn[data-cmd="删除"]', (el) => getComputedStyle(el).color);
  check('删除在有选中（可用）时用危险色 --danger-text', delColor === tokens.danger,
    JSON.stringify({ del: delColor, danger: tokens.danger }));
  await shot('light-1440-multiselect');

  // ---------- ⑥ 窄窗三段降级 ----------
  section('⑥ 700 / 560 宽窗：纯图标 → 收进「更多」，零横向溢出');
  await restore();
  await sleep(300);
  const w700 = await resizeFinderTo(700);
  check('窗口已缩到 700（±4px）', w700 && Math.abs(w700.w - 700) <= 4, JSON.stringify(w700));
  const mid = await cmdInfo();
  const midShown = mid.filter((c) => c.labelShown).map((c) => c.cmd);
  // 从令牌读按钮高（不硬编码）：v3 = --fx-btn-h 36，降级后的图标态按钮宽 = 高
  const btnH = await page.evaluate(() => {
    const el = document.createElement('div');
    el.style.cssText = 'height: var(--fx-btn-h)';
    document.body.appendChild(el);
    const h = Math.round(el.getBoundingClientRect().height);
    el.remove();
    return h;
  });
  check('700 宽：次要动作降级为 36×36 纯图标（标签隐藏）',
    mid.filter((c) => labelCmds.includes(c.cmd)).every((c) => !c.labelShown || c.cmd === '新建' || c.cmd === '上传'),
    `仍带标签：${midShown.join(',')}`);
  check('700 宽：图标按钮宽度正好 36px（= --fx-btn-h）',
    mid.filter((c) => !c.labelShown).every((c) => c.w === btnH), JSON.stringify(mid.filter((c) => !c.labelShown && c.w !== btnH).map((c) => `${c.cmd}:${c.w}`)));
  const m700 = await barMetrics();
  check('700 宽：命令行无横向溢出', m700.cmdbar.scrollW <= m700.cmdbar.clientW + 1, JSON.stringify({ scrollW: m700.cmdbar.scrollW, clientW: m700.cmdbar.clientW }));
  await shot('light-700');

  const w560 = await resizeFinderTo(560);
  check('窗口已缩到 560（最小宽度，±4px）', w560 && Math.abs(w560.w - 560) <= 4, JSON.stringify(w560));
  const narrow = await cmdInfo();
  const narrowLabels = narrow.filter((c) => c.labelShown).map((c) => c.cmd);
  check('560 宽：主操作「新建」仍有中文标签', narrowLabels.includes('新建'), narrowLabels.join(',') || '(无)');
  check('560 宽：其余按钮全部纯图标（36×36）',
    narrow.filter((c) => c.cmd !== '新建').every((c) => !c.labelShown && c.w === 36),
    JSON.stringify(narrow.filter((c) => c.cmd !== '新建' && c.labelShown && c.cmd !== '粘贴选项').map((c) => `${c.cmd}:${c.w}`)));
  const m560 = await barMetrics();
  check('560 宽：命令行与整个窗口都没有横向溢出（scrollWidth ≤ clientWidth）',
    m560.cmdbar.scrollW <= m560.cmdbar.clientW + 1 && m560.finder.scrollW <= m560.finder.clientW + 1,
    JSON.stringify({ cmd: [m560.cmdbar.scrollW, m560.cmdbar.clientW], finder: [m560.finder.scrollW, m560.finder.clientW] }));
  // 两行头部加起来 84px，且不把内容区/状态栏挤出窗口（不出现「外层 + 内容区」双滚动条）
  const layout = await page.evaluate(() => {
    const f = document.querySelector('.finder');
    const c = document.querySelector('.finder-content');
    const sb = document.querySelector('.finder-statusbar');
    const addr = document.querySelector('.finder-toolbar').getBoundingClientRect();
    const cmd = document.querySelector('.finder-cmdbar').getBoundingClientRect();
    return {
      header: Math.round(addr.height + cmd.height),
      outerOverflowY: f.scrollHeight - f.clientHeight,
      contentOverflowX: c.scrollWidth - c.clientWidth,
      statusInside: Math.round(sb.getBoundingClientRect().bottom) <= Math.round(f.getBoundingClientRect().bottom) + 1,
      cmdBottom: Math.round(cmd.bottom),
      contentTop: Math.round(c.getBoundingClientRect().top),
    };
  });
  check('两行头部共 84px（36+48），状态栏仍在窗口内、无双滚动条、内容区不被顶动',
    layout.header === 84 && layout.outerOverflowY <= 0 && layout.contentOverflowX <= 1
    && layout.statusInside && layout.contentTop === layout.cmdBottom,
    JSON.stringify(layout));
  await shot('light-560');

  // 窄窗同样零截断：标签被降级成图标，但残留的 data-cmd / tooltip 文案也不许带 `…`
  const auditNarrow = await labelAudit();
  check('560 宽：命令按钮依旧无 `…`、无 text-overflow、无横向溢出',
    auditNarrow.every((a) => !a.dots && a.ellipsis !== 'ellipsis' && a.scrollW <= a.clientW + 1),
    JSON.stringify(auditNarrow.filter((a) => a.dots || a.ellipsis === 'ellipsis' || a.scrollW > a.clientW + 1).map((a) => a.cmd)));

  // 「更多」在窄窗下必须能把所有动作接住
  await page.evaluate(() => document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="更多"]')?.click());
  await sleep(400);
  const moreItems = await page.$$eval('.context-menu .dropdown-item', (els) =>
    els.map((e) => e.innerText.trim().split('\n')[0].trim()));
  check('560 宽：「更多」菜单里上传 / 剪贴板 / 重命名 / 排序 / 视图 / 刷新 一个不少',
    ['上传文件', '上传文件夹', '剪切', '复制', '粘贴', '重命名', '排序方式', '视图', '刷新'].every((k) => moreItems.includes(k)),
    moreItems.join(','));
  await page.keyboard.press('Escape');
  await sleep(250);

  // 搜索展开：占用 200px 宽 → 必须靠 JS 把动作收进「更多」（第三段降级），且不产生溢出
  const beforeExpand = (await cmdInfo()).length;
  await page.evaluate(() => document.querySelector('.finder-cmdbar .fx-search-toggle')?.click());
  await sleep(700);
  const expanded = await page.evaluate(() => ({
    searchVisible: (() => {
      const el = document.querySelector('.finder-cmdbar .finder-search');
      return !!el && getComputedStyle(el).display !== 'none';
    })(),
    searchW: Math.round(document.querySelector('.finder-cmdbar .finder-search')?.getBoundingClientRect().width || 0),
    cmdbarH: Math.round(document.querySelector('.finder-cmdbar').getBoundingClientRect().height),
    overflow: (() => {
      const el = document.querySelector('.finder-cmdbar');
      return el.scrollWidth - el.clientWidth;
    })(),
    count: document.querySelectorAll('.finder-cmdbar .cmd-btn').length,
    barW: Math.round(document.querySelector('.finder-cmdbar').clientWidth),
    scrollW: document.querySelector('.finder-cmdbar').scrollWidth,
    groupsW: Math.round(document.querySelector('.cmd-groups')?.getBoundingClientRect().width || 0),
    rightW: Math.round(document.querySelector('.cmd-right')?.getBoundingClientRect().width || 0),
    searchW: Math.round(document.querySelector('.finder-cmdbar .finder-search')?.getBoundingClientRect().width || 0),
    hasMore: !!document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="更多"]'),
    focusInSearch: !!document.activeElement?.closest?.('.finder-search'),
  }));
  check('560 宽：点搜索图标展开输入框、焦点落在输入框里', expanded.searchVisible && expanded.focusInSearch, JSON.stringify(expanded));
  check('搜索展开后仍无横向溢出，且命令行高度不变（不跳版）',
    expanded.overflow <= 1 && expanded.cmdbarH === 48, JSON.stringify({ overflow: expanded.overflow, h: expanded.cmdbarH }));
  check('搜索展开后命令组确实被收进「更多」（第三段降级真的在跑）',
    expanded.count < beforeExpand && expanded.hasMore, `展开前 ${beforeExpand} 个按钮 → 展开后 ${expanded.count} 个`);
  await shot('light-560-search-open');
  await page.keyboard.press('Escape');
  await sleep(500);

  // ---------- ⑦ 暗色 ----------
  section('⑦ 暗色：命令栏 / 文字 / 按钮材质随令牌变化');
  const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);
  const readTheme = () => page.evaluate(() => {
    const bar = document.querySelector('.finder-cmdbar');
    const btn = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="上传"]');
    const pill = document.querySelector('.finder-address');
    const cs = getComputedStyle(bar);
    const csb = getComputedStyle(btn);
    const csp = getComputedStyle(pill);
    return {
      barBg: cs.backgroundColor,
      btnColor: csb.color,
      btnBg: csb.backgroundColor,
      btnBorder: csb.borderTopColor,
      btnShadow: csb.boxShadow,
      pillBg: csp.backgroundColor,
      pillBorder: csp.borderTopColor,
    };
  });
  await restore();
  await sleep(300);
  await maximize();
  await sleep(400);
  if ((await themeOf()) !== 'light') {
    await page.evaluate(() => document.querySelector('.tray-account')?.click());
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')]
      .find((b) => b.innerText.includes('浅色主题'))?.click());
    await sleep(400);
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  const lightTheme = await readTheme();
  await shot('light-1440');

  await page.evaluate(() => document.querySelector('.tray-account')?.click());
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')]
    .find((b) => b.innerText.includes('深色主题'))?.click());
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(400);
  const darkTheme = await readTheme();
  const darkElev1 = await probe('box-shadow: var(--fx-elev-1)');
  check('⑦ 暗色下命令栏底色随令牌变化（不硬编码颜色）',
    darkTheme.barBg !== lightTheme.barBg, JSON.stringify({ light: lightTheme.barBg, dark: darkTheme.barBg }));
  check('⑦ 暗色下按钮文字色随令牌变化', darkTheme.btnColor !== lightTheme.btnColor,
    JSON.stringify({ light: lightTheme.btnColor, dark: darkTheme.btnColor }));
  // v3 材质分层：暗色下阴影几乎不可见，靠实色阶梯（#303035 → #38383e → #2a2a2f）区分三态，
  // 所以「按钮底色 / 描边」必须跟着令牌走，不能是亮色那套白卡硬编码
  check('⑦ 暗色下按钮底色随令牌变化（白卡 → #303035 级灰阶）',
    darkTheme.btnBg !== lightTheme.btnBg, JSON.stringify({ light: lightTheme.btnBg, dark: darkTheme.btnBg }));
  check('⑦ 暗色下按钮描边随令牌变化（黑 5.5% → 白 5%）',
    darkTheme.btnBorder !== lightTheme.btnBorder, JSON.stringify({ light: lightTheme.btnBorder, dark: darkTheme.btnBorder }));
  check('⑦ 暗色下按钮仍是 elev-1 双层投影（按下才归零）',
    darkTheme.btnShadow === darkElev1.shadow && darkTheme.btnShadow !== lightTheme.btnShadow
    && darkTheme.btnShadow.split(',').length >= 2,
    JSON.stringify({ light: lightTheme.btnShadow, dark: darkTheme.btnShadow, want: darkElev1.shadow }));
  check('⑦ 地址药丸用 --fx-pill-bg 做凸面（暗色下与工具栏底色不同）',
    darkTheme.pillBg !== darkTheme.barBg, JSON.stringify({ pill: darkTheme.pillBg, bar: darkTheme.barBg }));
  await shot('dark-1440');

  // 暗色窄窗
  await restore();
  await sleep(250);
  await resizeFinderTo(700);
  await sleep(300);
  await shot('dark-700');
  await resizeFinderTo(560);
  await sleep(300);
  const dark560 = await barMetrics();
  check('⑦ 暗色 560 宽同样无横向溢出', dark560.cmdbar.scrollW <= dark560.cmdbar.clientW + 1,
    JSON.stringify({ scrollW: dark560.cmdbar.scrollW, clientW: dark560.cmdbar.clientW }));
  await shot('dark-560');

  // ---------- ⑧ 上传中态 ----------
  section('⑧ 上传进行中：按钮自带进度 + 进度胶囊');
  await page.evaluate(() => document.querySelector('.tray-account')?.click());
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.tb-popover .account-popover .dropdown-item')]
    .find((b) => b.innerText.includes('浅色主题'))?.click());
  await sleep(400);
  await page.keyboard.press('Escape');
  await sleep(300);
  await restore();
  await sleep(250);
  await maximize();
  await sleep(400);

  // 慢速上传：用 CDP 的网络延迟模拟把每个分片拖慢，才能稳定观察到「上传中」这一帧。
  // （不用 setRequestInterception：拦截会丢掉 PUT 的请求体，上传直接 400/404，测不到进度态）
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 1200, downloadThroughput: -1, uploadThroughput: -1,
  });
  const bigFile = join(tmpRoot || os.tmpdir(), 'uitest-big-upload.bin');
  writeFileSync(bigFile, Buffer.alloc(16 * 1024 * 1024, 0x61)); // 16MB → 4 个 4MB 分片
  const upBtn = await page.$('.finder-cmdbar .cmd-btn[data-cmd="上传"]');
  let uploadErr = '';
  try {
    // 「上传」现在是一级短词（上传 ⌄）+ 二级菜单（上传文件 / 上传文件夹）：
    // 选择器跟着改，但「点击→系统文件选择器」这条行为路径一字未动
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 10000 }),
      (async () => {
        await upBtn.click();
        await sleep(280);
        await page.evaluate(() => {
          const item = [...document.querySelectorAll('.context-menu .dropdown-item')]
            .find((e) => (e.dataset.label || e.innerText.trim()) === '上传文件');
          item?.click();
        });
      })(),
    ]);
    await chooser.accept([bigFile]);
  } catch (e) { uploadErr = String(e?.message || e); }
  check('⑧ 「上传 ⌄ → 上传文件」打开系统文件选择器并选到文件', !uploadErr, uploadErr);

  const upState = await page.waitForFunction(() => {
    const pill = document.querySelector('.finder-cmdbar .fx-up');
    const btn = document.querySelector('.finder-cmdbar .cmd-btn[data-cmd="上传"]');
    if (!pill || !btn?.classList.contains('is-uploading')) return null;
    return {
      pillText: pill.innerText.replace(/\n/g, ' '),
      pct: pill.querySelector('.fx-up-n')?.textContent || '',
      bar: btn.className,
      hasTrack: !!pill.querySelector('.fx-up-track'),
      cmdbarH: Math.round(document.querySelector('.finder-cmdbar').getBoundingClientRect().height),
    };
  }, { timeout: 20000, polling: 100 }).then((h) => h.jsonValue()).catch(() => null);
  check('⑧ 上传中命令行出现进度胶囊（含百分比与进度轨道）',
    !!upState && /\d+%/.test(upState.pct) && upState.hasTrack, JSON.stringify(upState));
  check('⑧ 上传按钮自身带进度态（is-uploading，不另开弹层）',
    !!upState && /is-uploading/.test(upState.bar), upState?.bar);
  check('⑧ 上传中命令行高度不变（无跳动）', !!upState && upState.cmdbarH === 48, String(upState?.cmdbarH));
  const advanced = await page.waitForFunction(() => {
    const n = document.querySelector('.finder-cmdbar .fx-up-n');
    return n && parseInt(n.textContent, 10) > 0;
  }, { timeout: 25000, polling: 100 }).then(() => true).catch(() => false);
  const pctNow = await page.$eval('.finder-cmdbar .fx-up-n', (el) => el.textContent).catch(() => '?');
  check('⑧ 进度百分比真的在走（不是静态徽标）', advanced, pctNow);
  await shot('light-1440-uploading');

  // 等上传结束：胶囊消失（0.6s 内）
  const upDone = await page.waitForFunction(
    () => !document.querySelector('.finder-cmdbar .fx-up'), { timeout: 60000, polling: 200 },
  ).then(() => true).catch(() => false);
  check('⑧ 上传完成后进度胶囊自动消失', upDone);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }).catch(() => {});
  await cdp.detach().catch(() => {});

  // ---------- 控制台 ----------
  section('控制台');
  const realErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
  check('浏览器控制台无 JS 错误', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));

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
