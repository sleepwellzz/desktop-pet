// 宠物内核的数据契约。本文件及 kernel/ 下所有模块**禁止 import electron**。

/** pet.json —— 严格保持 Codex/ChatGPT 原生格式，不得写入自研字段。 */
export interface PetManifest {
  id: string;
  displayName?: string;
  description?: string;
  spritesheetPath: string;
  spriteVersionNumber?: number;
}

/** behavior-map.json 的单个状态（行 → 状态 → 帧列）。 */
export interface BehaviorState {
  row: number;
  frames: number;
  frameColumns: number[];
  loop: boolean;
  bboxes?: (number[] | null)[];
  intent?: string;
}

export interface BehaviorMap {
  schema: string;
  /** 内嵌说明（契约允许，代码不读）。 */
  note?: string;
  pet: {
    id: string;
    displayName?: string;
    manifestPath: string;
    spritesheetPath: string;
    spriteVersionNumber?: number;
    cellSize: { width: number; height: number };
    grid: { columns: number; rows: number };
  };
  /**
   * 下面两段由图集探针（`tools/pet_sheet_probe.py --export-map`）写入，**运行时只做记录不读**。
   * 形状不由本文件声明 —— 唯一真源是那个脚本（同 `reducedMotion` / `actions` 的处理，见文末）。
   */
  rendererContract?: Record<string, unknown>;
  contentBounds?: Record<string, unknown>;
  semanticAliases?: Record<string, string>;
  states: Record<string, BehaviorState>;
}

/** desktop-pet.json 的单个状态（渲染与锚点参数）。 */
export interface RuntimeState {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  baselineY: number;
  offsetY: number;
  role?: string;
  fallbackState?: string;
  attention?: boolean;
  /** 触地点帧间抖动（px）—— 纯记录用途，校准锚点时要看它。 */
  bottomJitterPx?: number;
  /** 内嵌说明文字（契约允许，代码不读）。 */
  note?: string;
}

export interface RuntimeManifest {
  schema: string;
  /** 内嵌说明（契约允许，代码不读）。 */
  note?: string;
  pack: {
    id: string;
    displayName?: string;
    sourceManifest: string;
    behaviorMap: string;
    spritesheetPath: string;
    spriteVersionNumber?: number;
    imageSize: { width: number; height: number };
    cellSize: { width: number; height: number };
    grid: { columns: number; rows: number };
    totalFrames?: number;
    /** 图集实测记录（由 `pet_sheet_probe.py` 写入，纯文档用途）。 */
    verified?: Record<string, string>;
  };
  render: {
    defaultScale: number;
    scaleRange?: [number, number];
    scaleStep?: number;
    background: string;
    hitTest?: string;
    hitTestAlphaThreshold?: number;
    pixelSnap?: boolean;
    imageRendering?: string;
    zOrder?: string;
  };
  anchor: {
    mode: string;
    groundY: number;
    horizontal?: string;
    note?: string;
    horizontalNote?: string;
  };
  states: Record<string, RuntimeState>;
  statusMap?: Record<string, {
    state: string;
    then?: string;
    bubble?: string | null;
    priority?: number;
    attentionPulse?: boolean;
    stickyUntil?: string;
  }>;
  behavior?: {
    enabled?: boolean;
    layer?: string;
    note?: string;
    normalization?: string;
    idleRoam?: { enabled?: boolean; everySec?: [number, number]; distancePx?: [number, number]; speedPxPerSec?: number };
    idleMicroActions?: { enabled?: boolean; candidates?: string[]; everySec?: [number, number] };
    busyPace?: { enabled?: boolean; note?: string; everySec?: [number, number]; distancePx?: [number, number]; speedPxPerSec?: number };
    edgePolicy?: string;
    edgePolicyScope?: string;
    obstaclePolicy?: string;
    sleepAfterIdleSec?: number;
    sleepState?: string;
    sleepNote?: string;
  };
  /**
   * 状态层的到点收敛参数（`kernel/status.ts` 的仲裁器读它）。
   *
   * 这两条都是"某状态不该无限期占着画面"的落地，而它们**在屏幕上完全看不出对错**
   * （早 30 秒晚 30 秒都只表现为"它还摆着那副样子"）—— 所以必须可配、可单测。
   */
  statusTimeouts?: {
    /** `needs-input` 粘滞上限（ms），超过自动确认（默认 300000）。 */
    stickyMs?: number;
    /** `ready` 通报驻留上限（ms），超过按 idle 处理（默认 60000，ADR 021）。 */
    readyMs?: number;
    /**
     * 同一会话 `needs-input` **重新举手**的最小间隔（ms，默认 60000）。
     *
     * 迟滞窗口内的重报算"同一次求助的续报"，不动用户的确认位 ——
     * 挡住双通道交替（hook↔文件源）把确认反复冲掉那条路径（ADR 021 补充）。
     */
    reAskMinIntervalMs?: number;
    /** 会话静默兜底（ms），超过按 idle 处理（默认 900000）。 */
    sessionStaleMs?: number;
    /** 双通道逐出（ADR 027 / 030）：按通道优先级丢弃低优先级上报。 */
    dominance?: { enabled?: boolean; holdMs?: number; note?: string };
    note?: string;
    stickyNote?: string;
    readyNote?: string;
    reAskMinIntervalMsNote?: string;
    sessionStaleNote?: string;
  };
  interaction?: Record<string, unknown>;
  /**
   * 下面四段的**形状不由本文件声明** —— 它们各有一个专门的解析器
   * （`parseMotionPolicy` / `parseManualPlayPolicy`；气泡与控制条由渲染层按视图绘制），
   * 而解析器同时承担"值非法时怎么回落"的策略。
   *
   * 为什么写 `unknown` 而不是把形状抄一份：抄一份就是**两个出处**，
   * 迟早像"宠物名三份副本""版本号两处手写"那样漂开（ADR 040 / 041 的教训）。
   * **形状的唯一真源 = 解析器**；这里只需要"这个键属于契约"这个事实 ——
   * 有了它，`src/main/index.ts` 就不必再用 `as unknown as Record<string, unknown>` 绕开类型。
   */
  reducedMotion?: unknown;
  bubble?: unknown;
  controlBar?: unknown;
  extraAssets?: Record<string, unknown>;
  actions?: unknown;
}

/** 合并 behavior-map 与 desktop-pet.json 后，渲染层真正使用的状态定义。 */
export interface ResolvedState {
  id: string;
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  /** 单元格坐标下的绘制纵向偏移：使各状态触地点对齐 groundY。 */
  offsetY: number;
  frameColumns: number[];
  role?: string;
  fallbackState?: string;
}

export interface PetPack {
  /** 宠物包根目录（绝对路径）。 */
  dir: string;
  manifest: PetManifest;
  behavior: BehaviorMap;
  runtime: RuntimeManifest;
  /** 精灵图绝对路径（已做路径穿越校验）。 */
  sheetPath: string;
  sheetBytes: number;
  sheet: { width: number; height: number; format: 'webp' | 'png' };
  cell: { width: number; height: number };
  grid: { columns: number; rows: number };
  groundY: number;
  scale: number;
  states: Record<string, ResolvedState>;
  warnings: string[];
}

/** 播放器对外输出的当前帧。 */
export interface Frame {
  stateId: string;
  row: number;
  column: number;
  /** 单元格内纵向偏移（像素，未乘缩放）。 */
  offsetY: number;
  /** 该帧在本次播放中的序号。 */
  index: number;
}
