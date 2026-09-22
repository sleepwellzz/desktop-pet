// 开机自启：走 Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
// （Electron 内置 API 封装），不落自定义文件、不写服务、不写计划任务 ——
// 这三样都是"被误判为流氓软件"的常见由头（PLAN §8）。
//
// **开发态必须显式给 path + args**：不传的话注册进去的是裸 `electron.exe`，
// 开机后只会启动一个空壳（不加载本应用），用户视角是"设了自启但没反应"。
// 打包后要按打包形态复核一遍（见 ADR 011 的遗留项）。
import { spawnSync } from 'node:child_process';
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

// —— 旧值名的遗留条目迁移（ADR 035）——
//
// 2026-09-22 之前打的包没有改 exe 的版本资源，所以自启写在 `electron.app.Electron` 之下；
// 新版把 ProductName 改成了 desktop-pet，自启会写到 `electron.app.desktop-pet`。
// **旧条目不会自己消失** —— Electron 只认"自己该写的那个值名"，它看不见旧的，
// 于是系统启动列表里会留下两个都指向桌宠、又都看不懂的条目。
//
// 处理原则三条：
//   ① **只在旧条目确实指向本应用时才动它** —— 同名的值名可能属于机器上任何别的
//      便携 Electron 应用，误删别人的自启是不可接受的；
//   ② 迁移要**保住用户已开启的意图**（他勾过一次，升级后不该又变回关）；
//   ③ **幂等** —— 删掉之后 reg query 查不到，再跑一次自然什么都不做。
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LEGACY_VALUE = 'electron.app.Electron';

/**
 * 用 PowerShell 读写注册表，而不是 reg.exe：
 * ① reg.exe 在部分受限环境会被策略拦（本工程就踩到），PowerShell 则始终可用；
 * ② 读取单个值时要**直接取属性**而不是 `Get-ItemProperty` 的表格输出 —— 后者会把
 *    长值折行，解析出来的是断了的残缺内容（ADR 035 踩坑记录）。
 */
function regValue(name: string): string | null {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-ItemProperty -Path "${RUN_KEY}" -Name "${name}" -ErrorAction SilentlyContinue).'${name}'`],
  { encoding: 'utf8', windowsHide: true, shell: false });
  const out = (r.stdout || '').trim();
  return out ? out : null;
}

function regRemove(name: string): boolean {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Remove-ItemProperty -Path "${RUN_KEY}" -Name "${name}" -ErrorAction SilentlyContinue`],
  { encoding: 'utf8', windowsHide: true, shell: false });
  return r.status === 0;
}

export function migrateLegacyAutoStart(): void {
  if (process.platform !== 'win32') return;
  try {
    const cmd = regValue(LEGACY_VALUE);
    if (!cmd) return;                                      // 没有旧条目：无事可做
    // ① 只认指向**本应用**的条目 —— 这个值名可能属于机器上任何别的便携 Electron 应用
    if (!/desktop-pet/i.test(cmd)) return;
    console.log(`[pet] 发现旧的自启条目 ${LEGACY_VALUE}（指向本应用），迁移到新值名…`);
    if (!regRemove(LEGACY_VALUE)) {
      console.warn('[pet] 旧自启条目删除失败：保持原样，不做进一步动作');
      return;
    }
    writeAutoStart(true);                                  // ② 保住"用户已开启"的意图
    console.log(`[pet] 开机自启已迁移到新值名（回读=${isAutoStartEnabled()}）`);
  } catch (e) {
    // 迁移失败绝不能拖累启动 —— 用户还能手动勾
    console.warn('[pet] 旧自启条目迁移失败（不影响运行）：', e);
  }
}
