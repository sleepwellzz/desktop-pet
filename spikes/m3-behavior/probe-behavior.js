'use strict';
/**
 * 探针：行为层在真实窗口上到底有没有按规则动（M3 第一块）。
 *
 * 纯函数那一半在 `tools/status-arbiter.test.mjs` 的 ⑭ 段（虚拟时钟 + 固定随机种子）。
 * 这里只验**只有真实窗口能回答**的事：
 *   1. 宠物真的在走，而且**只沿地平线走**（y 从不变化）；
 *   2. 全程不越出工作区（edgePolicy 的落地）；
 *   3. 走的时候画的是**位移那一行**，而且**行号与移动方向一致**（right→第 1 行 / left→第 2 行）；
 *   4. **用户抓住它时一步都不动**（松手后接着走）—— 这条是"抢方向盘"的唯一防线；
 *   5. **控制条开着时不动**（面板锚在宠物身上，动了会一起飘）；
 *   6. **有任务在跑时不漫游、只在小范围里踱步**（写一条 running 会话 → 交回业务动画、
 *      然后在锚点 ± `busyPace.distancePx` 的范围内小步走动；见 ADR 019）；
 *   7. **空闲够久会打盹**（画 sleepState 那一行），**被单击就醒**。
 *
 * 为什么用**临时宠物包**：真实参数是"每 25–90 秒走一次、5 分钟后打盹"，照原样验一轮要十分钟，
 * 而且中途任何一步失败都看不出是哪条规则的问题。探针复制一份 sidecar、只改行为参数
 * （2–3 秒走一次 / 20 秒打盹），**不改任何代码路径** —— 测的仍然是产品代码本身。
 *
 * ⚠️ 两条踩过的坑（第一版就是这么假红的）：
 *   - **注入点击不能打窗口中心**：趴卧姿态（打盹用的第 5 行）的精灵贴在图集底部，
 *     窗口中心的像素是透明的 ⇒ 窗口此时是整窗穿透的，pointerdown 根本不会到渲染层。
 *     所以这里先用 `dbg.petInteractive()` 扫出一个**真的落在精灵上**的点（`findSolid`）；
 *   - **打盹阈值不能太短**：第一版设成 5 秒，观测窗口还没开始它就已经睡着了，
 *     于是"没在走""拖动没生效"全是同一个原因（睡着）。现在 20 秒 + 每个阶段前先唤醒。
 *
 * 用法：node spikes/m3-behavior/run.mjs
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'behavior.log');
const REPORT = path.join(__dirname, 'behavior.json');
const STATUS_FILE = path.join(__dirname, 'probe-status.json');
const EVENT_LOG = path.join(__dirname, 'probe-events.jsonl');

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
const mouse_event = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uint64_t extra)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const MOVE = 0x0001, ABSOLUTE = 0x8000;
const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004;
const VX = GetSystemMetrics(76), VY = GetSystemMetrics(77), VW = GetSystemMetrics(78), VH = GetSystemMetrics(79);
const moveTo = (x, y) => mouse_event(MOVE | ABSOLUTE,
  Math.round(((x - VX) * 65535) / Math.max(1, VW - 1)),
  Math.round(((y - VY) * 65535) / Math.max(1, VH - 1)), 0, 0);

/** 临时宠物包：把 sidecar 里的行为节奏压到秒级。其余字段原样带过来。 */
function makeFastPack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-behavior-'));
  const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-pet.json'), 'utf8'));
  sidecar.behavior = {
    ...sidecar.behavior,
    enabled: true,
    idleRoam: { enabled: true, everySec: [2, 3], distancePx: [90, 200], speedPxPerSec: 220 },
    idleMicroActions: { enabled: true, candidates: ['waving', 'jumping'], everySec: [4, 7] },
    // 任务中踱步也压到秒级：真参数是"每 60–180 秒走 60–300px"，照原样验一轮要几分钟
    busyPace: { enabled: true, everySec: [3, 5], distancePx: [60, 160], speedPxPerSec: 220 },
    sleepAfterIdleSec: 20,
  };
  fs.writeFileSync(path.join(dir, 'desktop-pet.json'), JSON.stringify(sidecar, null, 2), 'utf8');
  for (const f of ['pet.json', 'behavior-map.json', 'spritesheet.webp']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}

const PACK_DIR = makeFastPack();
try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* ignore */ }
try { fs.rmSync(EVENT_LOG, { force: true }); } catch (_) { /* ignore */ }
process.argv.push('--expose-actions');
process.argv.push(`--pet=${PACK_DIR}`);
process.argv.push(`--status-file=${STATUS_FILE}`);
process.argv.push(`--event-log=${EVENT_LOG}`);
require(path.join(DIST, 'main', 'index.js'));

/** 在渲染层给 drawImage 打补丁，回读"当前正在画的帧行号"（sy / 208）。 */
const INJECT = `
(() => {
  window.__last = '';
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.drawImage;
  proto.drawImage = function (img, sx, sy, sw, sh) {
    if (typeof sy === 'number' && sh === 208) window.__last = Date.now() + ',' + (sy / 208);
    return orig.apply(this, arguments);
  };
  return 'ok';
})()`;

function writeStatus(sessions) {
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'desktop-pet/status/v1', sessions }, null, 2), 'utf8');
  fs.renameSync(tmp, STATUS_FILE);
}

app.whenReady().then(async () => {
  const report = { packDir: PACK_DIR, samples: [], steps: {} };
  const dpr = screen.getPrimaryDisplay().scaleFactor;
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
    await sleep(2500);
    const dbg = globalThis.__petDebug;
    if (!dbg) throw new Error('拿不到 __petDebug');
    await pet.webContents.executeJavaScript(INJECT);
    log(`[probe] 行为层参数：${JSON.stringify({
      roam: dbg.behaviorPolicy().roamEveryMs, speed: dbg.behaviorPolicy().speedPxPerSec,
      pace: dbg.behaviorPolicy().paceEveryMs, paceDist: dbg.behaviorPolicy().paceDistancePx,
      sleep: dbg.behaviorPolicy().sleepAfterMs, loco: dbg.behaviorPolicy().locomotion,
    })}`);

    const bounds = () => dbg.petBounds();
    const row = async () => {
      const raw = await pet.webContents.executeJavaScript('window.__last').catch(() => '');
      return raw ? Number(String(raw).split(',')[1]) : null;
    };
    const sample = async (ms) => {
      const out = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const b = bounds();
        out.push({
          t: Date.now() - t0, x: b.x, y: b.y, w: b.width, h: b.height,
          row: await row(), phase: dbg.behaviorState().phase, moves: dbg.behaviorMoves(),
          anchor: dbg.behaviorState().anchorX,
        });
        await sleep(150);
      }
      report.samples.push(...out);
      return out;
    };
    const xChanged = (s) => s.some((p, i) => i > 0 && p.x !== s[i - 1].x);

    /**
     * 找一个**真的落在精灵像素上**的点（窗口坐标 → 屏幕物理像素）。
     *
     * 为什么不能直接用窗口中心：命中判定是渲染层按当前帧 alpha 给出的（ADR 008），
     * 而趴卧（第 5 行）这类姿态的精灵贴在单元格底部，窗口中心是透明的 ——
     * 那时窗口处于整窗穿透状态，注入的按下根本到不了渲染层（第一版就这么假红了两条）。
     * 这里扫一小片网格，用渲染层自己上报的命中状态当判据 —— 不猜、不问第二遍。
     */
    const findSolid = async () => {
      const b = bounds();
      const xs = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];
      const ys = [0.75, 0.85, 0.92, 0.65, 0.55];
      for (const fy of ys) {
        for (const fx of xs) {
          const px = Math.round((b.x + b.width * fx) * dpr);
          const py = Math.round((b.y + b.height * fy) * dpr);
          moveTo(px, py);
          await sleep(90);
          if (dbg.petInteractive()) return { px, py, fx, fy };
        }
      }
      return null;
    };

    /** 把宠物叫醒（单击精灵即"用户碰了它"）。返回是否成功。 */
    const ensureAwake = async (why) => {
      if (dbg.behaviorState().phase !== 'sleeping') return true;
      log(`[probe] ${why}：宠物正在打盹，先单击唤醒`);
      const p = await findSolid();
      if (!p) return false;
      mouse_event(LEFT_DOWN, 0, 0, 0, 0);
      await sleep(60);
      mouse_event(LEFT_UP, 0, 0, 0, 0);
      await sleep(900);
      return dbg.behaviorState().phase !== 'sleeping';
    };

    // —— ① 观察 12 秒：在动、只沿地平线动、不出工作区、行号与方向一致 ——
    await ensureAwake('①');
    const s1 = await sample(12000);
    const area = screen.getDisplayNearestPoint({ x: s1[0].x, y: s1[0].y }).workArea;
    report.steps.walk = {
      moves: dbg.behaviorMoves(), xChanged: xChanged(s1),
      yValues: [...new Set(s1.map((p) => p.y))], rows: [...new Set(s1.map((p) => p.row))],
      outOfArea: s1.filter((p) => p.x < area.x || p.x + p.w > area.x + area.width).length,
      area,
    };
    log(`[probe] ① 观察 12 秒：位置变化=${report.steps.walk.xChanged}｜位移次数=${dbg.behaviorMoves()}`
      + `｜出现过的 y=${JSON.stringify(report.steps.walk.yValues)}（应只有一个）`
      + `｜出现过的行号=${JSON.stringify(report.steps.walk.rows)}（1=右 2=左 0=待机 3=挥手 4=跳跃 5=趴卧）`
      + `｜越界采样=${report.steps.walk.outOfArea}`);

    let rightOk = 0, leftOk = 0, mismatch = [];
    for (let i = 1; i < s1.length; i += 1) {
      const a = s1[i - 1], b = s1[i];
      const dx = b.x - a.x;
      if (dx === 0 || !a.row || !b.row) continue;
      if (![1, 2].includes(a.row) || ![1, 2].includes(b.row)) continue;
      if (dx > 0 && b.row === 1) rightOk += 1;
      else if (dx < 0 && b.row === 2) leftOk += 1;
      else mismatch.push({ dx, row: b.row });
    }
    report.steps.direction = { rightOk, leftOk, mismatch: mismatch.slice(0, 5), mismatchCount: mismatch.length };
    log(`[probe] ①b 行号与方向一致：向右 ${rightOk} 次 / 向左 ${leftOk} 次 / 不一致 ${mismatch.length} 次`
      + (mismatch.length ? ` ${JSON.stringify(mismatch.slice(0, 3))}` : ''));

    // —— ② 用户抓住它时一步都不许动，松手后接着走 ——
    await ensureAwake('②');
    const beforeDrag = dbg.behaviorMoves();
    const solid = await findSolid();
    report.steps.drag = { solidAt: solid };
    if (!solid) throw new Error('扫不到宠物实体像素（拿不到可抓的位置）');
    mouse_event(LEFT_DOWN, 0, 0, 0, 0);
    await sleep(300);
    const hold = await sample(3000);
    const draggingFlag = dbg.draggingPet();
    const suppressed = dbg.behaviorSuppressed();
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    await sleep(400);
    const afterRelease = await sample(5000);
    Object.assign(report.steps.drag, {
      draggingFlag, suppressed, xChangedWhileHolding: xChanged(hold),
      movesBefore: beforeDrag, movesAfter: dbg.behaviorMoves(),
      movedAfterRelease: xChanged(afterRelease),
    });
    log(`[probe] ② 抓住不放 3 秒（抓在 ${solid.fx},${solid.fy} 上）：dragging=${draggingFlag} suppressed=${suppressed}`
      + `｜期间位置变化=${report.steps.drag.xChangedWhileHolding}（期望 false）`
      + `｜松手后 5 秒位置变化=${report.steps.drag.movedAfterRelease}（期望 true）`
      + `｜位移次数 ${beforeDrag} → ${dbg.behaviorMoves()}`);

    // —— ③ 控制条开着时不动 ——
    await ensureAwake('③');
    dbg.barToggle();
    await sleep(900);
    const barVisible = dbg.barVisible();
    const withBar = await sample(3500);
    dbg.barToggle();
    await sleep(900);
    const afterBar = await sample(5000);
    report.steps.bar = {
      barVisible, xChangedWithBar: xChanged(withBar), movedAfterBarClose: xChanged(afterBar),
    };
    log(`[probe] ③ 控制条：可见=${barVisible}｜开着时位置变化=${report.steps.bar.xChangedWithBar}（期望 false）`
      + `｜关掉后位置变化=${report.steps.bar.movedAfterBarClose}（期望 true）`);

    // —— ④ 有任务在跑时改走"踱步"：在动，但只在小范围里动（ADR 019）——
    // 旧判据是"running 期间一步都不动"。2026-09-18 用户改了要求：**可以离开原位，但不能超过
    // 几百像素**，频率要低、只作为点缀。所以这里量三件事：**在动**、**没走远**、**不越界**；
    // "频率低"与"不会越踱越远"由单测（虚拟时钟）精确量，这里只验真实窗口上的位移范围。
    const paceCfg = dbg.behaviorPolicy().paceDistancePx;
    writeStatus({ default: { status: 'running', title: 'probe', ts: Date.now() } });
    await sleep(1500);
    const busy = await sample(16000);
    const busyState = dbg.behaviorState();
    const areaBusy = screen.getDisplayNearestPoint({ x: busy[0].x, y: busy[0].y }).workArea;
    const anchors = [...new Set(busy.map((p) => p.anchor).filter((v) => typeof v === 'number'))];
    const anchor = busyState.anchorX ?? (anchors[0] ?? null);
    const maxDrift = anchor === null ? null : Math.max(...busy.map((p) => Math.abs(p.x - anchor)));
    report.steps.busy = {
      paced: xChanged(busy),
      anchorX: anchor,
      anchorsSeen: anchors,
      anchorChanged: anchors.length > 1,
      maxDriftPx: maxDrift,
      limitPx: paceCfg.max,
      phase: busyState.phase,
      poseRows: [...new Set(busy.map((p) => p.row))],
      outOfArea: busy.filter((p) => p.x < areaBusy.x || p.x + p.w > areaBusy.x + areaBusy.width).length,
      movedAfterClear: null,
    };
    log(`[probe] ④ running 期间踱步：在动=${report.steps.busy.paced}`
      + `｜锚点=${anchor}（观测期内出现过 ${anchors.length} 个不同锚点，期望 1）`
      + `｜离锚点最远 ${maxDrift}px（上限 ${paceCfg.max}px）`
      + `｜相=${report.steps.busy.phase}（期望 idle 或 pacing，不该是 roaming/sleeping）`
      + `｜画面行号=${JSON.stringify(report.steps.busy.poseRows)}（1=右 2=左 7=running）`
      + `｜越界采样=${report.steps.busy.outOfArea}`);
    globalThis.__petActions.clearSessions();
    await sleep(1500);
    const afterClear = await sample(6000);
    report.steps.busy.movedAfterClear = xChanged(afterClear);
    log(`[probe] ④b 清空会话后恢复自由漫游=${report.steps.busy.movedAfterClear}（期望 true）`);

    // —— ⑤ 空闲够久会打盹（画 sleepState 那一行），单击就醒 ——
    // 先单击一次把打盹计时归零，然后**有界地**等（临时包 sleepAfterIdleSec = 20）。
    await ensureAwake('⑤-前置');
    const solid5 = await findSolid();
    if (!solid5) throw new Error('扫不到宠物实体像素（无法把计时归零）');
    mouse_event(LEFT_DOWN, 0, 0, 0, 0);
    await sleep(60);
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    const tNap = Date.now();
    nap: while (Date.now() - tNap < 30000) {
      const r = await row();
      const st = dbg.behaviorState();
      const b = bounds();
      report.steps.nap = report.steps.nap ?? { rowsSeen: [] };
      report.steps.nap.rowsSeen.push({ t: Date.now() - tNap, row: r, phase: st.phase, x: b.x });
      if (!report.steps.nap.rowsSeen.some((p) => p.row === 5)) { /* 记录首次入睡 */ }
      if (st.phase === 'sleeping' && r === 5) break nap;
      await sleep(200);
    }
    const rows = report.steps.nap ?? { rowsSeen: [] };
    const napInfo = {
      sleepingPhase: dbg.behaviorState().phase,
      sleptRow: rows.rowsSeen.some((p) => p.row === 5),
      napWaitMs: Date.now() - tNap,
      rowsSeen: [...new Set(rows.rowsSeen.map((p) => p.row))],
    };
    // 单击唤醒（真的点在精灵上）
    const solidWake = await findSolid();
    if (!solidWake) throw new Error('扫不到宠物实体像素（无法单击唤醒）');
    mouse_event(LEFT_DOWN, 0, 0, 0, 0);
    await sleep(60);
    mouse_event(LEFT_UP, 0, 0, 0, 0);
    await sleep(1500);
    report.steps.nap = { ...napInfo, wokePhase: dbg.behaviorState().phase, wokeRow: await row(), solidWake };
    log(`[probe] ⑤ 打盹：等到相=${napInfo.sleepingPhase}（期望 sleeping）画到第 5 行=${napInfo.sleptRow}`
      + `｜用时 ${napInfo.napWaitMs}ms｜期间行号=${JSON.stringify(napInfo.rowsSeen)}`
      + `｜单击后 相=${report.steps.nap.wokePhase} 行号=${report.steps.nap.wokeRow}（期望醒来、离开 5）`);

    report.behaviorTicks = dbg.behaviorTicks();
    report.behaviorMoves = dbg.behaviorMoves();

    // —— 判定 ——
    const s = report.steps;
    const fails = [];
    if (!s.walk.xChanged) fails.push('12 秒内宠物一步都没走（漫游没生效）');
    if (s.walk.yValues.length !== 1) fails.push(`纵向被改动了（y 出现过 ${JSON.stringify(s.walk.yValues)}）`);
    if (s.walk.outOfArea > 0) fails.push(`走到工作区外 ${s.walk.outOfArea} 次采样`);
    if (s.direction.mismatchCount > 0) fails.push(`位移行号与移动方向不一致 ${s.direction.mismatchCount} 次`);
    if (s.direction.rightOk + s.direction.leftOk === 0) fails.push('没抓到任何"在走且画着位移行"的采样（判据无效）');
    if (!s.drag.draggingFlag) fails.push('按下后 draggingPet 没置真（渲染层没上报拖动边沿）');
    if (!s.drag.suppressed) fails.push('抓住时行为层没有进入抑制态');
    if (s.drag.xChangedWhileHolding) fails.push('用户抓着不放时宠物仍在自己动（与用户抢方向盘）');
    if (!s.drag.movedAfterRelease) fails.push('松手后没有恢复自主行为');
    if (!s.bar.barVisible) fails.push('控制条没有打开（用例前置不成立）');
    if (s.bar.xChangedWithBar) fails.push('控制条开着时宠物仍在漫游（面板会跟着飘）');
    if (!s.bar.movedAfterBarClose) fails.push('关掉控制条后没有恢复漫游');
    if (!s.busy.paced) fails.push('有会话在 running 时宠物一步都没动（踱步没生效）');
    if (s.busy.anchorChanged) fails.push(`running 期间锚点被改掉了（见到 ${s.busy.anchorsSeen.length} 个锚点）`);
    if (s.busy.maxDriftPx === null) fails.push('拿不到锚点，`踱步没走远`这条判据无法成立');
    else if (s.busy.maxDriftPx > s.busy.limitPx + 30) {
      fails.push(`running 期间离锚点最远 ${s.busy.maxDriftPx}px，超过上限 ${s.busy.limitPx}px（+30 容差）`);
    }
    if (s.busy.outOfArea > 0) fails.push(`running 期间走到工作区外 ${s.busy.outOfArea} 次采样`);
    if (!['idle', 'pacing'].includes(s.busy.phase)) {
      fails.push(`running 期间行为层相是 ${s.busy.phase}，期望 idle 或 pacing`);
    }
    if (!s.busy.movedAfterClear) fails.push('清空会话后没有恢复漫游');
    if (s.nap.sleepingPhase !== 'sleeping') fails.push('空闲够久没有进入打盹相');
    if (!s.nap.sleptRow) fails.push('打盹时没有画 sleepState（第 5 行）');
    if (s.nap.wokePhase === 'sleeping') fails.push('单击后没有醒来');
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
  await sleep(2000);
  try { fs.rmSync(PACK_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  app.exit(0);
});
