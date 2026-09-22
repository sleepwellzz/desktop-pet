// Electron 主进程入口：装配「宠物内核」与「宿主适配层」。
//
// 分工：
//   - 内核（src/kernel）负责解析宠物包、状态机、播帧 —— 纯 TS，不 import electron
//   - 宿主（src/host）负责窗口与系统能力 —— 目前只有覆盖窗口与全屏检测
//   - 播帧循环跑在渲染层：避免每帧 IPC，内核代码放哪都能跑
import { app, ipcMain, Menu, screen } from 'electron';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
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
import { isAutoStartEnabled, migrateLegacyAutoStart, writeAutoStart } from '../host/autostart';
import { createBubbleLayer, type BubbleLayer } from '../host/bubble-layer';
import { createControlBar, type ControlBar } from '../host/control-bar';
import { loadPrefs, savePrefs } from '../host/prefs';
import { BUBBLE_HIDDEN, bubbleExpired, nextBubbleState, parseBubblePolicy, type BubbleState } from '../kernel/bubble-policy';
import {
  BAR_HIDDEN, nextBarState, parseBarPolicy, tickBarState,
  type BarEvent, type BarPolicy, type BarState,
} from '../kernel/bar-policy';
import {
  BEHAVIOR_IDLE, parseBehaviorPolicy, roamSpeedPxPerSec, tickBehavior, wakeBehavior,
  type BehaviorCommand, type BehaviorPolicy, type BehaviorState,
} from '../kernel/behavior';
import {
  beginManualPlay, parseManualPlayPolicy, tickManualPlay,
  type ManualAction, type ManualPlay, type ManualPlayPolicy,
} from '../kernel/manual-play';
import {
  CH, type BarCommand, type BarCommandId, type BarView, type DragDelta, type DragState, type HitState,
  type PointerHint, type ReadyInfo, type RendererInit, type StatusPush,
} from '../shared/ipc';

/**
 * 菜单里的状态行文案。用业务状态而不是动画状态名（用户看到的应该是"在干什么"）。
 *
 * `satisfies` 而不是 `: Record<...>` 的注解，是为了让**漏写一种状态**变成编译错误，
 * 同时保留字面量类型（`statusLabels` 传给渲染层时键名仍然精确）。
 */
const STATUS_TEXT = {
  idle: '空闲',
  running: '运行中',
  'needs-input': '需要输入',
  blocked: '已受阻',
  ready: '就绪（未读）',
} satisfies Record<PetStatus, string>;

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

/**
 * 启动打戳（`--trace-boot`）。生产路径零开销 —— 不加这个开关时 `bootMark` 是个空函数。
 *
 * 为什么需要它：启动耗时是**加总效应**，十几处几十毫秒的同步调用叠起来才是用户感知的
 * "数秒"，单看任何一处都"看起来没问题"。要定位只能让每一处自己报数。
 */
const TRACE_BOOT = process.argv.includes('--trace-boot');
const BOOT_T0 = Date.now();
const LOG_PATH = join(homedir(), '.desktop-pet', 'pet.log');
const bootMark = TRACE_BOOT
  ? (label: string): void => { console.log(`[boot] ${Date.now() - BOOT_T0} ms ${label}`); }
  : (): void => { /* 未开启打戳 */ };

/**
 * 把 `console` 同时写一份到 `~/.desktop-pet/pet.log`。
 *
 * 为什么需要它：以前日志只打到 stdout，于是**必须挂着一个控制台窗口**才看得到 ——
 * 关掉窗口宠物就退出（控制台是它的父进程）。有了无控制台的启动方式（`启动桌宠-后台.bat`）
 * 之后，日志必须有别的地方可去，否则排查类问题会变成"两眼一抹黑"。
 *
 * 每次启动**截断**（只留本次运行的日志）：它是排查工具，不是审计台账；
 * 真正需要留痕的事件流水在 `events.jsonl`（只增不删）。
 */
function setupFileLog(): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    writeFileSync(LOG_PATH, `[pet] ==== 启动 ${new Date().toISOString()} ====\n`, 'utf8');
    for (const level of ['log', 'warn', 'error'] as const) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]): void => {
        orig(...(args as []));
        try {
          appendFileSync(LOG_PATH, args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n', 'utf8');
        } catch { /* 日志写失败绝不能影响运行 */ }
      };
    }
  } catch (e) {
    console.warn('[pet] 日志文件初始化失败（不影响运行）：' + String(e));
  }
}

/**
 * 启动装配。**线性执行、不改顺序**，下面的索引就是执行顺序（搜 `═══` 可跳段）。
 *
 * 为什么它这么长却**没有**拆成几个独立的装配函数：
 * 这些段落共享同一批对象（`overlay` / `arbiter` / `bubble` / `bar` / `prefs` …），
 * 而且彼此有明确先后（托盘菜单要在动作表之后建）。
 * 拆成模块级函数就得把这一批对象打包成一个 ctx 传来传去 —— 隐式耦合变成显式但更啰嗦，
 * 而启动路径的**任何**改动都要跑全屏/托盘/控制条/行为层/状态五套真实窗口回归。
 * 权衡下来：**先让它可导航**（索引 + 分节），等真出现"某一段要被复用"的需求再拆。
 */
function boot(): void {
  setupFileLog();
  bootMark('boot() 进入');
  // ══════════════════════════════════════════════════════════════════════
  // 装配索引（按执行顺序）
  //   ①  缩放与宠物覆盖窗口      pack 的默认值 + 用户 prefs，夹进包声明的可用区间
  //   ②  状态源 → 仲裁器 → 渲染层   仲裁器是全应用唯一真值；状态源**最后**才启动（见 ⑦）
  //  ③  托盘 / 右键菜单         一张动作表，两个入口共用（单击托盘 = 显示/隐藏）
  //   ④  气泡层                  独立透明层窗口，常态整窗穿透
  //   ⑤  控制条 + 命令白名单      本项目第一个可聚焦窗口
  //   ⑥  行为层                  漫游 / 微动作 / 打盹；纯函数在 kernel/behavior.ts
  //   ⑦  手动把玩                面板动作排点一个动作就演一次；纯函数在 kernel/manual-play.ts
  //   ⑦  状态源启动与时间推进     **必须等所有窗口建好之后**，见那处注释
  //   ⑧  命中测试与光标轮询       ~60Hz 轮询光标，命中由渲染层按 alpha 判定
  //   ⑨  自检 / 拖动 / 右键 / 确认   IPC 通道接线
  //   ⑩  全屏让位                命中即隐藏，退出后 reload 渲染层
  //
  // （原「④ 全局快捷键」已于 2026-09-21 整块删除，ADR 032：用户不用、且从未被真实按过一次，
  //   留着就是一个未验证的静默失败面。控制条剩两条唤出路径：右键宠物 / 托盘菜单「控制条」。）
  // ══════════════════════════════════════════════════════════════════════
  // 打包态诊断（挂起 #13）： 决定开机自启写进注册表的命令形态
  // （未打包要带应用路径参数，已打包不能带 —— 带上会被当成要打开的文件）。
  // 它**只从真实运行里才看得到**，猜测它的取值会直接写错注册表，所以落成一行启动日志。
  console.log('[pet] 打包态 isPackaged=' + app.isPackaged + '｜应用路径=' + app.getAppPath());
  const packDir = resolvePackDir();
  console.log('[pet] 加载宠物包：' + packDir);
  const pack = loadPack(packDir);
  bootMark('宠物包已解析（含精灵图 stat / 魔数 / 尺寸校验）');
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
  bootMark('宠物覆盖窗口已创建');

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
    bootMark('窗口已显示（ready-to-show）');
    console.log('[pet] 窗口已显示，位置', JSON.stringify(overlay.position()));
  });

  overlay.browserWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  bootMark('loadFile 已调用');

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
  // 状态层的到点收敛参数从宠物包读（ADR 021）：不写死在内核里，因为"60 秒够不够"
  // 是观感取舍，换宠物包/换使用节奏时可能要调；而它在屏幕上完全看不出对错，所以必须可配 + 可单测。
  const statusTimeouts = (pack.runtime as unknown as {
    statusTimeouts?: {
      stickyMs?: number; readyMs?: number; reAskMinIntervalMs?: number; sessionStaleMs?: number;
      /** 双通道逐出（ADR 027）：hook 优先于被动源，低优先级上报被丢弃。 */
      dominance?: { enabled?: boolean; holdMs?: number };
    };
  }).statusTimeouts ?? {};
  /**
   * `--ready-ms=<毫秒>`：**给探针用的接缝**（与 `--no-status-source` / `--no-behavior` 同一套路）。
   *
   * 为什么必须有：`ready` 的通报时效默认 60 秒，真实窗口探针跑一轮要等 60 秒才能观察到退场，
   * 既慢又容易在等待期间被别的干扰（注入的鼠标事件、窗口重载）打断。
   * 压到 4 秒后，一套"通报期内画第 8 行 / 到期后回第 0 行"的断言能在 12 秒内跑完。
   * 注意它**只覆盖参数**，不改任何逻辑分支 —— 探针验的仍是同一条代码路径。
   */
  const readyMsArg = process.argv.find((a) => a.startsWith('--ready-ms='));
  const readyMsOverride = readyMsArg ? Number(readyMsArg.slice('--ready-ms='.length)) : undefined;
  const arbiter = new StatusArbiter({
    statusMap: pack.runtime.statusMap,
    stickyTimeoutMs: statusTimeouts.stickyMs,
    readyTimeoutMs: Number.isFinite(readyMsOverride) ? readyMsOverride : statusTimeouts.readyMs,
    reAskMinIntervalMs: statusTimeouts.reAskMinIntervalMs,
    sessionStaleMs: statusTimeouts.sessionStaleMs,
    dominance: statusTimeouts.dominance,
    log: (m) => console.log('[pet]' + m),
  });
  if (Number.isFinite(readyMsOverride)) {
    console.warn(`[pet] ready 通报时效已由 --ready-ms 覆盖为 ${readyMsOverride}ms（探针/排查用）`);
  }

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
  /**
   * 落事件流水（`~/.desktop-pet/events.jsonl`），供离线查证。
   *
   * **额外写 `recvAt`（宠物收到的时刻）**：事件里的 `ts` 是**写侧**（hook 进程）产生时刻，
   * 拿它算端到端延迟会**严重低估** —— ADR 020 实测两者只差 2ms，那只是 hook 进程内
   * "落 payload → 写状态文件"的间隔，根本没算上"文件监听 → 主进程读到"这一段。
   * **端到端延迟 = `recvAt - ts`（判据 6）**，这是目前唯一可用的时间基准。
   */
  function recordEvent(e: StatusEvent): void {
    try {
      appendFileSync(eventLogPath, JSON.stringify({ ...e, recvAt: Date.now() }) + '\n', 'utf8');
    } catch (e) {
      console.warn('[pet] 事件日志写入失败（不影响运行）：' + String(e));
    }
  }

  /**
   * 状态推送后要顺带做的事（刷新托盘菜单、气泡、控制条三处的状态）。
   *
   * 用可变钩子而不是直接调用，是为了让"推状态"与"谁在监听"解耦 —— 监听方有三处
   * （托盘 / 气泡 / 控制条），而且它们全部在 `pushStatus` 定义**之后**才创建。
   * （2026-09-17 审计：原先这里的理由写的是"状态源在 boot 早期同步产出第一条事件"，
   * 那次改动把状态源的启动移到了所有窗口创建之后，理由已不成立；钩子本身保留。）
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
  } else {
    console.warn('[pet] 状态源已禁用（--no-status-source）：宠物只会播 idle');
  }

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

  /**
   * 清空状态文件里的全部会话（菜单项「清空状态会话」）。
   *
   * 为什么需要它：状态文件是**快照**，进程重启后状态自然还在（这是当初选它而不是 HTTP 的
   * 理由之一）—— 但副作用是"上一次跑完留下的会话"会在下次启动时被原样读回来。
   * 2026-09-16 用户实测困惑："一启动就显示 default 在运行中，怎么喂都改不了" ——
   * 其实改得掉，只是没人知道那条会话还留在文件里（按会话清只能靠 `喂状态.bat` 的 7/9）。
   *
   * **三处都要清，缺一处用户看到的都是"没清干净"**（2026-09-17 实测，ADR 016）：
   *   ① 文件：写一份空快照（原子替换，与 `pet-hook.mjs` 同款）；
   *   ② 适配器的记忆：`reset()`。否则它下一次读盘会把"空快照"diff 成"每条会话都消失了"，
   *      各补一条 idle 收尾 —— 刚清掉的会话立刻以 idle 的形式回来；
   *   ③ 仲裁器的记录：`clearSessions()`。否则那些记录仍在（面板照旧列两行、
   *      菜单照旧写「清空状态会话（N 条）」），要等 15 分钟静默兜底才轮到它们。
   * 最后再刷新面板与菜单，让计数当场归零。
   */
  function clearStatusSessions(): void {
    if (!statusFile) {
      console.warn('[pet] 状态源已禁用，没有可清空的会话');
      return;
    }
    try {
      mkdirSync(dirname(statusFile), { recursive: true });
      const tmp = `${statusFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ schema: 'desktop-pet/status/v1', sessions: {} }, null, 2) + '\n', 'utf8');
      renameSync(tmp, statusFile);
    } catch (e) {
      console.error('[pet] 清空状态文件失败：' + String(e));
      return;                                // 文件没写成功就别再动内存里的状态，免得两边错开
    }
    statusSource?.reset?.();
    const changed = arbiter.clearSessions();
    // 输出变化时走完整的推送路径（它顺带刷新托盘、气泡、面板三处）；
    // 输出没变（本来就没有会话在要求注意）时，面板与菜单的行数也仍要刷成 0。
    if (changed) pushStatus();
    refreshBar();
    refreshMenu();
    console.log('[pet] 已清空全部会话（文件 + 适配器记忆 + 仲裁器记录）');
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
      defaultScale: pack.scale,
      scaleRange,
      scaleStep,
      sessionCount: arbiter.viewSessions().length,
    };
  }

  const refreshMenu = (): void => tray?.refresh();
  // 状态推送后要做的三件事：刷新托盘的提示与状态行；按策略刷新气泡；刷新控制条内容。
  afterStatusPush = (): void => { refreshMenu(); refreshBubble(); refreshBar(); };

  const actions: PetMenuActions = {
    toggleVisibility() {
      if (overlay.isVisible()) {
        overlay.hide();
        bubble?.hide();                     // 气泡是宠物的一部分，主人不在就一起收
        hideBar('宠物已隐藏');               // 控制条锚定宠物，宠物不在就不该留在半空
        console.log('[pet] 已隐藏宠物（进程与托盘仍在，可从托盘恢复）');
      } else {
        resumePet();
        refreshBubble(true);                // 宠物回来时把气泡重新贴上去（策略不变）
        console.log('[pet] 恢复显示宠物');
      }
      refreshMenu();
    },
    toggleControlBar() {
      toggleBar();
    },
    clearSessions() {
      clearStatusSessions();
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
      bar?.followPet(overlay.browserWindow.getContentBounds());   // 宠物变大了，面板要重新贴
      refreshBar();                         // 面板上的缩放值也要跟着变
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
      bar?.followPet(overlay.browserWindow.getContentBounds());
      refreshBar();
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
      // **两条定时器都要停**（缺一不可，ADR 035）：
      //   - `stopTimers()`      16/33ms，也跟着窗口 show/hide 走；
      //   - `stopProcessTimers()` 250ms 仲裁推进 + 600ms 全屏监听，**只在这里停**。
      // 后者漏了的话，拆完窗口到进程真正退出之间还会有一两次 tick 落在已销毁的
      // 窗口上 —— 那正是用户在便携版点「退出宠物」时弹出的 `Object has been destroyed`
      // （探针日志里那行"噪音"从来就不是一个可忽略的噪音，是把高分 Styling 问题
      // 降格处理的代价）。
      stopTimers();
      stopProcessTimers();
      void statusSource?.stop();
      tray?.destroy();
      bubble?.destroy();
      bar?.destroy();
      app.quit();
    },
  };

  // （原「全局快捷键」装配段已整块删除，ADR 032 —— 见上方装配索引的注记。）
  // 控制条的唤出现在只有两条显式路径：右键宠物 / 托盘菜单「控制条」。

  // 托盘图标：脚本从图集生成（tools/make-tray-icon.py）。生成失败/缺失只降级不致命。
  const trayIcon = join(__dirname, '..', '..', 'assets', 'tray.ico');
  try {
    tray = createTray({ iconPath: trayIcon, getView: petMenuView, actions });
    console.log('[pet] 托盘已创建：' + trayIcon);
  } catch (e) {
    console.error('[pet] 托盘创建失败（宠物本体不受影响，但隐藏后将无入口可恢复）：' + String(e));
  }
  bootMark('托盘已创建');

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
  bootMark('气泡层已创建');

  /**
   * 按仲裁器状态刷新气泡。策略是纯函数（kernel/bubble-policy.ts），这里只做"应用结果"。
   *
   * **宠物矩形由这里显式传下去**：气泡层是独立窗口，它自己 `getContentBounds()` 拿到的是
   * 气泡窗的矩形（构造时的默认尺寸/位置），拿它当宠物位置用会让气泡出现在屏幕正中且
   * 此后再也不跟着宠物走 —— 这就是本轮修掉的那个缺陷（见 `host/bubble-layer.ts` 的 `show`）。
   * 宠物窗口已销毁时**选择不显示**：画错位置比不画更糟。
   *
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
    if (overlay.browserWindow.isDestroyed()) {
      bubbleState = { ...bubbleState, visible: false, hideAt: null };
      if (wasVisible || force) bubble.hide();
      return;
    }
    bubble.show(next.text, next.badge, overlay.browserWindow.getContentBounds());
  }

  /** 气泡到期检查（由 250ms 的仲裁 tick 顺带驱动，不另开定时器）。 */
  function expireBubble(): void {
    if (!bubble) return;
    if (!bubbleExpired(bubbleState, Date.now())) return;
    bubbleState = { ...bubbleState, visible: false, hideAt: null };
    bubble.hide();
  }

  // —— 手动把玩：面板动作排（2026-09-22，ADR 038）——
  //
  // 用户右键唤出面板、点一个动作，宠物就演一次 —— **与 agent 现在是什么状态无关**，
  // 所以它必须**高过**仲裁器状态，也必须高过自主行为层。三级优先级的来由：
  //   手动把玩（用户在看着它、刚点了它）> 自主行为层（它自己找乐子）> 仲裁器状态（agent 的事）。
  //
  // 为什么不能用 `CH.status` 实现：仲裁器是"全应用唯一真值"，往里塞一个手动动作会污染
  // 业务语义（托盘、气泡、面板会话行都会开始显示一些并不存在的 agent 状态）。所以手动把玩
  // 走的是**动画覆盖通道**（`CH.behavior`，与行为层同一条）—— 顺带白拿了"不产生气泡"：
  // 气泡只由业务状态产生（`statusMap[].bubble`），覆盖通道从不碰它。
  //
  // 状态放这里（而不是行为层内部）是因为 `barView()` 要读它做高亮，而 `barView` 比行为层先装配。
  const manualPolicy: ManualPlayPolicy = parseManualPlayPolicy(
    (pack.runtime as unknown as Record<string, unknown>)['actions'],
    pack,
    (m) => console.warn('[pet][manual] ' + m),
  );
  const manualActionByState = new Map(manualPolicy.actions.map((a) => [a.state, a]));
  /** 正在手动把玩的那一个；null = 没有。同一时刻最多一个（用户一次只点一个动作）。 */
  let manualPlay: ManualPlay | null = null;
  console.log(`[pet] 手动把玩：${manualPolicy.actions.length} 个动作（`
    + manualPolicy.actions.map((a) => `${a.label}=${a.state}`).join(' / ')
    + `），循环动作演 ${manualPolicy.dwellMs / 1000}s`
    + `，位移 ${manualPolicy.walkDistancePx.min}–${manualPolicy.walkDistancePx.max}px`);

  /** 宠物所在显示器的工作区。手动位移要夹进它（与自主漫游同一条范围纪律：不跨屏）。 */
  function workAreaOf(pet: { x: number; y: number; width: number; height: number }): {
    x: number; y: number; width: number; height: number;
  } {
    return screen.getDisplayNearestPoint({
      x: Math.round(pet.x + pet.width / 2),
      y: Math.round(pet.y + pet.height / 2),
    }).workArea;
  }

  // —— 控制条：本项目**第一个可聚焦窗口**（M2 ④，设计见 docs/design/m2-control-bar.md）——
  //
  // 本轮范围（D1 已拍板）：控制条 = 状态仪表盘 + 快捷动作，**不渲染自由文本输入框**。
  // 理由是规格里输入框的每个去处（铅笔=开新对话、`@` 上下文、`$` 技能、线程列表）
  // 全在 M3 的 agent 通道上；本轮控制条能做实、规格也支持的部分是"它是个窗口"本身。
  // 输入框的位置与契约在设计里冻结：M3 落地时它长在同一位置，走同一个 barCommand 通道，
  // 窗口层不用改（高度会从"顶栏+行+动作排"多长出一段输入区）。
  const barMeta = (pack.runtime as unknown as Record<string, unknown>)['controlBar'] as
    Record<string, unknown> | undefined;
  const barPolicy: BarPolicy = parseBarPolicy(barMeta);
  const barNum = (k: string, def: number): number => {
    const v = barMeta?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  const barWidth = barNum('width', 260);
  const barMaxRows = Math.max(1, Math.round(barNum('maxRows', 5)));
  /** 动作排（手动把玩）的排版参数。随 `BarView` 下发，渲染层不写死这两条 —— 见 ipc.ts。 */
  const barActionRowHeight = Math.max(1, barNum('actionRowHeight', 30));
  const barActionColumns = Math.max(1, Math.round(barNum('actionColumns', 5)));

  let bar: ControlBar | null = null;
  let barState: BarState = BAR_HIDDEN;
  /**
   * 原生菜单是否正开着（面板的「⋯」）。
   *
   * 为什么需要这个位（2026-09-17，ADR 016）：Windows 的原生菜单会**夺走弹出它的那个窗口
   * 的焦点**。若不屏蔽，菜单刚弹出来面板就吃到一次 `blur` → `blurHideMs` 后自己收起
   * （菜单随之消失）—— 表现就是"⋯ 点了没反应"，而且只有真手点才复现。
   * 菜单关闭时再按当时的真实焦点补一次记账（见下方 closeBarMenu）。
   */
  let barMenuOpen = false;

  try {
    bar = createControlBar({
      htmlPath: join(__dirname, '..', 'renderer', 'control-bar.html'),
      preloadPath: join(__dirname, 'bar-preload.js'),
      width: barWidth,
      headerHeight: barNum('headerHeight', 30),
      rowHeight: barNum('rowHeight', 28),
      footerHeight: barNum('footerHeight', 42),
      actionRowHeight: barActionRowHeight,
      actionColumns: barActionColumns,
      maxRows: barMaxRows,
      gapBelowPet: barNum('gapBelowPet', 8),
      gapAbovePet: barNum('gapAbovePet', 10),
      // 翻到宠物上方时让开气泡，否则面板会正好盖住它（气泡 32 高 + 6 间距）
      reservedAbove: () => (bubble?.isVisible() ? 38 : 0),
      onFocusChange: (hasFocus) => {
        if (barMenuOpen) return;             // 菜单开着时的失焦不算"用户点到别处"（见上）
        dispatchBar({ kind: 'focus', hasFocus });
      },
    });
    bar.followPet(overlay.browserWindow.getContentBounds());
    console.log(`[pet] 控制条已创建（宽 ${barWidth}，可聚焦）—— 唤出：右键宠物 / 托盘菜单「控制条」；`
      + `失焦 ${barPolicy.blurHideMs}ms 后收起`);
  } catch (e) {
    console.error('[pet] 控制条创建失败（宠物本体不受影响）：' + String(e));
  }
  bootMark('控制条已创建');

  /** 控制条视图：状态全部现读，面板自己不持有一份（延续 ADR 010 的唯一真值约定）。 */
  function barView(): BarView {
    const s = arbiter.state;
    return {
      status: s.status,
      statusLabels: STATUS_TEXT,
      sessions: arbiter.viewSessions(),
      maxRows: barMaxRows,
      petName: pack.manifest.displayName ?? pack.manifest.id,
      petVisible: overlay.isVisible(),
      // 动作排：清单来自 sidecar，`active` 由主进程的真相（`manualPlay`）给出 ——
      // 渲染层不自己记"我点过哪个"，否则面板收起再打开就会显示错的高亮。
      actions: manualPolicy.actions.map((a) => ({
        state: a.state,
        label: a.label,
        active: manualPlay?.state === a.state,
      })),
      actionColumns: barActionColumns,
      actionRowHeight: barActionRowHeight,
      rev: s.rev,
    };
  }

  /**
   * 把状态机的判定落到实际窗口上。调用方只需保证 `barState` 已更新。
   *
   * 显示一律**抢焦点**（`focus: true`）：两条唤出路径（右键宠物 / 托盘菜单项）
   * 都是用户明确表达"我要看它"的动作，而悬停那条"可能正在打字"的路径已经不存在了
   * （ADR 016）。抢焦点换来的是"点到别处即关"与 Esc 可收 —— 面板因此像一个真窗口。
   */
  function syncBar(): void {
    if (!bar) return;
    if (barState.visible) {
      if (!bar.isVisible()) {
        bar.show(barView(), { focus: true });
        console.log('[pet] 控制条显示（唤出即抢焦点；Esc 或点到别处可收）');
      } else {
        bar.update(barView());
      }
    } else if (bar.isVisible()) {
      bar.hide();
      console.log('[pet] 控制条收起');
    }
  }

  /** 喂一个事件给显示状态机（策略是纯函数，见 kernel/bar-policy.ts）。 */
  function dispatchBar(ev: BarEvent): void {
    if (!bar) return;
    barState = nextBarState(barState, ev, barPolicy, Date.now());
    syncBar();
  }

  /**
   * 宠物消失（托盘隐藏 / 右键隐藏 / 全屏让位）时把控制条一起收掉。
   * 走的是 `pet-hidden` 事件而不是直接 `bar.hide()`：状态机那条规则同时把"计划收起"
   * 与焦点记账一起清掉，免得留下一份与窗口对不上的账。
   */
  function hideBar(reason: string): void {
    if (!bar) return;
    const wasOn = barState.visible || bar.isVisible();
    dispatchBar({ kind: 'pet-hidden' });
    if (wasOn) console.log(`[pet] 控制条跟随隐藏（${reason}）`);
  }

  /** 宠物右键与托盘菜单「控制条」的共同入口。 */
  function toggleBar(): void {
    if (!bar) return;
    if (!overlay.isVisible()) {
      // 控制条锚定宠物，宠物不在就不能悬在半空。先叫回宠物 —— 否则用户按了快捷键
      // 什么都不会发生，只会以为程序坏了（设计 §7 明确定的行为）。
      resumePet();
      refreshBubble(true);
      refreshMenu();
      console.log('[pet] 控制条：宠物原本是隐藏的，先恢复宠物再唤出');
    }
    dispatchBar({ kind: 'toggle' });
  }

  /** 状态变化后刷新面板内容（未显示时什么都不做）。 */
  function refreshBar(): void {
    if (!bar || !barState.visible) return;
    bar.update(barView());
  }

  /**
   * 时间推进：把状态机的"到点收起"落到窗口上，每 16ms 由光标轮询顺带调用。
   *
   * 为什么挂在这里而不是另开定时器：`hideAt` 到期时用户的光标往往已经静止
   * （甚至已经去干别的了），这一刻**只剩这个轮询还在转**。不可见时它是恒等的，零开销。
   */
  function tickBar(): void {
    if (!bar) return;
    const before = barState;
    barState = tickBarState(barState, Date.now());
    if (barState !== before) syncBar();
  }

  // —— 控制条命令：白名单查表执行 ——
  // 渲染层拿不到动作表、也传不了任意参数（`ack-session` 的 arg 还会再校验"会话真的存在"）。
  // M3 只要在这里加一个 `agent-send`，通道形状与窗口层都不用动。
  const barCommandHandlers: Record<BarCommandId, (arg?: string) => void> = {
    'hide-pet'() {
      if (overlay.isVisible()) actions.toggleVisibility();
    },
    'ack-session'(arg) {
      // 白名单：会话必须真的在面板上。（过期的 `ready` 已被视图过滤 ⇒ 单行 ack 会被拒，
      // 但那一行本来就不给按钮、也不需要被确认；「全部已确认」走的是不带参的 `ack()`。）
      if (!arg || !arbiter.viewSessions().some((s) => s.sessionId === arg)) {
        console.warn(`[pet] 控制条请求确认不存在的会话：${arg ?? '(空)'}（已忽略）`);
        return;
      }
      if (arbiter.ack(arg)) pushStatus();
      else refreshBar();
    },
    /**
     * 「全部已确认」：一次清掉所有在等用户处理的会话（`needs-input` + 未过期的 `ready`）。
     *
     * 与"单击宠物"走**同一条**内核路径（`arbiter.ack()` 不带参），因此不需要新机制、
     * 也不会两处各写一份"什么算待确认"的判断。`ack()` 返回 true 表示仲裁输出变了
     * （宠物换了动作）就需要推状态；没变也要刷新面板，否则按钮点了没反馈。
     */
    'ack-all'() {
      if (arbiter.ack()) {
        pushStatus();
        console.log('[pet] 控制条：全部会话已确认');
      } else {
        refreshBar();
      }
    },
    /**
     * 手动把玩：让宠物演一次这个动作（2026-09-22，ADR 038）。
     *
     * 白名单校验与 `ack-session` 同形：`arg` 必须是**宠物包里真实存在的动作**。
     * 同一个动作再发一次 = 立刻停止（渲染层不记状态，高亮由主进程的 `manualPlay` 决定）。
     *
     * 这里**不碰仲裁器**：手动把玩不是业务状态，宠物演完就自动交回（见 `endManualPlay`）。
     */
    'play-action'(arg) {
      const action = arg ? manualActionByState.get(arg) : undefined;
      if (!action) {
        console.warn(`[pet] 控制条请求播放不存在的动作：${arg ?? '(空)'}（已忽略）`);
        return;
      }
      if (manualPlay && manualPlay.state === action.state) {
        endManualPlay('再点一次同一个按钮');
        return;
      }
      startManualPlay(action);
    },
    'popup-menu'() {
      if (!bar) return;
      // 弹的是**同一份**原生菜单（含"退出"），所以面板里不必再实现一遍退出按钮，
      // 也就不会因为多一个"退出"而增加误点风险（D4 的取舍）。
      //
      // `barMenuOpen` 见它的声明处：原生菜单会夺走面板的焦点，若不屏蔽，
      // 面板会在菜单弹出的同一瞬间吃到 blur，`blurHideMs` 后连菜单一起消失。
      // 菜单关闭时按**当时的真实焦点**补一次记账，避免"菜单关了但面板以为永远失焦"。
      barMenuOpen = true;
      const menu = Menu.buildFromTemplate(buildPetMenuTemplate(petMenuView(), actions));
      menu.popup({
        window: bar.browserWindow,
        callback: () => {
          barMenuOpen = false;
          if (!bar) return;
          const focused = bar.browserWindow.isFocused();
          dispatchBar({ kind: 'focus', hasFocus: focused });
        },
      });
    },
    'close-bar'() { dispatchBar({ kind: 'request-close' }); },
  };

  ipcMain.on(CH.barCommand, (_e, cmd: BarCommand) => {
    const handler = cmd ? barCommandHandlers[cmd.id] : undefined;
    if (!handler) {
      // 未知 id 一律忽略并记日志：这是安全边界。静默丢弃比抛异常好，但必须留痕。
      console.warn('[pet] 控制条发来未知命令，已忽略：' + JSON.stringify(cmd));
      return;
    }
    handler(cmd.arg);
  });

  // —— 行为层：漫游 / 微动作 / 打盹（M3 第一块，ADR 018）——
  //
  // 分工与状态层一致：**规则全在纯函数里**（`kernel/behavior.ts`，时钟与随机数可注入、有单测），
  // 这里只做三件事：攒输入 → 调 tick → 把命令落到窗口与 IPC 上。
  // 为什么值得这么拆：这套规则全是"到点才发生"的（25 秒还是 28 秒后开始走，屏幕上完全看不出对错），
  // 而它偏偏又是最容易把宠物弄坏的一块 —— 与用户拖动抢方向盘、走出工作区、走的时候点不动。
  const behaviorMeta = (pack.runtime as unknown as Record<string, unknown>)['behavior'];
  const behaviorPolicyRaw = parseBehaviorPolicy(
    behaviorMeta, pack, (m) => console.warn('[pet][behavior] ' + m),
  );
  /**
   * `--no-behavior`：关掉自主行为层。**这是给探针与排查用的接缝**（与 `--no-status-source` 同一套路）——
   * 宠物会自己走动，位置类断言（命中图、控制条贴边、托盘点击坐标）全都会因此变脆：
   * 探针读一次窗口位置、再按它算点击坐标，中间宠物走掉了就会点空。
   * 行为层自己的判据在 `spikes/m3-behavior`（那边当然不能带这个开关）。
   */
  const behaviorOff = process.argv.includes('--no-behavior');
  const behaviorPolicy: BehaviorPolicy = behaviorOff
    ? { ...behaviorPolicyRaw, enabled: false }
    : behaviorPolicyRaw;
  if (behaviorOff) console.warn('[pet] 行为层已由 --no-behavior 关闭（探针/排查用）');
  let behaviorState: BehaviorState = BEHAVIOR_IDLE;
  /** 渲染层上报的系统「减少动态效果」。主进程读不到这个偏好，只能由渲染层报到时带上。 */
  let rendererReducedMotion = false;
  /** 用户正抓着宠物（渲染层上报的拖动边沿）。行为层据此停手。 */
  let draggingPet = false;
  /** 全屏让位导致宠物当前是隐藏的（与"用户手动隐藏"分开记：全屏退出时要恢复显示）。 */
  let fullscreenHidden = false;
  /** 诊断计数：探针与排查用（"它到底动没动过"）。 */
  let behaviorTicks = 0;
  let behaviorMoves = 0;

  /** 这一 tick 允不允许宠物自己动。四个理由都是"现在不该动"。 */
  function behaviorSuppressed(): boolean {
    return draggingPet                       // 用户抓着它 —— 绝不与人的手抢方向盘
      || !overlay.isVisible()                // 宠物本身不在（用户隐藏 / 全屏让位）
      || fullscreenHidden                    // 兜底：让位期间即使窗口还没隐藏也不动
      || barState.visible                    // 面板开着：它锚在宠物身上，动了会一起飘
      || manualPlay !== null;                // 手动把玩中：它刚被用户点过，没有"自己找乐子"的余地
  }

  /** 把命令真正落到窗口与 IPC 上。命令的语义全在 kernel 侧，这里不做二次判断。 */
  function applyStageCommand(cmd: BehaviorCommand, channel: string): void {
    // `play` 是三态：缺省 = 不变（不发消息）、null = 交回仲裁器、对象 = 按它演。
    if (cmd.play !== undefined) {
      const o = cmd.play;
      if (!overlay.browserWindow.isDestroyed()) {
        overlay.browserWindow.webContents.send(CH.behavior, o);
      }
      console.log(`[pet][${channel}] 动画覆盖 → `
        + (o ? `${o.state}${o.loop ? '（循环）' : '（一次性）'}` : '交回仲裁器'));
    }
    if (cmd.moveX !== null) {
      const b = overlay.browserWindow.getContentBounds();
      if (cmd.moveX !== b.x) {
        overlay.moveTo(cmd.moveX, b.y);
        behaviorMoves += 1;
        const moved = overlay.browserWindow.getContentBounds();
        // 窗口动了，三件东西必须跟着走：光标→客户区的映射（命中判定靠它）、气泡、控制条。
        pushPointerHint();
        bubble?.followPet(moved);
        bar?.followPet(moved);
      }
    }
  }

  /**
   * 行为层的命令入口。**手动把玩期间一律丢弃**（2026-09-22，ADR 038）。
   *
   * 为什么非挡不可：面板打开时行为层本来就处于抑制态（`behaviorSuppressed` 含
   * `barState.visible`），它每 tick 都会在边沿下发一次"交回仲裁器" ——
   * 不挡的话，用户在面板上点的那个动作会被每秒冲掉 30 次，表现为"点了没反应"。
   *
   * 注意**行为层本身照旧每 tick 推进**（见 `tickBehaviorLayer`）：它在抑制态会把自己的
   * `sentPlay` 清成 null，这一步不能省 —— 省了的话把玩结束后它仍记着"我正在走"，
   * 窗口会移动而腿停在待机姿态（滑着走），而屏幕上只表现为"它怎么飘着"。
   */
  function applyBehaviorCommand(cmd: BehaviorCommand): void {
    if (manualPlay) return;
    applyStageCommand(cmd, 'behavior');
  }

  /**
   * 开始一次手动把玩（面板动作排上的按钮）。
   *
   * 三件事：算好位移目标（`beginManualPlay` 里，纯函数）、下发第一条覆盖命令、
   * 把这次点击当作"用户碰了它"（醒来 + 重排自主行为的计时，与单击宠物同一语义）。
   */
  function startManualPlay(action: ManualAction): void {
    const pet = overlay.browserWindow.getContentBounds();
    const res = beginManualPlay(
      action, manualPolicy, Date.now(), pet, workAreaOf(pet),
      // 位移速度取**与自主漫游同一个函数**（按缩放归一化）：两处取不同值会有一处滑步。
      // `--no-behavior` 时行为层只是 enabled=false，速度参数仍在，所以手动走路照常可用。
      roamSpeedPxPerSec(behaviorPolicy, currentScale),
      Math.random,
    );
    manualPlay = res.play;
    applyStageCommand(res.command, 'manual');
    wakePet(`手动把玩 ${action.label}`);
    refreshBar();                            // 高亮当前动作
    console.log(`[pet][manual] 开始「${action.label}」（${action.state}`
      + (res.play.targetX === null ? '，原地' : `，走 ${action.facing === 'left' ? '左' : '右'} → x=${res.play.targetX}`)
      + `），最多演 ${Math.round((res.play.until - Date.now()) / 100) / 10}s`);
  }

  /**
   * 结束手动把玩，把舞台交回仲裁器。
   *
   * **必须显式发一次 `play: null`**：覆盖是渲染层的一个变量，没人撤销它就永远停在那里 ——
   * 此刻行为层的 `sentPlay` 已经是 null（抑制期间清的），它不会替我们撤销。
   *
   * @param releaseSent 这一 tick 的 `tickManualPlay` 已经下发过"交回仲裁器"（走 33ms tick
   *   结束时传 true）—— 避免同一毫秒连发两条。多余的那条只多一行日志，
   *   但这个项目的日志是取证手段，不该自己污染自己。
   */
  function endManualPlay(reason: string, releaseSent = false): void {
    if (!manualPlay) return;
    const { state, targetX } = manualPlay;
    manualPlay = null;
    if (!releaseSent) {
      applyStageCommand({ play: null, moveX: targetX === null ? null : Math.round(targetX) }, 'manual');
    }
    refreshBar();                            // 清掉高亮
    console.log(`[pet][manual] 结束（${reason}）：${state} → 交回仲裁器`);
  }

  /**
   * 行为层 tick，33ms（≈30Hz）。
   *
   * 为什么不并进 16ms 的光标轮询：窗口移动不需要 60Hz（拖动那条路径是"手在动"才发增量），
   * 30Hz 已经足够顺；而且**分开跑就不会让"光标静止时轮询短路"顺带把行为层也冻住**。
   *
   * 手动把玩挂在这条 tick 上推进（而不是另开定时器）：两者是同一件事的两个优先级，
   * 而且这样**天然继承了定时器的生命周期纪律** —— 宠物隐藏时这条 tick 会一起停
   * （此时面板也必然已收起，不存在"宠物藏着、把玩还在走"）。
   */
  function tickBehaviorLayer(): void {
    behaviorTicks += 1;
    const pet = overlay.browserWindow.getContentBounds();
    const area = screen.getDisplayNearestPoint({
      x: Math.round(pet.x + pet.width / 2),
      y: Math.round(pet.y + pet.height / 2),
    }).workArea;
    const now = Date.now();
    const result = tickBehavior(behaviorState, {
      now,
      pet,
      workArea: area,
      scale: currentScale,
      status: arbiter.state.status,
      suppressed: behaviorSuppressed(),
      reducedMotion: rendererReducedMotion,
    }, behaviorPolicy, Math.random);
    behaviorState = result.state;
    applyBehaviorCommand(result.command);     // 手动把玩期间它自己会被丢弃（见那里的守卫）

    // —— 手动把玩：优先级最高，最后落地 ——
    // 放在行为层**之后**：这一 tick 行为层的记账已经推完（抑制态下它会清掉自己的 sentPlay），
    // 所以把玩结束时不会留下"它以为自己在走"的账。顺序反了就会出现滑步。
    if (!manualPlay) return;
    const mp = tickManualPlay(manualPlay, now, pet, roamSpeedPxPerSec(behaviorPolicy, currentScale));
    // ⚠️ 这里**不能**先写 `manualPlay = mp.play` 再调 `endManualPlay`：结束那一 tick
    // `mp.play` 是 null，先赋值会让 `endManualPlay` 开头的 `if (!manualPlay) return` 直接返回 ——
    // 于是它内部的 `refreshBar()` 不执行、**面板上的高亮永远不会清掉**（按钮一直亮着），
    // 日志里也看不到"结束"那行。2026-09-22 由探针报告的 `endLogged=false` 抓到。
    // `endManualPlay` 需要读 `manualPlay.state/targetX` 做记账与收尾定位，所以顺序必须是：
    // **先落地这一 tick 的命令 → 再交给它去清状态**。
    if (mp.play === null) {
      applyStageCommand(mp.command, 'manual');   // 这条命令本身就带 `play: null`（交回仲裁器）
      endManualPlay('到点／走到位', true);
      return;
    }
    manualPlay = mp.play;
    applyStageCommand(mp.command, 'manual');
  }

  /** 用户碰了宠物（单击 / 拖动）→ 从打盹里醒来并重新排程。 */
  function wakePet(reason: string): void {
    if (behaviorState.phase === 'sleeping') console.log(`[pet][behavior] 醒来（${reason}）`);
    behaviorState = wakeBehavior(behaviorState, behaviorPolicy, Date.now(), Math.random);
  }

  console.log('[pet] 行为层：'
    + (behaviorPolicy.enabled ? '启用' : '停用（behavior.enabled=false）')
    + `，漫游 ${behaviorPolicy.roamEnabled ? '开' : '关'}`
    + `（每 ${behaviorPolicy.roamEveryMs.min / 1000}–${behaviorPolicy.roamEveryMs.max / 1000}s 走 `
    + `${behaviorPolicy.roamDistancePx.min}–${behaviorPolicy.roamDistancePx.max}px，`
    + `${behaviorPolicy.speedPxPerSec}px/s @缩放1.0）`
    + `，微动作 ${behaviorPolicy.microEnabled ? behaviorPolicy.microCandidates.join('/') : '关'}`
    + `，任务中踱步 ${behaviorPolicy.paceEnabled ? `开（每 ${behaviorPolicy.paceEveryMs.min / 1000}–${behaviorPolicy.paceEveryMs.max / 1000}s 走 ${behaviorPolicy.paceDistancePx.min}–${behaviorPolicy.paceDistancePx.max}px，锚在进入任务状态时的位置附近）` : '关'}`
    + `，打盹 ${behaviorPolicy.sleepAfterMs / 1000}s → ${behaviorPolicy.sleepState}`
    + `｜位移姿态 ${behaviorPolicy.locomotion ? `${behaviorPolicy.locomotion.left}/${behaviorPolicy.locomotion.right}` : '缺失（不漫游）'}`);

  // —— 状态源与时间推进：**必须等所有窗口都建好之后再启动** ——
  // 为什么拖到这里（2026-09-17 审计发现的结构性隐患）：`statusSource.start()` 会**同步**读一次
  // 状态文件并可能立刻 `pushStatus()` → `afterStatusPush()` → `refreshBar()`，而 `refreshBar`
  // 读的是用 `let` 声明的 `bar`。今天不崩只是因为 boot 全程同步、异步事件插不进来 ——
  // 顺序一改（或在中间插入任何 `await`）就会踩到 `let` 的 TDZ，**启动即崩**。
  // 把"启动异步子系统"放在"所有窗口创建完毕"之后，这个依赖就从"靠隐式保证"变成"结构上不可能"。
  if (statusSource) {
    statusSource.start((e: StatusEvent) => {
      recordEvent(e);
      if (arbiter.ingest(e)) pushStatus();
    });
  }

  // **进程级**定时器：只在**退出**时清理，宠物隐藏期间照常跑。
  //
  // 它跟下面那组（33ms 行为层 / 16ms 光标轮询，跟着窗口 show/hide 启停）不是一回事 ——
  // 250ms 这条推进仲裁器的粘滞超时与静默兜底，600ms 那条盯着全屏让位，
  // 宠物藏起来不用画东西，但托盘那行"需要输入"仍然必须如实变化（ADR 023）。
  //
  // 正因为它们不被 `stopTimers()` 管，**退出时若不显式清掉，就会在窗口销毁之后
  // 再来一两次 tick** —— 那一 tick 打在已销毁的 `webContents` 上就是
  // `TypeError: Object has been destroyed`，Electron 会弹默认错误框给用户
  // （2026-09-22 用户在便携版点「退出宠物」时看到的那个，ADR 035）。
  //
  // **教训：定时器的生命周期必须和它要碰的对象的生命周期对齐。** 否则就会出现
  // "对象已经死了、定时器还在撞它"，而且只在退出这种一次性路径上暴露。
  // 这里统一登记 dispose，**回头新加定时器时记得也登记进来**。
  const processTimerDisposers: Array<() => void> = [];
  function stopProcessTimers(): void {
    // splice(0) 保证幂等：quit() 与 will-quit 都会来，第二次进来是空数组
    for (const dispose of processTimerDisposers.splice(0)) {
      try { dispose(); } catch { /* 已在退出途中，不必再抛 */ }
    }
  }

  // 仲裁器需要"时间推进"才能处理粘滞超时、会话静默过期，以及被限流挡下的那次切换。
  // 气泡的到期检查顺带挂在这里（它也是"到点就该收"的语义，没必要另开一个定时器）。
  const arbiterTimer = setInterval(() => {
    if (arbiter.tick()) pushStatus();
    expireBubble();
  }, 250);
  processTimerDisposers.push(() => clearInterval(arbiterTimer));

  /**
   * 两个高频定时器的启停（33ms 行为层 + 16ms 光标轮询）。
   *
   * 为什么要有它：宠物隐藏（用户手动隐藏 / 全屏让位）期间，既没有光标要跟随、
   * 也没有动作要走，这两个定时器却照常每 16/33 毫秒醒来一次 —— 纯粹白烧 CPU
   * （挂机时宠物常常一藏就是几小时）。**250ms 那条刻意不停**：它推进仲裁器的
   * 粘滞超时与静默兜底，也是气泡到期与托盘状态行的时间来源 —— 藏起来的宠物
   * 不再画东西，但托盘那行"需要输入"仍然必须如实变化。
   *
   * 为什么挂在窗口的 show/hide **事件**上而不是在各处手动配对：`hide()` 有三条路径
   * （托盘菜单 / 宠物右键 / 全屏让位），手动配对迟早会漏一条，而漏掉的那条只表现为
   * "恢复之后宠物不动了"，没有任何报错可循。
   * 另外**不要用 `isVisible()` 判断要不要启停** —— `show()` 之后同一 tick 内它仍可能
   * 返回 false（ADR 014 负面结论 1，本文件 `syncBar` 那处已因此修过一次）。
   */
  const timers: { behavior: NodeJS.Timeout | null; pointer: NodeJS.Timeout | null } = {
    behavior: null, pointer: null,
  };
  function startTimers(): void {
    if (timers.behavior || timers.pointer) return;      // 幂等：`show` 事件会重复来
    timers.behavior = setInterval(tickBehaviorLayer, 33);
    timers.pointer = setInterval(pollPointer, 16);
  }
  function stopTimers(): void {
    if (timers.behavior) { clearInterval(timers.behavior); timers.behavior = null; }
    if (timers.pointer) { clearInterval(timers.pointer); timers.pointer = null; }
  }

  // 行为层的时间推进（漫游到点、微动作播完、打盹计时都靠它）。**放在这里才安全**：
  // 上面那条 TDZ 教训同样适用于它 —— 它要读 `barState` / `arbiter` / `overlay`，
  // 必须等所有窗口与状态层都装配完再启动。
  // 光标轮询（16ms）也在这里一起起：它俩同时起、同时停，见 `startTimers` 的注释。
  startTimers();
  // 首次显示要显式起一次：`show` 事件只在**之后**的隐藏/恢复往返里才来。
  overlay.browserWindow.on('show', startTimers);
  overlay.browserWindow.on('hide', stopTimers);

  refreshMenu();

  // 探针用接缝：`--expose-actions` 时把动作表与若干只读探针挂到 globalThis，便于自动化验证
  // "隐藏→显示→仍可点击/拖动""改缩放后尺寸正确""自启回读正确""退出真的退出""气泡按策略显示"。
  if (process.argv.includes('--expose-actions')) {
    const g = globalThis as unknown as { __petActions?: unknown; __petDebug?: unknown };
    g.__petActions = actions;
    g.__petDebug = {
      bubbleState: () => bubbleState,
      bubbleVisible: () => bubble?.isVisible() ?? false,
      petBounds: () => overlay.browserWindow.getContentBounds(),
      /** 渲染层最近上报的命中状态。探针用它验证"光标远离宠物时必须为 false"。 */
      petInteractive: () => lastInteractive,
      // —— M2 ④ 控制条（探针用）——
      barState: () => barState,
      barVisible: () => bar?.isVisible() ?? false,
      barBounds: () => bar?.bounds() ?? null,
      barToggle: () => toggleBar(),
      barPolicy: () => barPolicy,
      /** 菜单视图（含 `sessionCount`）：探针用它验「清空状态会话」后计数归零。 */
      menuView: () => petMenuView(),
      /** 面板该显示谁的名字（探针用它验"面板显示宠物名，而不是缩放百分比"）。 */
      petName: () => pack.manifest.displayName ?? pack.manifest.id,
      // —— M3 行为层（探针用）——
      behaviorState: () => behaviorState,
      behaviorPolicy: () => behaviorPolicy,
      behaviorTicks: () => behaviorTicks,
      /** 两个高频定时器（33ms 行为层 / 16ms 光标轮询）当前是否在跑。隐藏时应为 false。 */
      timersRunning: () => Boolean(timers.behavior || timers.pointer),
      behaviorMoves: () => behaviorMoves,
      behaviorSuppressed: () => behaviorSuppressed(),
      draggingPet: () => draggingPet,
      // —— 手动把玩（探针用）——
      /** 正在把玩的那一个（null = 没有）。探针靠它验"点了动作→真的在演→到点自动交回"。 */
      manualPlay: () => manualPlay,
      /** sidecar 解析出来的动作清单（面板上应该有几个按钮、文字是什么）。 */
      manualActions: () => manualPolicy.actions,
      manualPolicy: () => manualPolicy,
    };
    console.log('[pet] --expose-actions：动作表与只读探针已挂到 globalThis（仅供探针）');
  }

  app.on('will-quit', () => {
    // 与 quit() 同一套清理：这条路径也会被 `app.quit()` 其它调用点触发
    // （自检截图那个分支、`window-all-closed`），它们不经过上面的菜单动作。
    stopTimers();
    stopProcessTimers();
    void statusSource?.stop();
    bubble?.destroy();
    bar?.destroy();
  });

  ipcMain.on(CH.ready, (_e, info?: ReadyInfo) => {
    // 页面重载后渲染层会再次报到：payload 复用缓存，自检只跑一次
    payload ??= buildPayload();
    // 「减少动态效果」只有渲染层读得到（matchMedia），行为层要靠它决定要不要漫游。
    if (info && typeof info.reducedMotion === 'boolean') rendererReducedMotion = info.reducedMotion;
    // 新页面从"整窗穿透"起步，并立刻**强制**重报一次命中状态（见 ADR 009）
    overlay.resetToIgnore();
    overlay.browserWindow.webContents.send(CH.init, payload);
    pushPointerHint(true);
    // 同样地，新页面必须重新拿到当前状态：否则每次全屏让位恢复（会 reload 渲染层）
    // 之后宠物都静默回到 idle，而仲裁器还以为自己在 running。replay 标记让渲染层
    // 落到静止落点，不重播一次性动作。
    pushStatus(true);
    // 行为层的覆盖也要补推：新页面的 `behaviorOverride` 是 null，而主进程侧
    // `sentPlay` 仍记着"正在漫游" —— 不补这一句，全屏让位恢复后宠物会**滑着走**
    // （窗口在动、腿却停在待机姿态）。（与 pushStatus(true) 同一个模式。）
    // **手动把玩优先**：正在把玩时补推给它的（行为层此刻的 sentPlay 已被抑制清空）。
    overlay.browserWindow.webContents.send(
      CH.behavior,
      manualPlay ? { state: manualPlay.state, loop: manualPlay.loop } : behaviorState.sentPlay,
    );
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
    // 控制条的"到点收起"靠这个 16ms 的轮询推进（没有悬停路径了，但"到点收起"仍然需要
    // 一个调度源；见 tickBar 的注释）。放在最前面：它不该受"宠物窗口是否可见"影响。
    tickBar();
    const win = overlay.browserWindow;
    if (win.isDestroyed() || !win.isVisible()) return;
    const cp = screen.getCursorScreenPoint();
    // 命中判定只在光标真移动时才有新信息可报（渲染层每帧都会用它复评命中，
    // 见 renderer.ts 的 tick），所以这里按位置变化去抖。
    if (!lastCursor || cp.x !== lastCursor.x || cp.y !== lastCursor.y) {
      lastCursor = { x: cp.x, y: cp.y };
      pushPointerHint();
    }
  }
  // 由 `startTimers()` 统一启动（宠物隐藏时一起停掉）—— 见它那处注释。
  //
  // 停掉它会不会让控制条的"到点收起"卡住（`tickBar` 挂在它最前面）？不会：
  // 三条隐藏路径（托盘 / 宠物右键 / 全屏让位）都先调 `hideBar()`，面板在宠物隐藏之前
  // 就已经收了，不存在"宠物藏着、面板还开着"的状态。

  // ═══ ⑩ 拖动：渲染层只上报增量，窗口移动由宿主完成 ═══
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
    // 气泡贴在宠物上方、控制条贴在下方，宠物动了它们都得跟着
    // （否则拖动时气泡与控制条会留在原地）
    const petBounds = overlay.browserWindow.getContentBounds();
    bubble?.followPet(petBounds);
    bar?.followPet(petBounds);
  });

  // 拖动的**边沿**（开始/结束）。行为层靠它停手 —— 只看"有没有拖动增量"是不行的：
  // 用户抓着不放、手停一下是常态，那种猜法会让宠物在他手里自己走起来（ADR 018）。
  ipcMain.on(CH.dragState, (_e, state: DragState) => {
    const on = Boolean(state?.dragging);
    if (on === draggingPet) return;
    draggingPet = on;
    console.log(`[pet][behavior] 用户${on ? '抓住' : '松开'}宠物 → 自主行为${on ? '暂停' : '恢复'}`);
    if (on) wakePet('用户抓住它');
  });

  ipcMain.on(CH.log, (_e, message: string) => console.log('[pet][renderer] ' + message));

  /**
   * 宠物上右键 → **唤出/收起控制条**（2026-09-17 起，ADR 016）。
   *
   * 为什么不再直接弹原生菜单：右键宠物与右键托盘要做两件不一样的事 ——
   *   宠物右键 = 打开控制条（状态仪表盘 + 确认 + 快捷动作）；
   *   托盘右键 = 打开完整菜单（缩放 / 自启 / 退出 / 清空会话）。
   * 而"完整菜单"在面板里还有一个入口（「⋯」），所以两条路径都能到达全部动作，
   * 冗余却没有互相遮挡（此前面板、宠物右键、托盘三处弹同一份菜单，用户判断"没必要这么复杂"）。
   *
   * 触发点必须在渲染层：窗口常态整窗穿透、命中与否由渲染层的 alpha 采样决定（ADR 008），
   * 只有它知道这一下右键落在精灵轮廓上还是一片空白。
   */
  ipcMain.on(CH.contextMenu, () => {
    toggleBar();
  });

  // —— 用户确认：解除 needs-input 粘滞 ——
  // 单击宠物即"我看到了"。不这样做的话，用户即使已经在终端里回答了问题，
  // 宠物还会举着手等到粘滞超时（默认 5 分钟），看起来像坏了。
  // 同时**唤醒**：打盹是"没人理它"的表现，被摸一下当然要醒，并重新开始计时（ADR 018）。
  ipcMain.on(CH.ack, () => {
    wakePet('用户单击');
    if (arbiter.ack()) pushStatus();
  });

  // —— 全屏让位：命中即隐藏，退出后恢复 ——
  if (!detectFullscreen().available) {
    console.warn('[pet] 全屏检测不可用：' + (fullscreenUnavailableReason() ?? '未知原因') + '（宠物将不会自动让位）');
  }
  const stopFullscreenWatch = startFullscreenWatch((status) => {
    // 守卫：这条回调可能在窗口已经销毁之后才被 tick 到（退出竞态）—— 见上面
    // `processTimerDisposers` 那段注释。有了上面的清理它已不该发生，但这里是最后一道防线：
    // 崩让用户看见，比什么都不做糟得多。
    if (overlay.browserWindow.isDestroyed()) return;
    fullscreenHidden = status.coversMonitor;
    if (status.coversMonitor) {
      overlay.hide();
      bubble?.hide();                     // 气泡是宠物的一部分，全屏让位时一起收
      hideBar('全屏让位');                 // 控制条同理：不能留在全屏应用上面
      console.log('[pet] 检测到全屏应用「' + status.fgTitle + '」，已让位隐藏');
    } else {
      overlay.show();
      // 关键：hide→show 之后 Windows 不再把真实鼠标按钮事件路由到这个窗口
      // （移动事件正常、坐标正确、样式位正确、SendMessage 能进），实测只有重新加载
      // 渲染层才能让 Chromium 重建输入通路。详见 host/overlay-window.ts 的 reload 注释。
      overlay.reload();
      refreshBubble(true);                // 气泡层不需要 reload（它从不接收按钮事件），贴回去即可
      // **控制条不自动恢复** —— 它是可聚焦窗口，全屏退出瞬间冒出一个面板很打扰；
      // 状态机里 pet-hidden 也一并撤销了悬停唤出资格（见 kernel/bar-policy.ts）。
      console.log('[pet] 全屏应用已退出，恢复显示（已重载渲染层以恢复输入通路）');
    }
    overlay.browserWindow.webContents.send(CH.fullscreen, { hidden: status.coversMonitor, fgTitle: status.fgTitle });
  }, 600);
  processTimerDisposers.push(stopFullscreenWatch);
  bootMark('boot() 返回（全屏监听已启动）');
}

app.whenReady().then(() => {
  bootMark('app ready（Electron 自身初始化完成）');
  // 一次性迁移：旧包遗留的自启条目（值名 electron.app.Electron）搬到新值名。
  // **必须在 boot() 之前** —— boot 里第一次读回菜单状态时，用户看来应当已经是迁移后的样子。
  // 幂等且只在旧条目指向本应用时才动手，见 autostart.ts 的注释。
  migrateLegacyAutoStart();
  boot();
}).catch((e) => {
  console.error('[pet] 启动失败：', e);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
