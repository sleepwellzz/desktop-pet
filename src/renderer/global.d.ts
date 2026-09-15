import type { DragDelta, FullscreenNotice, RendererInit } from '../shared/ipc';

interface PetBridge {
  onInit(cb: (payload: RendererInit) => void): void;
  onFullscreen(cb: (notice: FullscreenNotice) => void): void;
  dragBy(delta: DragDelta): void;
  log(message: string): void;
  ready(): void;
}

declare global {
  interface Window {
    pet: PetBridge;
  }
}

export {};
