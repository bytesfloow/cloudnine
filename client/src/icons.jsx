import React from 'react';
import { fileCat } from './store.js';

/* ============================================================
   CloudNine 图标集 · Win11 Fluent 风（阶段 3 · T15 重绘 / T15b 统一）
   ------------------------------------------------------------
   两套东西，各自成体系：

   ① 文件类（桌面 / 资源管理器）：纸面 + 折角 + 底部类型色带，
      色带里固定 3 个字符的类型码（IMG / PDF / ZIP / TXT / BIN…），
      22 种扩展名归到 9 个类型，全部有角标、全部同字号同位置；
      <28px 自动只留纯色带（20px 列表视图不糊）。
   ② 应用 / 系统类（任务栏 / 开始菜单 / 桌面系统图标）：单色线性，
      48 视框、同一描边宽度（W(size, 2.4)）、圆头圆角、同一个强调色，
      不再混用底板 / 实心块 / 白纸面 —— 终端在暗色下也不会糊进背景。

   全部为原创 SVG：无位图 / 外链 / emoji / <image>，也不搬微软官方路径
   （开始按钮是抽象四格）。props 与改造前完全一致。
   ============================================================ */

const Svg = ({ size = 48, children, vb = '0 0 48 48', ...rest }) => (
  <svg width={size} height={size} viewBox={vb} fill="none" xmlns="http://www.w3.org/2000/svg" {...rest}>{children}</svg>
);

// 每个实例要有独立的渐变 id，否则同页多份图标会共用第一个 defs
const useUid = (p) => `${p}${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

// 48 视框描边：小尺寸按比例加粗，保证 ≥1px 视觉宽度；48px 时即设计稿宽度
const W = (size, base = 2.2) => {
  const k = size <= 20 ? 1.45 : size <= 28 ? 1.25 : size <= 36 ? 1.1 : 1;
  return +(base * k).toFixed(2);
};

const PAPER_EDGE = '#b8c2d0';

/* ---------------- 文件类：文件夹（实形，暖色） ---------------- */

// 带页签的文件夹剪影（左上角页签 + 一条斜边落到正面顶部）
const FOLDER_BACK = 'M5.5 15a5 5 0 0 1 5-5h10.2l2.6 3.2h14.2a5 5 0 0 1 5 5v17.4a5 5 0 0 1-5 5h-32a5 5 0 0 1-5-5z';
const FOLDER_FRONT = 'M5.5 19.8h37v15.8a5 5 0 0 1-5 5h-27a5 5 0 0 1-5-5z';

// 文件夹本体：背面页签一层深色、正面一层亮色。普通文件夹与「主目录」共用同一份路径与色阶，
// 保证两者并排时是同一个东西，只是后者多一枚标识。
function FolderBody({ id }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e5a71f" />
          <stop offset="1" stopColor="#d7970f" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f9c85d" />
          <stop offset="1" stopColor="#f0b137" />
        </linearGradient>
      </defs>
      <path d={FOLDER_BACK} fill={`url(#${id}b)`} />
      <path d={FOLDER_FRONT} fill={`url(#${id}f)`} />
    </>
  );
}

export const FolderIcon = ({ size = 48 }) => {
  const id = useUid('fd');
  return (
    <Svg size={size}>
      <FolderBody id={id} />
    </Svg>
  );
};

/* ---------------- 文件类：主目录（文件夹 + 系统标识） ----------------
   桌面左上角的「主目录」= 用户自己的文件空间入口，本质就是一个文件夹，
   所以不另起一套造型：底就是上面的 FolderIcon，只在正面右下角压一枚蓝
   色圆角方块当系统标识（和普通文件夹并排：同一张脸 + 一枚标记）。
   小尺寸不留细节：≤24px 时方块退化成圆点，且按像素下限放大一点，
   20px 下也有 3.8px 的实心点，不会糊成一团。 */
const MARK_SIZE = 8.6; // 48 视框里的标识边长
const MARK_RIGHT = 39.2; // 标识右边缘（正面右边缘 42.5；再让开圆角 5 的弧，留 ~2.4 的黄色边）
const MARK_BOTTOM = 37.5; // 标识下边缘（正面下边缘 40.6，同上）

export const IconRootFolder = ({ size = 48 }) => {
  const id = useUid('rf');
  const m = Math.max(MARK_SIZE, (3.8 * 48) / size);
  const x = MARK_RIGHT - m;
  const y = MARK_BOTTOM - m;
  const dot = size <= 24;
  return (
    <Svg size={size}>
      <defs>
        <linearGradient id={`${id}m`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3f8cf6" />
          <stop offset="1" stopColor="#1253cc" />
        </linearGradient>
      </defs>
      <FolderBody id={id} />
      {dot ? (
        <circle cx={x + m / 2} cy={y + m / 2} r={m / 2} fill={`url(#${id}m)`} />
      ) : (
        <rect x={x} y={y} width={m} height={m} rx={m * 0.29} fill={`url(#${id}m)`} />
      )}
    </Svg>
  );
};

/* ---------------- 文件类：文件（纸面 + 类型码） ---------------- */

// 9 个类型色带：白字在其上 ≥4.4:1（11px 小字也够）
const FILE_TINT = {
  image: '#1a8063',
  video: '#c2376b',
  audio: '#7a4fd0',
  pdf: '#c22b21',
  archive: '#9c6208',
  code: '#0a6ee0',
  text: '#4b5563',
  office: '#1a5bbf',
  bin: '#6f7a8a',
  // 无扩展名、也不在纯文本名单里：中性灰蓝、不带角标（见 store.js fileCat）
  plain: '#8b95a3',
};

// 角标文字：固定 3 个字符，同一字号同一基线 —— 角的「有没有」和「大小」都齐
const FILE_LABEL = {
  image: 'IMG',
  video: 'VID',
  audio: 'AUD',
  pdf: 'PDF',
  archive: 'ZIP',
  code: 'SRC',
  text: 'TXT',
  office: 'DOC',
  bin: 'BIN',
  plain: '',
};

const SHEET = 'M8 9.5A4.5 4.5 0 0 1 12.5 5h15.7L40 16.8v21.7a4.5 4.5 0 0 1-4.5 4.5h-23A4.5 4.5 0 0 1 8 38.5z';
const FOLD = 'M28.2 5 40 16.8h-9.8a2.2 2.2 0 0 1-2.2-2.2z';
const BAND = 'M8 29h32v9.5a4.5 4.5 0 0 1-4.5 4.5h-23A4.5 4.5 0 0 1 8 38.5z';

const FILE_FONT = "'Segoe UI', 'Microsoft YaHei', sans-serif";

function FileSheet({ size, cat }) {
  const id = useUid('fl');
  const tint = FILE_TINT[cat] || FILE_TINT.bin;
  const label = FILE_LABEL[cat] ?? FILE_LABEL.bin;
  const sw = W(size, 2.2);
  const detail = size >= 28 && !!label; // 20px 列表里只保留纸面 + 色带；plain 类型不印字
  return (
    <Svg size={size}>
      <defs>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#edf1f7" />
        </linearGradient>
      </defs>
      <path d={SHEET} fill={`url(#${id}p)`} />
      <path d={BAND} fill={tint} />
      <path d={FOLD} fill="#e0e6ef" />
      {detail && (
        <text
          x="24"
          y="40.3"
          textAnchor="middle"
          fill="#ffffff"
          fontFamily={FILE_FONT}
          fontSize="11.2"
          fontWeight="700"
          letterSpacing="0.2"
        >{label}</text>
      )}
      <path d={SHEET} stroke={PAPER_EDGE} strokeWidth={sw} />
    </Svg>
  );
}

export const FileIcon = ({ name, type, size = 48 }) => {
  if (type === 'dir') return <FolderIcon size={size} />;
  const cat = fileCat(name, type);
  return <FileSheet size={size} cat={cat} />;
};

/* ---------------- 应用 / 系统类：单色线性，同一个强调色 ----------------
   这 9 枚共用一套画法：48 视框、同一描边、圆头、无底板、无渐变、
   同一个 #0a7cff —— 开始菜单 7 枚 + 桌面「回收站」（主目录改用文件夹造型，见上）。 */

const ACCENT = '#0a7cff';
const A = (size) => W(size, 2.4);

export const IconFiles = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <path
        d="M5.8 14.9a4.7 4.7 0 0 1 4.7-4.7h9.8l2.7 3.2h14.3a4.7 4.7 0 0 1 4.7 4.7v17.3a4.7 4.7 0 0 1-4.7 4.7H10.5a4.7 4.7 0 0 1-4.7-4.7z"
        stroke={ACCENT}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      <path d="M5.8 21.2h36.2" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />
    </Svg>
  );
};

export const IconTerminal = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <rect x="5.6" y="8.4" width="36.8" height="31.2" rx="5" stroke={ACCENT} strokeWidth={sw} />
      <path d="M13.6 18.4 20.8 24.4l-7.2 6" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24.8 30.4h10.2" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />
    </Svg>
  );
};

export const IconEditor = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <rect x="9.6" y="5.2" width="28.8" height="37.6" rx="4.2" stroke={ACCENT} strokeWidth={sw} />
      <path d="M15.4 15.4h16.6M15.4 21.4h16.6M15.4 27.4h9.4" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />
      {/* 粉色铅笔躺在纸面下半部：笔杆 + 箍线 + 笔尖，全在纸面内，不跨边 */}
      <g transform="translate(30.5 33.5) rotate(45)" stroke={ACCENT} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" fill="none">
        <path d="M-3 4h6v-13h-6z" />
        <path d="M-3-1.4h6" />
        <path d="M-3 4 0 9.4l3-5.4" />
      </g>
    </Svg>
  );
};

export const IconTransfer = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <g stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M16 38.2V12" />
        <path d="M9.6 18.4 16 12l6.4 6.4" />
        <path d="M32 9.8V36" />
        <path d="M25.6 29.6 32 36l6.4-6.4" />
      </g>
    </Svg>
  );
};

export const IconShare = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <g stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* 托盘 + 向上射出的箭头（Fluent 分享语汇，和 IconUpload 的单线箭头区分开） */}
        <path d="M8.2 26v8.3a4.8 4.8 0 0 0 4.8 4.8h22a4.8 4.8 0 0 0 4.8-4.8V26" />
        <path d="M24 33.4V8.4" />
        <path d="M16.4 16 24 8.4l7.6 7.6" />
      </g>
    </Svg>
  );
};

export const IconDisk = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <circle cx="24" cy="24" r="17.6" stroke={ACCENT} strokeWidth={sw} />
      <circle cx="24" cy="24" r="6" stroke={ACCENT} strokeWidth={sw} />
      <circle cx="24" cy="24" r="1.6" fill={ACCENT} />
      <path d="M24 6.4a17.6 17.6 0 0 1 15.2 8.8" stroke={ACCENT} strokeWidth={W(size, 3)} strokeLinecap="round" />
    </Svg>
  );
};

export const IconTrash = ({ size = 26, full }) => {
  const sw = A(size);
  const detail = size >= 28;
  return (
    <Svg size={size}>
      {/* full 态：桶身填一层 16% 的强调色 + 里面的纸线，其余仍是同一套线 */}
      <path
        d="M14.9 16.6h18.2l-1.6 21.1a4.7 4.7 0 0 1-4.7 4.5h-5.6a4.7 4.7 0 0 1-4.7-4.5z"
        fill={full ? ACCENT : 'none'}
        fillOpacity={full ? 0.22 : 0}
        stroke={ACCENT}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      {full && detail && (
        <g stroke={ACCENT} strokeWidth={W(size, 2)} strokeLinecap="round" opacity=".7">
          <path d="M18.8 23.8h10.4M18.8 29.2h10.4M18.8 34.6h6.8" />
        </g>
      )}
      <rect x="11.7" y="9.8" width="24.6" height="5" rx="2.5" stroke={ACCENT} strokeWidth={sw} />
      <path d="M19.5 9.8a4.5 4.5 0 0 1 9 0" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />
    </Svg>
  );
};

// 主目录（当前无调用点，保留导出）：同一套线。桌面系统图标已改用 IconRootFolder，
// 原来的地球仪（IconGlobe）因此下线——它正是被用户看成「浏览器图标」的那一枚。
export const IconHome = ({ size = 26 }) => {
  const sw = A(size);
  return (
    <Svg size={size}>
      <path d="M6.2 21.4 24 6.6l17.8 14.8" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.8 19.6v17.2a4.4 4.4 0 0 0 4.4 4.4h19.6a4.4 4.4 0 0 0 4.4-4.4V19.6" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />
      <path d="M19.8 41.2V30.6a2.2 2.2 0 0 1 2.2-2.2h4a2.2 2.2 0 0 1 2.2 2.2v10.6" stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />
    </Svg>
  );
};

// 开始按钮：抽象四格（不是微软徽标路径），跟随 currentColor
export const IconWindows = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <rect x="2.6" y="2.6" width="8.9" height="8.9" rx="1.1" />
    <rect x="12.5" y="2.6" width="8.9" height="8.9" rx="1.1" />
    <rect x="2.6" y="12.5" width="8.9" height="8.9" rx="1.1" />
    <rect x="12.5" y="12.5" width="8.9" height="8.9" rx="1.1" />
  </svg>
);

/* ---------------- 中性线性小图标（本轮不动） ---------------- */

const G = ({ size = 20, d, fill = 'currentColor', ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} xmlns="http://www.w3.org/2000/svg" {...rest}><path d={d} /></svg>
);

export const IconSearch = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2.4" />
    <path d="M15.5 15.5L21 21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
export const IconChevron = ({ size = 12, dir = 'right' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ transform: dir === 'down' ? 'rotate(90deg)' : dir === 'left' ? 'rotate(180deg)' : dir === 'up' ? 'rotate(-90deg)' : 'none' }}>
    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const IconBell = ({ size = 15 }) => (
  <G size={size} d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22Zm7-5.5V11a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5.5L3 19v1h18v-1l-2-2.5Z" />
);
export const IconClose = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
);
export const IconUpload = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 20h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
export const IconDownload = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 4v12m0 0l-4.5-4.5M12 16l4.5-4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 20h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
export const IconGrid = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" />
  </svg>
);
export const IconList = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1.4" fill="currentColor" /><circle cx="4" cy="12" r="1.4" fill="currentColor" /><circle cx="4" cy="18" r="1.4" fill="currentColor" />
  </svg>
);
export const IconMore = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
  </svg>
);
export const IconPaste = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4.5h6v2.8H9z" />
    <path d="M15 5.6h2.5A1.5 1.5 0 0 1 19 7.1v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.1v-12A1.5 1.5 0 0 1 6.5 5.6H9" />
    <path d="M9 12.2h6M9 15.8h4" />
  </svg>
);
export const IconRefresh = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v5h-5" />
  </svg>
);
export const IconNewFolder = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M3 6a2 2 0 0 1 2-2h5l2.2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" fill="currentColor" opacity=".9" />
    <path d="M12 10v6M9 13h6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
export const IconEye = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const IconInfo = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" strokeLinecap="round" />
  </svg>
);

/* ---------------- 当前色系图标（移动端上传卡 / 开始菜单最近文件） ----------------
   这四枚在调用点靠 CSS 的 color 上色（.m-upload-card:nth-child(n) svg / --sm-icon），
   所以继续吃 currentColor，只在造型与描边上统一到新规范。 */

export const IconCamera = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
    <path d="M3.6 9.6A2.6 2.6 0 0 1 6.2 7h1.9l1.2-1.7c.5-.7 1.3-1.1 2.1-1.1h5.2c.8 0 1.6.4 2.1 1.1L19.9 7h1.9a2.6 2.6 0 0 1 2.6 2.6v8.8a2.6 2.6 0 0 1-2.6 2.6H6.2a2.6 2.6 0 0 1-2.6-2.6z" />
    <circle cx="12" cy="13.6" r="3.5" />
    <circle cx="12" cy="13.6" r="3.5" fill="currentColor" fillOpacity=".16" />
  </svg>
);

export const IconPhoto = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6" fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeWidth="1.9" />
    <circle cx="8.4" cy="9.4" r="1.6" fill="currentColor" />
    <path d="M4.6 18.2l4.1-4.2a1.6 1.6 0 0 1 2.3 0l3.1 3.1 1.6-1.6a1.6 1.6 0 0 1 2.3 0l2.5 2.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconDoc = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M6.5 3.5h7.1l4.9 4.8V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1.5-1.5Z" fill="currentColor" fillOpacity=".12" />
    <path d="M6.5 3.5h7.1l4.9 4.8V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1.5-1.5Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    <path d="M13.4 3.7v4.3a1 1 0 0 0 1 1h4.1" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    <path d="M8.4 12.4h6.2M8.4 15.8h4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

export const IconFolderBig = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M3 6.6A2.6 2.6 0 0 1 5.6 4h4.9l2.2 2.6h5.6A2.6 2.6 0 0 1 21 9.2v8.2a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 17.4z" fill="currentColor" fillOpacity=".12" />
    <path d="M3 6.6A2.6 2.6 0 0 1 5.6 4h4.9l2.2 2.6h5.6A2.6 2.6 0 0 1 21 9.2v8.2a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 17.4z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    <path d="M3.4 10.4h17.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);
