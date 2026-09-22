#!/usr/bin/env node
// 打包成**免安装绿色目录**（挂起 #13；形态由用户 2026-09-21 拍板）。
//
// 做法：复制 Electron 官方运行时目录，把应用以 **`resources/app/` 目录形态**放进去，
// 再把 electron.exe 改成我们的名字。**不引入任何打包器**（electron-builder / packager 都没装，
// 且它们首次构建要联网下载 nsis / winCodeSign）。
//
// 为什么用目录形态而不是 asar：koffi 的原生二进制在
// `node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`，而 **`.node` 不能从 asar 内部加载**。
// 目录形态天然绕开这个坑，也不必配 `asarUnpack`。
//
// 用法：node tools/make-portable.mjs
//   产物：<工程>/dist-win/desktop-pet/（约 370 MB，已 gitignore）
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT = join(ROOT, 'dist-win', 'desktop-pet');
const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist');
const EXE_NAME = 'desktop-pet.exe';   // 刻意用 ASCII：见 ADR 029（含空格/非 ASCII 路径反复出问题）

// 应用要带走的运行时依赖。**只带真正被 require 的**，不要把整个 node_modules 拷进去。
const RUNTIME_DEPS = ['koffi', '@koromix'];

function die(msg) { console.error('[打包] 失败：' + msg); process.exit(1); }

if (!existsSync(ELECTRON_DIST)) die('找不到 Electron 运行时：' + ELECTRON_DIST);
if (!existsSync(join(ROOT, 'dist', 'main', 'index.js'))) die('dist/ 没构建好，先跑 npm run build');
for (const f of ['package.json', 'pet.json', 'spritesheet.webp', 'desktop-pet.json', 'behavior-map.json']) {
  if (!existsSync(join(ROOT, f))) die('缺少 ' + f);
}
for (const d of RUNTIME_DEPS) {
  if (!existsSync(join(ROOT, 'node_modules', d))) die('缺少运行时依赖 node_modules/' + d);
}

console.log('[打包] 清理旧产物 ' + OUT);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('[打包] 复制 Electron 运行时（约 368 MB，稍等）…');
cpSync(ELECTRON_DIST, OUT, { recursive: true });

const APP = join(OUT, 'resources', 'app');
mkdirSync(APP, { recursive: true });
console.log('[打包] 复制应用到 resources/app/（目录形态，不打 asar）');
for (const f of ['dist', 'assets', 'package.json', 'pet.json', 'spritesheet.webp',
  'desktop-pet.json', 'behavior-map.json']) {
  cpSync(join(ROOT, f), join(APP, f), { recursive: true });
}
const NM = join(APP, 'node_modules');
mkdirSync(NM, { recursive: true });
for (const d of RUNTIME_DEPS) cpSync(join(ROOT, 'node_modules', d), join(NM, d), { recursive: true });

// 改名：electron.exe → desktop-pet.exe。Electron 按 exe 同级找 resources/，改名是官方支持的做法。
const exeFrom = join(OUT, 'electron.exe');
const exeTo = join(OUT, EXE_NAME);
if (!existsSync(exeFrom)) die('运行时里没有 electron.exe');
rmSync(exeTo, { force: true });
renameSync(exeFrom, exeTo);

// —— 改 exe 的**版本资源**：这一步决定开机自启在注册表里叫什么 ——
// Electron 写 HKCU\...\Run 时的值名 = `electron.app.` + **exe 版本资源的 ProductName**，
// 跟 app package.json 的 name、跟 app.setName() **都没有关系**（2026-09-22 三种都实测过：
// 前者放着正确的 name 也不起作用，后者 getName() 变了值名还是不变，只有改 ProductName 有效）。
// 不改的话它会一直叫 `electron.app.Electron` —— 用户在系统启动列表里认不出这是桌宠，
// 也得承担与别的便携 Electron 应用互相覆盖的风险（挂起 #15 / ADR 034、035）。
// 顺带改 FileDescription：**这个 exe 在任务管理器里显示什么**也跟着变成 desktop-pet。
const RCEDIT = join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
if (!existsSync(RCEDIT)) die('缺 node_modules/rcedit（它是打包期依赖）：npm i -D rcedit');
const rc = spawnSync(RCEDIT, [exeTo,
  '--set-version-string', 'ProductName', 'desktop-pet',
  // **值一律用 ASCII**：中文写进版本资源在部分读取路径上会变乱码（本轮实测
  // FileDescription 读到的是问号），跟 .bat 必须纯 ASCII 是同一类坑（ADR 029）。
  '--set-version-string', 'FileDescription', 'desktop-pet desktop pet'],
{ encoding: 'utf8', shell: false });   // 含空格路径**不要** shell:true，参数会被截断
if (rc.status !== 0) die('rcedit 改版本资源失败：' + ((rc.stdout || '') + (rc.stderr || '')).trim());
console.log('[打包] exe 版本资源已改为 ProductName=desktop-pet（决定自启值名）');

// 留一份说明，免得几个月后面对一个 370MB 目录不知道它是什么。
writeFileSync(join(OUT, 'README.txt'), [
  '桌面宠物 · 免安装绿色版',
  '',
  '双击 desktop-pet.exe 即可运行，不需要安装。',
  '',
  '【要拷给别人 / 换机器时务必注意】',
  '  必须把**整个 desktop-pet 目录**一起拷过去，不能只拷 desktop-pet.exe。',
  '  这个 exe 只是入口，它启动时要在**同级目录**找 resources\\、*.dll、*.pak、locales\\ 等',
  '  370 MB 运行时文件；只发一个 exe 出去，对方双击会**毫无反应且没有任何报错**。',
  '  压缩包分发：<工程目录>/dist-win/desktop-pet-win-x64.zip 里就是整个目录。',
  '',
  `打包时间：${new Date().toISOString()}`,
  '',
  '生成方式：node tools/make-portable.mjs',
  '说明：本目录 = Electron 官方运行时 + resources/app/（应用本体，目录形态，不打 asar）。',
  '      不打 asar 是因为 koffi 的原生二进制 .node 不能从 asar 内部加载。',
  '      托盘：左键单击 = 显示/隐藏宠物；右键 = 完整菜单。',
  '      全局快捷键已删除（ADR 032），控制条唤出 = 右键宠物 / 托盘菜单「控制条」。',
  '      开机自启写在 HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run，',
  '      值名 electron.app.desktop-pet（Electron 固定前缀 + exe 版本资源的 ProductName；',
  '      升级 2026-09-22 之前打的包时，应用会在启动时自动把旧值名迁移过来）。',
  '      ⚠️ 勾了开机自启之后**别移动这个目录** —— 注册表里记的是绝对路径，移动后会失效，',
  '         需要在新位置重新双击一次让它自己修正。',
  '卸载：直接删掉整个目录，并在托盘菜单里关掉开机自启。',
  '',
].join('\r\n'), 'utf8');

const size = (() => {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else n += statSync(p).size;
    }
  };
  walk(OUT);
  return n;
})();

console.log('[打包] 完成：' + OUT);
console.log('[打包] 体积 ' + (size / 1048576).toFixed(0) + ' MB');
console.log('[打包] 主程序 ' + exeTo);

// —— `--zip`：压成**单个** zip，这才是能"发一个文件给别人"的东西 ——
// 必须说清楚：`desktop-pet.exe` **不能单独分发**。它只是入口，启动时要在同级目录找
// resources\ / *.dll / *.pak / locales\；只发一个 exe 出去，对方双击会**毫无反应且没有报错**
// （本轮实测过这个症状）。所以分发单位是"整个目录"，对外则压成一个 zip。
if (process.argv.includes('--zip')) {
  const zipPath = join(ROOT, 'dist-win', `desktop-pet-win-x64.zip`);
  rmSync(zipPath, { force: true });
  console.log('[打包] 压缩成单个 zip（分发用，约 1-2 分钟）…');
  // 用系统自带的 bsdtar（Win10 1803+）而不是 PowerShell Compress-Archive：快得多，
  // 且 `-a` 会按 .zip 后缀自动选 zip 格式。从 dist-win 里压，解出来就是一个 desktop-pet/ 目录。
  const z = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', join(ROOT, 'dist-win'), 'desktop-pet'],
    { encoding: 'utf8', shell: false });
  if (z.status !== 0) die('压缩失败：' + ((z.stdout || '') + (z.stderr || '')).trim());
  console.log('[打包] zip 完成：' + zipPath + '（' + (statSync(zipPath).size / 1048576).toFixed(0) + ' MB）');
  console.log('[打包] 分发方式：把这**一个** zip 发出去；对方解压后双击里面的 desktop-pet.exe');
}
