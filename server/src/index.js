import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { config, ensureDirs } from './config.js';
import { authRouter } from './auth.js';
import { fsRouter, cleanTrash } from './fs.js';
import { transferRouter } from './transfer.js';
import { mediaRouter, cleanOrphanTmp } from './media.js';
import { shareAdminRouter, sharePublicRouter } from './share.js';
import { setupTerminal } from './terminal.js';
import { serveStatic } from './static.js';

ensureDirs();
cleanOrphanTmp().catch(() => {});

const app = express();
// 只信任最近一跳（nginx）：固定跳数比 trust proxy=true 更保守，
// 客户端伪造在 X-Forwarded-For 里塞的左侧值不会被采纳
if (config.trustProxy) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// 路由
app.use('/api', authRouter);
app.use('/api', sharePublicRouter);
app.use('/api', shareAdminRouter);
app.use('/api', fsRouter);
app.use('/api', transferRouter);
app.use('/api', mediaRouter);

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 静态资源与页面
serveStatic(app);

// 统一错误处理
app.use((e, req, res, next) => {
  const status = e.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.url, e);
  res.status(status).json({ error: e.message || '服务器错误', code: e.code });
});

// 启动
const server = http.createServer(app);
setupTerminal(server);

server.listen(config.port, config.host, async () => {
  const n = await cleanTrash().catch(() => 0);
  setInterval(() => cleanTrash().catch(() => {}), 3600 * 1000).unref();
  console.log(`[${config.siteName}] 已启动: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`  文件根目录: ${config.fileRoot}`);
  console.log(`  数据目录:   ${config.dataDir}（废纸篓保留 ${config.trashRetentionDays} 天，启动时清理 ${n} 项）`);
  // 运维据此确认「来源 IP」是否可信：直连部署不该把 X-Forwarded-For 当真
  console.log(`  来源 IP:     ${config.trustProxy
    ? '信任反向代理头（TRUST_PROXY 已开启，取 X-Forwarded-For 最近一跳）'
    : '直连（忽略 X-Forwarded-For，用 TCP 对端地址；在 nginx 后面请设 TRUST_PROXY=1）'}`);
  if (!config.fileRoot.startsWith('/') && process.platform !== 'win32') console.warn('  ⚠ fileRoot 不是绝对路径');
});

server.on('error', (e) => {
  console.error('服务启动失败:', e.message);
  process.exit(1);
});
