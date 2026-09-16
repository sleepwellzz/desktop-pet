// 主进程 ↔ 渲染层的 IPC 契约。通道名与载荷类型集中在此，避免两边各写一份。
import type { ArbiterState } from '../kernel/status';
import type { ResolvedState } from '../kernel/types';

export const CH = {
  init: 'pet:init',
  /** 渲染层 → 主进程：脚本已就绪，可以下发 init 了 */
  ready: 'pet:ready',
  fullscreen: 'pet:fullscreen',
  drag: 'pet:drag',
  log: 'pet:log',
  /**
   * 渲染层 → 主进程：当前光标是否落在宠物实体像素上。
   * 决定窗口是"可交互"还是"整窗穿透"——命中区域完全由渲染层的 alpha 采样定义，
   * 不再依赖 Windows 对分层窗口的逐像素命中测试（2026-09-15 实测该机制不生效，
   * 生效区域是整个窗口矩形，见 ADR 008）。
   */
  interactive: 'pet:interactive',
  /** 主进程 → 渲染层：光标在窗口客户区中的位置提示（DIP/CSS 像素），用于窗口移动后重新采样。 */
  pointerHint: 'pet:pointer-hint',
  /**
   * 主进程 → 渲染层：仲裁后的状态（全应用唯一真值）。
   * 仲裁跑在主进程：M2 之后的托盘提示、控制条、角标文案都在那一侧，让它们各算一份
   * 比多一次 IPC 更糟；渲染层由此退化成"只负责把状态画出来"的哑渲染层。
   */
  status: 'pet:status',
  /** 渲染层 → 主进程：用户确认（单击宠物）。解除 needs-input 粘滞，见 ADR 010。 */
  ack: 'pet:ack',
  /**
   * 渲染层 → 主进程：在宠物实体上按下了右键，请弹出宠物菜单。
   *
   * 触发点必须在渲染层：窗口常态整窗穿透、命中与否由渲染层的 alpha 采样决定（ADR 008），
   * 只有它知道这一下右键落在精灵轮廓上还是空白处。主进程只负责弹菜单，不判断命中。
   * 不带坐标：Electron 的 `popup()` 不传 x/y 即以当前光标位置弹出。
   */
  contextMenu: 'pet:context-menu',
} as const;

/** 主进程 → 渲染层：宠物包与渲染所需的全部信息。 */
export interface RendererInit {
  /** 精灵图的 data URL。用 data URL 而非 file://，避免污染 canvas 导致 getImageData 报安全错误。 */
  sheetDataUrl: string;
  cell: { width: number; height: number };
  grid: { columns: number; rows: number };
  scale: number;
  /**
   * 命中测试的 alpha 阈值（来自 desktop-pet.json → render.hitTestAlphaThreshold）。
   * 低于该值的像素一律视为空白：渲染层会把它清零，让系统的逐像素命中测试与人眼感知一致。
   */
  hitTestAlphaThreshold: number;
  states: Record<string, ResolvedState>;
  initialState: string;
  warnings: string[];
  petId: string;
  displayName: string;
}

/** 渲染层 → 主进程：拖动增量（DIP，与 Electron 窗口坐标同一坐标系）。 */
export interface DragDelta { dx: number; dy: number }

/** 渲染层 → 主进程：命中状态。interactive=false 时窗口整体穿透。 */
export interface HitState { interactive: boolean }

/** 主进程 → 渲染层：光标位置（窗口客户区 CSS 像素），窗口移动后用它重新采样。 */
export interface PointerHint {
  cssX: number;
  cssY: number;
  /**
   * 强制重新上报命中状态。用于窗口**重新显示之后**：隐藏/显示会把双方的记账错开
   * （实测 hide→showInactive 后鼠标按钮事件不再投递到渲染层），必须让渲染层
   * 无条件重报一次，不能因为"和上次一样"而跳过。见 ADR 009。
   */
  force?: boolean;
}

export interface FullscreenNotice { hidden: boolean; fgTitle: string }

/**
 * 主进程 → 渲染层：仲裁结果。字段直接取自 `StatusArbiter.state`。
 */
export interface StatusPush extends ArbiterState {
  /**
   * true = 这是渲染层**重载后**的补推，不是一次新的状态迁移。
   *
   * 为什么需要这个标记：全屏让位恢复时会 `reload()` 渲染层（ADR 009），新页面必须
   * 重新拿到当前状态，否则宠物会静默回到 idle。但如果不加区分地重放，
   * `ready`（映射到一次性的 waving）就会在每次全屏恢复时再挥一次手 —— 明显是瑕疵。
   * 补推时渲染层直接落到"静止落点"（animation.then ?? animation.state）而不重播一次性动作。
   * 与 `PointerHint.force` 是同一个模式：同一类问题用同一种解法。
   */
  replay?: boolean;
}
