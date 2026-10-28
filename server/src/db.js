import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';

const FILE = () => path.join(config.dataDir, 'db.json');
const defaults = () => ({ account: null, sessions: {}, shares: [], recents: [] });

ensureDirs();
let data = defaults();
try {
  const raw = fs.readFileSync(FILE(), 'utf8');
  data = { ...defaults(), ...JSON.parse(raw) };
} catch { /* 首次启动无数据库文件 */ }

let saveTimer = null;
function writeNow() {
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE());
}
export function saveDB(now = false) {
  if (now) { clearTimeout(saveTimer); writeNow(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 300);
}
export function getDB() {
  return data;
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
