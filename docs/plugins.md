# 插件系统（v1）

CloudNine 的插件是一份**纯静态前端包**：`plugin.json` + 一个入口 HTML + 任意静态资源（css/js/图片/字体）。
插件跑在沙箱 iframe 里，通过 `postMessage` 调用宿主提供的少量能力；**v1 不允许插件自带 Node 后端代码**，也拿不到终端。

> 一句话理解安全模型：单用户自托管下「装插件 = 管理员自己往自己机器上放网页」。
> 权限声明（`permissions`）是**声明式约束**（前端据此展示、宿主据此拒绝调用），**不是沙箱**；
> 真正的隔离来自 iframe + `Content-Security-Policy: sandbox`（opaque origin，读不到 cookie、访问不到宿主 DOM）。
> 所以：只装你信得过的插件，跟「给浏览器装扩展」一个道理。

---

## 1. 目录布局

| 路径 | 说明 |
| --- | --- |
| `<DATA_DIR>/plugins/<id>/` | 安装后的插件包（`PLUGINS_DIR` 可改） |
| `<DATA_DIR>/plugin-data/<id>.json` | 插件私有数据（`storage` 权限），**不进 `db.json`** |
| `<DATA_DIR>/asset-secret` | `/pa` 资源 URL 的签名密钥（0600，首次运行生成） |

新增两个配置项（优先级：环境变量 > `server/config.json` > 默认值）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLUGINS_DIR` | `<DATA_DIR>/plugins` | 插件安装目录 |
| `PLUGIN_DATA_DIR` | `<DATA_DIR>/plugin-data` | 插件私有数据目录 |

备份：搬 `DATA_DIR` 就同时带走插件包、插件数据、签名密钥（密钥丢了不会坏数据，只是资源 URL 会变）。

---

## 2. `plugin.json` 全字段

```json
{
  "id": "hello",
  "name": "你好 CloudNine",
  "version": "1.0.0",
  "description": "示例插件",
  "author": "CloudNine",
  "icon": "icon.svg",
  "entry": "index.html",
  "window": { "width": 720, "height": 540, "minWidth": 420, "minHeight": 320, "multi": true },
  "permissions": ["storage"],
  "onDesktop": true,
  "inStartMenu": true,
  "minHostVersion": "0.1.0"
}
```

| 字段 | 必填 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | ✅ | string | — | `^[a-z0-9][a-z0-9._-]{1,47}$`，**必须等于安装目录名**；同时是数据文件名 |
| `name` | ✅ | string | — | 显示名，≤ 64 字符 |
| `version` | ✅ | string | — | 只允许字母数字和 `. + _ -`，≤ 32 字符（建议 semver） |
| `description` | — | string | `null` | ≤ 300 字符 |
| `author` | — | string | `null` | ≤ 100 字符 |
| `icon` | — | string | `null` | 相对路径，只支持 `.svg` / `.png` |
| `entry` | — | string | `index.html` | 相对路径，入口 HTML |
| `window.width` | — | number | `900` | 初始宽（200–4096） |
| `window.height` | — | number | `620` | 初始高（200–4096） |
| `window.minWidth` | — | number | `420` | 最小宽 |
| `window.minHeight` | — | number | `320` | 最小高 |
| `window.multi` | — | boolean | `true` | 是否允许开多个窗口 |
| `permissions` | — | string[] | `[]` | 只能是下面 5 个之一，未知权限 = manifest 非法 |
| `onDesktop` | — | boolean | `true` | 是否在桌面显示图标 |
| `inStartMenu` | — | boolean | `true` | 是否进开始菜单 |
| `minHostVersion` | — | string | `null` | 声明最低宿主版本（v1 服务端只透传、不拦截） |

以下字段会被**拒绝**（manifest 非法）：

- `server`、`main`：v1 插件不能自带后端代码，只能是静态资源。
- 未知权限（例如把 `fs.read` 写成 `files.read`）：宁可安装时报错，也不让插件「装上了但什么都不工作」。
- `entry` / `icon` 里的绝对路径、盘符、`.`、`..` 路径段。

---

## 3. 权限

| 权限 | 允许做的事 | 限制 / 真实风险 |
| --- | --- | --- |
| `storage` | 读写自己的私有数据（`storage.get/set`，落 `<PLUGIN_DATA_DIR>/<id>.json`） | 序列化后上限 **1MB**，超出返回 413；插件之间互相不可见（每个 id 一份文件） |
| `fs.read` | 列目录、读文本文件（`fs.list` / `fs.readText`），范围是服务端配置的 `FILE_ROOT` | **单用户自托管下，Linux 默认 `FILE_ROOT=/`，等于整个磁盘可读**。这是声明式约束，不是沙箱 |
| `fs.write` | 写文本文件（`fs.writeText`），范围同样是 `FILE_ROOT` | 同上：服务进程权限内可写的位置都能写（含覆盖你自己的文件） |
| `clipboard.write` | 往系统剪贴板写文本（`clipboard.writeText`） | 只能写、不能读；写入发生在用户的操作上下文里 |
| `notify` | 弹一条桌面通知（`notify`） | 不能读通知、不能交互，只是单向提示 |

明确**不支持**的能力（v1 没有对应权限）：

- 插件自建后端 / 监听端口 / 注册路由 —— manifest 不接受 `server`/`main`。
- 终端（PTY）、执行命令、起子进程。
- 读剪贴板、读 cookie / 登录态、读写 `db.json`、访问别的插件的存储。
- 读任意二进制文件（`fs.readText` 是文本接口，内容按 UTF-8 返回）。

---

## 4. HTTP API

除 `GET /pa/...` 与 `GET /plugin-sdk/...` 外，全部要求登录（会话 cookie），未登录返回 **401**。
错误统一返回 `{ "error": "中文说明", "code": "可选机器码" }`。

| 方法 | 路径 | 说明 | 主要错误 |
| --- | --- | --- | --- |
| GET | `/api/plugins` | `{plugins:[...], invalid:[{dir,error}]}`。坏掉的插件目录**不会**让整个接口 500，只进 `invalid` | — |
| GET | `/api/plugins/:id` | 单个插件对象（字段同列表项） | 404 `plugin_not_found`；400（该目录 manifest 非法，原因见 error） |
| GET | `/api/plugins/:id/storage` | `{data}`，无数据时 `data: null` | 404 / 403 `permission_denied` |
| PUT | `/api/plugins/:id/storage` | body `{data}`，返回 `{ok:true,size}`；tmp+fsync+rename 原子写 | 404 / 403 / **413** `payload_too_large` / 400 `invalid_data` |
| POST | `/api/plugins/install?overwrite=1` | body 为 zip **原始字节**（`Content-Type: application/zip`，≤ 8MB），返回新插件对象 | 400（zip 非法 / manifest 非法 / 缺 entry）/ **409** `plugin_exists` / 413（body 超 8MB） |
| DELETE | `/api/plugins/:id` | 删插件目录 + `<PLUGIN_DATA_DIR>/<id>.json`，返回 `{ok:true}`（幂等） | 400（id 非法） |

插件对象（列表项 / 详情 / 安装返回值同构）：

```json
{
  "id": "hello",
  "name": "你好 CloudNine",
  "version": "1.0.0",
  "description": "示例插件",
  "author": "CloudNine",
  "permissions": ["storage"],
  "window": { "width": 720, "height": 540, "minWidth": 420, "minHeight": 320, "multi": true },
  "entryUrl": "/pa/3f2a…/hello/index.html",
  "iconUrl": "/pa/3f2a…/hello/icon.svg",
  "onDesktop": true,
  "inStartMenu": true
}
```

`entryUrl` / `iconUrl` **由服务端拼好**，前端不要自己拼 `/pa` 的 token。

v1 **没有** enable / disable：装了就在，卸载就删。

---

## 5. 静态资源与 `/pa` token

```
GET /pa/<token>/<id>/<relpath>
```

- **不需要登录**。插件页面跑在 `<iframe sandbox>` 里（opaque origin），它自己的 css/js/图片请求跨源且不带 cookie；加鉴权的结果是插件永远白屏。
- `token = HMAC-SHA256(serverSecret, id)` 的前 32 位 hex。`serverSecret` 存在 `<DATA_DIR>/asset-secret`（0600），重启后不变。
- token 不匹配 → **404**（不区分「没有这个插件」和「token 错」，不给探测器信息）。
- `relpath` 经 `safeJoin` 校验，穿越返回 **400**；目标必须是**文件**，目录请求 404（`/pa` 不是文件浏览器）。
- 响应头固定带：`X-Content-Type-Options: nosniff`、`Cache-Control: no-cache`、`Content-Security-Policy: sandbox allow-scripts allow-forms`。
  最后一条是纵深防御：就算有人把这个 URL 直接贴到地址栏，页面也是沙箱化的（没有同源、没有 cookie），顺手也就没法调宿主的接口。
- MIME 由扩展名决定（`mime-types`），未知类型按 `application/octet-stream`。

SDK 文件：

```
GET /plugin-sdk/v1/cloudnine.js     # 公开，Content-Type: application/javascript，Cache-Control: max-age=300
```

---

## 6. SDK 与通信协议

插件页面只需一行：

```html
<script src="/plugin-sdk/v1/cloudnine.js"></script>
```

它挂出 `window.cloudnine`（IIFE，无构建、无外部依赖，不 eval）。

### 6.1 协议

| 方向 | 消息 |
| --- | --- |
| host → iframe | `{type:'cn:init', v:1, pluginId, theme:{'--accent':'#0a7cff',…}, locale:'zh-CN'}` |
| iframe → host | `{type:'cn:ready', v:1}` |
| iframe → host | `{type:'cn:call', id, method, params}` |
| host → iframe | `{type:'cn:result', id, ok:true, value}` / `{type:'cn:result', id, ok:false, error:{code,message}}` |
| host → iframe | `{type:'cn:event', name:'focus'\|'blur'\|'resize', payload}`（可选，驱动 `cloudnine.on`） |
| host → iframe | `{type:'cn:theme', theme:{…}}`（可选，主题切换时增量更新） |

规则：

- SDK 在收到 `cn:init` 之前**不发起任何调用**；3 秒内没收到 init 的调用直接以 `NOT_READY` 拒绝。
- 收到 init 后把 `theme` 逐项 `document.documentElement.style.setProperty(k, v)` 注入，然后回 `cn:ready`。
- 每次调用 8 秒超时 → `TIMEOUT`；host 返回的错误原样变成带 `code` 的 `Error`。

### 6.2 宿主侧必须实现的方法

| method | params | 返回 `value` |
| --- | --- | --- |
| `storage.get` | — | `{data}`（服务端原样；SDK 会帮你取出 `data`） |
| `storage.set` | `{data}` | `{ok:true, size}` |
| `fs.list` | `{path}` | 宿主自定义（建议 `{entries:[{name,dir,size,mtime}]}`） |
| `fs.readText` | `{path}` | `{text}` 或字符串 |
| `fs.writeText` | `{path,text}` | `{ok:true}` |
| `clipboard.writeText` | `{text}` | `{ok:true}` |
| `notify` | `{title, body}` | `{ok:true}` |
| `ui.setTitle` | `{title}` | `{ok:true}` |
| `ui.close` | — | `{ok:true}` |

错误码约定：`NOT_READY`、`TIMEOUT`、`INVALID_ARGUMENT`、`PERMISSION_DENIED`、`FS_NOT_FOUND`、`INTERNAL`（宿主也可自定义）。

### 6.3 插件里怎么写

```html
<script src="/plugin-sdk/v1/cloudnine.js"></script>
<script>
(async () => {
  await cloudnine.ready();                       // 等宿主注入主题
  document.body.style.background = 'var(--panel-bg)';

  const state = (await cloudnine.storage.get()) || { count: 0 };
  const btn = document.querySelector('#hit');
  btn.onclick = async () => {
    state.count += 1;
    await cloudnine.storage.set(state);          // 落 <PLUGIN_DATA_DIR>/<id>.json
    btn.textContent = `点了 ${state.count} 次`;
  };

  cloudnine.on('resize', () => console.log('窗口大小变了'));
  await cloudnine.notify('就绪', '示例插件已加载');   // 需要 notify 权限
})();
</script>
```

完整可运行的例子见 [`examples/plugins/hello/`](../examples/plugins/hello/)（主题色块 + storage 持久化的点击计数）。

---

## 7. 打包与上传

zip 结构两种都支持：

```
hello.zip                        hello.zip
├── plugin.json                  └── hello/
├── index.html                       ├── plugin.json
└── icon.svg                         ├── index.html
                                     └── icon.svg
```

上传：

```bash
curl -b cookie.txt -X POST 'http://127.0.0.1:8480/api/plugins/install' \
     -H 'Content-Type: application/zip' --data-binary @hello.zip
# 覆盖已装版本：
curl -b cookie.txt -X POST 'http://127.0.0.1:8480/api/plugins/install?overwrite=1' \
     -H 'Content-Type: application/zip' --data-binary @hello.zip
```

服务端会拒绝的 zip：

- 含 `..` 段、绝对路径、盘符；含符号链接。
- 条目数 > 200，或解压后总量 > 32MB（按**实际写出的字节数**再卡一次，防 zip 炸弹）。
- 找不到 `plugin.json`（既不在根目录，也不是「唯一顶层目录里有」）。
- manifest 不合法，或 `entry` 指向的文件不存在。
- 目标 id 已存在且没带 `?overwrite=1` → 409。
- 请求体 > 8MB → 413。

安装流程是「解到 `PLUGINS_DIR/.install-<随机>/` → 校验 → 同分区 `rename` 到 `PLUGINS_DIR/<id>`」，所以失败不会留下半个插件目录；
`?overwrite=1` 会先删旧目录再换新（这一步不是原子的，覆盖安装期间插件窗口刷新会短暂 404）。

---

## 8. 桌面图标与开始菜单（外壳渲染约定）

服务端**只提供数据**：`GET /api/plugins` 返回每个插件的 `entryUrl` / `iconUrl` / `onDesktop` / `inStartMenu` / `window`。
图标格子、开始菜单条目、任务栏按钮都由**外壳（前端）渲染**，服务端不生成任何 HTML 列表页。

外壳需要做的事：

1. 用 `onDesktop` / `inStartMenu` 决定放在哪里，`iconUrl` 当图标（懒加载，失败回退到内置的通用插件图标）。
2. 打开窗口时用 `window` 里的尺寸做初始值，`multi` 决定是否允许同 id 多开。
3. `<iframe sandbox="allow-scripts allow-forms" src={entryUrl}>` —— **不要加 `allow-same-origin`**，否则插件就能拿到宿主的 cookie 和 DOM。
4. 由外壳负责 `cn:init` / `cn:call` / `cn:result` 的收发与权限判断（没有 `storage` 权限的插件调 `storage.*` 应回 `PERMISSION_DENIED`）。
5. 卸载插件：`DELETE /api/plugins/:id`，然后从桌面/开始菜单移除并关掉它的窗口。

---

## 9. 自测

```bash
# 临时目录起一个独立实例（别碰真实的 server/data）
DATA_DIR=/tmp/cn-plugins PLUGINS_DIR=/tmp/cn-plugins/plugins \
PLUGIN_DATA_DIR=/tmp/cn-plugins/plugin-data PORT=8499 node server/src/index.js

# 初始化账号
curl -c /tmp/cn.txt -X POST http://127.0.0.1:8499/api/init \
     -H 'Content-Type: application/json' -d '{"username":"tester","password":"test1234"}'

# 全链路冒烟（401 / 列表 / 安装 / CSP / 穿越 / storage / 413 / 409 / 卸载 / SDK）
python scripts/plugins_smoke.py --url http://127.0.0.1:8499 --plugins-dir /tmp/cn-plugins/plugins
```
