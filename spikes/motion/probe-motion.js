'use strict';
/**
 * 探针：系统「减少动态效果」（prefers-reduced-motion）会不会把动画冻住。
 *
 * 为什么要有这条判据：2026-09-23 用户分发给朋友后回报——**动作全是静态图、炒菜站着不动、
 * 左走右走只是平移**，而另一个朋友的机器一切正常。排查下来不是依赖缺失：渲染层
 * `renderer.ts` 读 `matchMedia('(prefers-reduced-motion: reduce)')` 后**关掉了帧推进**
 * （`tick()` 里的 `if (player && !reducedMotion) player.update(dt)`），
 * 于是 `setState` 虽然切到了对应行，帧索引却永远停在 0 —— 画面就是一张静态贴图。
 * 这个开关在不同机器上取值不同 ⇒ 同一份代码两种表现。
 *
 * 判据取**用户真正会看到的那个量**：直接对宠物窗口的 canvas 连续采样、比较像素变化。
 * 不用"帧索引"这类内部量（它会骗人：索引在推进但没重绘，用户看到的还是静止）。
 *
 * 两个用例：
 *   A. **idle 循环动画**：什么都不触发，光看它自己动不动；
 *   B. **手动把玩**：发 `play-action`（走主进程真实的命令处理器），看动作播不播。
 *      B 走 `ipcMain.emit` 而不是面板点击 —— 处理器签名是 `(_e, cmd)`、只用到 `cmd`，
 *      所以这样调是安全的，代价是绕过了 IPC 传输那一跳（判据要的是"命令→渲染层"这条链）。
 *
 * 用法：node spikes/motion/run.mjs
 *   带 `--force-reduce` 时打开 Chromium 的 force-prefers-reduced-motion，模拟那台机器。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'motion.log');
const REPORT = path.join(__dirname, 'motion.json');

const FORCE_REDUCE = process.argv.includes('--force-reduce');
const SAMPLES = 24;          // 每次用例的采样次数
const INTERVAL_MS = 70;      // 采样间隔（合计约 1.7 秒，够覆盖好几个动画帧）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (m) => { lines.push(m); try { fs.appendFileSync(LOG, m + '\n'); } catch (_) {} };
try { fs.writeFileSync(LOG, ''); } catch (_) {}
globalThis.console = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

// 必须在 app ready 之前挂上开关，否则不生效。
if (FORCE_REDUCE) app.commandLine.appendSwitch('force-prefers-reduced-motion');

process.argv.push('--expose-actions');
process.argv.push('--no-behavior');      // 只测动画本身，不让自主行为干扰
process.argv.push('--no-status-source');
require(path.join(DIST, 'main', 'index.js'));

const CH = require(path.join(DIST, 'shared', 'ipc.js')).CH;

/** 渲染层里读 matchMedia —— 探针直接问"这台机器的开关到底是什么状态"。 */
const READ_MEDIA = `(() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return 'ERR:' + e.message; }
})()`;

/**
 * 取当前画面的指纹。取 canvas 像素而不是内部帧索引 ——
 * 帧索引推进了但没重绘的话，用户看到的依然是静止（这正是"代理指标"陷阱）。
 */
const FRAME_HASH = `(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height);
  let h = 0;
  for (let i = 0; i < d.data.length; i += 61) h = (h * 33 + d.data[i]) & 0x7fffffff;
  return h;
})()`;

app.whenReady().then(async () => {
  const report = { forceReduce: FORCE_REDUCE, cases: {} };
  const fails = [];
  try {
    await sleep(2500);   // 等 init + 精灵图就绪 + rAF 起步

    const pet = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'desktop-pet');
    if (!pet) throw new Error('找不到标题为 desktop-pet 的宠物窗口');

    report.mediaMatches = await pet.webContents.executeJavaScript(READ_MEDIA);
    log('[probe] 渲染层 matchMedia(reduce) = ' + report.mediaMatches
      + '（--force-reduce=' + FORCE_REDUCE + '）');
    if (report.mediaMatches !== FORCE_REDUCE) {
      fails.push('matchMedia 与 --force-reduce 不符（开关没生效，本轮结果不可信）');
    }

    /** 采一段画面，返回 {distinct, switches, series}；switches = 相邻两次不同的次数。 */
    async function sample(label) {
      const hashes = [];
      for (let i = 0; i < SAMPLES; i++) {
        hashes.push(await pet.webContents.executeJavaScript(FRAME_HASH));
        await sleep(INTERVAL_MS);
      }
      const valid = hashes.filter((h) => typeof h === 'number');
      let switches = 0;
      for (let i = 1; i < valid.length; i++) if (valid[i] !== valid[i - 1]) switches++;
      // 序列概览：把每个 hash 映射成 A/B/C… 便于一眼看出"变化发生在哪"
      const letters = {};
      const series = valid.map((h) => {
        if (!(h in letters)) letters[h] = String.fromCharCode(65 + Object.keys(letters).length);
        return letters[h];
      }).join('');
      const r = { samples: hashes.length, valid: valid.length,
        distinct: new Set(valid).size, switches, series };
      report.cases[label] = r;
      log('[probe] ' + label + '：有效 ' + r.valid + '/' + r.samples
        + '，不同画面 ' + r.distinct + ' 种，相邻变化 ' + r.switches + ' 次');
      log('        序列 ' + series);
      if (r.valid === 0) fails.push(label + '：一次画面都没取到');
      else if (r.distinct <= 1) {
        fails.push(label + '：画面完全静止（' + r.valid + ' 次采样只有 ' + r.distinct
          + ' 种）—— 动画被冻住了');
      }
      return r;
    }

    // —— 用例 A：idle 循环动画（什么都不触发）——
    await sample('A-idle');

    // —— 用例 B：手动把玩一个循环动作 ——
    const list = (globalThis.__petDebug && globalThis.__petDebug.manualActions()) || [];
    const pick = list.find((a) => a.loop && a.state !== 'idle') || list[0];
    if (!pick) {
      fails.push('拿不到动作清单，用例 B 跳过');
    } else {
      report.playedAction = pick.state;
      log('[probe] 触发 play-action → ' + pick.state + '（' + (pick.label || '') + '，loop=' + pick.loop + '）');
      ipcMain.emit(CH.barCommand, {}, { id: 'play-action', arg: pick.state });
      await sleep(400);          // 让覆盖下发到渲染层
      await sample('B-play');
    }
  } catch (e) {
    report.error = String((e && e.stack) || e);
    fails.push('探针异常：' + report.error);
    log('[probe] 失败：' + report.error);
  }

  report.fails = fails;
  report.verdict = fails.length ? 'FAIL' : 'PASS';
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) {}
  const actions = globalThis.__petActions;
  if (actions) actions.quit();
  await sleep(2000);
  app.exit(0);
});
