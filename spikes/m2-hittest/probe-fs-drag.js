'use strict';
/**
 * 复现并定位：全屏一次之后宠物无法再被拖动（spike，结论回写 ADR 009）。
 *
 * 已确认的现象（见 fs-drag.log 第一版）：全屏循环后点击**完全到不了宠物**
 * （pointerdown 0 次），拖动自然不可能。剩下要区分的是：
 *   A1) 主进程的光标 hint 不再送达渲染层 → 没人去切；
 *   A2) hint 到了、渲染层也判定为实体，但状态被缓存挡住 / 切换不生效；
 *   A3) OS 层的 setIgnoreMouseEvents(false) 在 hide/show 之后本身失效。
 *
 * 判定手段：
 *   - 直接读窗口扩展样式位（GWL_EXSTYLE 的 WS_EX_TRANSPARENT），看 OS 真实状态；
 *   - 在渲染层再挂一个 onPointerHint 监听器，数 hint 到达次数；
 *   - 从探针侧直接调 setIgnoreMouseEvents(false) 再单击，验证 OS 层 API 本身是否可用。
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-fs-drag.js fs-drag.json
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'fs-drag.log');
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
process.on('unhandledRejection', (e) => log('[unhandled] ' + ((e && e.stack) || e)));

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
koffi.struct('F_POINT', { x: 'int', y: 'int' });
const POINT_SIZE = koffi.sizeof('F_POINT');
const GetCursorPos = user32.func('bool GetCursorPos(F_POINT *pt)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const GetWindowLongW = user32.func('int GetWindowLongW(void *h, int index)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
const cursorPos = () => { const b = Buffer.alloc(POINT_SIZE); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; };

function hwndOf(win) {
  const raw = win.getNativeWindowHandle();
  return raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0);
}
function exstyle(win) {
  const v = GetWindowLongW(hwndOf(win), GWL_EXSTYLE) >>> 0;
  return {
    hex: '0x' + v.toString(16),
    TRANSPARENT: !!(v & WS_EX_TRANSPARENT),   // 置位 = 整窗穿透
    LAYERED: !!(v & WS_EX_LAYERED),
  };
}

const INJECT = `
window.__ev = { down: 0, up: 0, move: 0, cancel: 0 };
window.__hints = 0;
window.__lastHint = null;
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
document.addEventListener('pointerup', function () { window.__ev.up++; }, true);
document.addEventListener('pointercancel', function () { window.__ev.cancel++; }, true);
window.addEventListener('pointermove', function () { window.__ev.move++; }, true);
window.pet.onPointerHint(function (h) { window.__hints++; window.__lastHint = h; });
'done'`;

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
    const petWin = await waitForPetWindow(20000);
    const dpr = screen.getPrimaryDisplay().scaleFactor;
    await sleep(2500);
    await petWin.webContents.executeJavaScript(INJECT);
    log('[probe] 已注入事件计数与 hint 计数');

    const ev = () => petWin.webContents.executeJavaScript('JSON.stringify(window.__ev)').then(JSON.parse);
    const hints = () => petWin.webContents.executeJavaScript('window.__hints').then(Number);
    const centerPx = () => {
      const c = petWin.getContentBounds();
      return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) };
    };
    const step = async (label, extra = {}) => {
      const vis = await petWin.webContents.executeJavaScript(
        'JSON.stringify({ visibility: document.visibilityState, hidden: document.hidden, focus: document.hasFocus() })')
        .then(JSON.parse).catch((e) => ({ err: String(e) }));
      const row = { label, exstyle: exstyle(petWin), visible: petWin.isVisible(), ...extra, page: vis };
      report.steps.push(row);
      const e = row.exstyle;
      log(`[probe] ${label}：可见=${row.visible} TRANSPARENT=${e.TRANSPARENT} LAYERED=${e.LAYERED} (${e.hex})`
        + ` 页面 visibilityState=${vis.visibility} hidden=${vis.hidden} hasFocus=${vis.focus}`
        + (extra.note ? '  ' + extra.note : ''));
      return row;
    };

    async function clickTest(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(260);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(45);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(260);
      const b = await ev();
      const got = b.down - a.down;
      log(`[probe] ${label}：pointerdown ${got} 次 → ${got > 0 ? '可交互' : '点击被穿透'}`);
      return got;
    }
    async function dragTest(label) {
      const c0 = petWin.getContentBounds();
      const from = { x: Math.round((c0.x + c0.width / 2) * dpr), y: Math.round((c0.y + c0.height / 2) * dpr) };
      const to = { x: from.x - 400, y: from.y - 300 };
      const a = await ev();
      moveTo(from.x, from.y); await sleep(260);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
      for (let i = 1; i <= 10; i++) {
        moveTo(Math.round(from.x + (to.x - from.x) * i / 10), Math.round(from.y + (to.y - from.y) * i / 10));
        await sleep(55);
      }
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(260);
      const b = await ev();
      const c1 = petWin.getContentBounds();
      const r = {
        moved: c1.x !== c0.x || c1.y !== c0.y, delta: { dx: c1.x - c0.x, dy: c1.y - c0.y },
        events: { down: b.down - a.down, up: b.up - a.up, move: b.move - a.move, cancel: b.cancel - a.cancel },
      };
      log(`[probe] ${label}：窗口${r.moved ? '已移动 ' + JSON.stringify(r.delta) : '未移动'}；`
        + `down=${r.events.down} up=${r.events.up} move=${r.events.move} cancel=${r.events.cancel}`);
      return r;
    }

    /**
     * 把主进程发下来的 hint 载荷抓出来，和"按 getContentBounds 推算的期望客户区坐标"比对。
     * 映射一旦错位，hitAt 就会判成空白 → 窗口永远切不回可交互 → 点击全部穿透。
     */
    async function hintProbe(label) {
      const c = petWin.getContentBounds();
      const rows = [];
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.7]]) {
        const px = Math.round((c.x + c.width * fx) * dpr);
        const py = Math.round((c.y + c.height * fy) * dpr);
        await petWin.webContents.executeJavaScript('window.__lastHint = null');
        moveTo(px, py);
        await sleep(340);
        const raw = await petWin.webContents.executeJavaScript('JSON.stringify(window.__lastHint)');
        const hint = raw === 'null' ? null : JSON.parse(raw);
        const want = { x: +(c.width * fx).toFixed(1), y: +(c.height * fy).toFixed(1) };
        const off = hint ? { x: +(hint.cssX - want.x).toFixed(1), y: +(hint.cssY - want.y).toFixed(1) } : null;
        log(`[probe] ${label} hint采样 物理(${px},${py}) 期望客户区(${want.x},${want.y}) → 收到 ${JSON.stringify(hint)} 偏差 ${JSON.stringify(off)}`);
        rows.push({ fraction: [fx, fy], physical: { x: px, y: py }, wantClient: want, hint, offset: off });
      }
      log(`[probe] ${label} 当时的 getContentBounds=${JSON.stringify(c)}（DIP）`);
      return { contentBounds: c, rows };
    }

    // ---------- 基线 ----------
    log(`[probe] 光标坐标单位核对：Electron screen.getCursorScreenPoint()=${JSON.stringify(screen.getCursorScreenPoint())}`
      + `  Win32 物理=${JSON.stringify(cursorPos())}  scaleFactor=${dpr}`);
    moveTo(centerPx().x, centerPx().y); await sleep(500);
    await step('基线·光标在宠物上');
    report.baseline = { click: await clickTest('基线单击'), drag: await dragTest('基线拖动') };
    await step('基线·拖动结束（光标已离开宠物）');
    report.baselineHints = await hintProbe('基线');
    await step('基线·hint 采样后');

    // ---------- 全屏循环 ----------
    const h0 = await hints();
    log('[probe] 开启全屏窗口 …');
    const fsWin = new BrowserWindow({
      fullscreen: true, frame: false, backgroundColor: '#204060',
      skipTaskbar: true, show: true, webPreferences: { contextIsolation: true },
    });
    await fsWin.loadURL('data:text/html,<body style="margin:0;background:%23204060"></body>');
    fsWin.show(); fsWin.focus();
    await sleep(2200);
    const hiddenDuring = !petWin.isVisible();
    await step('全屏中');
    fsWin.destroy();
    await sleep(2800);
    await step('全屏后·刚恢复');

    // ---------- 全屏后：光标移到宠物上，看 hint 是否到达、OS 状态是否切换 ----------
    const h1 = await hints();
    moveTo(centerPx().x, centerPx().y);
    await sleep(120);
    const h2 = await hints();
    await sleep(700);
    const h3 = await hints();
    await step('全屏后·光标已移到宠物上', { note: `hint 计数 ${h1} → ${h2} → ${h3}` });

    report.fullscreen = { hiddenDuring, visibleAfter: petWin.isVisible(), hintCounts: { before: h0, atMove: h2, after700ms: h3 } };
    report.afterFullscreenHints = await hintProbe('全屏后');
    await step('全屏后·hint 采样后');
    report.afterFullscreen = {
      click: await clickTest('全屏后单击'),
      drag: await dragTest('全屏后拖动'),
    };
    await step('全屏后·拖动结束');

    // ---------- 从探针侧直接调 OS API：验证 setIgnoreMouseEvents 本身是否还能把状态切回来 ----------
    log('[probe] 从探针侧强制 setIgnoreMouseEvents(false) …');
    petWin.setIgnoreMouseEvents(false, { forward: true });
    await sleep(500);
    await step('强制 setIgnoreMouseEvents(false) 之后');
    report.forcedInteractive = {
      click: await clickTest('强制可交互后单击'),
      drag: await dragTest('强制可交互后拖动'),
    };
    await step('强制可交互·拖动结束');

    fs.writeFileSync(path.join(__dirname, 'fs-drag.json'), JSON.stringify(report, null, 1));
    log('[probe] 已写出 fs-drag.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'fs-drag.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
