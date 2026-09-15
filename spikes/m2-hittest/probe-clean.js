'use strict';
/**
 * 干净版最小实验（spike → ADR 009）：全程不直接碰 setIgnoreMouseEvents，避免污染应用记账。
 *
 *   1) 基线：光标移到宠物上 → 单击（预期 ✅）
 *   2) hide → showInactive
 *   3) 光标移到宠物上 → 单击（预期 ❌）
 *   4) 把光标移开再移回，观察 WS_EX_TRANSPARENT 是否仍随光标正确切换
 *      —— 用于判断"应用自己的开关是否还有效"
 *   5) 一次真实 nudge 后再单击（能否救回）
 *   6) webContents.reload() 后再单击（另一个候选修法）
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-clean.js clean.json
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'clean.log');
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
const flags = (w) => { const v = GetWindowLongW(hwndOf(w), GWL_EXSTYLE) >>> 0; return { T: !!(v & WS_EX_TRANSPARENT), L: !!(v & WS_EX_LAYERED), hex: '0x' + v.toString(16) }; };

const INJECT = `
window.__ev = { down: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
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
    await win.webContents.executeJavaScript(INJECT).catch(() => {});
    const ev = () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)').then(JSON.parse).catch(() => ({ down: 0 }));
    const cb = () => win.getContentBounds();
    const centerPx = () => { const c = cb(); return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) }; };
    const awayPx = () => { const c = cb(); return { x: Math.round((c.x - 400) * dpr), y: Math.round((c.y - 300) * dpr) }; };

    async function ensureInject() {
      await win.webContents.executeJavaScript(INJECT).catch(() => {});
    }
    async function clickTest(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(420);
      const fBefore = flags(win);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(320);
      const b = await ev();
      const got = b.down - a.down;
      const rec = { label, click: got, flagsAtClick: fBefore };
      report.steps.push(rec);
      log(`[probe] ${label}: 点击=${got > 0 ? '✅ 进得去' : '❌ 进不去'}  (点击瞬间 T=${fBefore.T} L=${fBefore.L})`);
      return got;
    }

    log('[probe] ---- 1) 基线 ----');
    await clickTest('1 基线');

    log('[probe] ---- 2) hide + showInactive ----');
    win.hide(); await sleep(1500); win.showInactive(); await sleep(1500);
    await clickTest('2 显示后');

    log('[probe] ---- 4) 光标移开再移回，看开关是否仍有效 ----');
    moveTo(awayPx().x, awayPx().y); await sleep(800);
    const fa = flags(win);
    log(`[probe] 光标移开后 T=${fa.T} L=${fa.L}（光标不在宠物上，期望 T=true）`);
    moveTo(centerPx().x, centerPx().y); await sleep(800);
    const fb = flags(win);
    log(`[probe] 光标移回后 T=${fb.T} L=${fb.L}（光标在宠物上，期望 T=false）`);
    report.toggleAfterShow = { away: fa, onPet: fb };
    await clickTest('4 移开再移回后');

    log('[probe] ---- 5) 一次真实 nudge ----');
    const c = cb();
    win.setContentBounds({ x: c.x, y: c.y + 1, width: c.width, height: c.height });
    await sleep(250);
    win.setContentBounds({ x: c.x, y: c.y, width: c.width, height: c.height });
    await sleep(700);
    await clickTest('5 nudge 后');

    log('[probe] ---- 6) 重新加载页面 ----');
    await win.webContents.reload();
    await sleep(3500);
    await ensureInject();
    await clickTest('6 reload 后');

    fs.writeFileSync(path.join(__dirname, 'clean.json'), JSON.stringify(report, null, 1));
    log('[probe] 已写出 clean.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'clean.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
