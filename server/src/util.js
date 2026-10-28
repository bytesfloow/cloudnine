import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const err = (status, message, code) => new HttpError(status, message, code);

// 越权校验：任何路径必须落在 root 内部
export function safeJoin(root, rel) {
  const r = path.resolve(root);
  const t = path.resolve(r, rel == null ? '' : String(rel).replace(/^\/+/, ''));
  if (t !== r && !t.startsWith(r + path.sep)) throw err(400, '非法路径');
  return t;
}

export function modeStr(mode) {
  const m = mode & 0o777;
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += m & (1 << (8 - i)) ? bits[i] : '-';
  const t = mode & 0o170000;
  return (t === 0o40000 ? 'd' : t === 0o120000 ? 'l' : '-') + out;
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x');
export const uid = () => crypto.randomBytes(8).toString('hex');

export function sanitizeName(name) {
  if (typeof name !== 'string' || !name.trim()) throw err(400, '名称不能为空');
  const n = name.trim();
  if (n === '.' || n === '..') throw err(400, '名称不合法');
  if (/[/\\\0]/.test(n)) throw err(400, '名称不能包含 / \\ 等字符');
  if (n.length > 255) throw err(400, '名称过长（最多 255 字符）');
  return n;
}

export function existsSync(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

// 目标目录下生成不冲突的名称：file(1).txt
export function uniqueName(dir, name) {
  if (!existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 1; ; i++) {
    const candidate = `${base}(${i})${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
}

export async function existsAsync(p) {
  try { await fs.promises.stat(p); return true; } catch { return false; }
}

// 递归收集目录下的全部文件（上限保护），返回绝对路径数组
export async function walkFiles(abs, { cap = 200000, hidden = true } = {}) {
  const out = [];
  const walk = async (dir, depth) => {
    if (out.length >= cap || depth > 32) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (out.length >= cap) return;
      if (!hidden && d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        out.push({ abs: full, isDir: true });
        await walk(full, depth + 1);
      } else if (d.isFile()) {
        out.push({ abs: full, isDir: false });
      }
    }
  };
  await walk(abs, 0);
  return out;
}
