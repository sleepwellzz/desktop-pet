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
  pet: {
    id: string;
    displayName?: string;
    manifestPath: string;
    spritesheetPath: string;
    spriteVersionNumber?: number;
    cellSize: { width: number; height: number };
    grid: { columns: number; rows: number };
  };
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
}

export interface RuntimeManifest {
  schema: string;
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
  };
  render: {
    defaultScale: number;
    scaleRange?: [number, number];
    scaleStep?: number;
    background: string;
    hitTest?: string;
    hitTestAlphaThreshold?: number;
  };
  anchor: {
    mode: string;
    groundY: number;
    horizontal?: string;
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
    idleRoam?: { enabled?: boolean; everySec?: [number, number]; distancePx?: [number, number]; speedPxPerSec?: number };
    idleMicroActions?: { enabled?: boolean; candidates?: string[]; everySec?: [number, number] };
    sleepAfterIdleSec?: number;
    sleepState?: string;
  };
  interaction?: Record<string, unknown>;
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
