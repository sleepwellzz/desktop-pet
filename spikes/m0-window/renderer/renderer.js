// 渲染层：画 idle 行动画，并把 alpha 掩码回传主进程供命中测试采样。
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d', { alpha: true });
const hud = document.getElementById('hud');

const W = cv.width, H = cv.height;
const CELL = { w: 192, h: 208 };
const OFF = { x: (W - CELL.w) / 2, y: (H - CELL.h) / 2 };

let sheet = null;
let info = null;
let hudData = null;
let frame = 0;
let lastMaskSent = 0;

// idle 行（第 0 行）6 帧 @8fps
const ROW = 0, FRAMES = 6, FPS = 8;

function drawFallback() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255, 193, 122, .95)';
  ctx.beginPath();
  ctx.arc(W / 2, H / 2 + Math.sin(Date.now() / 400) * 4, 70, 0, Math.PI * 2);
  ctx.fill();
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  if (!sheet) { drawFallback(); return; }
  ctx.drawImage(sheet, frame * CELL.w, ROW * CELL.h, CELL.w, CELL.h, OFF.x, OFF.y, CELL.w, CELL.h);
}

function sendMask() {
  const img = ctx.getImageData(0, 0, W, H).data;
  const alpha = new Uint8Array(W * H);
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = img[p];
  window.pet.sendMask(W, H, alpha);
}

function loop() {
  draw();
  const now = Date.now();
  if (now - lastMaskSent > 100) { sendMask(); lastMaskSent = now; }
  frame = (frame + 1) % FRAMES;
  renderHud();
  setTimeout(() => requestAnimationFrame(loop), 1000 / FPS);
}

function renderHud() {
  if (!hudData && !info) return;
  const d = hudData || {};
  const i = info || {};
  const rows = [
    `<b>M0 窗口层自检</b>`,
    `Electron ${i.electron || '-'} / Node ${i.node || '-'}`,
    `HWND ${i.hwnd || '-'}  样式 ${d.exStyle || i.exStyleAfter || '-'}`,
    `NOACTIVATE ${i.noActivate ? '<span class="ok">已生效</span>' : '<span class="bad">未生效</span>'}` +
    `  LAYERED ${i.layered ? '<span class="ok">是</span>' : '<span class="bad">否</span>'}` +
    `  置顶 ${i.topmost ? '<span class="ok">是</span>' : '<span class="bad">否</span>'}`,
    `命中测试 ${i.hitTestInstalled ? '<span class="ok">已安装</span>' : '未安装（native 模式）'}` +
    `  采样 ${d.hitCount ?? 0} 次`,
    `最近采样 ${d.lastHit ? `(${d.lastHit.sx},${d.lastHit.sy}) ${d.lastHit.hit ? '不透明' : '透明'}` : '-'}`,
    ``,
    `<b>全屏让位</b>`,
    `前台窗口 ${d.fgTitle || '-'}`,
    `前台矩形 ${d.fgRect || '-'}`,
    `显示器矩形 ${d.monitorRect || '-'}`,
    `覆盖显示器 ${d.coversMonitor ? '<span class="bad">是（已让位）</span>' : '<span class="ok">否</span>'}`,
    `QUNS ${d.quns || '-'}   已隐藏 ${d.hiddenByFullscreen ? '是' : '否'}`,
    ``,
    `最近点击 ${d.lastClick ? `(${d.lastClick.x},${d.lastClick.y})` : '无'}`,
  ];
  hud.innerHTML = rows.join('\n');
}

window.pet.onInit((v) => {
  info = v.info;
  if (v.sheet) {
    const img = new Image();
    img.onload = () => { sheet = img; };
    img.onerror = () => console.warn('图集加载失败');
    img.src = v.sheet;
  }
});
window.pet.onHud((v) => { hudData = v; });

cv.addEventListener('mousedown', (e) => {
  const r = cv.getBoundingClientRect();
  window.pet.reportClick(Math.round(e.clientX - r.left), Math.round(e.clientY - r.top));
});

requestAnimationFrame(loop);
