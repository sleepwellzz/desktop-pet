'use strict';
/**
 * 探针：宠物隐藏时两个高频定时器（33ms 行为层 / 16ms 光标轮询）**真的停了**。
 *
 * 为什么必须跑真实窗口：这是主进程的定时器生命周期，纯函数单测碰不到；
 * 而"停没停"在屏幕上没有任何表现（宠物本来就是藏起来的），只能靠计数器与开关位去量。
 *
 * 判据纪律（本项目栽过两次的同一种错）：**两次读数之间必须留出足够的时间窗**，
 * 让"定时器在跑"与"定时器停了"这两种状态在计数上区分得开 ——
 * 33ms 的定时器在 800ms 里应当产生 ~24 次 tick，与"0 次"是量级差异，不会被抖动掩盖。
 *
 * 用法：node spikes/m3-hidden-timers/run.mjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'run.log');
const REPORT = path.join(__dirname, 'report.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
globalThis.console = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

// 关掉自主行为层：本探针只关心"定时器在不在转"，宠物真走起来反而会引入变量。
// 注意 `tickBehaviorLayer` 不会因为 --no-behavior 而停止（策略停用 ≠ 定时器停），
// 所以 `behaviorTicks` 仍然是一个有效的"定时器还在转"的证据。
process.argv.push('--no-behavior');
process.argv.push('--expose-actions');
process.argv.push('--no-status-source');
require(path.join(DIST, 'main', 'index.js'));

app.whenReady().then(async () => {
  const report = { steps: [] };
  try {
    const waitFor = async (title, timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === title);
        if (w) return w;
        await sleep(250);
      }
      return null;
    };
    const pet = await waitFor('desktop-pet', 20000);
    if (!pet) throw new Error('未等到桌宠窗口');
    await sleep(2500);
    const dbg = globalThis.__petDebug;
    const actions = globalThis.__petActions;
    if (!dbg || !actions) throw new Error('拿不到 __petDebug / __petActions');

    /** 在一个时间窗里量 tick 增量。 */
    const sample = async (ms) => {
      const a = dbg.behaviorTicks();
      await sleep(ms);
      return { from: a, to: dbg.behaviorTicks(), delta: dbg.behaviorTicks() - a, ms };
    };

    // —— ① 前置：可见时定时器在转（否则后面的"停了"毫无意义）——
    const visibleRun = await sample(800);
    const runningWhenVisible = dbg.timersRunning();
    report.visible = { ...visibleRun, runningWhenVisible, petVisible: pet.isVisible() };
    log(`[probe] 可见时：timersRunning=${runningWhenVisible}，800ms 内 tick 增量=${visibleRun.delta}`);

    // —— ② 隐藏：定时器必须停 ——
    actions.toggleVisibility();
    await sleep(1500);                       // 等 hide 事件走到 stopTimers
    const hiddenRun = await sample(1000);
    const runningWhenHidden = dbg.timersRunning();
    report.hidden = { ...hiddenRun, runningWhenHidden, petVisible: pet.isVisible() };
    log(`[probe] 隐藏时：petVisible=${pet.isVisible()}，timersRunning=${runningWhenHidden}，1000ms 内 tick 增量=${hiddenRun.delta}（期望 0）`);

    // —— ③ 恢复：定时器必须重新起来（漏了这条就是"藏一次之后宠物再也不动"）——
    actions.toggleVisibility();
    await sleep(2500);                       // resumePet 会 reload 渲染层，给它一点时间
    const resumedRun = await sample(800);
    const runningWhenResumed = dbg.timersRunning();
    report.resumed = { ...resumedRun, runningWhenResumed, petVisible: pet.isVisible() };
    log(`[probe] 恢复后：petVisible=${pet.isVisible()}，timersRunning=${runningWhenResumed}，800ms 内 tick 增量=${resumedRun.delta}`);

    // —— 判定 ——
    const fails = [];
    if (!report.visible.petVisible) fails.push('前置不成立：宠物一开始就不可见');
    if (!runningWhenVisible) fails.push('可见时定时器没在跑（前置不成立）');
    if (visibleRun.delta <= 0) fails.push(`可见时 tick 增量为 ${visibleRun.delta}（前置不成立）`);
    if (report.hidden.petVisible) fails.push('toggleVisibility 没有把宠物藏起来（前置不成立）');
    if (runningWhenHidden) fails.push('宠物隐藏后定时器仍在跑');
    if (hiddenRun.delta !== 0) fails.push(`宠物隐藏后 tick 仍在增加（${hiddenRun.delta} 次/1000ms）`);
    if (!report.resumed.petVisible) fails.push('恢复显示失败（resumePet 没把宠物叫回来）');
    if (!runningWhenResumed) fails.push('恢复显示后定时器没有重启（宠物将永远不动）');
    if (resumedRun.delta <= 0) fails.push(`恢复显示后 tick 增量为 ${resumedRun.delta}（定时器没真的转起来）`);
    report.failures = fails;
    report.verdict = fails.length === 0 ? 'PASS' : 'FAIL';
    log(`[probe] 判定：${report.verdict}${fails.length ? ' —— ' + fails.join('；') : ''}`);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log('[probe] 失败：' + report.error);
  }
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) { /* ignore */ }
  const actions = globalThis.__petActions;
  if (actions) actions.quit();
  await sleep(2500);
  app.exit(0);
});
