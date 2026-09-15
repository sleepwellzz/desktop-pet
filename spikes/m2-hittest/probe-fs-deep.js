'use strict';
/**
 * 深入定位：hide → showInactive 之后"鼠标按钮事件进不了渲染层"（spike，结论回写 ADR 009）。
 *
 * 已知：坐标映射正确、页面 visible、窗口位置尺寸正确、WS_EX_TRANSPARENT 已清，
 * 鼠标移动事件能进渲染层，**只有按钮事件进不去**。
 *
 * 本轮要区分两件事：
 *   X) Windows 根本没把点击路由到这个窗口（命中测试/窗口状态问题）；
 *   Y) 点击送到了窗口，但 Chromium 内部没往下发（进程内事件处理问题）。
 * 判定手段：直接 SendMessage(WM_LBUTTONDOWN) 到顶层 HWND —— 绕过命中测试。
 *   若 SendMessage 能让渲染层收到 pointerdown，而真实点击不行 → 属 X。
 * 同时采集 IsWindowEnabled / GWL_STYLE(WS_DISABLED) / 前台窗口 / WindowFromPoint。
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-fs-deep.js fs-deep.json
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'fs-deep.log');
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
koffi.struct('D_POINT', { x: 'int', y: 'int' });
koffi.struct('D_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT_SIZE = koffi.sizeof('D_POINT');
const RECT_SIZE = koffi.sizeof('D_RECT');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const GetWindowRect = user32.func('bool GetWindowRect(void *h, D_RECT *r)');
const GetWindowLongW = user32.func('int GetWindowLongW(void *h, int index)');
const IsWindowEnabled = user32.func('bool IsWindowEnabled(void *h)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const WindowFromPoint = user32.func('void *WindowFromPoint(D_POINT *pt)');
const GetAncestor = user32.func('void *GetAncestor(void *h, uint flags)');
const SendMessageW = user32.func('intptr_t SendMessageW(void *h, uint msg, uintptr_t w, intptr_t l)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GWL_STYLE = -16, GWL_EXSTYLE = -20;
const WS_DISABLED = 0x08000000, WS_VISIBLE = 0x10000000;
const WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000;
const WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const MK_LBUTTON = 0x0001;
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

const INJECT = `
window.__ev = { down: 0, up: 0, move: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
document.addEventListener('pointerup', function () { window.__ev.up++; }, true);
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
    const dpr = require('electron').screen.getPrimaryDisplay().scaleFactor;
    await sleep(2500);
    await win.webContents.executeJavaScript(INJECT);
    const ev = () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)').then(JSON.parse);
    const centerPx = () => { const c = win.getContentBounds(); return { x: Math.round((c.x + c.width / 2) * dpr), y: Math.round((c.y + c.height / 2) * dpr) }; };

    function diag(label) {
      const h = hwndOf(win);
      const style = GetWindowLongW(h, GWL_STYLE) >>> 0;
      const ex = GetWindowLongW(h, GWL_EXSTYLE) >>> 0;
      const p = centerPx();
      const pt = Buffer.alloc(POINT_SIZE); pt.writeInt32LE(p.x, 0); pt.writeInt32LE(p.y, 4);
      const wfp = WindowFromPoint(pt);
      const fg = GetForegroundWindow();
      const row = {
        label,
        enabled: IsWindowEnabled(h),
        winVisible: IsWindowVisible(h),
        styleDisabled: !!(style & WS_DISABLED),
        styleVisible: !!(style & WS_VISIBLE),
        exTransparent: !!(ex & WS_EX_TRANSPARENT),
        exLayered: !!(ex & WS_EX_LAYERED),
        enable: win.isEnabled ? win.isEnabled() : 'n/a',
        windowFromPointIsPet: String(wfp) === String(h) ? true : (wfp ? String(wfp) : null),
        petHwnd: String(h),
        foreground: String(fg),
        isForeground: String(fg) === String(h),
        physical: rectOf(win),
        content: win.getContentBounds(),
      };
      report.steps.push(row);
      log(`[probe] ${label}: enabled=${row.enabled} 可见=${row.winVisible} WS_DISABLED=${row.styleDisabled}`
        + ` T=${row.exTransparent} L=${row.exLayered} WindowFromPoint=${row.windowFromPointIsPet}`
        + ` 前台是本窗口=${row.isForeground} 物理=${row.physical && row.physical.w + 'x' + row.physical.h}`);
      return row;
    }

    async function clickTest(label) {
      const p = centerPx();
      const a = await ev();
      moveTo(p.x, p.y); await sleep(300);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(320);
      const b = await ev();
      const got = b.down - a.down;
      log(`[probe] ${label}: 真实点击 → pointerdown=${got}`);
      return got;
    }
    /** 绕过命中测试，直接给顶层 HWND 发按钮消息。 */
    async function sendMessageTest(label) {
      const a = await ev();
      const h = hwndOf(win);
      const c = win.getContentBounds();
      const cx = Math.round(c.width / 2), cy = Math.round(c.height / 2);
      const lp = (cy << 16) | (cx & 0xffff);
      SendMessageW(h, WM_LBUTTONDOWN, MK_LBUTTON, lp);
      await sleep(120);
      SendMessageW(h, WM_LBUTTONUP, 0, lp);
      await sleep(220);
      const b = await ev();
      const got = b.down - a.down;
      log(`[probe] ${label}: SendMessage(WM_LBUTTONDOWN) → pointerdown=${got}`);
      return got;
    }

    log('[probe] ===== 基线 =====');
    diag('基线');
    await clickTest('基线');

    log('[probe] ===== 最小复现：hide + showInactive =====');
    win.hide();
    await sleep(1200);
    win.showInactive();
    await sleep(1500);
    diag('hide+show 之后');
    const realAfter = await clickTest('hide+show 之后');
    const smAfter = await sendMessageTest('hide+show 之后');

    log('[probe] ===== 补救动作 =====');
    const remedies = [
      ['EnableWindow(false→true)', () => {
        const w = koffi.load('user32.dll');
        const en = w.func('bool EnableWindow(void *h, bool enable)');
        en(hwndOf(win), false); en(hwndOf(win), true);
      }],
      ['尺寸 +1 再还原（真实 resize）', () => {
        const c = win.getContentBounds();
        win.setContentBounds({ x: c.x, y: c.y, width: c.width + 1, height: c.height });
        win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 });
      }],
      ['尺寸 +8 再还原', () => {
        const c = win.getContentBounds();
        win.setContentBounds({ x: c.x, y: c.y, width: c.width + 8, height: c.height + 8 });
        win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 });
      }],
      ['setContentBounds 原值（矩阵里曾有效）', () => {
        const c = win.getContentBounds();
        win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 });
      }],
      ['位置 +1 再还原', () => {
        const c = win.getContentBounds();
        win.setContentBounds({ x: c.x + 1, y: c.y, width: c.width, height: c.height });
        win.setContentBounds({ x: c.x, y: c.y, width: 144, height: 156 });
      }],
    ];
    const results = [];
    for (const [name, fn] of remedies) {
      log(`[probe] ---- 补救：${name} ----`);
      try { fn(); } catch (e) { log('[probe] 抛错：' + ((e && e.message) || e)); }
      await sleep(900);
      const ok = await clickTest('补救「' + name + '」后');
      results.push({ name, click: ok });
      if (ok > 0) log('[probe] ✅ 该动作恢复了点击投递');
    }
    report.realAfter = realAfter;
    report.sendMessageAfter = smAfter;
    report.remedyResults = results;
    fs.writeFileSync(path.join(__dirname, 'fs-deep.json'), JSON.stringify(report, null, 1));
    log('[probe] 已写出 fs-deep.json');
  } catch (e) {
    log('[probe] 失败：' + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(__dirname, 'fs-deep.json'), JSON.stringify({ error: String((e && e.stack) || e), report }, null, 1)); } catch (_) { /* ignore */ }
  }
  app.exit(0);
});
