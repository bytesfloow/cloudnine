#!/usr/bin/env node
/**
 * 开发期插件安装脚本（不用打包 zip 也能迭代插件）
 *
 * 把 examples/plugins/<name>/ 直接铺进服务端的 PLUGINS_DIR，目录布局与 zip 安装
 * 之后完全一致（<PLUGINS_DIR>/<id>/plugin.json）。改完示例插件、重跑一次，刷新浏览器即可。
 *
 * PLUGINS_DIR 的解析规则与 server/src/config.js 逐条对齐：
 *   环境变量 PLUGINS_DIR > server/config.json 的 pluginsDir > <DATA_DIR>/plugins
 *   DATA_DIR：环境变量 DATA_DIR > server/config.json 的 dataDir > <仓库>/server/data
 *   （相对路径按 server/ 目录解析 —— 服务端就是用 npm --prefix server run start 起来的，
 *    它的 process.cwd() 正是 server/）
 * `--dir` 直接给出目标目录时，上面的解析全部让位（只写不读）。
 *
 * 只动插件包目录：<PLUGIN_DATA_DIR>/<id>.json 里的插件私有数据不会被删，
 * 所以反复安装同一插件不会丢你的待办 / 计数。要连数据一起清，用界面里的卸载
 * （DELETE /api/plugins/:id）或手动删那个 json。
 *
 * 用法：
 *   node scripts/plugin-dev-install.mjs todo
 *   node scripts/plugin-dev-install.mjs todo --dir /tmp/cn-plugins
 *   node scripts/plugin-dev-install.mjs todo --remove
 *   node scripts/plugin-dev-install.mjs --list
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const EXAMPLES_DIR = path.join(ROOT, 'examples', 'plugins');
const CONFIG_FILE = path.join(SERVER_DIR, 'config.json');

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function die(msg, hint) {
  console.error(`${RED}错误：${RESET}${msg}`);
  if (hint) console.error(`${DIM}${hint}${RESET}`);
  process.exit(1);
}

function info(msg) { console.log(msg); }

const USAGE = `${BOLD}开发期插件安装${RESET}

用法：
  node scripts/plugin-dev-install.mjs <插件名>            安装 / 覆盖安装
  node scripts/plugin-dev-install.mjs <插件名> --remove   从 PLUGINS_DIR 删掉
  node scripts/plugin-dev-install.mjs --list              列出可安装的示例插件

可选：
  --dir <目录>      目标插件目录（默认按 PLUGINS_DIR 规则自动解析）
  -h, --help        显示本帮助

插件名是 examples/plugins/ 下的目录名，必须与它的 plugin.json 里 id 一致。
`;

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const args = { name: null, remove: false, dir: null, list: false, help: false };

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--help' || a === '-h') args.help = true;
  else if (a === '--remove' || a === '-r') args.remove = true;
  else if (a === '--list' || a === '-l') args.list = true;
  else if (a === '--dir') {
    args.dir = argv[i + 1];
    if (!args.dir || args.dir.startsWith('--')) die('--dir 后面要跟一个目录路径', '例如：--dir /tmp/cn-plugins');
    i += 1;
  } else if (a.startsWith('--dir=')) {
    args.dir = a.slice('--dir='.length) || null;
    if (!args.dir) die('--dir= 后面要跟一个目录路径');
  } else if (a.startsWith('-')) {
    die(`不认识的参数：${a}`, '用 --help 看用法');
  } else if (!args.name) {
    args.name = a;
  } else {
    die(`多余的参数：${a}`, '一次只能安装一个插件');
  }
}

if (args.help || (!args.name && !args.list)) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

// ---------------- 配置（规则与 server/src/config.js 一致） ----------------
function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;      // 没有 config.json 很正常，全靠默认值
    die(`读不了 ${CONFIG_FILE}：${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${CONFIG_FILE} 不是合法 JSON：${e.message}`, '服务端也会因为同一行报错起不来，先修它');
  }
  return null;
}

const fileConfig = readConfig() || {};
const envVal = (k) => (process.env[k] === undefined || process.env[k] === '' ? undefined : process.env[k]);
const pick = (envKey, cfgKey) => envVal(envKey) ?? fileConfig[cfgKey];

const dataDirRaw = pick('DATA_DIR', 'dataDir');
const dataDirSource = envVal('DATA_DIR') ? '环境变量 DATA_DIR' : fileConfig.dataDir ? 'server/config.json 的 dataDir' : '默认 <仓库>/server/data';
const dataDir = path.resolve(SERVER_DIR, String(dataDirRaw ?? path.join(SERVER_DIR, 'data')));

let pluginsDir;
let pluginsDirSource;
if (args.dir) {
  pluginsDir = path.resolve(args.dir);
  pluginsDirSource = '--dir';
} else {
  pluginsDir = path.resolve(SERVER_DIR, String(pick('PLUGINS_DIR', 'pluginsDir') ?? path.join(dataDir, 'plugins')));
  pluginsDirSource = envVal('PLUGINS_DIR') ? '环境变量 PLUGINS_DIR'
    : fileConfig.pluginsDir ? 'server/config.json 的 pluginsDir'
      : `默认 <DATA_DIR>/plugins（DATA_DIR 来自${dataDirSource}）`;
}

// ---------------- 示例插件清单 ----------------
function examplePlugins() {
  if (!fs.existsSync(EXAMPLES_DIR)) return [];
  return fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function manifestOf(dir) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const installedIds = () => {
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
};

function countFiles(dir) {
  let n = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) n += countFiles(path.join(dir, d.name));
    else n += 1;
  }
  return n;
}

// ---------------- --list ----------------
if (args.list) {
  // 列表视图只看目标目录（不安装），没有目标目录就明说，不假装成功
  const installed = installedIds();
  console.log(`${BOLD}示例插件${RESET}  ${DIM}${EXAMPLES_DIR}${RESET}`);
  const names = examplePlugins();
  if (!names.length) console.log(`${YELLOW}（examples/plugins/ 下没有插件）${RESET}`);
  for (const name of names) {
    const m = manifestOf(path.join(EXAMPLES_DIR, name)) || {};
    const mark = installed.includes(name) ? `${GREEN}已安装${RESET}` : `${DIM}未安装${RESET}`;
    console.log(`  ${name.padEnd(12)} ${m.name || '(缺少 plugin.json)'}  ${DIM}v${m.version || '?'}${RESET}  ${mark}`);
  }
  console.log(`\n${DIM}目标插件目录：${pluginsDir}（目录来源：${pluginsDirSource}）${RESET}`);
  process.exit(0);
}

// ---------------- 参数校验 ----------------
const name = args.name;
if (!/^[a-z0-9][a-z0-9._-]{1,47}$/.test(name)) {
  die(`插件名不合法：${name}`, '只允许小写字母、数字、点、下划线、连字符（例如 todo、my-plug.2）');
}

const source = path.join(EXAMPLES_DIR, name);
const target = path.join(pluginsDir, name);

// ---------------- --remove ----------------
if (args.remove) {
  if (!fs.existsSync(target)) {
    // 卸载是幂等的：不存在也算目标达成，但要说清楚，别让人以为删成功了一个别处的目录
    console.log(`${YELLOW}未安装：${RESET}${target} 不存在，无需删除`);
    console.log(`${DIM}目标插件目录：${pluginsDir}（目录来源：${pluginsDirSource}）${RESET}`);
    process.exit(0);
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    die(`删除失败：${target}\n${e.message}`, 'Windows 上插件窗口 / 编辑器可能还占着文件，关掉再试');
  }
  console.log(`${GREEN}已移除${RESET} ${target}`);
  console.log(`${DIM}插件私有数据（<PLUGIN_DATA_DIR>/${name}.json）保留；刷新浏览器后图标才会消失（插件列表只在登录时拉一次）${RESET}`);
  process.exit(0);
}

// ---------------- 安装 ----------------
if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
  const names = examplePlugins();
  die(`找不到示例插件目录：${source}`,
    names.length ? `可用的插件：${names.join('、')}` : 'examples/plugins/ 下还没有任何插件');
}

const manifest = manifestOf(source);
if (!manifest) {
  die(`${name}/plugin.json 不存在或不是合法 JSON`, '服务端安装时也会按同一份 manifest 校验');
}
if (manifest.id !== name) {
  die(`plugin.json 的 id（${manifest.id ?? '缺失'}）与目录名（${name}）不一致`,
    '服务端的约定是「id 必须等于安装目录名」，不一致装上去也不会被识别');
}
const entry = String(manifest.entry || 'index.html');
if (!fs.existsSync(path.join(source, entry))) {
  die(`manifest 指向的入口文件不存在：${name}/${entry}`, 'entry 默认是 index.html');
}

try {
  fs.mkdirSync(pluginsDir, { recursive: true });
  // 先删再复制：只覆盖改动过的文件会让「删掉一个旧文件」在目标目录里残留下来
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, dereference: true });
} catch (e) {
  die(`复制失败：${source} → ${target}\n${e.message}`, '检查目标目录是否可写、是否被其它进程占用');
}

const files = countFiles(target);
console.log(`${GREEN}已安装${RESET} ${BOLD}${manifest.name || name}${RESET} ${DIM}v${manifest.version || '?'} · ${files} 个文件${RESET}`);
console.log(`  ${DIM}来源${RESET} ${source}`);
console.log(`  ${DIM}目标${RESET} ${target}`);
console.log(`  ${DIM}目录来源${RESET} ${pluginsDirSource}`);
console.log(`${DIM}刷新浏览器即可看到「${manifest.name || name}」${RESET}`);
console.log(`${DIM}插件列表只在登录时拉一次：装 / 卸插件后必须刷新页面，外壳才会更新${RESET}`);
if (manifest.permissions?.length) console.log(`${DIM}权限：${manifest.permissions.join('、')}${RESET}`);
