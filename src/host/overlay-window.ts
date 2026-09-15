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
//   常态 setIgnoreMouseEvents(true) —— 整窗穿透（不做 forward：实测转发根本不生效，
//   而且它会额外带上 WS_EX_LAYERED，让"窗口被隐藏再显示"后的命中区域算成全透明，见 ADR 009）；
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
  /** 重新加载渲染层页面（窗口重新显示后必须调用，见实现处注释）。 */
  reload(): void;
  /** 无条件回到"整窗穿透"并对齐记账。 */
  resetToIgnore(): void;
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
  win.setIgnoreMouseEvents(true);

  const contentW = opts.width;
  const contentH = opts.height;

  /**
   * 把窗口内容区重新钉回预期尺寸与当前位置。
   *
   * 为什么必须有这一步（2026-09-15 实测，ADR 009）：`hide()` → `showInactive()` 之后，
   * 鼠标**按钮**事件不再投递到渲染层（鼠标移动事件照旧能进），表现为
   * **"全屏让位回来以后宠物再也点不动、拖不动"**。而当时页面 visibilityState=visible、
   * 坐标映射偏差为 0、窗口位置尺寸前后一致、WS_EX_TRANSPARENT 也已清除 —— 从任何单点
   * 看都"没问题"。
   *
   * 逐个试补救动作后定位：`webContents.focus()`、重设 alwaysOnTop、opacity 抖动、blur、
   * `invalidate()`、再 hide/show 一次、再 showInactive 一次 —— **全部无效**；
   * 只有真正下发一次 `SetWindowPos`（`setContentBounds`）能恢复投递。
   * 注意 `setBounds(getBounds())` 无效：参数不变时 Electron 会短路，没真正下发。
   *
   * 根因判断：`useContentSize` 下窗口内容区是 144×156，而 Chromium 的 view 是 148×160
   * （差 4 DIP，150% 缩放下的取整错位），隐藏/显示把这个错位固化到了输入区域上。
   * 每次显示后重新下发一次内容bounds，错位就被抹平。
   */
  function pinContentBounds(): void {
    const b = win.getContentBounds();
    win.setContentBounds({ x: b.x, y: b.y, width: contentW, height: contentH });
  }
  pinContentBounds();   // 创建后先归一化一次（顺带消除 view 与窗口尺寸的 4 DIP 错位）

  /**
   * 重新下发一次"真的变了"的窗口位置（下移 1 像素再复位）。
   *
   * 为什么必须有这一步（2026-09-15 实测，ADR 009）：`hide()` → `showInactive()` 之后，
   * Windows **不再把真实的鼠标按钮事件路由到这个窗口**。此时页面 visibilityState 正常、
   * 光标→客户区坐标映射偏差为 0、窗口位置尺寸正确、`WS_EX_TRANSPARENT` 也已按需清除，
   * 从任何单点看都"没问题"，但真实点击就是进不来 —— 用户看到的现象是
   * **"只要全屏一次，宠物回来以后就再也点不动、拖不动"**。
   *
   * 定位过程：把 `WM_LBUTTONDOWN` 用 `SendMessage` 直接发给顶层 HWND，渲染层**能**收到
   * pointerdown —— 证明窗口本身能收事件，是 Windows 的路由（命中测试）出了问题。
   * 逐个试补救动作：`EnableWindow(false→true)`、`webContents.focus()`、重设 alwaysOnTop、
   * opacity 抖动、`blur()`、`invalidate()`、再 hide/show 一次、再 `showInactive()` 一次、
   * `setBounds(getBounds())` —— **全部无效**；而只要下发一次真正改变了的 `SetWindowPos`
   * （位置 ±1 或尺寸 ±1 再还原）就**立刻恢复**。判断是该分层窗口的命中区域被缓存，
   * 而 `ShowWindow` 不足以触发重算。
   */
  function nudgeWindow(): void {
    const b = win.getContentBounds();
    win.setContentBounds({ x: b.x, y: b.y + 1, width: contentW, height: contentH });
    win.setContentBounds({ x: b.x, y: b.y, width: contentW, height: contentH });
  }

  return {
    browserWindow: win,
    showInactive: () => { win.showInactive(); nudgeWindow(); pinContentBounds(); },
    hide: () => win.hide(),
    show: () => { win.showInactive(); nudgeWindow(); pinContentBounds(); },
    /**
     * 重新加载渲染层页面。
     *
     * 为什么需要（2026-09-15 实测，ADR 009）：`hide()` → `showInactive()` 之后，
     * Windows 不再把**真实的鼠标按钮事件**路由到这个窗口 —— 页面 visibilityState 正常、
     * 光标→客户区坐标映射偏差为 0、窗口位置尺寸正确、`WS_EX_TRANSPARENT` 也随光标正确清除。
     * 证据链：
     *   - 用 `SendMessage(WM_LBUTTONDOWN)` 直接发给顶层 HWND，渲染层**能**收到 pointerdown
     *     → 窗口本身能收事件，坏的是 Windows 的路由；
     *   - 把光标移开再移回，`WS_EX_TRANSPARENT` 仍然精确地随光标切换 → 我们自己的状态机没坏；
     *   - 逐个试补救动作（EnableWindow、focus、alwaysOnTop 重设、opacity 抖动、blur、
     *     invalidate、再 hide/show、再 showInactive、`setBounds(getBounds())`、位置/尺寸 nudge）
     *     —— **全部不可靠**；
     *   - `webContents.reload()` —— 稳定恢复。
     * 结论：只有重建渲染层才能让 Chromium 重新建立该窗口的输入通路。
     */
    reload: () => win.webContents.reload(),
    /** 无条件回到"整窗穿透"并把记账对齐（页面重载后调用）。 */
    resetToIgnore: () => {
      interactive = false;
      win.setIgnoreMouseEvents(true);
    },
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
      win.setIgnoreMouseEvents(!on);
    },
  };
}
