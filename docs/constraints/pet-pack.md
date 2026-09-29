# 约束 · 宠物包与资产

> 2026-09-18 从 `AGENTS.md`「硬性约束」按主题拆出（内容未改，只搬位置）。
> 触发：碰到 `pet.json` / `behavior-map.json` / `desktop-pet.json` / 精灵图 / 行语义 / 动作外观时读这份。

- `pet.json` 严格保持 Codex 原生格式，**不得写入任何自研字段**。扩展参数一律走 sidecar：
  `behavior-map.json`（行→状态→帧列）与 `desktop-pet.json`（运行时参数）。
- 锚点采用行级固定锚点（`groundY = 202` + 各状态 `offsetY`）。**禁止逐帧基线锁定**。
- 帧率与锚点由脚本自动生成，不要手写。
- 宿主适配层收窄为四个接口，宠物内核不 import 任何 Electron API。
- **描述动作外观时必须引用 `docs/status-reference.png`，不要凭业务状态名猜**。
  `running`（运行中）落在第 7 行，而这行的画面由宠物包作者决定 —— 淘淘 New 在这里画的是**生日姿态**。
  第一版验收说明把它写成"原地跑动"，被用户当场发现。换宠物包后重新生成该图。

## 换宠物（ADR 049）

- **可换宠物是正式目标**（取代 ADR 046 后半句「不打算做成可换宠物的平台」——
  **保留下来的**是前半句：对外定位仍是「这是叫淘淘的软件」）。
  动手前核实：基础已经很齐（`loadPack(packDir)` 收目录参数、`--pet=` 已存在、
  网格由 `spriteVersionNumber` 推导、行号零硬编码），成本**不在功能，在规范与判据**。
- **做完一只新宠物照 `docs/pet-pack-guide.md` 走**（本文只列硬约束，不重复指南）。
- **发布前必须跑 `node tools/check-pet-swap.mjs <包目录>`**。
  它堵的是 `loadPack` **会静默放过**的洞：
  ① 少配一个状态 → `pack.ts:87` 只 `warnings.push` 后跳过，**宠物静默少一个动作**；
  ② `loadPack` 只强制要求 `idle`，而 **5 个业务状态**与**面板动作**靠 `statusMap`/`actions` 指过去，
  少配 ⇒ 该状态永不出现且无报错；③ `statusMap` 悬空；④ 锚点不自洽（脚离地）。
  **主单测 ⓪d 节会对工程根自己跑一遍** —— 自己过不了的判据没资格要求别人过。
- **托盘图标必须随包走**：包内 `tray.ico` 优先，其次工程 `assets/tray.ico`，
  两者都无才降级并**打印提示**（静默用错的比没有更难排查）。
  生成：`python tools/make-tray-icon.py <包目录>`（读该包 `pet.json` 的 `spritesheetPath`）。
- **运行时切换 UI 还没做**，现在只能用 `--pet=<目录>`。
  别急着做：它会动窗口生命周期，而 ADR 035/038/042 三个崩溃都出在那条路上。
  ⇒ 建议先有 **≥2 个真实包跑通 `check-pet-swap`**，再考虑。
