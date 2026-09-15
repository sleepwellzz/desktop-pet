'use strict';
/**
 * 全屏后"点击进不了渲染层"的补救动作矩阵（spike，结论回写 ADR 009）。
 *
 * 已排除：坐标映射（hint 载荷与推算值偏差 0）、页面可见性（全程 visible）、
 * 样式位（WS_EX_TRANSPARENT 已清）、窗口位置尺寸（前后一致）。
 * 剩下的事实：**鼠标移动能进渲染层，鼠标按钮事件进不去**。
 *
 * 本探针做最小复现（hide + showInactive），然后逐个尝试补救动作，
 * 每个动作后立刻单击测试，看哪一个能把"按钮事件投递"恢复回来。
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-hide-remedy.js hide-remedy.json
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'hide-remedy.log');
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
koffi.struct('R_POINT', { x: 'int', y: 'int' });
const POINT_SIZE = koffi.sizeof('R_POINT');
const GetCursorPos = user32.func('bool GetCursorPos(R_POINT *pt)');
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
const exOf = (w) => {
  const v = GetWindowLongW(hwndOf(w), GWL_EXSTYLE) >>> 0;
  return { hex: '0x' + v.toString(16), T: !!(v & WS_EX_TRANSPARENT), L: !!(v & WS_EX_LAYERED) };
};

const INJECT = `
window.__ev = { down: 0, up: 0, move: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
document.addEventListener('pointerup', function () { window.__ev.up++; }, true);
window.addEventListener('pointermove', function () { window.__ev.move++; }, true);
window.__vis = () => document.visibilityState + '/' + document.hasFocus();
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
    const dpr = require('electron').screen.getPrimaryDisplay().scaleFactor;
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);

    const ev = () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)').then(JSON.parse);
    const centerPx = () => {
      const c = win.getContentBounds();
      return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) };
    };

    /** 单击测试：把光标放到宠物中心，单击，看渲染层是否收到 pointerdown。 */
    async function click(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(300);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(300);
      const b = await ev();
      const got = b.down - a.down;
      const e = exOf(win);
      const state = { label, pointerdown: got, ok: got > 0, exstyle: e, visible: win.isVisible(), page: await win.webContents.executeJavaScript('window.__vis()') };
      report.steps.push(state);
      log(`[probe] ${label}：pointerdown=${got} → ${got > 0 ? '✅ 可点击' : '❌ 点击进不去'}  T=${e.T} L=${e.L} 可见=${state.visible} 页面=${state.page}`);
      return state;
    }

    log('[probe] ---- 基线 ----');
    await click('基线');

    log('[probe] ---- 最小复现：hide() + showInactive() ----');
    win.hide();
    await sleep(1200);
    win.showInactive();
    await sleep(1200);
    await click('hide+showInactive 之后');

    log('[probe] ---- 等待 6 秒，看是否自愈 ----');
    await sleep(6000);
    await click('等待 6 秒后');

    const remedies = [
      ['再切一次 setIgnoreMouseEvents(true→false)', () => { win.setIgnoreMouseEvents(true, { forward: true }); win.setIgnoreMouseEvents(false, { forward: true }); }],
      ['webContents.focus()', () => { win.webContents.focus(); }],
      ['setAlwaysOnTop 重设', () => { win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, 'screen-saver'); }],
      ['setOpacity 抖动', () => { win.setOpacity(0.99); win.setOpacity(1); }],
      ['blur()', () => { win.blur(); }],
      ['setBounds 重设', () => { win.setBounds(win.getBounds()); }],
      ['webContents.invalidate()', () => { win.webContents.invalidate(); }],
      ['再来一次 hide+showInactive', () => { win.hide(); setTimeout(() => win.showInactive(), 300); }],
      ['showInactive 再调一次', () => { win.showInactive(); }],
      ['setContentBounds 复位', () => { const c = win.getContentBounds(); win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 }); }],
    ];
    for (const [name, fn] of remedies) {
      log(`[probe] ---- 补救：${name} ----`);
      try { fn(); } catch (e) { log('[probe] 动作抛错：' + ((e && e.message) || e)); }
      await sleep(1000);
      await click('补救「' + name + '」后');
    }

    fs.writeFileSync(path.join(__dirname, 'hide-remedy.json'), JSON.stringify(report, null, 1));
    log('[probe] 已写出 hide-remedy.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'hide-remedy.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
