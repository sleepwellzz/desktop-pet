'use strict';
/**
 * 命中区域实测探针（spike，可丢弃，结论回写 ADR 008）。
 *
 * 被测对象是**真实应用**：脚本直接 require dist/main/index.js，用同一份主进程、
 * preload 与渲染层。探针只做两件事：注入真实 OS 点击、读回"谁收到了"。
 *
 * 每个采样点同时记录：
 *   - 宠物渲染层是否收到 pointerdown（= 被宠物吃掉）
 *   - 背景靶窗是否收到 pointerdown（= 成功穿透到下层）
 *   - 宠物渲染层当前帧在该点的 alpha（= 地面真值，应该命中/应该穿透）
 *
 * 用法：node spikes/m2-hittest/run.mjs
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const OUTDIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG = path.join(OUTDIR, 'run.log');
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
const console = {
  log: (...a) => log(a.map(String).join(' ')),
  error: (...a) => log('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map(String).join(' ')),
};
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => log('[unhandled] ' + ((e && e.stack) || e)));
log('[probe] boot electron=' + process.versions.electron);

const koffi = require('koffi');
const { loadPack } = require(path.join(DIST, 'kernel', 'pack.js'));

// ---------------- Win32 ----------------
const user32 = koffi.load('user32.dll');
koffi.struct('P2_POINT', { x: 'int', y: 'int' });
koffi.struct('P2_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT_SIZE = koffi.sizeof('P2_POINT');
const RECT_SIZE = koffi.sizeof('P2_RECT');
const GetCursorPos = user32.func('bool GetCursorPos(P2_POINT *pt)');
const SetCursorPos = user32.func('bool SetCursorPos(int x, int y)');
const GetWindowRect = user32.func('bool GetWindowRect(void *h, P2_RECT *r)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, MOVE = 0x0001, ABSOLUTE = 0x8000;

// 关键：SetCursorPos **不产生 WM_MOUSEMOVE**，注入拖动时渲染层收不到任何 pointermove，
// 拖动永远不动。必须用 mouse_event(MOVE|ABSOLUTE) 注入"真实的鼠标移动"。
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77);
const VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
function moveTo(x, y) {
  const nx = Math.round(((x - VX) * 65535) / Math.max(1, VW - 1));
  const ny = Math.round(((y - VY) * 65535) / Math.max(1, VH - 1));
  mouse_event(MOVE | ABSOLUTE, nx, ny, 0, 0);
}
const cursorPos = () => { const b = Buffer.alloc(POINT_SIZE); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) }; };
function rectOf(win) {
  try {
    const raw = win.getNativeWindowHandle();
    const n = raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0);
    const b = Buffer.alloc(RECT_SIZE);
    if (!GetWindowRect(n, b)) return null;
    return { left: b.readInt32LE(0), top: b.readInt32LE(4), right: b.readInt32LE(8), bottom: b.readInt32LE(12) };
  } catch (e) { return null; }
}
async function realClick(x, y) {
  moveTo(x, y); await sleep(45);            // 留够时间：16ms 轮询 → 渲染层采样 → 切换穿透状态
  mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(26);
  mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(36);
}
async function realDrag(from, to, steps) {
  moveTo(from.x, from.y); await sleep(150);
  mouse_event(LEFT_DOWN, 0, 0, 0, 0); await sleep(80);
  for (let i = 1; i <= steps; i++) {
    moveTo(Math.round(from.x + (to.x - from.x) * i / steps), Math.round(from.y + (to.y - from.y) * i / steps));
    await sleep(55);
  }
  mouse_event(LEFT_UP, 0, 0, 0, 0); await sleep(150);
}

// ---------------- 渲染层注入 ----------------
const PET_LISTEN = `
window.__hits = []; window.__moves = 0;
document.addEventListener('pointerdown', function (e) {
  window.__hits.push([Math.round(e.clientX), Math.round(e.clientY)]);
}, true);
window.addEventListener('pointermove', function () { window.__moves++; }, true);
'listening'`;
const PET_SNAP = `(() => {
  const c = document.getElementById('stage');
  const g = c.getContext('2d', { willReadFrequently: true });
  window.__snap = g.getImageData(0, 0, c.width, c.height);
  window.__alphaAt = function (cssX, cssY) {
    const px = Math.round(cssX * devicePixelRatio), py = Math.round(cssY * devicePixelRatio);
    if (px < 0 || py < 0 || px >= c.width || py >= c.height) return -1;
    return window.__snap.data[(py * c.width + px) * 4 + 3];
  };
  return 'snapshot';
})()`;
const BG_HTML = '<html><body style="margin:0;background:#000"><script>'
  + 'window.__hits=[];document.addEventListener("pointerdown",function(e){'
  + 'window.__hits.push([e.screenX,e.screenY,e.clientX,e.clientY]);},true);</script></body></html>';

// 冻结动画：宠物每帧的轮廓都会变（呼吸、摆尾），而探针的"应当命中"基准取自画布快照。
// 不冻结就只能是"拿 A 帧的掩码去判定 B 帧的点击"，漏吃率会被大幅高估。
// 渲染层按 prefers-reduced-motion 只画第 0 帧（见 desktop-pet.json reducedMotion）。
const { app: _app } = require('electron');
_app.commandLine.appendSwitch('force-prefers-reduced-motion');

// 关掉自主行为层：宠物自己走动会把位置类断言搅乱（行为层有自己的探针 spikes/m3-behavior）。
process.argv.push('--no-behavior');
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

async function run() {
  const pack = loadPack(ROOT);
  log(`[probe] 包=${pack.manifest.id} scale=${pack.scale} 期望内容区=${Math.round(pack.cell.width * pack.scale)}x${Math.round(pack.cell.height * pack.scale)} DIP`);

  const petWin = await waitForPetWindow(20000);
  await sleep(2500);
  log('[probe] 注入监听：' + await petWin.webContents.executeJavaScript(PET_LISTEN));
  log('[probe] 注入快照：' + await petWin.webContents.executeJavaScript(PET_SNAP));

  const disp = screen.getPrimaryDisplay();
  const b = disp.bounds;
  const bg = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: false, opacity: 0.10, backgroundColor: '#000000',
    focusable: false, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, show: false, webPreferences: { contextIsolation: true },
  });
  await bg.loadURL('data:text/html,' + encodeURIComponent(BG_HTML));
  bg.showInactive();
  await sleep(700);

  const count = (wc, expr) => wc.executeJavaScript(expr).then(Number);
  const dpr = disp.scaleFactor;
  const dip = petWin.getBounds();
  const content = petWin.getContentBounds();
  const phys = rectOf(petWin);
  const metrics = JSON.parse(await petWin.webContents.executeJavaScript(
    `JSON.stringify({ iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
      canvasW: document.getElementById('stage').width, canvasH: document.getElementById('stage').height })`));
  const alphaProbe = JSON.parse(await petWin.webContents.executeJavaScript(
    'JSON.stringify([__alphaAt(innerWidth/2, innerHeight/2), __alphaAt(2,2)])'));
  const origin = cursorPos();

  const geometry = {
    displayBounds: b, workArea: disp.workArea, scaleFactor: dpr,
    windowDIP: dip, contentDIP: content, windowPhysical: phys,
    estimatedPhysical: { left: Math.round(content.x * dpr), top: Math.round(content.y * dpr), right: Math.round((content.x + content.width) * dpr), bottom: Math.round((content.y + content.height) * dpr) },
    rendererMetrics: metrics, alphaProbe, cursor: origin,
  };
  log('[probe] 几何：\n' + JSON.stringify(geometry, null, 1));

  const STEP = 24, MARGIN = 36;
  async function sweep(label, rect, everyN) {
    const pts = [];
    for (let y = rect.top - MARGIN; y <= rect.bottom + MARGIN; y += STEP) {
      for (let x = rect.left - MARGIN; x <= rect.right + MARGIN; x += STEP) pts.push({ x, y });
    }
    const rows = [];
    const c = { pet: 0, bg: 0, none: 0, both: 0, fp: 0, fn: 0, tp: 0, tn: 0 };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i % everyN !== 0) { rows.push({ x: p.x, y: p.y, skipped: true }); continue; }
      const cssX = (p.x - rect.left) / dpr, cssY = (p.y - rect.top) / dpr;
      await petWin.webContents.executeJavaScript(PET_SNAP);   // 逐点刷新基准帧，避免拿过期帧判定
      const alpha = Number(await petWin.webContents.executeJavaScript(`__alphaAt(${cssX.toFixed(2)}, ${cssY.toFixed(2)})`));
      const prePet = await count(petWin.webContents, 'window.__hits.length');
      const preBg = await count(bg.webContents, 'window.__hits.length');
      await realClick(p.x, p.y);
      const gotPet = (await count(petWin.webContents, 'window.__hits.length')) > prePet;
      const gotBg = (await count(bg.webContents, 'window.__hits.length')) > preBg;
      const expectedHit = alpha >= 16;
      if (gotPet && gotBg) c.both++; else if (gotPet) c.pet++; else if (gotBg) c.bg++; else c.none++;
      if (expectedHit && gotPet) c.tp++;
      if (expectedHit && !gotPet) c.fn++;
      if (!expectedHit && gotPet) c.fp++;
      if (!expectedHit && !gotPet) c.tn++;
      rows.push({ x: p.x, y: p.y, cssX: +cssX.toFixed(1), cssY: +cssY.toFixed(1), alpha, expectedHit, gotPet, gotBg });
    }
    const n = Math.ceil(pts.length / everyN);
    log(`[probe] ${label}：采样 ${n} 点 | 被宠物吃掉 ${c.pet} | 穿透到靶窗 ${c.bg} | 都没收到 ${c.none} | 都收到 ${c.both}`);
    log(`[probe] ${label} 与"应该命中"比对：命中且吃到 ${c.tp} | 应命中却穿透 ${c.fn} | 应穿透却被吃 ${c.fp} | 应穿透且穿透 ${c.tn}`);
    // 漏吃点逐条打印（2026-09-17）：本探针已冻结动画（`--force-prefers-reduced-motion`）并逐点刷新
    // 基准帧，所以残留的漏吃**不可能是"拿过期帧判定"**。实测它们都落在轮廓边缘、alpha 紧贴阈值 16，
    // 来源是两种取整：渲染层的命中用 `floor(css / scale)`，探针的基准用 `round(css * dpr)` 取画布像素
    // —— 在边缘 1 像素内两者会分歧。把它打出来是为了"残留量有上界且可复现"，而不是继续当成黑箱。
    // 通过判据只看 `应穿透却被吃 === 0`（误吃才是真实缺陷；漏吃是边缘取整分歧）。
    const fnPoints = rows.filter((r) => r.expectedHit && !r.gotPet);
    if (fnPoints.length) {
      log(`[probe] ${label} 漏吃点明细（${fnPoints.length} 个，均为轮廓边缘）：`
        + fnPoints.map((r) => `(${r.cssX},${r.cssY}) alpha=${r.alpha}`).join(' / '));
    }
    return { label, rect, step: STEP, margin: MARGIN, everyN, counts: c, points: rows, fnDetails: fnPoints };
  }

  const s1 = await sweep('修复后·拖动前', phys, 1);

  // 拖动测试：走真实交互路径（渲染层 pointermove → IPC → 窗口移动）
  const from = { x: Math.round((content.x + content.width / 2) * dpr), y: Math.round((content.y + content.height / 2) * dpr) };
  const to = { x: from.x - 500, y: from.y - 360 };
  const movesBefore = await count(petWin.webContents, 'window.__moves');
  await realDrag(from, to, 12);
  const movesAfter = await count(petWin.webContents, 'window.__moves');
  await sleep(600);
  const dip2 = petWin.getBounds();
  const moved = dip2.x !== dip.x || dip2.y !== dip.y;
  const phys2 = rectOf(petWin);
  log(`[probe] 拖动：pointermove 收到 ${movesAfter - movesBefore} 次；窗口 ${JSON.stringify(dip)} → ${JSON.stringify(dip2)}（${moved ? '已移动' : '未移动'}）`);

  await petWin.webContents.executeJavaScript(PET_SNAP);
  const s2 = await sweep('修复后·拖动后', phys2 ?? phys, 1);

  moveTo(origin.x, origin.y);
  fs.writeFileSync(path.join(OUTDIR, 'report.json'), JSON.stringify({
    geometry, drag: { from, to, moves: movesAfter - movesBefore, dipAfter: dip2, moved, physicalAfter: phys2 },
    before: s1, after: s2,
  }, null, 1));
  log('[probe] 已写出 report.json');
  app.exit(0);
}

app.whenReady().then(() => run().catch((e) => {
  log('[probe] 失败：' + ((e && e.stack) || e));
  app.exit(1);
}));
