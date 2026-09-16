# spikes/m2-control · 悬浮控制条的窗口层验证（M2 ④）

结论已回写到 **ADR 014**，本目录按工程约定**可丢弃**（`run.mjs` 建议留着做回归 ——
改了控制条窗口的创建/显示/隐藏/移动都要重跑）。

## 怎么跑

```bash
node spikes/m2-control/run.mjs            # 两个探针全跑（约 2 分钟）
node spikes/m2-control/run.mjs key-path   # 只跑键盘路径与焦点
node spikes/m2-control/run.mjs control    # 只跑位置/内容/命令/样式位
```

每个探针都是"Electron 主进程即探针"（`require dist/main/index.js` + 注入 argv），
产出 `<名字>.json`（判定与数据）+ `<名字>.log`（主进程日志，含 `[probe]` 行）。

**跑之前先 `npm run build`**（或用 `node tools/npm-run.mjs build`）—— 探针读的是 `dist/`。

## 两个探针各验什么

| 探针 | 验的东西 | 为什么必须用真实探针 |
|---|---|---|
| `probe-key-path.js` | 悬停唤出**不抢焦点** / 快捷键唤出**抢焦点** / `hide→show` 往返后**键盘还进不进得来** / Esc 真的收起 | 本项目第一个可聚焦窗口，焦点行为是零经验区；键盘事件与鼠标按钮事件走**不同**的投递路径，ADR 009 的结论不能直接搬 |
| `probe-control.js` | 贴宠物下方 8 DIP + 水平居中 / 高度随会话数 / 面板内容与仲裁器一致 / 点「确认」解除粘滞 / 命令白名单（含**非法 id 与不存在的会话**）/ 拖动跟随 / 贴底边翻到上方 / `WS_EX_TOOLWINDOW` / `close-bar` 与 `hide-pet` | 位置算式、焦点、Alt+Tab 样式位都只有真实窗口能回答；DOM 点击走的是真实的 preload → IPC → 主进程路径 |

## 实测结论（2026-09-16，均 PASS）

- **悬停唤出 `isFocused()=false` 且注入按键收不到；快捷键唤出 `isFocused()=true` 且收得到** ——
  双路径显示按设计生效。
- **`hide()` → `show()` 往返后键盘照常投递** ⇒ 控制条**不需要 reload**。
  ADR 009 那个"隐藏后输入通路失效"是**鼠标按钮事件**的路由问题，键盘走另一条路径。
- 位置：宠物 134×146@790,437 → 面板 260×72@727,591，**下间距 8、水平偏差 0**；
  有 2 条会话时高度 128（30 + 2×28 + 42）。
- 命令：`scale-up` 把宠物从 134×146 变到 182×198，`reset-scale` 回到 134×146；
  未知 id 与不存在的会话都被忽略**并留下日志**。
- **`WS_EX_TOOLWINDOW` 必须自己设**：`skipTaskbar: true` 单独不够（见"踩到的坑"）。

## 踩到的坑（复现时注意）

1. **别用 `win.isVisible()` 判断"要不要 show"**。`win.show()` 之后同一 tick 内它可能仍返回
   `false`，紧跟其后的 `focus` 事件会让调用方再 show 一次 —— 第二次是 `showInactive()`，
   在抢焦点的路径上正好把焦点让出去。日志表现：一次唤出打出两条"控制条显示"。
   改用窗口的 `show`/`hide` 事件记账。
2. **测位置类规则之前先把宠物摆到屏幕中央**。宠物默认贴工作区右下角（margin 24 DIP），
   那里下方只剩 24 DIP、260 宽的面板在右侧会被夹取 —— 位置算式会（正确地）翻到上方并夹，
   量出来的是**别的规则**的结果。本探针第一版就是这样报了两条假失败。
3. **`skipTaskbar: true` 不加 `WS_EX_TOOLWINDOW`**（读回 `0x108`）。要读扩展样式位就用
   `GetWindowLongPtrW(hwnd, GWL_EXSTYLE = -20)`，HWND 从 `win.getNativeWindowHandle()`
   这段 Buffer 里读（长度为 8 时按 `readBigUInt64LE` 解）。
4. 探针注入的按键会进到当前**前台窗口**。悬停唤出后控制条没有焦点，注入的键会落到别处 ——
   这是预期行为，别把它当成"键盘坏了"。
