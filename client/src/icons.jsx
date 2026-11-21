import React from 'react';
import { fileCat } from './store.js';

/* ============================================================
   CloudNine 图标集 · Win11 Fluent 风（阶段 3 · T15 重绘）
   ------------------------------------------------------------
   - 全部为原创 SVG 路径：不引用任何位图 / 外链 / emoji / <image>，
     也不搬微软官方图标的路径（开始按钮是抽象四格，不是徽标）。
   - 风格：扁平实形 + 极轻竖向渐变；无高光、无 3D 阴影、不描边套底板。
   - 文件类图标统一「纸面 + 折角 + 底部类型色带」，色带在 20px 下退出细节、
     只剩纯色块，保证列表视图不糊；≥28px 才画类型标记。
   - 描边宽度按目标像素尺寸补偿（W），16 / 24 / 32 / 48 下视觉宽度都 ≥1px。
   - props 与改造前完全一致：size / full / name / type / dir / label 均未改。
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
const DIM_INK = '#c3cad4';

/* ---------------- 文件夹 ---------------- */

// 带页签的文件夹剪影（左上角页签 + 一条斜边落到正面顶部）
const FOLDER_BACK = 'M5.5 15a5 5 0 0 1 5-5h10.2l2.6 3.2h14.2a5 5 0 0 1 5 5v17.4a5 5 0 0 1-5 5h-32a5 5 0 0 1-5-5z';
const FOLDER_FRONT = 'M5.5 19.8h37v15.8a5 5 0 0 1-5 5h-27a5 5 0 0 1-5-5z';

export const FolderIcon = ({ size = 48 }) => {
  const id = useUid('fd');
  return (
    <Svg size={size}>
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
    </Svg>
  );
};

// 「文件」应用：同款剪影，背面换成蓝灰（Win11 资源管理器是双色文件夹）
export const IconFiles = ({ size = 26 }) => {
  const id = useUid('fs');
  return (
    <Svg size={size}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5d80b8" />
          <stop offset="1" stopColor="#46689f" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f9c85d" />
          <stop offset="1" stopColor="#f0b137" />
        </linearGradient>
      </defs>
      <path d={FOLDER_BACK} fill={`url(#${id}b)`} />
      <path d={FOLDER_FRONT} fill={`url(#${id}f)`} />
    </Svg>
  );
};

/* ---------------- 文件 ---------------- */

// 文件类型色带：饱和但不刺眼，白色标记在其上 ≥3.9:1（图形对比度）
const FILE_TINT = {
  image: '#1f8f6d',
  video: '#c2376b',
  audio: '#7a4fd0',
  pdf: '#c22b21',
  archive: '#a76a0a',
  code: '#0a6ee0',
  text: '#5a6472',
  office: '#1a5bbf',
};

const SHEET = 'M8 9.5A4.5 4.5 0 0 1 12.5 5h15.7L40 16.8v21.7a4.5 4.5 0 0 1-4.5 4.5h-23A4.5 4.5 0 0 1 8 38.5z';
const FOLD = 'M28.2 5 40 16.8h-9.8a2.2 2.2 0 0 1-2.2-2.2z';
const BAND = 'M8 31h32v7.5a4.5 4.5 0 0 1-4.5 4.5h-23A4.5 4.5 0 0 1 8 38.5z';

// 色带上的类型标记（≥28px 才画）：全部为粗笔画/实形，避免小尺寸糊成噪点
function FileMark({ cat }) {
  const wide = { fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif", fontWeight: 700, fontSize: 9.4, textAnchor: 'middle', fill: '#ffffff' };
  switch (cat) {
    case 'image':
      return (
        <g fill="#ffffff">
          <circle cx="17" cy="35.1" r="1.9" />
          <path d="M12.8 41.4l5.1-6.1a1.2 1.2 0 0 1 1.9 0l2.9 3.4 1.6-1.9a1.2 1.2 0 0 1 1.9 0l4.4 4.6z" />
        </g>
      );
    case 'video':
      return <path d="M19.4 33.2 29 38l-9.6 4.8z" fill="#ffffff" />;
    case 'audio':
      return (
        <g fill="#ffffff">
          <path d="M21.2 40.2V33c0-.5.4-.9.9-1 3.1.6 5 2.3 5.6 4.9" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" fill="none" />
          <ellipse cx="18.8" cy="40.2" rx="2.9" ry="2.3" transform="rotate(-18 18.8 40.2)" />
        </g>
      );
    case 'pdf':
      return <text x="24" y="40.1" {...wide}>PDF</text>;
    case 'archive':
      return <text x="24" y="40.1" {...wide}>ZIP</text>;
    case 'code':
      return (
        <g stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M17.9 33.5 13.6 37.1l4.3 3.6" />
          <path d="M30.1 33.5l4.3 3.6-4.3 3.6" />
          <path d="M26.4 32.6 21.6 41.6" strokeWidth="2.2" />
        </g>
      );
    case 'text':
      return (
        <g stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round">
          <path d="M14.6 33.9h18.8M14.6 37.1h18.8M14.6 40.3h12.4" />
        </g>
      );
    case 'office':
      return (
        <g stroke="#ffffff" fill="none">
          <rect x="14.2" y="32.5" width="19.6" height="10" rx="1.7" strokeWidth="2.3" />
          <path d="M14.2 37.5h19.6M24 32.5v10" strokeWidth="1.7" />
        </g>
      );
    default:
      return null;
  }
}

function FileSheet({ size, cat }) {
  const id = useUid('fl');
  const tint = FILE_TINT[cat];
  const sw = W(size, 2.2);
  const detail = size >= 28; // 20px 列表里只保留纸面 + 色带，避免细节糊成一片
  return (
    <Svg size={size}>
      <defs>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#edf1f7" />
        </linearGradient>
      </defs>
      <path d={SHEET} fill={`url(#${id}p)`} />
      {tint && <path d={BAND} fill={tint} />}
      <path d={FOLD} fill="#e0e6ef" />
      {!tint && detail && (
        <g stroke={DIM_INK} strokeWidth="2.4" strokeLinecap="round">
          <path d="M15 22h18M15 27.2h18M15 32.4h11" />
        </g>
      )}
      {tint && detail && <FileMark cat={cat} />}
      <path d={SHEET} stroke={PAPER_EDGE} strokeWidth={sw} />
    </Svg>
  );
}

export const FileIcon = ({ name, type, size = 48 }) => {
  if (type === 'dir') return <FolderIcon size={size} />;
  const cat = fileCat(name, type);
  return <FileSheet size={size} cat={cat} />;
};

/* ---------------- 应用 / 功能图标 ---------------- */

export const IconTerminal = ({ size = 26 }) => {
  const id = useUid('tm');
  const sw = W(size, 3.6);
  return (
    <Svg size={size} vb="0 0 48 48">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b424e" />
          <stop offset="1" stopColor="#1c2027" />
        </linearGradient>
      </defs>
      {/* 机身保留 .it-term-body：暗色主题下由 --icon-rim 补一圈描边（base.css） */}
      <rect x="5.5" y="8" width="37" height="32" rx="5" fill={`url(#${id}g)`} className="it-term-body" />
      <path d="M13.2 17.6 20.6 24l-7.4 6.4" stroke="#4cc2ff" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24 30.4h11" stroke="#dde5f1" strokeWidth={sw} strokeLinecap="round" />
    </Svg>
  );
};

export const IconEditor = ({ size = 26 }) => {
  const sw = W(size, 2.2);
  return (
    <Svg size={size}>
      <rect x="9" y="5" width="30" height="38" rx="3.5" fill="#ffffff" stroke={PAPER_EDGE} strokeWidth={sw} />
      <path d="M14.6 15h18.8M14.6 21h18.8M14.6 27h12" stroke="#8f99a6" strokeWidth={W(size, 2.6)} strokeLinecap="round" />
      {/* 记号笔：斜躺在纸面上，17px 下仍是一段清楚的蓝色斜块 + 笔尖 */}
      <g transform="translate(40 30) rotate(45)">
        <rect x="-3" y="0" width="6" height="12" rx="1.4" fill="#0a7cff" />
        <path d="M-3 12h6l-3 5z" fill="#0a7cff" />
      </g>
    </Svg>
  );
};

export const IconTransfer = ({ size = 26 }) => {
  const sw = W(size, 4.6);
  return (
    <Svg size={size}>
      <g stroke="#0a7cff" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M16 38.5V12" />
        <path d="M9.4 18.6 16 12l6.6 6.6" />
        <path d="M32 9.5V36" />
        <path d="M25.4 29.4 32 36l6.6-6.6" />
      </g>
    </Svg>
  );
};

export const IconShare = ({ size = 26 }) => {
  const sw = W(size, 3.4);
  return (
    <Svg size={size}>
      <g stroke="#0a7cff" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* 托盘 + 向上射出的箭头（Fluent 分享语汇，和 IconUpload 的单线箭头区分开） */}
        <path d="M7.4 25.8v8.6a5 5 0 0 0 5 5h23.2a5 5 0 0 0 5-5v-8.6" />
        <path d="M24 33V7.6" />
        <path d="M16.2 15.4 24 7.6l7.8 7.8" />
      </g>
    </Svg>
  );
};

export const IconDisk = ({ size = 26 }) => {
  const id = useUid('dk');
  const sw = W(size, 2.2);
  return (
    <Svg size={size}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eef2f8" />
          <stop offset="1" stopColor="#d5dce6" />
        </linearGradient>
      </defs>
      {/* 平放的盘片 + 蓝色使用率弧：无高光、无立体感，17px 下是「圆盘 + 中心孔」 */}
      <circle cx="24" cy="24" r="18.4" fill={`url(#${id}g)`} stroke="#a4afbe" strokeWidth={sw} />
      <circle cx="24" cy="24" r="6.4" fill="#f7f9fc" stroke="#a4afbe" strokeWidth={sw} />
      <circle cx="24" cy="24" r="2.1" fill="#8d98a8" />
      <path d="M24 5.6a18.4 18.4 0 0 1 15.9 9.1" stroke="#0a7cff" strokeWidth={W(size, 4.2)} strokeLinecap="round" fill="none" />
    </Svg>
  );
};

export const IconTrash = ({ size = 26, full }) => {
  const sw = W(size, 2.2);
  const detail = size >= 28;
  return (
    <Svg size={size}>
      {/* 桶身是浅灰金属，压在亮/暗两套表面上都清楚；full 态靠「桶里的纸」区分 */}
      <path
        d="M14.6 16.4h18.8l-1.7 21.7a4.8 4.8 0 0 1-4.8 4.7h-5.8a4.8 4.8 0 0 1-4.8-4.7z"
        fill={full ? '#f6f9fd' : '#dbe1e9'}
      />
      {full && detail && (
        // full 态：桶里塞满纸，三张微斜的白纸 + 灰描边，32/48px 下一眼能分辨
        <g stroke="#c2cbd8" strokeWidth="1.6" fill="#ffffff">
          <rect x="16.6" y="21.4" width="14.8" height="4.6" rx="1.3" transform="rotate(-4 24 23.7)" />
          <rect x="16.9" y="26.8" width="14.2" height="4.6" rx="1.3" transform="rotate(3 24 29.1)" />
          <rect x="17.6" y="32.2" width="13" height="4.6" rx="1.3" transform="rotate(-2 24.1 34.5)" />
        </g>
      )}
      <rect x="11.4" y="9.6" width="25.2" height="5.2" rx="2.6" fill="#7f8997" />
      <path d="M19.2 9.9a4.8 4.8 0 0 1 9.6 0" stroke="#7f8997" strokeWidth={W(size, 2.9)} fill="none" strokeLinecap="round" />
      <path
        d="M14.6 16.4h18.8l-1.7 21.7a4.8 4.8 0 0 1-4.8 4.7h-5.8a4.8 4.8 0 0 1-4.8-4.7z"
        stroke="#7f8997"
        strokeWidth={sw}
        fill="none"
        strokeLinejoin="round"
      />
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

// 主目录：单色实形 + 挖空门洞（fill-rule 挖洞，任何背景下都不会露出底色）
export const IconHome = ({ size = 26 }) => (
  <Svg size={size} vb="0 0 24 24">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      fill="currentColor"
      d="M12.9 3.2a1.5 1.5 0 0 0-1.8 0L2.7 10.7a1.4 1.4 0 0 0 1.7 2.2l.8-.7v7.1a2.7 2.7 0 0 0 2.7 2.7h13.2a2.7 2.7 0 0 0 2.7-2.7v-7.1l.8.7a1.4 1.4 0 1 0 1.7-2.2zM15 21.9v-5.6a1.2 1.2 0 0 0-1.2-1.2h-3.6a1.2 1.2 0 0 0-1.2 1.2v5.6z"
    />
  </Svg>
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
export const IconGlobe = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9Z" stroke="currentColor" strokeWidth="2" fill="none" />
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
