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
