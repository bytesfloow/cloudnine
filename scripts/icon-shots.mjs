#!/usr/bin/env node
/**
 * 回收站图标验收截图（桌面实景 + 满桶态）
 *
 * 直接连一个跑着的实例（默认本机 8580 的独立测试实例），
 * 登录 → 清空回收站 → 把桌面上的一个文件真的拖进回收站 → 亮/暗各拍一张。
 *
 * 用法：
 *   node scripts/icon-shots.mjs --url http://127.0.0.1:8580/
 *     [--user uitest --password Uitest12345] [--chrome <path>] [--out shots/icons-trash]
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const URL_BASE = (arg('url', 'http://127.0.0.1:8580/') || '').replace(/\/$/, '');
const USER = arg('user', 'uitest');
const PASS = arg('password', 'Uitest12345');
const CHROME = arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const OUT = arg('out', join(ROOT, 'shots', 'icons-trash'));
function loadPuppeteer() {
  for (const c of [process.env.PUPPETEER_CORE, join(ROOT, 'node_modules', 'puppeteer-core'),
    'C:\\Users\\zhl\\Desktop\\workspace\\.uitest\\node_modules\\puppeteer-core', 'puppeteer-core'].filter(Boolean)) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('找不到 puppeteer-core');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const puppeteer = loadPuppeteer();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });

async function loginIfNeeded() {
  await page.goto(`${URL_BASE}/`, { waitUntil: 'networkidle2', timeout: 45000 });
  // 首次启动：初始化向导（站点名 → 账号）
  const navText = await page.evaluate(() => document.body.innerText);
  if (/初始化|欢迎使用/.test(navText)) {
    const site = await page.$('.auth-card input');
    if (site) { await site.click(); await page.keyboard.type('CloudNine'); }
    await page.click('.auth-card .btn-primary');
    await sleep(700);
    const inputs = await page.$$('.auth-card input');
    if (inputs.length >= 3) {
      await inputs[0].click(); await page.keyboard.type(USER);
      await inputs[1].click(); await page.keyboard.type(PASS);
      await inputs[2].click(); await page.keyboard.type(PASS);
    }
    await page.click('.auth-card .btn-primary');
    await sleep(2800);
  } else if (await page.$('.auth-card input')) {
    const inputs = await page.$$('.auth-card input');
    await inputs[0].click(); await page.keyboard.type(USER);
    await inputs[1].click(); await page.keyboard.type(PASS);
    await page.click('.auth-card .btn-primary');
    await sleep(2500);
  }
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  await sleep(600);
}

async function setTheme(theme) {
  await page.evaluate((t) => localStorage.setItem('cloudnine-theme', t), theme);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  await sleep(800);
}

async function emptyTrash() {
  await page.evaluate(async () => {
    await fetch('/api/fs/trash/empty', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  });
  await sleep(500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.desktop-icons', { timeout: 20000 });
  await sleep(700);
}

// 真的走一遍桌面拖拽：从一个文件图标拖到「回收站」系统图标上，再点确认
async function dragFirstFileToTrash() {
  const name = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.desktop-icon[data-entry]')];
    // 优先挑一个文件（目录的图标包没有投影），避免把 docs 这类演示目录拖走
    const file = all.find((el) => !el.querySelector('.di-icon-wrap.no-shadow'));
    return (file || all[0])?.dataset.entry || null;
  });
  if (!name) throw new Error('桌面上没有可拖的文件');
  const ok = await page.evaluate((entryName) => {
    const icon = document.querySelector(`.desktop-icon[data-entry="${CSS.escape(entryName)}"]`);
    const trash = [...document.querySelectorAll('.desktop-sysicon')].find((el) => el.title === '回收站');
    if (!icon || !trash) return false;
    const dt = new DataTransfer();
    dt.setData('application/x-cloudnine', JSON.stringify({ paths: [entryName], cwd: '', mode: 'move' }));
    icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    trash.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    trash.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  }, name);
  if (!ok) throw new Error('拖拽事件没发出去');
  await sleep(700);
  // 确认对话框
  const confirmed = await page.evaluate(() => {
    const dlg = document.querySelector('.dialog');
    if (!dlg) return false;
    const btn = [...dlg.querySelectorAll('.dialog-actions .btn')].find((b) => /移入/.test(b.innerText));
    (btn || dlg.querySelector('.dialog-actions .btn-primary'))?.click();
    return true;
  });
  await sleep(1600);
  const full = await page.evaluate(() => {
    const trash = [...document.querySelectorAll('.desktop-sysicon')].find((el) => el.title === '回收站');
    return { badge: trash?.querySelector('.desktop-badge')?.textContent || null, papers: !!trash?.querySelector('svg rect') };
  });
  return { name, confirmed, full };
}

// 系统图标近景（主目录 + 回收站，2× 放大）
async function sysIconCrop(label) {
  const box = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.desktop-sysicon')];
    if (!ids.length) return null;
    const a = ids[0].getBoundingClientRect(), b = ids[ids.length - 1].getBoundingClientRect();
    return { x: a.left - 10, y: a.top - 10, width: b.right - a.left + 20, height: b.bottom - a.top + 20 };
  });
  if (!box) return;
  const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(1440 - box.x, box.width), height: box.height };
  await page.screenshot({ path: join(OUT, `${label}.png`), clip });
}

async function desktop(label) {
  await page.screenshot({ path: join(OUT, `${label}.png`) });
  await sysIconCrop(`${label}-sysicons`);
  console.log(`✓ ${label}`);
}

// 开始菜单「已固定」那一排：七枚应当全是蓝色线描
async function startMenu(label) {
  await page.evaluate(() => document.querySelector('.tb-start')?.click());
  await page.waitForSelector('.startmenu .sm-app', { timeout: 8000 });
  await sleep(500);
  await page.screenshot({ path: join(OUT, `${label}.png`) });
  const box = await page.evaluate(() => {
    const el = document.querySelector('.startmenu');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(1440 - r.left, r.width), height: Math.min(900 - r.top, r.height) };
  });
  if (box) await page.screenshot({ path: join(OUT, `${label}-menu.png`), clip: box });
  await page.keyboard.press('Escape');
  await sleep(400);
  console.log(`✓ ${label}`);
}

await loginIfNeeded();
await setTheme('light');
await emptyTrash();
await desktop('desktop-light-empty');
await startMenu('startmenu-light');
const l = await dragFirstFileToTrash();
console.log('  拖入:', JSON.stringify(l));
await desktop('desktop-light-full');

await setTheme('dark');
await startMenu('startmenu-dark');
const d = await dragFirstFileToTrash();
console.log('  暗色拖入:', JSON.stringify(d));
await desktop('desktop-dark-full');

// 小图标档（32px）也拍一张：验证 32 档在真桌面上的样子
await page.evaluate(() => {
  const key = 'cloudnine-desktop-view';
  const cur = JSON.parse(localStorage.getItem(key) || '{}');
  localStorage.setItem(key, JSON.stringify({
    sort: cur.sort || { key: 'name', asc: true, dirsFirst: true },
    showHidden: !!cur.showHidden,
    iconSize: 'small',
  }));
});
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('.desktop-icons', { timeout: 20000 });
await sleep(900);
await desktop('desktop-dark-full-32');

await browser.close();
console.log(`✓ 截图输出到 ${OUT}`);
