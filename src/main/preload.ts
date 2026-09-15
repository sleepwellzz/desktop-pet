// 渲染层与主进程之间只暴露窄接口，不开 nodeIntegration。
import { contextBridge, ipcRenderer } from 'electron';
import { CH, type DragDelta, type FullscreenNotice, type RendererInit } from '../shared/ipc';

contextBridge.exposeInMainWorld('pet', {
  onInit: (cb: (payload: RendererInit) => void): void => {
    ipcRenderer.on(CH.init, (_e, payload: RendererInit) => cb(payload));
  },
  onFullscreen: (cb: (notice: FullscreenNotice) => void): void => {
    ipcRenderer.on(CH.fullscreen, (_e, notice: FullscreenNotice) => cb(notice));
  },
  dragBy: (delta: DragDelta): void => { ipcRenderer.send(CH.drag, delta); },
  log: (message: string): void => { ipcRenderer.send(CH.log, message); },
  /** 通知主进程：preload 与页面脚本已就绪，可以下发 init 载荷了。 */
  ready: (): void => { ipcRenderer.send(CH.ready); },
});
