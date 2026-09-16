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
  tray.setToolTip('desktop-pet');

  const refresh = (): void => {
    const view = opts.getView();
    // 菜单每次重建而不是复用：勾选态（缩放档位、开机自启）与文案（隐藏/显示）都要现读，
    // 复用会让"点完之后勾没动"这类问题藏起来。
    tray.setContextMenu(Menu.buildFromTemplate(buildPetMenuTemplate(view, opts.actions)));
    tray.setToolTip(`desktop-pet · ${view.statusLine}`);
  };

  // Windows 上左键单击托盘图标通常不弹菜单，正好用它做"收起/放出宠物"
  tray.on('click', () => { (opts.onClick ?? opts.actions.toggleVisibility)(); });

  refresh();
  return { refresh, destroy: () => tray.destroy() };
}
