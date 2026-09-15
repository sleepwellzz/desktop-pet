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
let player: PetPlayer | null = null;
let init: RendererInit | null = null;
let lastTs = 0;

/**
 * 落实 desktop-pet.json 的 `render.hitTest = "alpha-threshold"` + `hitTestAlphaThreshold`。
 *
 * 为什么必须在渲染层做：点击是否穿透由 Windows 的分层窗口命中测试决定，它只看
 * **alpha > 0**。而精灵图经 WebP 有损压缩后，宠物轮廓外的空白区会残留 alpha 1~15
 * 的散点噪声（实测全图 7907 个），人眼完全看不见，却会被判成"实体"——
 * 表现就是"点在宠物旁边的空白处，有时也会触发挥手"（散点，所以是"有时"）。
 *
 * 这里把低于阈值的像素连同 RGB 一起清零，让系统判定退化成"与人眼所见一致"，
 * 不必引入 setIgnoreMouseEvents 之类的运行时开关（那会带来延迟与闪烁）。
 */
function applyAlphaThreshold(
  img: HTMLImageElement,
  threshold: number,
): { canvas: HTMLCanvasElement; cleared: number } {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext('2d', { alpha: true })!;
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
  return { canvas: c, cleared };
}

// 系统「减少动态效果」：只画第 0 帧（desktop-pet.json reducedMotion 策略）
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

window.pet.onInit((payload) => {
  if (init) return;            // init 只处理一次
  init = payload;
  const cssW = Math.round(payload.cell.width * payload.scale);
  const cssH = Math.round(payload.cell.height * payload.scale);
  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const states = payload.states as Record<string, ResolvedState>;
  player = new PetPlayer({ states }, payload.initialState);

  const img = new Image();
  img.onload = () => {
    const threshold = payload.hitTestAlphaThreshold ?? 1;
    const applied = applyAlphaThreshold(img, threshold);
    sheet = applied.canvas;
    window.pet.log(
      `精灵图就绪 ${img.naturalWidth}x${img.naturalHeight}，DPR=${dpr}；` +
      `按 alpha<${threshold} 清空 ${applied.cleared} 个空白像素`,
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
});

window.pet.onFullscreen((n) => window.pet.log(n.hidden ? `让位隐藏（前台：${n.fgTitle}）` : '恢复显示'));

// 报到：告诉主进程可以下发 init 载荷了
window.pet.ready();
