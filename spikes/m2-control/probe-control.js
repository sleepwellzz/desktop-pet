'use strict';
/**
 * 探针：控制条本体（M2 ④）。
 *
 * 验的都是"只有真实窗口才能回答"的事（键盘/焦点那条在 probe-key-path.js）：
 *   1. **贴宠物下方 8 DIP、水平居中** —— 位置算式唯一的观感指标；
 *   2. **跟随**：拖动宠物时面板跟着走；
 *   3. **贴边翻转**：宠物拖到工作区底边时翻到上方（不然面板会跑到屏幕外）；
 *   4. **面板内容与仲裁器一致**：会话行数、状态文案、角标；
 *   5. **点「确认」真的解除粘滞**（走真实 DOM 点击 → preload → IPC → 主进程）；
 *   6. **命令白名单**：合法 id 落到真动作；非法 id 被忽略且不抛异常；
 *      `ack-session` 传不存在的会话被拒；
 *   7. **Alt+Tab / 任务栏**：读扩展样式位 WS_EX_TOOLWINDOW（PLAN §8 的"流氓软件"风险项）。
 *
 * 用法：node spikes/m2-control/run.mjs control
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'control.log');
const REPORT = path.join(__dirname, 'control.json');
const SHOT = path.join(__dirname, 'control-shot.png');
const STATUS_FILE = path.join(__dirname, 'probe-status.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
globalThis.console = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
koffi.struct('C_POINT', { x: 'int', y: 'int' });
const POINT_SIZE = koffi.sizeof('C_POINT');
const GetCursorPos = user32.func('bool GetCursorPos(C_POINT *pt)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const GetWindowLongPtrW = user32.func('int64 GetWindowLongPtrW(void* hWnd, int nIndex)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
function cursorNow() { const b = Buffer.alloc(POINT_SIZE); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; }
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;

const hwndOf = (win) => {
  const b = win.getNativeWindowHandle();
  return b.length === 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
};

try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* ignore */ }
process.argv.push('--expose-actions');
process.argv.push(`--status-file=${STATUS_FILE}`);
require(path.join(DIST, 'main', 'index.js'));

function writeStatus(sessions) {
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'desktop-pet/status/v1', sessions }, null, 2), 'utf8');
  fs.renameSync(tmp, STATUS_FILE);
}
const now = () => Date.now();

app.whenReady().then(async () => {
  const report = { steps: [] };
  const dpr = screen.getPrimaryDisplay().scaleFactor;
  const px = (x, y) => ({ x: Math.round(x * dpr), y: Math.round(y * dpr) });
  try {
    const waitFor = async (title, timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === title);
        if (w) return w;
        await sleep(250);
      }
      return null;
    };
    const pet = await waitFor('desktop-pet', 20000);
    if (!pet) throw new Error('未等到桌宠窗口');
    const bar = await waitFor('desktop-pet-control-bar', 20000);
    if (!bar) throw new Error('未等到控制条窗口');
    await sleep(2500);
    const dbg = globalThis.__petDebug;
    if (!dbg) throw new Error('拿不到 __petDebug');
    // 期望值一律从宠物包的 sidecar 读，不在探针里另写一份（否则测的是探针自己的假设）
    const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-pet.json'), 'utf8'));
    const expectGapBelow = sidecar.controlBar.gapBelowPet;

    const dom = async () => bar.webContents.executeJavaScript(`JSON.stringify({
      rows: [...document.querySelectorAll('#sessions .row')].map(r => r.textContent),
      ackButtons: document.querySelectorAll('#sessions .row .ack').length,
      summary: document.getElementById('summary').textContent,
      scale: document.getElementById('scale').textContent,
      resetDisabled: !!document.querySelector('[data-cmd="reset-scale"]').disabled,
    })`).then(JSON.parse).catch((e) => ({ error: String(e) }));

    const send = async (cmd) => {
      await bar.webContents.executeJavaScript(
        `(() => { window.petBar.command(${JSON.stringify(cmd)}); return 'ok'; })()`,
      );
      await sleep(900);
    };

    /** 用真实鼠标把宠物拖走（走渲染层的拖动路径，不是直接改窗口坐标）。 */
    const dragPet = async (dxDip, dyDip) => {
      const c = pet.getContentBounds();
      const start = px(c.x + c.width / 2, c.y + c.height / 2);
      moveTo(start.x, start.y); await sleep(400);
      mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        moveTo(Math.round(start.x + (dxDip * dpr * i) / steps), Math.round(start.y + (dyDip * dpr * i) / steps));
        await sleep(60);
      }
      mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(800);
    };

    // —— ① 位置：先把宠物摆到屏幕中央（不贴任何边），再量"贴下方 8 DIP + 水平居中" ——
    // 为什么必须先摆位：宠物默认就在工作区右下角（margin 24 DIP），那里**下方只剩 24 DIP**，
    // 而 260 宽的面板贴右侧会被夹进工作区 —— 位置算式会（正确地）翻到上方并夹取，
    // 于是量出来的"下间距"和"居中偏差"全都是别的规则的结果。本探针第一版正是这样误报了两条。
    const cInit = pet.getContentBounds();
    const area0 = screen.getDisplayNearestPoint({ x: cInit.x, y: cInit.y }).workArea;
    const wantX = area0.x + Math.round((area0.width - cInit.width) / 2);
    const wantY = area0.y + Math.round((area0.height - cInit.height) / 2);
    await dragPet(wantX - cInit.x, wantY - cInit.y);
    const petB = pet.getContentBounds();
    await sleep(900);                        // 拖动后光标就停在宠物上 → 悬停唤出
    const bb = dbg.barBounds();
    const gapBelow = bb ? bb.y - (petB.y + petB.height) : null;
    const centerDelta = bb ? Math.abs((bb.x + bb.width / 2) - (petB.x + petB.width / 2)) : null;
    report.placement = {
      workArea: area0, pet: petB, bar: bb, gapBelow, centerDelta,
      expectGapBelow: expectGapBelow,
      expectHeight: sidecar.controlBar.headerHeight + sidecar.controlBar.footerHeight,
    };
    log(`[probe] 位置：宠物 ${petB.width}x${petB.height}@${petB.x},${petB.y} → 面板 ${bb ? `${bb.width}x${bb.height}@${bb.x},${bb.y}` : '无'}`
      + ` ｜ 下间距=${gapBelow}（宠物包声明 ${expectGapBelow}）水平偏差=${centerDelta}`
      + ` ｜ 高度 ${bb?.height}（无会话时期望 ${report.placement.expectHeight}）`);

    // —— ② 内容：与仲裁器一致（写两条会话：b 需要输入、a 运行中）——
    writeStatus({
      a: { status: 'running', title: 'a', ts: now() },
      b: { status: 'needs-input', title: '等你拍板', ts: now() },
    });
    await sleep(2200);
    const d1 = await dom();
    const bbWithRows = dbg.barBounds();
    report.content = { ...d1, barHeight: bbWithRows?.height };
    report.expectHeightWithRows = sidecar.controlBar.headerHeight
      + 2 * sidecar.controlBar.rowHeight + sidecar.controlBar.footerHeight;
    log(`[probe] 面板内容：摘要「${d1.summary}」｜行数=${d1.rows?.length} 确认按钮=${d1.ackButtons}`
      + `｜高度 ${bbWithRows?.height}（2 条会话期望 ${report.expectHeightWithRows}）｜`
      + (d1.rows ?? []).map((r, i) => `\n        行${i}: ${r}`).join(''));

    // —— ③ 点「确认」：粘滞解除（真实 DOM 点击）——
    const clicked = await bar.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('#sessions .row .ack');
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`).catch((e) => 'error:' + String(e));
    await sleep(1200);
    const d2 = await dom();
    const stateAfterAck = globalThis.__petDebug.barState();
    report.ack = { clicked, rowsAfter: d2.rows, barStateVisible: stateAfterAck.visible };
    log(`[probe] 点确认：${clicked} → 确认按钮数=${d2.ackButtons}（期望 0）`);

    // —— ④ 命令白名单：合法 id 落到真动作 ——
    const scaleBefore = pet.getContentBounds();
    await send({ id: 'scale-up' });
    const scaleUp = pet.getContentBounds();
    const dUp = await dom();
    await send({ id: 'reset-scale' });
    const scaleReset = pet.getContentBounds();
    report.commands = {
      before: { w: scaleBefore.width, h: scaleBefore.height },
      afterScaleUp: { w: scaleUp.width, h: scaleUp.height },
      afterReset: { w: scaleReset.width, h: scaleReset.height },
      scaleTextAfterUp: dUp.scale,
    };
    log(`[probe] scale-up：${scaleBefore.width}x${scaleBefore.height} → ${scaleUp.width}x${scaleUp.height}（面板显示 ${dUp.scale}）`
      + `；reset-scale → ${scaleReset.width}x${scaleReset.height}`);

    // 非法 id / 不存在的会话：都必须被忽略，且不能把面板或主进程弄坏
    const logBefore = fs.readFileSync(LOG, 'utf8').length;
    await send({ id: 'nonsense-command' });
    await send({ id: 'ack-session', arg: '不存在的会话' });
    const logAfter = fs.readFileSync(LOG, 'utf8');
    const tail = logAfter.slice(logBefore);
    report.rejects = {
      unknownLogged: tail.includes('未知命令'),
      nonexistentLogged: tail.includes('不存在的会话'),
      barStillVisible: dbg.barVisible(),
    };
    log(`[probe] 非法命令：未知 id 被记录=${report.rejects.unknownLogged}｜`
      + `不存在的会话被拒=${report.rejects.nonexistentLogged}｜面板仍在=${report.rejects.barStillVisible}`);

    // —— ⑤ 跟随：拖动宠物，面板要跟着走 ——
    const bbBefore = dbg.barBounds();
    const c0 = pet.getContentBounds();
    const from = px(c0.x + c0.width / 2, c0.y + c0.height / 2);
    moveTo(from.x, from.y); await sleep(400);
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
    for (let i = 1; i <= 10; i += 1) {
      moveTo(Math.round(from.x - 260 * i / 10), Math.round(from.y - 120 * i / 10));
      await sleep(60);
    }
    mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(600);
    const c1 = pet.getContentBounds();
    const bbAfter = dbg.barBounds();
    const followed = !!bbBefore && !!bbAfter && (bbAfter.x !== bbBefore.x || bbAfter.y !== bbBefore.y);
    report.follow = { petDelta: { dx: c1.x - c0.x, dy: c1.y - c0.y }, barBefore: bbBefore, barAfter: bbAfter, followed };
    log(`[probe] 拖动宠物 ${JSON.stringify({ dx: c1.x - c0.x, dy: c1.y - c0.y })} → 面板 `
      + `${bbBefore?.x},${bbBefore?.y} → ${bbAfter?.x},${bbAfter?.y} → ${followed ? '✅ 跟随' : '❌ 没跟随'}`);

    // —— ⑥ 贴边翻转：把宠物拖到工作区底边 ——
    const area = screen.getDisplayNearestPoint({ x: c1.x, y: c1.y }).workArea;
    const targetY = area.y + area.height - c1.height;
    const cur = pet.getContentBounds();
    const from2 = px(cur.x + cur.width / 2, cur.y + cur.height / 2);
    const dyDip = targetY - cur.y;
    moveTo(from2.x, from2.y); await sleep(400);
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
    for (let i = 1; i <= 14; i += 1) {
      moveTo(from2.x, Math.round(from2.y + (dyDip * dpr * i) / 14));
      await sleep(60);
    }
    mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(800);
    const petBottom = pet.getContentBounds();
    const barFlipped = dbg.barBounds();
    const flipped = !!barFlipped && barFlipped.y + barFlipped.height <= petBottom.y;
    report.flip = {
      workArea: area,
      pet: { y: petBottom.y, h: petBottom.height, bottom: petBottom.y + petBottom.height },
      bar: barFlipped,
      flippedAbove: flipped,
      gapAbove: barFlipped ? petBottom.y - (barFlipped.y + barFlipped.height) : null,
    };
    log(`[probe] 宠物拖到工作区底边 y=${petBottom.y}（底边 ${petBottom.y + petBottom.height}，工作区底 ${area.y + area.height}）`
      + ` → 面板 ${barFlipped?.y},${barFlipped?.height} → ${flipped ? '✅ 已翻到上方' : '❌ 仍在下方/出屏'}`);

    // 截图供人眼核对观感（位置翻转后的样子）
    try {
      const shot = await bar.webContents.capturePage();
      fs.writeFileSync(SHOT, shot.toPNG());
      log('[probe] 已保存 control-shot.png');
    } catch (_) { /* ignore */ }

    // —— ⑦ Alt+Tab / 任务栏：读扩展样式位 ——
    const exStyle = Number(GetWindowLongPtrW(hwndOf(bar), GWL_EXSTYLE));
    report.windowStyle = {
      exStyle: '0x' + (exStyle >>> 0).toString(16),
      toolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
    };
    log(`[probe] 控制条扩展样式 = 0x${(exStyle >>> 0).toString(16)}，WS_EX_TOOLWINDOW=${report.windowStyle.toolWindow}`);

    // —— ⑧ close-bar 与 hide-pet ——
    await send({ id: 'close-bar' });
    const afterClose = dbg.barVisible();
    await send({ id: 'hide-pet' });
    const petHidden = !pet.isVisible();
    const barAfterHidePet = dbg.barVisible();
    report.teardown = { afterCloseBar: afterClose, petHidden, barAfterHidePet };
    log(`[probe] close-bar → 面板可见=${afterClose}（期望 false）｜hide-pet → 宠物可见=${pet.isVisible()}（期望 false）面板可见=${barAfterHidePet}`);

    // —— 判定 ——
    const fails = [];
    if (bb == null) fails.push('拿不到控制条矩形（悬停没有唤出面板）');
    else {
      if (gapBelow === null || Math.abs(gapBelow - expectGapBelow) > 2) fails.push(`控制条与宠物下方的间距是 ${gapBelow}，期望 ${expectGapBelow}`);
      if (centerDelta === null || centerDelta > 2) fails.push(`控制条没有水平居中（偏差 ${centerDelta}）`);
      if (bb.height !== report.placement.expectHeight) {
        fails.push(`无会话时面板高度 ${bb.height}，期望 ${report.placement.expectHeight}`);
      }
    }
    if (bbWithRows?.height !== report.expectHeightWithRows) {
      fails.push(`2 条会话时面板高度 ${bbWithRows?.height}，期望 ${report.expectHeightWithRows}`);
    }
    if ((d1.rows?.length ?? 0) !== 2) fails.push(`面板会话行数 ${d1.rows?.length}，期望 2`);
    if (d1.ackButtons !== 1) fails.push(`确认按钮数 ${d1.ackButtons}，期望 1（needs-input 那条）`);
    if (!String(d1.summary).includes('需要输入')) fails.push('摘要没显示"需要输入"');
    if (clicked !== 'clicked') fails.push('点不到确认按钮：' + clicked);
    if (d2.ackButtons !== 0) fails.push('点确认后按钮仍在（粘滞没解除）');
    if (scaleUp.width <= scaleBefore.width) fails.push('scale-up 没有真的放大');
    if (scaleReset.width !== scaleBefore.width) fails.push('reset-scale 没有回到默认尺寸');
    if (!report.rejects.unknownLogged) fails.push('未知命令没有被记录（白名单形同虚设）');
    if (report.rejects.nonexistentLogged !== true) fails.push('ack-session 传不存在的会话没有被拒');
    if (!report.rejects.barStillVisible) fails.push('非法命令把面板弄没了');
    if (!report.follow.followed) fails.push('拖动宠物时控制条没有跟随');
    if (!report.flip.flippedAbove) fails.push('宠物贴到工作区底边时控制条没有翻到上方');
    if (!report.windowStyle.toolWindow) fails.push('控制条没有 WS_EX_TOOLWINDOW（可能出现在 Alt+Tab / 任务栏）');
    if (afterClose !== false) fails.push('close-bar 没有收起面板');
    if (!petHidden) fails.push('hide-pet 没有隐藏宠物');
    if (barAfterHidePet) fails.push('宠物隐藏后控制条还在');
    report.failures = fails;
    report.verdict = fails.length === 0 ? 'PASS' : 'FAIL';
    log(`[probe] 判定：${report.verdict}${fails.length ? ' —— ' + fails.join('；') : ''}`);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    log('[probe] 失败：' + report.error);
  }
  try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); } catch (_) { /* ignore */ }
  const actions = globalThis.__petActions;
  if (actions) actions.quit();
  await sleep(2500);
  app.exit(0);
});
