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

let sheet: HTMLImageElement | null = null;
let player: PetPlayer | null = null;
let init: RendererInit | null = null;
let lastTs = 0;

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
    sheet = img;
    window.pet.log(`精灵图就绪 ${img.naturalWidth}x${img.naturalHeight}，DPR=${dpr}`);
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
