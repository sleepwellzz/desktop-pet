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
 * 顺便量两件只有真实探针能回答的事：
 *   - 悬停唤出**不抢焦点**（用户可能正在 IDE 里打字）；
 *   - 快捷键唤出**抢焦点**（用户明确按了键）；
 *   - Esc 真的能收起。
 *
 * 用法：node spikes/m2-control/run.mjs
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
    const snap = () => ({ visible: dbg.barVisible(), focus: bar.isFocused(), keys: null });
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

    // —— ① 悬停唤出：应当**不抢焦点** ——
    const pb = pet.getContentBounds();
    const center = px(pb.x + pb.width / 2, pb.y + pb.height / 2);
    moveTo(center.x, center.y);
    await sleep(1200);
    const hovered = await step('悬停宠物 1.2 秒（期望出现且不抢焦点）');
    report.hover = { visible: hovered.visible, focused: hovered.focused };

    // 悬停唤出后注入一个普通按键：没焦点就应当收不到（这是设计要的，不是缺陷）
    const k0 = hovered.keys?.down ?? 0;
    tap(VK_A);
    await sleep(500);
    const hoverKey = await step('悬停唤出后按 A（无焦点 → 预期收不到）');
    report.hoverKeyboard = (hoverKey.keys?.down ?? 0) - k0;

    // —— 光标移开，等宽限收起 ——
    moveTo(px(60, 60).x, px(60, 60).y);
    await sleep(1400);
    await step('光标移开 1.4 秒（期望已收起）');

    // —— ② 快捷键唤出：应当**抢焦点** ——
    await pressHotkey();
    await sleep(1500);
    const k1 = (await keys())?.down ?? 0;
    const shown = await step('快捷键唤出（期望可见且抢到焦点）');
    tap(VK_A);
    await sleep(500);
    const shownKey = await step('快捷键唤出后按 A（预期收得到）');
    report.hotkeyShow = { visible: shown.visible, focused: shown.focused, keyDelta: (shownKey.keys?.down ?? 0) - k1 };

    // —— ③ 关键：hide → show 往返之后，键盘还进不进得来 ——
    // 这就是 ADR 009 那个坑在**键盘路径**上的复现实验。
    await pressHotkey();          // 收起
    await sleep(1200);
    const hidden = await step('再按快捷键收起');
    await pressHotkey();          // 唤出
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

    // —— ④ Esc 真的能收起 ——
    const beforeEsc = dbg.barVisible();
    tap(VK_ESCAPE);
    await sleep(1000);
    const afterEsc = await step('按 Esc（期望收起）');
    report.escape = { before: beforeEsc, after: afterEsc.visible, escCount: afterEsc.keys?.esc ?? 0 };

    // —— 判定 ——
    const fails = [];
    if (!report.hover.visible) fails.push('悬停宠物 1.2 秒后控制条没有出现');
    if (report.hover.focused) fails.push('悬停唤出抢了焦点（应当 showInactive 不抢）');
    if (!report.hotkeyShow.visible) fails.push('快捷键没能唤出控制条');
    if (!report.hotkeyShow.focused) fails.push('快捷键唤出后没有拿到焦点（键盘将永远进不来）');
    if (report.hotkeyShow.keyDelta < 1) fails.push('快捷键唤出后键盘事件收不到（焦点拿到了但消息不通）');
    if (!report.roundTrip.keysAlive) fails.push('往返后页面里的计数器丢了（说明渲染层被 reload，注入失效）');
    if (report.roundTrip.keyDelta < 1) fails.push('hide→show 往返之后键盘事件不再投递（ADR 009 在键盘路径同样复现 → 必须 reload）');
    if (report.escape.before !== true) fails.push('按 Esc 前控制条不是可见的（用例前置不成立）');
    if (report.escape.after !== false) fails.push('Esc 没能收起控制条');
    report.failures = fails;
    report.verdict = fails.length === 0 ? 'PASS' : 'FAIL';
    log(`[probe] 判定：${report.verdict}${fails.length ? ' —— ' + fails.join('；') : ''}`);
    log(`[probe] 摘要：悬停唤出抢焦点=${report.hover.focused}（应 false）｜快捷键唤出抢焦点=${report.hotkeyShow.focused}（应 true）`
      + `｜键盘增量 悬停=${report.hoverKeyboard} 快捷键=${report.hotkeyShow.keyDelta} 往返后=${report.roundTrip.keyDelta}`
      + `｜Esc 收起=${report.escape.after === false}`);
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
