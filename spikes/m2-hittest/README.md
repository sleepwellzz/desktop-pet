# spikes/m2-hittest —— 命中区域、窗口尺寸、全屏恢复实测探针

**用途**：测量桌宠窗口"到底吃掉了哪些点击"、移动/隐藏显示之后窗口行为是否漂移。
这是目前唯一能给出可信答案的方法（`WindowFromPoint` 测不出分层窗口的穿透）。

## 探针清单

| 命令 | 测什么 |
|---|---|
| `node spikes/m2-hittest/run.mjs probe.js` | **命中区域**：逐点真实点击，输出命中图（被宠物吃 / 穿透到靶窗 / 应当是实体），并做一次真实拖动后复测 |
| `node spikes/m2-hittest/run.mjs probe-grow.js grow.json` | **窗口尺寸漂移**：连续移动窗口 6 次看 `getBounds`/物理矩形是否变大 |
| `node spikes/m2-hittest/run.mjs probe-fs-verify.js fs-verify.json` | **全屏恢复**：用外部进程（`fs-child.js`）触发真实全屏让位，测恢复后能否单击/拖动。**改完 hide/show 相关代码必跑这个** |
| `node spikes/m2-hittest/run.mjs probe-clean.js clean.json` | 干净版最小实验：不直接碰 `setIgnoreMouseEvents`，逐步定位"按钮事件进不去" |
| `node spikes/m2-hittest/run.mjs probe-fs-drag.js` / `probe-fs-deep.js` / `probe-hide-remedy.js` / `probe-toggle-poison.js` | 定位过程留档（hint 载荷比对、SendMessage 判别、补救动作矩阵、开关毒化） |

`run.mjs` 是外层驱动：GUI 子系统的 Electron 拿不到 stdout，所以它负责"启动 → 轮询产出文件 → 打印日志"，
并把整个流程压进一条命令（避开沙箱在命令结束后回收子进程）。

## 探针怎么工作

1. `require('../../dist/main/index.js')` —— 跑的是**真实应用**，同一份主进程/preload/渲染层。
2. 自己再开一个铺满显示器、`opacity: 0.10` 的**实心靶窗**（默认在宠物下方）。
3. 用 `user32.mouse_event` 注入**真实 OS 点击**，每个采样点同时读回：
   - 宠物渲染层是否收到 `pointerdown`（= 被宠物吃掉）
   - 靶窗是否收到 `pointerdown`（= 成功穿透）
   - 宠物画布当前帧在该点的 alpha（= "应当命中"的基准）
4. 采样前先 `force-prefers-reduced-motion` **冻结动画**，并**逐点刷新**基准快照 ——
   否则等于拿 A 帧的掩码判定 B 帧的点击，漏吃率会被放大 3 倍。
5. 结果写 JSON，同时落日志。

## 已知坑（都踩过，别再踩）

- **GUI 子系统进程的 stdout 拿不到**：前后台启动都会被静默脱离。所有输出必须落盘。
- **`SetCursorPos` 不产生 `WM_MOUSEMOVE`**：注入拖动必须用
  `mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, nx, ny, 0, 0)`，nx/ny 按虚拟屏 0..65535 归一化。
- **拿 HWND 走 `getNativeWindowHandle()` 转数字**最稳；`WindowFromPoint` 在这里返回 null。
- **别在探针里直接调 `setIgnoreMouseEvents`**：会打乱应用自己的记账，让后续结论失真
  （本轮为此重做了一次干净实验）。
- **判断"路由问题"还是"进程内问题"**：用 `SendMessage(hwnd, WM_LBUTTONDOWN, ...)` 直接发给顶层 HWND。
  能进渲染层 = Windows 路由问题；进不去 = Chromium 进程内问题。
- 靶窗需要约 10 秒"预热"才真正开始接收点击（早于此的采样会记成"都没收到"）。
- koffi 传结构体一律用 `Buffer` 手工解码（见 ADR 004、007）。

## 运行副作用（提前知道）

复测 `probe.js` / `probe-fs-verify.js` 会让鼠标自动移动并点击约 40 秒，屏幕上会短暂出现
一个 10% 不透明度的黑色靶窗（`probe-fs-verify` 还会短暂出现一个全屏测试窗口），结束时光标归位。
点击由靶窗吸收，不会误触桌面图标。
