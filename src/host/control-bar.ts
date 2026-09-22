// 控制条层：本项目**第一个可聚焦窗口**（M2 ④，ADR 014）。
//
// 现有两层窗口（宠物 / 气泡）全是 `focusable: false` —— 焦点行为在这个项目里是**零经验区**，
// 所以本模块的每条取舍都由 `spikes/m2-control` 的真实探针支撑，不是推断：
//
//   - **双路径显示**：悬停唤出走 `showInactive()`（不抢焦点 —— 用户可能正在 IDE 里打字，
//     鼠标划过宠物不该打断他），右键/菜单唤出走 `show()` + `focus()`（用户明确点了）；
//   - **常态不做整窗穿透**：它是个填满窗口的矩形面板，窗口矩形 ≈ 可视矩形，
//     "矩形窗口吃掉自己矩形的点击"是正常窗口语义，因此**不适用 ADR 008 的逐像素纪律**。
//     代价是四角不能做圆角：圆角会留下 4 个透明三角去吃掉下层应用的点击（约 1% 面积），
//     在这个项目里那是需要显式接受的纵容，不值得为观感付（设计 §3.2）；
//   - **高度按内容算**（顶栏 + 会话行 + 动作排三段），并且**用实测高度反推 y** ——
//     气泡层踩过"下发 32 DIP 高度读回 38"的坑，而"离宠物 8 DIP"是这里唯一要紧的观感指标。
//
// 刻意不复用气泡层的窗口代码：气泡层"永不接收鼠标事件"是它最重要的性质（ADR 009 那个
// hide→show 后按钮事件不路由的坑与它无关，正因为它从不收按钮事件），控制条恰好相反。
// 把两者塞进一个模块，下一个人一定会以为控制条也该整窗穿透。
import { BrowserWindow, screen } from 'electron';
import koffi from 'koffi';
import { CH, type BarView } from '../shared/ipc';

// —— 让窗口不出现在 Alt+Tab 列表：显式设置 WS_EX_TOOLWINDOW ——
//
// 为什么不靠 `skipTaskbar: true` 就够了（**实测**，`spikes/m2-control/probe-control.js`）：
// 实测控制条的扩展样式读回来是 `0x108`（WS_EX_TOPMOST | WS_EX_WINDOWEDGE），**没有**
// WS_EX_TOOLWINDOW（0x80）。原因大概是 skipTaskbar 走的是 `ITaskbarList::DeleteTab`
// 把窗口从**任务栏**摘掉，而 Alt+Tab 列表看的是扩展样式位与 owner —— 两条路径不同。
// 结论：显式设样式位，`skipTaskbar` 保留作双保险。
// （这是本项目第五次"推断出来的平台行为被实测推翻"，前四次见 PLAN §8 风险表。）
const user32 = koffi.load('user32.dll');
const GetWindowLongPtrW = user32.func('int64 GetWindowLongPtrW(void* hWnd, int nIndex)');
const SetWindowLongPtrW = user32.func('int64 SetWindowLongPtrW(void* hWnd, int nIndex, int64 dwNewLong)');
const SetWindowPos = user32.func('bool SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)');
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;

/** 标成工具窗口。失败只降级（窗口可能出现于 Alt+Tab），不让控制条起不来。 */
function markAsToolWindow(win: BrowserWindow): boolean {
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    const next = (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    if (next !== ex) {
      SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
      // 改扩展样式后必须让系统重算一次窗口边框才会真正生效
      SetWindowPos(hwnd, null, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
    const after = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    return (after & WS_EX_TOOLWINDOW) !== 0;
  } catch (e) {
    console.warn('[pet] 设置 WS_EX_TOOLWINDOW 失败（控制条可能出现在 Alt+Tab）：' + String(e));
    return false;
  }
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface ControlBarOptions {
  htmlPath: string;
  preloadPath: string;
  /** 固定宽度。不做自适应：宽度变化会让面板在会话列表变化时横向抖动。 */
  width: number;
  /** 顶栏（状态行 + 收起按钮）高度。 */
  headerHeight: number;
  /** 每条会话行的高度。 */
  rowHeight: number;
  /** 底部动作排高度。 */
  footerHeight: number;
  /** 动作排（手动把玩）**每行**的高度。 */
  actionRowHeight: number;
  /** 动作排的列数：行数 = ceil(动作个数 / 列数)。 */
  actionColumns: number;
  /** 会话行最多显示几条，超出显示"另有 N 条"。 */
  maxRows: number;
  gapBelowPet: number;
  gapAbovePet: number;
  /**
   * 宠物**上方**已被占用的高度（气泡可见时非 0）。
   * 控制条翻到宠物上方时用它避让，否则会正好盖住气泡。
   */
  reservedAbove?: () => number;
  /** 焦点进出变化。主进程据此驱动显示状态机（`focus` 事件）。 */
  onFocusChange?: (hasFocus: boolean) => void;
}

export interface ControlBar {
  readonly browserWindow: BrowserWindow;
  /**
   * 显示并刷新内容。
   * @param focus true = 抢焦点（右键 / 菜单唤出）；false = `showInactive()` 不抢（历史路径，现未使用）。
   */
  show(view: BarView, o: { focus: boolean }): void;
  /** 已显示时更新内容（高度可能随之变化）。未显示时只记下来。 */
  update(view: BarView): void;
  hide(): void;
  isVisible(): boolean;
  /** 宠物移动 / 缩放后用新矩形重新定位（不可见时只更新记账）。 */
  followPet(petBounds: Rect): void;
  /** 内容区矩形（DIP）。主进程用它判定"光标是否在控制条上"（悬停语义的一半）。 */
  bounds(): Rect | null;
  destroy(): void;
}

export function createControlBar(opts: ControlBarOptions): ControlBar {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.headerHeight + opts.footerHeight,
    // 与宠物/气泡层一致：width/height 指**内容区**，否则会多出 4 DIP 的透明带
    useContentSize: true,
    show: false,
    transparent: false,
    backgroundColor: '#1b1f27',
    frame: false,
    // 不做投影：与工程既有窗口保持一致（设计 §12 已列"不做圆角/投影美化"）
    hasShadow: false,
    // 关键：不出现在任务栏。这也是"不被误判为流氓软件"那条风险的一项缓解（PLAN §8）。
    // Alt+Tab 是否也排除，由 `spikes/m2-control` 读扩展样式位实测，不推断。
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // 本项目唯一为 true 的窗口。它只在用户主动唤出时存在，且必须能收键盘（Esc、将来的输入框）。
    focusable: true,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (!markAsToolWindow(win)) {
    console.warn('[pet] 控制条不是 WS_EX_TOOLWINDOW：可能出现在 Alt+Tab（skipTaskbar 单独不够）');
  }

  // 窗口标题由页面 <title> 决定（`setTitle` 会被覆盖）—— 探针靠这个标题找窗口，
  // 所以 control-bar.html 的 <title> 必须与这里一致。
  win.loadFile(opts.htmlPath);

  win.on('blur', () => opts.onFocusChange?.(false));
  win.on('focus', () => opts.onFocusChange?.(true));

  let lastView: BarView | null = null;
  let lastPetBounds: Rect | null = null;
  /**
   * 显示记账。**不能用 `win.isVisible()` 现查**（2026-09-16 实测）：
   * `win.show()` 之后同一 tick 内 `isVisible()` 仍可能返回 false，于是紧跟其后的
   * `focus` 事件（show 会激活窗口）会让调用方以为"窗口还没显示"而**再 show 一次** ——
   * 第二次是不抢焦点的 `showInactive()`，在"快捷键唤出要抢焦点"的路径上正好把刚拿到的
   * 焦点又让出去。日志证据：一次快捷键唤出打出两条"控制条显示"，第二条写着"不抢焦点"。
   * 改为由窗口自身的 show/hide 事件驱动记账，绝不会与真实状态错开。
   */
  let visible = false;
  win.on('show', () => { visible = true; });
  win.on('hide', () => { visible = false; });

  /**
   * 内容高度 = 四段之和：顶栏 + 会话行 + **动作排** + 底部动作排。
   *
   * 动作排（2026-09-22，ADR 038）是第 3 段，行数 = `ceil(动作个数 / 列数)` ——
   * 主进程按它算窗口高度，渲染层按同一对参数设 CSS，因此**改 sidecar 就能两边一起动**。
   * （会话行当年是"主进程算 + CSS 里再写一个 28px"，动作排不再重复那个隐患。）
   */
  function desiredHeight(view: BarView): number {
    const n = view.sessions.length;
    const rows = n === 0 ? 0 : Math.min(n, opts.maxRows) + (n > opts.maxRows ? 1 : 0);
    const cols = Math.max(1, Math.round(opts.actionColumns));
    const actionRows = view.actions.length === 0 ? 0 : Math.ceil(view.actions.length / cols);
    return opts.headerHeight
      + rows * opts.rowHeight
      + actionRows * opts.actionRowHeight
      + opts.footerHeight;
  }

  function place(view: BarView, h: number): void {
    const pet = lastPetBounds;
    if (!pet) return;
    const w = opts.width;
    const centerX = pet.x + pet.width / 2;
    const area = screen.getDisplayNearestPoint({
      x: Math.round(centerX), y: Math.round(pet.y + pet.height / 2),
    }).workArea;
    const x = Math.min(Math.max(Math.round(centerX - w / 2), area.x), area.x + area.width - w);
    const below = pet.y + pet.height + opts.gapBelowPet;
    let y: number;
    if (below + h <= area.y + area.height) {
      y = below;
    } else {
      // 宠物贴工作区底边 → 翻到上方。上方可能已经有气泡，按 reservedAbove 让开。
      const reserved = opts.reservedAbove?.() ?? 0;
      const above = pet.y - opts.gapAbovePet - reserved - h;
      y = above >= area.y ? above : Math.min(Math.max(below, area.y), area.y + area.height - h);
    }
    win.setContentBounds({ x, y: Math.round(y), width: w, height: h });
  }

  function push(view: BarView): void {
    lastView = view;
    if (!win.isDestroyed()) win.webContents.send(CH.barView, view);
  }
  // 页面还没加载完时消息会丢（与气泡层同一个坑），加载完补一次。
  win.webContents.on('did-finish-load', () => {
    if (lastView && !win.isDestroyed()) win.webContents.send(CH.barView, lastView);
  });

  return {
    browserWindow: win,

    show(view, o) {
      lastView = view;
      const h = desiredHeight(view);
      push(view);
      if (!visible) {
        if (o.focus) win.show(); else win.showInactive();
      } else if (o.focus) {
        win.focus();
      }
      place(view, h);
      // 实测高度可能与请求不同。用实测值再定位一次，让"离宠物 N DIP"保持精确。
      const actual = win.getContentBounds().height;
      if (Math.abs(actual - h) > 0.5) place(view, actual);
      if (o.focus) win.webContents.send(CH.barFocus);
    },

    update(view) {
      lastView = view;
      if (!visible) return;
      const h = desiredHeight(view);
      const before = win.getContentBounds();
      push(view);
      if (Math.abs(before.height - h) > 0.5) {
        place(view, h);
        const actual = win.getContentBounds().height;
        if (Math.abs(actual - h) > 0.5) place(view, actual);
      } else {
        place(view, before.height);     // 高度没变，但宠物可能动过，重新贴一次
      }
    },

    hide() {
      if (visible) win.hide();
    },

    isVisible: () => visible,

    followPet(petBounds) {
      lastPetBounds = petBounds;
      if (!visible || !lastView) return;
      place(lastView, win.getContentBounds().height);
    },

    bounds() {
      if (win.isDestroyed()) return null;
      const b = win.getContentBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },

    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
