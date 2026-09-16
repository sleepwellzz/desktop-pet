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
  /** 当前生效的全局快捷键；null 表示注册失败（此时如实展示"不可用"）。 */
  hotkey: string | null;
  /** 宠物包声明的默认缩放（"重置大小"的落点）。 */
  defaultScale: number;
  scaleRange: [number, number];
  scaleStep: number;
}

export interface PetMenuActions {
  toggleVisibility(): void;
  /** 唤出 / 收起悬浮控制条（M2 ④）。与全局快捷键同一条路径。 */
  toggleControlBar(): void;
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
    // 状态行与快捷键：只读展示。快捷键写在这里是因为它没有别的可见处 ——
    // 注册失败时更要让人看见"不可用"，否则用户按了没反应会以为程序坏了。
    // 后缀"（唤出控制条）"必须写实：M2 ④ 把这颗快捷键的语义从"切换宠物显示"
    // 改成了"唤出/收起控制条"（规格 §3.4），菜单不跟着改就是在说谎。
    { label: `状态：${view.statusLine}`, enabled: false },
    {
      label: `快捷键：${view.hotkey ? `${view.hotkey}（唤出控制条）` : '不可用（请从托盘或右键操作）'}`,
      enabled: false,
    },
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
