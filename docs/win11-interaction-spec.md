# CloudNine · Windows 11 交互规格与动作归属对照表

> 阶段 0 交付物（T1）。后续所有改造任务的施工依据与验收标准。
>
> **基线**：分支 `feat/win11-shell`，起点为 `main@9fd928a`。
> **行号约定**：下文行号均指阶段 0 完成后的 `feat/win11-shell` 分支上的文件状态
> （此时 `styles.css` 已按模块拆到 `client/src/styles/`，`Finder.jsx` 已拆出
> `client/src/windows/finder/*`，但**外壳与交互一行未改**）。
>
> 若 T2 拆分被回退：`Finder.jsx` 的行号统一 **-4**
> （`act()` 122→118、`itemMenu` 322→318、`blankMenu` 353→349、`sortMenu` 378→374），
> 其余文件不受影响。
>
> **本文档的立场**：顶部菜单栏不是装饰，是功能入口。拆掉它之前，`MenuBar.jsx`
> 的每一条 `action`、`DesktopIcons.jsx` 的每一个右键项、`Finder.jsx` 的每一个
> `act()` 分支，都必须在新的外壳上有明确落点。**不允许静默丢失任何功能**。

---

## 0. 已锁定的产品决策（不可自行更改）

| # | 决策 |
|---|---|
| 1 | 完整 Win11 外壳：**底部任务栏 + 开始菜单**，顶部全局菜单栏彻底移除 |
| 2 | 交互 + 视觉 + 暗色主题一起重做 |
| 3 | macOS 独有交互全部移除：空格 QuickLook、底部 Dock、焦点应用全局菜单、`⌘` 快捷键语义 |
| 4 | 移动端（`mobile/MobileApp.jsx`、`mobile/HomeScreen.jsx`）**交互不动**，只同步改名文案 |
| 5 | 登录页、初始化向导、分享落地页（`auth/Login.jsx`、`auth/InitWizard.jsx`、`share/ShareApp.jsx`）一起 Fluent 化 |
| 6 | **纯色材质**，不做 Mica/Acrylic 半透明（保证任何环境和截图都稳定） |

**不动的部分**：`server/` 全部代码、API 契约、`scripts/` 部署脚本。

---

## 1. 新外壳的信息架构

### 1.1 整体结构

```
┌──────────────────────────────────────────────────────────────┐
│  桌面工作区（壁纸 + 桌面图标），顶部不再有菜单栏               │
│                                                              │
│   ┌─ 窗口（标题栏 39px + 内容区）──────────────────────────┐  │
│   │  文件资源管理器 / 终端 / 记事本 / 预览 / 传输 …        │  │
│   └────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│ [开始] [搜索] [文件] [终端] …  │窗口按钮…│  [托盘: 传输 磁盘 通知 时钟 账户] │
└──────────────────────────────────────────────────────────────┘
```

- 顶部 `--menubar-h` 归零；桌面图标区从 `top: 0` 开始。
- 底部为通栏任务栏，高度 40px（占位变量 `--taskbar-h`，阶段 3 可调）。
- 弹层层级重新分配：任务栏 / 开始菜单 / 右键菜单 / 对话框 / 通知 在现有
  z-index（10000 / 10001 / 12000 / 15000 / 16000）基础上顺延，**开始菜单必须高于任务栏**。
  > 阶段 3 · T13 修订：通知 toast 改到视口右下角后，层级取 **9990（低于任务栏）**。
  > 理由：任务栏托盘弹层（磁盘/通知/时钟/账户）会从任务栏向上弹，与 toast 区域重叠；
  > toast 压在上面会拦住弹层里的条目。低于任务栏后弹层永远盖住 toast、每一项都可点，
  > 对话框（15000）与右键菜单（12000）仍在 toast 之上。toast 本身距底 ≥ `--taskbar-h + 12px`，
  > 不会真的被任务栏遮住。

### 1.2 任务栏（Taskbar）分区

| 区 | 内容 | 行为 |
|---|---|---|
| 开始按钮 | Windows 徽标 | 单击开/关开始菜单；`Esc`、再次单击、点击别处关闭 |
| 搜索框（可选） | 输入即过滤开始菜单的应用与命令 | 阶段 1 先做成"点开开始菜单并聚焦其搜索框"，不单独实现全局搜索 |
| 固定应用 | 文件资源管理器、终端、记事本、传输（默认 4 个） | 单击：无窗口 → 新建；有窗口 → 切到最上层；再点 → 最小化 |
| 运行中窗口按钮 | **每个窗口一个按钮**（`s.windows` 逐个渲染，按 `w.title` 显示） | 单击切换 最上层 ↔ 最小化；右键 = 跳转列表（还原/最小化/最大化/关闭）；悬停 = 标题缩略浮层 |
| 托盘 · 传输 | 进行中的上传数徽标 | 点击打开「传输」窗口（现 `MenuBar.jsx:165-169`） |
| 托盘 · 磁盘 | 最紧张挂载点的占用百分比 | 点击弹面板列挂载点，点某行打开「磁盘监控」（现 `MenuBar.jsx:164, 178-203`） |
| 托盘 · 通知 | 铃铛 + 未读点 | 点击弹通知列表，可点击项执行 `activateNotification`（现 `MenuBar.jsx:170, 205-227`） |
| 托盘 · 时钟 | 日期 + 时间（`toLocaleString('zh-CN')`） | 点击弹通知中心（阶段 2 可与通知面板合并） |
| 托盘 · 账户 | 首字母头像 | 点击弹账户菜单：修改密码 / 浅色·深色·跟随系统 / 退出登录（现 `MenuBar.jsx:171, 229-253`） |

**拖放目标**（保留现状语义）：拖系统文件到「传输」按钮 = 上传到主目录
（`Dock.jsx:29-39` 现行为）；拖到「回收站」不接收（现状亦如此）。

### 1.3 开始菜单结构

```
┌─────────────────────────────────────────────┐
│ 🔍 搜索应用、命令…                          │
├─────────────────────────────────────────────┤
│ 已固定                                      │
│  文件资源管理器  终端      记事本   预览     │
│  传输           分享管理  磁盘监控 回收站    │
├─────────────────────────────────────────────┤
│ 推荐 / 最近使用的文件（api.recents()）      │
├─────────────────────────────────────────────┤
│ 全部应用                              ›     │
├─────────────────────────────────────────────┤
│ [头像] 用户名            [设置] [关于] [电源]│
└─────────────────────────────────────────────┘
```

- **应用清单**：与现 Dock 的 7 项一一对应，不增不减
  （`Dock.jsx:7-13`：文件 / 终端 / 文本编辑 / 传输 / 分享管理 / 磁盘监控 / 废纸篓）。
  另加「预览」——它现在没有独立入口，只能由文件双击间接打开，属于可选补全，不算功能丢失。
- **底部账户区**：`改密码`、`主题`（3 项）、`退出登录`、`关于本系统`。
- **电源按钮**：本系统无"关机"概念，映射为「锁定」（回到登录页）。

### 1.4 资源管理器（文件窗口）结构

窗口内自上而下：**地址栏 + 命令栏 → 侧栏 + 内容区 → 状态栏**。

```
┌ [←] [→] [↑]  🏠 › 用户 › docs                    [搜索框] ┐   ← 地址栏
├ [新建 ▸] [上传文件] [上传文件夹] │ [剪切] [复制] [粘贴] │ [删除] [重命名] │ [排序 ▸] [查看 ▸] ┤  ← 命令栏
├──────────┬──────────────────────────────────────────────┤
│ 快速访问  │                                              │
│  主目录   │              图标 / 列表视图                  │
│  文件根目录│                                             │
│  最近     │                                              │
│  回收站   │                                              │
├──────────┴──────────────────────────────────────────────┤
│ 12 个项目   已选择 2 项                    可用 42.1 GB  │  ← 状态栏
└─────────────────────────────────────────────────────────┘
```

- **命令栏分组**（Win11 Explorer 的五组结构）：
  1. `新建 ▸`（文件夹 / 文本文档）
  2. `上传文件…` `上传文件夹…`
  3. 剪贴板：`剪切` `复制` `粘贴` `粘贴为副本`
  4. `重命名` `删除`
  5. `排序 ▸` `查看 ▸`
- 现命令栏的独立 `⇅` 排序按钮与「图标/列表」两个按钮**收进下拉**，不再平铺。
- 搜索框保留（回车递归搜索），**必须保留 `.finder-search input` 这个选择器**，
  否则 `act('focus-search')`（`Finder.jsx:143`）的 DOM 查询会静默失效。

### 1.5 右键菜单层级

`ContextMenu.jsx` 目前只支持扁平 `items`（字符串 `'-'` 作分隔符，`{label, action, disabled, checked, danger}`）。
Win11 必须有子菜单，阶段 2 需扩展为：

```js
{ label: '新建', items: [ ... ] }          // 有 items 即子菜单
```

要求：子项悬浮展开、`Escape` 逐级关闭、键盘 `↑↓`/`→`/`←` 可导航、
屏幕右/下边缘自动翻转（现 `ContextMenu.jsx:14-18` 的定位只在挂载时算一次，
子菜单展开后不会重新收敛，需要一并处理）。

**桌面空白处**

```
查看 ▸            大图标 / 中等图标（默认）/ 小图标
排序方式 ▸        名称 / 大小 / 修改时间 / 类型 · 升序 / 降序 · 文件夹优先
刷新              F5
─────────────────────────────
粘贴               Ctrl+V（内部剪贴板为空时禁用）
新建 ▸            文件夹 / 文本文档
上传文件…  /  上传文件夹…
─────────────────────────────
剪贴板 ▸          复制 N 项 / 剪切 N 项 / 清空剪贴板
在终端中打开
```

**桌面图标 / 资源管理器条目**

```
打开                     Enter
打开方式 ▸               用编辑器打开 / 用预览打开 / 在终端中打开（目录）
预览                     Alt+P（阶段 3 的预览窗格）
─────────────────────────────
剪切 / 复制 / 粘贴为副本
创建快捷方式（不实现，本系统无快捷方式概念）
删除                     Delete → 回收站
重命名                   F2
─────────────────────────────
压缩… / 解压到…
发送到 ▸                 下载 / 打包下载 / 复制路径
─────────────────────────────
分享…                    仅普通文件（shareBlockReason 决定是否禁用）
属性                     Alt+Enter → 「显示简介」窗口
```

> 注意：`发送到 ▸` 里的「下载 / 打包下载 / 复制路径」不是凭空发明的，
> 它们对应现 `itemMenu` 里平铺的 `下载`（`DesktopIcons.jsx:254`）、`打包下载`（:255）、
> `复制路径`（:261）；子菜单只是把它们收拢，不新增能力。

**回收站视图（原废纸篓窗口）**

```
打开 / 放回原处           还原
彻底删除…                 Shift+Delete
清空回收站…               Win11 里在命令栏也有按钮
刷新
```

### 1.6 终端 / 记事本 / 预览：窗口内菜单

Win11 的应用自带窗口内菜单（记事本有"文件/编辑"，Windows Terminal 有标签栏 + 下拉），
这部分**不属于外壳**，保留即可。三个窗口的菜单项原地留在窗口标题区/工具条里：

| 窗口 | 载体 | 项 |
|---|---|---|
| 终端 | 标签栏右侧 `∨` 下拉 | 新建标签页 / 关闭当前标签 / 清屏 / 重置终端 / 关闭窗口 |
| 记事本 | 标题栏下方窗口内菜单 | 文件：保存 / 另存为… / 关闭；编辑：格式化（仅 json/html）/ 查找… |
| 预览 | 底部操作条（已有） | 下载 / 复制路径；文本与 Markdown 视图另有「用编辑器打开」 |

---

## 2. 动作归属对照表

> 载体代号：
> **SM** 开始菜单 · **TB** 任务栏 · **TRAY** 任务栏托盘 ·
> **EX-CMD** 资源管理器命令栏 · **CTX** 右键菜单（`CTX/xxx` 表示子菜单）·
> **KEY** 快捷键 · **WIN-MENU** 窗口内菜单 · **WIN-UI** 窗口内已有按钮

### 2.1 `MenuBar.jsx` → `appMenus()`（L10-90）

#### 2.1.1 桌面态（无窗口获得焦点，`if (!type)` L16-47）

| 旧位置 | action | 文案 | 新载体 | 说明 |
|---|---|---|---|---|
| `MenuBar.jsx:21` | `newFolder` | 新建文件夹 | `CTX/桌面空白›新建▸` + `KEY Ctrl+Shift+N` | |
| `MenuBar.jsx:21` | `newFile` | 新建空白文件 | `CTX/桌面空白›新建▸` | 新建后直接开记事本（现状 `DesktopIcons.jsx:205-210`） |
| `MenuBar.jsx:21` | `uploadFile` | 上传文件… | `CTX/桌面空白` + `EX-CMD` | |
| `MenuBar.jsx:21` | `uploadFolder` | 上传文件夹… | `CTX/桌面空白` + `EX-CMD` | |
| `MenuBar.jsx:22` | `paste` | 粘贴 | `CTX/桌面空白` + `KEY Ctrl+V` | 剪贴板为空时禁用 |
| `MenuBar.jsx:25` | `copy` | 复制 | `CTX/图标` + `KEY Ctrl+C` | |
| `MenuBar.jsx:25` | `cut` | 剪切 | `CTX/图标` + `KEY Ctrl+X` | |
| `MenuBar.jsx:25` | `paste` | 粘贴 | 同上 | |
| `MenuBar.jsx:26` | （无 action） | `剪贴板：复制 N 项` | **删除** | 只读状态展示，不是动作；信息改由 `CTX/桌面空白›剪贴板▸` 的标题体现 |
| `MenuBar.jsx:27` | `__clearClipboard` | 清空剪贴板 | `CTX/桌面空白›剪贴板▸` | `runItem` L123 → `setClipboard(null)` |
| `MenuBar.jsx:28` | `selectAll` | 全选 | `KEY Ctrl+A` | 桌面快捷键已存在（`Desktop.jsx:32`） |
| `MenuBar.jsx:28` | `rename` | 重命名 | `KEY F2` + `CTX/图标›重命名` | |
| `MenuBar.jsx:28` | `trash` | 移入废纸篓 | `KEY Delete` + `CTX/图标›删除` | 文案改「删除（移入回收站）」 |
| `MenuBar.jsx:31` | `sort:name` | 按名称排列 | `CTX/桌面空白›排序方式▸` | 带 `checked` |
| `MenuBar.jsx:32` | `sort:size` | 按大小排列 | 同上 | |
| `MenuBar.jsx:33` | `sort:mtime` | 按修改时间排列 | 同上 | |
| `MenuBar.jsx:34` | `sort:type` | 按类型排列 | 同上 | |
| `MenuBar.jsx:36` | `toggleSortDir` | 改为降序 / 改为升序 | `CTX/排序方式▸` 的「升序 / 降序」 | 由"切换项"改为两个 `checked` 项 |
| `MenuBar.jsx:37` | `dirsFirst` | 文件夹优先 | `CTX/排序方式▸` | |
| `MenuBar.jsx:39` | `toggleHidden` | 显示隐藏文件 | `CTX/查看▸` | 桌面空白菜单现在没有「查看」，需新增该子菜单 |
| `MenuBar.jsx:40` | `refresh` | 刷新 | `KEY F5` + `CTX/桌面空白›刷新` | |
| `MenuBar.jsx:43` | `goHome` | 主目录 | `SM›文件资源管理器` | ⚠️ 桌面态下这个 action 是空实现（`DesktopIcons.jsx:377: case 'goHome': return;`），因为桌面本身就是主目录 → **废弃，不要假装搬迁** |
| `MenuBar.jsx:44` | `goRoot` | 根目录 | `EX-CMD` 侧栏「文件根目录」 | 条件显示：`homeRel` 非空时才出现（L44 / L68） |
| `MenuBar.jsx:45` | `goTrash` | 废纸篓 | `CTX/图标›打开`（回收站图标）/ `SM›回收站` | |
| `MenuBar.jsx:46` | `openTerminal` | 在终端中打开 | `CTX/桌面空白›在终端中打开` | |

#### 2.1.2 文件资源管理器窗口（`type === 'finder'` L48-70）

| 旧位置 | action | 文案 | 新载体 |
|---|---|---|---|
| `MenuBar.jsx:50` | `newFolder` | 新建文件夹 | `EX-CMD›新建▸文件夹` + `CTX/空白›新建▸` + `KEY Ctrl+Shift+N` |
| `MenuBar.jsx:50` | `newFile` | 新建空白文件 | `EX-CMD›新建▸文本文档` + `CTX/空白›新建▸` |
| `MenuBar.jsx:50` | `uploadFile` | 上传文件… | `EX-CMD` + `CTX/空白` |
| `MenuBar.jsx:50` | `uploadFolder` | 上传文件夹… | `EX-CMD` + `CTX/空白` |
| `MenuBar.jsx:51` | `openTerminal` | 在终端中打开 | `CTX/空白›在终端中打开` |
| `MenuBar.jsx:51` | `closeWin` | 关闭窗口 | `WIN-UI` 标题栏 × + `KEY Ctrl+W` + `KEY Alt+F4` + `TB` 右键›关闭 |
| `MenuBar.jsx:56` | `copy` / `cut` / `paste` | 复制 / 剪切 / 粘贴 | `EX-CMD` 剪贴板组 + `KEY Ctrl+C/X/V` |
| `MenuBar.jsx:58` | `__clearClipboard` | 清空剪贴板 | `EX-CMD›剪贴板▸`（或 `CTX/空白›剪贴板▸`，二者择一，**必须有**） |
| `MenuBar.jsx:59` | `selectAll` | 全选 | `KEY Ctrl+A` + `EX-CMD` |
| `MenuBar.jsx:59` | `rename` | 重命名 | `KEY F2` + `CTX/条目›重命名` + `EX-CMD` |
| `MenuBar.jsx:59` | `trash` | 移入废纸篓 | `KEY Delete` + `CTX/条目›删除` + `EX-CMD›删除` |
| `MenuBar.jsx:62` | `viewIcon` | 图标视图 | `EX-CMD›查看▸图标` |
| `MenuBar.jsx:62` | `viewList` | 列表视图 | `EX-CMD›查看▸列表` |
| `MenuBar.jsx:63` | `toggleHidden` | 显示隐藏文件 | `EX-CMD›查看▸显示隐藏文件` + `CTX/空白›查看▸` |
| `MenuBar.jsx:63` | `refresh` | 刷新 | `KEY F5` + `EX-CMD` |
| `MenuBar.jsx:63` | `focus-search` | 搜索 | `KEY Ctrl+F` + `KEY F3` |
| `MenuBar.jsx:66` | `goHome` | 主目录 | 侧栏「主目录」 |
| `MenuBar.jsx:68` | `goRoot` | 根目录 | 侧栏「文件根目录」 |
| `MenuBar.jsx:69` | `goTrash` | 废纸篓 | 侧栏「回收站」 |
| `MenuBar.jsx:69` | `goParent` | 上级目录 | `KEY Alt+↑` + `EX-CMD` 地址栏「↑」按钮 |
| `MenuBar.jsx:69` | `goFolder` | 前往文件夹… | `EX-CMD` 地址栏可编辑 + `KEY Ctrl+L` |

#### 2.1.3 终端窗口（L71-74）

| 旧位置 | action | 文案 | 新载体 |
|---|---|---|---|
| `MenuBar.jsx:72` | `newTab` | 新建标签页 | `WIN-MENU/终端›∨` + `KEY Ctrl+Shift+T` |
| `MenuBar.jsx:72` | `closeTab` | 关闭当前标签 | `WIN-MENU/终端›∨` + 标签上的 × + `KEY Ctrl+Shift+W` |
| `MenuBar.jsx:72` | `closeWin` | 关闭窗口 | 标题栏 × + `Alt+F4` |
| `MenuBar.jsx:73` | `clear` | 清屏 | `WIN-MENU/终端›∨`（清屏由 shell `Ctrl+L` 另行处理，不拦截） |
| `MenuBar.jsx:73` | `clear{arg:'reset'}` | 重置终端 | `WIN-MENU/终端›∨` |

#### 2.1.4 记事本窗口（L75-81）

| 旧位置 | action | 文案 | 新载体 |
|---|---|---|---|
| `MenuBar.jsx:77` | `save` | 保存（hint `⌘S`/`Ctrl+S`） | `KEY Ctrl+S` + `WIN-MENU/记事本›文件`；**hint 固定为 `Ctrl+S`**（L75 的 `isMac` 判断要删） |
| `MenuBar.jsx:77` | `saveAs` | 另存为… | `WIN-MENU/记事本›文件` + `KEY Ctrl+Shift+S`（新增） |
| `MenuBar.jsx:77` | `closeWin` | 关闭窗口 | 标题栏 × + `Alt+F4` |
| `MenuBar.jsx:79` | `format` | 格式化（仅 json/html） | `WIN-MENU/记事本›编辑` |
| `MenuBar.jsx:80` | `find` | 查找… | `WIN-MENU/记事本›编辑` + `KEY Ctrl+F`。⚠️ 现状只弹一句「使用 Ctrl/Cmd + F 打开查找替换」提示（`Editor.jsx:233`），不是真查找；搬迁后**仍保持这个行为**，但提示文案去掉 `Cmd` |

#### 2.1.5 预览窗口（L82-84）

| 旧位置 | action | 文案 | 新载体 | 说明 |
|---|---|---|---|---|
| `MenuBar.jsx:83` | `download` | 下载 | `WIN-UI` 预览底部「下载」按钮（`Preview.jsx:244`） | ⚠️ 该 action **现在就是死代码**：`Preview.jsx` 没有 `win-action` 监听，点了没反应。功能由窗口内按钮承担，不算丢失 |
| `MenuBar.jsx:83` | `edit` | 用编辑器打开 | `WIN-UI` `Preview.jsx:102-104`（文本/Markdown 视图）+ 图片视图建议补一个 | 同上，当前为死 action |
| `MenuBar.jsx:83` | `closeWin` | 关闭窗口 | 标题栏 × | |

#### 2.1.6 通用菜单（L85-88，所有焦点状态都追加）

| 旧位置 | action | 文案 | 新载体 |
|---|---|---|---|
| `MenuBar.jsx:86` | `minimize` | 最小化 | 标题栏 `－`（已有）+ `TB` 窗口按钮单击 + `KEY Win+↓` |
| `MenuBar.jsx:86` | `__minAll` | 最小化全部窗口 | `TB` 空白处右键›显示桌面 / `KEY Win+D`。⚠️ 现状会让所有窗口不可还原，见 §5.3 |
| `MenuBar.jsx:86` | `__newFinder` | 新建文件窗口 | `SM›文件资源管理器` + `TB` 固定项 + `KEY Ctrl+N`（Win11 语义） |
| `MenuBar.jsx:88` | `__about` | 关于本系统 | `SM›设置›关于` + `SM` 底部「关于」+ 账户菜单 |

#### 2.1.7 顶栏右侧托盘（不是菜单项，但同属被拆掉的顶栏）

| 旧位置 | 内容 | 新载体 |
|---|---|---|
| `MenuBar.jsx:134` | 站点名按钮 → `showDialog({kind:'about'})` | `SM` 底部「关于本系统」 |
| `MenuBar.jsx:164, 178-203` | 磁盘占比指示 + popover（点行开「磁盘监控」） | `TRAY` 磁盘图标 |
| `MenuBar.jsx:165-169` | 传输中徽标 → `global-action: transfers` | `TRAY` 传输徽标 |
| `MenuBar.jsx:170, 205-227` | 通知铃 + 列表（可点项执行 `activateNotification`） | `TRAY` 通知中心 |
| `MenuBar.jsx:171, 229-253` | 账户菜单：修改密码(:236)、浅色/深色/跟随系统(:238-240)、退出登录(:242-248) | `TRAY` 账户头像 + `SM` 底部账户区 |
| `MenuBar.jsx:172` | 时钟 | `TRAY` 时钟 |
| `MenuBar.jsx:113` | `refreshDisk()` 每 20s 拉磁盘信息 | 外壳根组件（`AppShell`）的 effect，不能再挂在顶栏里 |

> `changePasswordFlow`（`MenuBar.jsx:255-272`）目前从 `MenuBar.jsx` 导出但**只被
> `AccountMenu` 自己使用**。删掉 `MenuBar.jsx` 时必须把它迁到
> 新外壳的账户模块，否则「修改密码」入口消失。

### 2.2 `DesktopIcons.jsx` 右键菜单

#### 2.2.1 `sysMenu()`（L140-159，系统图标：主目录 / 回收站）

| 旧位置 | 文案 | 新载体 | 说明 |
|---|---|---|---|
| `DesktopIcons.jsx:143` | 打开根目录 | 双击图标（`openSys` L135-138）+ `CTX›打开` | 图标标签后来改为「主目录」（文件夹造型 + 系统标识） |
| `DesktopIcons.jsx:144` | 在终端中打开 | `CTX›在终端中打开` | |
| `DesktopIcons.jsx:149` | 打开废纸篓 | 双击 + `CTX›打开` | 文案 → 打开回收站 |
| `DesktopIcons.jsx:151-157` | 清倒废纸篓（`trashCount>0` 才出现） | `CTX›清空回收站` + 回收站窗口内「清空回收站…」按钮 | 文案 → 清空回收站 |

#### 2.2.2 `itemMenu()`（L235-266，文件 / 文件夹）

| 旧位置 | 文案 | 新载体 | 说明 |
|---|---|---|---|
| `DesktopIcons.jsx:247` | 打开 | 双击 + `KEY Enter` + `CTX›打开` | |
| `DesktopIcons.jsx:248` | 快速预览 | `CTX›预览`（`KEY Alt+P` 开预览窗格） | macOS 手语「空格」删除，见 §4 |
| `DesktopIcons.jsx:250` | 重命名 | `KEY F2` + `CTX›重命名` | 多选时禁用（现状 `disabled: multi`） |
| `DesktopIcons.jsx:251` | 复制 | `CTX›复制` + `KEY Ctrl+C` | |
| `DesktopIcons.jsx:252` | 剪切 | `CTX›剪切` + `KEY Ctrl+X` | |
| `DesktopIcons.jsx:254` | 下载 | `CTX›发送到▸下载` | |
| `DesktopIcons.jsx:255` | 打包下载（多选） | `CTX›发送到▸打包下载` | |
| `DesktopIcons.jsx:256` | 压缩… | `CTX›压缩…` | |
| `DesktopIcons.jsx:257` | 解压到…（归档文件） | `CTX›解压到…` | |
| `DesktopIcons.jsx:259` | 分享…（不可分享时禁用并显示原因） | `CTX›分享…` | 保留 `shareBlockReason` 文案 |
| `DesktopIcons.jsx:260` | 显示简介 | `CTX›属性` + `KEY Alt+Enter` | 文案 → 属性 |
| `DesktopIcons.jsx:261` | 复制路径 | `CTX›发送到▸复制路径` | |
| `DesktopIcons.jsx:262` | 在终端中打开（目录） | `CTX›打开方式▸在终端中打开` | |
| `DesktopIcons.jsx:264` | 移入废纸篓 | `CTX›删除` + `KEY Delete` / `KEY Shift+Delete`（永久） | 文案 → 删除 |

#### 2.2.3 `blankMenu()`（L268-295，桌面空白）

| 旧位置 | 文案 | 新载体 |
|---|---|---|
| `DesktopIcons.jsx:273` | 新建文件夹 | `CTX/桌面空白›新建▸文件夹` + `KEY Ctrl+Shift+N` |
| `DesktopIcons.jsx:274` | 新建空白文件 | `CTX/新建▸文本文档` |
| `DesktopIcons.jsx:276-281` | 粘贴 / 粘贴项目 / 移动项目到此处（按剪贴板模式变文案） | `CTX/桌面空白›粘贴`（保留三种文案） |
| `DesktopIcons.jsx:282` | 上传文件… | `CTX/桌面空白` |
| `DesktopIcons.jsx:283` | 上传文件夹… | `CTX/桌面空白` |
| `DesktopIcons.jsx:285` | 显示隐藏文件 | `CTX/桌面空白›查看▸` |
| `DesktopIcons.jsx:286` | 文件夹优先 | `CTX/桌面空白›排序方式▸` |
| `DesktopIcons.jsx:287-290` | 按名称/大小/修改时间/类型排列 | `CTX/桌面空白›排序方式▸` |
| `DesktopIcons.jsx:292` | 刷新 | `CTX/桌面空白›刷新` + `KEY F5` |

> ⚠️ 桌面空白菜单**没有**「改为升序/降序」（只有 `MenuBar` 有，L36）。
> 新设计把升/降序放进 `排序方式 ▸` 后，两处入口才终于一致 —— 属于补齐，不算新增功能。

### 2.3 `Finder.jsx` → `act()`（L127-159）

`act()` 是菜单栏动作在文件窗口里的唯一执行入口。**27 个 case，全部要有落点**（下表 26 行，`quickLook` 合并为一行）：

| 旧位置 | action | 新载体 | 触发来源（现状） |
|---|---|---|---|
| `Finder.jsx:128` | `newFolder` | `EX-CMD›新建▸文件夹` + `CTX/空白` + `Ctrl+Shift+N` | MenuBar:50 |
| `Finder.jsx:129` | `newFile` | `EX-CMD›新建▸文本文档` + `CTX/空白` | MenuBar:50 |
| `Finder.jsx:130` | `uploadFile` | `EX-CMD›上传文件…` | MenuBar:50 |
| `Finder.jsx:131` | `uploadFolder` | `EX-CMD›上传文件夹…` | MenuBar:50 |
| `Finder.jsx:132` | `openTerminal` | `CTX/空白›在终端中打开` | MenuBar:51 |
| `Finder.jsx:133` | `copy` | `EX-CMD›复制` + `Ctrl+C` | MenuBar:56 |
| `Finder.jsx:134` | `cut` | `EX-CMD›剪切` + `Ctrl+X` | MenuBar:56 |
| `Finder.jsx:135` | `paste` | `EX-CMD›粘贴` + `Ctrl+V` | MenuBar:56 |
| `Finder.jsx:136` | `selectAll` | `EX-CMD›全选` + `Ctrl+A` | MenuBar:59 |
| `Finder.jsx:137` | `rename` | `EX-CMD›重命名` + `F2` + `CTX/条目` | MenuBar:59 |
| `Finder.jsx:138` | `trash` | `EX-CMD›删除` + `Delete` + `CTX/条目` | MenuBar:59 |
| `Finder.jsx:139` | `viewIcon` | `EX-CMD›查看▸图标` | MenuBar:62 |
| `Finder.jsx:140` | `viewList` | `EX-CMD›查看▸列表` | MenuBar:62 |
| `Finder.jsx:141` | `toggleHidden` | `EX-CMD›查看▸显示隐藏文件` | MenuBar:63 |
| `Finder.jsx:142` | `refresh` | `EX-CMD›刷新` + `F5` | MenuBar:63 |
| `Finder.jsx:143` | `focus-search` | `Ctrl+F` / `F3` + 点搜索框 | MenuBar:63、`Desktop.jsx:51` |
| `Finder.jsx:144` | `goHome` | 侧栏「主目录」 | MenuBar:66 |
| `Finder.jsx:145` | `goRoot` | 侧栏「文件根目录」 | MenuBar:68 |
| `Finder.jsx:146` | `goTrash` | 侧栏「回收站」 | MenuBar:69 |
| `Finder.jsx:147` | `goParent` | `Alt+↑` + 地址栏「↑」 | MenuBar:69 |
| `Finder.jsx:148` | `goFolder` | 地址栏可编辑 + `Ctrl+L` | MenuBar:69 |
| `Finder.jsx:149` | `download` | `CTX/条目›发送到▸下载` | 预览菜单（死）、无 finder 菜单入口 |
| `Finder.jsx:150` | `compress` | `CTX/条目›压缩…` | 仅右键 |
| `Finder.jsx:151` | `share` | `CTX/条目›分享…` | 仅右键 |
| `Finder.jsx:152-156` | `quickLook` | 预览窗格（`Alt+P`） | `Desktop.jsx:48-50` 空格 |
| `Finder.jsx:157` | `emptyTrash` | 回收站视图「清空回收站…」+ `CTX/回收站` | `Finder.jsx:330,358` |
| `Finder.jsx:158` | `restore` | 回收站视图「还原」+ `CTX/回收站›放回原处` | `Finder.jsx:327` |

**附带：`itemMenu` / `blankMenu` / `sortMenu`（L322-386）** 是右键菜单本体，
不在 `act()` 里，但同属"动作来源"，重构右键菜单时必须逐条保留：

- `Finder.jsx:327-330` 回收站：放回原处 / 彻底删除… / 清倒废纸篓…
- `Finder.jsx:332-348` 条目：打开 / 快速预览 / 重命名 / 复制 / 剪切 / 下载 / 压缩… / 解压到… / 分享… / 显示简介 / 复制路径 / 在终端中打开 / 移入废纸篓
- `Finder.jsx:357-375` 空白：清倒废纸篓 / 刷新（回收站视图）；新建文件夹 / 新建空白文件 / 粘贴 / **粘贴为副本**（L365，只有这里才有）/ 上传文件 / 上传文件夹 / 显示隐藏文件 / 在终端中打开 / 排序方式 ▸ / 刷新
- `Finder.jsx:378-386` 排序子菜单：按名称 / 按大小 / 按修改时间 / 改为升序-降序

> ⚠️ 「**粘贴为副本**」（`Finder.jsx:365`）只存在于文件窗口空白右键菜单，
> 菜单栏里没有。搬到命令栏时必须保留（建议放 `EX-CMD›粘贴` 的下拉里）。

### 2.4 `Dock.jsx` → 任务栏 / 开始菜单

| 旧位置 | 应用 | 现有行为 | 新落点 |
|---|---|---|---|
| `Dock.jsx:7` | 文件（finder） | `openWindow('finder', {cwd: homeRel})` | `SM` 固定项 + `TB` 固定项 |
| `Dock.jsx:8` | 终端 | `openWindow('terminal')` | 同上 |
| `Dock.jsx:9` | 文本编辑 | `openWindow('editor')` | 同上 |
| `Dock.jsx:10` | 传输 | `openWindow('transfers')` | 同上 + `TRAY` 传输徽标 |
| `Dock.jsx:11` | 分享管理 | `openWindow('shares')` | `SM` |
| `Dock.jsx:12` | 磁盘监控 | `openWindow('disk')` | `SM` + `TRAY` 磁盘面板 |
| `Dock.jsx:13` | 废纸篓 | `openWindow('finder', {trash:true})` | `SM` + 桌面回收站图标 |
| `Dock.jsx:29-39` | 拖文件到「传输」上传 | `addUpload(f, homeRel)` | `TB` 传输按钮保留该行为 |
| `Dock.jsx:21,47` | `running` 小圆点 = 该类型有窗口 | `windows.some(w => w.type === type)` | 任务栏改为**每窗口一个按钮**（不是每类型一个） |

> ⚠️ Dock 的点击语义是 `openWindow(type)`，对 `multi:true` 的类型（finder/terminal/
> editor/preview/info）**永远新建窗口**，不会切到已有窗口。这正是"最小化后找不回来"
> 的另一半原因（完整分析与修复方案见 §5.3），任务栏必须改成 `activateOrOpen`。

### 2.5 `Desktop.jsx` 键盘（L16-58）与 `pasteUpload`

| 旧位置 | 键 | 动作 | 新载体 |
|---|---|---|---|
| `Desktop.jsx:21-26` | `Escape` | 依次关 右键菜单 / 弹层 | 保留（开始菜单也要能 Esc 关） |
| `Desktop.jsx:32-34` | `⌘/Ctrl + A/C/X` | 桌面全选/复制/剪切 | `Ctrl + A/C/X` |
| `Desktop.jsx:35` | `⌘/Ctrl + N` | 桌面新建文件夹 | → `Ctrl+Shift+N`（`Ctrl+N` 改为新建窗口） |
| `Desktop.jsx:36` | `Delete`/`Backspace` | 移入废纸篓 | `Delete`；`Backspace` 改「后退」 |
| `Desktop.jsx:37` | `F2` | 重命名 | 保留 |
| `Desktop.jsx:38` | `Space` | 快速预览 | **删除**（macOS 独有） |
| `Desktop.jsx:42` | `⌘/Ctrl + W` | 关闭窗口 | `Ctrl+W` |
| `Desktop.jsx:43` | `⌘/Ctrl + N` | 新建文件窗口 | `Ctrl+N` |
| `Desktop.jsx:44` | `⌘/Ctrl + M` | 最小化 | **删除**（Win 无此键）→ `Win+↓` |
| `Desktop.jsx:45-47` | `⌘/Ctrl + A/C/X` | 窗口内全选/复制/剪切 | `Ctrl + …` |
| `Desktop.jsx:48-50` | `Space` | 预览选中项 | **删除** → `Alt+P` 预览窗格 |
| `Desktop.jsx:51-52` | `⌘/Ctrl + F` | 聚焦搜索框 | `Ctrl+F` |
| `Desktop.jsx:53-55` | `⌘/Ctrl + S` | 编辑器保存 | `Ctrl+S` |
| `pasteUpload.js:111-182` | `Ctrl+V` | 粘贴系统剪贴板文件 → 上传 | 保留（Windows 原生语义） |

---

## 3. 快捷键总表（Win11 语义，实施目标）

### 3.1 全局

| 快捷键 | 动作 | 备注 |
|---|---|---|
| `Win` | 开始菜单开/关 | 浏览器里 `Win` 键多半被系统截获，**必须同时提供任务栏开始按钮**；两者等价 |
| `Esc` | 关闭最上层弹层（子菜单 → 菜单 → 开始菜单 → 弹窗） | 逐级关闭 |
| `Ctrl+W` | 关闭当前窗口 / 当前标签 | 终端里应是关标签 |
| `Alt+F4` | 关闭当前窗口 | 浏览器环境下不可靠，作为"锦上添花"，不作为唯一入口 |
| `Alt+Tab` | 窗口切换器（列出 `s.windows`，跳过最小化的可另做） | 新增 |
| `Win+D` | 显示桌面 / 恢复 | 新增，等价「最小化全部」双向 |
| `Win+← / →` | 左右半屏（Aero Snap） | 新增 |
| `Win+↑` | 最大化 | 新增 |
| `Win+↓` | 还原 / 最小化 | 新增 |
| `Ctrl+N` | 新建资源管理器窗口 | 语义变更，见 §3.3 |
| `Ctrl+Shift+N` | 新建文件夹 | 新增 |
| `F5` | 刷新当前视图 | 新增 |
| `Alt+Enter` | 属性（打开「显示简介」） | 新增 |
| `Shift+Delete` | 永久删除（跳过回收站） | 新增，需确认后端能力，见 §3.4 |

### 3.2 文件窗口 / 桌面

| 快捷键 | 动作 |
|---|---|
| `Ctrl+A` / `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | 全选 / 复制 / 剪切 / 粘贴 |
| `Delete` | 删除到回收站 |
| `Shift+Delete` | 永久删除 |
| `F2` | 重命名 |
| `Enter` | 打开选中项 |
| `Alt+←` / `Alt+→` | 后退 / 前进（对应 `Finder` 的 `history`/`hIdx`） |
| `Alt+↑` | 上一级目录 |
| `Ctrl+L` | 编辑地址栏（等价「前往文件夹…」） |
| `Ctrl+F` / `F3` | 聚焦搜索框 |
| `Alt+P` | 显示/隐藏预览窗格 |
| `Ctrl+Shift+N` | 新建文件夹 |
| `F5` | 刷新 |
| `Space` | 切换当前选中项（Win11 资源管理器行为）—— **不再触发预览** |

### 3.3 与现有实现的冲突项（必须逐条处理）

`Desktop.jsx:19` 定义了 `const meta = e.metaKey || e.ctrlKey;`，所有快捷键都建立在
"⌘ 或 Ctrl 皆可"上。**这是 macOS 语义的核心残留**，改造后 `metaKey` 必须完全不参与。

| # | 位置 | 现状 | 冲突 | 处理 |
|---|---|---|---|---|
| C1 | `Desktop.jsx:19` | `metaKey \|\| ctrlKey` | ⌘ 语义 | 改为 `e.ctrlKey` |
| C2 | `Desktop.jsx:35` | `Ctrl+N` = 新建文件夹 | Win11 `Ctrl+N` = 新建窗口 | `Ctrl+N` 改新建窗口；新建文件夹改 `Ctrl+Shift+N` |
| C3 | `Desktop.jsx:43` | `Ctrl+N` = 新建文件窗口（仅窗口聚焦时） | 与 C2 同一组合键、两处语义不同 | 统一为"新建窗口"，桌面态也新建窗口 |
| C4 | `Desktop.jsx:36` | `Delete` 和 `Backspace` 都是"移入废纸篓" | Win11 `Backspace` = 后退 | `Backspace` 改为 `Alt+←` 等价的后退；只有 `Delete` 删除 |
| C5 | `Desktop.jsx:38, 48-50` | `Space` = 快速预览 | macOS 独有手势 | 删除；`Space` 改"切换选中"，预览改 `Alt+P` |
| C6 | `Desktop.jsx:44` | `Ctrl+M` = 最小化 | Win11 无此键 | 移除，改用 `Win+↓` / 任务栏 |
| C7 | `Desktop.jsx:42` | `Ctrl+W` = 关闭窗口 | 与"关闭标签"重叠（终端/记事本） | 明确优先级：焦点在终端/记事本标签时先关标签，否则关窗口 |
| C8 | `DesktopIcons.jsx:300`、`Finder.jsx:392` | 拖拽时 `e.altKey` = 复制 | Win11 是 **Ctrl 拖动 = 复制**；`Alt` 在 Win 里是菜单/属性修饰键 | `Alt` → `Ctrl`（`api.copy` vs `api.move` 的分支不变） |
| C9 | `DesktopIcons.jsx:165`、`Finder.jsx:193` | `metaKey \|\| ctrlKey` 多选 | ⌘ 语义 | 只留 `ctrlKey`（`Shift` 连选保留） |
| C10 | `DesktopIcons.jsx:178`、`Finder.jsx:206` | 框选时 `metaKey \|\| ctrlKey` 直接 return | 同上 | 只判 `ctrlKey` |
| C11 | `MenuBar.jsx:75,77` | `isMac` 检测 + `⌘S` 提示 | macOS | 删除检测，hint 固定 `Ctrl+S` |
| C12 | `QuickLook.jsx:11-18` | `Space`/`Esc` 关闭、方向键切换 | macOS QuickLook | 若保留预览窗格，改为 `Esc` 关闭、`←/→` 切文件；`Space` 不再参与 |
| C13 | `Desktop.jsx:16` 全局 `keydown` | 挂在 `window` 上、无 `capture` | 与浏览器默认快捷键（`Ctrl+N` 开新标签页等）冲突 | 需要 `preventDefault`，且**只在桌面壳挂载时生效**（登录页/分享页不挂） |

### 3.4 需要后端确认的能力（不能凭空承诺）

| 功能 | 现状 | 风险 |
|---|---|---|
| `Shift+Delete` 永久删除 | `api.trash()` 只移入回收站；`api.trashDelete(ids)` 需要回收站里的 id | 若要真·永久删除，需新增 API（**超出阶段 0 范围，且禁止改 `server/`**）。阶段 2 若不改后端，`Shift+Delete` 只能退化为"先移入回收站再立即彻底删除"，或干脆不实现。**建议不实现，不放进验收项** |
| `Alt+P` 预览窗格 | 无实现，现有 `QuickLook` 是居中浮层 | 属于新功能，不是"搬迁"，可放到阶段 3 |

---

## 4. 术语替换表

| 现状文案 | 出现位置 | 改为 | 备注 |
|---|---|---|---|
| 访达 | `ErrorBoundary.jsx:7`（注释）、`pasteUpload.js:37-38`（注释）、`styles/finder.css` 注释、`store.js:350` 注释 | 文件资源管理器 | 只在注释里出现，代码里没有 | 
| 「文件」窗口 | `Dock.jsx:7`、`store.js:245`（`title: '文件'`）、`DesktopIcons.jsx` 超量提示 | 文件资源管理器 | 窗口标题、Dock/任务栏标签、开始菜单应用名 |
| 废纸篓 | `DesktopIcons.jsx:132,149,151,152,264`；`MenuBar.jsx:28,45,59,69`；`Dock.jsx:13,36`；`Dialogs.jsx:140`；`fsops.js:77-90`；`Finder.jsx:49,52,293,330,348,358,427`；`FinderSidebar.jsx:17`；`mobile/MobileApp.jsx:130,219,250-251,262,283,328,542,558`；`mobile/HomeScreen.jsx:60` | 回收站 | 移动端同步改文案（交互不动） |
| 清倒废纸篓 | `DesktopIcons.jsx:151-152`；`Finder.jsx:293,330,358`；`MobileApp.jsx:219,262` | 清空回收站 | 动词也从「清倒」改「清空」 |
| Dock | `Dock.jsx`（整文件）、`Desktop.jsx:6,94`、`stores`/注释、`styles/dock.css`、`DesktopIcons.jsx:26`（`DOCK_RESERVE`） | 任务栏（Taskbar） | 组件名 `Dock` → `Taskbar`；CSS 变量 `--dock-*` → `--taskbar-*` |
| 快速预览 | `QuickLook.jsx` 全文件、`DesktopIcons.jsx:248`、`Finder.jsx:333`、`store.js:212-223`、`styles/overlays.css` `.quicklook*` | 预览 / 预览窗格 | 组件可改名 `PreviewPane`；CSS 类 `.quicklook*` → `.preview-pane*` |
| `⌘S` | `MenuBar.jsx:77` | `Ctrl+S` | |
| 使用 Ctrl/Cmd + F | `Editor.jsx:233` | 使用 Ctrl + F | |
| 显示简介 | `Finder.jsx:344`、`DesktopIcons.jsx:260`、`store.js:249`（`title: '显示简介'`） | 属性 | 窗口标题也改 |
| 个人收藏 | `FinderSidebar.jsx:12`（`sb-group` 文本） | 快速访问 | Win11 侧栏分组名 |
| 最近 | `FinderSidebar.jsx:16`、`Finder.jsx:49`（`recentMode` 标题 `最近`） | 最近使用的文件 | 只改显示文案，内部 `__recent__` 不变 |
| 根目录 | `DesktopIcons.jsx:131`、`FinderSidebar.jsx`、`Finder.jsx:427` 面包屑 | 主目录（侧栏里与 `homeRel` 主目录并存时叫「文件根目录」） | 这是 CloudNine 特有概念，不必硬套 Windows。后期按用户要求把这一层改叫「主目录」：客户端标签/标题/面包屑/移动端路径前缀统一，只有侧栏那一条保留「文件根目录」以示区分 |
| 主目录 | `FinderSidebar.jsx`、`MenuBar.jsx:43,66` | 主目录（保留） | `homeRel` 语义不变 |
| 分享管理 / 传输 / 磁盘监控 | `Dock.jsx:10-12`、`store.js:250-252` | 保留原名 | Windows 无对应概念，属于本系统特有应用 |

**同时要改但不在上表**：`client/index.html` 的 `<title>`、`README.md` 里"macOS 风格"的描述
（`package.json:5` 的 `description` 也写着 "macOS 风格云服务器桌面"）。

---

## 5. 窗口管理规格

### 5.1 窗口状态

每个窗口在 `store.js` 里扩展为：

```js
{
  id, type, props, title,
  rect: { x, y, w, h, max },     // 现有
  minimized: false,               // 现有
  snap: null,                     // 新增：null | 'left' | 'right'
  restoreRect: null,              // 新增：最大化/吸附前的几何，供还原用
  z, minW, minH
}
```

状态集合：`normal` · `maximized`（`rect.max`）· `snapped`（`snap`）· `minimized`。
`minimized` 与其他状态正交：最小化时保留 `rect`/`snap`，还原后回到原状态。

### 5.2 Aero Snap 触发区

拖动标题栏（`WindowFrame.jsx:11-35` 的 `startDrag`）时，在 `pointermove` 内判定：

| 触发区 | 条件 | 预览 | 释放后 |
|---|---|---|---|
| 左边缘 | `ev.clientX <= 8` | 左侧半屏高亮矩形（`--accent-soft` 纯色填充 + 1px `--accent` 描边） | `snap='left'`，`rect = {x:0, y:0, w: vw/2, h: vh - taskbarH}` |
| 右边缘 | `ev.clientX >= innerWidth - 8` | 右侧半屏 | `snap='right'`，`rect = {x: vw/2, …}` |
| 顶边缘 | `ev.clientY <= 8` | 整屏 | `rect.max = true` |
| 四角（可选） | 距角 ≤ 16px 且两侧都判中 | 1/4 屏 | 阶段 3 再议 |
| 离开全部触发区 | — | 取消预览 | 继续自由拖动 |

- 阈值 8px（Win 系默认），必须同时支持"拖动中反向拖出取消"。
- 提交只在 `pointerup`，预览态不写 store。
- `commitRect`（`store.js:333`）现在是"拖完就落库并存 localStorage"，吸附/最大化时必须
  **跳过几何持久化**（否则下次打开窗口会带着半屏尺寸），与现有 `if (win && !win.rect.max)` 同源处理。
- 现有约束要同步改：`WindowFrame.jsx:4` 的 `const MENUBAR_H = 28` 是"窗口不能拖到顶栏下面"，
  顶栏拆掉后要变成 `const SHELL_TOP_H = 0`，底部再引入 `SHELL_BOTTOM_H = 任务栏高度`，
  `WindowFrame.jsx:20`、`:53`、`:66` 三处同步。
- `store.js:255-292`（`openWindow`）的初始位置计算里也有 `Math.max(38, …)` 和 `vh - 110`、
  `vh - 80` 等基于 28px 菜单栏 / Dock 的魔数，必须一并改。

### 5.3 最小化 → 任务栏 → 还原（**这是一个真 bug，必须先修**）

#### 现状（可复现）

1. `minimizeWindow`（`store.js:328-329`）只把 `minimized` 置 `true`，`focusId` 直接置 `null`；
2. `styles/window.css` 里 `.window.minimized { display: none; }` —— 窗口直接从 DOM 布局消失，
   没有任何点击目标；
3. `openWindow`（`store.js:255`）对 `multi: true` 的类型（finder/terminal/editor/preview/info）
   **永远新建**，只有 `multi: false`（transfers/shares/disk）才 `focusWindow(existing.id)`；
4. `focusWindow`（`store.js:294`）是**唯一会**把 `minimized` 置回 `false` 的函数。它 **有** UI 调用点，
   但全部长在窗口自己身上：`WindowFrame.jsx:14`（标题栏拖动）、`:37`（缩放把手）、
   `:74`（窗口根节点 `onPointerDown`）。最小化后 `.window.minimized` 是 `display: none`，
   这三处指针事件**一个都命中不了** —— 不是“没有入口”，是“入口全部不可达”。
   （`openWindow` 内部的 `store.js:258`、`:262` 是仅剩的另外两个调用点。）

**结论**：文件 / 终端 / 记事本 / 预览 / 简介窗口一旦最小化，**就再也回不来**。
Dock 只显示一个 `running` 小圆点，点它等于再开一个新窗口，旧窗口的编辑状态仍在内存里但不可见。
`MenuBar` 的「最小化全部窗口」（`MenuBar.jsx:86` → `Desktop.jsx:80`）会一次性把这类窗口全变成孤儿。

**受影响范围（只这五个类型）**：孤儿只出现在 `multi: true` 的
finder / terminal / editor / preview / info 上。`multi: false` 的 transfers / shares / disk
**不受影响** —— 它们的 `openWindow` 走 `if (existing) { focusWindow(existing.id) }`
（`store.js:258`），最小化后从 Dock 再点一次就能还原。所以这不是“最小化全坏了”，
而是“多实例类型的最小化坏了”，修的时候不要顺手把 `multi: false` 的路径也改掉。

#### 修复方案（阶段 1 T3 必须落地，不能推迟到 T5）

**① `store.js` 新增"激活/切换"两个语义明确的函数**（不要复用 `focusWindow` 的早退逻辑：

```js
// 任务栏按钮单击：已聚焦且未最小化 → 最小化；否则 → 还原并置顶
export function toggleWindow(id) {
  const w = state.windows.find((x) => x.id === id);
  if (!w) return;
  if (!w.minimized && state.focusId === id) return minimizeWindow(id);
  focusWindow(id);           // focusWindow 已会 minimized:false + z 置顶
}

// 应用启动器（开始菜单 / 任务栏固定项）：
// 该类型有最小化的窗口 → 还原最上层那个；否则新建
export function activateOrOpen(type, props = {}) {
  const win = state.windows
    .filter((w) => w.type === type && w.minimized)
    .sort((a, b) => b.z - a.z)[0];
  if (win) return focusWindow(win.id);
  return openWindow(type, props);
}
```

**② `minimizeWindow` 要交接焦点**，不能直接置 `null`：

```js
export const minimizeWindow = (id) => setState((s) => {
  const rest = s.windows.filter((w) => w.id !== id);
  const next = s.focusId === id ? rest.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0] : null;
  return {
    windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    focusId: s.focusId === id ? (next?.id ?? null) : s.focusId,
  };
});
```

**③ `closeWindow` 的焦点回落同样要跳过最小化窗口**（`store.js:307-311`）。

**④ 任务栏渲染"每窗口一个按钮"**：`s.windows.map(w => <button>{w.title}</button>)`，
不要按 `type` 去重 —— 同类型可以有多窗口（`multi: true`），按类型去重会让按钮数量对不上窗口数量。

**⑤ 「最小化全部 / 显示桌面」要有反向操作**：`Win+D` 双向切换（全部最小化 ↔ 还原上次的集合），
或退化为"任务栏保留全部按钮，用户可逐个还原"——后者是底线，必须保证能还原。

**⑥ CSS 不用改**：`.window.minimized { display: none }` 可以保留，因为还原时
`minimized` 变 `false`，类名消失，`style` 里的 `left/top/width/height` 仍在（`WindowFrame.jsx:65-67`
从 `rect` 计算，不依赖 DOM 测量），不会出现尺寸丢失。

#### 状态流转表（验收用）

| 当前状态 | 触发 | 目标状态 | 副作用 |
|---|---|---|---|
| normal | 标题栏 `－` / 任务栏按钮（已聚焦） / `Win+↓`（非最大化） | minimized | `focusId` 交给剩余窗口中最上层者 |
| minimized | 任务栏按钮 / 任务栏缩略图 / 开始菜单应用 / `Alt+Tab` | normal | `minimized=false`、`z` 置顶、`focusId=id` |
| normal | 双击标题栏 / `Win+↑` / 拖到顶边缘 | maximized | 记录 `restoreRect` |
| maximized | 双击标题栏 / `Win+↓` / 拖离顶部 | normal | 恢复 `restoreRect` |
| normal | 拖到左/右边缘 | snapped | 记录 `restoreRect`，`snap='left'|'right'` |
| snapped | 拖离边缘 | normal | 恢复 `restoreRect`；指针锚点保持在标题栏下 |
| 任意 | 标题栏 `×` / `Ctrl+W` / `Alt+F4` / 任务栏右键关闭 | 关闭 | 编辑器有未保存改动时走 `closeWindow` 的三选一对话框（`store.js:304-327`） |

### 5.4 弹层收口（不能因为换外壳而破坏）

`store.js:200-210` 用**同一个全局槽位**管理 `contextMenu` 与 `popover`：
`openContextMenu` 会清空 `popover`，`openPopover` 会清空 `contextMenu`。
搬到任务栏/开始菜单后必须沿用这套收口，否则会出现"开始菜单和右键菜单同时开着"。

需要同时覆盖的关闭触发：`Escape`（`Desktop.jsx:21-26`）、点击外部（`MenuBar.jsx:104-110`）、
打开另一个弹层、窗口失焦（可选）。

---

## 6. 现有代码里**已经是 Windows 语义**的部分（不要重做）

这一节是给阶段 1-3 的省力清单，也是避免"改出新问题"的护栏：

| # | 位置 | 现状 |
|---|---|---|
| W1 | `WindowFrame.jsx:76-81` + `styles/window.css` `.tc` | 标题栏按钮已是 Win11 几何：右上角矩形、**46px 宽**、平铺占满标题栏高度、`mask` 画的 1px 细线符号 |
| W2 | `styles/window.css` `.window-titlebar` | 高度 **39px**（注释说明：扣 1px 底边框后内容 38px 偶数，避免半像素） |
| W3 | `styles/window.css` `.tc-close:hover` | 关闭按钮悬停 **`#c42b1c`**（Win11 官方取值） |
| W4 | `styles/window.css` `.window.maximized .tc-max` | 最大化后切换为「还原」双框图标 |
| W5 | `WindowFrame.jsx:76` | **双击标题栏最大化/还原** |
| W6 | `WindowFrame.jsx:70-71` + `styles/window.css` `.resize-handle` | 八方向窗口缩放把手 |
| W7 | `Desktop.jsx:37` | **F2 重命名** |
| W8 | `Desktop.jsx:36`（部分） | **Delete 删除** |
| W9 | `Desktop.jsx:53-55` | **Ctrl+S 保存** |
| W10 | `DesktopIcons.jsx:57-72` | 桌面图标**自动排布**（不手工摆位），等价 Win「自动排列图标」 |
| W11 | `ContextMenu.jsx:31-42` | 右键项支持 `disabled` / `checked`（✓） / `danger` 三态 |
| W12 | `ContextMenu.jsx:18-22` | `Escape` 关闭右键菜单、点击外部关闭 |
| W13 | `windows/finder/FinderListView.jsx:14-18` | 列表视图五列：名称 / 大小 / 修改时间 / 权限 / 所有者，表头可点排序 |
| W14 | `DesktopIcons.jsx:162-176`、`Finder.jsx:191-203`（框选 `Finder.jsx:206`、`DesktopIcons.jsx:178`） | `Ctrl` 多选 + `Shift` 连选 + 橡皮筋框选 |
| W15 | `pasteUpload.js:111-182` | **Ctrl+V 粘贴系统剪贴板文件并上传**（Win 原生语义） |
| W16 | `store.js:35` | `theme: 'auto' \| 'light' \| 'dark'` + `color-scheme`，与 Windows 深浅色一致 |
| W17 | `store.js:226-242` | 窗口几何按类型记忆（`cloudnine-win-geom`），符合 Win 的"记住窗口位置"预期 |
| W18 | `windows/finder/FinderToolbar.jsx` | 后退/前进 + 地址栏面包屑 + 搜索框，结构已接近 Explorer |
| W19 | `transfers.js` | 断点续传队列，无需改动 |

**唯一明显反 Windows 的地方**：`styles/desktop.css` `.desktop-grid { grid-auto-flow: column }`
（从右上往下填、再向左开新列），Windows 是**左上开始、从左往右填**。属于阶段 2 T6。

---

## 7. 会丢功能的风险点（施工时逐条打勾）

| # | 风险 | 位置 | 后果 | 对策 |
|---|---|---|---|---|
| R1 | 顶栏一拆，`refreshDisk()` 没人调用 | `MenuBar.jsx:113` | 磁盘占比永远停在初始值，磁盘窗口数据陈旧 | 迁到外壳根组件的 effect |
| R2 | `changePasswordFlow` 随 `MenuBar.jsx` 一起删除 | `MenuBar.jsx:255-272` | 「修改密码」入口消失 | 先迁到新账户模块再删文件 |
| R3 | 托盘四件套（磁盘/传输/通知/账户）漏搬 | `MenuBar.jsx:163-173` | 通知、上传进度、磁盘告警全部无法查看 | 按 §2.1.7 逐项验收 |
| R4 | 预览菜单的 `download` / `edit` 是**死 action** | `MenuBar.jsx:83` → `Preview.jsx` 无 `win-action` 监听 | 若照抄"菜单里有"会误判功能存在 | 明确由窗口内按钮承担（`Preview.jsx:244`、`:102-104`），并删掉死 action |
| R5 | `focus-search` 依赖 `.finder-search input` 选择器 | `Finder.jsx:143` | 命令栏重构后若改了类名，`Ctrl+F` 静默失效 | 保留该选择器，或在命令栏暴露 ref |
| R6 | 桌面态 `goHome` 是空实现 | `DesktopIcons.jsx:377` | 搬到开始菜单后点了没反应 | 直接废弃该项，不要包装成"有功能" |
| R7 | 「最小化全部」把窗口变成孤儿 | `MenuBar.jsx:86` → `Desktop.jsx:80` + `store.js:328` | 五个 `multi:true` 类型的窗口全部不可还原（`multi:false` 的还能从 Dock 点回来） | 先修 §5.3，再搬这个菜单项 |
| R8 | `openWindow` 对 `multi:true` 永远新建 | `store.js:256-258` | 任务栏点击导致窗口无限堆积 | 引入 `activateOrOpen` / `toggleWindow` |
| R9 | `ContextMenu` 不支持子菜单 | `ContextMenu.jsx:31-45` | 「新建 ▸ / 发送到 ▸ / 打开方式 ▸」无处安放 | 阶段 2 扩展为递归渲染 + 悬浮展开 + 方向键导航 |
| R10 | `ContextMenu` 定位只在挂载时算一次 | `ContextMenu.jsx:10-23`（`useEffect` 空依赖） | 子菜单展开或窗口缩放后会溢出屏幕 | 改为 `ResizeObserver` / 每次展开重算 |
| R11 | `--menubar-h` 只有一处定义却被 4 处引用 | `styles/base.css` `:root`；`styles/desktop.css`、`styles/menubar.css`、`styles/overlays.css`（通知定位） | 拆顶栏后仍按 28px 留白 | 删除变量前全局搜索 `--menubar-h`，逐处改为 0 或 `--taskbar-h` |
| R12 | `MENUBAR_H = 28` 硬编码在 JS 里 | `WindowFrame.jsx:4` | 窗口拖不到屏幕顶部；最大化后顶部留 28px 空白 | 改为 `SHELL_TOP_H = 0` + `SHELL_BOTTOM_H` |
| R13 | `DOCK_RESERVE = 96` 与 `.dock { bottom: 10px }` | `DesktopIcons.jsx:26`、`styles/dock.css` | 任务栏变高后图标被压到任务栏下面 | 按新任务栏高度重算 |
| R14 | 全局 `keydown` 挂在 `window` 上，登录页/分享页也会命中 | `Desktop.jsx:16`（仅 `Desktop` 挂载时才挂） | 目前安全；但若把快捷键抽到 `App.jsx` 会污染登录页 | 快捷键必须留在桌面壳内 |
| R15 | `Ctrl+N` / `Ctrl+W` 是浏览器保留键 | `Desktop.jsx:42-43` | 不 `preventDefault` 会开新标签页/关标签页 | 全部 `e.preventDefault()` |
| R16 | 桌面超量提示文案「其余请在「文件」窗口中查看」 | `DesktopIcons.jsx`（`MAX_ICONS` 提示） | 改名后文案与入口名不一致 | 随术语表一起改 |
| R17 | 移动端沿用「废纸篓 / Dock」文案 | `MobileApp.jsx`、`HomeScreen.jsx` | 与桌面端术语不一致 | 只改文案，不动交互（决策 #4） |
| R18 | `store.js:39` 主题切换存在 `localStorage`，但「跟随系统」依赖 `matchMedia` 监听 | `store.js:157-159` | 无风险，仅提醒不要在外壳重构时丢掉 | 保留 |

---

## 8. 阶段验收清单（后续任务的 DoD）

阶段 1（任务栏 + 开始菜单）：
- [x] 顶栏删除后，§2.1.1 / §2.1.2 / §2.1.6 / §2.1.7 的每一项都能在新外壳上点到（逐条打勾）
  > 已核对：`MenuBar.jsx` / `Dock.jsx` 删除（T3、T8），注意 R6 的桌面态 `goHome` 按原文要求**废弃**、
  > R4 的预览菜单 `download` / `edit` 死 action 一并删除，这两条不算丢失。
- [x] 最小化任意窗口后能从任务栏还原（finder / terminal / editor / preview / info 五个类型各试一次）
- [x] 「最小化全部」之后仍能逐个还原
- [x] `refreshDisk` 仍在跑（等 20s 看磁盘百分比会变）
- [x] 「修改密码」仍可用
- [x] `Ctrl+F` 仍能聚焦文件窗口搜索框

阶段 2（交互）：
- [x] §3.1 / §3.2 快捷键表逐条可用；§3.3 的 C1-C13 全部处理完
- [x] 右键菜单三处子菜单（新建 / 发送到 / 打开方式）齐全，且「粘贴为副本」仍在
- [x] Aero Snap 左右半屏 + 顶部最大化，拖离后能还原到拖动前几何
- [x] 桌面图标改为左上起、从左往右排布
- [x] 空格不再触发任何预览；`Alt+P`（若实现）可开合预览窗格
      → 空格已改为「切换选中」；**`Alt+P` 预览窗格没有实现**，预览改由右键「预览」开
      独立预览窗口，详见 §10.3。此项按「若实现」的字面含义视为达成。

阶段 3（视觉）：
- [x] 纯色材质（无 `backdrop-filter`），圆角 8px，Segoe UI 字体栈
- [x] 暗色主题下 §2 所有落点的对比度达标

> 逐项实测结论见提交说明与 T16 验收报告；§8 之外实际落地时偏离本文档的地方，
> 统一记在 §10，避免文档与代码各说一套。

## 9. 阶段 0 的验证结论（供审阅）

- CSS 拆分：拆分前后 `client/src/styles.css` 与拆分后 15 个文件按序拼接**逐字节相同**；
  构建产物 CSS bundle 的 md5 完全一致（`105b692eb6ad2b9e5367b17311c44ce5`），规则块 544 → 544。
  → 窗口 / 文件资源管理器 / 右键菜单三处的选择器、优先级、渲染结果**可证明不变**。
- Finder 拆分：四段被搬走的 JSX 与 `SideItem` / `RenameInput` 去掉缩进后与原文件
  **逐字符相同**；子组件用到的自由变量全部在 props 中。
- 端到端：`scripts/uitest.mjs` 在拆分前后各跑一次，**均为 70 项中 69 项通过**，
  唯一失败项（终端 PTY 落盘）在拆分前同样失败，属 Windows 环境限制；
  26 张截图中，文件窗口那两张仅有菜单栏时钟的 53 个像素不同。

---

## 10. 实施记录：与本文档的偏差（阶段 1-3 落地后回写，T16 校订）

> 本节只记**和上文写得不一样**的地方，不重复已经一致的部分。
> 代码为最终事实来源；本文档与代码冲突时改本文档。

### 10.1 窗口状态机（对 §5.1 / §5.2 的细化）

`client/src/store.js` 顶部常量：`SHELL_TOP_H = 0`、`SHELL_BOTTOM_H = 40`（与 `--taskbar-h` 同源）、
`TITLEBAR_MIN_VISIBLE = 44`、`SNAP_EDGE = 8`。`MENUBAR_H = 28` 与 `DOCK_RESERVE = 96` 已不存在。

- 状态字段与 §5.1 一致（`rect.max` / `snap` / `restoreRect`，`minimized` 与其他状态正交）。
- **`restoreRectOf(w)`**：当前已是 max/snap 且已有 `restoreRect` 时**沿用旧值**，
  否则才记录当前几何。目的：连续「左半屏 → 右半屏」吸附不会把半屏尺寸当成原始几何。
- **`applySnap(id, side)`**：`side` 取 `'left' | 'right' | 'max'`，**只在 `pointerup` 调用**；
  拖动中的预览不写 store，而是一个挂在 `.desktop` 上的 DOM 节点 `.snap-preview`
  （`data-snap` 标左/右/整屏），取消时直接 remove。
- **`beginMoveFromSpecial(id, rect)`**：从最大化/吸附态拖标题栏时「就地还原」——
  先把窗口写回给定几何并清掉 `max`/`snap`，其余位移仍由 `WindowFrame` 直接操作 DOM，
  所以指针锚点不跳。这是 §5.3 状态表「maximized/snapped + 拖离 → normal」的落地方式。
- **`commitRect`** 会清 `snap`，且只在非 max / 非 snap 时写几何库（§5.2 的要求）。
- 四角 1/4 屏吸附**未实现**：§5.2 标的是「阶段 3 再议」，阶段 3 没有排进来。
  触发区只有顶（最大化）/ 左 / 右三条。

### 10.2 激活与切换（对 §5.3 的补充）

- **`activateOrOpen(type, props, match)` 多一个 `match` 谓词**（本文档 §5.3 给的签名只有两个参数）。
  用途：区分同类型但身份不同的窗口 —— 例如 `finder` 里 `props.trash === true` 的回收站窗口，
  从开始菜单点「回收站」时要命中的是那个窗口，不是随便一个文件资源管理器窗口。
  判定顺序：① 同型可见窗口 → 置顶并返回该窗口 id（已在顶层也返回 id，**绝不叠新窗口**）；
  ② 只剩最小化窗口 → 还原 `z` 最大的那个；③ 都没有 → `openWindow` 新建。
- `toggleWindow` / `minimizeWindow`（焦点交接）/ `closeWindow`（回落跳过最小化）与 §5.3 ①③ 一致。
- 「最小化全部 / 显示桌面」实际是三个函数：`minimizeAllWindows` / `restoreAllWindows` /
  `toggleShowDesktop`（Win+D、任务栏空白右键、任务栏右端「显示桌面」细条三处同一动作，双向）。
- **Alt+Tab**：`openAltTab` / `cycleAltTab(dir)` / `commitAltTab` / `closeAltTab`；
  候选 = 非最小化窗口，排序用 `recent`（最近使用顺序，当前窗口排第一），
  按住 Alt 连续循环、松开 Alt 提交、Esc 取消，与右键菜单/开始菜单共用「同时只开一层」的收口。
- **任务栏溢出（本文档未规定）**：窗口按钮宽度累计超限时，多出来的折叠进「更多 N」弹层，
  每项带状态标记（最大化 / 半屏 / 已最小化）。悬停按钮另有标题浮层 `.tb-win-tip`。

### 10.3 预览（对 §2.2.2 / §3.4 的修订）

- `QuickLook.jsx` **已删除**；空格改为「切换当前选中项」（§3.2 已写）。
- **`Alt+P` 预览窗格没有实现，也不打算实现**：右键「预览」直接开独立的「预览」窗口
  （`openWindow('preview', { paths })`）。所以 §2.2.2 表里「快速预览 → 预览（Alt+P 开预览窗格）」
  的实际载体是**预览窗口**，不是窗格。`Alt+P` 目前不绑定任何动作。
- `Shift+Delete` 永久删除**未实现**（§3.4 的结论就是不实现）；
  永久删除只能走回收站视图的「彻底删除…」（`api.trashDelete`）。

### 10.4 图标体系（T15 / T15b / T16，本文档原文未描述）

- **应用 / 系统类**（任务栏、开始菜单、桌面系统图标）：单色线性，48 视框，
  统一描边与同一个强调色，无底板、无渐变 —— 暗色主题下终端图标也不会糊进背景。
- **文件类**：纸面 + 折角 + 底部类型色带，色带里固定 3 个字符的类型码
  （`IMG / VID / AUD / PDF / ZIP / SRC / TXT / DOC / BIN`）。22 种扩展名归 9 个类别；
  `< 28px` 只保留纯色带（20px 列表视图里不印字）。
- **T16 新增 `plain` 类别**：无扩展名、又不在纯文本名单里的文件（如随手的 `a.out`）
  不再谎称是 `BIN`，给中性色带、**不带角标**；
  `Makefile / LICENCE / COPYING / .gitignore / .env / Dockerfile …` 这一批名字本身就是扩展名，
  由 `store.js` 的 `PLAIN_TEXT_NAMES` 归到 `text`（角标 `TXT`）。
  `TEXT_EDITABLE` 也随之改为只看 `fileCat()` 的结果（原先另有一份写死的名单）。
- 桌面图标三档：大 / 中 / 小 = 图标 64 / 52 / 32px（`DESKTOP_ICON_SIZES`）。

### 10.5 开始菜单底部（对 §2.1.6 的修订）

没有「设置 ▸」这一层：底部账户区直接给出 `关于本系统`（对应 R「__about」）与
`锁定（回到登录页）`（对应电源按钮），账户菜单（头像）里是 `修改密码… / 主题三档 / 退出登录`。
`SM›设置›关于` 这一路径不存在。

### 10.6 术语与文案（T16 收尾）

- `废纸篓 → 回收站`、`清倒 → 清空`、`显示简介 → 属性` 已**全仓清零**（含注释、README、package.json）。
  T16 补上了桌面端最后一批：桌面系统图标名、侧栏项、窗口标题、搜索框占位、空状态、
  删除确认框（文案为「移入回收站」）、关于对话框的「回收站保留 N 天」。
- 代码标识符不动：`__trash__` / `props.trash` / `api.trash` / `trashCount` 仍叫 trash。
- 移动端 `.m-dock` **类名保留**（iPhone 底栏，与桌面任务栏语义不同），
  其内部文案已全部是「回收站」，无「废纸篓」。
- 根目录仍是 CloudNine 特有概念，没有硬套 Windows 的「此电脑」；
  后期按用户要求改叫「主目录」（桌面图标、窗口标题、面包屑、移动端路径前缀），
  侧栏那一条在 `homeRel` 非空时仍叫「文件根目录」，避免与 `homeRel` 的「主目录」同名。

### 10.7 其它已落地但原文没写的

- `client/src/styles/` 的令牌：`--radius-win` / `--radius-menu` = 8px、`--radius-ctl` = 4px；
  字体栈 `'Segoe UI Variable Display', 'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif`；
  **无 `backdrop-filter`**（纯色材质，§0 决策 6）。
- `scripts/theme-audit.mjs`（新增）：暗色逐表面截图 + 4 组对比度实测 + 10 个表面的
  「露白 / 文字对比度 / backdrop-filter」扫描 + 亮暗来回切的 computed style 快照比对 + 首帧白帧检测。
- `scripts/uitest.mjs` 新增 `--theme light|dark`：同一套用例可在两套主题下各跑一遍。
- 任务栏托盘里的「时钟」按 §1.2 可与通知面板合并 —— 实际是**独立的时钟按钮**，
  点开即通知中心（未与通知铃合并成两套列表）。
