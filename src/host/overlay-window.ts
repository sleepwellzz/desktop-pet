// 宿主适配层之一：创建并管理"透明置顶覆盖窗口"。
// 这是 ADR 001 约定的四个宿主接口里的第一个，也是唯一一个承载窗口语义的模块。
//
// M0 实测结论：transparent + alwaysOnTop + focusable:false 三者组合，
// Electron 会自动带上 WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE，
// 不夺焦点是原生行为，这里不需要 Win32 调用。
//
// 2026-09-15 修正（ADR 008）：**逐像素穿透不是原生行为**。实测窗口的生效命中区域
// 是整个窗口矩形（293x317 物理像素），窗口内 90/90 个采样点全部吃掉点击，包括
// 精灵轮廓外 46 DIP 的透明带。因此这里改为显式控制：
//   常态 setIgnoreMouseEvents(true, { forward: true }) —— 整窗穿透，但仍转发鼠标移动；
//   渲染层按当前帧精灵 alpha 判定光标是否落在实体上，命中才切回可交互。
// 命中区域由此完全由我们定义，与窗口尺寸、系统分层窗口行为都无关。
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
  /** 切换"可交互 / 整窗穿透"。重复设置同一状态会被忽略。 */
  setInteractive(on: boolean): void;
}

export function createOverlayWindow(opts: OverlayOptions): OverlayWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.round(area.x + area.width - opts.width - (opts.marginRight ?? 24));
  const y = Math.round(area.y + area.height - opts.height - (opts.marginBottom ?? 24));

  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    // 让 width/height 指的是**内容区**：实测默认语义下窗口会比请求尺寸大 4 DIP，
    // 多出来的透明带既不绘制也不该存在（虽然显式命中测试后它已不再吃点击）。
    useContentSize: true,
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

  // 起步即全穿透：渲染层尚未采样前，宁可让点击落到底层应用，也不要吃掉它。
  let interactive = false;
  win.setIgnoreMouseEvents(true, { forward: true });

  const contentW = opts.width;
  const contentH = opts.height;

  return {
    browserWindow: win,
    showInactive: () => win.showInactive(),
    hide: () => win.hide(),
    show: () => win.showInactive(),
    /**
     * 移动窗口。刻意不用 `setPosition`：在 150% 缩放下，它每次都要把
     * "内容尺寸 ↔ 窗口尺寸"做一次 DIP/物理像素取整，误差逐次累积 ——
     * 2026-09-15 实测每移动一次窗口就长 1 DIP（148x160 → 149x161 → …），
     * 6 次后变成 154x166，物理 221x239 → 230x248。拖动越多窗口越大，
     * 而修复前的命中区域恰好等于整个窗口矩形，于是表现为
     * **"拖动后点不动的死区越变越大"**（用户报告的原始现象）。
     * 每次都显式复位内容尺寸，留不出累积空间。
     */
    moveBy: (dx, dy) => {
      const b = win.getContentBounds();
      win.setContentBounds({
        x: Math.round(b.x + dx),
        y: Math.round(b.y + dy),
        width: contentW,
        height: contentH,
      });
    },
    position: () => {
      const [px = 0, py = 0] = win.getPosition();
      return { x: px, y: py };
    },
    setInteractive: (on) => {
      if (on === interactive) return;
      interactive = on;
      win.setIgnoreMouseEvents(!on, { forward: true });
    },
  };
}
