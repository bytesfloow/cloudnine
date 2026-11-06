# CloudNine — macOS 风格云服务器桌面

自托管的单用户云桌面：部署到云服务器后，浏览器打开就是一个 macOS 风格桌面（菜单栏、桌面图标、可拖动窗口、Dock）。文件在「访达」里管理，命令在「终端」里执行；手机浏览器自动切换为 iOS 风格单屏形态。

Node.js ≥ 18 · Express + ws · React 18 + Vite · CodeMirror 6 · node-pty

## 快速开始

```bash
npm run install:all   # 安装 server/ 与 client/ 依赖
npm run build         # 构建客户端
npm start             # 启动服务，默认 :8480
```

打开 http://localhost:8480，首次访问通过初始化向导创建唯一账号。

开发模式（前端热更新）：两个终端分别跑 `npm run dev:server`（:8480）与 `npm run dev:client`（Vite :5173，已代理 `/api`、`/ws`）。

## 配置

优先级：环境变量 > `server/config.json` > 默认值。全部配置项见 [server/config.example.json](server/config.example.json)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 8480 | 监听端口 |
| `HOST` | 0.0.0.0 | 建议只监听本地 + 反向代理 |
| `FILE_ROOT` | Linux `/` | **可浏览的文件根目录，生产环境务必指向数据盘** |
| `DATA_DIR` | `server/data` | 账号、会话、分享、废纸篓、上传临时文件 |
| `SESSION_DAYS` | 7 | 会话有效期（「记住我」30 天） |

忘记密码：停止服务 → 删除 `DATA_DIR/db.json` 的 `account` 字段 → 重启后重新初始化。

## 部署（Linux）

推荐直接使用仓库内置工具链，模板与脚本都在 `scripts/`：

```bash
# 首次部署（开发机执行，需可 SSH 到目标服务器）
python3 scripts/deploy_cloudnine.py --host <IP> --user ubuntu --bootstrap --push

# 后续部署：拉代码 → 装依赖 → 构建 → 重启 → 健康检查，任一步失败自动回滚
python3 scripts/deploy_cloudnine.py --host <IP> --user ubuntu --push
```

手工部署时以 [scripts/systemd/cloudnine.service](scripts/systemd/cloudnine.service) 和 [scripts/nginx/cloudnine.conf](scripts/nginx/cloudnine.conf) 为模板，细节见 [scripts/bootstrap.sh](scripts/bootstrap.sh) 与 [scripts/deploy_remote.sh](scripts/deploy_remote.sh)。

两个必知约束：

- 若启用 `ProtectSystem=strict`，`ReadWritePaths` 必须包含 `FILE_ROOT` 与 `DATA_DIR`，否则文件管理器所有写操作都会失败。
- 终端等价于服务器控制权：生产环境必须走 HTTPS/WSS 并限制访问来源。

扩展解压格式需系统组件：`bunzip2`、`xz`、`p7zip`、`unrar`。

## 测试

```bash
python3 scripts/smoke_test.py --url http://<IP>/
node scripts/uitest.mjs --url http://<IP>/ --user <账号> --password <密码>
```

`smoke_test.py` 仅用标准库，覆盖账号、文件读写、搜索、上传下载、Range、分享、废纸篓、磁盘；`uitest.mjs` 用 puppeteer-core 驱动系统 Chrome 做桌面与移动视口的 UI 自测（需先安装 `puppeteer-core`，可用 `PUPPETEER_CORE` 指定路径）。测试用的 `testroot/`、`server/data/` 是本地产物，已在 `.gitignore` 中，clone 后不存在。

## 功能概览

- 访达：图标/列表视图、搜索、框选拖拽、右键菜单、简介与权限
- 终端：真实 PTY、多标签、断线重连
- 编辑与预览：CodeMirror 6 语法高亮、Quick Look、图片/音视频/PDF/Markdown/CSV/Office 预览
- 传输：分片断点续传、文件夹上传、批量打包下载、压缩解压
- 分享与运维：带密码/有效期的分享链接、磁盘监控、废纸篓、深浅主题与通知
- 移动端：≤768px 自动切换 iPhone 风格形态

功能范围与实现取舍以代码和提交历史为准；未纳入本版本的能力（如浏览器扩展、本地客户端、终端命令审计等）见对应源码注释。

## 安全须知

- 终端 = 服务器控制权，务必 HTTPS/WSS + 登录鉴权 + 限制来源，并用低权限专用账号运行服务。
- 所有文件接口做路径规范化与根目录边界校验；服务进程权限即可操作的文件边界。
- 密码 bcrypt 加盐、登录限流、Cookie HttpOnly/SameSite=Lax；分享令牌不可枚举。
- 界面为原创实现，不含 Apple 商标/字体/素材，与 Apple 无关。

## 其他文档

- [LICENSE](LICENSE)
