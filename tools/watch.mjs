// 增量构建监听（`npm run watch` 的真正实现，ADR 050 / P0-3）。
//
// 为什么要换掉原来那条 `tsc -p tsconfig.json --watch`：
//   它只跑 tsc，于是
//   ① 把 `src/renderer/*.ts` 编成 **CommonJS** 覆盖掉 esbuild 的 **IIFE** 产物
//      ⇒ 浏览器里 `require`/`exports` 未定义 ⇒ **宠物窗口白屏**（而 watch 还在"正常运行"）；
//   ② preload 被 `tsconfig.json` 排除（ADR 023，那三个是 tsc 诱饵），
//      所以 **preload 改动纹丝不动** ⇒ 开发者以为在监听，其实什么也没监听。
//
// 正确形态：**用与正式构建完全相同的步骤**做监听 —— tsc（主）+ preload 类型检查
// + 六个 esbuild 目标 + copy-assets + 构建戳。esbuild 用它的 watch API（不是轮询）。
//
// 用法：
//   node tools/watch.mjs           监听构建（不启动 electron）
//   node tools/watch.mjs --start   监听构建，并在首次成功后启动 electron
//
// 监听模式**不写构建戳的 `at` 之外的语义** —— 戳里的 srcHash 每次成功都会刷新，
// 于是主单测的 ⓪ 节在 watch 期间同样能通过（这正是我们要的：watch 出来的 dist 是本轮的）。
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscJs = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const NODE = process.execPath;
const wantStart = process.argv.includes('--start');

/** 与 run-build.cjs 完全一致的六个 esbuild 目标。 */
const TARGETS = [
  ['preload', 'src/main/preload.ts', 'dist/main/preload.js', 'cjs', 'node', ['--external:electron']],
  ['preload-bubble', 'src/main/preload-bubble.ts', 'dist/main/bubble-preload.js', 'cjs', 'node', ['--external:electron']],
  ['preload-bar', 'src/main/preload-bar.ts', 'dist/main/bar-preload.js', 'cjs', 'node', ['--external:electron']],
  ['renderer', 'src/renderer/renderer.ts', 'dist/renderer/renderer.js', 'iife', 'browser', ['--sourcemap']],
  ['bubble', 'src/renderer/bubble.ts', 'dist/renderer/bubble.js', 'iife', 'browser', ['--sourcemap']],
  ['bar', 'src/renderer/control-bar.ts', 'dist/renderer/control-bar.js', 'iife', 'browser', ['--sourcemap']],
];

let firstBuildDone = false;
async function writeStampIfFirst() {
  if (firstBuildDone) return;
  firstBuildDone = true;
  const { writeStamp } = await import('./stamp-build.mjs');
  const s = writeStamp();
  console.log(`[stamp] srcHash=${s.srcHash}`);
  if (wantStart) {
    console.log('[watch] 启动 electron（改动后需自己重启才会看到新构建）…');
    spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [root], {
      cwd: root, detached: true, stdio: 'ignore', windowsHide: false,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
    }).unref();
  }
}

// —— esbuild 监听（六个目标并行）——
for (const [label, entry, out, format, platform, extra] of TARGETS) {
  const ctx = await esbuild.context({
    entryPoints: [join(root, entry)],
    bundle: true,
    outfile: join(root, out),
    format, platform,
    target: 'es2022',
    external: platform === 'node' ? ['electron'] : [],
    sourcemap: extra.includes('--sourcemap'),
    plugins: [{
      name: 'taotao-first-build',
      setup(b) {
        b.onEnd(async (res) => {
          if (res.errors.length === 0) {
            console.log(`[ OK ] esbuild ${label}`);
            await writeStampIfFirst();
          } else {
            console.log(`[FAIL] esbuild ${label}：${res.errors.length} 个错误`);
          }
        });
      },
    }],
  });
  await ctx.watch();
}

// —— tsc 监听：主配置（emit）+ preload / renderer 的 noEmit 类型检查 ——
//    renderer 绝不能进 tsc 的 emit（它会把 esbuild 的 IIFE 覆盖成 CommonJS ⇒ 白屏，
//    ADR 050 / P0-3）；它的类型检查由 `tsconfig.renderer.json` 承担。
function watchTsc(label, args) {
  const c = spawn(NODE, [tscJs, ...args, '--watch', '--preserveWatchOutput'], { cwd: root, shell: false });
  const tag = (s) => `[${label}] ${s}`;
  c.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag(l))));
  c.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag(l))));
  c.on('close', (code) => console.log(`${label} 退出（code=${code}）`));
  return c;
}
watchTsc('tsc main', ['-p', 'tsconfig.json']);
watchTsc('tsc preload', ['-p', 'tsconfig.preload.json']);
watchTsc('tsc renderer', ['-p', 'tsconfig.renderer.json']);

// —— copy-assets 也要监听：renderer/*.html 是静态资源，tsc/esbuild 都不碰它们。
//    漏掉它 ⇒ 改了 HTML 界面却以为 watch 覆盖了（同类"以为在监听其实没监听"的坑）。
//    这里用 fs.watch 递归监听 src/renderer 下的 html。
import { watch as fsWatch } from 'node:fs';
let copyTimer = null;
fsWatch(join(root, 'src', 'renderer'), { recursive: true }, (_e, filename) => {
  if (!filename || !String(filename).endsWith('.html')) return;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(async () => {
    await import('./copy-assets.mjs');
    console.log('[ OK ] copy-assets (html 变更)');
  }, 150);
});

console.log('[watch] 监听中：tsc(main) + tsc(preload) + tsc(renderer) + 6×esbuild + copy-assets。Ctrl+C 退出。');
