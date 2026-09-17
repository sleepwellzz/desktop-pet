// 主进程 ↔ 渲染层的 IPC 契约。通道名与载荷类型集中在此，避免两边各写一份。
import type { ArbiterState, PetStatus, SessionView } from '../kernel/status';
import type { ResolvedState } from '../kernel/types';

export type { SessionView };

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
  /**
   * 主进程 → 控制条：整份视图数据（状态、会话列表、缩放、快捷键…）。
   * 控制条是**只读面板**：它自己不持有状态、不读文件，所有内容都从这里来。
   */
  barView: 'pet:bar-view',
  /**
   * 主进程 → 控制条：请聚焦首屏（快捷键唤出时用）。
   *
   * 为什么焦点要由主进程下令而不是渲染层自作主张：控制条有两条唤出路径
   * （悬停 = 不抢焦点 / 快捷键 = 抢焦点），渲染层看不到"我是怎么被唤出来的"。
   */
  barFocus: 'pet:bar-focus',
  /**
   * 控制条 → 主进程：执行一个**白名单动作**。
   *
   * 渲染层拿不到动作表，只能发命令 id；主进程查表执行，未知 id 一律忽略并记日志。
   * 这样安全边界干净（渲染层传不了任意参数），而且 M3 加"agent 输入框"时
   * 协议形状不变 —— 只是给联合类型加一个成员，输入框长在同一位置、走同一个通道。
   */
  barCommand: 'pet:bar-command',
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
 * 控制条能触发的动作 id。**这是渲染层唯一能让主进程做事的手段。**
 *
 * 刻意用"命令 id"而不是把 `PetMenuActions` 直接交给渲染层：后者等于把整张动作表
 * 连同参数一起开放出去（`setScale(0.001)` 只是个开始）。查表执行还有第二个好处 ——
 * M3 要加"把输入框里的文字发给 agent"时，只在这里加一个 `agent-send` 成员，
 * 通道形状、窗口层、白名单机制全都不用动。
 */
export type BarCommandId =
  /** 隐藏宠物（控制条随之收起）。 */
  | 'hide-pet'
  /** 确认某条会话（解除 needs-input 粘滞），需要 `arg` = sessionId。 */
  | 'ack-session'
  /**
   * 弹出与托盘/右键**同一份**原生菜单 —— 缩放、重置大小、开机自启、退出都在里面。
   *
   * 2026-09-16 用户验收后把面板上的 − / + / ↺ 三个缩放按钮撤掉了（"加减按钮不太需要，
   * 只需在右键托盘处出现"）：面板只留"看一下状态、确认一下、收起"三件事，
   * 缩放这类不常动的操作交给菜单，面板因此更短、误点更少。
   */
  | 'popup-menu'
  /** 收起控制条（等同 Esc 或面板右上角的 ×）。 */
  | 'close-bar';

export interface BarCommand {
  id: BarCommandId;
  arg?: string;
}

/** 主进程 → 控制条：面板要显示的全部内容。控制条不持有任何自己的状态。 */
export interface BarView {
  status: PetStatus;
  /**
   * 业务状态 → 中文文案。整份下发而不是让渲染层自己写一份映射：
   * 状态文案只有一处真相（主进程的 `STATUS_TEXT`），否则菜单、气泡、面板三处会各说各话。
   */
  statusLabels: Record<PetStatus, string>;
  /** 会话视图，主状态排第一。 */
  sessions: SessionView[];
  /** 面板最多显示几行（超出显示"另有 N 条"）。 */
  maxRows: number;
  /** 当前缩放，只读显示用（缩放操作本身在菜单里）。 */
  scale: number;
  /** 当前生效的全局快捷键；null = 注册失败（如实显示，不静默）。 */
  hotkey: string | null;
  petVisible: boolean;
  /** 与 `StatusPush.rev` 同源：渲染层据此识别"重载后的第一帧"。 */
  rev: number;
}

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
