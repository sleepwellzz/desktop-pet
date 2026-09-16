# spikes/m2-status —— 状态链路端到端探针

**用途**：验证「状态源 → 仲裁器 → 动画」这条链真的通到了画面上。
M2 第一步的核心风险是"没有真实状态源，产品空转"，这个探针就是那条链的验收手段。

## 命令

```bash
# 离线单测（不起窗口，虚拟时钟，58 项断言）
node tools/status-arbiter.test.mjs        # 或 npm run test:status

# 端到端（拉起真实应用 + 真实 hook CLI，约 45 秒，屏幕右下角会出现桌宠）
node spikes/m2-status/run-status-e2e.mjs  # 或 npm run e2e:status
```

## 怎么取证

"渲染层收到了状态"不足以证明"画面真的换了"。所以探针在渲染层给
`CanvasRenderingContext2D.prototype.drawImage` 打补丁，回读 `sy / 208` ——
即**当前正在绘制的帧行号**。行号就是精灵图的语义坐标：

| 行 | 0 | 3 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|
| 状态 | idle | waving | failed | waiting | running | review |

于是"期望行出现过"= 动画确实切过去了，不依赖任何日志自述。

## 时间线

驱动扮演 agent，用**真实 hook CLI**（`tools/pet-hook.mjs`）写状态文件，
每个状态留 1800ms 窗口，核对窗口内实际出现的行号：

| 注入 | 期望行 | 验的是什么 |
|---|---|---|
| running | 7 | 处理中 |
| needs-input | 6 | 等待输入（并进入粘滞） |
| `--clear` | 0 | 会话被移除 → 补 idle 收尾 |
| ready | 3 → 8 | 一次性动作 + `then` 落点（挥手后落到 review） |
| blocked | 5 | 受阻（趴卧） |
| idle | 0 | 任务结束 |

## 已知坑（都踩过）

- **探针要等 Electron 起来才会截断日志**。驱动必须先把旧日志删掉，并用运行标识
  （`PET_E2E_RUN`）确认就绪行出自本次运行 —— 否则会读到上一次运行的残留日志，
  在探针还没开始采样时就动手注入（实测注入比采样早 3.7 秒，前两步全丢）。
- **桌宠是 detached 启动的**，`child.kill()` 带不走它下面的进程。收尾要用
  `taskkill /PID <pid> /T /F`。**绝不能按镜像名杀 `electron.exe`** —— WorkBuddy 自身也是 Electron。
- 残留实例会继续读写同一个状态文件，污染下一次运行。
- `idle` 事件**不产生状态切换**（输出本来就是 idle），所以断言必须挂在真实切换上。
