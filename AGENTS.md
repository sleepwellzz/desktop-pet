# AGENTS.md

任何 agent 在本目录开工前，**先读 `PLAN.md`**（当前状态、下一步、挂起清单）。

**本文件是路由表，不是约束全集。** 硬约束已按主题分到 `docs/constraints/` ——
按下面这张表**只读与本次任务相关的那一两份**（此前 40 条全量堆在这里，每次开工都要读 17 KB）。

## 改了什么 → 读哪份 + 跑哪些判据

| 你要动的东西 | 读哪份约束 | 必跑的判据 |
|---|---|---|
| `pet.json` / `behavior-map.json` / 精灵图 / 行语义 / 动作外观 | `docs/constraints/pet-pack.md` | — |
| 窗口创建·显示·隐藏·移动·缩放、命中判定、控制条、定时器、指针事件 | `docs/constraints/window.md` | `spikes/m2-hittest`（**第二参数不能省**）/ `spikes/m2-menu/run-tray.mjs` / `spikes/m2-control/run.mjs` |
| `src/kernel/status.ts` / `src/source/*` / 确认与消解 / `ready`·`needs-input` | `docs/constraints/status.md` | `node tools/status-arbiter.test.mjs` + `spikes/m3-ready-ack/probe-ack-revival.mjs`；动了出口再跑 `spikes/m3-ready-exit/run.mjs` |
| `tools/pet-hook*.mjs` / hook 映射层与安装器 / 状态源接线 | `docs/constraints/sources-hooks.md` | `node tools/codebuddy-hook.test.mjs`（70 项） |
| `src/kernel/behavior.ts` / `desktop-pet.json → behavior` | `docs/constraints/behavior.md` | `node tools/status-arbiter.test.mjs` + `node spikes/m3-behavior/run.mjs`（**不带** `--no-behavior`） |
| renderer / preload / 构建链 / 新写探针 / 量渲染结果 / `喂状态.bat` | `docs/constraints/build-probe.md` | **完整 `npm run build`**（只跑 `tsc` 不够） |

**两条跨主题的通用纪律**（不看上面也该记住）：

1. **平台行为一律用探针实测，不要推断** —— 本项目已有六次推断被实测推翻。
   报告里要区分"实测"与"推测"。
2. **凡是"位置类/兜底类"参数都要显式传入，不许让下游自己猜** ——
   拿不到就选择"不显示"，而不是显示在错的地方（ADR 021）。

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

## 离开前

把本轮的决策与进度写回 `PLAN.md`（见上方"收工"）。会话自身的记忆换会话即不可见，**未落盘等于没发生**。
