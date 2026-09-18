'use strict';
/**
 * 探针：`ready` 的通报时效真的让宠物松手了吗（ADR 021）。
 *
 * 为什么必须做真实窗口探针：单测只能证明**仲裁器的输出**变了（`ready` → `idle`），
 * 证明不了**渲染层真的跟着换帧**。而这条链路中间隔着两处会让状态"看起来生效、其实没生效"
 * 的接缝：`onStatus` 的一次性动作保护（`if (player.isOneShot) return`）与
 * `reconcileStatus` 的每帧收敛。历史上"状态层单测全绿、屏幕上却没变"踩过不止一次。
 *
 * 取证手段与 `spikes/m2-status/probe-status-e2e.js` 相同：给 `drawImage` 打补丁回读
 * `sy / 208`，即**当前实际绘制的帧行号**。行号是精灵图的语义坐标，不依赖任何日志自述 ——
 * `ready` 的落点是第 8 行（小厨师），退场后应回到第 0 行（idle）。
 *
 * 做法：把 `readyTimeoutMs` 压到 4 秒（默认 60 秒太长，探针等不起），
 * 注入一条 `ready`，然后**在 12 秒里持续采样行号**，要求：
 *   ① 早期确实画到第 8 行（waving 的第 3 行是过渡，一闪而过，不强制要求采到）；
 *   ② 超过 4 秒之后**不再**出现第 8 行（通报到期，宠物松手）。
 * 第二条是全部要害：没有它，这个探针在"缺陷仍然存在"时会照样通过。
 *
 * 用法：node spikes/m3-ready-exit/run.mjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'ready-exit.log');
const REPORT = path.join(__dirname, 'ready-exit.json');
const STATUS_FILE = path.join(__dirname, 'ready-exit-status.json');
const EVENT_LOG = path.join(__dirname, 'ready-exit-events.jsonl');

/** `ready` 的通报时效（ms）。压到 4 秒，探针才能在合理时间内看到退场。 */
const READY_MS = 4000;
/** 采样总时长（ms）。要明显长于 READY_MS，才能区分"到期前"与"到期后"。 */
const DURATION_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
globalThis.console = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

// 干净起点：上一次跑剩的状态文件会让首屏就不是 idle
try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(EVENT_LOG, { force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(REPORT, { force: true }); } catch (_) { /* ignore */ }

process.argv.push(`--status-file=${STATUS_FILE}`);
process.argv.push(`--event-log=${EVENT_LOG}`);
// 关掉自主行为层：漫游/微动作/打盹都会改帧行号，会把"是不是 ready 在画第 8 行"搅糊
// （打盹画的第 5 行与 blocked 共用，微动作还会画第 3/4 行）。
process.argv.push('--no-behavior');
// 通报时效压到 4 秒（探针专用，改的只是这一次运行的参数，不动宠物包）。
process.argv.push(`--ready-ms=${READY_MS}`);
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

/** 写一份"单会话 ready"的状态快照（与 pet-hook 的原子替换同款）。 */
function writeReady() {
  const body = {
    schema: 'desktop-pet/status/v1',
    sessions: { 'wb:probe-ready': { status: 'ready', title: '探针：干完了', ts: Date.now() } },
  };
  const tmp = `${STATUS_FILE}.tmp`;
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function waitForPetWindow(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find(
      (x) => !x.isDestroyed() && x.getTitle() === 'desktop-pet',
    );
    if (w && w.isVisible()) return w;
    await sleep(250);
  }
  throw new Error('未等到桌宠窗口');
}

app.whenReady().then(async () => {
  const report = { readyMs: READY_MS, durationMs: DURATION_MS, samples: [], failures: [] };
  try {
    const win = await waitForPetWindow(20000);
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);
    log(`[probe] 采样开始（readyMs=${READY_MS}）`);

    const t0 = Date.now();
    writeReady();
    const tInject = Date.now();
    report.injectedAt = tInject;

    while (Date.now() - t0 < DURATION_MS) {
      const raw = await win.webContents.executeJavaScript('window.__lastFrame()').catch(() => '');
      if (raw) {
        const [t, row] = raw.split(',');
        report.samples.push({ t: Number(t) - tInject, row: Number(row) });
      }
      await sleep(120);
    }
    report.ok = true;
    log(`[probe] 采样结束，共 ${report.samples.length} 个采样点`);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.failures.push('探针异常：' + report.error);
    log('[probe] 失败：' + report.error);
  }

  // —— 判定 ——
  // 分割点：注入后 [0, READY_MS) 是"通报期内"，[READY_MS, DURATION_MS] 是"到期后"。
  // 留 600ms 宽限，避免"到期那一瞬间正在渲染的那一帧"被判成违约。
  const GRACE = 600;
  const during = report.samples.filter((s) => s.t >= 0 && s.t < READY_MS - 200);
  const after = report.samples.filter((s) => s.t >= READY_MS + GRACE);

  const rowsDuring = [...new Set(during.map((s) => s.row))].sort((a, b) => a - b);
  const rowsAfter = [...new Set(after.map((s) => s.row))].sort((a, b) => a - b);
  report.rowsDuring = rowsDuring;
  report.rowsAfter = rowsAfter;

  // ① 通报期内必须画到第 8 行（小厨师 = ready 的落点）
  if (!rowsDuring.includes(8)) {
    report.failures.push(`通报期内没画到第 8 行（ready 的落点），实际行号 [${rowsDuring.join(',')}]`);
  }
  // ② 到期之后**不得**再出现第 8 行 —— 这条是全部要害
  if (rowsAfter.includes(8)) {
    report.failures.push(`到期后仍在画第 8 行（宠物没松手），实际行号 [${rowsAfter.join(',')}]`);
  }
  // ③ 到期后应落回第 0 行（idle）
  if (!rowsAfter.includes(0)) {
    report.failures.push(`到期后没回到第 0 行（idle），实际行号 [${rowsAfter.join(',')}]`);
  }

  report.verdict = report.failures.length === 0 ? 'PASS' : 'FAIL';
  log(`[probe] 通报期内行号=[${rowsDuring.join(',')}]`);
  log(`[probe] 到期后行号=[${rowsAfter.join(',')}]`);
  log(`[probe] 判定：${report.verdict}`);
  for (const f of report.failures) log('[probe] ✗ ' + f);

  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) { /* ignore */ }
  app.exit(report.verdict === 'PASS' ? 0 : 1);
});
