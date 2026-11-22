# 部署与配置

CloudNine 是单进程 Node.js 服务：Express 提供 API 与静态资源，ws 承载终端与文件变更推送。生产环境推荐 Linux + systemd + nginx，同机自托管。

## 环境要求

- Node.js ≥ 18
- Linux（systemd + nginx），或任意能运行 Node.js 的系统
- 解压 `bz2` / `xz` / `7z` / `rar` 需要系统组件：`bunzip2`、`xz`、`p7zip`、`unrar`

## 配置

优先级：环境变量 > `server/config.json` > 默认值。全部配置项见 [server/config.example.json](../server/config.example.json)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 8480 | 监听端口 |
| `HOST` | 0.0.0.0 | 建议只监听本地 + 反向代理 |
| `FILE_ROOT` | Linux `/` | **可浏览的文件根目录，生产环境务必指向数据盘** |
| `DATA_DIR` | `server/data` | 账号、会话、分享、回收站、上传临时文件 |
| `SESSION_DAYS` | 7 | 会话有效期（「记住我」30 天） |
| `TRUST_PROXY` | `false` | 是否信任代理头（`X-Forwarded-For` / `X-Forwarded-Proto`）。只有确实在 nginx 等反向代理后面才设为 `1`，且反代必须**覆盖写**该头（见 `scripts/nginx/cloudnine.conf`）；直连部署保持 `false`，否则客户端伪造该头就能冒充来源 IP、绕过登录限流 |

忘记密码：停止服务 → 删除 `DATA_DIR/db.json` 的 `account` 字段 → 重启后重新初始化。

## 部署（Linux）

推荐直接使用仓库内置工具链，模板与脚本都在 `scripts/`：

```bash
# 首次部署（开发机执行，需可 SSH 到目标服务器）
python3 scripts/deploy_cloudnine.py --host <IP> --user ubuntu --bootstrap --push

# 后续部署：拉代码 → 装依赖 → 构建 → 重启 → 健康检查，任一步失败自动回滚
python3 scripts/deploy_cloudnine.py --host <IP> --user ubuntu --push
```

手工部署时以 [scripts/systemd/cloudnine.service](../scripts/systemd/cloudnine.service) 和 [scripts/nginx/cloudnine.conf](../scripts/nginx/cloudnine.conf) 为模板，细节见 [scripts/bootstrap.sh](../scripts/bootstrap.sh) 与 [scripts/deploy_remote.sh](../scripts/deploy_remote.sh)。

两个必知约束：

- 若启用 `ProtectSystem=strict`，`ReadWritePaths` 必须包含 `FILE_ROOT` 与 `DATA_DIR`，否则文件管理器所有写操作都会失败。
- 终端等价于服务器控制权：生产环境必须走 HTTPS/WSS 并限制访问来源。

## 本地开发

```bash
npm run install:all
npm run dev:server   # API + ws，:8480
npm run dev:client   # Vite 热更新，:5173，已代理 /api 与 /ws
```

## 测试

```bash
python3 scripts/smoke_test.py --url http://<IP>/
node scripts/uitest.mjs --url http://<IP>/ --user <账号> --password <密码>
```

`smoke_test.py` 仅用标准库，覆盖账号、文件读写、搜索、上传下载、Range、分享、回收站、磁盘；`uitest.mjs` 用 puppeteer-core 驱动系统 Chrome 做桌面与移动视口的 UI 自测（需先安装 `puppeteer-core`，可用 `PUPPETEER_CORE` 指定路径）。测试用的 `testroot/`、`server/data/` 是本地产物，已在 `.gitignore` 中，clone 后不存在。

`uitest.mjs` 每次运行会在 `shots/uitest-<时间戳>/` 下留一套分步截图与 `report.txt` 报告（`shots/` 同样在 `.gitignore` 中，不入库）。截图只用于排障：断言失败时报告会指出对应截图文件名。历史目录会自动滚动清理，默认只保留最近 3 次（`--keep-shots N` 可调整），避免 `shots/` 无限膨胀。

## 安全须知

- 终端 = 服务器控制权，务必 HTTPS/WSS + 登录鉴权 + 限制来源，并用低权限专用账号运行服务。
- 所有文件接口做路径规范化与根目录边界校验；可操作范围即服务进程权限。
- 密码 bcrypt 加盐、登录限流、Cookie HttpOnly/SameSite=Lax；分享令牌不可枚举。
- 界面与图标为原创实现，不使用第三方商标、字体或素材。

## 相关文档

- 界面结构与快捷键：[win11-interaction-spec.md](win11-interaction-spec.md)
- 许可证：[LICENSE](../LICENSE)
