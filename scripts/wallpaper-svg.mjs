#!/usr/bin/env node
/**
 * CloudNine「云海」壁纸生成器
 *
 * 壁纸是一张**静态内联 SVG**，以 data URI 的形式挂进 `--wallpaper`
 * （client/src/styles/base.css，亮/暗两个主题块各一条）。不引外链、不落位图，
 * 桌面 / 登录页 / 移动端 / 分享页共用这一个令牌，所以只改 base.css 一处。
 *
 * 用法：
 *   node scripts/wallpaper-svg.mjs --print     # 打印两段 CSS 声明
 *   node scripts/wallpaper-svg.mjs --write     # 就地刷新 base.css 的 WALLPAPER 标记区
 *   node scripts/wallpaper-svg.mjs --preview   # 输出 shots/wallpaper-preview.html（亮/暗对照）
 *
 * 图层（自下而上，共 6 层 / 4 个 mask，无任何 filter / blur / 动画）：
 *   1. 底色        rect  #08121e
 *   2. 天空        rect  径向渐变，圆心在右上角外（78% 0%），三档
 *   3. 云堤月光边  mask(bank 圆组，向左上偏 3/6) → #7fb1dd @ .30
 *   4. 云堤        mask(bank 圆组) → 竖向渐变 #1d4364 → #0c2135
 *   5. 云体月光边  mask(body 圆组，向左上偏 3.5/7) → #93c6f2 @ .38
 *   6. 云体 + 高光 mask(body 圆组) → 竖向渐变 #24507a → #173a5b → #0b1f33，
 *                  再叠一枚椭圆高光（radial #7cb2e4 @ .55 → 0，整层 .6）
 *
 * 为什么用 mask 而不是直接画圆：九个圆彼此重叠，半透明边缘和横向渐变一旦按圆
 * 各画各的，重叠处会出现发白的接缝；mask 把整组圆合成一个剪影，一次上色。
 *
 * 亮色 = 同一张画整体提亮一档：原型里是 `filter: brightness(1.15) saturate(1.03)`，
 * 这里把滤镜换成「直接算进色值」（背景图不能挂 filter），天空另取原型亮色那份手挑底色。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASE_CSS = join(ROOT, 'client', 'src', 'styles', 'base.css');

// ---------- 形体：三组圆的 cx / cy / r ----------
// 云体：九个圆叠成一片，重心压在右下（左上角留给桌面图标）
const BODY = [
  [610, 905, 190], [790, 820, 235], [1010, 760, 268], [1230, 800, 232], [1420, 880, 198],
  [880, 905, 258], [1100, 900, 248], [1310, 930, 218], [700, 965, 150],
];
// 云堤：左下那条更高的岸线，和云体之间留一道月光
const BANK = [[160, 985, 170], [330, 930, 190], [500, 905, 205], [660, 960, 180], [70, 1010, 140]];
// 原型里还有一组「远云」（右上角那朵小的实心云，4 个圆 + feGaussianBlur）。
// 用户看过效果后只否掉了它：右上角保持干净，全图不再有任何 blur。

// ---------- 色板 ----------
const BASE_DARK = '#08121e';
const SKY_DARK = ['#173a5e', '#0f2439', '#08121e'];   // 0 / .40 / .78 三档
const SKY_LIGHT_SRC = ['#28557f', '#173655', '#0c1d31']; // 原型亮色那份手挑底色
const BODY_G = ['#24507a', '#173a5b', '#0b1f33'];
const BANK_G = ['#1d4364', '#0c2135'];
const RIM_BODY = '#93c6f2';
const RIM_BANK = '#7fb1dd';
const HI = '#7cb2e4';

// ---------- 亮档：与 CSS 滤镜等价地直接改色值 ----------
// filter: brightness(1.15) saturate(1.03) 作用在 sRGB 通道上（CSS 滤镜按 sRGB 计算），
// 所以这里就是「先整体乘 1.15，再过一遍 saturate 矩阵」，alpha 不参与。
const hex2rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgb2hex = (v) => '#' + v.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
function tone(hex, brightness, saturate) {
  let [r, g, b] = hex2rgb(hex).map((c) => c * brightness);
  const s = saturate;
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const [nr, ng, nb] = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
  return rgb2hex([nr, ng, nb]);
}
const LIGHT = (c) => tone(c, 1.15, 1.03);
const DARK = (c) => c;

// ---------- SVG ----------
const circles = (arr, dx = 0, dy = 0) =>
  `<g transform='translate(${dx} ${dy})'>${arr.map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}'/>`).join('')}</g>`;

function buildSvg(toneFn, skySrc) {
  const sky = skySrc.map(toneFn);
  const bodyG = BODY_G.map(toneFn);
  const bankG = BANK_G.map(toneFn);
  const base = toneFn(BASE_DARK);
  // mask 只当「圆组的并集」用：白色区域不透明，圆与圆的重叠不会叠出更亮的接缝
  const mask = (id, arr, dx = 0, dy = 0) =>
    `<mask id='${id}' maskUnits='userSpaceOnUse' x='0' y='0' width='1440' height='900'><g fill='#fff'>${circles(arr, dx, dy)}</g></mask>`;
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 900' preserveAspectRatio='xMidYMid slice'>` +
    `<defs>` +
      // 天空：径向椭圆圆心 (1123,0)、半径 1100×760（= CSS 的 1100px 760px at 78% 0%）
      `<radialGradient id='sky' gradientUnits='userSpaceOnUse' cx='0' cy='0' r='1100' gradientTransform='translate(1123 0) scale(1 .69)'>` +
        `<stop offset='0' stop-color='${sky[0]}'/><stop offset='.4' stop-color='${sky[1]}'/><stop offset='.78' stop-color='${sky[2]}'/>` +
      `</radialGradient>` +
      `<linearGradient id='body' x1='0' y1='0' x2='0' y2='1'>` +
        `<stop offset='0' stop-color='${bodyG[0]}'/><stop offset='.5' stop-color='${bodyG[1]}'/><stop offset='1' stop-color='${bodyG[2]}'/>` +
      `</linearGradient>` +
      `<linearGradient id='bank' x1='0' y1='0' x2='0' y2='1'>` +
        `<stop offset='0' stop-color='${bankG[0]}'/><stop offset='1' stop-color='${bankG[1]}'/>` +
      `</linearGradient>` +
      `<radialGradient id='hi' cx='.5' cy='.5' r='.5'>` +
        `<stop offset='0' stop-color='${toneFn(HI)}' stop-opacity='.55'/><stop offset='1' stop-color='${toneFn(HI)}' stop-opacity='0'/>` +
      `</radialGradient>` +
      mask('mb', BODY) + mask('mbl', BODY, -3.5, -7) + mask('mk', BANK) + mask('mkl', BANK, -3, -6) +
    `</defs>` +
    `<rect width='1440' height='900' fill='${base}'/>` +
    `<rect width='1440' height='900' fill='url(#sky)'/>` +
    // 云堤：先铺月光边（整体向左上偏 3/6，被云堤压住后只剩左上一条亮边），再压云堤本体
    `<g mask='url(#mkl)'><rect width='1440' height='900' fill='${toneFn(RIM_BANK)}' opacity='.3'/></g>` +
    `<g mask='url(#mk)'><rect width='1440' height='900' fill='url(#bank)'/></g>` +
    // 云体：同一套顺序，亮边压在下面只露左上一线
    `<g mask='url(#mbl)'><rect width='1440' height='900' fill='${toneFn(RIM_BODY)}' opacity='.38'/></g>` +
    `<g mask='url(#mb)'><rect width='1440' height='900' fill='url(#body)'/></g>` +
    // 高光：只落在云体上，给「云海」一点通透感，不开滤镜
    `<g mask='url(#mb)' opacity='.6'><ellipse cx='870' cy='670' rx='420' ry='230' fill='url(#hi)'/></g>` +
  `</svg>`;
}

// data URI：只转义必须转义的 #（在 CSS 字符串里会被当片段起点截断），
// 其余 < > / 空格 / 单引号在带引号的 url("…") 里都是合法字符。
const toDataUri = (svg) => `url("data:image/svg+xml,${svg.replace(/#/g, '%23')}")`;
// 单层背景：位置 / 尺寸 / 不重复写在同一条 shorthand 里，base.css 各处仍是 `background: var(--wallpaper)`
const toDecl = (svg) => `center / cover no-repeat ${toDataUri(svg)}`;

// ---------- 输出 ----------
const DARK_DECL = toDecl(buildSvg(DARK, SKY_DARK));
const LIGHT_DECL = toDecl(buildSvg(LIGHT, SKY_LIGHT_SRC));

const arg = (n) => process.argv.includes(`--${n}`);

if (arg('write')) {
  const css = readFileSync(BASE_CSS, 'utf8');
  const splice = (src, theme, value) => {
    const open = `/* WALLPAPER:${theme} */`;
    const close = '/* WALLPAPER:end */';
    const i = src.indexOf(open);
    const j = src.indexOf(close, i);
    if (i < 0 || j < 0) throw new Error(`base.css 里找不到 ${theme} 的 WALLPAPER 标记区`);
    return src.slice(0, i + open.length) + `\n  --wallpaper: ${value};\n` + src.slice(j);
  };
  const out = splice(splice(css, 'light', LIGHT_DECL), 'dark', DARK_DECL);
  if (out === css) console.log('base.css 已是最新（无变化）');
  else { writeFileSync(BASE_CSS, out); console.log(`已写入 ${BASE_CSS}`); }
} else if (arg('preview')) {
  const out = join(ROOT, 'shots', 'wallpaper-preview.html');
  mkdirSync(join(ROOT, 'shots'), { recursive: true });
  // 预览页用 <style> 而不是 style 属性：SVG 里全是单引号，塞进 style='…' 会截断属性
  writeFileSync(out, `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#000}
  .w{position:relative;aspect-ratio:16/10;background-position:center;background-size:cover;background-repeat:no-repeat}
  .w:after{content:attr(data-t);position:absolute;left:8px;bottom:8px;color:#fff;font:12px/1.4 sans-serif;text-shadow:0 1px 2px #000}
  #dark{background-image:${toDataUri(buildSvg(DARK, SKY_DARK))}}
  #light{background-image:${toDataUri(buildSvg(LIGHT, SKY_LIGHT_SRC))}}
  </style>
  <div class="w" id="dark" data-t="dark"></div>
  <div class="w" id="light" data-t="light"></div>`);
  console.log(out);
} else {
  console.log(`/* 亮色 */\n--wallpaper: ${LIGHT_DECL};\n\n/* 暗色 */\n--wallpaper: ${DARK_DECL};`);
  console.error(`\n节点数：${(DARK_DECL.match(/<(?!\/)/g) || []).length}  字节：light ${LIGHT_DECL.length} / dark ${DARK_DECL.length}`);
}
