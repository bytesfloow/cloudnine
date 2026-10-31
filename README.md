# CloudNine — macOS 风格云服务器桌面

自托管的单用户云桌面：部署在云服务器上，浏览器打开即进入一个 **macOS 风格的桌面环境**——菜单栏、桌面图标、可自由拖动的窗口、底部 Dock。文件在"访达"窗口里管理，命令在"终端"窗口里执行，手机浏览器自动切换为 iOS 风格单屏形态。

功能范围与交互细节见 [需求文档.md](./需求文档.md)（v2.1，含全部决策记录）。

## 功能一览

- **访达**：图标/列表视图、侧边栏（个人收藏/挂载点）、路径栏、递归搜索、橡皮筋框选、拖拽移动/复制、右键菜单、行内重命名、显示简介（chmod/chown）、最近打开
- **终端**：node-pty 真实 PTY（未安装时自动降级为管道 Shell）、多标签、自适应尺寸、断线重连
- **文本编辑**：CodeMirror 6、语法高亮（JS/TS/Python/Go/JSON/YAML/Markdown 等 15+ 语言）、`Ctrl/Cmd+S` 保存（临时文件 + 原子替换）、外部变更冲突检测、另存为
- **预览**：空格键快速预览（Quick Look）、图片缩放旋转、音视频边下边播（HTTP Range）、PDF、Markdown 渲染、CSV 表格、压缩包内列表、docx/xlsx 在线渲染（懒加载）、未知类型信息卡
- **上传下载**：拖拽/按钮/粘贴上传、文件夹上传保留目录结构、4MB 分片 + 断点续传、暂停/继续/重试、同名自动重命名、多选打包 zip 流式下载、Range 断点下载
- **压缩解压**：zip / tar.gz / tar 打包（后台任务 + 进度），zip/tar*/gz/bz2/xz/7z/rar 解压（bz2/xz/7z/rar 依赖系统组件），zip-slip 与压缩炸弹防护
- **文件共享**：有效期/访问密码/下载次数上限/允许下载/允许上传（投递），独立轻量分享页 `/s/<token>`，分享管理窗口
- **磁盘监控**：菜单栏常驻指示器 + 完整窗口（各挂载点用量、inode、自动刷新、点击跳转目录）
- **废纸篓**：删除默认移入废纸篓（数据目录内），还原 / 彻底删除 / 清倒，保留 30 天自动清理
- **账号**：首次访问初始化向导（仅可创建一个账号）、密码登录（bcrypt + 登录限流）、会话滑动续期、修改密码、退出登录
- **移动端**：≤768px 自动切换 iPhone 风格形态——主屏幕桌面（应用图标网格 + Dock）、应用全屏缩放动画、Home 指示条（点按/上滑返回桌面）、长按操作菜单（Action Sheet）、多选批量操作、拍照/相册上传、终端快捷键栏
- **其他**：浅色/深色主题（跟随系统）、通知中心、全局快捷键、桌面右键菜单

## 目录结构

```
cloudnine/
├── 需求文档.md          # PRD（v2.1）
├── server/              # Node.js + Express + ws 服务端
│   └── src/
│       ├── index.js     # 入口：路由装配 / 静态资源 / WS
│       ├── config.js    # 配置（环境变量 > config.json > 默认值）
│       ├── auth.js      # 初始化/登录/会话/限流
│       ├── fs.js        # 文件系统 API + 废纸篓
│       ├── transfer.js  # 分片上传 / Range 下载 / zip 打包
│       ├── terminal.js  # PTY WebSocket
│       ├── media.js     # 磁盘监控 / 压缩解压 / 后台任务
│       └── share.js     # 分享管理 + 公开分享接口
└── client/              # React 18 + Vite 客户端
    └── src/
        ├── desktop/     # 菜单栏 / Dock / 窗口管理 / 右键 / 对话框 / 快速预览
        ├── windows/     # 访达 / 终端 / 编辑器 / 预览 / 简介 / 传输 / 分享 / 磁盘
        ├── mobile/      # iOS 风格移动形态
        ├── share/       # 分享访问页（独立入口 share.html）
        └── store.js     # 全局状态 + 事件总线
```

## 快速开始

要求：Node.js ≥ 18（建议 20+）。

```bash
# 1. 安装依赖
npm run install:all

# 2. 构建客户端
npm run build

# 3. 启动服务端（默认端口 8480）
npm start
# 开发模式（服务端热重载）：npm run dev:server
```

打开 `http://localhost:8480`，首次访问会进入初始化向导创建唯一账号。

### 开发调试（前端热更新）

```bash
npm run dev:server   # 终端 1：服务端 :8480
npm run dev:client   # 终端 2：Vite :5173（/api 与 /ws 已代理到 8480）
```

## 配置

环境变量或 `server/config.json`（优先级：环境变量 > config.json > 默认值）。示例见 [server/config.example.json](./server/config.example.json)。

| 配置项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 端口 | `PORT` | 8480 | 监听端口 |
| 监听地址 | `HOST` | 0.0.0.0 | 建议配合反向代理 |
| **文件根目录** | `FILE_ROOT` | Linux `/`（Windows 开发默认用户主目录） | 可浏览的起始目录，建议限制到数据盘 |
| 数据目录 | `DATA_DIR` | `server/data` | 账号、分享、废纸篓、上传临时文件 |
| 站点名称 | `SITE_NAME` | CloudNine | 菜单栏与标题显示 |
| 会话有效期 | `SESSION_DAYS` | 7 | "记住我" 30 天 |
| 上传上限 | `MAX_UPLOAD_MB` | 4096 | 单文件大小上限 |
| 废纸篓保留 | `TRASH_RETENTION_DAYS` | 30 | 到期自动清理 |
| 解压上限 | `MAX_EXTRACT_MB` | 8192 | 压缩炸弹防护 |
| Shell | `SHELL` | Linux `bash` / Windows `%ComSpec%` | 终端默认 Shell |
| 信任代理 | `TRUST_PROXY` | true | 反向代理下识别 X-Forwarded-Proto |

账号、会话、分享、最近打开记录存放在 `DATA_DIR/db.json`，废纸篓清单在 `DATA_DIR/trash.json`。

忘记密码：停止服务 → 删除 `db.json` 中 `account` 字段（或整个文件）→ 重启后重新初始化。

## 生产部署（Linux）

```bash
# 构建
npm run install:all && npm run build

# 以 systemd 常驻（示例）
sudo tee /etc/systemd/system/cloudnine.service <<'EOF'
[Unit]
Description=CloudNine
After=network.target

[Service]
WorkingDirectory=/opt/cloudnine/server
Environment=FILE_ROOT=/data
Environment=PORT=8480
ExecStart=/usr/bin/node src/index.js
Restart=always
User=cloudnine

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now cloudnine
```

建议配合 Nginx/Caddy 反向代理 + HTTPS：

```nginx
location / {
    proxy_pass http://127.0.0.1:8480;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
location /ws/ {   # 终端 WebSocket
    proxy_pass http://127.0.0.1:8480;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

可选系统组件（扩展解压格式）：`bunzip2`、`xz`（多数发行版自带）、`p7zip`（7z）、`unrar`。

## 安全说明

- 所有文件接口做路径规范化 + 根目录边界校验，杜绝路径穿越；上传目录不可执行
- 终端等价于服务器控制权：WebSocket 握手校验会话，生产环境务必走 HTTPS/WSS 并限制来源
- 密码 bcrypt 加盐存储；登录限流（10 分钟 10 次失败锁定 15 分钟）
- Cookie：HttpOnly + SameSite=Lax +（HTTPS 下）Secure
- 分享令牌不可枚举；分享页禁止访问父目录；`Referrer-Policy: strict-origin-when-cross-origin`
- 服务进程权限 = 能操作的文件边界：推荐专用低权限账户运行，需要更大范围时由运维显式调整
- 界面风格为原创实现，不包含 Apple 商标/字体/壁纸素材，与 Apple 无关

## 已知限制（与需求文档对应）

- 桌面端"窗口总览（Mission Control 式）"与刷新后窗口布局恢复未实现（决策 Q11：本版本不做）
- 终端审计为会话级（建立/来源/关闭），逐命令审计为后续增强（决策 Q5）
- 分享上传为单请求投递（上限 100 MB），不走分片
- PWA（manifest/添加到主屏幕）为 P1 增量，本版本未包含

## 开发测试说明

仓库内 `testroot/` 为开发冒烟测试用的文件根目录（含测试账号 `owner` / `test1234abcd`，数据在 `server/data/`）。正式使用时请通过 `FILE_ROOT` 指向自己的目录，并删除 `server/data/db.json` 重新初始化。
