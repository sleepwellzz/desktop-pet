'use strict';
/**
 * 探针：`focusable:false` + 透明 + 分层的宠物窗口上，**原生菜单（Menu.popup）能否弹出并被点击**。
 *
 * 为什么要专门探：这是纯平台行为，不许推断（工程约定）。宠物窗口带着
 * WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TOPMOST，系统弹出菜单要靠它自己拿焦点；
 * 万一拿不到，右键菜单这条路就得换方案（自绘 HTML 菜单 → 要改窗口尺寸 → 触碰命中区域）。
 *
 * 取证方式（三重，缺一不可）：
 *   1. 弹出菜单时**抓一张全屏截图**（desktopCapturer）—— 直接看到菜单到底出现没有；
 *   2. 在光标附近的不同偏移处注入**真实点击**，看哪个菜单项的回调被触发 ——
 *      证明"能点"且能定位；偏移取 +200,+200 作为对照（应该什么都不触发）；
 *   3. 交互结束后再真实点一下宠物，确认输入通路没被这次菜单交互破坏。
 *
 * 用法：node spikes/m2-menu/run.mjs
 */
const { app, BrowserWindow, Menu, Tray, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'menu-native.log');
const REPORT = path.join(__dirname, 'menu-native.json');
const SHOT = path.join(__dirname, 'menu-shot.png');

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

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
koffi.struct('V_POINT', { x: 'int', y: 'int' });
koffi.struct('M2_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT_SIZE = koffi.sizeof('V_POINT');
const RECT_SIZE = koffi.sizeof('M2_RECT');
const GetCursorPos = user32.func('bool GetCursorPos(V_POINT *pt)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const GetWindowLongW = user32.func('int GetWindowLongW(void *h, int index)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetClassNameW = user32.func('int GetClassNameW(void *h, char16_t *buf, int n)');
const GetWindowTextW2 = user32.func('int GetWindowTextW(void *h, char16_t *buf, int n)');
const GetWindowTextLengthW2 = user32.func('int GetWindowTextLengthW(void *h)');
const IsWindowVisible2 = user32.func('bool IsWindowVisible(void *h)');
const IsIconic2 = user32.func('bool IsIconic(void *h)');
const GetWindowRect2 = user32.func('bool GetWindowRect(void *h, M2_RECT *r)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GWL_EXSTYLE = -20;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
const exStyle = (w) => GetWindowLongW(hwndOf(w), GWL_EXSTYLE) >>> 0;
function cursorNow() { const b = Buffer.alloc(POINT_SIZE); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; }
function decodeExStyle(v) {
  return {
    raw: '0x' + v.toString(16),
    LAYERED: !!(v & 0x80000), TRANSPARENT: !!(v & 0x20),
    NOACTIVATE: !!(v & 0x8000000), TOPMOST: !!(v & 0x8),
  };
}

/**
 * 前台窗口快照（含类名）——用来抓"宠物为什么被误判成全屏"。
 * 用与 host/fullscreen.ts 相同的判据复算一次 covers，便于对照。
 */
function fgInfo() {
  const fg = GetForegroundWindow();
  if (!fg) return { hwnd: null };
  const cbuf = Buffer.alloc(512);
  const n = GetClassNameW(fg, cbuf, 256);
  const cls = n > 0 ? cbuf.toString('utf16le', 0, n * 2) : '';
  const len = GetWindowTextLengthW2(fg);
  const tbuf = Buffer.alloc((len + 1) * 2);
  const tn = len > 0 ? GetWindowTextW2(fg, tbuf, len + 1) : 0;
  const title = tn > 0 ? tbuf.toString('utf16le', 0, tn * 2) : '';
  const rbuf = Buffer.alloc(RECT_SIZE);
  GetWindowRect2(fg, rbuf);
  const r = { left: rbuf.readInt32LE(0), top: rbuf.readInt32LE(4), right: rbuf.readInt32LE(8), bottom: rbuf.readInt32LE(12) };
  const rw = r.right - r.left, rh = r.bottom - r.top;
  return {
    hwnd: Number(fg), class: cls, title,
    rect: `${r.left},${r.top},${r.right},${r.bottom}`,
    size: `${rw}x${rh}`,
    visible: !!IsWindowVisible2(fg), iconic: !!IsIconic2(fg),
    coversScreen: rw >= VW && rh >= VH,
  };
}

const INJECT = `
window.__ev = { down: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
'ok'`;

// 宿主自己的全屏检测函数：用它原样复算，才能判断"宠物被隐藏"是不是这条判据误报。
const { detectFullscreen } = require(path.join(DIST, 'host', 'fullscreen.js'));

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
  const report = { rounds: [], notes: [] };
  const cornerX = VX + VW - 2, cornerY = VY + VH - 2;
  const clickAt = async (x, y) => { moveTo(x, y); await sleep(300); mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(60); mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(1600); };
  try {
    // 用例 0（启动路径）：先让"桌面"成为前台，再启动宠物。
    // 这是原始缺陷的真实触发路径（开机自启时桌面就是前台 / 用户刚点过桌面），
    // 上一次修复就是因为类名差一错误在这条路径上静默失效，所以单独钉一个用例。
    await clickAt(cornerX, cornerY);
    report.startupDesktopFirst = { fgBeforeBoot: fgInfo(), detectorBeforeBoot: detectFullscreen() };
    log(`[probe] 启动前把前台切到桌面：${report.startupDesktopFirst.fgBeforeBoot.class || '?'} "${report.startupDesktopFirst.fgBeforeBoot.title || ''}" ` +
      `${report.startupDesktopFirst.fgBeforeBoot.size || ''}；检测器 coversMonitor=${report.startupDesktopFirst.detectorBeforeBoot.coversMonitor}`);

    require(path.join(DIST, 'main', 'index.js'));
    const win0 = await waitForPetWindow(20000);
    await sleep(4000);           // 覆盖全屏检测的首轮采样（启动后 ~600ms）与随后几轮
    report.startupDesktopFirst.petVisibleAfterBoot = win0.isVisible();
    report.startupDesktopFirst.fgAfterBoot = fgInfo();
    report.startupDesktopFirst.detectorAfterBoot = detectFullscreen();
    report.startupDesktopFirst.verdict = win0.isVisible() ? 'PASS 桌面在前台，宠物没有自我隐藏' : 'FAIL 启动即被误判为全屏并隐藏';
    log(`[probe] 启动后：宠物可见=${win0.isVisible()} → ${report.startupDesktopFirst.verdict}`);

    await clickAt(cornerX, cornerY);   // 恢复窗口

    const win = win0;
    await sleep(1500);
    const dpr = screen.getPrimaryDisplay().scaleFactor;
    const cb = win.getContentBounds();
    const cx = Math.round((cb.x + cb.width / 2) * dpr);
    const cy = Math.round((cb.y + cb.height / 2) * dpr);
    report.pet = { contentBounds: cb, dpr, clickAt: { x: cx, y: cy }, exStyle: decodeExStyle(exStyle(win)) };
    log(`[probe] 宠物内容区 ${JSON.stringify(cb)} DPR=${dpr} 点击点=(${cx},${cy})`);
    log(`[probe] exStyle=${JSON.stringify(report.pet.exStyle)}`);
    await win.webContents.executeJavaScript(INJECT);
    const downCount = () => win.webContents.executeJavaScript('window.__ev.down').catch(() => -1);

    // 对照：先证明确实能把真实点击注入到宠物上（探针自身有效性）
    moveTo(cx, cy); await sleep(350);
    const before0 = await downCount();
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50); mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(350);
    const after0 = await downCount();
    report.clickInjectionWorks = after0 > before0;
    log(`[probe] 点击注入自检：pointerdown ${before0} → ${after0} ${report.clickInjectionWorks ? '✅' : '❌'}`);

    // 逐轮：弹原生菜单 → 点击"扫描点" → 看哪个项被触发。
    // 为什么是"扫描"而不是"猜一个点"：v1 探针证明菜单在屏幕右下角会**向上翻折**，
    // 于是"光标右下偏移"型的猜测全部落空（截图为证）。这里按上/左/右下多个方向扫，
    // 顺便把菜单的真实几何映射出来。
    const scanOffsets = [
      // 这些点是从 v1 的全屏截图**量出来的**：菜单被屏幕右下角顶住后整体上移，
      // 落在光标的"右上"方向（左边缘 ≈ 光标+15px，上边缘 ≈ 光标-167px，行高 ≈ 64px）。
      [76, -103], [40, -103], [100, -103],   // ITEM-A 一带
      [76, -39],                              // ITEM-B 一带
      [76, 22],                               // ITEM-C 一带
    ];
    let firstPopup = true;
    for (const [dx, dy] of scanOffsets) {
      let fired = null;
      const menu = Menu.buildFromTemplate([
        { label: 'ITEM-A', click: () => { fired = 'A'; } },
        { label: 'ITEM-B', click: () => { fired = 'B'; } },
        { type: 'separator' },
        { label: 'ITEM-C', click: () => { fired = 'C'; } },
      ]);
      moveTo(cx, cy); await sleep(280);
      menu.popup({ window: win });
      await sleep(650);

      if (firstPopup) {
        firstPopup = false;
        try {
          const srcs = await desktopCapturer.getSources({
            types: ['screen'], thumbnailSize: { width: VW, height: VH },
          });
          if (srcs[0]) { fs.writeFileSync(SHOT, srcs[0].thumbnail.toPNG()); report.screenCaptured = true; }
          else { report.screenCaptured = false; }
        } catch (e) { report.captureError = String((e && e.stack) || e); }
      }

      const during = {
        petVisible: win.isVisible(),
        petExStyle: decodeExStyle(exStyle(win)),
        fg: fgInfo(),
      };
      moveTo(cx + dx, cy + dy); await sleep(150);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(60); mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(550);
      const after = { fg: fgInfo(), petVisible: win.isVisible() };
      report.rounds.push({ offset: { dx, dy }, fired, during, after });
      log(`[probe] 偏移(${dx},${dy}) → 触发项 = ${fired ?? '（无）'}；此时前台 = ${during.fg.class || '?'} "${during.fg.title || ''}" ${during.fg.size || ''}${during.fg.coversScreen ? ' [覆盖全屏]' : ''}`);
    }

    // 菜单交互之后，宠物的输入通路是否还在
    moveTo(cx, cy); await sleep(450);
    const before1 = await downCount();
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(50); mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(450);
    const after1 = await downCount();
    report.inputAfterMenu = { before: before1, after: after1, works: after1 > before1, petVisible: win.isVisible() };
    log(`[probe] 菜单交互后再点宠物：pointerdown ${before1} → ${after1} ${report.inputAfterMenu.works ? '✅ 输入通路未破坏' : '❌ 没点进去'}（宠物可见=${win.isVisible()}）`);

    // 独立用例（回归）：点任务栏右下角的"显示桌面"条。
    // 2026-09-16 实测过：这一步会让前台变成 WorkerW（2560x1600、空标题），
    // 旧版全屏检测判它 coversMonitor=true → 宠物把自己隐藏（"点一下桌面宠物不见了"）。
    // 这里连点两次（显示桌面 / 恢复），核对修复后宠物始终可见。
    report.desktopCase = { at: { x: cornerX, y: cornerY } };
    await clickAt(cornerX, cornerY);
    report.desktopCase.afterShowDesktop = {
      fg: fgInfo(), detector: detectFullscreen(), petVisible: win.isVisible(),
    };
    log(`[probe] 点"显示桌面"条 → 前台=${report.desktopCase.afterShowDesktop.fg.class || '?'} "${report.desktopCase.afterShowDesktop.fg.title || ''}" ` +
      `${report.desktopCase.afterShowDesktop.fg.size || ''}`);
    log(`[probe]   宿主检测器：coversMonitor=${report.desktopCase.afterShowDesktop.detector.coversMonitor} ` +
      `fgClass=${report.desktopCase.afterShowDesktop.detector.fgClass} quns=${report.desktopCase.afterShowDesktop.detector.quns} ` +
      `宠物可见=${report.desktopCase.afterShowDesktop.petVisible}`);
    await clickAt(cornerX, cornerY);   // 再点一次恢复窗口
    report.desktopCase.afterRestore = { fg: fgInfo(), detector: detectFullscreen(), petVisible: win.isVisible() };
    report.desktopCase.verdict = (!report.desktopCase.afterShowDesktop.detector.coversMonitor
      && report.desktopCase.afterShowDesktop.petVisible) ? 'PASS 桌面不算全屏，宠物没消失' : 'FAIL 仍被误判';
    log(`[probe]   再点一次恢复 → 宠物可见=${report.desktopCase.afterRestore.petVisible}；判定：${report.desktopCase.verdict}`);

    // 托盘能否创建（图标用刚捕获的宠物画面，免额外资产）
    try {
      const shot = await win.webContents.capturePage();
      const tray = new Tray(shot.resize({ width: 16, height: 16 }));
      tray.setToolTip('desktop-pet probe');
      report.tray = { created: !tray.isDestroyed() };
      await sleep(800);
      tray.destroy();
      log('[probe] 托盘创建成功（图标用窗口截图缩放，仅用于验证 API）');
    } catch (e) {
      report.tray = { error: String((e && e.stack) || e) };
      log('[probe] 托盘创建失败：' + report.tray.error);
    }

    const hit = report.rounds.filter((r) => r.fired);
    report.conclusion = hit.length > 0
      ? `原生菜单可用：偏移 ${hit.map((h) => `(+${h.offset.dx},+${h.offset.dy})→${h.fired}`).join('、')}`
      : '原生菜单未命中任何项（菜单可能没弹出，或菜单几何与预期差得远）';
    log('[probe] 结论：' + report.conclusion);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log('[probe] 失败：' + report.error);
  }
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) { /* ignore */ }
  app.exit(0);
});
