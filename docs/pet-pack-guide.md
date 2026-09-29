# 宠物包制作指南

> **你要做的是：做一只新宠物，让它在淘淘里动起来。**
>
> 这份文档假定你**没读过** `pet-spec.html`（100 KB 的完整规格）和本项目的 ADR。
> 那两份仍是**权威来源**，本文是**能照着做下去的操作路径** + 本工程特有的坑。
>
> 换句话说：**要查"为什么"，去 `pet-spec.html` 与 `docs/decisions/`；
> 要查"怎么做"，看这里。**

---

## 0. 最短路径（先跑通，再美化）

```bash
# 1. 拿模板（标注稿 + 空图集）
python tools/make_pet_template.py --out ./my-pet-assets

# 2. 照着标注稿画图，导出成图集（8 列网格，单元格 192×208）
#    成品图集不能带网格线和文字

# 3. 放入宠物包目录，三份配置 + 图集：
#    my-pet/
#      pet.json            ← 官方原生格式，**不得加自研字段**
#      spritesheet.webp    ← 你的图集
#      behavior-map.json   ← 行 → 状态 → 帧列
#      desktop-pet.json    ← 运行时参数（fps / 锚点 / 映射）

# 4. 让工具帮你生成 sidecar（别手写帧数，让它量）
python tools/pet_sheet_probe.py ./my-pet --export-map --export-atlas

# 5. 体检 —— 这一步能省掉你后面所有的双击试错
node tools/check-pet-swap.mjs ./my-pet

# 6. 托盘图标（否则任务栏上还是旧宠物的那张脸）
python tools/make-tray-icon.py ./my-pet    # 写入 <包>/tray.ico，主进程会优先用它

# 7. 试跑
desktop-pet.exe --pet=./my-pet
```

⚠️ **第 5 步是本工程的关键**。它会告诉你"这只宠物少了什么"，
而不用你双击二十次去找"为什么挥手没反应"。

---

## 1. 宠物包目录该有什么

```
my-pet/
├── pet.json            官方原生清单（只读，不要动格式）
├── spritesheet.webp    精灵图
├── behavior-map.json   sidecar：行 → 状态 → 帧列
├── desktop-pet.json    sidecar：fps / 锚点 / 业务映射 / 面板动作
└── tray.ico            托盘图标（可选但强烈建议，ADR 049）
```

**两份 sidecar 是自研的，`pet.json` 不是。**
这条界线来自 ADR 002，不能破：一旦往 `pet.json` 写自研字段，
这个包就既不是官方 Codex 宠物、也不能被别的工具读了。

---

## 2. 精灵图规格

| | V1 | V2 |
|---|---|---|
| 尺寸 | **1536 × 1872** | **1536 × 2288** |
| 网格 | 8 列 | 8 列 |
| 单元格 | 192 × 208 | 192 × 208 |
| 行数 | 9 | 11 |
| 声明 | 默认 | `pet.json` 里写 `"spriteVersionNumber": 2` |

**尺寸是硬闸**：`loadPack` 读魔数拿真实尺寸，与 `spriteVersionNumber` 推导的期望值
一对不上就直接抛错。**图集里多画了一行、或导出时尺寸被改了，都会在这里炸。**

> 💡 体积：超过 **20 MiB** 会给警告（本地仍可用），硬上限 64 MiB。
> 导出时选 WebP 或控制 PNG 质量，1600×2300 的图很容易超。

---

## 3. 行语义：哪一行演什么（**最容易搞错的地方**）

V1 的 9 行顺序是**官方契约的一部分**（`tools/pet_sheet_probe.py` 里的 `V1_ROWS`）：

| 行 | 状态 | 建议帧数 | 演什么 |
|---|---|---|---|
| 0 | `idle` | 6 | 待机。轻微呼吸/眨眼循环 |
| 1 | `running-right` | 8 | 向右跑（位移用） |
| 2 | `running-left` | 8 | 向左跑（位移用） |
| 3 | `waving` | 4 | 挥手。**一次性信号**：完成、致意、交接 |
| 4 | `jumping` | 5 | 跳跃。**一次性**：越过边界、庆祝 |
| 5 | `failed` | 8 | 失败/受阻。平躺或沮丧循环 |
| 6 | `waiting` | 6 | 等待输入。停在操作闸口 |
| 7 | `running` | 6 | 处理中。原地忙碌循环 |
| 8 | `review` | 6 | 检查结果。审视产出 |

### ⚠️ 关于第 7 行的真实教训

**不要按名字猜这一行长什么样。**

本工程的 `running`（"运行中"这个业务状态）落在**第 7 行**，
而这一行画什么**由宠物包作者决定** —— 淘淘在这一行画的是**生日姿态**，不是"原地跑动"。
第一版验收说明写成"原地跑动"，被用户当场发现。

⇒ 换宠物包后**必须重新生成 `docs/status-reference.png`**（`tools/make-status-reference.py`），
它是"业务状态 → 屏幕上实际长什么样"的对照卡，验收时对着它看，别对着记忆看。

---

## 4. 三份配置怎么互相咬合

这是最容易出错的地方。**三个文件必须一致**，`loadPack` 会逐条校验：

```
behavior-map.json          desktop-pet.json            两者必须相等
  states.<id>.row       ↔   states.<id>.row             行号
  states.<id>.frames    ↔   states.<id>.frames          帧数
  states.<id>.loop      ↔   states.<id>.loop            循环标记
  states.<id>.frameColumns  → 播放帧必须从第 0 列连续
```

**为什么写两遍**：一份是"行为语义"，一份是"渲染参数"，
分开是为了 `pet.json` 保持官方格式（ADR 002）。代价就是**必须手工保持同步**。

> 💡 **别手写 `behavior-map.json`** —— 用 `pet_sheet_probe.py --export-map`
> 让它从图集实测每行真实帧数。手写的帧数是本工程最常见的错误来源。

### 锚点：脚必须落在同一条地平线上

`desktop-pet.json` 里：

```json
"anchor": { "mode": "per-state-fixed", "groundY": 202 }
```

每个状态还有 `baselineY` 与 `offsetY`，且**必须满足**：

```
offsetY === groundY - baselineY
```

不满足就是**脚会离地**（或插进地里）。`loadPack` 会抛错，
`check-pet-swap.mjs` 会在静态阶段先算一遍给你看。

> ⚠️ **禁止逐帧基线锁定**（ADR 002）。
> 那会把奔跑的步态起伏和跳跃的腾空弧线一起抹平 —— 宠物会变成在地上滑行的贴图。

---

## 5. 业务状态怎么接到动画上

**5 个业务状态**（由 agent 的活动状态决定）→ 你图集里的动画状态：

```json
"statusMap": {
  "idle":        { "state": "idle" },
  "running":     { "state": "running" },
  "needs-input": { "state": "waiting", "bubble": "需要输入", "stickyUntil": "user-ack" },
  "blocked":     { "state": "failed" },
  "ready":       { "state": "waving", "then": "review" }
}
```

**五个都要有**，缺一个 ⇒ agent 进入该状态时宠物无动作可演，
而**不会有任何报错**（这是 `check-pet-swap.mjs` 专门堵的洞之一）。

`ready` 用了 `then`：先挥手，再切到"检查结果"。

---

## 6. 面板动作排（手动把玩）

```json
"actions": { "list": [ { "state": "waving", "label": "挥手" }, ... ] }
```

控制条会为**每一个** `list` 项渲染一个按钮。少配一个 = 少一个按钮；
配了一个不存在的状态 = **渲染出一个点下去演不出来的按钮**。

> 💡 `actions.list` 的顺序决定按钮顺序。
> 当前工程是 9 个（全部动画状态）。**你可以只放一部分** ——
> 但 `check-pet-swap.mjs` 会检查每个引用的状态真实存在。

---

## 7. 体检：发布前必跑

```bash
node tools/check-pet-swap.mjs ./my-pet
```

它会报出**四类你在双击时看不出来的问题**：

| 报什么 | 后果（不体检就发现不了） |
|---|---|
| 状态在 `behavior-map` 有、`desktop-pet` 没有 | `loadPack` **静默跳过** ⇒ 宠物少一个动作 |
| `statusMap` 指向不存在的状态 | agent 进入该状态时**无动作可演**，无报错 |
| 锚点不自洽 | 脚离地 |
| 包内没有 `tray.ico` | 托盘还是别的宠物的脸 |

> ⚠️ **本工程自己过了这道体检**（主单测 ⓪d 节每次都会体检工程根）。
> **自己过不了的判据没有资格要求别人过。**

---

## 8. 常见坑（都是本工程真的踩过的）

| 现象 | 真因 |
|---|---|
| 宠物少了某个动作，没有任何报错 | `loadPack` 对缺状态只 `warnings.push` 后跳过（`pack.ts:87`）⇒ 跑 `check-pet-swap` |
| 换包后托盘还是旧宠物 | 图标写死在工程根 ⇒ **已修**（ADR 049）。新包必须**自带 `tray.ico`**，
并用 `python tools/make-tray-icon.py <你的包目录>` 生成（它会读你 `pet.json` 里的 `spritesheetPath`） |
| 宠物在原地滑行，脚不沾地 | 锚点不自洽，或做了逐帧基线锁定 |
| 文字/气泡被裁掉几个像素 | `line-height` 与字体度量冲突；判据要用**截屏差分**量，别用 canvas 度量反推（ADR 013） |
| 「我改了图但没生效」 | 改了 `src` 忘了 rebuild ⇒ 现在 `dist` 不对会**直接拒绝跑测试**（ADR 047） |
| 包能加载但窗口空白 | 图集尺寸对、但 `esbuild` 没跑（preload 与 renderer 走不同工具链，ADR 023） |
| Windows 把它当流氓软件 | 见 `PLAN.md` §6 风险表：不夺焦点、不写服务、不出任务栏 |

---

## 9. 权威来源在哪

| 想查什么 | 去哪 |
|---|---|
| 完整规格（100 KB，含全部字段定义） | `pet-spec.html` |
| 本工程的硬约束 | `docs/constraints/pet-pack.md` |
| 为什么这么定 | `docs/decisions/INDEX.md` → 对应 ADR |
| 行语义与帧数的**代码事实** | `tools/pet_sheet_probe.py` 的 `V1_ROWS` |
| 每个业务状态实际长什么样 | `docs/status-reference.png`（**换包后重新生成**） |
| 图集网格与行标注 | `python tools/make_pet_template.py --out ./assets` |
| 用户级技能 | `codex-pet-pack`（本项目外的权威） |

---

## 10. 还没做的部分（别期待过头）

- **软件内切换宠物的界面还没有。** 现在只能用 `--pet=<目录>` 启动参数换。
  运行时切换 UI 明确排在本轮之外（ADR 049）——
  它会动窗口生命周期，而 ADR 035/038/042 三个崩溃都出在那条路上。
- **`examples/demo-pet` 与 `examples/broken-pet` 不是完整可运行的包**，
  它们只有 `pet.json` + 图集，缺两份 sidecar。`check-pet-swap` 会报 FAIL —— 那是事实。
  要做完整样例，**复制工程根的三份配置再改**。
