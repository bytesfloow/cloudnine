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

export default defineConfig({
  plugins: [react(), shareHtmlRoute()],
  build: {
    rollupOptions: {
      input: { main: 'index.html', share: 'share.html' },
    },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8480',
      '/ws': { target: 'ws://localhost:8480', ws: true },
    },
  },
});
