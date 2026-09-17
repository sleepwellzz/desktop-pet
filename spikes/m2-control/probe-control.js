'use strict';
/**
 * 探针：控制条本体（M2 ④）。
 *
 * 验的都是"只有真实窗口才能回答"的事（键盘/焦点那条在 probe-key-path.js）：
 *   1. **贴宠物下方 8 DIP、水平居中** —— 位置算式唯一的观感指标；
 *   2. **跟随**：拖动宠物时面板跟着走；
 *   3. **贴边翻转**：宠物拖到工作区底边时翻到上方（不然面板会跑到屏幕外）；
 *   4. **面板内容与仲裁器一致**：会话行数、状态文案、宠物名、确认按钮；
 *   5. **点「确认」真的解除粘滞**（走真实 DOM 点击 → preload → IPC → 主进程）；
 *   6. **命令白名单**：合法 id 落到真动作；非法 id 被忽略且不抛异常；
 *      `ack-session` 传不存在的会话被拒；
 *   7. **Alt+Tab / 任务栏**：读扩展样式位 WS_EX_TOOLWINDOW（PLAN §8 的"流氓软件"风险项）；
 *   8. **唤出手势 = 右键宠物**（真实注入右键），再右键一次收起；
 *   9. **悬停不再唤出**（2026-09-17 移除的能力，必须钉住"不会自己回来"）；
 *  10. **「⋯」弹原生菜单时面板不被自己的失焦收掉**（菜单会夺焦，必须屏蔽）；
 *  11. **「清空状态会话」把视图也清掉**：面板行数 0、菜单计数 0（ADR 016 / D2）。
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
const RIGHT_DOWN = 0x0008, RIGHT_UP = 0x0010;
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
// 关掉自主行为层：宠物自己走动会把位置类断言搅乱（行为层有自己的探针 spikes/m3-behavior）。
process.argv.push('--no-behavior');
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
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pet.json'), 'utf8'));
    const expectGapBelow = sidecar.controlBar.gapBelowPet;

    const dom = async () => bar.webContents.executeJavaScript(`JSON.stringify({
      rows: [...document.querySelectorAll('#sessions .row')].map(r => r.textContent),
      ackButtons: document.querySelectorAll('#sessions .row .ack').length,
      summary: document.getElementById('summary').textContent,
      petName: document.getElementById('pet-name').textContent,
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

    /**
     * 唤出面板 —— 走**产品路径：真实右键宠物**（ADR 016）。
     * 已可见时什么都不做（右键是 toggle，重复注入会把它关掉）。
     * 所有用例都经由它取"可见"这个前置，因此手势一旦失效，整个探针会立刻报错而不是静默跳过。
     */
    const ensureBar = async () => {
      if (dbg.barVisible()) return true;
      const c = pet.getContentBounds();
      const p = px(c.x + c.width / 2, c.y + c.height / 2);
      moveTo(p.x, p.y);
      await sleep(500);                       // 等渲染层的命中判定把窗口切成可交互
      mouse_event(RIGHT_DOWN, 0, 0, 0, 0); await sleep(70);
      mouse_event(RIGHT_UP, 0, 0, 0, 0);
      for (let i = 0; i < 20 && !dbg.barVisible(); i += 1) await sleep(100);
      return dbg.barVisible();
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
    if (!(await ensureBar())) throw new Error('右键宠物没有唤出控制条（手势本身失效，后续用例全部不成立）');
    await sleep(500);
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
    // **前置：面板必须可见**。面板不可见时 `refreshBar()` 会早退 —— 那是正确设计
    // （重新显示时 `show()` 会推最新内容），但本用例要验的是"面板内容随仲裁器更新"。
    // 2026-09-17 踩过：面板已收起时读 DOM，读到的是上一次渲染的旧内容，报出连环假失败。
    if (!dbg.barVisible()) await ensureBar();
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
      + `｜宠物名「${d1.petName}」`
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

    // —— ④ 命令白名单 ——
    // 面板上的 − / + / ↺ 已在人工验收后撤掉（缩放统一走菜单），所以这里只验白名单边界：
    // 非法 id 与"不存在的会话"都必须被拒绝，且不能把面板或主进程弄坏。
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

    // —— ⑧ 面板 × ：真实 DOM 点击立即收起，且**不会自己弹回来** ——
    // 用户 2026-09-16 报的问题正是"× 点了没反应"，直接 send 命令会绕过
    // "按钮上有没有 data-cmd"那一层，恰好验不出那个 bug。
    // 收起后光标仍停在宠物上，1.5 秒的追加采样同时钉住"没有悬停就不会自己回来"。
    if (!dbg.barVisible()) await ensureBar();
    const closeClicked = await bar.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('#close');
      if (!b) return 'no-button';
      const cmd = b.dataset.cmd || '';
      b.click();
      return 'clicked:' + (cmd || '(no-datacmd)');
    })()`).catch((e) => 'error:' + String(e));
    await sleep(900);
    const afterClose = dbg.barVisible();
    await sleep(1500);                        // 光标还停在宠物上
    const staysHiddenAfterClose = !dbg.barVisible();
    report.closeByX = { closeClicked, afterCloseBar: afterClose, staysHiddenAfterClose };
    log(`[probe] 点面板 × ：${closeClicked} → 面板可见=${afterClose}（期望 false）`
      + ` ｜ 1.5 秒后仍不可见=${staysHiddenAfterClose}（期望 true）`);

    // —— ⑨ 右键宠物唤出 / 再右键一次收起（真实注入右键，ADR 016 的产品路径）——
    const petForClick = pet.getContentBounds();
    const petCenterPx = () => {
      const c = pet.getContentBounds();
      return px(c.x + c.width / 2, c.y + c.height / 2);
    };
    const rightClickPet = async () => {
      const p = petCenterPx();
      moveTo(p.x, p.y); await sleep(450);
      mouse_event(RIGHT_DOWN, 0, 0, 0, 0); await sleep(70);
      mouse_event(RIGHT_UP, 0, 0, 0, 0);
      await sleep(900);
    };
    await rightClickPet();
    const shownByRightClick = dbg.barVisible();
    const shownState = dbg.barState();
    await rightClickPet();
    const hiddenByRightClick = !dbg.barVisible();
    report.rightClickPet = {
      pet: petForClick, shownByRightClick, focusedWhenShown: shownState,
      hiddenByRightClick,
    };
    log(`[probe] 右键宠物：唤出=${shownByRightClick}（状态机 ${JSON.stringify(shownState)}）`
      + ` → 再右键一次收起=${hiddenByRightClick}`);

    // —— ⑩ 悬停不再唤出（已移除的能力，钉住"不会自己回来"）——
    // 面板此刻不可见。光标移到宠物正中心停 1.8 秒，再移到"面板消失前那块矩形"里停 1.8 秒 ——
    // 都必须仍然不可见。从前这里是本功能的唤出路径（300ms 悬停出现），现在反过来是**反例**。
    const ghostRect = bar.getContentBounds();
    const petCenter2 = petCenterPx();
    moveTo(petCenter2.x, petCenter2.y);
    await sleep(1800);
    const hoverShows = dbg.barVisible();
    const ghostPx = px(ghostRect.x + 10, ghostRect.y + Math.round(ghostRect.height / 2));
    moveTo(ghostPx.x, ghostPx.y);
    await sleep(1800);
    const ghostShows = dbg.barVisible();
    report.noHover = { hoverShows, ghostShows, ghostRect, petCenter: petCenterPx() };
    log(`[probe] 悬停不再唤出：停在宠物上 1.8 秒 → 可见=${hoverShows}（期望 false）｜`
      + `停在旧面板矩形内 1.8 秒 → 可见=${ghostShows}（期望 false）`);

    // —— ⑪ 「⋯」弹原生菜单时，面板不能被自己的失焦收掉 ——
    // 原生菜单会夺走弹出它的窗口的焦点；不屏蔽的话面板会在菜单弹出的同一瞬间吃到 blur，
    // `blurHideMs` 后连菜单一起消失 —— 表现就是"⋯ 点了没反应"，且只有真手点才复现。
    if (!dbg.barVisible()) await ensureBar();
    const menuClicked = await bar.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('#actions button[data-cmd="popup-menu"]');
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`).catch((e) => 'error:' + String(e));
    await sleep(1200);
    const barAliveUnderMenu = dbg.barVisible();
    report.popupMenu = { menuClicked, barAliveUnderMenu };
    log(`[probe] 点「⋯」：${menuClicked} → 菜单打开 1.2 秒后面板仍在=${barAliveUnderMenu}（期望 true）`);

    // —— ⑫ 「清空状态会话」必须把视图也清掉（ADR 016 / D2）——
    // 从前只清文件：主状态会回落 idle（宠物确实松手了），但面板照旧列两行 idle、
    // 菜单照旧写「清空状态会话（2 条）」，要等 15 分钟静默兜底才轮到它们。
    if (!dbg.barVisible()) await ensureBar();
    writeStatus({
      a: { status: 'running', title: 'a', ts: now() },
      b: { status: 'needs-input', title: '等你拍板', ts: now() },
    });
    await sleep(2200);
    const beforeClear = await dom();
    const menuBefore = dbg.menuView();
    const bbBeforeClear = dbg.barBounds();
    globalThis.__petActions.clearSessions();
    await sleep(1400);
    const afterClear = await dom();
    const menuAfter = dbg.menuView();
    const bbAfterClear = dbg.barBounds();
    const fileAfterClear = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    report.clearSessions = {
      rowsBefore: beforeClear.rows?.length, rowsAfter: afterClear.rows?.length,
      ackButtonsBefore: beforeClear.ackButtons, ackButtonsAfter: afterClear.ackButtons,
      summaryBefore: beforeClear.summary, summaryAfter: afterClear.summary,
      menuCountBefore: menuBefore.sessionCount, menuCountAfter: menuAfter.sessionCount,
      heightBefore: bbBeforeClear?.height, heightAfter: bbAfterClear?.height,
      fileSessions: Object.keys(fileAfterClear.sessions ?? {}),
    };
    log(`[probe] 清空会话：行数 ${report.clearSessions.rowsBefore} → ${report.clearSessions.rowsAfter}（期望 0）｜`
      + `菜单计数 ${report.clearSessions.menuCountBefore} → ${report.clearSessions.menuCountAfter}（期望 0）｜`
      + `面板高度 ${report.clearSessions.heightBefore} → ${report.clearSessions.heightAfter}`
      + `（期望回落 ${report.placement.expectHeight}）｜摘要「${report.clearSessions.summaryBefore}」→「${report.clearSessions.summaryAfter}」`);

    // —— ⑬ 面板「隐藏宠物」：面板跟着收起 ——
    await send({ id: 'hide-pet' });
    await sleep(600);
    const petHidden = !pet.isVisible();
    const barAfterHidePet = dbg.barVisible();
    report.teardown = { petHidden, barAfterHidePet };
    log(`[probe] hide-pet → 宠物可见=${pet.isVisible()}（期望 false）面板可见=${barAfterHidePet}（期望 false）`);

    // —— 判定 ——
    const fails = [];
    if (bb == null) fails.push('拿不到控制条矩形（右键宠物没有唤出面板）');
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
    // 面板显示的是宠物包里的名字（原来是只读的缩放百分比，2026-09-17 换掉，见 ADR 016）
    if (d1.petName !== manifest.displayName) {
      fails.push(`面板显示的宠物名是「${d1.petName}」，期望「${manifest.displayName}」（pet.json 的 displayName）`);
    }
    if (clicked !== 'clicked') fails.push('点不到确认按钮：' + clicked);
    if (d2.ackButtons !== 0) fails.push('点确认后按钮仍在（粘滞没解除）');
    if (!report.rejects.unknownLogged) fails.push('未知命令没有被记录（白名单形同虚设）');
    if (report.rejects.nonexistentLogged !== true) fails.push('ack-session 传不存在的会话没有被拒');
    if (!report.rejects.barStillVisible) fails.push('非法命令把面板弄没了');
    if (!report.follow.followed) fails.push('拖动宠物时控制条没有跟随');
    if (!report.flip.flippedAbove) fails.push('宠物贴到工作区底边时控制条没有翻到上方');
    if (!report.windowStyle.toolWindow) fails.push('控制条没有 WS_EX_TOOLWINDOW（可能出现在 Alt+Tab / 任务栏）');
    if (report.closeByX.closeClicked !== 'clicked:close-bar') {
      fails.push('面板右上角的 × 不可用：' + report.closeByX.closeClicked);
    }
    if (afterClose !== false) fails.push('点 × 后面板没有收起');
    if (!report.closeByX.staysHiddenAfterClose) fails.push('点 × 后 1.5 秒面板又自己回来了（有东西在重新唤出它）');
    // —— 新交互模型的两条核心判据 ——
    if (!report.rightClickPet.shownByRightClick) fails.push('右键宠物没有唤出控制条');
    if (!report.rightClickPet.hiddenByRightClick) fails.push('再右键宠物一次没有收起控制条（toggle 失效）');
    if (report.noHover.hoverShows) fails.push('悬停宠物把面板唤出来了（悬停应已彻底移除）');
    if (report.noHover.ghostShows) fails.push('光标落在旧面板矩形内把面板唤出来了');
    if (report.popupMenu.menuClicked !== 'clicked') fails.push('点不到面板上的「⋯」：' + report.popupMenu.menuClicked);
    if (!report.popupMenu.barAliveUnderMenu) fails.push('「⋯」弹出原生菜单时面板被自己的失焦收掉了（菜单会跟着消失）');
    // —— 清空会话（D2）——
    if (report.clearSessions.rowsBefore !== 2) fails.push(`清空前置不成立：面板行数 ${report.clearSessions.rowsBefore}，期望 2`);
    if (report.clearSessions.rowsAfter !== 0) fails.push(`清空后面板仍有 ${report.clearSessions.rowsAfter} 行（视图没清干净）`);
    if (report.clearSessions.ackButtonsAfter !== 0) fails.push('清空后仍有确认按钮');
    if (report.clearSessions.menuCountBefore !== 2) fails.push(`清空前置不成立：菜单计数 ${report.clearSessions.menuCountBefore}，期望 2`);
    if (report.clearSessions.menuCountAfter !== 0) fails.push(`清空后菜单仍写「（${report.clearSessions.menuCountAfter} 条）」`);
    if (report.clearSessions.fileSessions.length !== 0) fails.push('状态文件里仍有会话');
    if (report.clearSessions.heightAfter !== report.placement.expectHeight) {
      fails.push(`清空后面板高度 ${report.clearSessions.heightAfter}，期望回落 ${report.placement.expectHeight}`);
    }
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
