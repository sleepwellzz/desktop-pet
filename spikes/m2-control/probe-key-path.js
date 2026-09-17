'use strict';
/**
 * 探针：控制条的**键盘路径**与焦点行为（M2 ④）。
 *
 * 为什么单独跑这一个（设计 §3.3）：ADR 009 的结论是"`hide()` → `show()` 之后，
 * Windows 不再把**鼠标按钮事件**路由到该窗口，只有重建渲染层能恢复"。控制条要收键盘
 * （Esc，将来还有输入框），而键盘事件的投递走的是另一条路径（焦点 → 消息队列），
 * **从没验过**。这条结论直接决定实现：
 *
 *   键盘不受影响 → 隐藏/显示不必 reload（更简单）；
 *   键盘也断     → 每次显示后必须 reload 渲染层。
 *
 * 同时钉住 2026-09-17 的新交互模型（ADR 016）：
 *   - **悬停不再唤出**（停在宠物上 1.8 秒必须什么都不发生）；
 *   - **右键宠物 = 唤出**，且唤出即抢焦点（所以键盘与 Esc 都可达）；
 *   - 收起后再唤出，键盘照常投递。
 *
 * 用法：node spikes/m2-control/run.mjs key-path
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'key-path.log');
const REPORT = path.join(__dirname, 'key-path.json');
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

// —— 真实输入注入（与 spikes/m2-hotkey 同一套）——
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const keybd_event = user32.func('void keybd_event(uint vk, uint scan, uint flags, uint64_t extra)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const MOVE = 0x0001, ABSOLUTE = 0x8000, KEYUP = 0x0002;
const RIGHT_DOWN = 0x0008, RIGHT_UP = 0x0010;
const VK_LWIN = 0x5B, VK_MENU = 0x12, VK_P = 0x50, VK_A = 0x41, VK_ESCAPE = 0x1B;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);

const tap = (vk) => { keybd_event(vk, 0, 0, 0); keybd_event(vk, 0, KEYUP, 0); };
async function pressHotkey() {
  keybd_event(VK_LWIN, 0, 0, 0);
  keybd_event(VK_MENU, 0, 0, 0);
  keybd_event(VK_P, 0, 0, 0);
  await sleep(70);
  keybd_event(VK_P, 0, KEYUP, 0);
  keybd_event(VK_MENU, 0, KEYUP, 0);
  keybd_event(VK_LWIN, 0, KEYUP, 0);
}

try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* ignore */ }
process.argv.push('--expose-actions');
process.argv.push(`--status-file=${STATUS_FILE}`);
require(path.join(DIST, 'main', 'index.js'));

/** 在控制条页面里装一个 keydown 计数器。用**捕获阶段**，避免被页面自身的处理吞掉。 */
const INJECT = `
window.__keys = { down: 0, esc: 0, last: '' };
document.addEventListener('keydown', function (e) {
  window.__keys.down++;
  window.__keys.last = e.key;
  if (e.key === 'Escape') window.__keys.esc++;
}, true);
'ok'`;

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
    if (!bar) throw new Error('未等到控制条窗口（标题应为 desktop-pet-control-bar）');
    await sleep(2500);

    const dbg = globalThis.__petDebug;
    if (!dbg) throw new Error('拿不到 __petDebug（--expose-actions 没生效？）');
    log(`[probe] 宠物窗=${!!pet} 控制条窗=${!!bar} 快捷键=${dbg.hotkey()} DPR=${dpr}`);

    const keys = async () => bar.webContents.executeJavaScript('JSON.stringify(window.__keys)')
      .then((s) => JSON.parse(s)).catch(() => null);
    const step = async (label) => {
      const s = { label, visible: dbg.barVisible(), focused: bar.isFocused(), keys: await keys() };
      report.steps.push(s);
      log(`[probe] ${label}：visible=${s.visible} focused=${s.focused} keys=${JSON.stringify(s.keys)}`);
      return s;
    };

    // 页面可能还没加载完，过早注入会丢
    if (bar.webContents.isLoading()) {
      await new Promise((r) => bar.webContents.once('did-finish-load', r));
      await sleep(300);
    }
    await bar.webContents.executeJavaScript(INJECT);
    await step('初始（未唤出）');

    const petCenterPx = () => {
      const p = pet.getContentBounds();
      return px(p.x + p.width / 2, p.y + p.height / 2);
    };
    const rightClickPet = async () => {
      const p = petCenterPx();
      moveTo(p.x, p.y); await sleep(450);
      mouse_event(RIGHT_DOWN, 0, 0, 0, 0); await sleep(70);
      mouse_event(RIGHT_UP, 0, 0, 0, 0);
      await sleep(1100);
    };

    // —— ① 悬停不再唤出（2026-09-17 移除了这条路径，必须钉住"不会自己回来"）——
    // 这是新旧模型之间最容易悄悄回流的差异：谁要是把悬停逻辑加回来，这里立刻红。
    const c = petCenterPx();
    moveTo(c.x, c.y);
    await sleep(1800);
    const hovered = await step('光标停在宠物中心 1.8 秒（期望：什么都不发生）');
    report.hoverShows = hovered.visible;

    // —— ② 右键宠物唤出：应当**抢焦点**（否则键盘与 Esc 都到不了面板）——
    await rightClickPet();
    const k1 = (await keys())?.down ?? 0;
    const shown = await step('右键宠物（期望可见且抢到焦点）');
    tap(VK_A);
    await sleep(500);
    const shownKey = await step('唤出后按 A（预期收得到）');
    report.rightClickShow = {
      visible: shown.visible, focused: shown.focused,
      keyDelta: (shownKey.keys?.down ?? 0) - k1,
    };

    // —— ③ 关键：hide → show 往返之后，键盘还进不进得来 ——
    // 这就是 ADR 009 那个坑在**键盘路径**上的复现实验。
    await pressHotkey();          // 收起
    await sleep(1200);
    const hidden = await step('按快捷键收起');
    await pressHotkey();          // 再唤出
    await sleep(1500);
    const k2 = (await keys())?.down ?? 0;
    const reshown = await step('再次唤出（hide→show 往返后）');
    tap(VK_A);
    await sleep(500);
    const reshownKey = await step('往返后按 A');
    report.roundTrip = {
      hiddenVisible: hidden.visible,
      visible: reshown.visible,
      focused: reshown.focused,
      keyDelta: (reshownKey.keys?.down ?? 0) - k2,
      keysAlive: reshownKey.keys !== null,
    };

    // —— ④ Esc 真的能收起，且收起来之后不会自己回来 ——
    const beforeEsc = dbg.barVisible();
    tap(VK_ESCAPE);
    await sleep(1000);
    const afterEsc = await step('按 Esc（期望收起）');
    await sleep(800);
    const staysHidden = await step('Esc 收起后停留 0.8 秒（期望仍不可见）');
    report.escape = {
      before: beforeEsc, after: afterEsc.visible, escCount: afterEsc.keys?.esc ?? 0,
      staysHidden: !staysHidden.visible,
    };

    // —— 判定 ——
    const fails = [];
    if (report.hoverShows) fails.push('光标停在宠物上 1.8 秒把面板唤出来了（悬停应已彻底移除）');
    if (!report.rightClickShow.visible) fails.push('右键宠物没能唤出控制条');
    if (!report.rightClickShow.focused) fails.push('右键唤出后没有拿到焦点（键盘将永远进不来）');
    if (report.rightClickShow.keyDelta < 1) fails.push('右键唤出后键盘事件收不到（焦点拿到了但消息不通）');
    if (report.roundTrip.hiddenVisible !== false) fails.push('快捷键没能收起控制条（往返用例前置不成立）');
    if (!report.roundTrip.keysAlive) fails.push('往返后页面里的计数器丢了（说明渲染层被 reload，注入失效）');
    if (!report.roundTrip.visible) fails.push('往返后没能再次唤出');
    if (report.roundTrip.keyDelta < 1) fails.push('hide→show 往返之后键盘事件不再投递（ADR 009 在键盘路径同样复现 → 必须 reload）');
    if (report.escape.before !== true) fails.push('按 Esc 前控制条不是可见的（用例前置不成立）');
    if (report.escape.after !== false) fails.push('Esc 没能收起控制条');
    if (!report.escape.staysHidden) fails.push('Esc 收起后面板又自己回来了');
    report.failures = fails;
    report.verdict = fails.length === 0 ? 'PASS' : 'FAIL';
    log(`[probe] 判定：${report.verdict}${fails.length ? ' —— ' + fails.join('；') : ''}`);
    log(`[probe] 摘要：悬停唤出=${report.hoverShows}（应 false）｜右键唤出抢焦点=${report.rightClickShow.focused}（应 true）`
      + `｜键盘增量 右键唤出=${report.rightClickShow.keyDelta} 往返后=${report.roundTrip.keyDelta}`
      + `｜Esc 收起=${report.escape.after === false} 收回后不自动重现=${report.escape.staysHidden}`);
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
