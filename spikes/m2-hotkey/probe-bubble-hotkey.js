'use strict';
/**
 * 探针：气泡层与全局快捷键（M2 ③）。
 *
 * 验四件事，都用可观测结果判定：
 *   1. **快捷键**（默认 Win+Alt+P）真的能切换宠物显示/隐藏 —— 注入真实击键，不调内部函数；
 *   2. **气泡**按策略出现/收起/常驻 —— 读的是气泡页面里真实渲染出的文本，不是"窗口存在"；
 *   3. **多会话角标**（+N）跟着气泡出现；
 *   4. 新增窗口**没有影响命中判定** —— 气泡工作期间宠物仍可单击（ADR 008 的回归）。
 *
 * 用法：node spikes/m2-hotkey/run.mjs
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'bubble-hotkey.log');
const REPORT = path.join(__dirname, 'bubble-hotkey.json');
const STATUS_FILE = path.join(__dirname, 'probe-status.json');
const EVENT_LOG = path.join(__dirname, 'probe-events.jsonl');

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
koffi.struct('B_POINT', { x: 'int', y: 'int' });
const POINT_SIZE = koffi.sizeof('B_POINT');
const GetCursorPos = user32.func('bool GetCursorPos(B_POINT *pt)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const keybd_event = user32.func('void keybd_event(uint vk, uint scan, uint flags, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000, KEYUP = 0x0002;
const VK_LWIN = 0x5B, VK_MENU = 0x12, VK_P = 0x50;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);
function cursorNow() { const b = Buffer.alloc(POINT_SIZE); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; }

const INJECT = `
window.__ev = { down: 0 };
document.addEventListener('pointerdown', function () { window.__ev.down++; }, true);
'ok'`;

try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* ignore */ }
process.argv.push('--expose-actions');
process.argv.push(`--status-file=${STATUS_FILE}`);
process.argv.push(`--event-log=${EVENT_LOG}`);
require(path.join(DIST, 'main', 'index.js'));

/** 状态文件写入（与 tools/pet-hook.mjs 同格式，原子替换）。 */
function writeStatus(sessions) {
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'desktop-pet/status/v1', sessions }, null, 2), 'utf8');
  fs.renameSync(tmp, STATUS_FILE);
}
const now = () => Date.now();

async function waitForWindow(title, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === title);
    if (w) return w;
    await sleep(250);
  }
  return null;
}

app.whenReady().then(async () => {
  const report = { steps: [] };
  const dpr = screen.getPrimaryDisplay().scaleFactor;
  const px = (x, y) => ({ x: Math.round(x * dpr), y: Math.round(y * dpr) });
  try {
    const pet = await waitForWindow('desktop-pet', 20000);
    if (!pet) throw new Error('未等到桌宠窗口');
    await sleep(2500);
    // 气泡窗每次现查：它一开始是隐藏的，而且**窗口标题由页面 <title> 决定**
    // （曾经写成 "bubble"，导致这里按 'desktop-pet-bubble' 查不到）。
    const bubbleWindow = () => BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === 'desktop-pet-bubble') ?? null;
    const dbg = globalThis.__petDebug;
    report.debugAvailable = !!dbg;
    if (!dbg) throw new Error('拿不到 __petDebug（--expose-actions 没生效？）');
    log(`[probe] 宠物窗=${!!pet} 气泡窗=${!!bubbleWindow()} 快捷键=${dbg.hotkey()} DPR=${dpr}`);

    /** 读气泡**页面里真实渲染出的文本**（不是"窗口存在"这种弱证据）。 */
    const bubbleText = async () => {
      const w = bubbleWindow();
      if (!w) return null;
      return w.webContents.executeJavaScript(
        `JSON.stringify({ hidden: document.body.classList.contains('hidden'), text: document.getElementById('text').textContent, badge: document.getElementById('badge').textContent })`,
      ).then((s) => JSON.parse(s)).catch(() => null);
    };
    const injectPet = async () => { await pet.webContents.executeJavaScript(INJECT).catch(() => {}); };
    await injectPet();

    // —— 用例 1：快捷键切换显示（注入真实击键 Win+Alt+P）——
    const pressHotkey = async () => {
      keybd_event(VK_LWIN, 0, 0, 0);
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_P, 0, 0, 0);
      await sleep(70);
      keybd_event(VK_P, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
      keybd_event(VK_LWIN, 0, KEYUP, 0);
      await sleep(1200);
    };
    const visBefore = pet.isVisible();
    await pressHotkey();
    const visAfterHide = pet.isVisible();
    await pressHotkey();
    await sleep(1500);
    const visAfterShow = pet.isVisible();
    await injectPet();
    report.hotkey = { accelerator: dbg.hotkey(), visBefore, visAfterHide, visAfterShow };
    log(`[probe] 快捷键 ${dbg.hotkey()}：${visBefore} → 按下后 ${visAfterHide} → 再按 ${visAfterShow}` +
      ` → ${!visAfterHide && visAfterShow ? '✅ 切换正常' : '❌ 没切换'}`);

    // —— 用例 2：气泡按策略显示 / 常驻 / 到期收起 ——
    const bubbleCase = async (label, sessions, waitMs) => {
      writeStatus(sessions);
      await sleep(waitMs);
      const state = dbg.bubbleState();
      const rendered = await bubbleText();
      const bw = bubbleWindow();
      const rect = bw ? bw.getContentBounds() : null;
      const petBounds = pet.getContentBounds();
      const overlap = rect && !(rect.x + rect.width <= petBounds.x || rect.x >= petBounds.x + petBounds.width
        || rect.y + rect.height <= petBounds.y || rect.y >= petBounds.y + petBounds.height);
      const rec = { label, visible: state.visible, text: state.text, badge: state.badge, hideAt: state.hideAt, rendered, rect, overlapsPet: !!overlap };
      report.steps.push(rec);
      log(`[probe] ${label}：策略 visible=${state.visible}「${state.text ?? ''}」badge=${state.badge} ` +
        `｜页面 hidden=${rendered?.hidden} 文本「${rendered?.text ?? ''}」角标「${rendered?.badge ?? ''}」` +
        `｜窗 ${rect ? `${rect.width}x${rect.height}@${rect.x},${rect.y}` : '无'} 与宠物重叠=${overlap ? '是' : '否'}`);
      return rec;
    };

    await bubbleCase('running（2 秒后应自动收起）', { a: { status: 'running', title: 'a', ts: now() } }, 700);
    await bubbleCase('running 心跳（不重置计时）', { a: { status: 'running', title: 'a', ts: now() } }, 400);
    await sleep(1600);
    const afterExpire = { visible: dbg.bubbleVisible(), state: dbg.bubbleState() };
    log(`[probe] running 到期后：窗口可见=${afterExpire.visible} 策略 visible=${afterExpire.state.visible}`);
    report.steps.push({ label: 'running 到期收起', ...afterExpire });

    await bubbleCase('needs-input（常驻）+ 多会话角标', {
      a: { status: 'running', title: 'a', ts: now() },
      b: { status: 'needs-input', title: 'b', ts: now() },
    }, 700);
    await sleep(2500);
    log(`[probe] needs-input 2.5 秒后仍应常驻：窗口可见=${dbg.bubbleVisible()}`);
    // 截一张气泡本体，供人眼核对观感（间距、圆角、角标位置）
    try {
      const bw = bubbleWindow();
      if (bw) {
        const shot = await bw.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'bubble-shot.png'), shot.toPNG());
        log('[probe] 已保存 bubble-shot.png');
      }
    } catch (e) {
      log('[probe] 气泡截图失败：' + String(e));
    }

    // —— 用例 2b：气泡里文字**有没有被裁、有没有居中** ——
    // 起因（2026-09-16 用户实测）：`line-height: 1` 让行盒只有 13px，而雅黑 13px 自身的
    // ascent+descent ≈ 17.2px —— 字形上下各溢出约 2px，被 #text / #bubble 的 overflow:hidden
    // 裁掉，症状是"每个字的最下方显示不全"。
    // 判据不靠肉眼看截图：用 canvas 的字体度量算出**墨迹盒**，再与行盒比，得到像素级的裁切量；
    // 水平方向同理，量左右余量判断是否真居中（flex 默认 flex-start，估算宽度多出来的余量全落右侧）。
    const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '?');
    const textGeometry = async () => {
      const w = bubbleWindow();
      if (!w) return null;
      return w.webContents.executeJavaScript(`(() => {
        const bubble = document.getElementById('bubble');
        const textEl = document.getElementById('text');
        const badgeEl = document.getElementById('badge');
        const cs = getComputedStyle(textEl);
        const cv = document.createElement('canvas').getContext('2d');
        cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const m = cv.measureText(textEl.textContent || '');
        const boxH = textEl.getBoundingClientRect().height;
        const br = bubble.getBoundingClientRect();
        const tr = textEl.getBoundingClientRect();
        const badgeVisible = !!badgeEl.textContent && getComputedStyle(badgeEl).display !== 'none';
        const contentRight = badgeVisible ? badgeEl.getBoundingClientRect().right : tr.right;
        const bcs = getComputedStyle(bubble);
        return JSON.stringify({
          text: textEl.textContent, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
          // 仅供参考：canvas 的字体度量与 Chromium 排版用的度量**不是同一套**，
          // 实测按它反推的裁切量与真实渲染对不上（算出 0，而像素证据显示被裁）。
          // 所以"有没有被裁"一律以 inkRows() 的差分取值为准，这里只留作背景信息。
          canvasFontBox: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent,
          lineBoxH: boxH, clientH: textEl.clientHeight,
          canvasInkHeight: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
          slackLeft: tr.left - br.left - parseFloat(bcs.paddingLeft),
          slackRight: br.right - contentRight - parseFloat(bcs.paddingRight),
          pillHeight: br.height,
        });
      })()`).then((s) => JSON.parse(s)).catch((e) => ({ error: String(e) }));
    };
    const geo = await textGeometry();
    report.textGeometry = geo;
    if (geo && !geo.error) {
      log(`[probe] 文字几何：字号=${geo.fontSize} line-height=${geo.lineHeight} `
        + `行盒=${f2(geo.lineBoxH)}px（canvas 估字体盒 ${f2(geo.canvasFontBox)}px / 墨迹 ${f2(geo.canvasInkHeight)}px）｜ `
        + `左右余量=${f2(geo.slackLeft)}/${f2(geo.slackRight)}px ｜ 胶囊高 ${f2(geo.pillHeight)}`);
    } else {
      log('[probe] 拿不到文字几何度量：' + (geo && geo.error));
    }

    // —— 用例 2c：文字**有没有被裁** ——
    // 差分法：同一帧截两次 —— 保留 overflow:hidden（真实渲染），再注入一段 CSS 把裁切关掉。
    // 两次的"文字墨迹行范围"之差就是被裁掉的像素数。**不依赖任何字体度量公式**，
    // 因为它比的是真实渲染结果本身（2026-09-16：正是这一点纠正了 canvas 度量给出的假阴性）。
    // 只扫 #text 的列带（避开右侧角标），所以量到的就是正文文字。
    const textBand = async () => {
      const w = bubbleWindow();
      return w.webContents.executeJavaScript(
        `(() => { const r = document.getElementById('text').getBoundingClientRect();
          return JSON.stringify({ left: r.left, right: r.right }); })()`,
      ).then(JSON.parse);
    };
    /** 在 #text 的列带里找"亮像素"（近白 = 正文文字）的首次/末次出现的行号（物理像素）。 */
    const inkRows = async () => {
      const w = bubbleWindow();
      const img = await w.webContents.capturePage();
      const { width, height } = img.getSize();
      const buf = img.toBitmap();                       // BGRA，索引 3 是 alpha
      const band = await textBand();
      const x0 = Math.max(0, Math.floor(band.left * dpr));
      const x1 = Math.min(width, Math.ceil(band.right * dpr));
      let top = -1;
      let bottom = -1;
      for (let y = 0; y < height; y += 1) {
        let bright = 0;
        for (let x = x0; x < x1; x += 1) {
          const o = (y * width + x) * 4;
          if (buf[o] > 180 && buf[o + 1] > 180 && buf[o + 2] > 180) bright += 1;
        }
        if (bright >= 2) { if (top < 0) top = y; bottom = y; }
      }
      return { width, height, x0, x1, top, bottom };
    };
    const UNCLIP = "(() => { const s = document.createElement('style'); s.id = 'probe-unclip';"
      + " s.textContent = '#bubble{overflow:visible !important} #text{overflow:visible !important}';"
      + " document.head.appendChild(s); return 'ok'; })()";
    const inkClipped = await inkRows();
    await bubbleWindow().webContents.executeJavaScript(UNCLIP).catch(() => {});
    await sleep(350);
    const inkOpen = await inkRows();
    await bubbleWindow().webContents.executeJavaScript(
      "(() => { const s = document.getElementById('probe-unclip'); if (s) s.remove(); return 'ok'; })()",
    ).catch(() => {});
    await sleep(200);
    // 差分得到的是**整数物理像素**级的事实，所以下面按物理像素判、容差为 0：
    // overflow:hidden 不该吃掉任何一列字形墨迹。正数 = 该侧被裁掉的像素数。
    const clipTopPx = Math.max(0, inkClipped.top - inkOpen.top);
    const clipBottomPx = Math.max(0, inkOpen.bottom - inkClipped.bottom);
    report.textClip = { inkClipped, inkOpen, clipTopPx, clipBottomPx, dpr };
    log(`[probe] 文字裁切（差分）：裁切时墨迹行 ${inkClipped.top}..${inkClipped.bottom}，`
      + `关掉 overflow 后 ${inkOpen.top}..${inkOpen.bottom}（窗口高 ${inkClipped.height}px @${dpr}x）`
      + ` → 被裁 上 ${clipTopPx} / 下 ${clipBottomPx} 物理像素`
      + `（${f2(clipTopPx / dpr)} / ${f2(clipBottomPx / dpr)} DIP）`);

    // —— 用例 3：拖动宠物时气泡跟随 ——
    const bwFollow = bubbleWindow();
    const beforeFollow = bwFollow ? bwFollow.getContentBounds() : null;
    if (!bwFollow || !beforeFollow) throw new Error('拖动物例需要气泡窗可见（当前查不到窗口）');
    const c0 = pet.getContentBounds();
    const from = px(c0.x + c0.width / 2, c0.y + c0.height / 2);
    moveTo(from.x, from.y); await sleep(300);
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(90);
    for (let i = 1; i <= 10; i += 1) {
      moveTo(Math.round(from.x - 300 * i / 10), Math.round(from.y - 150 * i / 10));
      await sleep(60);
    }
    mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(500);
    const afterFollow = bwFollow.getContentBounds();
    const c1 = pet.getContentBounds();
    const followed = afterFollow.x !== beforeFollow.x || afterFollow.y !== beforeFollow.y;
    report.bubbleFollow = { beforeFollow, afterFollow, petDelta: { dx: c1.x - c0.x, dy: c1.y - c0.y }, followed };
    log(`[probe] 拖宠物 ${JSON.stringify({ dx: c1.x - c0.x, dy: c1.y - c0.y })} → 气泡从 ${beforeFollow.x},${beforeFollow.y} 到 ${afterFollow.x},${afterFollow.y}` +
      ` → ${followed ? '✅ 跟随' : '❌ 没跟随'}`);

    // —— 用例 4：气泡工作期间宠物仍可点（ADR 008 回归）——
    const cb = pet.getContentBounds();
    const p = px(cb.x + cb.width / 2, cb.y + cb.height / 2);
    const a0 = await pet.webContents.executeJavaScript('window.__ev.down').catch(() => -1);
    moveTo(p.x, p.y); await sleep(400);
    mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(60); mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(400);
    const a1 = await pet.webContents.executeJavaScript('window.__ev.down').catch(() => -1);
    report.petClickDuringBubble = { before: a0, after: a1, works: a1 > a0 };
    log(`[probe] 气泡工作期间点宠物：pointerdown ${a0} → ${a1} ${a1 > a0 ? '✅ 仍可点' : '❌ 被吃掉'}`);

    // —— 判定 ——
    const fails = [];
    if (!(!report.hotkey.visAfterHide && report.hotkey.visAfterShow)) fails.push('快捷键没有切换宠物显示');
    const s1 = report.steps[0];
    if (!s1.visible || s1.rendered?.hidden || s1.rendered?.text !== '运行中') fails.push('running 气泡没显示或页面文本不对');
    if (s1.overlapsPet) fails.push('气泡与宠物重叠');
    const s2 = report.steps[1];
    if (s2.hideAt !== s1.hideAt) fails.push('心跳重置了气泡计时');
    const s3 = report.steps.find((x) => x.label === 'running 到期收起');
    if (s3.visible) fails.push('running 气泡到期后没有收起');
    const s4 = report.steps.find((x) => x.label.startsWith('needs-input'));
    if (!s4.visible || s4.badge !== 1 || s4.rendered?.badge !== '+1') fails.push('needs-input 气泡/角标不对');
    if (s4.hideAt !== null) fails.push('needs-input 不是常驻');
    const g = report.textGeometry;
    if (!g || g.error) fails.push('没量到气泡文字几何（无法判断是否居中）');
    else if (Math.abs(g.slackLeft - g.slackRight) > 2) {
      fails.push(`气泡文字没有水平居中：左余量 ${f2(g.slackLeft)}px vs 右余量 ${f2(g.slackRight)}px`);
    }
    const tc = report.textClip;
    if (!tc || tc.inkClipped.top < 0) fails.push('没量到气泡文字墨迹（无法判断是否被裁）');
    else {
      if (tc.clipTopPx > 0) fails.push(`气泡文字上缘被裁掉 ${tc.clipTopPx} 物理像素`);
      if (tc.clipBottomPx > 0) fails.push(`气泡文字下缘被裁掉 ${tc.clipBottomPx} 物理像素`);
      // 兜底：墨迹高度远小于字号，说明有大面积裁切（防差分判据本身失效时静默通过）
      const inkHeightDip = (tc.inkClipped.bottom - tc.inkClipped.top + 1) / tc.dpr;
      const fontSize = parseFloat((g && g.fontSize) || '13');
      if (inkHeightDip < fontSize * 0.7) {
        fails.push(`气泡文字墨迹只有 ${f2(inkHeightDip)} DIP 高（字号 ${f2(fontSize)}px），疑似被裁`);
      }
    }
    if (!report.bubbleFollow.followed) fails.push('拖动宠物时气泡没跟随');
    if (!report.petClickDuringBubble.works) fails.push('气泡工作期间宠物点不动了');
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
  await sleep(3000);
  app.exit(0);
});
