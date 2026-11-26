import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';
import yauzl from 'yauzl';
import { config } from './config.js';
import { requireLogin } from './auth.js';
import { safeJoin, err, uid } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// SDK 不进构建：它就是一份纯浏览器脚本，直接从仓库的 sdk/ 目录读出来发出去
const SDK_FILE = path.resolve(__dirname, '../../sdk/v1/cloudnine.js');

/**
 * 插件系统 v1 —— 服务端运行时。
 *
 * 设计前提（决定了这里每个安全边界的松紧）：
 *   - 单用户自托管，装插件 = 管理员自己装，等于自己往自己机器上放网页；
 *     所以 permissions 是**声明式约束**（前端据此弹权限、宿主据此 403），
 *     不是沙箱。真正的隔离靠 iframe + CSP sandbox（opaque origin）。
 *   - v1 插件**只能是静态前端资源**，manifest 里不接受 server/main 字段，
 *     因此这里没有任何「执行插件代码」的路径，安装/列表/静态资源三条链路都不 eval、不 require。
 *   - 单用户场景下不追求插件之间互不可见：插件私有数据只保证「不和 db.json 混在一起」，
 *     保证备份/删除插件时能一起带走或清掉。
 */

// ================= manifest =================

// 插件 id 同时是目录名 + /pa URL 的一段 + 数据文件名，字符集必须窄
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/;
// v1 的全部权限。未知权限一律判非法：写错了字（比如 'files.read'）必须当场报错，
// 否则插件会「看起来装好了但什么都不能用」，排查成本极高。
const PERMISSIONS = ['storage', 'fs.read', 'fs.write', 'clipboard.write', 'notify'];
// v1 明确不支持插件自带后端代码
const FORBIDDEN_KEYS = ['server', 'main'];
const STORAGE_LIMIT = 1024 * 1024; // 插件私有数据上限 1MB（序列化后）
// 文件关联（v1.1）：fileTypes / defaultFor 里的扩展名
//   - 必须带点、只允许字母数字与 - _ +、整串 ≤ 16（含点）；不支持 .tar.gz 这种多段扩展名
//     （前端按「最后一个点之后」取扩展名，声明多段只会永远匹配不上）
//   - 统一转小写后比较，插件写 ".JSON" 也会被规范成 ".json"
//   - 一个插件最多声明 10 个
const EXT_RE = /^\.[a-z0-9][a-z0-9_+-]*$/;
const MAX_FILE_TYPES = 10;

const DEFAULTS = {
  entry: 'index.html',
  window: { width: 900, height: 620, minWidth: 420, minHeight: 320, multi: true },
};

const asString = (v) => (typeof v === 'string' ? v : null);

/** manifest 里的相对路径（entry/icon）：不允许绝对路径、盘符、.. 段 */
function relAssetPath(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw err(400, `manifest 字段 ${field} 必须是非空字符串`);
  const p = v.trim().replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw err(400, `manifest 字段 ${field} 必须是相对路径`);
  if (p.split('/').some((s) => s === '..' || s === '.')) throw err(400, `manifest 字段 ${field} 不能包含 . 或 .. 路径段`);
  if (p.length > 300) throw err(400, `manifest 字段 ${field} 过长`);
  return p;
}

/**
 * 扩展名数组校验（fileTypes / defaultFor 共用）：
 * 必须是数组、元素必须是以点开头的小写化扩展名、≤ 16 字符、≤ 10 项。
 * 非法一律抛 400 —— 与 permissions 里的未知权限同样处理：宁可安装时报错，
 * 也不接受一个「装上了但双击文件没反应」的插件。
 */
function extList(v, field) {
  if (!Array.isArray(v)) throw err(400, `manifest 字段 ${field} 必须是数组（例如 [".json", ".md"]）`);
  if (v.length > MAX_FILE_TYPES) throw err(400, `manifest 字段 ${field} 最多 ${MAX_FILE_TYPES} 项`);
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') throw err(400, `manifest 字段 ${field} 的元素必须是字符串：${JSON.stringify(raw)}`);
    const ext = raw.trim().toLowerCase();
    if (ext.length > 16) throw err(400, `manifest 字段 ${field} 的扩展名过长（最多 16 字符）：${raw}`);
    if (!EXT_RE.test(ext)) {
      throw err(400, `manifest 字段 ${field} 的扩展名非法（需以 . 开头、只含字母数字与 - _ +）：${JSON.stringify(raw)}`);
    }
    out.push(ext);
  }
  return [...new Set(out)];
}

function intInRange(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 校验并补默认值。dirName 有值时要求 manifest.id 与目录名一致（安装时取 manifest 的 id，
 * 因为那时还没有目录名）。
 */
export function normalizeManifest(raw, dirName = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err(400, 'plugin.json 顶层必须是 JSON 对象');

  for (const k of FORBIDDEN_KEYS) {
    if (k in raw) throw err(400, `v1 插件不支持 "${k}" 字段：插件不能自带后端代码，只能是静态资源`);
  }

  const id = asString(raw.id)?.trim();
  if (!id || !ID_RE.test(id)) throw err(400, `id 非法（需匹配 ${ID_RE}）：${JSON.stringify(raw.id)}`);
  if (dirName && id !== dirName) throw err(400, `id（${id}）必须与安装目录名（${dirName}）一致`);

  const name = asString(raw.name)?.trim();
  if (!name) throw err(400, 'manifest 缺少 name');
  if (name.length > 64) throw err(400, 'name 过长（最多 64 字符）');

  const version = asString(raw.version)?.trim();
  if (!version) throw err(400, 'manifest 缺少 version');
  if (!/^[0-9A-Za-z.+_-]{1,32}$/.test(version)) throw err(400, 'version 非法（只允许字母数字和 . + _ -，最多 32 字符）');

  const description = asString(raw.description)?.trim().slice(0, 300) || null;
  const author = asString(raw.author)?.trim().slice(0, 100) || null;

  let icon = null;
  if (raw.icon !== undefined && raw.icon !== null && raw.icon !== '') {
    icon = relAssetPath(raw.icon, 'icon');
    if (!/\.(svg|png)$/i.test(icon)) throw err(400, 'icon 只支持 svg / png');
  }

  const entry = raw.entry === undefined || raw.entry === null || raw.entry === ''
    ? DEFAULTS.entry
    : relAssetPath(raw.entry, 'entry');

  // permissions：必须是数组，元素必须在白名单内；允许重复但会去重
  let permissions = [];
  if (raw.permissions !== undefined && raw.permissions !== null) {
    if (!Array.isArray(raw.permissions)) throw err(400, 'permissions 必须是数组');
    for (const p of raw.permissions) {
      if (typeof p !== 'string' || !PERMISSIONS.includes(p)) {
        throw err(400, `未知权限 ${JSON.stringify(p)}（v1 只支持 ${PERMISSIONS.join(' / ')}）`);
      }
    }
    permissions = [...new Set(raw.permissions)];
  }

  // 文件关联：fileTypes 让插件出现在「打开方式」里；defaultFor 里的扩展名双击时优先用它。
  // 旧 manifest 没有这两个字段 → 空数组（不影响加载，也不会进打开方式）
  const fileTypes = raw.fileTypes === undefined || raw.fileTypes === null ? [] : extList(raw.fileTypes, 'fileTypes');
  let defaultFor = [];
  if (raw.defaultFor !== undefined && raw.defaultFor !== null) {
    defaultFor = extList(raw.defaultFor, 'defaultFor');
    const missing = defaultFor.filter((e) => !fileTypes.includes(e));
    if (missing.length) {
      throw err(400, `manifest 字段 defaultFor 里的扩展名必须先声明在 fileTypes 里：${missing.join(' ')}`);
    }
  }

  const w = raw.window && typeof raw.window === 'object' && !Array.isArray(raw.window) ? raw.window : {};
  const window = {
    width: intInRange(w.width, DEFAULTS.window.width, 200, 4096),
    height: intInRange(w.height, DEFAULTS.window.height, 200, 4096),
    minWidth: intInRange(w.minWidth, DEFAULTS.window.minWidth, 200, 4096),
    minHeight: intInRange(w.minHeight, DEFAULTS.window.minHeight, 200, 4096),
    multi: typeof w.multi === 'boolean' ? w.multi : DEFAULTS.window.multi,
  };

  const flag = (v, def) => (typeof v === 'boolean' ? v : def);

  return {
    id,
    name,
    version,
    description,
    author,
    icon,
    entry,
    window,
    permissions,
    onDesktop: flag(raw.onDesktop, true),
    inStartMenu: flag(raw.inStartMenu, true),
    fileTypes,
    defaultFor,
    minHostVersion: asString(raw.minHostVersion)?.trim().slice(0, 32) || null,
  };
}

/** 读并校验一个已安装目录；失败抛出 HttpError / Error，由调用方决定是 404 还是进 invalid */
export function readInstalledManifest(dir, dirName = path.basename(dir)) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw err(404, '插件目录里没有 plugin.json', 'manifest_missing');
    throw err(500, `无法读取 plugin.json（${e.code || e.message}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw err(400, `plugin.json 不是合法 JSON：${e.message}`);
  }
  return normalizeManifest(parsed, dirName);
}

// ================= /pa token =================

/**
 * 签名密钥：首次运行随机生成并落盘（0600），重启后不变——否则每次重启所有插件的
 * entryUrl 都变，前端缓存/书签全部失效。
 * 读失败或文件损坏时会重新生成（只影响 token 稳定性，不影响正确性）。
 */
let secretCache = null;
function assetSecret() {
  if (secretCache) return secretCache;
  const file = path.join(config.dataDir, 'asset-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(s)) return (secretCache = s);
  } catch { /* 不存在 / 读不了：下面生成一份 */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    // wx：并发启动时只有一个进程能写成功，另一个读它写的
    fs.writeFileSync(file, `${s}\n`, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 基本无效，忽略 */ }
  } catch (e) {
    if (e.code === 'EEXIST') {
      try { return (secretCache = fs.readFileSync(file, 'utf8').trim()); } catch { /* 落到下面用内存值 */ }
    } else {
      console.error(`[plugins] 写入 asset-secret 失败（${e.code || e.message}）：${file}`);
      console.error('[plugins] 影响：本次运行仍可用，但重启后插件资源 URL 的 token 会变，请检查数据目录权限/磁盘。');
    }
  }
  return (secretCache = s);
}

export function pluginToken(id) {
  return crypto.createHmac('sha256', assetSecret()).update(String(id)).digest('hex').slice(0, 32);
}

function tokenMatches(given, id) {
  const want = pluginToken(id);
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 插件资源的公开 URL：/pa/<token>/<id>/<relpath>（不需要登录，见下方 /pa 路由说明） */
export function pluginAssetUrl(id, rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  return `/pa/${pluginToken(id)}/${encodeURIComponent(id)}/${parts.map(encodeURIComponent).join('/')}`;
}

/** 对外的插件对象（前端契约字段，不多不少） */
function publicPlugin(m) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    permissions: m.permissions,
    window: m.window,
    entryUrl: pluginAssetUrl(m.id, m.entry),
    iconUrl: m.icon ? pluginAssetUrl(m.id, m.icon) : null,
    // 包体积（字节，递归统计 + 进程内缓存，见下面「插件体积」段）
    size: pluginSize(m.id),
    onDesktop: m.onDesktop,
    inStartMenu: m.inStartMenu,
    // 文件关联（v1.1）：前端据此把插件放进「打开方式」，并按 defaultFor 决定双击默认程序。
    // 旧插件没有这两个字段 → 服务端补空数组，前端不需要判 undefined
    fileTypes: m.fileTypes || [],
    defaultFor: m.defaultFor || [],
  };
}

// ================= 目录扫描 =================

/**
 * 扫描插件目录。**任何一个目录坏掉都不能让整个列表 500**：
 * 用户手滑改坏一个 plugin.json，不应该导致桌面/开始菜单里所有插件消失。
 * 坏目录进 invalid（带原因）并打一条日志，好目录照常返回。
 */
export function listPlugins() {
  const plugins = [];
  const invalid = [];
  let names = [];
  try {
    names = fs.readdirSync(config.pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[plugins] 读取插件目录失败（${e.code || e.message}）：${config.pluginsDir}`);
    return { plugins, invalid };
  }

  for (const dir of names) {
    try {
      const m = readInstalledManifest(path.join(config.pluginsDir, dir), dir);
      plugins.push(publicPlugin(m));
    } catch (e) {
      invalid.push({ dir, error: e.message || String(e) });
      console.error(`[plugins] 跳过无效插件目录 ${dir}：${e.message || e}`);
    }
  }
  return { plugins, invalid };
}

function findPlugin(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const dir = path.join(config.pluginsDir, id);
  if (!fs.existsSync(dir)) return null;
  try {
    return { dir, manifest: readInstalledManifest(dir, id) };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

const pluginDir = (id) => path.join(config.pluginsDir, id);
const storageFile = (id) => path.join(config.pluginDataDir, `${id}.json`);

// ================= 插件体积（列表里的 size） =================
// size = 插件目录下**所有文件的字节数之和**（递归，不跟软链）：前端「设置 → 插件」直接展示，
// 不用再去命令行 du。
// 两个上限防止一个畸形目录把 GET /api/plugins 拖死：条目数 2000 / 总字节 64MB；
// 触顶就停止累加，返回已经统计到的值（仍是个有意义的「至少这么大」）。
const SIZE_MAX_ENTRIES = 2000;
const SIZE_MAX_BYTES = 64 * 1024 * 1024;

// 进程内缓存：key = 顶层目录的 mtimeMs + 顶层条目数。
// 装 / 卸 / 覆盖都会让这两个值变化；那三条链路做完还会显式失效一次（invalidatePluginSize）。
// 命中缓存时只做一次 readdir + 一次 stat，不再逐层 walk —— 连续调 GET /api/plugins 不反复扫盘。
const sizeCache = new Map(); // id -> { key, size }

function dirSizeKey(dir) {
  try {
    return `${fs.statSync(dir).mtimeMs}:${fs.readdirSync(dir).length}`;
  } catch { return null; }
}

function walkSize(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of entries) {
    if (acc.count >= SIZE_MAX_ENTRIES || acc.bytes >= SIZE_MAX_BYTES) return;
    acc.count += 1;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { walkSize(full, acc); continue; }
    // 软链 / 设备文件不跟也不统计：插件包本来就只能是普通文件
    if (!d.isFile()) continue;
    try { acc.bytes += fs.statSync(full).size; } catch { /* 统计途中被删：略过 */ }
  }
}

/** 某个插件的包体积（字节）。命中缓存时不扫盘。 */
export function pluginSize(id) {
  const key = dirSizeKey(pluginDir(String(id)));
  if (!key) return 0;
  const cached = sizeCache.get(String(id));
  if (cached && cached.key === key) return cached.size;
  const acc = { count: 0, bytes: 0 };
  walkSize(pluginDir(String(id)), acc);
  sizeCache.set(String(id), { key, size: acc.bytes });
  return acc.bytes;
}

/** 安装 / 覆盖 / 卸载之后让缓存失效（磁盘已经变了，下次调用重新统计） */
export function invalidatePluginSize(id) {
  sizeCache.delete(String(id));
}

// ================= zip 解包（安装用） =================

const MAX_ENTRIES = 200;
const MAX_UNZIP_BYTES = 32 * 1024 * 1024;

/** 条目名归一化并拒绝穿越：绝对路径、盘符、.. 段、符号链接 */
function safeEntryName(name) {
  let n = String(name).replace(/\\/g, '/');
  if (!n) throw err(400, 'zip 含空文件名');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) throw err(400, `zip 含绝对路径：${name}`);
  const parts = n.split('/');
  if (parts.some((s) => s === '..')) throw err(400, `zip 含危险路径：${name}`);
  n = parts.filter((s) => s && s !== '.').join('/');
  if (!n) throw err(400, `zip 含非法文件名：${name}`);
  return n;
}

const isSymlink = (entry) => ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;

/** 把 zip buffer 解到 destDir，返回解出的条目数 */
function extractZipBuffer(buf, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, autoClose: true }, (e, zipfile) => {
      if (e) return reject(err(400, '无法读取 zip（文件可能已损坏或不是 zip 格式）'));
      let count = 0;
      let bytes = 0;
      let settled = false;

      const fail = (e2) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* 已经关了 */ }
        reject(e2);
      };

      zipfile.on('entry', (entry) => {
        if (settled) return;
        (async () => {
          if (/\/$/.test(entry.fileName)) {
            // 目录条目本身也算一个条目，避免「全是空目录」的 zip 绕过计数
            if (++count > MAX_ENTRIES) throw err(400, `zip 条目超过上限（${MAX_ENTRIES} 个）`);
            await fsp.mkdir(safeJoin(destDir, safeEntryName(entry.fileName)), { recursive: true });
            return zipfile.readEntry();
          }
          if (isSymlink(entry)) throw err(400, `zip 里含符号链接，v1 插件不允许：${entry.fileName}`);
          // macOS 打包工具塞进来的元数据，直接跳过（否则「唯一顶层目录」判定会被它破坏）
          if (/^__MACOSX\//.test(entry.fileName) || /(^|\/)\.DS_Store$/.test(entry.fileName)) return zipfile.readEntry();

          if (++count > MAX_ENTRIES) throw err(400, `zip 条目超过上限（${MAX_ENTRIES} 个）`);
          bytes += entry.uncompressedSize || 0;
          if (bytes > MAX_UNZIP_BYTES) throw err(400, `解压后总量超过上限（${MAX_UNZIP_BYTES / 1024 / 1024}MB）`);

          const rel = safeEntryName(entry.fileName);
          const out = safeJoin(destDir, rel);
          await fsp.mkdir(path.dirname(out), { recursive: true });
          const rs = await new Promise((res2, rej2) => {
            zipfile.openReadStream(entry, (e2, s) => (e2 ? rej2(err(400, `zip 条目读取失败：${entry.fileName}`)) : res2(s)));
          });
          // 声明大小可以造假（zip 炸弹的常规手法），这里按真实写出的字节数再卡一次
          let written = 0;
          rs.on('data', (chunk) => {
            written += chunk.length;
            if (written > MAX_UNZIP_BYTES) rs.destroy(err(400, `解压后总量超过上限（${MAX_UNZIP_BYTES / 1024 / 1024}MB）`));
          });
          await pipeline(rs, fs.createWriteStream(out));
          zipfile.readEntry();
        })().catch(fail);
      });

      zipfile.on('end', () => {
        if (settled) return;
        if (count === 0) return fail(err(400, 'zip 是空的'));
        settled = true;
        resolve(count);
      });
      zipfile.on('error', (e2) => fail(err(400, `zip 读取失败：${e2.message || e2}`)));
      zipfile.readEntry();
    });
  });
}

// ================= /api/plugins =================

export const pluginsRouter = Router();

// /api/plugins 下的接口全部要求登录（/pa 静态资源是唯一的例外，见下面 pluginAssetRouter）
pluginsRouter.use('/plugins', requireLogin);

pluginsRouter.get('/plugins', (req, res, next) => {
  try {
    res.json(listPlugins());
  } catch (e) { next(e); }
});

pluginsRouter.get('/plugins/:id', (req, res, next) => {
  try {
    const found = findPlugin(req.params.id);
    if (!found) return next(err(404, '插件不存在', 'plugin_not_found'));
    res.json(publicPlugin(found.manifest));
  } catch (e) { next(e); }
});

// ---------- 私有存储 ----------

function readStorage(id) {
  const file = storageFile(id);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 数据文件坏了不能 500（否则插件窗口整个打不开），当没有数据处理并留下证据
    console.error(`[plugins] 插件 ${id} 的存储文件不是合法 JSON，按空数据处理：${file}`);
    return null;
  }
}

pluginsRouter.get('/plugins/:id/storage', (req, res, next) => {
  try {
    const found = findPlugin(req.params.id);
    if (!found) return next(err(404, '插件不存在', 'plugin_not_found'));
    if (!found.manifest.permissions.includes('storage')) {
      return next(err(403, '该插件没有声明 storage 权限', 'permission_denied'));
    }
    res.json({ data: readStorage(found.manifest.id) });
  } catch (e) { next(e); }
});

pluginsRouter.put('/plugins/:id/storage', async (req, res, next) => {
  try {
    const found = findPlugin(req.params.id);
    if (!found) return next(err(404, '插件不存在', 'plugin_not_found'));
    if (!found.manifest.permissions.includes('storage')) {
      return next(err(403, '该插件没有声明 storage 权限', 'permission_denied'));
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || !('data' in body)) return next(err(400, '请求体需要 JSON 对象 {data}'));

    // 序列化后算大小（不是请求体大小）：数字/布尔/字符串的 JSON 长度才是真正落盘的字节数
    let json;
    try {
      json = JSON.stringify(body.data);
    } catch {
      return next(err(400, 'data 无法序列化为 JSON', 'invalid_data'));
    }
    if (json === undefined) return next(err(400, 'data 无法序列化为 JSON', 'invalid_data'));
    const size = Buffer.byteLength(json, 'utf8');
    if (size > STORAGE_LIMIT) {
      return next(err(413, `插件数据超过上限（序列化后 ${(size / 1024 / 1024).toFixed(2)}MB，上限 1MB）`, 'payload_too_large'));
    }

    const file = storageFile(found.manifest.id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // tmp + fsync + rename：和 db.js 一致，避免断电留下半个 JSON（插件读不了数据就会重置计数）
    const tmp = `${file}.${uid()}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file).catch(async (e) => {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    });
    res.json({ ok: true, size });
  } catch (e) { next(e); }
});

// ---------- 安装 ----------

// 只认 zip；application/octet-stream 也收，因为有些上传组件不给准确的类型
const rawZip = express.raw({
  type: (req) => /^(application\/(zip|x-zip-compressed|octet-stream))$/i.test(String(req.headers['content-type'] || '').split(';')[0].trim()),
  limit: '8mb',
});

pluginsRouter.post('/plugins/install', rawZip, async (req, res, next) => {
  const tmpRoot = path.join(config.pluginsDir, `.install-${uid()}`);
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return next(err(400, '请把插件 zip 的原始字节放在请求体里（Content-Type: application/zip）', 'empty_body'));
    }
    const extractDir = path.join(tmpRoot, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    await extractZipBuffer(req.body, extractDir);

    // 两种打包习惯都支持：根目录直接放 plugin.json，或只有一个顶层目录（里面是插件）
    let root = extractDir;
    if (!fs.existsSync(path.join(extractDir, 'plugin.json'))) {
      const tops = (await fsp.readdir(extractDir)).filter((n) => n !== '__MACOSX');
      if (tops.length !== 1) throw err(400, 'zip 里找不到 plugin.json：请把它放在 zip 根目录，或只放一个顶层目录');
      const only = path.join(extractDir, tops[0]);
      const st = await fsp.stat(only).catch(() => null);
      if (!st?.isDirectory() || !fs.existsSync(path.join(only, 'plugin.json'))) {
        throw err(400, 'zip 里找不到 plugin.json：请把它放在 zip 根目录，或只放一个顶层目录');
      }
      root = only;
    }

    let manifest;
    try {
      manifest = readInstalledManifest(root, null);
    } catch (e) {
      // 安装时目录名还没定，id 一致性等安装到目标目录后再由列表扫描兜底
      throw err(400, `插件 manifest 不合法：${e.message}`, 'invalid_manifest');
    }
    if (!fs.existsSync(path.join(root, manifest.entry))) {
      throw err(400, `manifest 里的 entry（${manifest.entry}）在 zip 里不存在`, 'entry_missing');
    }

    const target = pluginDir(manifest.id);
    const exists = fs.existsSync(target);
    const overwrite = /^(1|true|yes)$/i.test(String(req.query.overwrite || ''));
    if (exists && !overwrite) {
      // 409 结构化：前端据此弹「已存在 vX，是否覆盖」，**不需要再解析文案**。
      // 外层形状保持 `{ error: 中文说明字符串, code }` 不变（旧客户端读 error 仍然可用），
      // 机器可读的 id / version 放在同级字段上。
      let installed = null;
      try { installed = readInstalledManifest(target, manifest.id); } catch { /* 旧目录 manifest 坏了：只回 id */ }
      const version = installed?.version || null;
      const message = version
        ? `插件「${installed.name || manifest.id}」v${version} 已存在；如需覆盖请加 ?overwrite=1`
        : `插件 ${manifest.id} 已存在；如需覆盖请加 ?overwrite=1`;
      return res.status(409).json({ error: message, code: 'PLUGIN_EXISTS', id: manifest.id, version });
    }
    if (exists) await fsp.rm(target, { recursive: true, force: true });

    // 同一个分区内的 rename 是原子的：要么旧版本完整、要么新版本完整，不会出现半个插件目录
    await fsp.rename(root, target);
    invalidatePluginSize(manifest.id);
    res.json(publicPlugin(manifest));
  } catch (e) {
    next(e);
  } finally {
    // 临时目录一定要清（包括 409/400 这些提前返回的路径）
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- 删除 ----------

pluginsRouter.delete('/plugins/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) return next(err(400, '插件 id 非法'));
    await fsp.rm(pluginDir(id), { recursive: true, force: true });
    await fsp.rm(storageFile(id), { force: true });
    invalidatePluginSize(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ================= /pa 插件静态资源 & /plugin-sdk =================

export const pluginAssetRouter = Router();

/**
 * 插件资源**故意不加登录**：
 * 插件页面跑在 <iframe sandbox> 里（opaque origin），它自己的 css/js/图片请求是
 * 跨源且不带 cookie 的；加鉴权的结果就是插件页面永远白屏（只有一个 401）。
 * 防越权靠 token：token = HMAC(serverSecret, pluginId) 的前 32 位，只有读过
 * /api/plugins 的人才知道 → 实际效果是「登录用户能看，别人猜不到」。
 * 即使 token 泄漏，响应还带 CSP sandbox，直接打开也只是被沙箱化的静态页面。
 */
pluginAssetRouter.get('/pa/:token/:id/*', (req, res) => {
  const notFound = (msg = '资源不存在') => res.status(404).type('text/plain; charset=utf-8').send(msg);
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return notFound();
  if (!tokenMatches(req.params.token, id)) return notFound();

  const dir = pluginDir(id);
  const rel = String(req.params[0] || '');
  if (!rel) return notFound();

  let abs;
  try {
    abs = safeJoin(dir, rel);
  } catch {
    return res.status(400).type('text/plain; charset=utf-8').send('非法路径');
  }

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return notFound();
  }
  // 只发文件：不列目录，也不让 /pa 变成插件目录的文件浏览器
  if (!st.isFile()) return notFound();

  res.status(200);
  res.setHeader('Content-Type', mime.lookup(abs) || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  // 纵深防御：就算有人绕过前端直接打开这个 URL，页面也是沙箱化的（无 cookie、无同源）
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms');
  // 全局中间件给了 X-Frame-Options: SAMEORIGIN；插件窗口本身是同一个源，
  // 这里删掉是为了以后外壳把插件放进跨源预览容器时不会被它挡掉（页面已由 CSP 沙箱保护）
  res.removeHeader('X-Frame-Options');

  const rs = fs.createReadStream(abs);
  rs.on('error', () => { try { res.destroy(); } catch { /* 连接已断 */ } });
  rs.pipe(res);
});

/**
 * 插件 SDK：公开静态文件。
 * 不进前端构建：插件页面只用 <script src="/plugin-sdk/v1/cloudnine.js"> 一行引入，
 * 这样 SDK 升级不需要插件作者重新打包。
 */
let sdkCache = null;
pluginAssetRouter.get('/plugin-sdk/v1/cloudnine.js', (req, res) => {
  if (sdkCache === null) {
    try {
      sdkCache = fs.readFileSync(SDK_FILE, 'utf8');
    } catch (e) {
      console.error(`[plugins] 读取 SDK 失败（${e.code || e.message}）：${SDK_FILE}`);
      sdkCache = false;
    }
  }
  if (!sdkCache) return res.status(404).type('text/plain; charset=utf-8').send('SDK 文件缺失');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(sdkCache);
});
