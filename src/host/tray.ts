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

  /**
   * 销毁之后不许再碰它。
   *
   * `Tray` 的 `setContextMenu` / `setToolTip` 在销毁后会抛
   * `TypeError: Object has been destroyed`（同类坑见 ADR 035 / 042）。
   * 而"销毁之后还会有人调 refresh"是**真实存在**的路径：退出时 `quit()` 先
   * `void statusSource?.stop()`（异步），随后就 `tray.destroy()` —— 一次迟到的状态推送
   * 仍会经 `refreshMenu()` 打到这里。
   *
   * 判据放在**资源自己身上**而不是每个调用点：谁拥有它，谁负责它的生命周期。
   * 这与主进程里那些 `isDestroyed()` 守卫是同一条纪律。
   */
  let dead = false;

  const refresh = (): void => {
    if (dead) return;
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
  tray.on('click', () => {
    if (dead) return;
    (opts.onClick ?? opts.actions.toggleVisibility)();
  });

  refresh();
  return {
    refresh,
    destroy: () => {
      dead = true;      // 先置位再销毁：反过来的话，销毁与"下一次 refresh"之间仍有缝
      tray.destroy();
    },
  };
}
