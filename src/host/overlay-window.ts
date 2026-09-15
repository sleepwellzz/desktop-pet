// 宿主适配层之一：创建并管理"透明置顶覆盖窗口"。
// 这是 ADR 001 约定的四个宿主接口里的第一个，也是唯一一个承载窗口语义的模块。
//
// M0 实测结论：transparent + alwaysOnTop + focusable:false 三者组合，
// Electron 会自动带上 WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE，
// 逐像素穿透、不夺焦点**都是原生行为**，这里不需要任何 Win32 调用。
import { BrowserWindow, screen } from 'electron';

export interface OverlayOptions {
  width: number;
  height: number;
  /** 距主显示器工作区右/下边缘的留白（DIP）。 */
  marginRight?: number;
  marginBottom?: number;
  htmlPath: string;
  preloadPath: string;
}

export interface OverlayWindow {
  readonly browserWindow: BrowserWindow;
  showInactive(): void;
  hide(): void;
  show(): void;
  moveBy(dx: number, dy: number): void;
  position(): { x: number; y: number };
}

export function createOverlayWindow(opts: OverlayOptions): OverlayWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.round(area.x + area.width - opts.width - (opts.marginRight ?? 24));
  const y = Math.round(area.y + area.height - opts.height - (opts.marginBottom ?? 24));

  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    x, y,
    transparent: true,
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    focusable: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  return {
    browserWindow: win,
    showInactive: () => win.showInactive(),
    hide: () => win.hide(),
    show: () => win.showInactive(),
    moveBy: (dx, dy) => {
      const [px = 0, py = 0] = win.getPosition();
      win.setPosition(px + dx, py + dy, false);
    },
    position: () => {
      const [px = 0, py = 0] = win.getPosition();
      return { x: px, y: py };
    },
  };
}
