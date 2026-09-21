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

// 留一份说明，免得几个月后面对一个 370MB 目录不知道它是什么。
writeFileSync(join(OUT, '说明.txt'), [
  '桌面宠物 · 免安装绿色版',
  '',
  '双击 desktop-pet.exe 即可运行，不需要安装。',
  `打包时间：${new Date().toISOString()}`,
  '',
  '生成方式：node tools/make-portable.mjs',
  '说明：本目录 = Electron 官方运行时 + resources/app/（应用本体，目录形态，不打 asar）。',
  '      不打 asar 是因为 koffi 的原生二进制 .node 不能从 asar 内部加载。',
  '      托盘：左键单击 = 显示/隐藏宠物；右键 = 完整菜单。',
  '      全局快捷键已删除（ADR 032），控制条唤出 = 右键宠物 / 托盘菜单「控制条」。',
  '卸载：直接删掉整个目录。开机自启可在托盘菜单里关掉（它写的是 HKCU\\\\...\\\\Run）。',
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
