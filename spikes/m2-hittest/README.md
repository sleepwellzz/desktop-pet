# spikes/m2-hittest —— 命中区域与窗口尺寸实测探针

**用途**：测量桌宠窗口"到底吃掉了哪些点击"，以及移动窗口后窗口矩形会不会漂移。
这是目前唯一能给出可信答案的方法（`WindowFromPoint` 测不出分层窗口的穿透）。

两个探针：

| 命令 | 测什么 |
|---|---|
| `node spikes/m2-hittest/run.mjs probe.js` | 逐点真实点击，输出命中图（被宠物吃 / 穿透到靶窗 / 应当是实体），并做一次真实拖动后复测 |
| `node spikes/m2-hittest/run.mjs probe-grow.js grow.json` | 连续移动窗口 6 次，看 `getBounds` / 物理矩形是否漂移 |

## 探针怎么工作

1. `require('../../dist/main/index.js')` —— 跑的是**真实应用**，同一份主进程/preload/渲染层。
2. 自己再开一个铺满显示器、`opacity: 0.10` 的**实心靶窗**（默认在宠物下方）。
3. 用 `user32.mouse_event` 注入**真实 OS 点击**，每个采样点同时读回：
   - 宠物渲染层是否收到 `pointerdown`（= 被宠物吃掉）
   - 靶窗是否收到 `pointerdown`（= 成功穿透）
   - 宠物画布当前帧在该点的 alpha（= "应当命中"的基准）
4. 采样前先 `force-prefers-reduced-motion` **冻结动画**，并**逐点刷新**基准快照 ——
   否则等于拿 A 帧的掩码判定 B 帧的点击，漏吃率会被放大 3 倍。
5. 结果写 `report.json`，同时落 `run.log`。

注意：靶窗需要约 10 秒"预热"才真正开始接收点击（早于此时刻的采样会记成"都没收到"）。
`probe.js` 的日志里 `都没收到` 若在拖动前那一轮偏大，先怀疑这一点。

## 已知坑（都踩过，别再踩）

- **GUI 子系统进程的 stdout 拿不到**：前后台启动都会被静默脱离。所有输出必须落盘，
  由 `run.mjs` 这个外层驱动轮询文件；它同时也是"一条命令内跑完"的保证。
- **`SetCursorPos` 不产生 `WM_MOUSEMOVE`**：注入拖动必须用
  `mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, nx, ny, 0, 0)`，nx/ny 按虚拟屏 0..65535 归一化。
- **拿 HWND 走 `getNativeWindowHandle()` 转数字**最稳；`WindowFromPoint` 在这里返回 null。
- koffi 传结构体一律用 `Buffer` 手工解码（见 `docs/decisions/004`、`007`）。

## 运行副作用（提前知道）

复测 `probe.js` 会让鼠标自动移动并点击约 40 秒，屏幕上会短暂出现一个 10% 不透明度的黑色靶窗，
结束时光标归位。点击全部由靶窗吸收（若靶窗正常），不会误触桌面图标。
