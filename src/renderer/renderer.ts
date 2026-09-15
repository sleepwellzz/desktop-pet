// 渲染层：加载精灵图、按内核播放器播帧、处理拖动与点击。
//
// 两条硬约束：
//   1. 想让点击穿透的区域，alpha 必须严格为 0 —— 所以每帧先 clearRect，绝不画背景。
//   2. 内核不 import electron，所以播帧循环放在这里，避免每帧走 IPC。
import { PetPlayer } from '../kernel/player';
import type { ResolvedState } from '../kernel/types';
import type { RendererInit } from '../shared/ipc';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: true })!;

let sheet: HTMLCanvasElement | null = null;
/** 阈值清理后的整张精灵图像素（RGBA）。命中测试直接查它，不做任何回读。 */
let sheetData: Uint8ClampedArray | null = null;
let sheetW = 0;
let sheetH = 0;
let hitThreshold = 16;
let player: PetPlayer | null = null;
let init: RendererInit | null = null;
let lastTs = 0;

/**
 * 落实 desktop-pet.json 的 `render.hitTest = "alpha-threshold"` + `hitTestAlphaThreshold`。
 *
 * 为什么必须在渲染层做：**Windows 对分层窗口的逐像素命中测试在这个组合下并不生效**。
 * 2026-09-15 用真实鼠标点击逐点实测（spikes/m2-hittest，169 个采样点）：
 * 窗口矩形内的 90 个点**全部**被宠物吃掉，包括精灵轮廓外 46 DIP 的纯透明带；
 * 而"应该命中"的判定与精灵 alpha 完全无关 —— 生效命中区域 = 整个窗口矩形。
 *
 * 所以命中区域改由我们自己定义：主进程常态整窗穿透，渲染层按当前帧精灵 alpha
 * 判定光标是否落在实体上，命中才切回可交互（见下方 evaluateHit 与 CH.interactive）。
 * 这里把低于阈值的像素连同 RGB 一起清零，一是让画面干净（WebP 有损压缩会在轮廓外
 * 留下 alpha 1~15 的散点噪声，实测全图 7907 个），二是让这份像素同时充当命中掩码。
 */
function applyAlphaThreshold(
  img: HTMLImageElement,
  threshold: number,
): { canvas: HTMLCanvasElement; image: ImageData; cleared: number } {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext('2d', { alpha: true, willReadFrequently: true })!;
  cx.drawImage(img, 0, 0);

  const image = cx.getImageData(0, 0, c.width, c.height);
  const px = image.data;
  let cleared = 0;
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i] ?? 0;
    if (a < threshold) {
      px[i - 3] = 0; px[i - 2] = 0; px[i - 1] = 0; px[i] = 0;
      cleared += 1;
    }
  }
  cx.putImageData(image, 0, 0);
  return { canvas: c, image, cleared };
}

// 系统「减少动态效果」：只画第 0 帧（desktop-pet.json reducedMotion 策略）
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

window.pet.onInit((payload) => {
  if (init) return;            // init 只处理一次
  init = payload;
  const cssW = Math.round(payload.cell.width * payload.scale);
  const cssH = Math.round(payload.cell.height * payload.scale);
  const dpr = window.devicePixelRatio || 1;
  hitThreshold = payload.hitTestAlphaThreshold ?? 16;

  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const states = payload.states as Record<string, ResolvedState>;
  player = new PetPlayer({ states }, payload.initialState);

  const img = new Image();
  img.onload = () => {
    const applied = applyAlphaThreshold(img, hitThreshold);
    sheet = applied.canvas;
    sheetData = applied.image.data;
    sheetW = applied.image.width;
    sheetH = applied.image.height;
    window.pet.log(
      `精灵图就绪 ${img.naturalWidth}x${img.naturalHeight}，DPR=${dpr}；` +
      `按 alpha<${hitThreshold} 清空 ${applied.cleared} 个空白像素`,
    );
    requestAnimationFrame(tick);
  };
  img.onerror = () => window.pet.log('精灵图加载失败');
  img.src = payload.sheetDataUrl;

  for (const w of payload.warnings) window.pet.log('警告：' + w);
});

function tick(ts: number): void {
  const dt = lastTs ? ts - lastTs : 0;
  lastTs = ts;
  if (player && !reducedMotion) player.update(dt);
  draw();
  requestAnimationFrame(tick);
}

function draw(): void {
  if (!init || !player) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!sheet) return;

  const f = player.frame();
  const { width: cw, height: ch } = init.cell;
  const s = init.scale;
  // offsetY 是单元格坐标下的纵向补偿，用于把各状态触地点对齐 groundY
  ctx.drawImage(
    sheet,
    f.column * cw, f.row * ch, cw, ch,
    0, f.offsetY * s, cw * s, ch * s
  );
}

// —— 命中测试：把"哪些像素算实体"交给我们自己判定 ——
// 主进程常态整窗穿透（setIgnoreMouseEvents(true, { forward: true })），鼠标移动仍会转发到这里；
// 光标落在实体像素上才切回可交互，离开立刻释放。见 ADR 008。
let interactive = false;
/**
 * @param force 无条件上报。窗口重新显示后必须强制一次：隐藏/显示会让主进程侧的记账
 *   与渲染层错开，若因为"与上次相同"而被跳过，窗口就可能永远停在穿透状态
 *   （实测症状：全屏让位回来后宠物点不动、拖不动，见 ADR 009）。
 */
function setInteractive(on: boolean, force = false): void {
  if (!force && on === interactive) return;
  interactive = on;
  window.pet.setInteractive(on);
}

/**
 * 精灵图上给定坐标是否算"实体"。
 *
 * 刻意**只查单点、不做邻域膨胀**。曾经为了对齐"浏览器双线性插值后看得见的那一圈"
 * 而取 3x3 邻域，实测结果是：误吃（应穿透却被吃）从 0 涨到 4，而漏吃（应命中却穿透）
 * 一点没降 —— 说明漏吃并非边缘 1px 造成（真实原因是动画帧在采样期间变化，
 * 探针基准帧过期，见 ADR 008）。单点判定是这几组实测里唯一做到"误吃 = 0"的配置。
 */
function solidAt(sx: number, sy: number): boolean {
  if (!sheetData) return false;
  if (sx < 0 || sy < 0 || sx >= sheetW || sy >= sheetH) return false;
  return (sheetData[(sy * sheetW + sx) * 4 + 3] ?? 0) >= hitThreshold;
}

/** 当前帧在窗口客户区坐标 cssX/cssY 处是否命中实体。 */
function hitAt(cssX: number, cssY: number): boolean {
  if (!init || !player || !sheetData) return false;
  const f = player.frame();
  const s = init.scale;
  const { width: cw, height: ch } = init.cell;
  const localX = Math.floor(cssX / s);
  const localY = Math.floor(cssY / s - f.offsetY);
  return solidAt(f.column * cw + localX, f.row * ch + localY);
}

function evaluateHit(cssX: number, cssY: number, force = false): void {
  setInteractive(hitAt(cssX, cssY), force);
}

// —— 交互：按住拖动；单击（未拖动）触发一次性挥手 ——
let dragging = false;
let moved = 0;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  moved = 0;
  lastX = e.screenX;
  lastY = e.screenY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  window.pet.dragBy({ dx, dy });
});

canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  const wasClick = moved < 4;
  if (wasClick && player) {
    // 一次性动作：播完由播放器自动回落到 idle
    if (!player.setState('waving')) player.setState('idle');
  }
  evaluateHit(e.clientX, e.clientY);   // 拖完可能已不在实体像素上，立刻复评
});

// 光标在窗口内移动时复评。注意：常态整窗穿透时 Windows **不会**把鼠标移动转发
// 到渲染层（实测 0 次），所以真正的驱动源是主进程 ~60Hz 的光标轮询（onPointerHint）。
// 这个监听器只在窗口已经可交互（光标就在宠物身上）时生效，属于锦上添花。
window.addEventListener('pointermove', (e) => {
  if (dragging) return;
  evaluateHit(e.clientX, e.clientY);
}, true);

// 兜底释放。转发不可用时这两个事件不会到达，释放由 16ms 轮询的采样负责。
const releaseIfIdle = (): void => { if (!dragging) setInteractive(false); };
window.addEventListener('mouseleave', releaseIfIdle);
window.addEventListener('pointerleave', releaseIfIdle);
window.addEventListener('blur', releaseIfIdle);

// 主进程按光标位置回报采样点，窗口被拖动或重新显示后也靠它重新定位。
// force 来自"窗口刚重新显示"，必须无条件重报一次（见 setInteractive 注释）。
window.pet.onPointerHint((hint) => {
  if (dragging) return;
  evaluateHit(hint.cssX, hint.cssY, Boolean(hint.force));
});

/**
 * 指针被系统取消（例如拖动过程中宠物被全屏让位隐藏）。
 * 不处理的话 dragging 会永久卡在 true，之后所有 hint 都被 `if (!dragging)` 挡掉，
 * 窗口再也切不回可交互 —— 这是同一类症状的第二条路径，一并堵掉。
 */
function onPointerCancel(): void {
  if (!dragging) return;
  dragging = false;
  setInteractive(false);
}
canvas.addEventListener('pointercancel', onPointerCancel);
window.addEventListener('pointercancel', onPointerCancel);

window.pet.onFullscreen((n) => window.pet.log(n.hidden ? `让位隐藏（前台：${n.fgTitle}）` : '恢复显示'));

// 报到：告诉主进程可以下发 init 载荷了
window.pet.ready();
