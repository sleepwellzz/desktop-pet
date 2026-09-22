# 桌面宠物 · desktop-pet

把 AI agent 的工作状态，变成 Windows 桌面上一只可以逗的宠物。

它会自己走动、挥手、跳一下；agent 需要你输入时会举手；空闲满 5 分钟就趴下打盹。
你也可以随时右键把它唤出来，**不管 agent 在干什么**，像逗宠物一样点着玩。

这是一个**自研的运行时**：不依赖 Codex / ChatGPT 客户端，自己解析宠物包规格
（精灵图集 + `pet.json` + 行为映射），用 Electron 透明覆盖窗口一帧帧画出来。

![控制条面板](docs/panel-actions-shelf.png)

> 上图是右键宠物唤出的控制条：状态摘要 + 多会话明细 + 底部一排「手动把玩」按钮。
> 动作排与 agent 状态无关 —— 点一下就演；暖色描边那个是正在演的，再点一次即停。

## 它解决什么问题

跑多个 AI agent 的人，通常只能盯着终端或网页看"现在到哪一步了"。把这件事挪到桌面上之后，
你不用切窗口就能知道：有没有任务在跑、有没有东西卡着等你回话。

设计上刻意守住几条边界：

- **不抢焦点**：宠物窗口全程 `WS_EX_NOACTIVATE`，不会打断你正在做的事；
- **只有宠物本身可点**：光标在精灵轮廓外一律穿透到桌面（逐像素 alpha 命中判定），
  窗口"看着大"但不会吃掉旁边的点击；
- **全屏自动让位**：检测到全屏应用就藏起来，退出全屏再回来；
- **能关得掉**：托盘右键一键退出，开机自启可开关，不写服务、不写计划任务。

## 快速开始

### 直接用（Windows 10/11 x64）

`desktop-pet.exe` **不能单独拷走** —— 它只是入口，启动时要在同级目录找 `resources/`、
`*.dll`、`*.pak`、`locales/`。**要拷就拷整个目录**（或直接用打包好的 zip）。

1. 把 `desktop-pet/` 整个目录拷到任意位置；
2. 双击 `desktop-pet.exe`；
3. 托盘会出现一只宠物图标：**左键单击 = 收起/放出**，**右键 = 完整菜单**。

> 未签名的 exe 首次运行会被 SmartScreen 拦，点「更多信息 → 仍要运行」。
> 勾了开机自启之后**别移动这个目录** —— 注册表里记的是绝对路径。

### 从源码跑（开发）

```bash
npm ci
npm run build        # 完整构建（只跑 tsc 不够，渲染层还要过 esbuild）
npm start            # = electron .
```

要求：**Node 22+**、Windows x64。

打包成免安装绿色目录 / zip：

```bash
npm run make:portable        # 只出目录 → dist-win/desktop-pet/
npm run make:portable:zip    # 顺带压成一个 zip（对外分发用这一个文件）
```

## 怎么给它喂状态

宠物自己不产生状态，状态从 agent 那边来。仓库里带了一个人工验收用的入口：

```bash
node tools/pet-hook.mjs needs-input --session=demo --title="等你确认"
```

`喂状态.bat` 是它的图形化版本。真实接入有两条通道：**hook 命令**（实时）与
**状态文件**（快照轮询，默认在 `~/.desktop-pet/status.json`）。细节见
[`docs/how-to-run.md`](docs/how-to-run.md) 与 [`docs/constraints/sources-hooks.md`](docs/constraints/sources-hooks.md)。

## 代码结构

```
src/
├── kernel/     纯 TS 内核：状态仲裁、动画映射、播放器、行为层、手动把玩（不 import Electron）
├── source/     状态源适配器：hook / 状态文件 → 统一事件
├── host/       宿主适配层：窗口、托盘、气泡、控制条、全屏检测、自启
├── main/       主进程装配（boot 的每一段都有索引注释）
└── renderer/   精灵图渲染 / 气泡 / 控制条面板
```

内核刻意不碰 Electron —— 宿主差异全部收在 `src/host/`，所以状态机、行为层、
手动把玩的逻辑都能用**纯函数单测**跑，不需要起窗口。

## 测试与判据

```bash
npm run test:status     # 状态机 / 气泡 / 控制条策略 / 手动把玩 / 结构不变量（413 项）
npm run check:timers    # 定时器生命周期静态检查（每条 interval 的句柄都必须被接住）
```

真实窗口层面的验证在 `spikes/` 下，各目录有自己的 README。它们是**探针**：
启动真实的 Electron 窗口、注入真实鼠标、量真实读数（不是断言 DOM 猜出来的）。
例如 `spikes/m2-control/` 会验"面板贴宠物下方 8 DIP""左右走真的走了多少像素""菜单回调落在已销毁窗口上会不会崩"。

## 文档在哪

这个工程的文档密度比一般项目高，因为它是**按"接续"来组织的**：

| 文件 | 作用 |
|---|---|
| [`PLAN.md`](PLAN.md) | 当前状态索引：现在到哪了、下一步做什么、细节去哪找 |
| [`AGENTS.md`](AGENTS.md) | 开工约定与约束路由表（按"你要改什么"指向对应约束） |
| [`docs/decisions/INDEX.md`](docs/decisions/INDEX.md) | 决策档案一行一条（ADR 全文在同目录，只增不改） |
| [`docs/how-to-run.md`](docs/how-to-run.md) | 操作手册：启动、托盘、气泡、控制条、动作排 |
| [`docs/acceptance.md`](docs/acceptance.md) | 人工验收清单 |
| `journal/` | 每次会话的日志 |

踩过的坑大多写进了 ADR 与约束文件（例如"平台行为一律实测、不要推断"这条，
是被实测推翻过六次之后才立起来的）。

## 宠物包

宠物外观来自一个**宠物包**：一张精灵图集 + `pet.json` + `behavior-map.json`。
规格细节见 [`pet-spec.html`](pet-spec.html)，校验用 `python tools/validate_pet.py`。
换宠物包不需要改代码 —— 只要图集尺寸与 `spriteVersionNumber` 对得上。

## 已知限制

- **仅 Windows**（核心依赖 Win32 分层窗口、`WS_EX_NOACTIVATE`、逐像素命中判定）；
- 未签名 exe，首次运行会被 SmartScreen 提示；
- 开机自启写 `HKCU\...\Run`，因此**移动目录会让自启失效**（在新位置双击一次即可修正）；
- 多显示器**不做跨屏漫游**，宠物只在自己那块屏里走。

## 许可证

**代码：MIT** —— 见 [`LICENSE`](LICENSE)。

**演示素材除外**：仓库里的 `spritesheet.webp`、`examples/`、
`assets/pet_atlas_guide_*.png`、`assets/tray.ico`、`pet-spec.html`、`atlas-map.png`
等美术与规格素材，是**为了能直接跑起来而随附的演示资源**，用于展示宠物的外观与动画规格。
它们**不包含在 MIT 授权范围内**；如果你要基于本项目做自己的作品，
请换成你自己拥有权利的素材（用 `tools/make_pet_template.py` 生成模板即可）。
