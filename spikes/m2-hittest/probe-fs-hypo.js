'use strict';
/**
 * 验证根因假设：**窗口处于"分层穿透"状态时被隐藏，再显示后 Windows 会继续按穿透处理
 * 鼠标按钮事件**（移动事件正常，页面 visible，坐标正确）。
 *
 * 于是两种隐藏时机应当表现不同：
 *   C) 光标在宠物上（可交互态，T=false L=false）时隐藏 → 再显示后应当还能点；
 *   D) 光标不在宠物上（穿透态，T=true L=true）时隐藏 → 再显示后应当点不动。
 * 每个用例结束后用一次真实 resize 把状态复位，避免相互污染。
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-fs-hypo.js fs-hypo.json
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'fs-hypo.log');
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
const flags = (w) => {
  const v = GetWindowLongW(hwndOf(w), GWL_EXSTYLE) >>> 0;
  return { hex: '0x' + v.toString(16), T: !!(v & WS_EX_TRANSPARENT), L: !!(v & WS_EX_LAYERED) };
};

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
  const report = { cases: [] };
  try {
    const win = await waitForPetWindow(20000);
    const dpr = require('electron').screen.getPrimaryDisplay().scaleFactor;
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);
    const ev = () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)').then(JSON.parse);
    const centerPx = () => { const c = win.getContentBounds(); return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) }; };

    async function clickTest(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(320);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(320);
      const b = await ev();
      const got = b.down - a.down;
      log(`[probe]   ${label}: 真实点击 → pointerdown=${got}`);
      return got;
    }
    /** 真实 resize：把被污染的状态复位（探针里用来隔离用例）。 */
    async function forceResize() {
      const c = win.getContentBounds();
      win.setContentBounds({ x: c.x, y: c.y, width: c.width + 4, height: c.height + 4 });
      await sleep(250);
      win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 });
      await sleep(400);
    }

    async function testCase(name, prepareCursor, expect) {
      log(`[probe] ---- 用例 ${name} ----`);
      await prepareCursor();
      await sleep(450);
      const before = { flagsAtHide: flags(win) };
      log(`[probe]   隐藏前状态 T=${before.flagsAtHide.T} L=${before.flagsAtHide.L}`);
      win.hide();
      await sleep(1300);
      win.showInactive();
      await sleep(1500);
      const afterShow = flags(win);
      const got = await clickTest('显示后');
      const rec = { name, expect, flagsAtHide: before.flagsAtHide, flagsAfterShow: afterShow, click: got, verdict: got > 0 ? 'OK' : 'FAIL' };
      report.cases.push(rec);
      log(`[probe]   结论：${rec.verdict}（预期 ${expect}）；显示后 T=${afterShow.T} L=${afterShow.L}`);
      await forceResize();
      return rec;
    }

    const offPet = () => { const c = win.getContentBounds(); return moveTo(Math.round(c.x * dpr) - 600, Math.round(c.y * dpr) - 500); };
    const onPet = () => moveTo(centerPx().x, centerPx().y);

    await testCase('D 穿透态下隐藏', offPet, 'FAIL');
    await testCase('C 可交互态下隐藏', onPet, 'OK');
    await testCase('D 重现（穿透态下隐藏）', offPet, 'FAIL');
    await testCase('C 重现（可交互态下隐藏）', onPet, 'OK');

    fs.writeFileSync(path.join(__dirname, 'fs-hypo.json'), JSON.stringify(report, null, 1));
    log('[probe] 已写出 fs-hypo.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'fs-hypo.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
