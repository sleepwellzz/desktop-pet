'use strict';
/**
 * 探针：托盘菜单那套动作真的起作用吗（M2 ②）。
 *
 * 验四件事，每件都用**可观测的结果**而不是"看着像"：
 *   1. 隐藏 → 显示之后，宠物**仍然可点可拖**（ADR 009 的输入通路没被打断）；
 *   2. 改缩放后窗口内容区 = round(cell×scale)，且**底边中点没动**（宠物站在原地长大），
 *      并且命中判定仍然只吃精灵轮廓（中心可点、远处空白穿透）；
 *   3. 开机自启写入后能回读，撤销后回读为关（顺带用 PowerShell 直接读注册表做第二来源）；
 *   4. 退出之后进程真的消失（驱动脚本核对 PID）。
 *
 * 动作表是主进程内部的闭包，探针拿不到 —— 所以主进程提供 `--expose-actions` 接缝，
 * 把动作表挂到 `globalThis.__petActions`（仅探针使用，不影响正常运行）。
 *
 * 用法：node spikes/m2-menu/run-tray.mjs
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'tray.log');
const REPORT = path.join(__dirname, 'tray.json');
const STATUS_FILE = path.join(__dirname, 'tray-status.json');
const EVENT_LOG = path.join(__dirname, 'tray-events.jsonl');

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
koffi.struct('T_POINT', { x: 'int', y: 'int' });
const POINT_SIZE = koffi.sizeof('T_POINT');
const GetCursorPos = user32.func('bool GetCursorPos(T_POINT *pt)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const GetWindowLongW = user32.func('int GetWindowLongW(void *h, int index)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20;
const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
const transparentFlag = (w) => !!(GetWindowLongW(hwndOf(w), GWL_EXSTYLE) & WS_EX_TRANSPARENT);
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
function cursorNow() { const b = Buffer.alloc(POINT_SIZE); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; }

const INJECT = `
window.__ev = { down: 0, up: 0, move: 0, cancel: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
document.addEventListener('pointerup', function () { window.__ev.up++; }, true);
document.addEventListener('pointercancel', function () { window.__ev.cancel++; }, true);
document.addEventListener('pointermove', function () { window.__ev.move++; }, true);
'ok'`;

// 隔离：不碰用户真实的 ~/.desktop-pet/status.json
process.argv.push('--expose-actions');
process.argv.push(`--status-file=${STATUS_FILE}`);
process.argv.push(`--event-log=${EVENT_LOG}`);
require(path.join(DIST, 'main', 'index.js'));
const { isAutoStartEnabled } = require(path.join(DIST, 'host', 'autostart.js'));

async function waitForPetWindow(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === 'desktop-pet');
    if (w) return w;
    await sleep(250);
  }
  throw new Error('未等到桌宠窗口');
}

app.whenReady().then(async () => {
  const report = { steps: [], pid: process.pid };
  const dpr = screen.getPrimaryDisplay().scaleFactor;
  const px = (x, y) => ({ x: Math.round(x * dpr), y: Math.round(y * dpr) });
  try {
    const win = await waitForPetWindow(20000);
    await sleep(2500);
    const actions = globalThis.__petActions;
    report.actionsAvailable = !!actions;
    if (!actions) throw new Error('拿不到 __petActions（--expose-actions 没生效？）');
    log(`[probe] 动作表已取到；DPR=${dpr}；cell=${JSON.stringify(require(path.join(ROOT, 'desktop-pet.json')).pack.cellSize)}`);

    const inject = async () => { await win.webContents.executeJavaScript(INJECT).catch(() => {}); };
    const ev = async () => win.webContents.executeJavaScript('JSON.stringify(window.__ev)')
      .then((s) => JSON.parse(s)).catch(() => ({ down: 0, up: 0, cancel: 0 }));
    await inject();

    /** 在给定的客户区坐标（DIP）点一下，返回渲染层收到的 pointerdown 增量。 */
    async function clickAtDip(cssX, cssY, label) {
      const cb = win.getContentBounds();
      const p = px(cb.x + cssX, cb.y + cssY);
      const a = await ev();
      moveTo(p.x, p.y); await sleep(350);
      // 落点前后各记一次扩展样式：WS_EX_TRANSPARENT 是否已清掉，直接决定点击能不能进来
      const styleOverSprite = transparentFlag(win);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(60);
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(400);
      const b = await ev();
      const got = b.down - a.down;
      log(`[probe] ${label}：客户区(${cssX},${cssY}) → pointerdown +${got} → ${got > 0 ? '命中' : '穿透'}` +
        `；光标落到宠物上时 WS_EX_TRANSPARENT=${styleOverSprite}`);
      return got;
    }

    // —— 用例 1：隐藏 → 显示 → 仍可点可拖 ——
    const cb0 = win.getContentBounds();
    actions.toggleVisibility();
    await sleep(800);
    const hidden = !win.isVisible();
    log(`[probe] 隐藏后 isVisible=${win.isVisible()} ${hidden ? '✅' : '❌'}`);
    actions.toggleVisibility();
    await sleep(3000);            // 等 reload + 渲染层重新报到 + 重新下发 init
    await inject();
    const visAfter = win.isVisible();
    const clickAfterShow = await clickAtDip(Math.round(cb0.width / 2), Math.round(cb0.height / 2), '显示后单击宠物');
    // 拖动
    {
      const c = win.getContentBounds();
      const from = px(c.x + c.width / 2, c.y + c.height / 2);
      const to = { x: from.x - 400, y: from.y - 300 };
      const a = await ev();
      const transparentAtStart = transparentFlag(win);
      moveTo(from.x, from.y); await sleep(400);
      const transparentBeforeDown = transparentFlag(win);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
      for (let i = 1; i <= 10; i += 1) {
        moveTo(Math.round(from.x + (to.x - from.x) * i / 10), Math.round(from.y + (to.y - from.y) * i / 10));
        await sleep(60);
      }
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(400);
      const b = await ev();
      const c1 = win.getContentBounds();
      const moved = c1.x !== c.x || c1.y !== c.y;
      const events = {
        down: b.down - a.down, up: b.up - a.up, move: b.move - a.move, cancel: b.cancel - a.cancel,
      };
      report.steps.push({
        name: '隐藏→显示',
        hidden, visibleAfterShow: visAfter, clickAfterShow,
        dragged: moved, delta: { dx: c1.x - c.x, dy: c1.y - c.y },
        dragEvents: events, transparentAtStart, transparentBeforeDown,
      });
      log(`[probe] 显示后拖动：${moved ? '✅ 可拖动 ' + JSON.stringify({ dx: c1.x - c.x, dy: c1.y - c.y }) : '❌ 拖不动'}` +
        `；指针事件 down=${events.down} up=${events.up} move=${events.move} cancel=${events.cancel}` +
        `；按下前 WS_EX_TRANSPARENT=${transparentBeforeDown}（拖动开始前=${transparentAtStart}）`);
    }
    await sleep(600);
    // 把宠物拖回原处附近，便于后续缩放用例的比较
    actions.resetScale();

    // —— 用例 2：改缩放（尺寸 + 底边中点不动 + 命中仍只吃精灵） ——
    const before = win.getContentBounds();
    const bc = { cx: before.x + before.width / 2, bottom: before.y + before.height };
    actions.setScale(1.0);
    await sleep(3000);
    await inject();
    const after = win.getContentBounds();
    const expect = { w: Math.round(192 * 1.0), h: Math.round(208 * 1.0) };
    const bc2 = { cx: after.x + after.width / 2, bottom: after.y + after.height };
    const centerHit = await clickAtDip(Math.round(after.width / 2), Math.round(after.height / 2), '放大后单击中心');
    const cornerHit = await clickAtDip(4, 4, '放大后单击左上角（应为空白）');
    report.steps.push({
      name: 'setScale(1.0)',
      bounds: after,
      sizeOk: after.width === expect.w && after.height === expect.h,
      expected: expect,
      bottomCenterDrift: { dx: Math.round(bc2.cx - bc.cx), dBottom: Math.round(bc2.bottom - bc.bottom) },
      centerHit, cornerHit,
    });
    log(`[probe] 尺寸 ${after.width}x${after.height}（应为 ${expect.w}x${expect.h}）${after.width === expect.w && after.height === expect.h ? ' ✅' : ' ❌'}；` +
      `底边中点漂移 dx=${Math.round(bc2.cx - bc.cx)} dBottom=${Math.round(bc2.bottom - bc.bottom)}`);
    log(`[probe] 命中：中心=${centerHit > 0 ? '✅' : '❌'} 左上空白=${cornerHit === 0 ? '✅ 穿透' : '❌ 吃掉了'}`);

    // —— 用例 3：重置大小 ——
    actions.resetScale();
    await sleep(3000);
    const back = win.getContentBounds();
    report.steps.push({ name: 'resetScale', bounds: back });
    log(`[probe] 重置后尺寸 ${back.width}x${back.height}（默认 0.7 → 应为 134x146）`);

    // —— 用例 4：开机自启（写 → 回读 → 第二来源 → 撤销） ——
    const psQuery = () => {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').PSObject.Properties | " +
        "Where-Object { $_.Name -like '*desktop-pet*' } | ForEach-Object { $_.Name + '=' + $_.Value }",
      ], { encoding: 'utf8' });
      return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim().slice(0, 200), status: r.status };
    };
    const authBefore = isAutoStartEnabled();
    actions.setAutoStart(true);
    await sleep(700);
    const authOn = isAutoStartEnabled();
    const regOn = psQuery();
    actions.setAutoStart(false);
    await sleep(700);
    const authOff = isAutoStartEnabled();
    const regOff = psQuery();
    report.steps.push({ name: 'autostart', authBefore, authOn, regOn, authOff, regOff });
    log(`[probe] 自启：写前=${authBefore} 写入后回读=${authOn} 撤销后回读=${authOff}`);
    log(`[probe] 注册表第二来源：写入后 "${regOn.out}"（status=${regOn.status}${regOn.err ? ' err=' + regOn.err : ''}）；` +
      `撤销后 "${regOff.out}"`);

    // 托盘是否创建成功：主进程日志里有标记（同进程共用一个日志文件）
    const logText = fs.readFileSync(LOG, 'utf8');
    report.trayCreated = /\[pet\] 托盘已创建/.test(logText);
    log(`[probe] 托盘创建标记=${report.trayCreated}`);
    report.cursorBeforeQuit = cursorNow();

    const fails = [];
    const s1 = report.steps[0];
    if (!s1.hidden) fails.push('隐藏无效');
    if (!s1.visibleAfterShow) fails.push('显示无效');
    if (!(s1.clickAfterShow > 0)) fails.push('显示后点不动（ADR 009 通路被打断）');
    if (!s1.dragged) fails.push('显示后拖不动');
    const s2 = report.steps[1];
    if (!s2.sizeOk) fails.push('缩放后尺寸不对');
    // 锚点判据：底边中点不该动，**除非被工作区夹住**（宠物贴着屏幕右/下边缘时，
    // 放大必然要被推回来一点 —— 那是防止宠物跑出屏幕的夹取，不是漂移）。
    const area = screen.getDisplayNearestPoint({ x: Math.round(after.x + after.width / 2), y: after.y + after.height }).workArea;
    const clampedX = after.x <= area.x || after.x + after.width >= area.x + area.width;
    const clampedY = after.y <= area.y || after.y + after.height >= area.y + area.height;
    s2.clamped = { x: clampedX, y: clampedY, area };
    const anchorOk = (Math.abs(s2.bottomCenterDrift.dBottom) <= 2)
      && (Math.abs(s2.bottomCenterDrift.dx) <= 2 || clampedX);
    if (!anchorOk) fails.push('缩放锚点漂移超过 2 DIP 且不是被工作区夹住');
    if (!(s2.centerHit > 0)) fails.push('放大后中心点不命中');
    if (s2.cornerHit !== 0) fails.push('放大后空白区被吃掉');
    if (report.steps[2].bounds.width !== Math.round(192 * 0.7)) fails.push('重置大小没回到默认值');
    const s4 = report.steps[3];
    if (!s4.authOn) fails.push('自启写入后回读为关');
    if (s4.authOff) fails.push('自启撤销后回读仍为开');
    if (!report.trayCreated) fails.push('托盘没有创建成功的日志标记');
    report.failures = fails;
    report.verdict = fails.length === 0 ? 'PASS' : 'FAIL';
    log(`[probe] 判定：${report.verdict}${fails.length ? ' —— ' + fails.join('；') : ''}`);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log('[probe] 失败：' + report.error);
  }
  // 报告先落盘，再退出：退出用例由驱动脚本核对进程是否真的消失
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) { /* ignore */ }
  log('[probe] 调 actions.quit() —— 若进程之后仍在，说明"退出"没退干净');
  try {
    const actions = globalThis.__petActions;
    if (actions) actions.quit();
  } catch (e) {
    log('[probe] quit 抛异常：' + String(e));
  }
  await sleep(4000);
  log('[probe] quit 后仍存活 4 秒 —— 退出失败');
  app.exit(0);
});
