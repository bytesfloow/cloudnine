import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { getDB, saveDB } from './db.js';
import { config } from './config.js';
import { err } from './util.js';

const COOKIE = 'cloudnine_sid';
const day = (n) => n * 24 * 3600 * 1000;

// 登录限流：10 分钟窗口内失败 10 次 → 锁定 15 分钟
const loginFails = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

function recordFail(key) {
  const now = Date.now();
  let rec = loginFails.get(key);
  if (!rec || now - rec.firstAt > WINDOW) rec = { count: 0, firstAt: now, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_FAILS) { rec.lockedUntil = now + LOCK_MS; rec.count = 0; }
  loginFails.set(key, rec);
}

const validPassword = (p) => typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);

function cookieOpts(req) {
  const https = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  return { httpOnly: true, sameSite: 'lax', secure: https, path: '/' };
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
  const key = `${req.ip}|${String(username || '').slice(0, 64)}`;
  const rec = loginFails.get(key);
  if (rec && rec.lockedUntil > Date.now()) {
    return next(err(429, `失败次数过多，请 ${Math.ceil((rec.lockedUntil - Date.now()) / 60000)} 分钟后再试`));
  }
  const ok = typeof password === 'string' && String(username || '').trim() === db.account.username && bcrypt.compareSync(password, db.account.hash);
  if (!ok) {
    recordFail(key);
    return next(err(401, '用户名或密码错误'));
  }
  loginFails.delete(key);
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
