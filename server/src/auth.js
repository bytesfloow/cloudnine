import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { getDB, saveDB } from './db.js';
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

authRouter.get('/state', (req, res) => {
  const db = getDB();
  res.json({
    initialized: !!db.account,
    siteName: config.siteName,
    version: config.version,
    user: db.account && req.cookies?.[COOKIE] && db.sessions[req.cookies[COOKIE]]?.expiresAt > Date.now() ? db.account.username : null,
  });
});

authRouter.post('/init', (req, res, next) => {
  const db = getDB();
  if (db.account) return next(err(403, '系统已初始化，不能重复创建账号'));
  const { username, password, siteName } = req.body || {};
  if (!username || !/^[A-Za-z0-9\u4e00-\u9fa5_-]{2,32}$/.test(String(username).trim())) return next(err(400, '用户名需为 2-32 位字母、数字、中文、- 或 _'));
  if (!validPassword(password)) return next(err(400, '密码至少 8 位，且需包含字母与数字'));
  if (siteName) config.siteName = String(siteName).trim().slice(0, 50) || config.siteName;
  db.account = { username: String(username).trim(), hash: bcrypt.hashSync(password, 10), createdAt: Date.now() };
  saveDB(true);
  const token = createSession(req, config.sessionDays);
  res.cookie(COOKIE, token, { ...cookieOpts(req), maxAge: day(config.sessionDays) });
  res.json({ ok: true, user: db.account.username });
});

authRouter.post('/login', (req, res, next) => {
  const db = getDB();
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
    runtimeUser: os.userInfo().username,
    hostname: os.hostname(),
    platform: process.platform,
    fileRoot: config.fileRoot,
    trashRetentionDays: config.trashRetentionDays,
  });
});
