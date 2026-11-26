import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { config, ensureDirs } from './config.js';
import { authRouter } from './auth.js';
import { fsRouter, cleanTrash } from './fs.js';
import { transferRouter } from './transfer.js';
import { mediaRouter, cleanOrphanTmp } from './media.js';
import { shareAdminRouter, sharePublicRouter } from './share.js';
import { systemRouter } from './system.js';
import { setupTerminal } from './terminal.js';
import { pluginsRouter, pluginAssetRouter } from './plugins.js';
import { serveStatic } from './static.js';
import { saveDB } from './db.js';

// ================= 进程级兜底 =================
// 注意：这里只兜「漏网的」异常，不是正常错误路径。流/路由里的错误必须在原地处理
// （media.js 的 writeEntry、fs.js 的 try/catch），挂了全局兜底也不能拿它当挡箭牌。
//
// 已经有 server.on('error')，但它只管 http server 自己的错误（端口占用等），
// 接不到定时器/流回调/异步链里抛出的东西。
process.on('uncaughtException', (e, origin) => {
  // 未捕获异常意味着进程状态已不可信（可能某个函数半途中断、锁没释放），
  // 继续跑只会把问题放大：记完整堆栈 + 上下文，尽最大努力把待落盘数据写下去，
  // 然后退出，交给 systemd 重启（scripts/systemd/cloudnine.service 是 Restart=always）。
  console.error(`[fatal] uncaughtException（来源 ${origin || 'uncaughtException'}），进程即将退出`);
  console.error(e?.stack || e);
  try {
    // db 的写盘本身不会抛（内部已捕获），这里再包一层以防万一
    if (!saveDB(true)) console.error('[fatal] 退出前写盘未成功，最后几百毫秒的内存改动会丢失');
  } catch (e2) {
    console.error('[fatal] 退出前写盘抛出异常:', e2?.stack || e2);
  }
  // 略等一下让日志落盘（日志可能被重定向到文件，写入是异步的），然后退出
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  // node-pty 1.1.0 的 ConPTY 回退清理路径在 console-list agent 失败时会对
  // undefined 调 forEach；PTY 已按幂等流程关闭，只忽略这一条已知库内噪声。
  const message = String(reason?.message || reason || '');
  const stack = String(reason?.stack || '');
  if (/windowsPtyAgent\.js/.test(stack) && /forEach/.test(message) && /undefined/.test(message)) {
    console.warn('[terminal] 忽略 node-pty 关闭 ConPTY 时的已知清理异常');
    return;
  }
  // 这类错误通常是某条异步链漏了 catch / await。
  // 选择「记录但不退出」：单用户自托管场景下，为了一个后台任务的疏忽反复重启整个服务，
  // 对使用者而言比留下一条醒目的日志更糟。但日志必须带完整堆栈，否则无从排查。
  console.error('[fatal] unhandledRejection（未处理的 Promise 拒绝，代码漏了 catch/await）');
  console.error(reason?.stack || reason);
});

ensureDirs();
// 启动清理失败不能静默：否则遗留的 .cloudnine-tmp 会一直堆着没人知道
cleanOrphanTmp().catch((e) => console.error('[media] 启动时清理遗留临时文件失败:', e.message));

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
// 插件 fs.writeText 的上限是 8MB（见 docs/plugins.md §6.2），JSON 请求体会略大于文本本身；
// 只对写文件这条路由放宽，其余接口保持 2MB，不动别的接口的上限。
app.use('/api/fs/write', express.json({ limit: '24mb' }));
app.use(express.json({ limit: '2mb' }));

// 路由
app.use('/api', authRouter);
app.use('/api', sharePublicRouter);
app.use('/api', shareAdminRouter);
app.use('/api', fsRouter);
app.use('/api', transferRouter);
app.use('/api', mediaRouter);
app.use('/api', systemRouter);
// 插件：/api/plugins* 要登录；/pa、/plugin-sdk 是公开的（理由见 plugins.js）
app.use('/api', pluginsRouter);
app.use(pluginAssetRouter);

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
  const n = await cleanTrash().catch((e) => { console.error('[trash] 启动时清理废纸篓失败:', e.message); return 0; });
  // 定时清理也不能静默吞错（cleanTrash 内部会记清单损坏的情况，这里兜真正意外的异常）
  setInterval(() => cleanTrash().catch((e) => console.error('[trash] 定时回收异常:', e.message)), 3600 * 1000).unref();
  console.log(`[${config.siteName}] 已启动: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`  文件根目录: ${config.fileRoot}`);
  console.log(`  数据目录:   ${config.dataDir}（废纸篓保留 ${config.trashRetentionDays} 天，启动时清理 ${n} 项）`);
  console.log(`  插件目录:   ${config.pluginsDir}（私有数据 ${config.pluginDataDir}）`);
  // 运维据此确认「来源 IP」是否可信：直连部署不该把 X-Forwarded-For 当真
  console.log(`  来源 IP:     ${config.trustProxy
    ? '信任反向代理头（TRUST_PROXY 已开启，取 X-Forwarded-For 最近一跳）'
    : '直连（忽略 X-Forwarded-For，用 TCP 对端地址；在 nginx 后面请设 TRUST_PROXY=1）'}`);
  if (!config.fileRoot.startsWith('/') && process.platform !== 'win32') console.warn('  ⚠ fileRoot 不是绝对路径');
});

server.on('error', (e) => {
  // 端口被占用、绑定地址不可用等：这类错误没救，直接退出让 systemd/pm2 处理
  console.error('[fatal] 服务启动失败:', e.code ? `${e.code}: ` : '', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
