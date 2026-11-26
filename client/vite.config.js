import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发/预览服务器也要把 /s/<token> 指向独立的分享入口页。
// 只在中间件阶段改写 req.url，保留浏览器地址栏里的原始 token（ShareApp 从 location 读取）。
function shareHtmlRoute() {
  const rewrite = (req, _res, next) => {
    const [pathname, ...queryParts] = String(req.url || '').split('?');
    if (/^\/s\//.test(pathname)) {
      req.url = `/share.html${queryParts.length ? `?${queryParts.join('?')}` : ''}`;
    }
    next();
  };
  return {
    name: 'cloudnine-share-html-route',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

// 后端地址：默认 8480（`npm run dev:server`）。要连别的实例时用 CLOUDNINE_API 覆盖，
// 这样同一份配置既能连本机默认端口，也能连临时起在其它端口上的实例（例如性能测量）。
const API_TARGET = process.env.CLOUDNINE_API || 'http://localhost:8480';
const WS_TARGET = API_TARGET.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react(), shareHtmlRoute()],
  // 依赖预打包缓存的默认位置（node_modules/.vite）允许被 CLOUDNINE_CACHE_DIR 覆盖：
  // scripts/uitest-dev-plugin.mjs 要自己起一个 dev 实例，得用独立缓存目录，
  // 否则会和本机正在跑的 dev 抢同一份 .vite（互相判定「依赖已过期」整页重载）。
  cacheDir: process.env.CLOUDNINE_CACHE_DIR || 'node_modules/.vite',
  // dev 预打包：CodeMirror 全家桶 + 各语言包（原本是点开记事本时才被发现的新依赖，
  // vite 得在路中优化一次并整页重载，首次打开也就多了一大截白屏）。
  // 现在启动时就一起预构建，运行中不会再触发。
  optimizeDeps: {
    include: [
      '@uiw/react-codemirror',
      'codemirror',
      '@codemirror/view',
      '@codemirror/state',
      '@codemirror/theme-one-dark',
      '@codemirror/lang-javascript',
      '@codemirror/lang-json',
      '@codemirror/lang-yaml',
      '@codemirror/lang-markdown',
      '@codemirror/lang-python',
      '@codemirror/lang-html',
      '@codemirror/lang-css',
      '@codemirror/lang-sql',
      '@codemirror/lang-cpp',
      '@codemirror/lang-java',
      '@codemirror/lang-go',
      '@codemirror/lang-php',
      '@codemirror/lang-rust',
      'js-beautify',
    ],
  },
  build: {
    rollupOptions: {
      input: { main: 'index.html', share: 'share.html' },
    },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    // 先把首屏 + 编辑器的模块队列在后台转译好：浏览器请求时已经命中缓存，
    // 不再把「第一次点开记事本」变成一次大转译
    warmup: {
      clientFiles: [
        'src/main.jsx',
        'src/App.jsx',
        'src/desktop/Desktop.jsx',
        'src/windows/Editor.jsx',
        'src/windows/EditorSkeleton.jsx',
      ],
    },
    // 代理清单必须与 server/src/index.js 挂的「不在 vite 里的」路由一一对应：
    //   /api      → 所有业务接口（各 *Router 都挂在 /api 下）
    //   /ws       → 终端的 WebSocket（server/src/terminal.js 监听 upgrade: /ws/term）
    //   /pa       → 插件静态资源（server/src/plugins.js 的 pluginAssetRouter）
    //   /plugin-sdk → 插件 SDK 单文件（同上 router）
    // 漏掉 /pa 的后果不是 404：vite 会把 /pa/.../index.html 走 SPA fallback 回成它自己的
    // index.html（带 @vite/client、/src/main.jsx），而插件 iframe 是 opaque origin
    // （故意不给 allow-same-origin），这些脚本会被 CORS 全拦 → 插件永远不发 cn:ready。
    // 页面路由（/ 与 /s/*）不代理：dev 下由 vite 自己出 index.html / share.html。
    proxy: {
      '/api': API_TARGET,
      '/pa': API_TARGET,
      '/plugin-sdk': API_TARGET,
      '/ws': { target: WS_TARGET, ws: true },
    },
  },
});
