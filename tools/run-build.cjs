// 用 node 直接调 tsc / esbuild 的 JS 入口跑构建，完全绕开 npm 与 shell。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 工程根从**脚本自己的位置**推出来（tools/ 的上一级），不写死绝对路径 ——
// 写死的后果是：仓库 clone 到别处、或换台机器，这个脚本就悄悄跑错目录。
const root = path.resolve(__dirname, '..');
const tscJs = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const esbuildJs = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');

const NODE = process.execPath;

function run(label, exe, args) {
  const t0 = Date.now();
  const r = spawnSync(exe, args, { cwd: root, encoding: 'utf8', shell: false });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  console.log(`[${ok ? ' OK ' : 'FAIL'}] ${label}  ${ms}ms`);
  if (!ok) {
    console.log((r.stdout || '').trim());
    console.log((r.stderr || '').trim());
  }
  return ok;
}

let ok = true;

ok = run('tsc (main + kernel + host + source)', NODE, [tscJs, '-p', 'tsconfig.json']) && ok;

const esbuildTargets = [
  ['preload', 'src/main/preload.ts', 'dist/main/preload.js', ['--external:electron']],
  ['preload-bubble', 'src/main/preload-bubble.ts', 'dist/main/bubble-preload.js', ['--external:electron']],
  ['preload-bar', 'src/main/preload-bar.ts', 'dist/main/bar-preload.js', ['--external:electron']],
  ['renderer', 'src/renderer/renderer.ts', 'dist/renderer/renderer.js', ['--sourcemap']],
  ['bubble', 'src/renderer/bubble.ts', 'dist/renderer/bubble.js', ['--sourcemap']],
  ['bar', 'src/renderer/control-bar.ts', 'dist/renderer/control-bar.js', ['--sourcemap']],
];
for (const [label, entry, out, extra] of esbuildTargets) {
  const fmt = entry.includes('/main/') ? 'cjs' : 'iife';
  const plat = entry.includes('/main/') ? 'node' : 'browser';
  const args = [esbuildJs, entry, '--bundle', `--outfile=${out}`, `--format=${fmt}`, `--platform=${plat}`, '--target=es2022', ...extra];
  ok = run('esbuild ' + label, NODE, args) && ok;
}

ok = run('copy-assets', NODE, ['tools/copy-assets.mjs']) && ok;

// 写构建戳（ADR 047）。**必须在全部编译步骤都成功之后写** ——
// 提前写戳等于给一次失败的构建发通行证，而"dist 是本轮产物"正是行为测试可信的前提。
//
// 注意这是异步 import：run-build.cjs 是 .cjs，同步 require 一个 .mjs 会抛。
// 因此**收尾的 process.exit 必须落进 then 里** —— 放在外面会在 import 兑现前就退出，
// 表现为"构建全绿但没有戳"，而那正是本条纪律要防的状态。
(async () => {
  if (!ok) { console.log('BUILD FAILED'); process.exit(1); }
  try {
    const { writeStamp } = await import('./stamp-build.mjs');
    const s = writeStamp();
    console.log(`[ OK ] build-stamp      srcHash=${s.srcHash}`);
    console.log('BUILD OK');
    process.exit(0);
  } catch (e) {
    console.error('[FAIL] build-stamp      ' + (e && e.message));
    console.error('BUILD FAILED');
    process.exit(1);
  }
})();
