'use strict';
/**
 * 端到端验证「状态源 → 仲裁器 → 动画」这条链（M2 第一步）。
 *
 * 为什么这样取证：GUI 进程拿不到 stdout，所以日志落盘；而"渲染层收到状态"还不足以证明
 * "画面真的换了" —— 这里直接在渲染层给 `CanvasRenderingContext2D.prototype.drawImage`
 * 打补丁，回读 `sy / 208` 即**当前正在绘制的帧行号**。行号是精灵图的语义坐标
 * （7=running、6=waiting、5=failed、3=waving、8=review、0=idle），因此
 * "行号出现过"就是"动画确实切过去了"的硬证据，不依赖任何日志自述。
 *
 * 外层驱动 run-status-e2e.mjs 负责扮演 agent 调 hook CLI 写状态文件。
 * 用法：node spikes/m2-status/run-status-e2e.mjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'status-e2e.log');
const REPORT = path.join(__dirname, 'status-e2e.json');
const STATUS_FILE = path.join(__dirname, 'status-e2e-status.json');
const EVENT_LOG = path.join(__dirname, 'status-e2e-events.jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
const myConsole = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
globalThis.console = myConsole;
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

// 干净起点：上一次跑剩的状态文件会让首屏就不是 idle
try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(EVENT_LOG, { force: true }); } catch (_) { /* ignore */ }

process.argv.push(`--status-file=${STATUS_FILE}`);
process.argv.push(`--event-log=${EVENT_LOG}`);
require(path.join(DIST, 'main', 'index.js'));

const CELL_H = 208;
const INJECT = `
(() => {
  window.__frames = [];
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.drawImage;
  proto.drawImage = function (img, sx, sy, sw, sh) {
    if (typeof sx === 'number' && typeof sy === 'number' && sh === 208) {
      window.__frames.push(Date.now() + ',' + (sy / 208));
    }
    return orig.apply(this, arguments);
  };
  window.__lastFrame = () => window.__frames.length ? window.__frames[window.__frames.length - 1] : '';
  return 'ok';
})()`;

const DURATION_MS = Number(process.env.PET_E2E_DURATION_MS || 34000);
// 运行标识：外层驱动靠它确认"我看到的这行日志是本次运行写的"。
// 没有它的话，驱动会读到上一次运行残留的日志，在探针还没开始采样时就动手注入
// （实测踩过：注入比采样早 3.7 秒，前两步全部丢失）。
const RUN = String(process.env.PET_E2E_RUN || 'local');

async function waitForPetWindow(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === 'desktop-pet');
    if (w && w.isVisible()) return w;
    await sleep(250);
  }
  throw new Error('未等到桌宠窗口');
}

app.whenReady().then(async () => {
  const report = { log: LOG, statusFile: STATUS_FILE, eventLog: EVENT_LOG, samples: [] };
  try {
    const win = await waitForPetWindow(20000);
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);
    log(`[probe] 采样开始 run=${RUN} epoch=${Date.now()}`);
    const t0 = Date.now();
    while (Date.now() - t0 < DURATION_MS) {
      const raw = await win.webContents.executeJavaScript('window.__lastFrame()').catch(() => '');
      if (raw) {
        const [t, row] = raw.split(',');
        report.samples.push({ t: Number(t), row: Number(row) });
      }
      await sleep(150);
    }
    report.ok = true;
    log(`[probe] 采样结束，共 ${report.samples.length} 个采样点`);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log('[probe] 失败：' + report.error);
  }
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) { /* ignore */ }
  app.exit(0);
});
