# 测试

一条命令跑完仓库里所有自测：

```bash
npm test                 # 全部套件（串行执行）
npm run test:core        # 桌面 UI 全集 + 移动端（最常回归的两条）
npm run test:plugin      # 所有插件相关套件（含服务端 API 冒烟）
npm run test:fast        # core + dev-plugin + openwith（改动前后最快的一道闸）
npm run --silent test -- --list    # 只列套件，不跑
```

`scripts/run-tests.mjs` 是统一入口（零新依赖，只用 Node 标准库）。它**串行**跑每个套件——套件各自起后端 / vite、各自用临时目录，并行会互相抢端口和 CPU，Chrome 的断言也会抖。

## 为什么要跑这几条

2026-11 有过两次「功能没坏、只是那条路径当天没人跑」的事故：

- **dev 代理漏配**：`client/vite.config.js` 的 `server.proxy` 只代理了 `/api` 和 `/ws`，dev 下插件资源被 vite 的 SPA fallback 接走，插件永远发不出 `cn:ready`。生产构建那一套全绿，一点问题都看不出来 —— 只有 `test:plugin` 里的 `dev-plugin` 会挂。
- **大文件乱码**：`/api/fs/read` 被 `maxKB` 截断时把最后一个多字节字符切成两半，`TextDecoder(fatal)` 抛错 → 整篇退回 GB18030。只有 `express` 组的 `encoding-truncation` 会挂。

所以：**推之前跑 `test:fast`，合之前跑 `npm test`**。

## 套件清单

| 套件 id | 文件 | 分组 | 默认端口 | 说明 |
| --- | --- | --- | --- | --- |
| `core` | `scripts/uitest.mjs` | core | 随机（夹具） | 桌面 UI 全集（窗口 / 文件 / 终端 / 编辑器 / 预览 / 右键菜单…） |
| `mobile` | `scripts/uitest.mjs --mobile` | core | 随机（夹具） | 移动端用例（同一个文件的另一条路） |
| `dev-plugin` | `scripts/uitest-dev-plugin.mjs` | plugin | 8741（后端）+ 5273（vite） | vite dev server 的 `/pa`、`/plugin-sdk` 代理与插件开窗 |
| `plugins` | `scripts/uitest-plugins.mjs` | plugin | 8599 | 插件外壳接入：图标 / 开窗 / 沙箱 / 主题注入 / postMessage 协议 |
| `todo` | `scripts/uitest-todo.mjs` | plugin | 8699 | 示例插件 `todo` 端到端（含重启服务后的持久化） |
| `openwith` | `scripts/uitest-openwith.mjs` | plugin | 8644 | 文件关联：`打开方式` / `defaultFor` / `file.rel` / `ui.markDirty` |
| `json-plugin` | `scripts/uitest-json-plugin.mjs` | plugin | 8733 | 示例插件 `json` 端到端 |
| `md-plugin` | `scripts/uitest-md-plugin.mjs` | plugin | 8702 | 示例插件 `markdown` 端到端 |
| `plugins-smoke` | `scripts/plugins_smoke.py` | plugin, express | 随机（夹具） | 插件服务端 API 冒烟（401 / 安装 / CSP / 穿越 / storage / 413 / 409） |
| `encoding-truncation` | `scripts/uitest-encoding-truncation.mjs` | express | 8712 | 读取解码与截断（大文件中不乱码） |

端口不是手抄表：runner 直接读各脚本里的 `Number(arg('port', N))` / `arg('vite-port', N)`，套件改端口它跟着变。
`随机（夹具）` 表示这个套件自己不起服务，由 runner 起一个临时实例并给一个空闲随机端口（见下文）。

分组只是跑子集的快捷方式；一个套件可以同时属于多个分组（`plugins-smoke` 在 `plugin` 和 `express` 里都能被选中）。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--list` | 列出套件 / 分组 / 依赖，不执行 |
| `--only=a,b` | 只跑指定套件（id 见 `--list`） |
| `--group=core` | 只跑某个分组，可逗号分隔多个 |
| `--no-build` | `client/dist` 不存在时不自动 `npm run build` |
| `--keep` | 透传 `--keep` 给套件，保留它们自己的临时目录（排障用） |
| `--json` | 末尾多打一份 JSON 汇总（给 CI 用） |
| `--timeout=<秒>` | 单个套件的超时；超时会被杀掉并标为该套件失败 |

## 新加一个套件

三点，前两点自动生效：

1. **自动发现**：文件放在 `scripts/` 下，命名为 `uitest-<id>.mjs`（或 `uitest_xxx.mjs`）就会被发现，id 就是去掉前缀和 `.mjs` 的那段。`scripts/plugins_smoke.py` 也在这个名单里。**不需要改 runner**。
2. **分组**：先看 `scripts/run-tests.mjs` 顶部的 `KNOWN` 表（内置套件的分组与「要不要 runner 提供临时实例」都在那里）；不在表里时，runner 会读文件头 40 行里的 `@group plugin` 注释，再不行按文件名猜（含 `plugin` / `openwith` / `todo` → `plugin`，含 `encoding` / `smoke` / `api` / `server` → `express`，其余 `core`）。
3. **自己起环境**：新套件请沿用现有约定——自己起后端/前端、自己用 `testroot/` 下的临时目录、自己清理，跑完用 `process.exit(0/1)` 表示结果，并在最后一行打印 `通过 N/total`（`uitest*` 风格）或 `通过 N · 失败 M`（插件套件风格），runner 靠它填汇总表的条数。
   只有在套件**自己不打算起服务**（像 `uitest.mjs` 那样只吃 `--url`）时，才需要在 `KNOWN` 表里加一行 `fixture: true`。runner 会给它起一个临时实例（随机端口、`testroot/runner-*/` 下的 DATA_DIR / FILE_ROOT / PLUGINS_DIR）并传 `--url`，跑完杀掉；也可以在文件头写 `@needs-fixture` 走同一条路。

## 端口占用的处理

插件类套件用的是**写死的默认端口**（`plugins` 8599、`todo` 8699、`json-plugin` 8733、`md-plugin` 8702、`openwith` 8644、`encoding-truncation` 8712、`dev-plugin` 8741 + 5273）。这是它们能做到「自己起、自己清」的前提，但也带来一个很坏的失败模式：

> 上一个实例没被清掉（比如上次跑被 Ctrl-C、机器休眠、`taskkill` 只杀了父进程），端口还在别人手里。新套件起来后 `--strictPort` 起不来、或者干脆**连到了那个旧实例上**，于是「初始列表不为空」「计数对不上」——断言全在跑，但数字全是假的。它可能看着绿，也可能莫名其妙红，两者都不可信。

所以 runner 在每个套件开跑前会先探一次它的默认端口（`net.createServer().listen()`，占不上就是被占了）：

```
⊘ 3/7 json-plugin 跳过：端口 8733 已被占用，另一个测试实例可能在跑
    先清掉占用：Windows netstat -ano | findstr :8733 → taskkill /PID <pid> /F；macOS/Linux：lsof -i :8733 → kill <pid>
```

被占的套件标为 **跳过(端口)**，**不会**静默继续跑，也不会算通过——进程最终退出码非零。汇总表里有「默认端口」一列，一眼就能看出是哪一条撞了。

清残留实例：

```bash
# Windows
netstat -ano | findstr :8733          # 找 PID
taskkill /PID <pid> /T /F             # 连子进程一起杀
Get-Process node | Select-Object Id, StartTime   # 还找不着就按启动时间认

# macOS / Linux
lsof -i :8733
kill <pid>
```

顺带清掉 `testroot/`（各套件的临时数据目录，被中断的那次通常没删干净）和 `shots/` 里旧截图。

**并发跑多个套件时**：一个 runner 内部是串行的，不会自相冲突；但如果你同时开两个 runner（或两个终端），就要错开套件——每个套件的端口是固定的，同一条套件不能并行。临时起实例的 `core` / `mobile` / `plugins-smoke` 用随机端口（显式排除 8480 / 5173），不受影响。

## 环境与端口

- 永远不碰用户自己的 **8480**（生产/开发后端）和 **5173**（vite dev）。runner 自己不启动这两个，需要临时实例时用随机空闲端口，且显式排除 8480 / 5173。
- `TEMP` / `TMP` 被指到仓库内的 `testroot/build-tmp`：本机 esbuild 删系统 TEMP 里的临时文件会被 `Access is denied` 拒掉，`npm run build` 会随机失败。
- `CI=1`、`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1` 会设上（后者让 python 套件的中文与汇总行不乱码），其余环境变量原样传下去。
- 依赖自动探测（找不到就跳过对应套件并让最终退出码非零，不会假装通过）：
  - Chrome：`CLOUDNINE_TEST_CHROME` / `CHROME_PATH`，否则按系统默认位置找（Windows 的 `Program Files\Google\Chrome\Application\chrome.exe`、Linux 的 `/usr/bin/google-chrome` 等）。找到就自动给套件传 `--chrome`。
  - puppeteer-core：`PUPPETEER_CORE`，否则 `../.uitest/node_modules/puppeteer-core`、`node_modules/puppeteer-core`。找到就自动导出成 `PUPPETEER_CORE`。
  - python：`CLOUDNINE_TEST_PYTHON`，否则 `python` / `python3` / `py`。
- Windows 上夹具实例默认把 `SHELL` 指到 `wsl.exe`（有的话）：套件会往 PTY 里敲 `touch`、用 readline 的 `^V`，`cmd.exe` 下必然假失败。你自己设了 `SHELL` 就尊重你的。

## 失败了怎么定位

runner 的每一行都带套件 id；失败时会打印该套件**最后 40 行**输出（`--fail-lines=<N>` 可改），末尾汇总表把失败项和原因（超时 / 退出码 / 信号）列出来，任何失败 → 进程退出码 1；**全部被跳过也退非零**（什么都没验证不能算通过）。

- 想复现单个套件：`npm test -- --only=json-plugin`，或者直接 `node scripts/uitest-json-plugin.mjs --keep`，它在 `testroot/` 留下的临时目录和 `shots/` 里的截图就是现场。
- 浏览器类套件的截图在 `shots/<套件名>/`（`uitest.mjs` 的截图带时间戳目录，默认只保留最近 3 次）。
- 超时的套件会被整棵进程树杀掉（Windows `taskkill /T /F`），不用手动清进程。
- 桌面 UI（`core`）本机的已知偶发失败：「浏览器控制台无 JS 错误」偶尔多一条 401，先重跑一次再当回归。
