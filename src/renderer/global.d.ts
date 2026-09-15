import type { DragDelta, FullscreenNotice, PointerHint, RendererInit } from '../shared/ipc';

interface PetBridge {
  onInit(cb: (payload: RendererInit) => void): void;
  onFullscreen(cb: (notice: FullscreenNotice) => void): void;
  /** 窗口移动后主进程回报光标位置（窗口内容区 CSS 像素），据此重新采样命中状态。 */
  onPointerHint(cb: (hint: PointerHint) => void): void;
  dragBy(delta: DragDelta): void;
  /** 上报命中状态：true = 光标在宠物实体像素上，窗口需可交互；false = 整窗穿透。 */
  setInteractive(interactive: boolean): void;
  log(message: string): void;
  ready(): void;
}

declare global {
  interface Window {
    pet: PetBridge;
  }
}

export {};
