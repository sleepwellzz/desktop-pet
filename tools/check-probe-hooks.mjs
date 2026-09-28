// 探针静态一致性检查：不启动 Electron 就能发现"探针调用的调试钩子已经不存在"。
//
// 为什么需要（ADR 047）：
//   `spikes/*/probe-*.js` 通过 `globalThis.__petDebug` 调主进程的调试钩子。
//   **删除一个功能时，钩子会被删掉，而调用它的探针不会收到任何通知** ——
//   探针会在 `dbg.hotkey()` 处抛 `TypeError`，走不到写报告那步，于是：
//     · 判据跑不出任何新证据；
//     · 而 run.mjs 又在 spawn 前把**上一轮的入库证据删掉了**（rmSync），
//       ⇒ "跑一次必跑判据"的净效果是**既没验成、又丢了历史证据**。
//   这个组合在 `spikes/m2-hotkey` 上真实发生过（ADR 032 删掉全局快捷键之后）。
//   它不启动 Electron 就能静态发现 —— 这正是它该有的形状：**能便宜发现的，不要留到贵的那一步**。
//
// 查什么：探针里 `dbg.<name>(` 的每个名字，必须出现在主进程 `__petDebug` 桥的对象字面量里。
//
// 用法：node tools/check-probe-hooks.mjs      （只读，不改任何文件）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 从主进程源码里抽出 __petDebug 桥暴露的键名。 */
export function extractDebugHooks(mainSrc) {
  const start = mainSrc.indexOf('g.__petDebug = {');
  if (start < 0) throw new Error('main/index.ts 里找不到 __petDebug 桥');
  const body = mainSrc.slice(start);
  const keys = new Set();
  for (const m of body.matchAll(/^\s{6}(\w+):/gm)) keys.add(m[1]);
  return keys;
}

/**
 * 抽出一个探针文件里用到的 dbg.<name>。
 *
 * 必须先去注释：`m2-control/probe-key-path.js:97` 的注释里写着
 * “（原日志里的 `快捷键=${dbg.hotkey()}` 已随全局快捷键一并删除，ADR 032。）”
 * —— 那是一条**正确维护过的注释**，而按裸文本匹配会把它当成真实调用并误报。
 * 判据把注释当代码 ⇒ 它的失败会变成噪音，而噪音是让人忽略判据的头号原因
 * （本项目 ADR 042 之后自己定的纪律：“断言不该被它测以外的东西判红”）。
 * 这里复用 status-arbiter.test.mjs 里同款的 stripComments 思路。
 */
export function extractUsedHooks(probeSrc) {
  const code = stripComments(probeSrc);
  const used = new Map(); // name -> 首次出现的行号（1-indexed，行号按原文算）
  for (const m of code.matchAll(/\bdbg\.(\w+)\s*\(/g)) {
    const line = probeSrc.slice(0, m.index).split('\n').length;
    if (!used.has(m[1])) used.set(m[1], line);
  }
  return used;
}

/** 去块注释与行注释，但**保留字符数**以便行号仍对应原文。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function listProbeFiles(dir = join(root, 'spikes')) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); }
      else if (/^probe.*\.(js|mjs|cjs)$/.test(name) || /^run.*\.mjs$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function checkProbeHooks() {
  const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
  const hooks = extractDebugHooks(mainSrc);
  const problems = [];
  const checked = [];

  for (const f of listProbeFiles()) {
    const src = readFileSync(f, 'utf8');
    // 只查真正跑在主进程里的探针体（run.mjs 是驱动，不直接调 dbg）
    const used = extractUsedHooks(src);
    if (used.size === 0) continue;
    const rel = relative(root, f).split('\\').join('/');
    for (const [name, line] of used) {
      if (hooks.has(name)) checked.push(`${rel}:${line} dbg.${name}`);
      else problems.push(`${rel}:${line} 调用了 dbg.${name}()，但 __petDebug 桥里没有这个钩子`);
    }
  }
  return { ok: problems.length === 0, problems, checked, hooks: [...hooks].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = checkProbeHooks();
  process.stdout.write(`__petDebug 桥暴露 ${r.hooks.length} 个钩子；核对 ${r.checked.length} 处探针调用\n`);
  for (const c of r.checked) process.stdout.write(`  ok   ${c}\n`);
  if (!r.ok) {
    process.stderr.write('\n探针引用了不存在的调试钩子（跑起来会在那一行抛 TypeError）：\n');
    for (const p of r.problems) process.stderr.write(`  FAIL ${p}\n`);
    process.stderr.write(
      '\n两种可能，请分辨后再改：\n'
      + '  (a) 功能被删了（例：ADR 032 删掉全局快捷键）⇒ 从探针里删掉该用例，\n'
      + '      并同步 docs/constraints/build-probe.md 里“必跑判据”的指向；\n'
      + '  (b) 钩子被改名/漏加 ⇒ 补回 __petDebug 桥。\n'
      + '注意：在改之前先看该探针的 run.mjs 是否会在 spawn 前 rmSync 掉已入库的证据 ——\n'
      + '      那样的话“跑一次必跑判据”的净效果是既没验成、又丢了历史证据。\n');
    process.exit(1);
  }
  process.stdout.write('\n全部一致\n');
}
