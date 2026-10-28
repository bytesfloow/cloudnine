import React from 'react';
import { fileCat } from './store.js';

// 原创简洁 SVG 图标（开源风格，不使用 Apple 素材）
const Svg = ({ size = 48, children, vb = '0 0 48 48', ...rest }) => (
  <svg width={size} height={size} viewBox={vb} fill="none" xmlns="http://www.w3.org/2000/svg" {...rest}>{children}</svg>
);

export const FolderIcon = ({ size = 48 }) => (
  <Svg size={size}>
    <path d="M4 12a4 4 0 0 1 4-4h10l5 5h17a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V12Z" fill="#4da3ff" />
    <path d="M4 17h40v-0a4 4 0 0 0-4-4H23l-5-5H8a4 4 0 0 0-4 4v5Z" fill="#6cb5ff" />
  </Svg>
);

const DocBase = ({ size, tint, label }) => (
  <Svg size={size}>
    <path d="M10 6a3 3 0 0 1 3-3h15l10 10v29a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V6Z" fill="#f4f5f7" />
    <path d="M28 3l10 10H28V3Z" fill="#d5d8de" />
    <rect x="10" y="33" width="28" height="15" rx="3" fill={tint} />
    {label && <text x="24" y="44" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="sans-serif">{label}</text>}
  </Svg>
);

export const FileIcon = ({ name, type, size = 48 }) => {
  if (type === 'dir') return <FolderIcon size={size} />;
  const cat = fileCat(name, type);
  if (cat === 'image') {
    return (
      <Svg size={size}>
        <path d="M10 6a3 3 0 0 1 3-3h15l10 10v29a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V6Z" fill="#f4f5f7" />
        <path d="M28 3l10 10H28V3Z" fill="#d5d8de" />
        <rect x="14" y="20" width="20" height="16" rx="2" fill="#34c783" />
        <circle cx="20" cy="26" r="2.4" fill="#fff" />
        <path d="M16 34l6-6 4 4 3-3 5 5H16Z" fill="#fff" opacity=".9" />
      </Svg>
    );
  }
  if (cat === 'video') return <DocBase size={size} tint="#ff6b81" label="▶" />;
  if (cat === 'audio') return <DocBase size={size} tint="#c56bff" label="♪" />;
  if (cat === 'pdf') return <DocBase size={size} tint="#ff5f57" label="PDF" />;
  if (cat === 'archive') return <DocBase size={size} tint="#f5a623" label="ZIP" />;
  if (cat === 'code') return <DocBase size={size} tint="#3b82f6" label="</>" />;
  if (cat === 'text') return <DocBase size={size} tint="#8e9299" label="T" />;
  if (cat === 'office') return <DocBase size={size} tint="#2d7ff9" label="DOC" />;
  return (
    <Svg size={size}>
      <path d="M10 6a3 3 0 0 1 3-3h15l10 10v29a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V6Z" fill="#eceef1" stroke="#d5d8de" />
      <path d="M28 3l10 10H28V3Z" fill="#d5d8de" />
    </Svg>
  );
};

// 功能图标（菜单栏 / Dock / 按钮）
const G = ({ size = 20, d, fill = 'currentColor', ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} xmlns="http://www.w3.org/2000/svg" {...rest}><path d={d} /></svg>
);

export const IconTerminal = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="7" width="40" height="34" rx="7" fill="#2b2b30" />
    <path d="M12 18l6 5-6 5" stroke="#5be07f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M22 29h12" stroke="#e8e8ec" strokeWidth="3" strokeLinecap="round" />
  </svg>
);
export const IconEditor = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <rect x="7" y="6" width="34" height="36" rx="6" fill="#fff" stroke="#d5d8de" />
    <path d="M14 16h20M14 23h20M14 30h13" stroke="#8e9299" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
);
export const IconTransfer = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 26l10-12 10 12" stroke="#30a5ff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M24 15v22" stroke="#30a5ff" strokeWidth="4" strokeLinecap="round" />
    <path d="M12 38h24" stroke="#8e9299" strokeWidth="4" strokeLinecap="round" />
  </svg>
);
export const IconShare = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <circle cx="36" cy="11" r="6" fill="#30a5ff" />
    <circle cx="11" cy="24" r="6" fill="#30a5ff" />
    <circle cx="36" cy="37" r="6" fill="#30a5ff" />
    <path d="M16.5 21l14-8M16.5 27l14 8" stroke="#30a5ff" strokeWidth="3.4" strokeLinecap="round" />
  </svg>
);
export const IconDisk = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <circle cx="24" cy="24" r="19" fill="#c8cbd2" />
    <circle cx="24" cy="24" r="6.5" fill="#fff" />
    <circle cx="24" cy="24" r="2.4" fill="#8e9299" />
    <path d="M24 5a19 19 0 0 1 16 8.7" stroke="#30a5ff" strokeWidth="3.4" strokeLinecap="round" fill="none" />
  </svg>
);
export const IconTrash = ({ size = 26, full }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 14h20l-2 26a4 4 0 0 1-4 3.6H20a4 4 0 0 1-4-3.6L14 14Z" fill={full ? '#8fbfdc' : '#c8cbd2'} />
    <rect x="11" y="9" width="26" height="4.6" rx="2.3" fill="#a7abb2" />
    <path d="M19 9a5 5 0 0 1 10 0" stroke="#a7abb2" strokeWidth="2.4" fill="none" />
  </svg>
);
export const IconFinder = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="40" height="40" rx="10" fill="#3f9bff" />
    <path d="M24 4c-4 8-4 32 0 40" stroke="#fff" strokeWidth="3" fill="none" />
    <path d="M14 17v6M34 17v6" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
    <path d="M16 33c5 3 11 3 16 0" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" />
  </svg>
);
export const IconHome = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 22L24 8l16 14v16a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V22Z" fill="#8e9299" />
    <path d="M19 41V29h10v12" fill="#5b5f66" />
  </svg>
);
export const IconSearch = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2.4" />
    <path d="M15.5 15.5L21 21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
export const IconChevron = ({ size = 12, dir = 'right' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ transform: dir === 'down' ? 'rotate(90deg)' : dir === 'left' ? 'rotate(180deg)' : 'none' }}>
    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const IconBell = ({ size = 15 }) => (
  <G size={size} d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22Zm7-5.5V11a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5.5L3 19v1h18v-1l-2-2.5Z" />
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
