// 构建戳：把「本次 dist 到底是从哪一份 src 构建出来的」落成一行可校验的哈希。
//
// 为什么需要（ADR 047）：
//   `tools/status-arbiter.test.mjs` 的行为断言 require 的是 `dist/**/*.js`，而 `dist/` 被 gitignore。
//   改完 `src/` 不重新构建就跑测试，会得到「结构性断言全绿（新源码）+ 行为断言全绿（旧 dist）」
//   的假全绿 —— 没有任何现行判据会在这条路径上变红（`typecheck` 用 `--noEmit` 不产出 JS）。
//
// 为什么用**内容哈希**而不是 mtime：
//   mtime 验证法在这个项目已经骗过人一次 —— 六份入库的探针证据内容是 09-18 的、mtime 是 09-22 的，
//   「比 src 新」成立而「是这次构建的」不成立（ADR 纪律 3(b) 问的是后者，mtime 答不了）。
//   git checkout / 文件复制都会重写 mtime，两者同样不可信。哈希只认内容。
//
// 用法：
//   node tools/stamp-build.mjs          构建后调用，写 dist/.build-stamp.json
//   node tools/stamp-build.mjs --check  只校验当前 src 哈希与戳是否一致（不写）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STAMP_PATH = join(root, 'dist', '.build-stamp.json');

// 只有这些扩展名参与哈希：注释与格式改动会改变它们（那也是要重新构建的），
// 而 .map 之类产物不进 src，排除它们只会让戳对不相关文件敏感。
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.json', '.html', '.css']);

export function listSrcFiles(dir = join(root, 'src')) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (SRC_EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** src/ 全量内容的哈希。与顺序无关（先排序），与路径分隔符写法无关（统一转 /）。 */
export function computeSrcHash() {
  const h = createHash('sha256');
  for (const p of listSrcFiles()) {
    h.update(relative(root, p).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(p));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * dist 里必须存在、且必须由本次构建产出的文件。缺任何一个说明构建没跑完。
 * 这份清单是 **tests 实际 require 的东西**（不是“应该有”的东西）——
 * 手写一份“应该存在的产物”清单会写出 `kernel/status-file.js` 这种不存在的路径
 * （它实际在 source/ 下），然后把一个健康的构建判成失败。
 * 所以每一条都对应本文件里一处真实的 require 或 require 触发的模块图。
 */
export const REQUIRED_DIST = [
  // —— 行为断言直接 require 的五处（status-arbiter.test.mjs 顶部）——
  'kernel/status.js',
  'kernel/player.js',
  'kernel/motion-policy.js',
  'source/status-file.js',
  // —— 结构性用例里 require 的（bubble-policy / bar-policy / behavior / manual-play / pack / pet-menu）——
  'kernel/bubble-policy.js',
  'kernel/bar-policy.js',
  'kernel/behavior.js',
  'kernel/manual-play.js',
  'kernel/pack.js',
  'host/pet-menu.js',
  // —— build:main 之后的 tsc 产物 ——
  'main/index.js',
  // —— esbuild 产物：三个 preload + 三个 renderer。注意 preload 的文件名与源码不同名，
  //    而且这里列的必须是**实际被加载**的那几个（ADR 023 之前存在同名诱饵）。——
  'main/preload.js',
  'main/bubble-preload.js',
  'main/bar-preload.js',
  'renderer/renderer.js',
  'renderer/bubble.js',
  'renderer/control-bar.js',
];

export function readStamp() {
  if (!existsSync(STAMP_PATH)) return null;
  try { return JSON.parse(readFileSync(STAMP_PATH, 'utf8')); } catch { return null; }
}

export function writeStamp() {
  const stamp = { srcHash: computeSrcHash(), at: new Date().toISOString() };
  mkdirSync(dirname(STAMP_PATH), { recursive: true });
  writeFileSync(STAMP_PATH, JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  return stamp;
}

/**
 * 校验 dist 是否与当前 src 一致。
 * 返回 { ok, reasons[] } —— reasons 里每条都是能直接照着做的修复动作。
 */
export function verifyDist() {
  const reasons = [];
  const missing = REQUIRED_DIST.filter((f) => !existsSync(join(root, 'dist', f)));
  if (missing.length) reasons.push(`dist 缺少产物：${missing.join('、')}（构建没跑完）`);

  const stamp = readStamp();
  if (!stamp) {
    reasons.push('dist/.build-stamp.json 不存在 —— 构建链没有写戳，或 dist 是手工拼出来的');
  } else {
    const now = computeSrcHash();
    if (now !== stamp.srcHash) {
      reasons.push(`src 已改动但 dist 不是它的产物（src 哈希 ${now} ≠ 戳 ${stamp.srcHash}，戳写于 ${stamp.at}）`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--check')) {
    const { ok, reasons } = verifyDist();
    if (ok) { process.stdout.write('dist 与 src 一致\n'); process.exit(0); }
    process.stderr.write('dist 与 src 不一致：\n' + reasons.map((r) => `  - ${r}`).join('\n') + '\n');
    process.exit(1);
  }
  const s = writeStamp();
  process.stdout.write(`构建戳已写入 dist/.build-stamp.json  srcHash=${s.srcHash}  at=${s.at}\n`);
}
