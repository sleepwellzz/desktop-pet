// 渲染层：加载精灵图、按内核播放器播帧、处理拖动与点击。
//
// 两条硬约束：
//   1. 想让点击穿透的区域，alpha 必须严格为 0 —— 所以每帧先 clearRect，绝不画背景。
//   2. 内核不 import electron，所以播帧循环放在这里，避免每帧走 IPC。
import { PetPlayer } from '../kernel/player';
import { DEFAULT_MOTION_POLICY, shouldAdvanceFrames, type MotionPolicy } from '../kernel/motion-policy';
import type { ResolvedState } from '../kernel/types';
import type { RendererInit, StatusPush } from '../shared/ipc';

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

/**
 * 系统「减少动态效果」的**开关本身** —— 只有渲染层读得到（matchMedia），
 * 所以要上报给主进程：行为层靠它决定要不要自动漫游（ADR 018）。
 *
 * ⚠️ 它**不再**用来决定"动画播不播"。以前是（`tick()` 里 `!reducedMotion` 直接关掉帧推进），
 * 结果同一份代码在两台机器上两种表现：一台正常，一台所有动作都是静态贴图 ——
 * 因为"减少动画"的本意是**减少它自作主张的运动**，不是让它变成一块石头。
 * 现在动画播不播由**策略**决定（见下），而策略是可配置的。ADR 043。
 */
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * 「减少动态效果」的应对策略，来自 `desktop-pet.json → reducedMotion`（主进程解析后下发）。
 * 默认 `animate`：动画照常。**只画一帧**（`freeze-frame`）是用户主动选的行为，不是默认。
 */
let motionPolicy: MotionPolicy = DEFAULT_MOTION_POLICY;

/** 这一策略下要不要推进帧。判据在策略自己身上，调用点只问它（调用点会新增，策略只有一个）。 */
const frozen = (): boolean => !shouldAdvanceFrames(motionPolicy);

window.pet.onInit((payload) => {
  if (init) return;            // init 只处理一次
  init = payload;
  // 策略来自主进程（它读 sidecar）；缺省就按默认走，渲染层不自己发明一套。
  motionPolicy = payload.motionPolicy ?? DEFAULT_MOTION_POLICY;
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
  if (player && !frozen()) player.update(dt);
  draw();
  reconcileStatus();
  // 每帧用"最近一次已知的光标位置"复评命中。
  //
  // 命中判据是**当前帧的精灵 alpha**（ADR 008），而光标停着不动时动画仍在换帧 ——
  // 只靠"光标移动"驱动评估会出现这个盲区：用户点了一下宠物（切到挥手姿态）后不移动鼠标
  // 直接拖动，此时光标下的像素已换成空白 → 窗口被切成整窗穿透 → 按下直接穿透过去，
  // 表现为"点得动、紧接着拖不动"。2026-09-16 由 spikes/m2-menu/probe-tray.js 实测抓到。
  // 代价只有每帧一次 alpha 查表，且 setInteractive 只在真正变化时发 IPC。
  if (!dragging && lastCss) evaluateHit(lastCss.x, lastCss.y);
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

// —— 状态：主进程是唯一真值来源，渲染层只负责把"该演什么"画出来 ——
// 施工纪律落成一条规则：**仲裁器说演什么就演什么，渲染层唯一有权拒绝的情况是
// "当前正在播一次性动作"** —— 挥手挥到一半被切断是最廉价的观感。
let lastStatus: StatusPush | null = null;
let lastStatusRev = -1;

/** 静止落点：一次性动作播完之后应该停在哪个状态。 */
function restingState(p: StatusPush): string {
  return p.animation.then ?? p.animation.state;
}

window.pet.onStatus((p) => {
  const isNew = p.rev !== lastStatusRev;
  lastStatus = p;
  lastStatusRev = p.rev;
  const anim = p.animation.then ? `${p.animation.state} → ${p.animation.then}` : p.animation.state;
  window.pet.log(
    `状态 ${p.status} → ${anim} rev=${p.rev}` +
    (p.bubble ? ` ｜ 气泡「${p.bubble}」` : '') +
    (p.badgeCount > 0 ? ` ｜ 另有 ${p.badgeCount} 条活动会话` : '') +
    (p.replay ? '（重载补推）' : ''),
  );

  if (!player) return;                    // init 还没到；tick 里的 reconcile 会补上
  if (frozen()) {
    // 帧推进被关闭时，一次性状态会卡在首帧回不去，所以直接落到静止落点。
    // 只有策略是 `freeze-frame` 才会走到这里（默认 `animate` 不走）。
    player.setState(restingState(p), { then: p.animation.then });
    return;
  }
  if (player.isOneShot && player.stateId !== p.animation.state) return;   // 单次动作不打断
  // 新迁移播 animation.state（可能是一次性动作）；重载补推只落静止落点，
  // 否则每次全屏让位恢复（会 reload 渲染层）都要重播一次挥手。
  player.setState(isNew && !p.replay ? p.animation.state : restingState(p), { then: p.animation.then });
});

/**
 * 把播放器收敛回仲裁器的当前状态。覆盖两条路径：
 *   ① 本地一次性动作（单击挥手）播完后的归位；
 *   ② 状态在一次性动作播放期间变化 —— 播完立刻接管，而不是等下一次状态事件。
 *
 * **行为层接管期间完全让位**（M3 第一块，ADR 018）：漫游/微动作/打盹都不来自业务状态，
 * 若这里照旧收敛，每一帧都会被拉回主状态的姿态上 —— 表现为"宠物根本走不动"。
 */
function reconcileStatus(): void {
  if (behaviorOverride) return;
  const p = lastStatus;
  if (!p || !player || player.isOneShot) return;
  const rest = restingState(p);
  if (player.stateId !== rest && player.stateId !== p.animation.state) {
    player.setState(rest, { then: p.animation.then });
  }
}

// —— 动画覆盖（M3 第一块：行为层；2026-09-22 起手动把玩也走这条）——
//
// 主进程说演什么就演什么（与状态同一条纪律）；`null` = 交回仲裁器。
// 覆盖期间 `reconcileStatus` 不再收敛（见上），所以走路能被看见。
// 命中判定不受影响：它每帧查**当前帧**的 alpha（ADR 008），换了行/帧自然跟着换。
//
// 日志前缀是 `动画覆盖：` 而不是 `行为层：` —— 这条通道现在有两个来源
// （自主行为层 / 用户手动把玩），主进程侧用 `[pet][behavior]` 与 `[pet][manual]`
// 区分来源，渲染层只说"我换成了哪一格"。
let behaviorOverride: { state: string; loop: boolean } | null = null;

window.pet.onBehavior((o) => {
  behaviorOverride = o;
  if (!player) return;
  if (o) {
    const changed = player.setState(o.state);
    if (changed) window.pet.log(`动画覆盖：${o.state}${o.loop ? '（循环）' : '（一次性）'}`);
    return;
  }
  // 交回仲裁器：立刻落到当前主状态的静止落点，而不是等下一帧的 reconcile
  const p = lastStatus;
  if (p) player.setState(restingState(p), { then: p.animation.then });
});

// —— 命中测试：把"哪些像素算实体"交给我们自己判定 ——
// 主进程常态整窗穿透（setIgnoreMouseEvents(true, { forward: true })），鼠标移动仍会转发到这里；
// 光标落在实体像素上才切回可交互，离开立刻释放。见 ADR 008。
let interactive = false;
/** 最近一次已知的光标位置（窗口客户区 CSS 像素）。tick() 每帧用它复评命中，见那里的注释。 */
let lastCss: { x: number; y: number } | null = null;
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
  const s = init.scale;
  const { width: cw, height: ch } = init.cell;
  // ① **客户区之外一律不算命中。**
  //    2026-09-16 用户实测抓到的 bug（症状："控制条出现后，鼠标在离它很远的地方仍会被判定为
  //    即将触发控制条"，而且面板偶尔收不掉）。根因就在这里：光标在窗口外时 cssX/cssY 是**负数**，
  //    经 `f.column * cw + localX` 这样的整数运算后会**落回图集内部的其它行列**，
  //    命中到的其实是另一行的精灵（日志证据：同一个 css=(-553,-813) 在动画帧之间
  //    时而判"空白"时而判"实体"）—— 判定随之抖动，悬停的 `hideAt` 被无限次重置。
  if (cssX < 0 || cssY < 0 || cssX >= cw * s || cssY >= ch * s) return false;
  const f = player.frame();
  const localX = Math.floor(cssX / s);
  const localY = Math.floor(cssY / s - f.offsetY);
  // ② **单元格之外也不算。** 同一条链路的第二半：`offsetY`（各状态的对齐补偿，最大 61px）
  //    会把局部坐标平移出当前单元格，滑到相邻行去命中别的精灵。少了这条，
  //    状态一换（offsetY 变）判定就会在宠物轮廓外的一圈里忽真忽假。
  if (localX < 0 || localY < 0 || localX >= cw || localY >= ch) return false;
  return solidAt(f.column * cw + localX, f.row * ch + localY);
}

function evaluateHit(cssX: number, cssY: number, force = false): void {
  const hit = hitAt(cssX, cssY);
  // 只在判定变化（或强制重报）时留一行取证：这是"点击到底归谁"的唯一一手数据，
  // 排查"点得动/点不动"全靠它。带上帧与换算结果，避免事后靠猜坐标。
  if (force || hit !== interactive) {
    const f = player?.frame();
    const s = init?.scale ?? 1;
    const localX = Math.floor(cssX / s);
    const localY = f ? Math.floor(cssY / s - f.offsetY) : null;
    window.pet.log(
      `命中评估 css=(${Math.round(cssX)},${Math.round(cssY)}) → ${hit ? '实体' : '空白'}` +
      ` ｜ 帧 row=${f?.row ?? '?'} col=${f?.column ?? '?'} ｜ 换算 local=(${localX},${localY ?? '?'}) scale=${s}`,
    );
  }
  setInteractive(hit, force);
}

// —— 交互：按住拖动；单击（未拖动）播「拜一下」并确认；右键唤出控制条 ——
let dragging = false;
let moved = 0;
let lastX = 0;
let lastY = 0;

// 只处理左键。不加这个判断的话，右键的 pointerdown 也会把 dragging 置真，
// 于是"右键菜单还没弹出来，宠物已经被拖着走了"。
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = 0;
  lastX = e.screenX;
  lastY = e.screenY;
  canvas.setPointerCapture(e.pointerId);
  // 告诉主进程"人在抓着它" → 行为层立刻停手，绝不与用户的手抢方向盘（ADR 018）。
  window.pet.dragState(true);
});

canvas.addEventListener('pointermove', (e) => {
  // **不要在这里判断 e.button**：pointermove 的 button 是 -1（本次移动没有按钮状态变化），
  // 按"只处理左键"写会把整段拖动静默吃掉 —— 实测症状是"按下有反应、拖动完全不动"，
  // 而 down/up/move 计数全都正常（`spikes/m2-menu/probe-tray.js` 抓到）。
  // dragging 只有左键按下才会置真，这里不必重复判断。
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  window.pet.dragBy({ dx, dy });
});

canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;                 // 同上：pointerup 的 button 对左键是 0，但不必依赖它
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  window.pet.dragState(false);
  const wasClick = moved < 4;
  if (wasClick && player) {
    // 单击 = 一、用户确认（「needs-input 驻留至用户确认」里的那个"确认"就落在这里，
    // 不接这条线的话，用户即使已经在别处回答了问题，宠物还会举着手等到粘滞超时，见 ADR 010）；
    // 二、播一次「拜一下」—— 第 3 行 `waving` 在淘淘 New 里画的正是**双手抱拳致意**的姿态
    // （见 docs/status-reference.png，别按状态名猜外观）。
    // 单击**不唤出控制条**：那是右键宠物的事（ADR 016），左键只做"陪一下"。
    window.pet.ack();
    // 帧推进被关闭时不播一次性动作（否则它会卡在首帧回不到静止状态）。
    if (!frozen() && !player.setState('waving')) player.setState('idle');
  }
  evaluateHit(e.clientX, e.clientY);   // 拖完可能已不在实体像素上，立刻复评
});

/**
 * 右键 → 请求主进程**唤出/收起控制条**（2026-09-17 起，ADR 016；此前是弹原生菜单）。
 *
 * 为什么由渲染层触发（而不是主进程监听鼠标）：窗口常态整窗穿透，只有渲染层知道
 * 光标是否落在精灵实体上（ADR 008）。Windows 不会替我们判断"这一下算不算点在宠物身上"。
 * 完整菜单仍在两条路径上：托盘右键、以及控制条面板里的「⋯」。
 */
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.requestContextMenu();
});
// 窗口内空白处（透明区）的右键交还给下层应用，不弹我们的菜单
window.addEventListener('contextmenu', (e) => e.preventDefault());

// 光标在窗口内移动时复评。注意：常态整窗穿透时 Windows **不会**把鼠标移动转发
// 到渲染层（实测 0 次），所以真正的驱动源是主进程 ~60Hz 的光标轮询（onPointerHint）。
// 这个监听器只在窗口已经可交互（光标就在宠物身上）时生效，属于锦上添花。
window.addEventListener('pointermove', (e) => {
  if (dragging) return;
  lastCss = { x: e.clientX, y: e.clientY };
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
  lastCss = { x: hint.cssX, y: hint.cssY };
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
  window.pet.dragState(false);   // 不补这一句，行为层会以为人还抓着（直到窗口重载）
}
canvas.addEventListener('pointercancel', onPointerCancel);
window.addEventListener('pointercancel', onPointerCancel);

window.pet.onFullscreen((n) => window.pet.log(n.hidden ? `让位隐藏（前台：${n.fgTitle}）` : '恢复显示'));

// 报到：告诉主进程可以下发 init 载荷了。顺带上报「减少动态效果」——
// 这个偏好只有渲染层读得到（matchMedia），而行为层要靠它决定"要不要漫游"（ADR 018）。
window.pet.ready({ reducedMotion });
