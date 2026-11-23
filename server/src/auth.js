import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { getDB, saveDB, dbStatus, markInitialized } from './db.js';
import { config } from './config.js';
import { err } from './util.js';

const COOKIE = 'cloudnine_sid';
const day = (n) => n * 24 * 3600 * 1000;

// 登录限流：双层计数，任一维度超限即锁定
// - 按用户名：15 分钟内 20 次失败 → 锁 15 分钟（防定点爆破）
// - 按 IP：15 分钟内 60 次失败 → 锁 15 分钟（阈值放宽，只挡横扫；同一出口 IP 可能有多个人）
// 两个维度缺一不可：只按 IP 时换个 IP 就能继续爆，只按用户名时换用户名就能横扫。
const loginFails = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS_USER = 20;
const MAX_FAILS_IP = 60;

const userKey = (username) => `u:${String(username || '').trim().slice(0, 64)}`;
const ipKey = (req) => `ip:${req.ip || ''}`;

function recordFail(key, max) {
  const now = Date.now();
  let rec = loginFails.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) rec = { count: 0, firstAt: now, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= max) { rec.lockedUntil = now + LOCK_MS; rec.count = 0; }
  loginFails.set(key, rec);
}

// 返回仍在锁定期内的那一层（{dim, rec}），未锁定返回 null
function lockedLayer(keys) {
  const now = Date.now();
  for (const { key, dim } of keys) {
    const rec = loginFails.get(key);
    if (rec && rec.lockedUntil > now) return { dim, rec };
  }
  return null;
}

// 定期清理过期记录：否则 Map 会随「试过的用户名 / 来源 IP」无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginFails) {
    if (rec.lockedUntil > now) continue;
    if (now - rec.firstAt > WINDOW_MS) loginFails.delete(key);
  }
}, 60 * 1000).unref();

const validPassword = (p) => typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);

function cookieOpts(req) {
  // req.secure 已经考虑了 trust proxy 配置：只有信任代理时才会采信 X-Forwarded-Proto
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' };
}

export function requireLogin(req, res, next) {
  const token = req.cookies?.[COOKIE];
  const db = getDB();
  const s = token && db.sessions[token];
  if (!s) return next(err(401, '未登录'));
  if (s.expiresAt < Date.now()) {
    delete db.sessions[token];
    saveDB();
    return next(err(401, '会话已过期'));
  }
  const span = day(s.days || config.sessionDays);
  if (s.expiresAt - Date.now() < span / 2) { s.expiresAt = Date.now() + span; saveDB(); }
  req.user = db.account?.username || 'owner';
  next();
}

function createSession(req, days) {
  const token = crypto.randomBytes(32).toString('base64url');
  getDB().sessions[token] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + day(days),
    days,
    ip: req.ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };
  saveDB();
  return token;
}

export const authRouter = Router();

// 库损坏时的统一文案：说清「发生了什么 + 已做了什么保护 + 怎么办」
function dbDamagedError() {
  const st = dbStatus();
  const copy = st.corruptCopy ? `（已保留为 ${String(st.corruptCopy).split(/[\\/]/).pop()}）` : '';
  return err(500, `数据库文件 db.json 加载失败${copy}：${st.error}。为免用空库覆盖已有数据，服务器已进入只读降级模式并拒绝此操作；请用备份恢复 db.json 后重启服务。`, 'db_damaged');
}

authRouter.get('/state', (req, res) => {
  const db = getDB();
  const st = dbStatus();
  // initialized 仍然只表达「是否已有账号」，字段结构不变；
  // 库损坏时额外附带 dbDamaged / dbError，供前端提示和运维排查（新增字段，老前端忽略即可）
  res.json({
    initialized: !!db.account,
    siteName: config.siteName,
    version: config.version,
    user: db.account && req.cookies?.[COOKIE] && db.sessions[req.cookies[COOKIE]]?.expiresAt > Date.now() ? db.account.username : null,
    dbDamaged: st.damaged,
    dbError: st.damaged ? st.error : null,
  });
});

authRouter.post('/init', (req, res, next) => {
  // 初始化守卫从 fail-open 改成 fail-closed：
  // 以前只判 `db.account`，库损坏 → 空库 → 守卫失效 → 任何先打开站点的人都能建号接管。
  // 现在先看库有没有成功加载过：加载失败就一律拒绝，哪怕 account 是空的。
  if (dbStatus().damaged) return next(dbDamagedError());
  const db = getDB();
  if (db.account) return next(err(403, '系统已初始化，不能重复创建账号'));
  const { username, password, siteName } = req.body || {};
  if (!username || !/^[A-Za-z0-9\u4e00-\u9fa5_-]{2,32}$/.test(String(username).trim())) return next(err(400, '用户名需为 2-32 位字母、数字、中文、- 或 _'));
  if (!validPassword(password)) return next(err(400, '密码至少 8 位，且需包含字母与数字'));
  if (siteName) config.siteName = String(siteName).trim().slice(0, 50) || config.siteName;
  db.account = { username: String(username).trim(), hash: bcrypt.hashSync(password, 10), createdAt: Date.now() };
  // 写盘失败时不能报成功：否则用户以为建好了号，重启后又回到「未初始化」，
  // 而那一刻的 POST /api/init 又对任何人敞开
  if (!saveDB(true)) {
    db.account = null;
    return next(err(500, '无法写入数据库文件 db.json（磁盘已满、只读或权限不足），账号未创建；请检查磁盘后重试。', 'db_write_failed'));
  }
  const token = createSession(req, config.sessionDays);
  // 初始化成功就落一个「曾经初始化过」的标记：以后 db.json 被删掉，也不会被当成全新安装
  // （写失败只在 db.js 里记日志，不影响本次初始化）
  markInitialized('init');
  res.cookie(COOKIE, token, { ...cookieOpts(req), maxAge: day(config.sessionDays) });
  res.json({ ok: true, user: db.account.username });
});

authRouter.post('/login', (req, res, next) => {
  const db = getDB();
  // 库损坏时这里说「系统尚未初始化」会误导（用户会以为要重新初始化），给出真正的原因
  if (dbStatus().damaged) return next(dbDamagedError());
  if (!db.account) return next(err(400, '系统尚未初始化'));
  const { username, password, remember } = req.body || {};
  const keys = [
    { key: userKey(username), dim: 'user' },
    { key: ipKey(req), dim: 'ip' },
  ];
  const locked = lockedLayer(keys);
  if (locked) {
    const mins = Math.ceil((locked.rec.lockedUntil - Date.now()) / 60000);
    // 文案里写明是哪个维度超限，否则用户/运维不知道该换什么
    const what = locked.dim === 'ip' ? '该 IP 登录失败次数过多' : '该用户名登录失败次数过多';
    return next(err(429, `${what}，请 ${mins} 分钟后再试`, 'login_locked'));
  }
  const ok = typeof password === 'string' && String(username || '').trim() === db.account.username && bcrypt.compareSync(password, db.account.hash);
  if (!ok) {
    recordFail(keys[0].key, MAX_FAILS_USER);
    recordFail(keys[1].key, MAX_FAILS_IP);
    return next(err(401, '用户名或密码错误'));
  }
  for (const k of keys) loginFails.delete(k.key);
  const days = remember ? config.rememberDays : config.sessionDays;
  const token = createSession(req, days);
  res.cookie(COOKIE, token, { ...cookieOpts(req), maxAge: day(days) });
  res.json({ ok: true, user: db.account.username });
});

authRouter.post('/logout', requireLogin, (req, res) => {
  const db = getDB();
  delete db.sessions[req.cookies[COOKIE]];
  saveDB(true);
  res.clearCookie(COOKIE, cookieOpts(req));
  res.json({ ok: true });
});

authRouter.post('/account/password', requireLogin, (req, res, next) => {
  const db = getDB();
  const { current, next: np } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), db.account.hash)) return next(err(401, '原密码错误'));
  if (!validPassword(np)) return next(err(400, '新密码至少 8 位，且需包含字母与数字'));
  db.account.hash = bcrypt.hashSync(np, 10);
  saveDB(true);
  res.json({ ok: true });
});

authRouter.get('/about', requireLogin, (req, res) => {
  res.json({
    version: config.version,
    siteName: config.siteName,
    port: config.port,
    runtimeUser: os.userInfo().username,
    hostname: os.hostname(),
    platform: process.platform,
    fileRoot: config.fileRoot,
    trashRetentionDays: config.trashRetentionDays,
  });
});
