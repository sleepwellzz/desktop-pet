// tsc 只处理 .ts，渲染层的静态资源要手工搬到 dist。
// 用法：node tools/copy-assets.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jobs = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/bubble.html', 'dist/renderer/bubble.html'],
  ['src/renderer/control-bar.html', 'dist/renderer/control-bar.html'],
];

for (const [from, to] of jobs) {
  const src = join(root, from);
  const dst = join(root, to);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[copy-assets] ${from} -> ${to}`);
}
