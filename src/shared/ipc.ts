// 主进程 ↔ 渲染层的 IPC 契约。通道名与载荷类型集中在此，避免两边各写一份。
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
