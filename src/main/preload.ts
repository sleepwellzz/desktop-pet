// 渲染层与主进程之间只暴露窄接口，不开 nodeIntegration。
import { contextBridge, ipcRenderer } from 'electron';
import {
  CH, type DragDelta, type FullscreenNotice, type HitState, type PointerHint, type RendererInit,
} from '../shared/ipc';

contextBridge.exposeInMainWorld('pet', {
  onInit: (cb: (payload: RendererInit) => void): void => {
    ipcRenderer.on(CH.init, (_e, payload: RendererInit) => cb(payload));
  },
  onFullscreen: (cb: (notice: FullscreenNotice) => void): void => {
    ipcRenderer.on(CH.fullscreen, (_e, notice: FullscreenNotice) => cb(notice));
  },
  /** 窗口移动后主进程回报光标位置，渲染层据此重新判定是否需要可交互。 */
  onPointerHint: (cb: (hint: PointerHint) => void): void => {
    ipcRenderer.on(CH.pointerHint, (_e, hint: PointerHint) => cb(hint));
  },
  dragBy: (delta: DragDelta): void => { ipcRenderer.send(CH.drag, delta); },
  /** 命中状态变化才上报，主进程据此切换整窗穿透。 */
  setInteractive: (interactive: boolean): void => {
    const state: HitState = { interactive };
    ipcRenderer.send(CH.interactive, state);
  },
  log: (message: string): void => { ipcRenderer.send(CH.log, message); },
  /** 通知主进程：preload 与页面脚本已就绪，可以下发 init 载荷了。 */
  ready: (): void => { ipcRenderer.send(CH.ready); },
});
