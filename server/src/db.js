import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';

const FILE = () => path.join(config.dataDir, 'db.json');
const CORRUPT_PREFIX = 'db.json.corrupt-';
const defaults = () => ({ account: null, sessions: {}, shares: [], recents: [] });

ensureDirs();

/**
 * 加载状态（对外通过 dbStatus() 暴露）：
 *   'ok'      正常读到并解析了 db.json
 *   'fresh'   真正的首次启动：没有 db.json，也没有任何损坏副本
 *   'corrupt' 文件损坏 / 读不出来 / 上次启动已隔离过损坏文件
 *
 * 以前这里是一个裸 `catch {}`，把「首次启动」和「库损坏」混成一件事：
 * db.json 一旦损坏，进程带着空库正常启动，随后任意一次 saveDB()
 * （会话续期、最近打开、下载计数）就把空库原子覆盖回 db.json，
 * 管理员密码哈希、会话、分享令牌一次性永久丢失；而且空库让
 * GET /api/state 返回 initialized:false，POST /api/init 的守卫
 * `if (db.account)` 于是对所有人敞开 —— 数据事故升级成账号被接管。
 */
let loadState = 'fresh';
let loadError = null;
let corruptCopy = null;
/** 只读降级：损坏时置 false，saveDB() 一律不落盘，绝不用空库覆盖损坏库 */
let writable = true;

let data = defaults();

/**
 * 「曾经初始化过」的永久标记（data/.initialized）。
 * 为什么需要它：光看 db.json 在不在，无法区分「全新安装」和「库被人工删掉了」。
 * 后者会让进程带着空库启动，于是空库 + 未初始化 = 谁先打开站点谁就能建号接管。
 * 有标记就说明这个实例曾经有过账号，库文件不见了只能算「库缺失」，必须 fail-closed。
 */
const MARKER_FILE = () => path.join(config.dataDir, '.initialized');
// 进程内缓存：/api/state 每次都会问，没必要每次读盘（删标记后本来就需要重启才生效）
let markerSeen = false;

function hasMarker() {
  if (markerSeen) return true;
  try {
    if (fs.readFileSync(MARKER_FILE(), 'utf8').trim().length > 0) {
      markerSeen = true;
      return true;
    }
  } catch { /* 不存在 / 读不了，都当没有，退回原来的「看库文件」判定 */ }
  return false;
}

function writeMarker(source) {
  try {
    const fd = fs.openSync(MARKER_FILE(), 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify({ initializedAt: Date.now(), source }) + '\n');
      fs.fsyncSync(fd); // 标记本身很小，落盘后才能保证「断电/重启也不会又被当成全新安装」
    } finally {
      fs.closeSync(fd);
    }
    markerSeen = true;
    return true;
  } catch (e) {
    // 写标记失败不能把正常启动/初始化弄挂，但要留下痕迹，并说清保护退化成什么样
    console.error(`[db] 写入「曾经初始化过」标记失败（${e.code || e.message}）：${MARKER_FILE()}`);
    console.error('[db] 影响：以后如果 db.json 被删掉，服务会把它当成全新安装（可被重新初始化）。请检查数据目录权限/磁盘。');
    return false;
  }
}

/** 初始化成功后调用；已经存在就不重复写 */
export function markInitialized(source = 'init') {
  if (hasMarker()) return true;
  return writeMarker(source);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function corruptMarkers() {
  try {
    return fs.readdirSync(config.dataDir).filter((n) => n.startsWith(CORRUPT_PREFIX)).sort();
  } catch {
    return [];
  }
}

/** 把损坏的库改名保留（不删），用户的密码哈希可能还能从里面抢救出来 */
function quarantine(file) {
  if (!fs.existsSync(file)) return;
  const dest = `${file}.corrupt-${stamp()}`;
  try {
    fs.renameSync(file, dest);
    corruptCopy = dest;
    console.error(`[db] 损坏的数据库已保留为 ${path.basename(dest)}（原文件未删除）`);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    console.error(`[db] 保留损坏文件失败（${e.code || e.message}）：${dest}`);
  }
}

function markDamaged(cause) {
  loadState = 'corrupt';
  loadError = cause;
  writable = false;
  quarantine(FILE());
}

(function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE(), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return markDamaged(e); // 权限 / 磁盘错误：同样是「库坏了」，不是首次启动
    const markers = corruptMarkers();
    if (!markers.length) {
      // 库文件不在时还要再看一眼标记：有标记说明这个实例曾经初始化过，
      // 那这就是「库被删了」而不是「全新安装」（区别就是会不会向所有人间开 /api/init）
      if (hasMarker()) {
        loadState = 'corrupt';
        writable = false;
        loadError = new Error('db.json 不存在，但数据目录里有 .initialized 标记（该实例曾经初始化过）');
        return;
      }
      return; // 干净目录 + 没有标记：真正的首次启动
    }
    // 上一次启动已经把损坏文件隔离走，但库并没有修好：继续保持只读降级。
    // 否则这里会被当成首次启动，而空库 + 未初始化 = 谁先打开站点谁就能创建管理员。
    loadState = 'corrupt';
    writable = false;
    corruptCopy = path.join(config.dataDir, markers[markers.length - 1]);
    loadError = new Error(`db.json 缺失，但存在损坏副本 ${markers[markers.length - 1]}`);
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是 JSON 对象');
    data = { ...defaults(), ...parsed };
    loadState = 'ok';
    // 老安装的迁移路径：以前没有标记文件，读到含 account 的有效库就补写一份，
    // 不需要用户手动做任何事；以后哪天 db.json 被删掉，也能判出「库缺失」
    if (data.account) markInitialized('load');
  } catch (e) {
    markDamaged(e);
  }
})();

if (loadState === 'corrupt') {
  const why = `${loadError?.code ? loadError.code + ': ' : ''}${loadError?.message || '未知原因'}`;
  console.error('');
  console.error('==================================================================');
  console.error('[db] 数据库 db.json 加载失败，已进入「只读降级」模式');
  console.error(`[db] 原因:   ${why}`);
  console.error(`[db] 路径:   ${FILE()}`);
  if (corruptCopy) console.error(`[db] 副本:   ${corruptCopy}`);
  console.error('[db] 现在的行为：不写盘、不允许初始化账号、不允许登录（没有账号）。');
  console.error('[db] 处理办法：用备份恢复 db.json（或检查磁盘/权限），然后重启服务。');
  console.error('[db] 注意：如果确认这是全新安装，先删掉数据目录里的 .initialized 标记再启动。');
  console.error('==================================================================');
  console.error('');
}

/**
 * 写盘：先写 .tmp + fsync，再 rename 覆盖，最后 fsync 目录。
 * 没有 fsync 时 rename 可能先于数据落盘，断电会留下 0 字节的 db.json。
 * 以前这里在 setTimeout 回调里裸跑同步 IO：磁盘满时异常从定时器栈抛出，
 * index.js 的 next(e) 接不到，直接 uncaughtException 崩进程。
 */
function writeNow() {
  if (!writable) {
    if (!writeNow.warned) {
      writeNow.warned = true;
      console.error('[db] 只读降级模式：已跳过写盘（否则会用空库覆盖损坏的 db.json）。');
    }
    return false;
  }
  const json = JSON.stringify(data, null, 2);
  const tmp = FILE() + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json);
      fs.fsyncSync(fd); // 数据先落盘，再 rename，避免 rename 后断电留下空文件
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, FILE());
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    console.error(`[db] 写盘失败（${e.code || e.message}），本次改动只在内存中，未落盘:`, FILE());
    return false;
  }
  // rename 本身也要落盘，否则断电后可能「数据在、目录项还在旧版本」
  try {
    const dfd = fs.openSync(config.dataDir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* Windows 等不支持打开目录，忽略 */ }
  return true;
}

let saveTimer = null;
export function saveDB(now = false) {
  if (now) { clearTimeout(saveTimer); return writeNow(); }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeNow(), 300);
}
export function getDB() {
  return data;
}

/**
 * 当前库的状态。auth.js 用它把「未初始化」的判定从只看 db.account
 * 改成也看「库文件是否成功加载过」。
 */
export function dbStatus() {
  return {
    state: loadState,                 // 'ok' | 'fresh' | 'corrupt'
    loaded: loadState === 'ok',
    freshInstall: loadState === 'fresh',
    damaged: loadState === 'corrupt',
    writable,
    file: FILE(),
    corruptCopy,
    marker: MARKER_FILE(),            // 「曾经初始化过」标记，仅用于诊断
    markerPresent: hasMarker(),
    error: loadError ? `${loadError.code ? loadError.code + ': ' : ''}${loadError.message || loadError}` : null,
  };
}

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [t, s] of Object.entries(data.sessions)) {
    if (s.expiresAt < now) { delete data.sessions[t]; changed = true; }
  }
  if (changed) saveDB(true);
}, 3600 * 1000).unref();
