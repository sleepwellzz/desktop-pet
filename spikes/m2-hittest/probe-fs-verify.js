'use strict';
/**
 * 验证「全屏让位回来后宠物能继续拖动」（spike，结论回写 ADR 009）。
 *
 * 用**外部进程**做全屏应用（fs-child.js），走真实的全屏让位路径：
 * 宠物隐藏 → 外部全屏退出 → 宠物恢复 → 单击/拖动测试。
 * 全程记录 WS_EX_TRANSPARENT、页面可见性、窗口内容区bounds、指针事件计数。
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-fs-verify.js fs-verify.json
 */
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'fs-verify.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
const myConsole = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
globalThis.console = myConsole;
const console = myConsole;
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
koffi.struct('V_POINT', { x: 'int', y: 'int' });
koffi.struct('V_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT_SIZE = koffi.sizeof('V_POINT');
const RECT_SIZE = koffi.sizeof('V_RECT');
const GetCursorPos = user32.func('bool GetCursorPos(V_POINT *pt)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const GetWindowRect = user32.func('bool GetWindowRect(void *h, V_RECT *r)');
const GetWindowLongW = user32.func('int GetWindowLongW(void *h, int index)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
function rectOf(w) {
  const b = Buffer.alloc(RECT_SIZE);
  if (!GetWindowRect(hwndOf(w), b)) return null;
  const r = { left: b.readInt32LE(0), top: b.readInt32LE(4), right: b.readInt32LE(8), bottom: b.readInt32LE(12) };
  return { ...r, w: r.right - r.left, h: r.bottom - r.top };
}
const transparent = (w) => !!(GetWindowLongW(hwndOf(w), GWL_EXSTYLE) & WS_EX_TRANSPARENT);

const INJECT = `
window.__ev = { down: 0, up: 0, move: 0, cancel: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
document.addEventListener('pointerup', function () { window.__ev.up++; }, true);
document.addEventListener('pointercancel', function () { window.__ev.cancel++; }, true);
window.addEventListener('pointermove', function () { window.__ev.move++; }, true);
window.__vis = () => document.visibilityState + '/' + (window.innerWidth + 'x' + window.innerHeight);
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
async function waitUntil(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(250);
  }
  log(`[probe] 等待超时：${what}`);
  return false;
}

app.whenReady().then(async () => {
  const report = { rounds: [] };
  try {
    const win = await waitForPetWindow(20000);
    const dpr = screen.getPrimaryDisplay().scaleFactor;
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);

    const ev = () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)').then((s) => JSON.parse(s)).catch(() => ({ down: 0, up: 0, move: 0, cancel: 0 }));
    // 恢复显示后渲染层会被重载（修复手段），注入的计数器随之消失，必须重新注入
    const reInject = async () => { await win.webContents.executeJavaScript(INJECT).catch(() => {}); };
    const centerPx = () => {
      const c = win.getContentBounds();
      return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) };
    };
    const snapshot = async (label) => ({
      label,
      visible: win.isVisible(),
      transparent: transparent(win),
      content: win.getContentBounds(),
      physical: rectOf(win),
      page: await win.webContents.executeJavaScript('window.__vis()'),
    });

    async function clickTest(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(300);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(320);
      const b = await ev();
      const got = b.down - a.down;
      log(`[probe] ${label}：pointerdown=${got} → ${got > 0 ? '✅ 可点击' : '❌ 点不进去'}`);
      return got;
    }
    async function dragTest(label) {
      const c0 = win.getContentBounds();
      const from = { x: Math.round((c0.x + c0.width / 2) * dpr), y: Math.round((c0.y + c0.height / 2) * dpr) };
      const to = { x: from.x - 400, y: from.y - 300 };
      const a = await ev();
      moveTo(from.x, from.y); await sleep(300);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
      for (let i = 1; i <= 10; i++) {
        moveTo(Math.round(from.x + (to.x - from.x) * i / 10), Math.round(from.y + (to.y - from.y) * i / 10));
        await sleep(55);
      }
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(300);
      const b = await ev();
      const c1 = win.getContentBounds();
      const moved = c1.x !== c0.x || c1.y !== c0.y;
      const r = { moved, delta: { dx: c1.x - c0.x, dy: c1.y - c0.y }, events: { down: b.down - a.down, up: b.up - a.up, move: b.move - a.move, cancel: b.cancel - a.cancel } };
      log(`[probe] ${label}：窗口${moved ? '已移动 ' + JSON.stringify(r.delta) : '未移动'}；down=${r.events.down} up=${r.events.up} move=${r.events.move} cancel=${r.events.cancel} → ${moved ? '✅ 可拖动' : '❌ 拖不动'}`);
      return r;
    }

    async function round(n) {
      const rec = { round: n };
      log(`[probe] ======== 第 ${n} 轮 ========`);
      moveTo(centerPx().x, centerPx().y); await sleep(500);
      rec.before = await snapshot('全屏前');
      rec.click = await clickTest('全屏前单击');
      rec.drag = await dragTest('全屏前拖动');
      rec.before2 = await snapshot('全屏前·拖动后');

      log('[probe] 启动外部全屏应用 …');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(process.execPath, [path.join(__dirname, 'fs-child.js'), '--life=8000'], { stdio: 'ignore', env, windowsHide: true });
      const hid = await waitUntil(() => !win.isVisible(), 12000, '宠物隐藏');
      rec.hidden = { ok: hid, snapshot: await snapshot('全屏中') };
      log(`[probe] 宠物已隐藏=${hid}`);
      await waitUntil(() => win.isVisible(), 15000, '宠物恢复显示');
      await sleep(2500);          // 等重载完成（页面重载 → 重新报到 → 重新下发 init）
      await reInject();
      await sleep(400);
      rec.restored = await snapshot('全屏后·已恢复');
      log(`[probe] 宠物已恢复显示=${win.isVisible()}`);

      moveTo(centerPx().x, centerPx().y); await sleep(600);
      rec.clickAfter = await clickTest('全屏后单击');
      rec.dragAfter = await dragTest('全屏后拖动');
      rec.after = await snapshot('全屏后·拖动之后');
      try { child.kill(); } catch (_) { /* ignore */ }
      await sleep(500);
      report.rounds.push(rec);
      return rec;
    }

    await round(1);
    await sleep(1500);
    await round(2);

    fs.writeFileSync(path.join(__dirname, 'fs-verify.json'), JSON.stringify(report, null, 1));
    const r1 = report.rounds[0], r2 = report.rounds[1];
    log(`[probe] 结论：第1轮 全屏后单击=${r1.clickAfter > 0 ? 'OK' : 'FAIL'} 拖动=${r1.dragAfter.moved ? 'OK' : 'FAIL'}；`
      + `第2轮 全屏后单击=${r2.clickAfter > 0 ? 'OK' : 'FAIL'} 拖动=${r2.dragAfter.moved ? 'OK' : 'FAIL'}`);
    log('[probe] 已写出 fs-verify.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'fs-verify.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
