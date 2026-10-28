import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../client/dist');

export function serveStatic(app) {
  if (!fs.existsSync(DIST)) {
    app.get('/', (req, res) => res
      .status(200)
      .type('html')
      .send('<meta charset="utf-8"><body style="font-family:sans-serif;background:#1d1d1f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div>客户端尚未构建：请先运行 <code>npm --prefix client install &amp;&amp; npm --prefix client run build</code></div></body>'));
    return;
  }

  app.use(express.static(DIST, { index: false, maxAge: '1d' }));

  const html = (file) => (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, file));
  };
  app.get('/', html('index.html'));
  app.get('/s/*', html('share.html'));
}
