// 主进程 ↔ 渲染层的 IPC 契约。通道名与载荷类型集中在此，避免两边各写一份。
import type { ResolvedState } from '../kernel/types';

export const CH = {
  init: 'pet:init',
  /** 渲染层 → 主进程：脚本已就绪，可以下发 init 了 */
  ready: 'pet:ready',
  fullscreen: 'pet:fullscreen',
  drag: 'pet:drag',
  log: 'pet:log',
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

export interface FullscreenNotice { hidden: boolean; fgTitle: string }
