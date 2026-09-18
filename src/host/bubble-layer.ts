// 气泡层：独立的透明窗口，绘制状态文案与多会话角标。
//
// **本模块的核心取舍：不扩大宠物窗口。** 把气泡画进宠物窗口会改窗口矩形，
// 而命中判定的坐标系、边界与"整窗穿透/可交互"的切换全都建立在那个矩形上
// （ADR 008/009 用两轮真实点击实测换来的结论）。独立窗口则完全隔离：
//
//   - 常态 `setIgnoreMouseEvents(true)`，**永不切换** —— 气泡不可点，不存在命中判定这回事；
//   - 因为它永远不接收鼠标按钮事件，ADR 009 那个"hide→show 之后 Windows 不再路由
//     按钮事件、只能靠重载渲染层恢复"的坑**与它无关**：本层隐藏/显示后不需要 reload；
//   - 全屏让位时跟着宠物一起隐藏，恢复时直接 show 即可。
import { BrowserWindow, screen } from 'electron';

export interface BubbleLayerOptions {
  htmlPath: string;
  preloadPath: string;
  /** 距宠物窗口上边缘的间距（DIP）。 */
  gapAbovePet: number;
  minWidth: number;
  maxWidth: number;
  height: number;
}

/** 窗口矩形（DIP，屏幕坐标）。 */
export interface PetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BubbleLayer {
  readonly browserWindow: BrowserWindow;
  /**
   * 按当前文本/角标显示（尺寸按内容估算，位置贴宠物上方居中）。
   *
   * `petBounds` **必须由调用方传入宠物窗口的真实矩形**，且**不接受"我自己去猜"**：
   * 本层是独立的透明窗口，`win.getContentBounds()` 拿到的是**气泡窗自己的**矩形
   * （首次显示时它还在构造时的默认尺寸与默认位置上，与宠物毫无关系）。
   * 曾把它当宠物矩形用，症状是气泡出现在屏幕正中、且往后再也不会跟着宠物走
   * （`followPet` 之外的路径全被这一次错误赋值污染）。拿不到宠物矩形时**选择不显示** ——
   * 气泡画错位置比不画更糟，且它会长时间停留在那个错误位置上误导用户。
   * 兄弟模块 `host/control-bar.ts` 的 `place()` 用的是同一条纪律（`if (!pet) return;`）。
   */
  show(text: string, badge: number, petBounds: PetBounds): void;
  hide(): void;
  isVisible(): boolean;
  /** 宠物移动/缩放后用它的新矩形重新定位（不可见时什么都不做）。 */
  followPet(petBounds: PetBounds): void;
  /** 宠物矩形变化且气泡可见时，重新定位并返回是否移动过。 */
  destroy(): void;
}

/**
 * 估算气泡宽度。用逐字符宽度累加而不是让窗口自适应：
 * 窗口尺寸由主进程给，改尺寸又要走 `setContentBounds`（ADR 008），
 * 所以宁可在主进程里算准一点。中日韩字符按全角宽、其余按半角估。
 */
export function estimateBubbleWidth(text: string, badge: number, min: number, max: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 14 : 8;
  }
  w += 24;                            // 左右内边距
  if (badge > 0) w += 30;             // 角标
  return Math.min(max, Math.max(min, Math.ceil(w)));
}

export function createBubbleLayer(opts: BubbleLayerOptions): BubbleLayer {
  const win = new BrowserWindow({
    width: opts.minWidth,
    height: opts.height,
    useContentSize: true,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    focusable: false,
    acceptFirstMouse: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 常态穿透：气泡层永远不需要接收点击（用户的点击应该落到宠物或下层应用）
  win.setIgnoreMouseEvents(true);

  const winTitle = 'desktop-pet-bubble';
  win.setTitle(winTitle);
  win.loadFile(opts.htmlPath);

  /** 把内容送进气泡层页面。页面还没加载完时消息会丢，所以 did-finish-load 时补一次。 */
  let last: { text: string; badge: number } | null = null;
  function push(text: string, badge: number): void {
    last = { text, badge };
    if (!win.isDestroyed()) win.webContents.send('pet:bubble', last);
  }
  win.webContents.on('did-finish-load', () => {
    if (last && !win.isDestroyed()) win.webContents.send('pet:bubble', last);
  });

  function boundsFor(text: string, badge: number, petBounds: PetBounds): PetBounds {
    const w = estimateBubbleWidth(text, badge, opts.minWidth, opts.maxWidth);
    // 用**实测高度**做纵向定位：本机实测下发 32 DIP 会读回 38（多 6 DIP，出现在隐藏窗口
    // 首次显示时），若拿请求值算，气泡会比预期离宠物近 6 DIP。宽度不受影响，实测与请求一致。
    // 不去纠正那个 6 DIP：气泡层不接收点击，尺寸偏差只影响观感；而"用真实值算间距"
    // 能让唯一的观感指标（离宠物多远）保持精确。
    const h = win.isDestroyed() ? opts.height : Math.max(opts.height, win.getContentBounds().height);
    const centerX = petBounds.x + petBounds.width / 2;
    const centerY = petBounds.y + petBounds.height / 2;
    const area = screen.getDisplayNearestPoint({ x: Math.round(centerX), y: Math.round(centerY) }).workArea;
    const x = Math.min(Math.max(Math.round(centerX - w / 2), area.x), area.x + area.width - w);
    const y = Math.min(Math.max(Math.round(petBounds.y - opts.gapAbovePet - h), area.y), area.y + area.height - h);
    return { x, y, width: w, height: h };
  }

  /** 最近一次由调用方告知的宠物矩形；**只由调用方写入**，本层不自行推断（见 `show` 的注释）。 */
  let lastPetBounds: PetBounds | null = null;

  return {
    browserWindow: win,
    show(text, badge, petBounds) {
      lastPetBounds = petBounds;
      // 顺序照宠物窗口那套（`overlay-window.ts` 的 pinContentBounds）：**先显示再钉尺寸**。
      // 反过来（先钉再显示）实测读回来的高度会比请求值大 6 DIP —— 隐藏状态下下发尺寸
      // 会被系统的首次显示重新算一遍，多出来的透明带既不该存在也没人看得见。
      if (!win.isVisible()) win.showInactive();     // 绝不抢焦点
      win.setContentBounds(boundsFor(text, badge, petBounds));
      push(text, badge);
    },
    hide() {
      if (win.isVisible()) win.hide();
    },
    isVisible: () => win.isVisible(),
    followPet(petBounds) {
      lastPetBounds = petBounds;
      if (!win.isVisible() || !last) return;
      win.setContentBounds(boundsFor(last.text, last.badge, petBounds));
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
