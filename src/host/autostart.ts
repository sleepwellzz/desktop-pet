// 开机自启：走 Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
// （Electron 内置 API 封装），不落自定义文件、不写服务、不写计划任务 ——
// 这三样都是"被误判为流氓软件"的常见由头（PLAN §8）。
//
// **开发态必须显式给 path + args**：不传的话注册进去的是裸 `electron.exe`，
// 开机后只会启动一个空壳（不加载本应用），用户视角是"设了自启但没反应"。
// 打包后要按打包形态复核一遍（见 ADR 011 的遗留项）。
import { app } from 'electron';

/**
 * 注册表项要写的命令。
 *
 * 未打包（开发态）与已打包的形态**不一样**，这点实测过（`spikes/m2-menu/check-autostart-registry.mjs`
 * 直接读注册表核对）：
 *   - 开发态：`electron.exe <应用目录>` —— 必须带上应用路径，否则开机只会启动一个空壳；
 *   - 已打包：只有应用自己的 exe，**不能再带参数**（带上反而会把它当成要打开的文件）。
 * 2026-09-16 实测写出的项形如：
 *   `electron.app.Electron = "...\electron.exe" "...\desktop-pet"`（撤销后条目消失）。
 *
 * **关于值名的那半句话已被实测推翻（ADR 034，2026-09-22）**：这里原本写着
 * "值名里的 Electron 是未打包时的 app 名，打包后会变成 productName"。
 * **不成立** —— 便携版实测写出的值名仍是 `electron.app.Electron`，而
 * `resources/app/package.json` 里 `name: "desktop-pet"` 是**存在且正确**的，只是不起作用。
 * 即：**这个函数的入参（`{path, args}`）只决定命令，不决定值名**；值名来自别处
 * （大概率是 exe 的版本资源 ProductName，见 ADR 034 §4 的方案 C）。
 * 修到一半别把它"顺手改回"上面那句旧注释 —— 那是推断，不是事实。
 */
function loginItem(): { path: string; args: string[] } {
  return app.isPackaged
    ? { path: process.execPath, args: [] }
    : { path: process.execPath, args: [app.getAppPath()] };
}

/** 勾选态一律**回读**，不缓存 —— 用户可能从系统设置里直接改掉。 */
export function isAutoStartEnabled(): boolean {
  try {
    return app.getLoginItemSettings(loginItem()).openAtLogin === true;
  } catch {
    return false;
  }
}

export function writeAutoStart(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, ...loginItem() });
}
