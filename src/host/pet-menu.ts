// 宠物菜单模板：托盘图标与宠物右键**共用同一套**（一份真相，两处入口）。
//
// 状态全部由调用方通过 getView() 现读（仲裁器 / overlay / prefs / autostart），
// 菜单自己不持有任何状态 —— 延续 ADR 010"仲裁器是全应用唯一真值来源"的约定。
//
// 原生菜单的可行性已实测（`spikes/m2-menu`）：宠物窗口带着
// WS_EX_NOACTIVATE | WS_EX_TOPMOST，`Menu.popup()` 能正常弹出、能被真实点击、
// 交互后不再破坏输入通路。所以不需要自绘 HTML 菜单（那要扩大窗口 → 触碰命中区域）。
import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface PetMenuView {
  /** 宠物窗口当前是否可见。决定第一项是"隐藏"还是"显示"。 */
  visible: boolean;
  /** 当前缩放。 */
  scale: number;
  /** 开机自启勾选态（回读得到）。 */
  autoStart: boolean;
  /** 人可读的状态行，来自 StatusArbiter.state。 */
  statusLine: string;
  /**
   * 宠物名（`pet.json` 的 `displayName`，回落 id）。
   *
   * 托盘图标的悬停提示用它 —— 2026-09-22 用户要求把那里显示的 `desktop-pet`（产品/进程名）
   * 改成宠物的名字「淘淘」。**取自宠物包而不是硬编码**：换宠物包自动跟着变，
   * 与面板上的身份位（ADR 016 第 4 条）同一个来源。
   */
  petName: string;
  /**
   * 软件版本（`package.json` 的 `version`，主进程用 `app.getVersion()` 现读，ADR 041）。
   *
   * 只出现在**菜单里的一行只读小字**。刻意**不放进托盘的悬停提示** ——
   * 用户 2026-09-22 明确要求那里保持「淘淘 · 空闲」，不要掺版本号。
   * 也**不要**把它写进控制条面板：面板宽只有 260px，身份位后面塞不下。
   */
  version: string;
  /** 状态文件里现存的会话数。0 时"清空状态会话"置灰。 */
  sessionCount: number;
  /** 宠物包声明的默认缩放（"重置大小"的落点）。 */
  defaultScale: number;
  scaleRange: [number, number];
  scaleStep: number;
}

export interface PetMenuActions {
  toggleVisibility(): void;
  /** 唤出 / 收起悬浮控制条（M2 ④）。与宠物右键同一条路径。 */
  toggleControlBar(): void;
  /**
   * 清空状态文件里的全部会话（M2 ④ 人工验收后补）。
   *
   * 起因：状态文件是快照，上次运行留下的会话会在下次启动时被原样读回来，
   * 用户看到"一启动就显示某条会话在运行中、怎么喂都改不掉" —— 其实那条会话还留在文件里，
   * 而按会话清只能靠 `喂状态.bat` 的 7/9。给一个显式的一键清空入口。
   */
  clearSessions(): void;
  setScale(scale: number): void;
  resetScale(): void;
  setAutoStart(on: boolean): void;
  quit(): void;
}

const pct = (s: number) => `${Math.round(s * 100)}%`;

/** 缩放档位：按宠物包声明的 range/step 生成，当前值用 radio 勾上。 */
function scaleItems(view: PetMenuView, actions: PetMenuActions): MenuItemConstructorOptions[] {
  const [min, max] = view.scaleRange;
  const step = view.scaleStep > 0 ? view.scaleStep : 0.25;
  const items: MenuItemConstructorOptions[] = [];
  // 用整数步进累加，避免 0.1 类浮点误差累积出 0.7000000000000001
  const steps = Math.round((max - min) / step);
  for (let i = 0; i <= steps; i += 1) {
    const s = Math.round((min + i * step) * 100) / 100;
    items.push({
      label: pct(s) + (s === view.defaultScale ? '（默认）' : ''),
      type: 'radio',
      checked: Math.abs(s - view.scale) < 0.001,
      click: () => actions.setScale(s),
    });
  }
  return items;
}

export function buildPetMenuTemplate(
  view: PetMenuView,
  actions: PetMenuActions,
): MenuItemConstructorOptions[] {
  return [
    // 状态行：只读展示。（原「快捷键：…」只读行随全局快捷键一起删除，ADR 032。）
    { label: `状态：${view.statusLine}`, enabled: false },
    // 版本行：与上面那条状态行同类 —— 只读信息行。（原生菜单不支持字号，
    // `enabled: false` 的置灰效果就是这里最接近"小字"的表达。）
    // 放在**最上方**而不是最下方：它属于"读一眼就走"的信息区，
    // 而下面每一项都是**动作**，退出必须留在最后一项（ADR 034 第 1 条已拍板）。
    { label: `版本：${view.version}`, enabled: false },
    { type: 'separator' },
    { label: view.visible ? '隐藏宠物' : '显示宠物', click: () => actions.toggleVisibility() },
    { label: '控制条', click: () => actions.toggleControlBar() },
    { label: '宠物大小', submenu: scaleItems(view, actions) },
    {
      label: '重置大小',
      // 已经是默认值时置灰，避免"点了没反应"的疑惑
      enabled: Math.abs(view.scale - view.defaultScale) > 0.001,
      click: () => actions.resetScale(),
    },
    { type: 'separator' },
    // 一键清掉状态文件里的残留会话：状态文件是快照，上次运行留下的会话会在下次启动时
    // 照原样显示出来（用户实测困惑："一启动就显示某条会话在运行中，怎么喂都改不了"）。
    {
      label: `清空状态会话${view.sessionCount > 0 ? `（${view.sessionCount} 条）` : ''}`,
      enabled: view.sessionCount > 0,
      click: () => actions.clearSessions(),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: view.autoStart,
      click: (item) => actions.setAutoStart(Boolean(item.checked)),
    },
    { type: 'separator' },
    // 退出必须一击到达、不做二次确认 —— 需要点两次才能退出的东西本身就是流氓特征
    { label: '退出', click: () => actions.quit() },
  ];
}

/** 在光标处弹出宠物菜单（右键用）。Electron 不传 x/y 即以当前光标位置弹出。 */
export function popupPetMenu(
  view: PetMenuView,
  actions: PetMenuActions,
  window: Electron.BrowserWindow,
): void {
  Menu.buildFromTemplate(buildPetMenuTemplate(view, actions)).popup({ window });
}
