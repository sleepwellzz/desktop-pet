// 用 node 直接调 tsc / esbuild 的 JS 入口跑构建，完全绕开 npm 与 shell。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = '<工程目录>';
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

console.log(ok ? 'BUILD OK' : 'BUILD FAILED');
process.exit(ok ? 0 : 1);
