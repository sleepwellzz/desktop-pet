import type { BarCommand, BarView } from '../shared/ipc';

interface BarBridge {
  /** 主进程下发的整份视图数据。控制条是哑面板：所有内容都从这里来。 */
  onView(cb: (view: BarView) => void): void;
  /** 主进程下令聚焦（快捷键唤出）。本轮只用来把键盘焦点交给面板，M3 会用来聚焦输入框。 */
  onFocus(cb: () => void): void;
  /** 执行一个白名单动作（只能发 id，主进程查表）。 */
  command(cmd: BarCommand): void;
}

declare global {
  interface Window {
    petBar: BarBridge;
  }
}

export {};
