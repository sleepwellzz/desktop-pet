/**
 * 驱动：把 motion 探针跑两轮 —— 正常一轮、强制打开「减少动态效果」一轮。
 *
 * 两轮都必须 PASS。第二轮是本判据存在的理由：它模拟用户朋友那台机器，
 * 一旦回归（有人又把帧推进接回 matchMedia），这一轮会立刻红。
 *
 * 为什么不能用 spawnSync：Electron 是 GUI 子系统进程，在本环境里 spawnSync 会直接报
 * EBUSY 起不来（与"验证便携版必须走双击路径"同一类限制）。所以沿用既有探针的写法：
 * detached spawn + 轮询等报告落盘 + 按 pid 收尾。
 *
 * 用法：node spikes/motion/run.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径含空格 ⇒ 必须 fileURLToPath（手拼 `new URL().pathname` 会得到 %20，
// 然后 spawn electron 时找不到文件 —— 本工程这条坑已记过，这里又踩一次）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(HERE, 'probe-motion.js');
const REPORT = path.join(HERE, 'motion.json');
const LOG = path.join(HERE, 'motion.log');

if (!fs.existsSync(EXE)) {
  console.error('找不到 electron：' + EXE);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOnce(extraArgs, label) {
  for (const f of [REPORT, LOG]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;      // 宿主是 Electron：这个变量会让 electron.exe 退化成纯 node
  const child = spawn(EXE, [PROBE, ...extraArgs], {
    cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true,
  });
  child.unref();

  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 150000 && !fs.existsSync(REPORT)) await sleep(1500);
    // 按 pid 收尾（只杀我们这一棵进程树；绝不按 electron.exe 名字乱杀 —— 宿主也是 Electron）
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    await sleep(1500);

    console.log('════════ ' + label + ' ════════');
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { /* 下面处理 */ }
    if (!rep) {
      try { (fs.readFileSync(LOG, 'utf8') || '').split('\n').filter(Boolean).slice(-12).forEach((l) => console.log('  | ' + l)); } catch { /* ignore */ }
      console.log('  探针没产出报告');
      console.log('  判定：FAIL');
      console.log('');
      return false;
    }
    console.log('  matchMedia(reduce) = ' + rep.mediaMatches
      + '   触发的动作 = ' + (rep.playedAction || '(无)'));
    for (const [k, c] of Object.entries(rep.cases || {})) {
      console.log('  ' + k + '：不同画面 ' + c.distinct + ' 种，相邻变化 '
        + c.switches + ' 次   序列 ' + c.series);
    }
    if (rep.error) console.log('  异常：' + rep.error);
    (rep.fails || []).forEach((f) => console.log('  ✗ ' + f));
    console.log('  判定：' + rep.verdict);
    console.log('');
    return rep.verdict === 'PASS';
  })();
}

const a = await runOnce([], '① 正常（系统动画开着）');
const b = await runOnce(['--force-reduce'], '② 强制「减少动态效果」（模拟朋友的机器）');

console.log('════════ 汇总 ════════');
console.log('  ① 正常           ' + (a ? 'PASS' : 'FAIL'));
console.log('  ② 减少动态效果   ' + (b ? 'PASS' : 'FAIL'));
console.log('  总计             ' + (a && b ? 'PASS —— 动画在任何系统设置下都会播' : 'FAIL'));
process.exit(a && b ? 0 : 1);
