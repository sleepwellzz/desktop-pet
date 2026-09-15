# M0 窗口层技术验证

证明三件事能否做到：① 逐像素点击穿透（宠物透明区域把点击让给下层应用）；② 点击宠物不夺焦点；③ 全屏应用出现时自动让位。

退出判据：三项全过。结论见文末，并已回写 `../../docs/decisions/004-M0窗口层验证结论.md`。

## 怎么跑

```bash
# 1) 依赖（约 120MB，主要来自 Electron）
npm install                       # 若 Electron 二进制没下来，补跑：
node node_modules/electron/install.js

# 2) 纯 Win32 层验证（不开 Electron，跨进程、全自动）
node probe/hit-test-probe.js      # 逐像素穿透 + 不夺焦点
node probe/fullscreen-probe.js    # 全屏检测

# 3) Electron 宿主验证
npm run electron                          # 可视化 HUD，人工点两下
npm run electron -- --self-test           # 自动点击测试
npm run electron -- --self-test --hit-test   # 附带 WndProc 子类化对照
```

> **注意**：本会话环境里 `ELECTRON_RUN_AS_NODE=1`（宿主 WorkBuddy 自身是 Electron 应用），
> 直接跑 electron 会退化成纯 Node 模式、`require('electron')` 返回字符串。
> 上面的 npm script 不受影响；手工调二进制时需先 `unset`/删除该环境变量。
> 另：路径含空格时不要用 `shell: true` 调 electron.exe，参数会被截断。

## 文件

| 文件 | 作用 |
|---|---|
| `probe/win32.js` | koffi 的 Win32 绑定与工具（建窗、分层绘制、模拟点击、全屏检测） |
| `probe/target-window.js` | 靶窗口**子进程**：不透明可激活窗口，记录点击与激活状态 |
| `probe/hit-test-probe.js` | 主探针：拉伸分层窗口做穿透/夺焦点实验，两种模式对照 |
| `probe/fullscreen-probe.js` | 拉起铺满显示器的窗口，看检测是否翻转 |
| `host/win32-host.js` | Electron 宿主适配层雏形（改样式、装命中测试、查全屏） |
| `main.js` / `preload.js` / `renderer/` | Electron 示例：透明置顶窗口 + 精灵渲染 + HUD |
| `probe/_spike-*.js` | koffi 可行性小试验（回调作 WNDPROC、建窗变量排查），保留作踩坑证据 |

## 结论

**三项全部通过，且走的是最省事的一条路。**

| 判据 | 结果 |
|---|---|
| 逐像素穿透 | ✅ 透明区域点击落到**另一个进程**的窗口；不透明区域由宠物吃掉 |
| 不夺焦点 | ✅ 点击后前台窗口不变，`WS_EX_NOACTIVATE` 生效 |
| 全屏让位 | ✅ 铺满显示器的窗口出现时检测翻转 true，撤掉后回落 false |

### 关键发现

1. **不需要 `WM_NCHITTEST`，也不需要 `setIgnoreMouseEvents`。**
   `WS_EX_LAYERED` 窗口配合逐像素 alpha，Windows 原生就做逐像素命中测试：alpha=0 的像素把鼠标消息让给下层窗口，**跨进程也成立**。
   Electron 的 `transparent: true` 窗口已经带 `WS_EX_LAYERED`，因此开箱可用。

2. **Electron 自己就把三个扩展样式都设好了**（`transparent` + `alwaysOnTop` + `focusable: false`）：
   实测 `exStyleBefore = 0x08080008` = `NOACTIVATE | LAYERED | TOPMOST`。
   手动 `SetWindowLongPtr` 只需补 `WS_EX_TOOLWINDOW`（藏出任务栏，Electron 另有 `skipTaskbar`）。

3. **koffi 在 Electron 44 下能正常加载**（Node v24.21.0 / ABI 兼容，未触发重编译）。

4. **但别用 koffi 子类化 `GWLP_WNDPROC`。**
   实测 `SetWindowLongPtr` 返回成功（非 0），但回调**一次都没被调用**（`hitTestCount = 0`），
   并且窗口行为变成**整窗穿透**——连不透明区域也不再接收点击。
   最可能的解释：Chromium 的窗口消息在非 Node 线程上派发，koffi 无法在该线程回调 JS，
   于是 `WM_NCHITTEST` 拿到默认返回值 0（`HTNOWHERE`，等于"没点中"），整窗穿透。
   **结论：这条路在 Electron 下不可用，且是静默失效（不报错、只表现为行为异常），务必避开。**

5. **M1 因此不需要 alpha 掩码 IPC**：不需要把渲染层的 alpha 掩码回传主进程做采样，省掉每帧几十 KB 的传输。

### 踩坑清单（复用时避开）

- koffi 3.x **没有 `koffi.callback`**，直接传 JS 函数；`koffi.register(fn, ptr)` 返回跳板地址（bigint），
  结构体里的函数指针字段要写成 `'void *'` 并传这个地址，直接传函数会报 "non-registered callback"。
- WndProc 里**必须**把未处理消息交给 `DefWindowProcW`。返回 0 会让 `WM_NCCREATE` 否决建窗，
  表现为 `CreateWindowEx` 返回 null 且 `GetLastError` 是陈旧的 126（极具误导性）。
- 带 `_Out_` 标注的结构体参数，koffi 会把入参清零（`MONITORINFO.cbSize` 变 0 → 错误 87）。
- 嵌套结构体（如 `MONITORINFO.rcMonitor`）**不会回写**到 JS 对象：传 Buffer 手工解。
- Node 默认 DPI 无感知、Electron 默认 DPI 感知，两边屏幕坐标差一个缩放系数。
  靶窗口进程必须先 `SetProcessDpiAwarenessContext(-4)` 拉齐，否则点击落点整体偏移。
  本机主显示器 2560×1600 @150%，虚拟化后 1707×1067。
- 后建的置顶窗口会盖在先建的置顶窗口上：靶窗口就绪后要把宠物窗口重新顶到最上层再测。
- 全屏检测**不要**用 EnumWindows 扫描兜底：`Microsoft Text Input Application` 等系统窗口恒为"覆盖显示器"状态，误报严重。
  判据用「前台窗口矩形 ⊇ 显示器矩形」为主，`SHQueryUserNotificationState == RUNNING_D3D_FULL_SCREEN` 为辅。
