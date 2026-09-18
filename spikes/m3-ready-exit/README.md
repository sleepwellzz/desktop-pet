# spikes/m3-ready-exit

**问题**：`ready`（结果未读）是一个没有出口的状态 —— 一次 `Stop` 事件就让宠物把小厨师姿态
摆到 15 分钟静默兜底为止。用户 2026-09-18 报告："在我打字的这个过程之中，并没有任何 agent
在跑，但是它依然是小厨师在炒菜的这个动画状态。"

**做法**：给仲裁器加一条 `ready` 的到点收敛（`readyTimeoutMs`，默认 60 秒，见 ADR 021）。
本探针验的是**渲染层真的跟着换帧**，不只是仲裁器的输出变了。

## 为什么必须做真实窗口探针

单测（`tools/status-arbiter.test.mjs` ⑨b）只能证明**仲裁输出**从 `ready` 变成 `idle`。
中间还隔着两处会让状态"看起来生效、其实没生效"的接缝：

- `onStatus` 的一次性动作保护（`if (player.isOneShot) return`）—— 状态变了但被挡住不切；
- `reconcileStatus` 的每帧收敛 —— 收敛目标算错就会一直画错的行。

本项目"状态层单测全绿、屏幕上却没变"踩过不止一次，所以这一层必须实测。

## 取证手段

与 `spikes/m2-status/probe-status-e2e.js` 相同：给 `CanvasRenderingContext2D.prototype.drawImage`
打补丁，回读 `sy / 208` = **当前实际绘制的帧行号**。行号是精灵图的语义坐标：

| 行 | 语义 |
|---|---|
| 0 | `idle`（待机） |
| 3 | `waving`（挥手致意，`ready` 的过渡） |
| 8 | `review`（小厨师，`ready` 的落点） |

行号出现过就是"动画确实切过去了"的硬证据，**不依赖任何日志自述**。

## 跑法

```bash
node spikes/m3-ready-exit/run.mjs
```

约 20 秒（含 Electron 启动）。会弹一个桌宠窗口，跑完自动杀掉自己那条进程树。

## 判据

把采样点按注入时刻分成两段（`--ready-ms=4000`，所以"通报期内" = 4 秒，"到期后" = 之后 8 秒）：

1. **通报期内必须画到第 8 行** —— 否则 `ready` 根本没落到小厨手上；
2. **到期后不得再出现第 8 行** —— **这条是全部要害**。没有它，探针在"缺陷仍然存在"时
   会照样通过；
3. **到期后应落回第 0 行** —— 否则宠物松手后停在了别的地方。

## 实测结果（2026-09-18）

```
通报期内（<4000ms）行号：[3, 8]     ← 挥手 → 小厨师
到期后（>4000ms）行号：[0]          ← idle

轨迹：0.1s:3 0.3s:3 0.4s:3 0.5s:3 0.6s:8 ... 4.2s:8 4.3s:0 ... 11.8s:0
      └── waving ──┘└──── review（小厨师）────┘└──── idle ────┘
```

**PASS**。`ready` 的通报时效在真实窗口上按预期生效。

## 接缝

探针靠 `--ready-ms=<毫秒>` 把通报时效压到 4 秒（默认 60 秒太长，等不起）。
这个参数**只覆盖数值**，不改任何逻辑分支 —— 验的仍是同一条代码路径。
与 `--no-status-source` / `--no-behavior` 是同一套路。

## 踩过的坑

**只跑 `tsc` 不够。** `tsc -p tsconfig.json` 只产出未打包的 `dist/main/preload.js`；
preload 是 **esbuild** 打包的（`npm run build:preload`）。只跑 `tsc` 之后启动会得到
`Unable to load preload script: module not found: ../shared/ipc`，渲染层 `exports is not defined`
完全不初始化 —— 表现为"0 个采样点"，很容易误判成探针逻辑坏了。
**跑任何真实窗口探针前先跑完整的 `npm run build`。**
