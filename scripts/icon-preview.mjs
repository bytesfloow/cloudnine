#!/usr/bin/env node
/**
 * 桌面系统图标对比图（回收站重绘验收用）
 *
 * 直接 import client/src/icons.jsx 里的真组件（esbuild 打包 + react-dom/server 直出静态 SVG），
 * 所以图里画的就是应用里画的那一份，不会出现「预览稿和落地稿不一样」。
 *
 * 用法：
 *   node scripts/icon-preview.mjs --sheet compare   # 亮/暗 × 空/满，与主目录、普通文件夹并排
 *   node scripts/icon-preview.mjs --sheet sizes     # 20 / 32 / 48 三档 1:1（含 4× 像素采样）
 *   node scripts/icon-preview.mjs --sheet all
 *
 * 环境：PUPPETEER_CORE 指向 puppeteer-core，--chrome 指定 Chrome（默认系统路径）。
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLIENT = join(ROOT, 'client');
const OUT = join(ROOT, 'shots', 'icons-trash');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const CHROME = arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const SHEET = arg('sheet', 'all');

function loadPuppeteer() {
  const candidates = [process.env.PUPPETEER_CORE, join(ROOT, 'node_modules', 'puppeteer-core'),
    'C:\\Users\\zhl\\Desktop\\workspace\\.uitest\\node_modules\\puppeteer-core', 'puppeteer-core'].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch { /* next */ } }
  throw new Error('找不到 puppeteer-core');
}

// ---------- 用 esbuild 把 icons.jsx 打成一个能直出的 cjs ----------
const esbuild = require(join(CLIENT, 'node_modules', 'esbuild'));
const entry = `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as I from './src/icons.jsx';
export const html = (name, props) => renderToStaticMarkup(React.createElement(I[name], props));
export const has = (name) => !!I[name];
`;
const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: CLIENT, sourcefile: 'preview-entry.jsx', loader: 'jsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
});
// store.js 在模块顶层读 localStorage / matchMedia：Node 里补空壳（图标本身不依赖它们）
const mem = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) };

const bundlePath = join(tmpdir(), `cloudnine-icons-${process.pid}.cjs`);
writeFileSync(bundlePath, built.outputFiles[0].text);
const { html, has } = await import(`file:///${bundlePath.replace(/\\/g, '/')}`);

// ---------- 壁纸：直接从 base.css 里取真实的那两条 data URI ----------
const css = readFileSync(join(CLIENT, 'src', 'styles', 'base.css'), 'utf8');
const wallpaper = (theme) => {
  const m = css.match(new RegExp(`/\\* WALLPAPER:${theme} \\*/\\s*--wallpaper:\\s*([^;]+);`));
  return m ? m[1].trim() : '#12324f';
};
const icon = (name, props) => (has(name) ? html(name, props) : `<span class="miss">missing ${name}</span>`);

const PURE = {
  light: { surface: 'rgba(255,255,255,.94)', text: '#1b1b1b', line: 'rgba(0,0,0,.1)' },
  dark: { surface: 'rgba(43,43,43,.96)', text: '#e7e7e7', line: 'rgba(255,255,255,.12)' },
};

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #0e1319; color: #e8ecf2; }
  .page { width: 1120px; }
  .theme { padding: 26px 30px 30px; background-size: cover; background-position: center; }
  .theme + .theme { border-top: 1px solid #000a; }
  .theme-name { font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: #fff; opacity: .7;
    text-shadow: 0 1px 3px rgba(0,0,0,.6); margin: 0 0 18px; }
  .row { display: flex; align-items: flex-end; gap: 28px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .art { display: grid; place-items: center; }
  .cap { font-size: 12px; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.8), 0 0 8px rgba(0,0,0,.5); white-space: nowrap; }
  .cap.dim { font-size: 11px; opacity: .6; }
  .zoom { margin-top: 16px; padding-top: 16px; border-top: 1px solid #ffffff1f; display: flex; gap: 26px; align-items: flex-end; }
  .panel { margin-top: 22px; padding: 14px 18px; border-radius: 12px; background: var(--surface); color: var(--text); border: 1px solid var(--line); }
  .panel h4 { margin: 0 0 12px; font-size: 11.5px; font-weight: 600; opacity: .65; letter-spacing: .04em; }
  .chips { display: flex; gap: 2px; }
  .chip { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 12px 6px; border-radius: 6px; }
  .chip .cap { color: #1b1b1b; text-shadow: none; font-size: 11.5px; }
  .theme--dark .chip .cap { color: #e7e7e7; }
  .sizes { display: flex; gap: 30px; align-items: flex-end; }
  .sizes .cell { gap: 7px; }
  .sizes .cap { font-size: 11px; }
  .sep { width: 1px; align-self: stretch; background: #ffffff33; margin: 0 2px 26px; }
  .foot { font-size: 11px; opacity: .5; margin-top: 12px; }
  .miss { color: #f66; font-size: 11px; }
  .title { margin: 0 0 14px; font-size: 13px; font-weight: 600; color: #fff; opacity: .85; }
`;

const wallpaperCss = `
.wp-light { background: ${wallpaper('light')}; }
.wp-dark { background: ${wallpaper('dark')}; }
`;

const COMPARE = (theme, name) => `
<section class="theme wp-${theme} theme--${theme}" style="--surface:${PURE[theme].surface}; --text:${PURE[theme].text}; --line:${PURE[theme].line};">
  <p class="theme-name">${name} · 48px 系统图标同排</p>
  <div class="row">
    <div class="cell"><div class="art">${icon('IconRootFolder', { size: 48 })}</div><span class="cap">主目录</span></div>
    <div class="cell"><div class="art">${icon('FolderIcon', { size: 48 })}</div><span class="cap">普通文件夹</span></div>
    <div class="cell"><div class="art">${icon('IconTrash', { size: 48 })}</div><span class="cap">回收站 · 空</span></div>
    <div class="cell"><div class="art">${icon('IconTrash', { size: 48, full: true })}</div><span class="cap">回收站 · 满</span></div>
  </div>
  <div class="zoom">
    <div class="cell"><div class="art">${icon('IconRootFolder', { size: 112 })}</div></div>
    <div class="cell"><div class="art">${icon('IconTrash', { size: 112 })}</div></div>
    <div class="cell"><div class="art">${icon('IconTrash', { size: 112, full: true })}</div></div>
    <div class="cell"><div class="art">${icon('FolderIcon', { size: 112 })}</div></div>
  </div>
  <div class="panel">
    <h4>开始菜单「已固定」同排（30px，和其余 6 枚线描图标并排）</h4>
    <div class="chips">
      ${[['IconFiles', '文件'], ['IconTerminal', '终端'], ['IconEditor', '记事本'], ['IconTransfer', '传输'],
        ['IconShare', '分享'], ['IconDisk', '磁盘']]
        .map(([n, cap]) => `<div class="chip"><span>${icon(n, { size: 30 })}</span><span class="cap">${cap}</span></div>`).join('')}
      <div class="chip"><span>${icon('IconTrash', { size: 30 })}</span><span class="cap">回收站</span></div>
      <div class="chip"><span>${icon('IconTrash', { size: 30, full: true })}</span><span class="cap">回收站·满</span></div>
    </div>
  </div>
</section>`;

const SIZES = (theme, name) => `
<section class="theme wp-${theme} theme--${theme}" style="--surface:${PURE[theme].surface}; --text:${PURE[theme].text}; --line:${PURE[theme].line};">
  <p class="theme-name">${name} · 20 / 32 / 48 三档 1:1</p>
  <div class="sizes">
    ${[48, 32, 20].map((s) => `
      <div class="cell"><div class="art">${icon('IconTrash', { size: s })}</div><span class="cap">${s}px · 空</span></div>`).join('')}
    <div class="sep"></div>
    ${[48, 32, 20].map((s) => `
      <div class="cell"><div class="art">${icon('IconTrash', { size: s, full: true })}</div><span class="cap">${s}px · 满</span></div>`).join('')}
    <div class="sep"></div>
    ${[48, 32, 20].map((s) => `
      <div class="cell"><div class="art">${icon('FolderIcon', { size: s })}</div><span class="cap">${s}px · 文件夹</span></div>`).join('')}
  </div>
  <div class="zoom">
    ${[['空', false], ['满', true]].map(([cap, full]) => `
      <div class="cell"><span class="art"><span class="pixart" data-size="20">${icon('IconTrash', { size: 20, full })}</span></span><span class="cap dim">20px · ${cap} · 放大 6×（像素落点）</span></div>`).join('')}
  </div>
  <div class="foot">上面一行是 1:1 实际像素，不做任何缩放；下排两个是把 20px 那张按 6 倍最近邻放大后的真实像素。</div>
</section>`;

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${wallpaperCss}</style></head>
<body><div class="page">${body}</div></body></html>`;
}

const puppeteer = loadPuppeteer();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const pg = await browser.newPage();
await pg.setViewport({ width: 1120, height: 900, deviceScaleFactor: 2 });

async function shoot(name, body) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.html`);
  writeFileSync(file, page(body));
  await pg.goto(`file:///${file.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
  await pg.evaluate(async () => {
    for (const host of document.querySelectorAll('.pixart')) {
      const svg = host.querySelector('svg');
      const size = Number(host.dataset.size);
      const src = svg.outerHTML.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '')
        .replace(/^<svg /, `<svg width="${size}" height="${size}" `);
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(src)))}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      c.style.width = `${size * 6}px`;
      c.style.height = `${size * 6}px`;
      c.style.imageRendering = 'pixelated';
      host.replaceChildren(c);
    }
  });
  const el = await pg.$('.page');
  const png = join(OUT, `${name}.png`);
  await el.screenshot({ path: png });
  const box = await el.boundingBox();
  console.log(`✓ ${png}  (${Math.round(box.width)}×${Math.round(box.height)} @2x)`);
}

if (SHEET === 'all' || SHEET === 'compare') {
  await shoot('01-compare-light-dark', COMPARE('light', 'Light 亮色桌面') + COMPARE('dark', 'Dark 暗色桌面'));
}
if (SHEET === 'all' || SHEET === 'sizes') {
  await shoot('02-sizes-1to1', SIZES('light', 'Light 亮色桌面') + SIZES('dark', 'Dark 暗色桌面'));
}

await browser.close();
