# AGENTS.md

任何 agent 在本目录开工前，**先读 `PLAN.md`**（当前状态、下一步、挂起清单）。

**本文件是路由表，不是约束全集。** 硬约束已按主题分到 `docs/constraints/` ——
按下面这张表**只读与本次任务相关的那一两份**（此前 40 条全量堆在这里，每次开工都要读 17 KB）。

## 改了什么 → 读哪份 + 跑哪些判据

| 你要动的东西 | 读哪份约束 | 必跑的判据 |
|---|---|---|
| `pet.json` / `behavior-map.json` / 精灵图 / 行语义 / 动作外观 | `docs/constraints/pet-pack.md` | `node tools/check-pet-swap.mjs <包目录>`（**换宠物必跑**；工程根自己的由 ⓪d 自动跑） |
| **要做一只新宠物 / 换宠物包** | `docs/pet-pack-guide.md`（可执行的操作路径） | `python tools/make-tray-icon.py <包目录>` + `node tools/check-pet-swap.mjs <包目录>` |
| 窗口创建·显示·隐藏·移动·缩放、命中判定、控制条、定时器、指针事件 | `docs/constraints/window.md` | `spikes/m2-hittest`（**第二参数不能省**）/ `spikes/m2-menu/run-tray.mjs` / `spikes/m2-control/run.mjs` |
| 面板动作排 / 手动把玩（`kernel/manual-play.ts`、`desktop-pet.json → actions`） | `docs/constraints/behavior.md`（末节）+ `docs/constraints/window.md`（控制条那节） | `node tools/status-arbiter.test.mjs`（第 ⑰ 节）+ `spikes/m2-control/run.mjs control` |
| `src/kernel/status.ts` / `src/source/*` / 确认与消解 / `ready`·`needs-input` | `docs/constraints/status.md` | `node tools/status-arbiter.test.mjs` + `spikes/m3-ready-ack/probe-ack-revival.mjs`；动了出口再跑 `spikes/m3-ready-exit/run.mjs` |
| `tools/pet-hook*.mjs` / hook 映射层与安装器 / 状态源接线 | `docs/constraints/sources-hooks.md` | `node tools/codebuddy-hook.test.mjs`（70 项） |
| `src/kernel/behavior.ts` / `desktop-pet.json → behavior` | `docs/constraints/behavior.md` | `node tools/status-arbiter.test.mjs` + `node spikes/m3-behavior/run.mjs`（**不带** `--no-behavior`） |
| renderer / preload / 构建链 / 新写探针 / 量渲染结果 / `喂状态.bat` | `docs/constraints/build-probe.md` | **完整 `npm run build`**（只跑 `tsc` 不够） |

**每轮开工先确认三件事**（2026-09-28 补，都是本项目真实踩过的）：

- **`dist` 是不是本轮的** ⇒ `node tools/stamp-build.mjs --check`。不是就先 `node tools/run-build.cjs`。
  主单测的 ⓪ 节会替你拦，但**你会在被拦之前浪费一轮**。
- **刚删掉的功能，有没有探针还在调它的钩子** ⇒ `node tools/check-probe-hooks.mjs`。
- **要改的文件，有没有 ADR 说过"不要动"** ⇒ 查 `docs/decisions/INDEX.md`（它明确规定检索入口），
  再查对应 ADR 全文。**已决策的事不要再讨论。**

**两条跨主题的通用纪律**（不看上面也该记住）：

1. **平台行为一律用探针实测，不要推断** —— 本项目已有六次推断被实测推翻。
   报告里要区分"实测"与"推测"。
2. **凡是"位置类/兜底类"参数都要显式传入，不许让下游自己猜** ——
   拿不到就选择"不显示"，而不是显示在错的地方（ADR 021）。

**第三条是 2026-09-22 补的，与第一条同族：别拿"代理指标"顶替"那个结果本身"。**

3. **"发生了"不等于"表现对了"，且"有证据"不等于"证据属于这一次"。** 已有两次同形事故：
   **"进程消失"≠"退出干净"**（ADR 035）、**"动作演完了"≠"面板不再说它在演"**（ADR 038 ——
   收尾函数被一个 `if (!manualPlay) return` 提前返回，`refreshBar()` 从未执行，按钮一直亮着；
   而探针只查了"点下去有没有开始演"）。
   第三次是 2026-09-22 验证便携版时踩的：**读到的 `pet.log` 其实是上一轮留下的旧文件**
   （开头写着上一轮的工作目录），于是"几乎全绿"的验收结论**什么都没验**。
   ⇒ 两条自检：**（a）** 我要断言的这个量，用户真的会看到它吗？如果用户看的是另一个量，就得断言那个。
   **（b）** 我读的这份证据，怎么证明它是**本次**运行产生的？（比对 mtime / 看启动横幅的时间戳 /
   比对进程数）—— 否则"证据"与"过期的证据"长得一模一样。

**第四条是同日（第八次）补的，关于"写守卫"：**

4. **"写了一个守卫"不等于"守住了" —— 要守那个会在危险发生时变化的东西。** ADR 042：
   面板「⋯」菜单的关闭回调写的是 `if (!bar) return`，而 `bar` 是模块级变量、`destroy()`
   之后**仍然非空** ⇒ 守卫在真正危险的状态下**恒为假**，`isFocused()` 照样落在已销毁窗口上抛
   （用户点「退出」看到的就是它）。
   自检：**"我守的这个东西，会在危险发生时变吗？"**（`!bar` 不变 ⇒ 守不住；`isDestroyed()` 变 ⇒ 守得住）。
   配套做法：**判据下沉到资源自己身上**（谁拥有它，谁负责它的生命周期），**不要放在调用点** ——
   调用点会新增，资源只有一个。
   实测过的两个"销毁后调用即抛"：`BrowserWindow.isFocused()` → `Object has been destroyed`；
   `Tray.setToolTip` / `setContextMenu` → `Tray is destroyed`。
   另附一条排查方法：**堆栈被截断时，用函数名的出现次数反推定义点**
   （用户从 Electron 的错误框里能复制出来的行号对不上源码；本轮全靠"全仓只有一个 `callback`"定位）。

**第五条是 2026-09-28 补的，关于"判据报通过不需要真的验过"：**

5. **一份判据报"通过"，得能回答"它验的是哪一次"。** 审计（`docs/reviews/2026-09-28-全面代码复核.md`）
   查出三条同源的病：① `tools/status-arbiter.test.mjs` 的行为断言跑在 `dist/` 上，
   而**没有任何守卫保证 `dist/` 是本轮构建的** ⇒ 改完 `src` 不 rebuild 会得到
   「结构性断言全绿（新源码）+ 行为断言全绿（旧 dist）」的假全绿；
   ② 删功能时**调试钩子被静默删掉**，调用它的探针不是报红而是**跑不出任何证据**；
   ③ 入库证据里存在**内含 `[uncaught]` 却报 `PASS`** 的自相矛盾文件。
   ⇒ 主单测现有三道闸门（**前两道硬失败，退出码 2；第三道只 warn**）：

   | 节 | 查什么 | 失败时 |
   |---|---|---|
   | **⓪** | `dist/.build-stamp.json` 的 `src/` 内容哈希是否与当前 `src` 相符 | **拒绝运行** |
   | **⓪b** | 探针用到的每个 `dbg.*` 是否还在 `__petDebug` 桥上 | **拒绝运行** |
   | **⓪c** | 入库证据是否"内含未捕获异常却报 PASS" | **只 warn**（已列 §4 #17） |

   - **⓪ 用内容哈希而不是 mtime** —— mtime 在本项目骗过人一次
     （那批证据内容是 09-18 的、mtime 是 09-22 的），且 `git checkout` 会重写它。
     纪律 3(b) 问的是"这是不是**本次**产生的"，mtime 答不了，哈希能。
   - **⓪c 刻意不阻断**：已入库的污染证据只能靠**重跑探针**修（会启动 Electron，需用户确认）；
     做成硬失败会让主测试长期亮红，而**长期亮红的判据会被习惯性忽略**（§4 #16 记的就是这个过程）。
     ⇒ 判别标准：**能立即修的才做成阻断闸门，历史遗留的只做成提醒。**（ADR 048）
   - **删了功能就顺手跑 `node tools/check-probe-hooks.mjs`** —— 它不启动 Electron，比跑探针便宜得多。
     实测它当场多抓出一处审计漏掉的（`m2-control/probe-key-path.js`）。
   - **⚠️ 验证驱动脚本能否解析，用 `node --check`，不要 `import` 它** ——
     `spikes/*/run.mjs` 顶层就 `spawn` 了 `electron.exe`。2026-09-28 因此误跑过一次 GUI 探针。

**第六条是 2026-09-29 补的，关于"可塑性"：**

6. **换宠物是正式目标（ADR 049，取代 ADR 046 后半句）。** 用户要工程「完备且可塑性」。
   动手前核实发现**基础已经很齐**：`loadPack(packDir)` 收目录参数、`--pet=` 启动参数已存在、
   网格规格由 `spriteVersionNumber` 推导、**行号零硬编码**（全走 `behavior-map.json`）、
   路径穿越防护与契约校验器都在。⇒ **成本不在功能，在规范与判据。**
   已修的真 bug：**托盘图标原写死工程根**（而 `make-tray-icon.py` 开头就写着
   "换一只宠物包就该换一次图标"）⇒ 换包后托盘还是旧的脸**且无报错**。
   **新的静默失败点是 `loadPack` 自己的行为**：少配一个状态时它只 `warnings.push` 后跳过
   （`pack.ts:87`）⇒ **宠物静默少一个动作**；而它只强制要求 `idle`，
   **5 个业务状态**与**面板动作**全靠 `statusMap`/`actions` 指过去，少配同样不报错。
   ⇒ 新增 `tools/check-pet-swap.mjs`（不启动 Electron）专门堵这四个洞，接进主单测 ⓪d，
   **工程根自己也被体检** —— **自己过不了的判据没资格要求别人过。**
   **换宠物前先跑它，别用双击试错。**

## ⚠️ 看到“杂乱”想整理之前，先读这一段（2026-09-29 补）

用户不止一次提到「从外行人角度看仓库杂乱」。**核实后的结论是：那两个最显眼的“杂乱”都是有意保持的，
动它们会出事。** 别把本段当成“暂缓整理”—— 它就是最终结论。

1. **根目录 23 个文件，一个都别搬。** 它们互相咬着：`Windows桌面宠物开发方案.html` 引 `atlas-map.png`、
   `动画映射验证器.html` 用 CSS 引 `spritesheet.webp`、三个配置 JSON 互引且被 `src/` 运行时读。
   三个 `.bat` 更是**用户可见的交付面**（双击即用），不属于杂乱。
   ⇒ 逐条推导见 `PLAN.md` §5 与 ADR 048 末节。
2. **`spikes/` 下 118 个入库文件不能删。** 其中 42 份是判据产物，而
   **ADR 008 / 014 / 023 / 035 / 038 / 039 逐一点名了具体文件**作论证依据，
   `docs/constraints/window.md` 也直接读 `m2-hittest/fs-verify.json`。
   **“把可重跑产物移出版本库”不是清理，是切断决策链。** 已经 gitignore 的是**该 gitignore 的**
   （整屏截图会拍进桌面与账号信息，曾在公开仓库挂了 12 天，commit `8f682f5`；可重跑时序 payload）。
   **不要再往 `.gitignore` 里加 `spikes/**/*.json` / `*.out` / `*.log`。** ⇒ ADR 048。
3. **真要加东西**：进分区目录（`docs/` / `tools/` / `spikes/`），**不往根目录堆**（ADR 003）。
   `tools/` 已有一份五类索引 `tools/README.md`，加脚本时顺手更新它。

## 知识与文档在哪（不要再重新调研）

- 宠物包规格：用户级技能 `codex-pet-pack`（权威来源）。
- 完整设计：`Windows桌面宠物开发方案.html`（13 章）。
- 详细内容路由表：`PLAN.md` §0（先查那里，再决定读哪份）。
- 已经拍过的板：`docs/decisions/INDEX.md`（一行一条）→ 对应 ADR 全文。**已决策的事不要再讨论。**
- 渲染逻辑参考：`动画映射验证器.html`（帧率、锚点、状态映射已验证）。

## 会话协议

**开工**
1. 读 `PLAN.md`（§3 状态表 + §4 挂起清单）与本文件。
2. 按上面的路由表读对应的 `docs/constraints/*.md`。
3. 需要规格细节时读技能 `codex-pet-pack`；不确定工程结构时读 `docs/decisions/`。

**收工**（缺一不可）
1. 更新 `PLAN.md` §3 状态表与 §4 挂起清单（§7 只留最近三条变更，**完整叙述追加到 `docs/changelog.md`**）。
2. 本轮的"为什么这么决定"落一份 ADR 到 `docs/decisions/`（只增不改）。
3. 在 `journal/` 追加当日记录。
4. `git add -A && git commit -m "..."`（里程碑结束至少提交一次）。
5. **只要有用户能看见的改动（新功能 / 修复），就直接打包给他，不要问** ——
   用户唯一的验证途径是双击那个 exe；不打包等于本轮没交付（2026-09-22 用户明确要求）。
   命令：`node tools/make-portable.mjs --zip`（**先 `node tools/run-build.cjs`** ——
   打包脚本只复制 `dist/`，它自己不构建）。**打包前先关掉正在运行的便携版**。
6. **打包前先定版本号，并且自己定、说明理由**（ADR 045）—— 用户不需要记这件事，也不需要提醒你。
   **"一次交付 = 一个版本号"**：触发点是打包（= 用户会拿到新构建），不是 commit；
   一次交付里攒了多件事就按其中**最高的那类跳一次**。
   判断标准是"**对发布过的版本做了什么**"：**修 bug → PATCH**（`1.0.0 → 1.0.1`）｜
   **加用户可见的新东西 → MINOR**｜**弄坏 ADR 041 承诺范围内的兼容性 → MAJOR**｜
   文档 / 注释 / 单测 / 探针 / 内部重构 / 打包工具 → **不跳**。
   改完 `package.json` 后**四处派生值必须一起验**（exe 版本资源 / 日志横幅 / 托盘菜单那行小字 /
   zip 名与 README）—— 只改一处等于没改。
   **给发布提交打 `v<版本号>` 的轻量 tag 并推上去**（tag 名不带斜杠），否则事后无法回答
   "`1.0.0` 到底是哪份源码"。
   ⚠️ 已经发出去的版本号**不能回收**：`1.0.0` 永远代表"含『减少动态效果会冻结动画』缺陷的那一版"。
   **出现两个内容不同却同名同号的包，比版本号跳错更糟。**

## 离开前

把本轮的决策与进度写回 `PLAN.md`（见上方"收工"）。会话自身的记忆换会话即不可见，**未落盘等于没发生**。
