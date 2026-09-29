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
// 用法：node tools/make-portable.mjs [--zip] [--keep-maps]
//   产物：<工程>/dist-win/desktop-pet/（约 370 MB，已 gitignore）
//   --zip        另压一个 `desktop-pet-<版本>-win-x64.zip`（**这才是能发人的东西**）
//   --keep-maps  保留 sourcemap（默认排除，见下方 P1-2 说明）
//
// ═══ 事务性（P0-5，2026-09-29）═══
//
// 这个脚本原先**零个 try 块**，且全程直接写最终路径。两个具体后果：
//   ① `rcedit` 失败时，`OUT` 里已经有一个叫 `desktop-pet.exe` 的文件，但版本资源还是 Electron
//      原版的 ⇒ ProductName 仍是 Electron ⇒ **开机自启的注册表值名会是 `electron.app.Electron`**
//      —— 恰好是本脚本下面用一整段注释说明要避开的坑。而那个目录有 exe、能双击、看不出异常。
//   ② 运行中打包时 `rmSync(OUT)` 会失败（exe 被占用），而它**已经删掉了一半旧包**。
//
// 现在：所有写操作指向 `.staging-<pid>`，全部成功后才**原子换入**最终路径；
// 移开旧产物失败时给出可读提示并**保证旧产物未被改动**（不再有"删一半"这种中间态）。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory, verifyZip } from './zip-dir.mjs';
import { verifyDist } from './stamp-build.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const FINAL_OUT = join(ROOT, 'dist-win', 'desktop-pet');
const STAGE = join(ROOT, 'dist-win', `.staging-${process.pid}`);
const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist');
const EXE_NAME = 'desktop-pet.exe';   // 刻意用 ASCII：见 ADR 029（含空格/非 ASCII 路径反复出问题）

/**
 * 是否保留 sourcemap。**默认排除**（审计 P1-2）。
 *
 * 原因：三个 renderer 构建显式开了 `--sourcemap`，而 esbuild 的 `.map` 内嵌 `sourcesContent`
 * ⇒ 实测发行包里躺着约 56 KB **完整 TypeScript 源码**（连注释里的设计决策一起）。
 * 绿色版是可任意转发的产物，"把内部实现随包发出去"不该是默认行为。
 * 确实要调试时用 `--keep-maps` 显式要回来（本地目录版）。
 */
const KEEP_MAPS = process.argv.includes('--keep-maps');
const ZIP_MODE = process.argv.includes('--zip');

/**
 * 软件版本。**唯一真源是 `package.json` 的 `version`，这里不许手写第二份**（ADR 041）。
 *
 * 为什么单拎出来强调：同一个数字写两遍就会不一致 —— 本工程已经在"宠物名"上栽过一次
 * （面板写淘淘、托盘写 desktop-pet，2026-09-22 用户报的）。版本号比名字更容易悄悄漂移，
 * 因为它没人天天看，而且要跨四处（exe 资源 / 日志 / 菜单 / zip 名）保持一致。
 */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/**
 * semver → Windows 的四段数值版（`1.0.0` → `1.0.0.0`）。
 *
 * Windows 的 `FileVersion` 数值字段**必须是四段纯数字**，semver 的预发布后缀
 * （`1.0.0-beta.1`）在那里没有位置 —— 显式剥掉，别让它悄悄漏进 exe 里变成乱码。
 *
 * 两套是给两个读者看的（实测，见 ADR 041）：四段数值给系统/安装器**比较**大小，
 * 字符串版才是用户在「属性 → 详细信息」里看到的那一行。所以两个都得写。
 */
function windowsVersion(v) {
  const parts = String(v).split('-')[0].split('+')[0].split('.');
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).map((p) => String(Number.parseInt(p, 10) || 0)).join('.');
}

// 应用要带走的运行时依赖。**只带真正被 require 的**，不要把整个 node_modules 拷进去。
const RUNTIME_DEPS = ['koffi', '@koromix'];

/**
 * 打包失败用抛异常而不是 `process.exit` —— `process.exit` 会**跳过 finally**，
 * 那样 staging 目录就清理不掉了（P0-5 的一半价值正在于"不留中间态"）。
 */
class BuildError extends Error {}
function die(msg) { throw new BuildError(msg); }

/**
 * 跑一个外部程序并等它结束，返回 `{ code, out }`（**不抛异常**，把失败留给调用方决定怎么说）。
 *
 * 为什么不用 `spawnSync`：2026-09-23 实测，在带沙箱的环境里 `spawnSync` 起 exe 会**间歇性**
 * 直接返回 `EBUSY`（进程根本没起来），而**异步 `spawn` 在同一环境里正常**。
 * 打包脚本不该因为"环境不让同步起进程"就整个跑不动 —— 何况它本来就要跑一个原生的 `rcedit`
 * （改 exe 版本资源，没有等价的 JS 实现）。顺带的好处：异步版本还能把 stdout/stderr 收全。
 */
function runExe(exe, args, cwd) {
  return new Promise((resolve) => {
    const c = spawn(exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.stderr.on('data', (d) => { out += d.toString(); });
    c.on('error', (e) => resolve({ code: null, out: out + `spawn error: ${e.code} ${e.message}` }));
    c.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * 把 staging 目录**换入**最终路径（P0-5）。
 *
 * 首选路径是**原子**的：`旧 → .old-<pid>` →（原子）`stage → 最终` → 删 `.old`。
 * 关键性质是"移开旧产物失败时旧产物分毫未动" —— 这正是"运行中打包删掉一半旧包"那个缺陷的解法。
 *
 * ⚠️ **回退路径（2026-09-29 实测补上）**：Windows 上"整体重命名一个目录"**会偶发 `EPERM`**。
 * 实测对照：同一父目录下**新建的空目录 rename 正常**，而**这个 187 个文件的产物目录稳定失败**
 * （连试两次都失败，且当时**没有任何 desktop-pet / electron 进程在跑**）。
 * 特征符合"索引器或杀软持有目录内某些文件的句柄"—— 那类句柄**允许删除、不允许重命名**。
 *
 * ⇒ 拿不到原子性时**降级为"先删旧、再换入"**，并把代价如实打印出来（不再事务化）。
 * 更重要的是一并保证：**任何失败都不销毁新产物** —— staging 会被保留并打印路径，
 * 人工 `rename` 一次就能用（构建那 372 MB 的活不必重做）。
 */
function swapIntoPlace(stage, out) {
  const backup = `${out}.old-${process.pid}`;
  const hadOld = existsSync(out);
  if (hadOld) {
    try { rmSync(backup, { recursive: true, force: true }); } catch { /* 残留的 .old 不影响本次 */ }
    let moveErr = null;
    try { renameSync(out, backup); } catch (e) { moveErr = e; }
    if (moveErr) {
      console.warn(`[打包] 旧产物无法整体移开（${moveErr.code ?? ''}）—— 改用「先删旧、再换入」。`);
      console.warn('[打包] ⚠️ 这条**回退路径没有事务性**：接下来的换入若失败，最终目录会是缺的。');
      console.warn(`[打包]    完整的新产物在：${stage}（失败时它会保留，可手动改名过去）`);
      try {
        rmSync(out, { recursive: true, force: true });
      } catch (e) {
        die(`既不能移开、也不能删除旧产物（多半是它正在被使用）：${out}\n`
          + `  ${e.message}\n`
          + `  ✅ 新产物完好地在：${stage}`);
      }
    }
  }
  try {
    renameSync(stage, out);
  } catch (e) {
    if (hadOld) {
      try { renameSync(backup, out); } catch { /* 回滚失败：旧产物仍在 backup，路径已打印 */ }
    }
    die(`新产物就位失败：${e.message}\n  新产物完好地在：${stage}`);
  }
  if (hadOld) {
    try { rmSync(backup, { recursive: true, force: true }); }
    catch { console.warn('[打包] 旧产物备份目录没删掉（无害，可手动删）：' + backup); }
  }
}

/** 递归统计目录字节数。 */
function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else n += statSync(p).size;
    }
  };
  walk(dir);
  return n;
}

// ═══ 预检（只读，不碰任何产物）═══
if (!existsSync(ELECTRON_DIST)) die('找不到 Electron 运行时：' + ELECTRON_DIST);

// —— P0-4：打包前必须确认 dist/ 与 src/ 同步（ADR 050）——
//
// 原先这里只判 `dist/main/index.js` **存在**，不看它新不新。
// 后果具体到可复现：改完 `src/` 直接打包，脚本拿**上一次的 dist/** 配上
// **新的 package.json 版本号**，产出「1.0.2 版装着 1.0.1 代码」的包 ——
// 而它在属性页 / zip 名 / 日志横幅 / 托盘菜单**四处全都自洽地显示 1.0.2，没有一处会露馅**。
//
// 用 `stamp-build.mjs` 的 verifyDist()：比对构建戳里的 `src/` 内容哈希（ADR 047）。
// **不比较 mtime** —— 那个方法在本项目骗过人一次（见 ADR 047）。
const distCheck = verifyDist();
if (!distCheck.ok) {
  die('dist/ 与 src/ 不同步，拒绝打包：\n  - ' + distCheck.reasons.join('\n  - ')
    + '\n先跑：node tools/run-build.cjs');
}
if (!existsSync(join(ROOT, 'dist', 'main', 'index.js'))) die('dist/ 没构建好，先跑 npm run build');
for (const f of ['package.json', 'pet.json', 'spritesheet.webp', 'desktop-pet.json', 'behavior-map.json']) {
  if (!existsSync(join(ROOT, f))) die('缺少 ' + f);
}
for (const d of RUNTIME_DEPS) {
  if (!existsSync(join(ROOT, 'node_modules', d))) die('缺少运行时依赖 node_modules/' + d);
}

try {
  // ═══ 构建到 staging（所有写操作都指向这里）═══
  console.log('[打包] 构建到 staging：' + STAGE);
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  console.log('[打包] 复制 Electron 运行时（约 368 MB，稍等）…');
  cpSync(ELECTRON_DIST, STAGE, { recursive: true });

  const APP = join(STAGE, 'resources', 'app');
  mkdirSync(APP, { recursive: true });
  console.log('[打包] 复制应用到 resources/app/（目录形态，不打 asar）');
  for (const f of ['assets', 'package.json', 'pet.json', 'spritesheet.webp',
    'desktop-pet.json', 'behavior-map.json']) {
    cpSync(join(ROOT, f), join(APP, f), { recursive: true });
  }
  // dist 单独处理：默认滤掉 sourcemap（P1-2）。注意 filter 对**目录**也会调用，
  // 所以判据只能是"后缀是 .map"，不能反过来白名单（那会把目录树整棵剪掉）。
  let skippedMaps = 0;
  cpSync(join(ROOT, 'dist'), join(APP, 'dist'), {
    recursive: true,
    filter: (src) => {
      if (KEEP_MAPS || !src.endsWith('.map')) return true;
      skippedMaps++;
      return false;
    },
  });
  console.log(`[打包] dist 已复制${KEEP_MAPS ? '（--keep-maps：含 sourcemap）' : `，已排除 ${skippedMaps} 个 .map（不发源码出去）`}`);

  const NM = join(APP, 'node_modules');
  mkdirSync(NM, { recursive: true });
  for (const d of RUNTIME_DEPS) cpSync(join(ROOT, 'node_modules', d), join(NM, d), { recursive: true });

  // 改名：electron.exe → desktop-pet.exe。Electron 按 exe 同级找 resources/，改名是官方支持的做法。
  const exeFrom = join(STAGE, 'electron.exe');
  const exeTo = join(STAGE, EXE_NAME);
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
  //
  // ⚠️ 这一步失败**不再留下半成品**（P0-5）：新版先失败在 staging 里，最终路径上的旧产物
  //    一个字节都没动。旧版的后果是"目录里有 exe、能双击、但自启值名是 electron.app.Electron"。
  const RCEDIT = join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
  if (!existsSync(RCEDIT)) die('缺 node_modules/rcedit（它是打包期依赖）：npm i -D rcedit');
  const rc = await runExe(RCEDIT, [exeTo,
    '--set-version-string', 'ProductName', 'desktop-pet',
    // **值一律用 ASCII**：中文写进版本资源在部分读取路径上会变乱码（本轮实测
    // FileDescription 读到的是问号），跟 .bat 必须纯 ASCII 是同一类坑（ADR 029）。
    '--set-version-string', 'FileDescription', 'desktop-pet desktop pet',
    // —— 版本号（ADR 041）——
    // 两套都写，缺一不可：只写数值 ⇒ 属性页显示 1.0.0.0（或干脆空着）；
    // 只写字符串 ⇒ 安装器/系统读不到可比较的数字。
    '--set-file-version', windowsVersion(VERSION),
    '--set-product-version', windowsVersion(VERSION),
    '--set-version-string', 'FileVersion', VERSION,
    '--set-version-string', 'ProductVersion', VERSION,
    // —— 清掉 Electron 留在同一批资源里的痕迹 ——
    // 不改的话「属性 → 详细信息」里写着 GitHub, Inc. / 2015 年的版权 / OriginalFilename=electron.exe，
    // 看起来就像"Electron 换了个名字"而不是一个自己的软件。
    // 版权刻意只写产品名：没有的东西（作者、年份）**不要编**，留白比编一句假声明诚实。
    '--set-version-string', 'CompanyName', 'desktop-pet',
    '--set-version-string', 'LegalCopyright', 'desktop-pet',
    '--set-version-string', 'OriginalFilename', EXE_NAME],
  process.cwd());   // 含空格路径**不要** shell:true，参数会被截断（spawn 默认 shell:false）
  if (rc.code !== 0) die('rcedit 改版本资源失败：' + rc.out.trim());
  console.log(`[打包] exe 版本资源：ProductName=desktop-pet（决定自启值名）｜版本 ${VERSION}`);

  // 留一份说明，免得几个月后面对一个 370MB 目录不知道它是什么。
  writeFileSync(join(STAGE, 'README.txt'), [
    '桌面宠物 · 免安装绿色版',
    `版本：${VERSION}`,
    '',
    '双击 desktop-pet.exe 即可运行，不需要安装。',
    '',
    '【要拷给别人 / 换机器时务必注意】',
    '  必须把**整个 desktop-pet 目录**一起拷过去，不能只拷 desktop-pet.exe。',
    '  这个 exe 只是入口，它启动时要在**同级目录**找 resources\\、*.dll、*.pak、locales\\ 等',
    '  370 MB 运行时文件；只发一个 exe 出去，对方双击会**毫无反应且没有任何报错**。',
    `  压缩包分发：<工程目录>/dist-win/desktop-pet-${VERSION}-win-x64.zip 里就是整个目录。`,
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

  const size = dirSize(STAGE);
  console.log(`[打包] staging 就绪：${(size / 1048576).toFixed(0)} MB`);

  // ═══ 原子换入最终路径 ═══
  swapIntoPlace(STAGE, FINAL_OUT);
  console.log('[打包] 完成：' + FINAL_OUT);
  console.log('[打包] 主程序 ' + join(FINAL_OUT, EXE_NAME));

  // ═══ `--zip`：压成**单个** zip，这才是能"发一个文件给别人"的东西 ═══
  //
  // 必须说清楚：`desktop-pet.exe` **不能单独分发**。它只是入口，启动时要在同级目录找
  // resources\ / *.dll / *.pak / locales\；只发一个 exe 出去，对方双击会**毫无反应且没有报错**
  // （本项目实测过这个症状）。所以分发单位是"整个目录"，对外则压成一个 zip。
  if (ZIP_MODE) {
    // zip 名带版本号（ADR 041）：对方手上是哪一版一眼可知，你自己也好留旧包对照。
    // **目录名保持不带版本** —— 自启注册表里记的是绝对路径，目录改名会让老用户的条目失效。
    const zipPath = join(ROOT, 'dist-win', `desktop-pet-${VERSION}-win-x64.zip`);
    const zipTmp = `${zipPath}.tmp-${process.pid}`;
    rmSync(zipTmp, { force: true });
    console.log('[打包] 压缩成单个 zip（分发用，约 1 分钟）…');
    // 用工程自带的 `tools/zip-dir.mjs`（纯 Node，zlib deflate + 手写 ZIP 结构），不用系统 tar。
    //
    // 为什么不再用 bsdtar（2026-09-23 实测）：`tar -a -c -f x.zip` 在一次运行里**静默产出了一个 tar**
    // （体积等于原始体积、头部是 tar 的文件名而不是 `PK\x03\x04`），但**退出码 0**、脚本照样打印
    // "zip 完成"。也就是说 `-a` 没生效，而失败毫无声音 —— 对方拿到的是改名为 .zip 的 tar，解不开。
    // 这个坑不值得赌：PATH 上的 `tar` 是哪一个、支不支持 `-a`，各台机器都可能不同。
    const zr = zipDirectory(FINAL_OUT, zipTmp);
    // 写完先**回读自证**（P1-1），再换名到位 —— 反过来做的话，"坏 zip 占着最终文件名"
    // 这个状态就会被短暂地真实存在过（原实现是先删旧 zip、再直写最终路径）。
    const v = verifyZip(zipTmp);
    if (!v.ok) {
      rmSync(zipTmp, { force: true });
      die('压缩产物校验未通过，已丢弃（别把它发出去）：\n  - ' + v.reasons.join('\n  - '));
    }
    rmSync(zipPath, { force: true });
    renameSync(zipTmp, zipPath);
    // 换名后再回读一次**最终文件本身**（而不是那个临时名）—— ADR 044 的纪律：
    // "打包成功"必须回读产物本身，体积 / 退出码 / 日志文案都会说谎。
    const finalCheck = verifyZip(zipPath);
    if (!finalCheck.ok) die('最终 zip 回读失败：\n  - ' + finalCheck.reasons.join('\n  - '));
    console.log('[打包] zip 完成：' + zipPath
      + `（${(statSync(zipPath).size / 1048576).toFixed(0)} MB，${zr.entries} 个条目，校验通过）`);
    console.log('[打包] 分发方式：把这**一个** zip 发出去；对方解压后双击里面的 desktop-pet.exe');
  }
} catch (e) {
  console.error('[打包] 失败：' + (e instanceof BuildError ? e.message : `${e.name}: ${e.message}`));
  if (!(e instanceof BuildError) && e.stack) console.error(e.stack);
  process.exitCode = 1;
} finally {
  // 成功时 STAGE 已被 rename 走（这里 no-op）。
  // **失败时保留它** —— 那是完整的新产物（372 MB 的构建成果），删掉就白干了；
  // 失败信息里已经打印了它的路径，人工改名一次即可。
  if (process.exitCode) {
    console.warn(`[打包] 已保留 staging 供人工处置（确认不需要后可删）：${STAGE}`);
    console.warn('[打包]   想直接用它：关掉正在运行的桌宠后，把上面这个目录改名成 dist-win\\desktop-pet');
  } else {
    try { rmSync(STAGE, { recursive: true, force: true }); } catch { /* 清不掉也不能掩盖原错误 */ }
  }
}
