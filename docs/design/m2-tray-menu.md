# M2 ② 托盘菜单与右键菜单 · 接口设计

- **状态**：⚗️ **待用户确认**（确认后落地实现，并把决策写成 ADR 011）
- **日期**：2026-09-16
- **目标**：补齐"用户能掌控这只宠物"的最小集合 —— 隐藏/显示、大小、开机自启、退出。
  其中**"退出"是硬性验收项**：不能被误判为流氓软件（PLAN §8）。

## 1. 范围

来自 `desktop-pet.json` 的 `interaction`：

| 菜单项 | 本轮 | 说明 |
|---|---|---|
| 隐藏宠物 / 显示宠物 | ✅ | 只隐藏窗口，进程常驻，托盘还在 |
| 宠物大小（子菜单） | ✅ | 0.5 / 0.75 / 1.0 / 1.25 / 1.5（暂定，见 §7 待确认） |
| 重置大小 | ✅ | 删除偏好，回到 `render.defaultScale`（0.7） |
| 开机自启（勾选） | ✅ | 走 Windows 注册表 Run 项，勾选态**回读**不缓存 |
| 退出 | ✅ | 硬性验收项 |
| 切换宠物 | ❌ 建议推迟 | 见 §2 |
| 宠物管理 / 设置（独立窗口） | ❌ | 窗口不存在，本轮不做 |
| 气泡与角标 | ❌ | 留给 ③ 控制条那一轮（要改窗口尺寸） |

**托盘菜单与宠物右键菜单共用同一套模板**，唯一差异是第一项文案：
托盘的"显示/隐藏宠物"会随当前可见性变化，右键菜单里恒为"隐藏宠物"（右键时宠物必然是可见的）。

## 2. 为什么建议推迟"切换宠物"

- 本机 `~/.codex/pets/` 目前只有 1 只真实宠物包（`taotao`），需求价值低；
- 它需要一个独立的能力集：扫目录 → 列包 → 校验 → **热切换整个 pack**（窗口尺寸、状态表、
  sheet data URL、精灵图标全量重建）→ 失败回退。是本轮最大的一块新逻辑；
- 本轮已经有三类改动（新增宿主模块、改缩放、动注册表），再叠"热切换"风险不可控。

建议单独作为一轮（M2 ④）。

## 3. 新增/改动的模块

全部落在**宿主适配层**（ADR 001：内核与状态层不碰 Electron）：

```
src/host/tray.ts           托盘图标与菜单；refresh() 重建（勾选态/文案变化）
src/host/context-menu.ts   宠物上右键 → 弹出同一套菜单
src/host/autostart.ts      开机自启：写 / 回读 / 撤销
src/host/prefs.ts          用户偏好持久化（缩放）
src/host/overlay-window.ts 【改】增加 setScale()：改窗口尺寸并保持锚点
src/shared/ipc.ts          【改】新增 pet:context-menu 通道
src/main/index.ts          【改】装配"单一动作表"，托盘与右键菜单共用
```

## 4. 核心接口

```ts
// src/host/prefs.ts —— 用户偏好。读不到/损坏一律回落默认值，不抛异常。
export interface Prefs { scale?: number }
export function loadPrefs(): Prefs;
export function savePrefs(patch: Partial<Prefs>): void;   // 临时文件 + rename 原子替换

// src/host/autostart.ts —— 勾选态一律回读，不缓存（用户可能从系统设置里直接改）
export function isAutoStartEnabled(): boolean;
export function setAutoStart(on: boolean): void;

// src/host/tray.ts
export interface PetActions {                 // 主进程唯一动作表，菜单只做转发
  toggleVisibility(): void;
  setScale(scale: number): void;
  resetScale(): void;
  setAutoStart(on: boolean): void;
  quit(): void;
}
export interface PetViewState {               // 菜单渲染所需的一切，全部现读
  visible: boolean;                           // 宠物窗口是否显示
  scale: number;                              // 当前缩放
  autoStart: boolean;
  statusLine: string;                         // 取自 StatusArbiter.state，不另算一份
}
export function createTray(opts: {
  iconPath: string;
  actions: PetActions;
  getView: () => PetViewState;
}): { refresh(): void; destroy(): void };
```

`getView()` 由主进程注入，直接读 `arbiter.state` / overlay / prefs / autostart ——
延续 ADR 010 的"仲裁器是唯一真值来源"，菜单不做第二份状态计算。

右键菜单通道：

```ts
// 渲染层 → 主进程：光标在宠物实体上按下了右键
// 不带坐标：让 Electron 在光标处弹出（popup 不传 x/y 即用光标位置）。
'send pet:context-menu'
```

触发点在**渲染层**：窗口常态整窗穿透、命中与否由渲染层的 alpha 判定决定（ADR 008），
只有渲染层知道"这一下右键到底落在宠物身上还是空白处"。主进程只负责弹菜单。

## 5. 两个必须守住的技术约束

### 5.1 显示/缩放必须复用 ADR 009 修好的恢复通路

ADR 009：`hide()` → `show()` 之后 Windows **不再把真实鼠标按钮事件路由到该窗口**
（移动事件正常），唯一可靠恢复是 `webContents.reload()` + 强制重报命中 + 重推状态。

因此抽出唯一一个 `resumePet()`，托盘显示、右键显示、全屏让位恢复**三处共用**：

```
overlay.show()                      // showInactive + pinContentBounds
overlay.reload()                    // 重建渲染层输入通路
  ↳ 渲染层 ready 时：resetToIgnore → init → pointerHint(force) → pushStatus(replay)
```

**任何地方都不许再单独写 `win.show()`。**

### 5.2 缩放变更的窗口处理

- 尺寸 = `round(cell.width × scale) × round(cell.height × scale)`，一律用 `setContentBounds`
  并显式复位内容尺寸（ADR 008：`setPosition` 在 150% 缩放下每次长 1 DIP）；
- **锚点策略：保持窗口底边中点不动**，宠物像站在原地长大/缩小；再夹进当前显示器工作区，
  不能把宠物推到屏幕外；
- 缩放后必须重发 `init`（渲染层按 `payload.scale` 设 canvas 尺寸与命中映射）→ 复用 reload，
  顺带把 5.1 的通路一起走掉。

## 6. 开机自启的实现要点

- 用 `app.setLoginItemSettings` / `getLoginItemSettings`，走注册表 `HKCU\...\Run`，不落自定义文件；
- **开发态（未打包）必须显式给 `path` + `args`**，否则注册进去的是裸 `electron.exe`，
  开机后什么都不会发生：`{ path: process.execPath, args: [app.getAppPath()] }`；
  打包后按打包形态复核一遍（留待 M3 打包时验证）；
- 验证用 `getLoginItemSettings().openAtLogin` **回读**；
  本机 `reg.exe` 被安全策略禁止调用，第二来源核对改用 PowerShell
  `Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`（若同样受限，就只认 API 回读并如实标注）。

## 7. 退出（硬性验收项）

```
quit(): statusSource.stop() → tray.destroy() → app.quit()
```

- 托盘与右键菜单里都必须能一击到达，文案就叫"退出"，不做二次确认（用户要求两次点击的退出本身就是流氓特征）；
- 检查 `window-all-closed` 不会抢先 `app.quit()` 造成"隐藏后进程莫名消失"；
- 验收判据：点"退出"后进程真的消失（探针里核对 PID）。

## 8. 验证计划

| # | 手段 | 验什么 |
|---|---|---|
| 1 | `spikes/m2-menu/probe-menu-native.js`（新写，先跑） | **焦点:false + 透明 + 分层窗口上，原生菜单能否弹出并点击** —— 纯平台行为，不许推断 |
| 2 | `node spikes/m2-hittest/run.mjs probe-fs-verify.js`（回归） | 托盘隐藏/显示走同一条通路，没打断 ADR 009 的修复 |
| 3 | `spikes/m2-menu/` 增：托盘隐藏 → 显示 → 真实单击/拖动 | 隐藏显示往返后宠物仍可点可拖 |
| 4 | 缩放切换探针 | 内容区尺寸 = round(192×s)×round(208×s)；命中仍只吃精灵轮廓；不越界 |
| 5 | 自启写入 → 回读 → 撤销 | 勾选态正确，撤销干净 |
| 6 | 进程核对 | 点"退出"后 PID 消失 |
| 7 | 人工验收 | 照 ① 的流程：托盘菜单点一遍 + 宠物上右键点一遍 + 退出 |

## 9. 需要确认的三点

1. **切换宠物是否本轮做** —— 建议不做，单独一轮（§2）。
2. **右键菜单：先探针验原生菜单，还是直接自绘 HTML 菜单** —— 建议先探针（原生零布局成本、
   系统观感、不碰命中区域；自绘要改窗口尺寸，直接触碰 ADR 008/009 的边界）。
3. **缩放档位范围** —— `desktop-pet.json` 写着 0.5–3.0 步进 0.25；建议收到 **0.5–1.5**，
   理由是 3.0 时窗口内容区 576×624 DIP，观感夸张且命中判定在超大矩形上做逐点采样没有收益。

## 10. 本设计**不做**的事（写清以免误解已实现）

- 不实现多宠物；不做设置窗口/宠物管理窗口；不画气泡与角标；
- 不引入全局快捷键（属 ③）；
- 不改任何状态层/仲裁逻辑。
