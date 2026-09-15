'use strict';
/**
 * 定位最后一环：到底是"隐藏/显示"本身，还是"显示之后我们自己的 setIgnoreMouseEvents"（spike → ADR 009）。
 *
 * 已知（实测）：
 *   - hide → showInactive 之后，真实鼠标按钮事件不再被路由到窗口，但 SendMessage 能进渲染层；
 *   - 由外部在**稍后**下发一次真实 SetWindowPos 能恢复；在 show 里紧接着下发却无效。
 * 推论：破坏发生在 show 之后，很可能是我们自己随后的 setIgnoreMouseEvents 调用。
 *
 * 本探针按顺序验证：
 *   A) 刚 show 完立刻 nudge → 点击？
 *   B) 紧接着 setIgnoreMouseEvents(true) → 点击？（= 我们自己那一下）
 *   C) 再 setIgnoreMouseEvents(false) → 点击？
 *   D) 再 nudge → 点击？（能否救回）
 *   E) 基线（未 hide 过）上反复开关 setIgnoreMouseEvents → 点击？（确认开关本身是否有毒）
 *   F) 用"移出屏幕"替代 hide：移走再移回 → 点击？（找替代方案）
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-toggle-poison.js toggle-poison.json
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'toggle-poison.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
const myConsole = { log: (...a) => log(a.map(String).join(' ')), error: (...a) => log('[ERROR] ' + a.map(String).join(' ')), warn: (...a) => log('[WARN] ' + a.map(String).join(' ')) };
globalThis.console = myConsole;
const console = myConsole;
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const GetWindowLongW = user32.func('int GetWindowLongW(void *h, int index)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
const flags = (w) => { const v = GetWindowLongW(hwndOf(w), GWL_EXSTYLE) >>> 0; return { hex: '0x' + v.toString(16), T: !!(v & WS_EX_TRANSPARENT), L: !!(v & WS_EX_LAYERED) }; };

const INJECT = `
window.__ev = { down: 0, move: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
window.addEventListener('pointermove', function () { window.__ev.move++; }, true);
'ok'`;

require(path.join(DIST, 'main', 'index.js'));

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
  const report = { steps: [] };
  try {
    const win = await waitForPetWindow(20000);
    const dpr = screen.getPrimaryDisplay().scaleFactor;
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);
    const ev = () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)').then(JSON.parse);
    const cb = () => win.getContentBounds();
    const centerPx = () => { const c = cb(); return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) }; };
    const nudge = () => { const c = cb(); win.setContentBounds({ x: c.x, y: c.y + 1, width: 144, height: 156 }); win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 }); };

    async function clickTest(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(320);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(320);
      const b = await ev();
      const got = b.down - a.down;
      const f = flags(win);
      report.steps.push({ label, click: got, flags: f });
      log(`[probe] ${label}: 点击=${got > 0 ? '✅ 进得去' : '❌ 进不去'} (T=${f.T} L=${f.L})`);
      return got;
    }

    log('[probe] ===== E 前置：基线（未 hide 过）反复开关 setIgnoreMouseEvents =====');
    await clickTest('E0 基线');
    win.setIgnoreMouseEvents(true); await sleep(200);
    win.setIgnoreMouseEvents(false); await sleep(200);
    await clickTest('E1 基线·开关一次后');

    log('[probe] ===== A/B/C/D：hide → show 之后逐步复现 =====');
    win.hide(); await sleep(1200); win.showInactive(); await sleep(900);
    await clickTest('A1 刚 show（尚未做任何事）');
    nudge(); await sleep(500);
    await clickTest('A2 show 后立刻 nudge');
    win.setIgnoreMouseEvents(true); await sleep(300);
    await clickTest('B1 紧接着 setIgnoreMouseEvents(true)');
    win.setIgnoreMouseEvents(false); await sleep(300);
    await clickTest('C1 再 setIgnoreMouseEvents(false)');
    nudge(); await sleep(500);
    await clickTest('D1 再 nudge（能否救回）');
    win.setIgnoreMouseEvents(true); await sleep(300);
    await clickTest('D2 救回后再 setIgnoreMouseEvents(true)');
    win.setIgnoreMouseEvents(false); await sleep(200);
    nudge(); await sleep(400);
    await clickTest('D3 收尾');

    log('[probe] ===== F：用"移出屏幕"替代 hide =====');
    const home = cb();
    moveTo(Math.round((home.x + 40) * dpr), Math.round((home.y + 40) * dpr)); await sleep(400);   // 光标挪到宠物上，确保是"可交互"态
    win.setContentBounds({ x: home.x - 4000, y: home.y - 4000, width: home.width, height: home.height });
    await sleep(900);
    const off = cb();
    log(`[probe] 已移出屏幕：${JSON.stringify(off)}`);
    win.setContentBounds({ x: home.x, y: home.y, width: home.width, height: home.height });
    await sleep(900);
    await clickTest('F1 移出屏幕再移回');

    fs.writeFileSync(path.join(__dirname, 'toggle-poison.json'), JSON.stringify(report, null, 1));
    log('[probe] 已写出 toggle-poison.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'toggle-poison.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
