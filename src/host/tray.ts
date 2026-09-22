// 系统托盘：宠物隐藏后用户唯一的入口（也是"这只宠物能被关掉"的可信证明）。
//
// 图标是脚本从图集生成的（`tools/make-tray-icon.py` → `assets/tray.ico`），
// 换宠物包重跑脚本即可，不手画。
import { Menu, Tray, nativeImage } from 'electron';
import { buildPetMenuTemplate, type PetMenuActions, type PetMenuView } from './pet-menu';

export interface TrayHandle {
  /** 重建菜单与提示文案。可见性/缩放/自启/状态变化后调用。 */
  refresh(): void;
  destroy(): void;
}

export function createTray(opts: {
  iconPath: string;
  getView: () => PetMenuView;
  actions: PetMenuActions;
  /** 单击托盘图标的行为，默认切换显示/隐藏。 */
  onClick?: () => void;
}): TrayHandle {
  const icon = nativeImage.createFromPath(opts.iconPath);
  if (icon.isEmpty()) throw new Error(`托盘图标读不出来：${opts.iconPath}`);
  const tray = new Tray(icon);

  const refresh = (): void => {
    const view = opts.getView();
    // 菜单每次重建而不是复用：勾选态（缩放档位、开机自启）与文案（隐藏/显示）都要现读，
    // 复用会让"点完之后勾没动"这类问题藏起来。
    tray.setContextMenu(Menu.buildFromTemplate(buildPetMenuTemplate(view, opts.actions)));
    // 悬停提示 = 宠物名 + 状态。**不再用 `desktop-pet`**（那是产品/进程名，2026-09-22 用户
    // 要求换成宠物的名字）——取自宠物包，换包自动跟着变。
    // 这里不另设一次初始 tooltip：`refresh()` 紧接着就会调用，两处写同一个值只会让
    // 下一个人不确定该改哪一处。
    tray.setToolTip(view.petName ? `${view.petName} · ${view.statusLine}` : view.statusLine);
  };

  // Windows 上左键单击托盘图标通常不弹菜单，正好用它做"收起/放出宠物"
  tray.on('click', () => { (opts.onClick ?? opts.actions.toggleVisibility)(); });

  refresh();
  return { refresh, destroy: () => tray.destroy() };
}
