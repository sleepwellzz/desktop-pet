// 控制条的 preload：最小权限，只开它需要的三个通道。
//
// 刻意不复用宠物层 / 气泡层的 preload：控制条不需要拖动、命中、状态回推那些能力，
// 开出去只会扩大攻击面。反过来它多了一个别人没有的能力 —— **发命令**
// （`command`）。这个能力之所以安全，是因为它只能发白名单里的 id，
// 主进程查表执行、未知 id 忽略并记日志（见 shared/ipc.ts 的 BarCommandId 注释）。
import { contextBridge, ipcRenderer } from 'electron';
import { CH, type BarCommand, type BarView } from '../shared/ipc';

contextBridge.exposeInMainWorld('petBar', {
  /** 主进程下发的整份视图数据（状态、会话列表、缩放、快捷键…）。 */
  onView: (cb: (view: BarView) => void): void => {
    ipcRenderer.on(CH.barView, (_e, view: BarView) => cb(view));
  },
  /** 主进程下令聚焦（快捷键唤出时用）。 */
  onFocus: (cb: () => void): void => {
    ipcRenderer.on(CH.barFocus, () => cb());
  },
  /** 执行一个白名单动作。渲染层拿不到动作表，只能发 id。 */
  command: (cmd: BarCommand): void => { ipcRenderer.send(CH.barCommand, cmd); },
});
