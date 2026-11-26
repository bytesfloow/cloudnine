#!/usr/bin/env node
/**
 * CloudNine · 读取解码 / 截断自测（GET /api/fs/read）
 *
 * 背景（2026-11 修的核心缺陷）：
 *   老实现只做一次 `TextDecoder('utf-8', {fatal:true})`，一旦文件被 maxKB 截断、
 *   最后一个多字节字符被切了一半，fatal 就抛错 → 整篇退回 gb18030 → 满屏乱码。
 *   受影响的不只是插件：内置编辑器打开 >512KB 的中文文本就是一片乱码。
 *
 * 本脚本覆盖：
 *   a. 中文文本，maxKB 刚好切在多字节字符中间 → encoding 仍是 utf-8、text 是合法 UTF-8 前缀、
 *      没有 U+FFFD、truncated=true（按字节对比源文件前缀）
 *   b. 切在字符边界上 → 同样 utf-8、truncated=true、内容完整到切点
 *   c. 真 GB18030 文件（不截断 / 被截断两种）→ 仍然回退 gb18030，内容正确
 *   d. 不截断但尾部就是非法 UTF-8 → 行为明确（回退 gb18030）、不崩、不 500
 *   e. 1MB 以上中文全文读取 → 内容与源文件逐字节一致、encoding=utf-8、truncated=false
 *   f. 内置编辑器场景：>512KB 中文 .txt 双击用内置编辑器打开 → 不是乱码（关键字 + 截图）
 *
 * 默认自己起一套干净环境（不碰仓库里正在跑的 dev / 生产实例）：
 *   DATA_DIR / FILE_ROOT 全在系统临时目录，端口 8712，跑完清理。
 *
 * 用法：
 *   node scripts/uitest-encoding-truncation.mjs
 *   node scripts/uitest-encoding-truncation.mjs --chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *   node scripts/uitest-encoding-truncation.mjs --keep
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- puppeteer-core（只有 f 段用得到，装不上就跳过浏览器段）----------
let puppeteer = null;
function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    resolve(ROOT, '..', '.uitest', 'node_modules', 'puppeteer-core'),
    resolve(ROOT, 'node_modules', 'puppeteer-core'),
    'puppeteer-core',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* 继续找 */ }
  }
  return null;
}

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const PORT = Number(arg('port', 8712));
const URL_BASE = (arg('url', `http://127.0.0.1:${PORT}/`) || '').replace(/\/$/, '');
const OWN_SERVER = !arg('url', null);
const USERNAME = arg('user', 'uitest');
const PASSWORD = arg('password', 'Uitest12345');
const CHROME = arg('chrome', process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const KEEP = flag('keep');
const OUT_DIR = resolve(ROOT, arg('out', 'shots/encoding-truncation'));

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
let dataDir = null;
let filesRoot = null;
let serverEnv = null;

// 测试语料
const CN_500 = '中'.repeat(500);                         // 1500 字节，3 字节/字
const CN_BOUNDARY = 'a'.repeat(1024) + '中';            // 1024 字节整：maxKB=1 正好切在字符边界
const GBK_HEADER = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]); // '中文测试' 的 GBK 编码
const BIG_CN = ('# 中文大文件\n\n这是一段用来验证 1MB 以上中文文本读取的内容。\n' +
  '行内容：云九、插件、终端、桌面、文件管理器。\n').repeat(9000);   // ≈1.5MB 字符 / ≈4MB 字节

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
  tmpRoot = mkdtempSync(join(os.tmpdir(), 'cn-encoding-uitest-'));
  dataDir = join(tmpRoot, 'data');
  filesRoot = join(tmpRoot, 'files');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(filesRoot, 'docs'), { recursive: true });

  writeFileSync(join(filesRoot, 'cn-500.md'), CN_500, 'utf8');            // 1500 字节中文
  writeFileSync(join(filesRoot, 'cn-boundary.md'), CN_BOUNDARY, 'utf8');  // 1024 字节整
  // 真 GB18030：'中文测试' + ASCII + 再来一串 GBK 中文（每个 '中' 都是 D6 D0）
  const gbkSmall = Buffer.concat([
    Buffer.from('# '),
    GBK_HEADER,
    Buffer.from('\n2026 ok\n'),
    Buffer.from([0xd6, 0xd0, 0xd6, 0xd0, 0xd6, 0xd0]), // '中中中'
  ]);
  writeFileSync(join(filesRoot, 'gbk-small.txt'), gbkSmall);
  const gbkBig = Buffer.concat(Array.from({ length: 600 }, () => Buffer.from([0xd6, 0xd0]))); // 1200 字节 GBK 中文
  writeFileSync(join(filesRoot, 'gbk-1200.txt'), gbkBig);
  // 不截断、但尾部是非法 UTF-8 字节（0xFF）
  writeFileSync(join(filesRoot, 'bad-tail.txt'), Buffer.concat([Buffer.from('中文内容', 'utf8'), Buffer.from([0xff])]));
  // 1MB+ 中文
  writeFileSync(join(filesRoot, 'big-cn.md'), BIG_CN, 'utf8');
  // 内置编辑器场景：>512KB 中文 txt，关键字在 512KB 以内，越界关键字在 512KB 以后
  const head = '# 中文大文件自测\n\n第一段关键字：云九乱码探针\n\n';
  const filler = '这是用来撑到 512KB 以上的中文正文，反复重复同一句话。\n';
  const markerBeyond = '越界关键字：这一段在 512KB 之后，编辑器只读前一部分时看不到。\n';
  let body = head;
  while (Buffer.byteLength(body + filler, 'utf8') < 560 * 1024) body += filler;
  writeFileSync(join(filesRoot, 'big-chinese.txt'), body + markerBeyond, 'utf8');
  writeFileSync(join(filesRoot, 'readme.txt'), 'cloudnine encoding uitest\n');

  serverEnv = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    FILE_ROOT: filesRoot,
    SITE_NAME: 'CloudNine 编码自测',
  };
  await startServer();
  console.log(`${DIM}临时数据目录：${tmpRoot}${RESET}`);
  console.log(`${DIM}临时 FILE_ROOT：${filesRoot}${RESET}`);
  console.log(`${DIM}big-chinese.txt = ${statSync(join(filesRoot, 'big-chinese.txt')).size} 字节${RESET}`);
}

async function cleanup() {
  if (child && !child.killed) {
    child.kill();
    await sleep(300);
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  if (tmpRoot && !KEEP) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
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

// ================= 2. 主流程 =================
let sid = null;
const readApi = async (rel, maxKB) => {
  const q = `/api/fs/read?path=${encodeURIComponent(rel)}${maxKB ? `&maxKB=${maxKB}` : ''}`;
  const t0 = Date.now();
  const r = await fetch(`${URL_BASE}${q}`, { headers: { cookie: `cloudnine_sid=${sid}` } });
  const ms = Date.now() - t0;
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j, ms };
};

const MOJIBAKE = /[\uFFFD]|涓枃|涓枃|锛|銆|鏂囦欢|瓒呭ぇ|澶ф枃浠/; // 常见 UTF-8→GB18030 误读特征

async function main() {
  if (OWN_SERVER) await prepareEnv();
  sid = await ensureAccount(URL_BASE);
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`${BOLD}CloudNine 读取解码 / 截断自测${RESET}  目标: ${URL_BASE}`);

  // ---------- a. 中文截断切在多字节字符中间 ----------
  section('a. 中文文本被 maxKB 切在多字节字符中间');
  const a = await readApi('cn-500.md', 1);   // 1024 字节 = 341 个「中」+ 1 个字节（切断）
  const aSrc = readFileSync(join(filesRoot, 'cn-500.md'));
  check('HTTP 200 且返回体字段齐全（content / encoding / truncated / size / mtimeMs）',
    a.status === 200 && a.body && typeof a.body.content === 'string' && 'encoding' in a.body
    && 'truncated' in a.body && typeof a.body.size === 'number' && typeof a.body.mtimeMs === 'number',
    JSON.stringify({ status: a.status, keys: a.body && Object.keys(a.body) }));
  check('截断后 encoding 仍是 utf-8（不再整篇退回 gb18030）', a.body?.encoding === 'utf-8', a.body?.encoding);
  check('truncated=true、size=真实字节数（1500）', a.body?.truncated === true && a.body?.size === 1500,
    JSON.stringify({ truncated: a.body?.truncated, size: a.body?.size }));
  check('text 里没有替换符 / 典型乱码', !/[\uFFFD]/.test(a.body?.content || '')
    && !MOJIBAKE.test(a.body?.content || ''), (a.body?.content || '').slice(0, 40));
  check('text 是源文件按字节的合法 UTF-8 前缀（正好 341 个字 = 1023 字节）',
    a.body?.content === '中'.repeat(341)
    && Buffer.byteLength(a.body?.content || '', 'utf8') === 1023
    && aSrc.subarray(0, 1023).equals(Buffer.from(a.body?.content || '', 'utf8')),
    `len=${Buffer.byteLength(a.body?.content || '', 'utf8')}`);
  check('不存在「长度不是字符整数倍」的半截字符（text 能被再次 UTF-8 编码且字节数对齐）',
    Buffer.from(a.body?.content || '', 'utf8').toString('utf8') === a.body?.content);

  // ---------- b. 切在字符边界上 ----------
  section('b. 截断点正好落在字符边界');
  const b = await readApi('cn-boundary.md', 1);  // 1024 字节整：1024 个 a，接下来的「中」整字未被载入
  check('边界截断：utf-8 / truncated=true / 内容 = 1024×a（不多不少）',
    b.body?.encoding === 'utf-8' && b.body?.truncated === true
    && b.body?.content === 'a'.repeat(1024) && !/\uFFFD/.test(b.body?.content || ''),
    JSON.stringify({ enc: b.body?.encoding, len: (b.body?.content || '').length }));

  // ---------- c. 真 GB18030 ----------
  section('c. 真 GB18030 文件仍能正确回退');
  const gbkProbe = new TextDecoder('gb18030').decode(GBK_HEADER);
  check('（自检）GBK 编码样例探针解码正确：D6D0 CEC4 B2E2 CAD4 = 中文测试', gbkProbe === '中文测试', gbkProbe);
  const c1 = await readApi('gbk-small.txt', 8192);
  check('完整 GB18030 文件：encoding=gb18030、内容正确、truncated=false',
    c1.body?.encoding === 'gb18030' && c1.body?.truncated === false
    && (c1.body?.content || '').startsWith('# 中文测试') && (c1.body?.content || '').includes('2026 ok')
    && (c1.body?.content || '').endsWith('中中中'),
    JSON.stringify({ enc: c1.body?.encoding, head: (c1.body?.content || '').slice(0, 30) }));
  const c2 = await readApi('gbk-1200.txt', 1);  // 1200 字节 GBK，读 1024 字节 → 尾部切断
  check('被截断的 GB18030 文件仍判为 gb18030（不会被新逻辑误当 utf-8）',
    c2.body?.encoding === 'gb18030' && c2.body?.truncated === true,
    JSON.stringify({ enc: c2.body?.encoding, truncated: c2.body?.truncated }));
  check('被截断的 GB18030 内容仍是「中」的重复（512 个字）',
    /^中+$/.test(c2.body?.content || '') && (c2.body?.content || '').length === 512,
    `len=${(c2.body?.content || '').length}`);

  // ---------- d. 不截断但尾部非法 UTF-8 ----------
  section('d. 完整读取但尾部有非法 UTF-8 字节（不崩、行为明确）');
  const d = await readApi('bad-tail.txt', 8192);
  check('HTTP 200、不 500、返回体仍是字符串', d.status === 200 && typeof d.body?.content === 'string',
    JSON.stringify({ status: d.status, keys: d.body && Object.keys(d.body) }));
  check('truncated=false（文件读完了），且 encoding 落在明确档位（gb18030 / latin1）',
    d.body?.truncated === false && ['gb18030', 'latin1'].includes(d.body?.encoding),
    JSON.stringify({ enc: d.body?.encoding, truncated: d.body?.truncated }));
  check('size 是真实字节数（13）', d.body?.size === 13, String(d.body?.size));

  // ---------- e. 1MB 以上中文全文 ----------
  section('e. 1MB 以上中文全文读取');
  const e = await readApi('big-cn.md', 8192);
  const srcBytes = readFileSync(join(filesRoot, 'big-cn.md'));
  check('全文读取：truncated=false、encoding=utf-8、size 与磁盘一致',
    e.body?.truncated === false && e.body?.encoding === 'utf-8' && e.body?.size === srcBytes.length,
    JSON.stringify({ truncated: e.body?.truncated, size: e.body?.size, disk: srcBytes.length }));
  check('内容与源文件逐字节一致（4MB+ 中文）',
    Buffer.from(e.body?.content || '', 'utf8').equals(srcBytes),
    `bytes=${Buffer.byteLength(e.body?.content || '', 'utf8')} disk=${srcBytes.length}`);
  check('没有乱码特征', !MOJIBAKE.test(e.body?.content || ''));
  console.log(`${DIM}    4MB 中文读取耗时 ${e.ms} ms${RESET}`);
  check('大文件读取没有明显变慢（< 3000ms）', e.ms < 3000, `${e.ms}ms`);

  // 老行为对照：默认 maxKB（512KB）读同一个 >1MB 的文件也必须 utf-8
  const e2 = await readApi('big-cn.md');
  check('默认 maxKB（512KB）截断 4MB 中文文件：仍是 utf-8 且无乱码',
    e2.body?.encoding === 'utf-8' && e2.body?.truncated === true
    && !MOJIBAKE.test(e2.body?.content || '') && !/\uFFFD/.test(e2.body?.content || ''),
    JSON.stringify({ enc: e2.body?.encoding, len: (e2.body?.content || '').length }));

  // ---------- f. 内置编辑器场景（浏览器）----------
  section('f. 内置编辑器打开 >512KB 中文文本（不是乱码）');
  puppeteer = puppeteer || loadPuppeteer();
  if (!puppeteer) {
    check('puppeteer-core 可用（浏览器段）', false, '未找到 puppeteer-core');
  } else {
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    });
    let shotIdx = 0;
    const page = await browser.newPage();
    const shot = async (label) => {
      const name = `${String(++shotIdx).padStart(2, '0')}-${label}.png`;
      await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
      currentShot = name;
      console.log(`${DIM}    📸 ${name}${RESET}`);
      return name;
    };
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await browser.setCookie({
        name: 'cloudnine_sid', value: sid, domain: new URL(URL_BASE).hostname, path: '/', httpOnly: true,
      });
      const consoleErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

      await page.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('.desktop-icons', { timeout: 20000 });
      const iconOk = await page.waitForSelector('.desktop-icon[data-entry="big-chinese.txt"]', { timeout: 15000 })
        .then(() => true).catch(() => false);
      check('桌面上有 big-chinese.txt（>512KB 中文）', iconOk);

      const box = iconOk ? await page.evaluate(() => {
        const r = document.querySelector('.desktop-icon[data-entry="big-chinese.txt"]').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }) : null;
      if (box) {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
        await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
      }
      const opened = await page.waitForSelector('.window .editor-window', { timeout: 20000 })
        .then(() => true).catch(() => false);
      check('双击用内置编辑器打开（不是插件 / 不是预览）', opened);
      if (opened) {
        // CodeMirror 是虚拟滚动的：内容落地有一拍延迟，且 innerText 只含“已渲染的行”，
        // 所以轮询等关键字出现，而不是数总长度
        const loaded = await page.waitForFunction(() => {
          const el = document.querySelector('.window .editor-window .cm-content');
          return !!el && (el.innerText || '').includes('中文大文件自测');
        }, { timeout: 20000, polling: 150 }).then(() => true).catch(() => false);
        check('编辑器加载出内容（开头标题已渲染）', loaded);
        const srcText = readFileSync(join(filesRoot, 'big-chinese.txt'), 'utf8');
        const srcSize = statSync(join(filesRoot, 'big-chinese.txt')).size;
        const ed = await page.evaluate(() => {
          const win = document.querySelector('.window .editor-window');
          const cm = win?.querySelector('.cm-content');
          const text = cm ? (cm.innerText || '') : '';
          return {
            head: text.slice(0, 160),
            len: text.length,
            hasHead: text.includes('中文大文件自测'),
            hasProbe: text.includes('云九乱码探针'),
            fffd: (text.match(/\uFFFD/g) || []).length,
            enc: win?.querySelector('.es-enc')?.textContent.trim() || '',
            size: win?.querySelector('.es-size')?.textContent.trim() || '',
            banner: win?.querySelector('.editor-banner')?.textContent.trim() || '',
            cnCount: (text.match(/[\u4e00-\u9fff]/g) || []).length,
          };
        });
        check('编辑器里的中文正常（含开头标题与关键字，没有 U+FFFD）',
          ed.hasHead && ed.hasProbe && ed.fffd === 0, JSON.stringify({ head: ed.head, fffd: ed.fffd }));
        check('可见文本与源文件开头逐字一致（不是乱码替换后的内容）',
          (() => {
            const norm = (s) => s.replace(/\s+/g, ' ').trim();
            const want = norm(srcText).slice(0, 30);
            return norm(ed.head).startsWith(want);
          })(),
          JSON.stringify({ got: ed.head.slice(0, 24), want: srcText.slice(0, 24) }));
        check('没有 UTF-8→GB18030 误读的典型乱码', !MOJIBAKE.test(ed.head), ed.head);
        check('可见区域里中文字符密集（不是被替换成一堆符号）', ed.cnCount > 100, String(ed.cnCount));
        check('只读了前 512KB：越界提示条可见', /仅显示前一部分/.test(ed.banner), ed.banner);
        check('状态栏：编码 utf-8、大小是真实字节数（不是 512KB）',
          ed.enc === 'utf-8' && Math.abs(parseFloat(ed.size) - srcSize / 1024) < 12,
          JSON.stringify({ enc: ed.enc, size: ed.size, realKB: Math.round(srcSize / 1024) }));
        await shot('内置编辑器-中文大文件');
      }
      const realErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
      check('浏览器控制台无 JS 错误', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));
    } finally {
      await browser.close().catch(() => {});
    }
  }

  await page_shots_done();
}

function page_shots_done() {
  // 占位：保持 main 结构简单（截图在各段内部完成）
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
  await cleanup();
}

console.log(`\n${BOLD}结果${RESET}  通过 ${GREEN}${passed.length}${RESET} · 失败 ${failed.length ? RED : DIM}${failed.length}${RESET}  截图目录 ${OUT_DIR}`);
if (failed.length) {
  for (const [name, detail, s] of failed) console.log(`${RED}  ✗${RESET} ${name}  ${detail}${s ? `  📎 ${s}` : ''}`);
  process.exit(exitCode || 1);
}
process.exit(exitCode);
