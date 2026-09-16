# spikes/m2-hotkey —— 气泡层 / 全局快捷键 / 文字观感的取证工程

结论已回写到 ADR 012（气泡层与快捷键）与 ADR 013（文字裁切与居中修正）。
本目录可丢弃，但**建议留着**：改了气泡外观或快捷键时用它做回归（PLAN §4 已把它列为必跑项）。

## 怎么跑

```bash
node spikes/m2-hotkey/run.mjs                    # 主探针：气泡 + 快捷键 + 文字几何 + 文字裁切差分
node spikes/m2-hotkey/probe-hotkey.js            # 单跑：本机哪些候选快捷键可用（需 electron 启动）
node spikes/m2-hotkey/probe-keyinject.js         # 单跑：分离实验 —— 注入击键能否触发全局快捷键
node spikes/m2-hotkey/check-feed-bat.mjs         # 检查 喂状态.bat 的交互菜单（含第二会话/角标）
```

`run.mjs` 每次会重置 `bubble-hotkey.log` / `bubble-hotkey.json` / `bubble-shot.png`。

## 主探针验什么（都用可观测结果判定）

| 用例 | 判据 |
|---|---|
| 快捷键 | **注入真实击键**（`keybd_event`）后宠物可见性翻转，不是调内部函数 |
| 气泡显示 | 读气泡页面里**真实渲染出的文本**，不是"窗口存在" |
| 心跳 | 同状态再推一次，`hideAt` 必须不变（否则 hook 每次心跳都把气泡刷出来） |
| 常驻 | `needs-input` 2.5 秒后仍可见、`hideAt === null` |
| 角标 | 两个会话时页面里出现 `+1` |
| 跟随 | 拖动宠物后气泡窗口坐标随之改变 |
| 回归 | 气泡工作期间点宠物，渲染层 `pointerdown` 计数仍增加（ADR 008 的地盘） |
| **文字几何** | 左右余量差 ≤ 2px（居中） |
| **文字裁切** | 差分截屏量出的被裁像素数必须为 0（见下） |

## 关键做法：文字裁切用**差分截屏**量，不用字体公式

先记结论：**canvas 的 `fontBoundingBox*` 与 Chromium 排版用的度量不是同一套，
拿它反推是错的（实测给出假阴性：算出裁切 0，而像素证据显示字下缘被切）。**

判据改成量渲染结果本身：

1. `capturePage().toBitmap()` 取原始 BGRA（索引 3 是 alpha）；
2. 只扫 `document.getElementById('text')` 的**列带**（避开右侧角标的白字干扰），
   找"亮像素"（三通道均 > 180 = 正文文字）的**首次/末次行号**；
3. 再注入 `<style>#bubble{overflow:visible}#text{overflow:visible}</style>`，
   同一帧再截一次，重复第 2 步；
4. **两次行号之差 = 被裁掉的物理像素数**，容差 0。

这个判据与字体、引擎、DPR 都无关。若需要人眼核对观感，把 `bubble-shot.png`
放大 8 倍（最近邻）再看 —— 1 个物理像素的裁切在原始尺寸下几乎看不出来，放大后一目了然。

## 已知坑（都踩过）

- **`globalShortcut.register('Win+Alt+P')` 返回 true 但永不触发** —— Electron 的修饰键词汇表里
  Windows 键叫 `Super`，人话写法会静默失效（无返回 false、无异常）。注册前必须归一化。
  定位靠**分离实验**：先证明"注入击键本身能触发 `globalShortcut`"（`probe-keyinject.js`），
  排除环境因素，才敢断定是自己的注册写错了。
- **窗口标题由页面 `<title>` 决定**：`setTitle()` 会被覆盖，探针按标题找窗口时要按 `<title>` 的值找。
- **下发 32 DIP 高度会读回 38**（隐藏窗口首次显示时）。宽度不受影响。定位改用**实测高度**，
  以保证"离宠物 10 DIP"这个唯一的观感指标精确。
- **测 `喂状态.bat` 这类交互菜单不能用 `spawnSync(..., { input })`**：它在写完输入后立刻关闭 stdin，
  等价于"输入即刻 EOF"，既测不出"连按多次不退出"，还会让没有 EOF 保护的菜单**空转跑满一个核**
  （本项目第一版就撞上了）。正确做法见 `check-feed-bat.mjs`：`spawn` 起进程后
  **延时逐行写 stdin 且先不 end()**，最后再 end；`child.on('exit')` 要在 spawn 之后立刻注册。
- **探针启动的 Electron 是 detached 的**，`child.kill()` 带不走它；收尾用
  `taskkill /PID <pid> /T /F`，**绝不能按镜像名杀 `electron.exe`**（WorkBuddy 自身就是 Electron）。
