// Electron 主进程入口：装配「宠物内核」与「宿主适配层」。
//
// 分工：
//   - 内核（src/kernel）负责解析宠物包、状态机、播帧 —— 纯 TS，不 import electron
//   - 宿主（src/host）负责窗口与系统能力 —— 目前只有覆盖窗口与全屏检测
//   - 播帧循环跑在渲染层：避免每帧 IPC，内核代码放哪都能跑
import { app, ipcMain, Menu, screen } from 'electron';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { loadPack } from '../kernel/pack';
import { StatusArbiter, type PetStatus, type StatusEvent } from '../kernel/status';
import { createStatusFileSource } from '../source/status-file';
import type { StatusSource } from '../source/types';
import { createOverlayWindow } from '../host/overlay-window';
import { detectFullscreen, startFullscreenWatch, fullscreenUnavailableReason } from '../host/fullscreen';
import { createTray } from '../host/tray';
import { buildPetMenuTemplate, type PetMenuActions, type PetMenuView } from '../host/pet-menu';
import { isAutoStartEnabled, writeAutoStart } from '../host/autostart';
import { registerHotkey, unregisterHotkeys } from '../host/hotkey';
import { createBubbleLayer, type BubbleLayer } from '../host/bubble-layer';
import { loadPrefs, savePrefs } from '../host/prefs';
import { BUBBLE_HIDDEN, bubbleExpired, nextBubbleState, parseBubblePolicy, type BubbleState } from '../kernel/bubble-policy';
import { CH, type DragDelta, type HitState, type PointerHint, type RendererInit, type StatusPush } from '../shared/ipc';

/** 菜单里的状态行文案。用业务状态而不是动画状态名（用户看到的应该是"在干什么"）。 */
const STATUS_TEXT: Record<PetStatus, string> = {
  idle: '空闲',
  running: '运行中',
  'needs-input': '需要输入',
  blocked: '已受阻',
  ready: '就绪（未读）',
};

/** 宠物包目录：默认工程根目录，可用 --pet=绝对路径 覆盖。 */
function resolvePackDir(): string {
  const arg = process.argv.find((a) => a.startsWith('--pet='));
  if (arg) return resolve(arg.slice('--pet='.length));
  // dist/main/index.js → 上两级是工程根
  return resolve(__dirname, '..', '..');
}

/**
 * 状态文件路径。默认放用户目录而不是工程目录：hook 不需要知道工程在哪，
 * 换宠物包 / 换工程目录都不用改 hook 配置。
 * `--no-status-source` 用于隔离排查（此时宠物只受点击影响，不接任何外部状态）。
 */
function resolveStatusFile(): string | null {
  if (process.argv.includes('--no-status-source')) return null;
  const arg = process.argv.find((a) => a.startsWith('--status-file='));
  if (arg) return resolve(arg.slice('--status-file='.length));
  return join(homedir(), '.desktop-pet', 'status.json');
}

function toDataUrl(path: string, format: 'webp' | 'png'): string {
  const mime = format === 'png' ? 'image/png' : 'image/webp';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

function boot(): void {
  const packDir = resolvePackDir();
  console.log('[pet] 加载宠物包：' + packDir);
  const pack = loadPack(packDir);
  for (const w of pack.warnings) console.warn('[pet][warn] ' + w);
  console.log(`[pet] ${pack.manifest.displayName ?? pack.manifest.id} · ${pack.sheet.width}x${pack.sheet.height} ` +
    `· ${pack.grid.columns}x${pack.grid.rows} @ ${pack.cell.width}x${pack.cell.height} · ${Object.keys(pack.states).length} 个状态`);

  // —— 缩放：宠物包默认值 + 用户偏好（prefs），并夹进宠物包声明的可用区间 ——
  const render = pack.runtime.render;
  const scaleRange: [number, number] = render.scaleRange ?? [0.5, 1.5];
  const scaleStep = render.scaleStep && render.scaleStep > 0 ? render.scaleStep : 0.25;
  const clampScale = (s: number): number =>
    Math.min(scaleRange[1], Math.max(scaleRange[0], Math.round(s * 100) / 100));
  const prefs = loadPrefs();
  let currentScale = clampScale(prefs.scale ?? pack.scale);
  if (prefs.scale !== undefined && prefs.scale !== currentScale) {
    console.warn(`[pet] 偏好里的缩放 ${prefs.scale} 超出宠物包允许区间 [${scaleRange.join(',')}]，已夹到 ${currentScale}`);
  }

  const width = Math.round(pack.cell.width * currentScale);
  const height = Math.round(pack.cell.height * currentScale);

  const overlay = createOverlayWindow({
    width, height,
    htmlPath: join(__dirname, '..', 'renderer', 'index.html'),
    preloadPath: join(__dirname, 'preload.js'),
  });

  // init 载荷要等渲染层脚本就绪后再下发：ready-to-show 时页面脚本往往还没执行，
  // 过早 send 会丢消息（表现为宠物不显示、渲染层无任何日志）。
  let payload: RendererInit | null = null;
  const buildPayload = (): RendererInit => ({
    sheetDataUrl: toDataUrl(pack.sheetPath, pack.sheet.format),
    cell: pack.cell,
    grid: pack.grid,
    scale: currentScale,
    hitTestAlphaThreshold: render.hitTestAlphaThreshold ?? 1,
    states: pack.states,
    initialState: 'idle',
    warnings: pack.warnings,
    petId: pack.manifest.id,
    displayName: pack.manifest.displayName ?? pack.manifest.id,
  });

  overlay.browserWindow.once('ready-to-show', () => {
    overlay.showInactive();
    console.log('[pet] 窗口已显示，位置', JSON.stringify(overlay.position()));
  });

  overlay.browserWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  // 渲染层的 console 与加载错误转发到主进程日志，否则页面里的异常完全看不见
  type ConsoleMessageParams = { level: number; message: string; lineNumber: number; sourceId: string };
  const wc = overlay.browserWindow.webContents as unknown as {
    on(event: 'console-message', listener: (e: ConsoleMessageParams) => void): void;
  };
  wc.on('console-message', (e) => {
    console.log(`[pet][renderer:${e.level}] ${e.message} @ ${e.sourceId}:${e.lineNumber}`);
  });
  overlay.browserWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[pet] 页面加载失败 ${code} ${desc} ${url}`);
  });
  overlay.browserWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[pet] preload 出错 ${preloadPath}: ${error}`);
  });

  let selfCheckStarted = false;

  // —— 状态源 → 仲裁器 → 渲染层 ——
  // 这是"产品会不会空转"的那条链（PLAN §8 风险表里排第一的一条）。分工：
  //   源只管把外部世界变成事件；仲裁器只管把事件变成唯一主状态；渲染层只管画。
  const statusFile = resolveStatusFile();
  const arbiter = new StatusArbiter({
    statusMap: pack.runtime.statusMap,
    log: (m) => console.log('[pet]' + m),
  });

  // 事件流水落盘：链路通没通不看屏幕也能查，同时把 M3 要做的"事件回放"先埋下。
  const eventLogPath = resolve(
    process.argv.find((a) => a.startsWith('--event-log='))?.slice('--event-log='.length)
      ?? join(homedir(), '.desktop-pet', 'events.jsonl'),
  );
  try {
    mkdirSync(dirname(eventLogPath), { recursive: true });
  } catch (e) {
    console.warn('[pet] 事件日志目录创建失败（不影响运行）：' + String(e));
  }
  function recordEvent(e: StatusEvent): void {
    try {
      appendFileSync(eventLogPath, JSON.stringify(e) + '\n', 'utf8');
    } catch (e) {
      console.warn('[pet] 事件日志写入失败（不影响运行）：' + String(e));
    }
  }

  /**
   * 状态推送后要顺带做的事（目前是刷新托盘菜单里的状态行）。
   * 用可变钩子而不是直接调 refreshMenu：状态源在 boot 早期就会**同步**产出第一条事件，
   * 那时托盘与 refreshMenu 还没初始化（const 的 TDZ 会让启动直接抛异常）。
   */
  let afterStatusPush: (() => void) | null = null;

  /** 把仲裁结果推给渲染层。replay=true 表示这是重载后的补推，见 StatusPush.replay。 */
  function pushStatus(replay = false): void {
    if (overlay.browserWindow.isDestroyed()) return;
    const state = arbiter.state;
    const payload: StatusPush = replay ? { ...state, replay: true } : state;
    overlay.browserWindow.webContents.send(CH.status, payload);
    const anim = state.animation.then
      ? `${state.animation.state} → ${state.animation.then}`
      : state.animation.state;
    console.log(`[pet][status] 推送 ${state.status} → ${anim} rev=${state.rev}` +
      (state.badgeCount > 0 ? ` 角标=${state.badgeCount}` : '') +
      (replay ? '（重载补推，不重播一次性动作）' : ''));
    afterStatusPush?.();
  }

  let statusSource: StatusSource | null = null;
  if (statusFile) {
    statusSource = createStatusFileSource({
      path: statusFile,
      log: (m) => console.log('[pet][source] ' + m),
    });
    console.log('[pet] 状态源：' + statusSource.describe());
    statusSource.start((e: StatusEvent) => {
      recordEvent(e);
      if (arbiter.ingest(e)) pushStatus();
    });
  } else {
    console.warn('[pet] 状态源已禁用（--no-status-source）：宠物只会播 idle');
  }

  // 仲裁器需要"时间推进"才能处理粘滞超时、会话静默过期，以及被限流挡下的那次切换。
  // 气泡的到期检查顺带挂在这里（它也是"到点就该收"的语义，没必要另开一个定时器）。
  setInterval(() => {
    if (arbiter.tick()) pushStatus();
    expireBubble();
  }, 250);

  // —— 托盘 / 右键菜单：一张动作表，两个入口共用（M2 ②）——
  // 设计见 docs/design/m2-tray-menu.md，可行性探针见 spikes/m2-menu。
  let tray: ReturnType<typeof createTray> | null = null;

  /**
   * 让宠物恢复显示。**这是"重新显示"的唯一入口**。
   *
   * 为什么必须共用一处（ADR 009）：`hide()` → `showInactive()` 之后，Windows 不再把
   * **真实鼠标按钮事件**路由到这个窗口（移动事件正常），唯一可靠的恢复手段是重载渲染层。
   * 重载会触发渲染层重新报到，CH.ready 那段再统一补发 init / 强制重报命中 / 补推状态。
   * 任何地方单独写 `win.show()` 都会留下"看着正常但点不动"的窗口。
   */
  function resumePet(): void {
    overlay.show();
    overlay.reload();
  }

  /** 菜单视图：状态全部现读，菜单自己不持有状态（ADR 010 的唯一真值约定）。 */
  function petMenuView(): PetMenuView {
    const s = arbiter.state;
    const statusLine = STATUS_TEXT[s.status] +
      (s.badgeCount > 0 ? ` · 另有 ${s.badgeCount} 条会话` : '');
    return {
      visible: overlay.isVisible(),
      scale: currentScale,
      autoStart: isAutoStartEnabled(),
      statusLine,
      hotkey: activeHotkey,
      defaultScale: pack.scale,
      scaleRange,
      scaleStep,
    };
  }

  const refreshMenu = (): void => tray?.refresh();
  // 状态推送后要做的两件事：刷新托盘的提示与状态行；按策略刷新气泡。
  afterStatusPush = (): void => { refreshMenu(); refreshBubble(); };

  const actions: PetMenuActions = {
    toggleVisibility() {
      if (overlay.isVisible()) {
        overlay.hide();
        bubble?.hide();                     // 气泡是宠物的一部分，主人不在就一起收
        console.log('[pet] 已隐藏宠物（进程与托盘仍在，可从托盘恢复）');
      } else {
        resumePet();
        refreshBubble(true);                // 宠物回来时把气泡重新贴上去（策略不变）
        console.log('[pet] 恢复显示宠物');
      }
      refreshMenu();
    },
    setScale(next) {
      const s = clampScale(next);
      if (s === currentScale) return;
      currentScale = s;
      savePrefs({ scale: s });
      payload = null;                       // init 载荷里带着 scale，必须重建
      const size = overlay.setScale(s, pack.cell);
      resumePet();                          // canvas 尺寸与命中映射都按新 scale 走，靠重载重建
      refreshBubble(true);
      console.log(`[pet] 缩放 → ${s}（窗口内容区 ${size.width}x${size.height} DIP）`);
      refreshMenu();
    },
    resetScale() {
      savePrefs({ scale: undefined });      // 删掉偏好，回到宠物包默认值
      if (Math.abs(currentScale - pack.scale) < 0.001) return;
      currentScale = pack.scale;
      payload = null;
      const size = overlay.setScale(currentScale, pack.cell);
      resumePet();
      refreshBubble(true);
      console.log(`[pet] 重置缩放 → ${currentScale}（宠物包默认值）`);
      refreshMenu();
    },
    setAutoStart(on) {
      writeAutoStart(on);
      console.log(`[pet] 开机自启 → ${on ? '开' : '关'}（回读=${isAutoStartEnabled()}）`);
      refreshMenu();
    },
    quit() {
      console.log('[pet] 用户从菜单退出');
      void statusSource?.stop();
      tray?.destroy();
      bubble?.destroy();
      unregisterHotkeys();
      app.quit();
    },
  };

  // —— 全局快捷键（在托盘之前注册：petMenuView 要读 activeHotkey，早于它调用会踩 TDZ）——
  // 默认值与降级链来自宠物包（interaction.hideShortcut）；本机实测默认值可用，见 spikes/m2-hotkey/。
  const shortcutMeta = pack.runtime.interaction?.['hideShortcut'] as
    | { default?: string; fallbacks?: string[] }
    | undefined;
  const preferredHotkey = prefs.hotkey ?? shortcutMeta?.default ?? 'Super+Alt+P';
  const fallbackHotkeys = Array.isArray(shortcutMeta?.fallbacks)
    ? shortcutMeta.fallbacks
    : ['Ctrl+Alt+P', 'Super+Alt+Space', 'Ctrl+Shift+Alt+P'];
  const hotkeyResult = registerHotkey(preferredHotkey, fallbackHotkeys, () => {
    console.log('[pet] 全局快捷键触发：切换宠物显示');
    actions.toggleVisibility();
  });
  const activeHotkey: string | null = hotkeyResult.accelerator;
  if (hotkeyResult.ok) {
    const how = hotkeyResult.usedFallback
      ? `（首选 ${preferredHotkey} 不可用，已降级）`
      : hotkeyResult.normalizedFrom
        ? `（由 ${hotkeyResult.normalizedFrom} 归一化而来）`
        : '';
    console.log(`[pet] 快捷键已注册：${activeHotkey}${how}`);
  } else {
    console.warn('[pet] 快捷键注册失败（全部候选都被占用）：' +
      hotkeyResult.attempts.map((a) => a.accelerator).join(' / ') +
      '；宠物仍可从托盘或右键菜单操作');
  }


  // 托盘图标：脚本从图集生成（tools/make-tray-icon.py）。生成失败/缺失只降级不致命。
  const trayIcon = join(__dirname, '..', '..', 'assets', 'tray.ico');
  try {
    tray = createTray({ iconPath: trayIcon, getView: petMenuView, actions });
    console.log('[pet] 托盘已创建：' + trayIcon);
  } catch (e) {
    console.error('[pet] 托盘创建失败（宠物本体不受影响，但隐藏后将无入口可恢复）：' + String(e));
  }

  // —— 气泡层：状态文案与多会话角标（独立窗口，见 host/bubble-layer.ts 顶部注释）——
  const bubblePolicy = parseBubblePolicy((pack.runtime as unknown as Record<string, unknown>)['bubble']);
  let bubble: BubbleLayer | null = null;
  let bubbleState: BubbleState = BUBBLE_HIDDEN;
  try {
    bubble = createBubbleLayer({
      htmlPath: join(__dirname, '..', 'renderer', 'bubble.html'),
      preloadPath: join(__dirname, 'bubble-preload.js'),
      gapAbovePet: 10,
      minWidth: 88,
      maxWidth: 320,
      height: 32,
    });
    console.log('[pet] 气泡层已创建（常态整窗穿透，不参与命中判定）');
  } catch (e) {
    console.error('[pet] 气泡层创建失败（状态仍可从托盘菜单查看）：' + String(e));
  }

  /**
   * 按仲裁器状态刷新气泡。策略是纯函数（kernel/bubble-policy.ts），这里只做"应用结果"。
   * @param force 绕过"状态未变就不动"的短路（宠物重新显示后要重新贴上去）。
   */
  function refreshBubble(force = false): void {
    if (!bubble) return;
    const s = arbiter.state;
    const next = nextBubbleState(bubbleState, { status: s.status, text: s.bubble, badgeCount: s.badgeCount }, bubblePolicy, Date.now());
    if (!force && next === bubbleState) return;
    const wasVisible = bubbleState.visible;
    bubbleState = next;
    if (!next.visible || !next.text) {
      if (wasVisible || force) bubble.hide();
      return;
    }
    bubble.show(next.text, next.badge);
  }

  /** 气泡到期检查（由 250ms 的仲裁 tick 顺带驱动，不另开定时器）。 */
  function expireBubble(): void {
    if (!bubble) return;
    if (!bubbleExpired(bubbleState, Date.now())) return;
    bubbleState = { ...bubbleState, visible: false, hideAt: null };
    bubble.hide();
  }

  refreshMenu();   // 快捷键已定，菜单里那行"快捷键：…"要跟上

  // 探针用接缝：`--expose-actions` 时把动作表与若干只读探针挂到 globalThis，便于自动化验证
  // "隐藏→显示→仍可点击/拖动""改缩放后尺寸正确""自启回读正确""退出真的退出""气泡按策略显示"。
  if (process.argv.includes('--expose-actions')) {
    const g = globalThis as unknown as { __petActions?: unknown; __petDebug?: unknown };
    g.__petActions = actions;
    g.__petDebug = {
      bubbleState: () => bubbleState,
      hotkey: () => activeHotkey,
      bubbleVisible: () => bubble?.isVisible() ?? false,
      petBounds: () => overlay.browserWindow.getContentBounds(),
    };
    console.log('[pet] --expose-actions：动作表与只读探针已挂到 globalThis（仅供探针）');
  }

  app.on('will-quit', () => {
    void statusSource?.stop();
    unregisterHotkeys();
    bubble?.destroy();
  });

  ipcMain.on(CH.ready, () => {
    // 页面重载后渲染层会再次报到：payload 复用缓存，自检只跑一次
    payload ??= buildPayload();
    // 新页面从"整窗穿透"起步，并立刻**强制**重报一次命中状态（见 ADR 009）
    overlay.resetToIgnore();
    overlay.browserWindow.webContents.send(CH.init, payload);
    pushPointerHint(true);
    // 同样地，新页面必须重新拿到当前状态：否则每次全屏让位恢复（会 reload 渲染层）
    // 之后宠物都静默回到 idle，而仲裁器还以为自己在 running。replay 标记让渲染层
    // 落到静止落点，不重播一次性动作。
    pushStatus(true);
    if (!selfCheckStarted) {
      selfCheckStarted = true;
      scheduleSelfCheck();
    }
  });

  // —— 命中测试：渲染层判定"光标落在实体像素上"才让窗口可交互，否则整窗穿透 ——
  // 2026-09-15 实测：Windows 对分层窗口的逐像素命中测试在此组合下不生效，生效区域
  // 是整个窗口矩形（窗口内 90/90 采样点全部吃掉点击）。故改由渲染层显式接管，见 ADR 008。
  let lastInteractive = false;
  ipcMain.on(CH.interactive, (_e, state: HitState) => {
    const on = Boolean(state?.interactive);
    // 只在真正变化时打日志：这是"点击到底归谁"的第一手证据，排查穿透类问题全靠它
    if (on !== lastInteractive) {
      lastInteractive = on;
      console.log(`[pet] 命中状态 → ${on ? '可交互（光标在宠物实体上）' : '整窗穿透'}`);
    }
    overlay.setInteractive(on);
  });

  /** 光标在窗口内容区里的位置（DIP，与渲染层 CSS 像素一致）。 */
  function cursorHint(): PointerHint | null {
    const win = overlay.browserWindow;
    if (win.isDestroyed() || !win.isVisible()) return null;
    const cp = screen.getCursorScreenPoint();   // DIP
    const cb = win.getContentBounds();          // DIP
    return { cssX: cp.x - cb.x, cssY: cp.y - cb.y };
  }
  function pushPointerHint(force = false): void {
    const hint = cursorHint();
    if (hint) overlay.browserWindow.webContents.send(CH.pointerHint, { ...hint, force });
  }

  /**
   * 光标轮询：命中判定必须跟着光标走，而 `setIgnoreMouseEvents(true)` 下
   * **鼠标移动不会转发到渲染层**（2026-09-15 实测：注入拖动期间渲染层收到 0 次
   * pointermove，只靠 300ms 兜底轮询驱动，表现为"点击宠物有时穿透、有时吃到"）。
   * 所以这里自己以 ~60Hz 轮询光标，只在光标位置真的变化时才发消息。
   * 实测把命中延迟从"最长 300ms"降到"最长 16ms"，误穿透归零。
   */
  let lastCursor: { x: number; y: number } | null = null;
  function pollPointer(): void {
    const win = overlay.browserWindow;
    if (win.isDestroyed() || !win.isVisible()) return;
    const cp = screen.getCursorScreenPoint();
    if (lastCursor && cp.x === lastCursor.x && cp.y === lastCursor.y) return;
    lastCursor = { x: cp.x, y: cp.y };
    pushPointerHint();
  }
  setInterval(pollPointer, 16);

  // —— 拖动：渲染层只上报增量，窗口移动由宿主完成 ——
  // —— 自检：--screenshot=<前缀> 抓两帧存盘后退出，用于验证"动画确实在播" ——
  async function scheduleSelfCheck(): Promise<void> {
    const arg = process.argv.find((a) => a.startsWith('--screenshot='));
    if (!arg) return;
    const prefix = resolve(arg.slice('--screenshot='.length));
    mkdirSync(dirname(prefix), { recursive: true });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      await wait(1200);
      const a = await overlay.browserWindow.webContents.capturePage();
      writeFileSync(`${prefix}-a.png`, a.toPNG());
      await wait(400);
      const b = await overlay.browserWindow.webContents.capturePage();
      writeFileSync(`${prefix}-b.png`, b.toPNG());
      console.log(`[pet] 自检截图已保存：${prefix}-a.png / ${prefix}-b.png`);
    } catch (e) {
      console.error('[pet] 自检截图失败：', e);
    }
    app.quit();
  }

  ipcMain.on(CH.drag, (_e, delta: DragDelta) => {
    overlay.moveBy(Math.round(delta.dx), Math.round(delta.dy));
    // 气泡贴在宠物上方，宠物动了它得跟着（否则拖动时气泡会留在原地）
    bubble?.followPet(overlay.browserWindow.getContentBounds());
  });

  ipcMain.on(CH.log, (_e, message: string) => console.log('[pet][renderer] ' + message));

  /**
   * 宠物上右键 → 弹出宠物菜单。命中判定在渲染层（ADR 008），主进程只管弹。
   * 原生菜单在 `WS_EX_NOACTIVATE | TOPMOST` 的透明窗口上可弹出、可点击，
   * 已由 `spikes/m2-menu` 用真实点击实测确认（不是推断）。
   */
  ipcMain.on(CH.contextMenu, () => {
    Menu.buildFromTemplate(buildPetMenuTemplate(petMenuView(), actions))
      .popup({ window: overlay.browserWindow });
  });

  // —— 用户确认：解除 needs-input 粘滞 ——
  // 单击宠物即"我看到了"。不这样做的话，用户即使已经在终端里回答了问题，
  // 宠物还会举着手等到粘滞超时（默认 5 分钟），看起来像坏了。
  ipcMain.on(CH.ack, () => {
    if (arbiter.ack()) pushStatus();
  });

  // —— 全屏让位：命中即隐藏，退出后恢复 ——
  if (!detectFullscreen().available) {
    console.warn('[pet] 全屏检测不可用：' + (fullscreenUnavailableReason() ?? '未知原因') + '（宠物将不会自动让位）');
  }
  startFullscreenWatch((status) => {
    if (status.coversMonitor) {
      overlay.hide();
      bubble?.hide();                     // 气泡是宠物的一部分，全屏让位时一起收
      console.log('[pet] 检测到全屏应用「' + status.fgTitle + '」，已让位隐藏');
    } else {
      overlay.show();
      // 关键：hide→show 之后 Windows 不再把真实鼠标按钮事件路由到这个窗口
      // （移动事件正常、坐标正确、样式位正确、SendMessage 能进），实测只有重新加载
      // 渲染层才能让 Chromium 重建输入通路。详见 host/overlay-window.ts 的 reload 注释。
      overlay.reload();
      refreshBubble(true);                // 气泡层不需要 reload（它从不接收按钮事件），贴回去即可
      console.log('[pet] 全屏应用已退出，恢复显示（已重载渲染层以恢复输入通路）');
    }
    overlay.browserWindow.webContents.send(CH.fullscreen, { hidden: status.coversMonitor, fgTitle: status.fgTitle });
  }, 600);
}

app.whenReady().then(boot).catch((e) => {
  console.error('[pet] 启动失败：', e);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
