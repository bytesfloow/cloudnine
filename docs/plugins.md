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
  "fileTypes": [".json", ".jsonc"],
  "defaultFor": [".json"],
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
| `fileTypes` | — | string[] | `[]` | 能打开的扩展名，进「打开方式 ▸」；规则见 §2.1 |
| `defaultFor` | — | string[] | `[]` | 双击时优先用我打开的扩展名（必须是 `fileTypes` 的子集）；规则见 §2.1 |

以下字段会被**拒绝**（manifest 非法）：

- `server`、`main`：v1 插件不能自带后端代码，只能是静态资源。
- 未知权限（例如把 `fs.read` 写成 `files.read`）：宁可安装时报错，也不让插件「装上了但什么都不工作」。
- `entry` / `icon` 里的绝对路径、盘符、`.`、`..` 路径段。
- `fileTypes` / `defaultFor` 的取值不合法（见 §2.1），或 `defaultFor` 里有 `fileTypes` 没声明的扩展名。

### 2.1 文件关联：`fileTypes` 与 `defaultFor`

这两个字段让插件能「双击文件直接用」，而不是只能从图标 / 开始菜单启动。

**取值规则（两个字段相同）**

| 规则 | 说明 |
| --- | --- |
| 必须是数组 | 写成一个字符串（`"fileTypes": ".json"`）算 manifest 非法 |
| 元素必须带点 | `.json` ✅ / `json` ❌ / `.` ❌ |
| 字符集 | 点之后只允许字母数字与 `-` `_` `+`：`.json` `.tsx` `.tar-gz` ✅ / `.js on` ❌ |
| 长度 | 整串 ≤ **16** 字符（含点） |
| 数量 | ≤ **10** 项 |
| 大小写 | 统一转小写后比较，写 `.JSON` 也行，服务端返回的是 `.json` |
| 多段扩展名 | **不支持** `.tar.gz` 这种。前端按「最后一个点之后」取扩展名，声明多段只会永远匹配不上 |
| 重复项 | 自动去重 |

**`defaultFor` 的额外约束**：里面的每个扩展名都必须先出现在 `fileTypes` 里，否则 manifest 非法 ——
避免出现「双击时号称默认，但打开方式里找不到我」这种自相矛盾的声明。

**双击一个文件时的完整流转（外壳侧）**

> 桌面图标、**文件资源管理器窗口内**、「最近」列表三处双击走的是**同一个函数**
> （`client/src/fsops.js` 的 `openWithDefault()`）—— 行为只写一份，不会两处不一致。

1. 取文件名最后一个点之后的部分当扩展名（小写）。无扩展名的文件（`Makefile`）不参与文件关联。
2. 在已安装插件里找**所有** `fileTypes` 含该扩展名的插件：
   - **一个都没有** → 保持原有内置行为（文本走编辑器，图片/PDF/Office 等走预览），不弹任何选择框。
   - **有** → 再从中筛 `defaultFor` 含该扩展名的：
     - **恰好一个** → 直接打开这个插件的窗口，不再开内置程序、不弹选择框。
     - **一个都没有 / 有多个（冲突）** → 弹「打开方式」选择器：第一项是内置程序（**默认选中**，
       直接回车/点「打开」就是改造前那个行为），后面是每个候选插件；取消则什么都不打开。
3. 打开插件窗口时宿主传 `{pluginId, fileRel}`；插件在 `cn:init` 里收到 `file: {rel, name, ext}`，
   自己用 `cloudnine.fs.readText(file.rel)` 读内容、`fs.writeText` 写回（**需要相应权限**，见 §3）。
4. 同一插件 + 同一文件已经开着 → 只聚焦已有窗口，不叠第二个；打开**另一个**文件是新窗口。

**冲突规则（一句话）**：同一扩展名被多个插件声明 `defaultFor` 时**没有默认程序**：
双击不直接进任何插件，而是弹「打开方式」选择器（内置项默认选中），由用户当场决定；
右键「打开方式 ▸」里这些插件也全部列着。宿主不会随机挑一个，也不会静默把文件交给某个插件。

**旧插件兼容**：没有 `fileTypes` 的旧 manifest 照常加载，服务端把两个字段补成 `[]`，
插件不会出现在「打开方式」里，也不会参与双击选择器，双击行为与改造前完全一致。
`fileTypes` 为空数组的插件同样不出现。

**外壳兼容**：「打开方式」的候选只在 `client/src/fsops.js` 的 `openWithItems()` 里拼一次，
桌面图标右键与文件资源管理器条目右键共用同一份；双击则统一走 `openWithDefault()`，
两处的默认程序判断也不会分叉。

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
  "inStartMenu": true,
  "fileTypes": [".json", ".jsonc"],
  "defaultFor": [".json"]
}
```

`fileTypes` / `defaultFor` 总是数组（旧插件也会被补成 `[]`，前端不用判 `undefined`）。
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
| host → iframe | `{type:'cn:init', v:1, pluginId, theme:{'--accent':'#0a7cff',…}, locale:'zh-CN', file}` |
| iframe → host | `{type:'cn:ready', v:1}` |
| iframe → host | `{type:'cn:call', id, method, params}` |
| host → iframe | `{type:'cn:result', id, ok:true, value}` / `{type:'cn:result', id, ok:false, error:{code,message}}` |
| host → iframe | `{type:'cn:event', name:'focus'\|'blur'\|'resize', payload}`（可选，驱动 `cloudnine.on`） |
| host → iframe | `{type:'cn:theme', theme:{…}}`（可选，主题切换时增量更新） |

规则：

- SDK 在收到 `cn:init` 之前**不发起任何调用**；3 秒内没收到 init 的调用直接以 `NOT_READY` 拒绝。
- 收到 init 后把 `theme` 逐项 `document.documentElement.style.setProperty(k, v)` 注入，然后回 `cn:ready`。
- `cn:init.file` 是 `{rel, name, ext}` 或 `null`（§6.6）。`ext` 带点且小写（`.json`），无扩展名时为 `''`。
- 每次调用 8 秒超时 → `TIMEOUT`；host 返回的错误原样变成带 `code` 的 `Error`。

### 6.2 宿主侧必须实现的方法

| method | params | 返回 `value` |
| --- | --- | --- |
| `storage.get` | — | `{data}`（服务端原样；SDK 会帮你取出 `data`） |
| `storage.set` | `{data}` | `{ok:true, size}` |
| `fs.list` | `{path}` | `{entries:[{name, dir, size, mtime}]}`：`dir` 是布尔（服务端 `type === 'dir'`）、`size` 字节、`mtime` = 服务端的 `mtimeMs`。宿主是拿 `GET /api/fs/list?path=` 自己拼的，那个接口实际返回 `{path, entries:[{name, type, size, mtimeMs, birthtimeMs, atimeMs, mode, modeStr, uid, gid, hidden, target}], free, total}`，`type` 取 `file` / `dir` / `symlink` / `broken`（**不是** `{dir, size, mtime}`，别把两个形状记混） |
| `fs.readText` | `{path}` | `{text}` 或字符串 |
| `fs.writeText` | `{path,text}` | `{ok:true}` |
| `clipboard.writeText` | `{text}` | `{ok:true}` |
| `notify` | `{title, body}` | `{ok:true}` |
| `ui.setTitle` | `{title}` | `{ok:true}` |
| `ui.markDirty` | `{dirty:boolean}` | `{ok:true, dirty}`；脏状态下点 X / 刷新页面都会被拦（§6.6） |
| `ui.close` | — | `{ok:true}`；**窗口处于脏状态时返回错误 `UNSAVED_CHANGES`**，宿主不替用户丢数据 |

错误码约定：`NOT_READY`、`TIMEOUT`、`INVALID_ARGUMENT`、`PERMISSION_DENIED`、`FS_NOT_FOUND`、`INTERNAL`（宿主也可自定义）。
宿主自己在「脏状态下 `ui.close`」这一条上返回 `UNSAVED_CHANGES`。

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

完整可运行的例子见 [`examples/plugins/hello/`](../examples/plugins/hello/)（主题色块 + storage 持久化的点击计数），
真正能用的小应用见 [`examples/plugins/todo/`](../examples/plugins/todo/)（待办清单：增删改查 + 筛选 + 明暗跟随 + 键盘与窄宽度），
文件关联的最小例子见 [`examples/plugins/filelink-probe/`](../examples/plugins/filelink-probe/)（§6.6）。

### 6.4 写一个自己的插件（最小可用 4 步）

1. **建目录 + manifest**：`examples/plugins/mine/plugin.json`，`id` 必须和目录名一致，
   按需声明 `permissions`（只读写自己的数据就写 `["storage"]`），`entry` 默认 `index.html`。
2. **写入口页**：`index.html` 里 `<script src="/plugin-sdk/v1/cloudnine.js"></script>`，
   再做三件事 —— `await cloudnine.ready()` 等宿主注入主题、把颜色全写成 `var(--accent)` / `var(--panel-bg)` 这类令牌
   （不要写死颜色，否则暗色主题下会瞎）、用 `cloudnine.ui.close()` / `ui.setTitle()` 接宿主窗口。
3. **持久化**：`cloudnine.storage.get()` / `set(data)`，数据落 `<PLUGIN_DATA_DIR>/<id>.json`，序列化后上限 1MB。
   结构自己定，但要向后兼容：老数据里多出来的字段别直接丢，读的时候按字段名宽容解析。
4. **装进去看效果**：`node scripts/plugin-dev-install.mjs mine`，然后刷新浏览器（见 §6.5）。

对照 `examples/plugins/todo/` 看这四步在真实应用里的样子：输入框 + 列表 + 筛选 + 空状态 + 键盘操作 + 窄宽度布局，
全部在一个 HTML 文件里（内联 CSS/JS，不引 CDN），持久化就是每次改动后 `storage.set` 整个 JSON。

### 6.5 开发期安装（不打包也能迭代）

```bash
node scripts/plugin-dev-install.mjs todo            # 安装 / 覆盖安装
node scripts/plugin-dev-install.mjs todo --remove    # 从插件目录删掉
node scripts/plugin-dev-install.mjs --list           # 列出示例插件与安装状态
node scripts/plugin-dev-install.mjs todo --dir /tmp/cn-plugins   # 指到别的插件目录
```

- 目标 `PLUGINS_DIR` 的解析规则与服务端 `server/src/config.js` 一致：
  `PLUGINS_DIR` 环境变量 > `server/config.json` 的 `pluginsDir` > `<DATA_DIR>/plugins`；`--dir` 直接覆盖。
- 它只是把 `examples/plugins/<name>/` **递归复制**成 `<PLUGINS_DIR>/<id>/`，落盘布局与 zip 安装后完全一致
  （先删旧目录再复制，所以删掉的文件不会残留）。
- 不碰插件私有数据（`<PLUGIN_DATA_DIR>/<id>.json`）：反复安装同一插件不会丢你的待办 / 计数。
- 装完刷新浏览器：插件列表只在登录时拉一次（§8 第 6 条），不刷新看不到新图标。

### 6.6 文件关联与「未保存保护」

声明了 `fileTypes` 之后，双击对应类型的文件就会打开你的插件（规则、选择器与冲突见 §2.1）。
宿主**不会**把文件内容塞进消息里，只告诉你「打开的是哪个文件」：

```js
const file = cloudnine.file;          // {rel, name, ext} 或 null
if (file) {
  // 需要 fs.read 权限；rel 是相对 FILE_ROOT 的路径，与 fs.* 接口同一口径
  const r = await cloudnine.fs.readText(file.rel);
  render(r.text);
}
```

- 从桌面图标 / 开始菜单启动时 `cloudnine.file` 是 `null` —— 两条入口共用同一个页面，两种都得处理。
- 写回就用 `cloudnine.fs.writeText(file.rel, text)`（需要 `fs.write`）。v1 不新增任何文件类方法，
  `fs.writeText` 带 `force`，宿主不做「外部已修改」冲突检测。
- `file.ext` 带点且小写（`.json`），无扩展名时为 `''`；`file.name` 只是文件名，不包含目录。

未保存保护：

```js
await cloudnine.ui.markDirty(true);   // 标题前出现 *，点 X / 刷新页面会先问一句
await cloudnine.ui.markDirty(false);  // 已保存（或用户确认放弃）后调回来
```

宿主行为（脏表与确认在 `client/src/store.js`，标题星号在 `client/src/desktop/WindowFrame.jsx`）：

- **标题**：脏时渲染成 `*<标题>`，自动化测试据此判断脏状态。
- **任何关闭入口都会先问一句**：点 X、任务栏窗口按钮右键的「关闭窗口」、其它任何走 `closeWindow` 的地方
  都读同一张脏表（`store.js` 的 `dirtyWindows`），所以行为一致；取消 = 什么都不做，窗口与脏标记原样留着。
- **刷新 / 关标签（`beforeunload`）**：只要有**任意**窗口脏着就拦一次。浏览器本身只会弹一个原生确认框，
  所以多个脏窗口也只会问一次 —— 不会出现「一刷新弹好几个框」。
- **脏状态下 `ui.close`** 返回 `UNSAVED_CHANGES`：宿主不替用户丢数据。插件想自己关窗，
  先保存再 `markDirty(false)`，然后 `ui.close()`。
- 窗口被关掉 / 卸载时脏标记自动清掉，不会让后续刷新一直被拦。
- 宿主只负责「拦一下 + 问一句」；保存 / 放弃的具体流程完全由插件自己实现（v1 没有宿主级保存钩子）。

> 参考实现：[`examples/plugins/filelink-probe/`](../examples/plugins/filelink-probe/)（`fileTypes: [".json"]` +
> `defaultFor: [".json"]`，演示读 `file.rel`、标脏与 `ui.close` 被拒的完整状态机）。
> 端到端验收：`node scripts/uitest-openwith.mjs`。

---

## 7. 打包与上传

> 迭代阶段不必每次都打包 zip，用 §6.5 的开发期安装脚本即可；分发 / 上传到别的实例再看下面。

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

服务端**只提供数据**：`GET /api/plugins` 返回每个插件的 `entryUrl` / `iconUrl` / `onDesktop` / `inStartMenu` / `window` /
`fileTypes` / `defaultFor`。图标格子、开始菜单条目、任务栏按钮、「打开方式」候选都由**外壳（前端）渲染**，
服务端不生成任何 HTML 列表页。

外壳需要做的事：

1. 用 `onDesktop` / `inStartMenu` 决定放在哪里，`iconUrl` 当图标（懒加载，失败回退到内置的通用插件图标）。
   桌面图标是**虚拟应用图标**：排在系统图标之后、文件图标之前，不可拖拽 / 重命名 / 框选 / 删除，
   右键只有「打开」「从桌面移除」（移除只进 localStorage 名单），完整规则见 `docs/win11-interaction-spec.md` §1.7。
2. 打开窗口时用 `window` 里的尺寸做初始值，`multi` 决定是否允许同 id 多开。
3. `<iframe sandbox="allow-scripts allow-forms" src={entryUrl}>` —— **不要加 `allow-same-origin`**，否则插件就能拿到宿主的 cookie 和 DOM。
4. 由外壳负责 `cn:init` / `cn:call` / `cn:result` 的收发与权限判断（没有 `storage` 权限的插件调 `storage.*` 应回 `PERMISSION_DENIED`）。
5. 卸载插件：`DELETE /api/plugins/:id`，然后从桌面/开始菜单移除并关掉它的窗口。
6. **插件列表只在登录时拉一次**：外壳启动 / 登录后调一次 `GET /api/plugins`，结果挂在内存里。
   装、卸、覆盖安装之后**必须刷新页面**，桌面图标 / 开始菜单 / 任务栏才会更新；v1 没有轮询也没有服务端推送，
   不要指望 `DELETE` 的返回值能就地改外壳状态。
7. 文件关联：按 `fileTypes` 往「打开方式」里追加候选项（只有声明了 `fileTypes` 的插件才追加），
   双击文件统一走 `fsops.openWithDefault()`（桌面 / 文件管理器窗口内 /「最近」同一份）：
   唯一 `defaultFor` → 直接进插件；有候选但无默认 → 弹「打开方式」选择器（内置默认选中）；无候选 → 内置行为。
8. 脏窗口：`ui.markDirty(true)` 后窗口标题前加 `*`；关闭（任何入口）与 `beforeunload` 都统一由
   `closeWindow` / 页面级监听确认一次（§6.6）。

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

浏览器端（自己起临时环境 + 跑完清理，需 `puppeteer-core` + 本机 Chrome）：

```bash
node scripts/uitest-plugins.mjs    # 外壳接入：图标 / 开窗 / 沙箱 / 主题注入 / 协议 / 错误码
node scripts/uitest-todo.mjs       # 示例插件 todo 的端到端验收（含重启服务后的持久化、亮暗主题、窄宽度）
node scripts/uitest-openwith.mjs   # 文件关联：打开方式 / defaultFor / file.rel / ui.markDirty / beforeunload
```

三个脚本都支持 `--chrome`、`--port`、`--url`、`--keep`，默认不碰仓库里正在跑的实例。
