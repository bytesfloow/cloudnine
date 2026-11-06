import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fileConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const env = (k) => process.env[k];
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const isWin = process.platform === 'win32';

export const config = {
  version: '0.1.0',
  port: num(env('PORT') ?? fileConfig.port, 8480),
  host: env('HOST') ?? fileConfig.host ?? '0.0.0.0',
  // 文件系统浏览根目录：Linux 默认 /，Windows 开发环境默认用户主目录
  fileRoot: path.resolve(env('FILE_ROOT') ?? fileConfig.fileRoot ?? (isWin ? os.homedir() : '/')),
  dataDir: path.resolve(env('DATA_DIR') ?? fileConfig.dataDir ?? path.join(process.cwd(), 'data')),
  siteName: String(env('SITE_NAME') ?? fileConfig.siteName ?? 'CloudNine').slice(0, 50),
  sessionDays: num(env('SESSION_DAYS') ?? fileConfig.sessionDays, 7),
  rememberDays: num(env('REMEMBER_DAYS') ?? fileConfig.rememberDays, 30),
  maxUploadMB: num(env('MAX_UPLOAD_MB') ?? fileConfig.maxUploadMB, 4096),
  trashRetentionDays: num(env('TRASH_RETENTION_DAYS') ?? fileConfig.trashRetentionDays, 30),
  maxExtractMB: num(env('MAX_EXTRACT_MB') ?? fileConfig.maxExtractMB, 8192),
  auditCommands: Boolean(env('AUDIT_COMMANDS') ?? fileConfig.auditCommands ?? false),
  trustProxy: Boolean(env('TRUST_PROXY') ?? fileConfig.trustProxy ?? true),
  defaultShell: env('SHELL') ?? fileConfig.shell ?? (isWin ? process.env.ComSpec || 'cmd.exe' : 'bash'),
  // 终端默认工作目录：留空表示按 defaultCwd() 自动推导（见下）
  terminalCwd: String(env('TERMINAL_CWD') ?? fileConfig.terminalCwd ?? ''),
};

/**
 * 终端默认工作目录。
 * 约定：「终端初始工作目录：由访达窗口/右键携带的目录，或用户主目录（可配置默认行为）」。
 *
 * 注意：这里绝不能留空——cwd 为空时 node-pty 会继承服务端进程的工作目录
 * （生产环境即 /opt/cloudnine 安装目录），不符合预期。
 *
 * 推导顺序：TERMINAL_CWD 配置 → 用户主目录（若在文件根目录内）→ 文件根目录本身。
 * 最后一条与应用内「主目录」语义一致（fs.js 的 /api/fs/home 同样在主目录越界时退回根目录）。
 */
export function defaultCwd() {
  const root = path.resolve(config.fileRoot);
  if (config.terminalCwd) {
    const abs = path.resolve(root, config.terminalCwd.replace(/^\/+/, ''));
    return fs.existsSync(abs) ? abs : root;
  }
  const home = os.homedir();
  const rel = path.relative(root, home);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(home)) return home;
  return root;
}

export const dirs = {
  trash: path.join(config.dataDir, 'trash'),
  uploads: path.join(config.dataDir, 'uploads'),
};

export function ensureDirs() {
  for (const d of [config.dataDir, dirs.trash, dirs.uploads]) fs.mkdirSync(d, { recursive: true });
}

// 相对路径（客户端与服务端之间统一使用 / 分隔的相对路径）→ 绝对路径
export function toAbs(rel) {
  return path.resolve(config.fileRoot, String(rel || '').replace(/^\/+/, ''));
}
export function toRel(abs) {
  const r = path.relative(path.resolve(config.fileRoot), path.resolve(abs));
  return r.split(path.sep).join('/');
}
