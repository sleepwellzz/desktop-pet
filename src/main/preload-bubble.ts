// 气泡层的 preload：只暴露它需要的那一个通道。
// 刻意**不复用**宠物层的 preload —— 气泡层不需要拖动、命中、状态回推那些能力，
// 开出去只会扩大攻击面（最小权限）。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('petBubble', {
  onBubble: (cb: (payload: { text: string; badge: number }) => void): void => {
    ipcRenderer.on('pet:bubble', (_e, payload: { text: string; badge: number }) => cb(payload));
  },
});
