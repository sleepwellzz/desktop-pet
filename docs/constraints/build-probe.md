# 约束 · 构建链与探针纪律

> 2026-09-18 从 `AGENTS.md`「硬性约束」按主题拆出（内容未改，只搬位置）。
> 触发：改 renderer / preload、写新探针、要量渲染结果、改 `喂状态.bat` 时读这份。

## 构建链（preload 有两条工具链，别被诱饵文件骗了）

- **改 renderer/preload 只跑 `tsc` 不够 —— 而且 `dist/` 里有诱饵文件**。三个 preload 源码被两条工具链
  编译成**两个文件名**：`tsc`（`outDir` 直接映射）产出 `dist/main/preload-bar.js` / `preload-bubble.js`，
  esbuild 产出 `dist/main/bar-preload.js` / `bubble-preload.js`（**后者才是实际加载的**，见 `main/index.ts:434/515`）。
  **`tsc` 那两个名字全仓无任何引用、永不被加载**，但它们会随源码同步更新 —— 只跑 `tsc` 会看到
  "产物时间戳变了、内容也对了"的假象，而真正加载的那份没动。**认准 `bar-preload.js` / `bubble-preload.js`。**
  （ADR 023 已把三个 preload 从 `tsconfig.json` 排除，另建 `tsconfig.preload.json` 做 `noEmit` 检查 ——
  诱饵不再产出，但上面这条纪律仍然适用。）
- **改了 renderer 或 preload 之后必须跑完整 `npm run build`** —— preload 是 **esbuild** 打包的。
  症状很隐蔽：探针拿到 **0 个采样点**，日志里 `Unable to load preload script ... module not found`
  + 渲染层 `exports is not defined`（ADR 021 踩坑）。
- **`.bat` 必须纯 ASCII，而且"只改注释"也算改**：cmd 按 **GBK** 读 `.bat`，中文注释会被
  解析成命令执行（2026-09-18 实测：`'控制台' 不是内部或外部命令`，脚本 exit 1）。
  改完任何 `.bat` 都跑一次校验，别靠眼睛看：
  `node -e "const b=require('fs').readFileSync('<file>.bat');console.log([...b].filter(c=>c>127).length)"` ⇒ 必须是 **0**。
- **在 `dist/` 里 grep 中文会假失败**：esbuild 默认 `charset=ascii`，会把非 ASCII 字符转义成
  `\u5168...` 的形式。所以在产物里搜"全部已确认"要**先反转义再找**，否则会得出
  "这个功能没进产物"的错误结论（2026-09-18 就这么误判过一次）。
  HTML 是 `copy-assets` 直接复制的、不经过 esbuild，**中文原样保留** —— 两者表现不同。
- 这个环境的 Bash shim **没有 npm**：用 `node tools/npm-run.mjs build`（或 `typecheck` / `start`）。
  完整类型检查是 `npm run typecheck`（跑两份 tsconfig）。

## 探针纪律

- **写探针时，两次「输入」之间必须显式推进时钟 / 改变前置状态**，否则量到的是别的机制。
  本项目已**多次**栽在这上面：
  · `probe-ack-revival` 情形 2b 在同一次钟值上连发两条 `ingest`，量到的是 500ms **限流窗格**
    而不是被测的 **迟滞窗口**（断言假失败）；
  · M2 ④ 第一版探针没先把宠物从默认右下角挪到屏幕中间就测"贴宠物下方 8 DIP"，
    量到的是"翻到上方 + 夹进工作区"；
  · 单测里 `clock.advance()` 只改时钟值，**窗格由 `arb.tick()` 应用** —— 只推进不 tick 主状态不会变。
  **判据必须只让被测的那条规则生效。**
- **验证"路径 / 启动 / 引号"类问题时，必须用真实的含空格路径**（2026-09-21）。
  本工程在 `<工程目录>`，**中间有空格**，而且这是记录在案的已知坑。
  我验证 `Start-Process` 启动方式时用的是不含空格的临时目录，
  三轮全绿 —— 结果用户双击真脚本立刻报 `Unable to find Electron app at <工程目录>`
  （PowerShell 的 `-ArgumentList` **按空白拆分**参数）。
  **"判据的输入不代表生产"和"判据测的量不支持结论"是同一类错误**（ADR 029 §3/§6）。
  实用解法：能少传路径参数就少传 —— 用 `-WorkingDirectory` + `-ArgumentList '.'`，
  让工作目录去解析位置，整类引号问题一次消失。
- **判据必须覆盖你要证明的命题本身，而不是它旁边的一个量**（2026-09-21，本项目第三次栽）。
  实例：要证"关掉窗口后宠物能存活"，我测的却是"启动 electron 时会不会**新建**控制台" ——
  一个进程不新建控制台，完全可以**附加**到父进程已经有的那个。两个命题不同，
  而前者给出了一个"看起来很对"的数字（conhost 数量不变），把结论带偏了一整轮（ADR 029）。
  另一个同源坑：用 `AttachConsole(pid)` 判断"目标进程有没有控制台"**必须先 `FreeConsole()`**，
  否则它对每个进程都失败 —— **判据工具自己没校准，会稳定地给出错误答案**。
  落笔前先问一句：**这个数字能直接支持我的结论吗？** 不能就去测结论本身。
- **平台行为一律用探针实测，不要推断**。本项目已有**六次**"推断出来的结论被实测推翻"
  （逐像素穿透、补丁式 nudge、探针读到残留日志、canvas 字体度量 ≠ Chromium 排版度量、
  `skipTaskbar: true` 不加 `WS_EX_TOOLWINDOW`、**"重报 16 分钟后面板会清空"** —— 最后一条是推翻的
  自己的交接文档，不只是平台行为）。
  拿不准就写个最小探针跑一遍，并区分报告里的"实测"与"推测"。
- **要量渲染结果，就量渲染本身**（截屏差分 / DOM 盒子几何），不要用另一套引擎算出的近似值当判据
  （ADR 013：用 canvas 的 `fontBoundingBox*` 反推"文字被裁了多少"，实测给出假阴性 —— 算出 0，
  而像素证据显示字下缘被切）。**改了气泡外观（`renderer/bubble.html` / `bubble.ts`）必须跑**
  `node spikes/m2-hotkey/run.mjs` —— 其中的差分截屏会把"被裁了几像素、左右余量差多少"直接量出来。
- **改了 `喂状态.bat` 必须跑** `node spikes/m2-hotkey/check-feed-bat.mjs`；
  测这类交互菜单不能用 `spawnSync(..., {input})`（写完就关 stdin，等价于立刻 EOF），
  要 `spawn` + 延时逐行写 stdin 且先不关。
