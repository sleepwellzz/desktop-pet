# M2 ④ 悬浮控制条与快捷输入 · 接口设计

- **状态**：✅ **已落地**（决策见 ADR 014；实现与本文档的偏差见文末「实现回写」）
- **日期**：2026-09-16
- **前置**：M2 ①（状态链路，ADR 010）、②（托盘与右键菜单，ADR 011）、③（气泡与快捷键，ADR 012/013）
  均已完成并人工验收通过
- **本轮要先回答的问题**：输入框的内容发去哪？

## 0. 结论先行

**本轮做「控制条 + 状态仪表盘 + 快捷动作」，不渲染自由文本输入框。** 理由不是做不出来，
而是**规格里输入框的每一个去处都落在 agent 通道上**：

| 规格出处 | 原文 | 依赖的能力 |
|---|---|---|
| 功能基线 2 | 宠物下方控制条：铅笔图标**开新对话**、语音图标、铃铛图标**看线程** | agent 通道（创建会话 / 会话列表） |
| 功能基线 3 | 快捷输入 Quick Chat：`@` 添加上下文、`$` 选择技能；**发起的对话不隶属任何项目** | agent 通道 |
| 功能基线 4 | 全局快捷键：Windows 默认 `Win+Alt+P`：显示控制条并**聚焦 Quick Chat** | 同上 |
| 架构 6.1 · 窗口 B | 承载 Quick Chat 输入框、语音按钮、铃铛与**线程列表** | 同上 |

换句话说：**控制条上的核心按钮与输入框是同一件事**（都是"开一次会话"），
而 agent 通道属 M3。这一轮控制条能做实、且规格支持的部分是「**它是个窗口**」这件事本身 ——
悬浮、可聚焦、贴宠物下方、悬停出现、快捷键唤出。

三条候选路线：

| 路线 | 本轮交付 | 输入框 | 主要风险 | 推进基线验收项？ |
|---|---|---|---|---|
| **A. 状态仪表盘 + 快捷动作（推荐）** | 可聚焦控制条窗口 + 会话仪表盘 + 动作排 | 不渲染，位置与契约**冻结** | 中：本项目第一个**可聚焦**窗口 | ✅ 基线 2/4 的窗口部分 |
| B. A + 本地命令通道（先定协议） | A + 单行输入框 + `/命令` 解析 | 真（消费者是运行时自己） | 高：窗口层与新协议同轮落地；命令语法与 M3 的对话语义冲突 | ❌「本地命令」不在基线表里 |
| C. A + 自由文本输入 | 假输入框（无消费者） | 假 | — | ❌ |

### 为什么不选 B

1. **它不推进任何一条验收项**。M2 的退出判据是"对照 §3 功能基线表逐条验收"。加一条规格外的
   本地命令通道，覆盖面没变大，却引入一个新的功能面要维护、要写文档、要被人验收。
2. **输入语义会打架**。同一个文本框，M2 里是"斜杠命令"，M3 里是"跟 agent 说话"。
   用户不会先读我们的 ADR 再决定敲什么；他会直接打字问问题，然后收到"未知命令"。
   这与"M2 ③ 定下的**不做假输入框**"是同一条纪律 —— 一个看起来能聊天、实际只能敲命令的盒子，
   是假输入框的另一种形态。
3. **它把两件难事压进同一轮**。PLAN §4 明确说这轮是"本项目最大的一块窗口改动"（可聚焦窗口 +
   焦点管理 + 失焦自动隐藏）。焦点行为在这个项目里是**零经验区**（现有三层窗口全部
   `focusable:false`），必须靠探针实测换结论。再叠一层输入协议解析，出问题时无法定位是哪一层的锅。

### 但 B 里有一件值得留下的东西：**动作走白名单命令**

控制条的按钮不直接把动作表暴露给渲染层，而是发**命令 id**（`CH.barCommand`），
主进程查白名单执行、未知 id 一律忽略并记日志。这样：

- 安全边界干净（渲染层只能触发我们登记过的动作，不能传任意参数）；
- **M3 加输入框时协议形状不变** —— 只是给联合类型加一个成员 `{ id: 'agent-send', text }`，
  输入框在**同一位置**长出，窗口层无需再改（高度 44 → 76，走同一套 `setContentBounds` 重算）。

这也回答了"输入框发去哪"：**本轮它没有去处，所以它不渲染；去处一旦存在（M3），它长在同一处，走同一个通道。**

## 1. 范围

| 项 | 本轮 | 说明 |
|---|---|---|
| 控制条窗口（可聚焦、贴宠物下方、随宠物移动） | ✅ | 见 §3、§5 |
| 状态仪表盘（**多会话列表**） | ✅ | 本轮唯一的"新信息"，托盘菜单只有一行汇总。见 §6.1 |
| 单个会话「确认」（解除 needs-input 粘滞） | ✅ | `arbiter.ack(sessionId)` 已支持，只缺 UI 入口 |
| 快捷动作排（隐藏 / 缩放 −+ / 重置 / 更多菜单） | ✅ | 复用既有动作表，不新增能力 |
| 悬停出现（基线 2） | ✅ | 需延时去抖，见 §4 |
| 快捷键语义改为"唤出/收起控制条"（基线 4） | ✅ | **这是对 ADR 012 的行为修订**，见 §7 |
| 自由文本输入框（基线 3） | ⬜ **不做** | 位置与交互契约在设计里冻结，M3 落地 |
| 铅笔 / 语音 / 铃铛按钮（基线 2） | ⬜ | 全部依赖 agent 通道 |
| Mini 模式（基线 13） | ⬜ | 见 §12，需控制条**自有位置记忆**，与"锚定宠物"冲突 |
| 控制条钉住 / 位置记忆 / 圆角美化 | ⬜ | 见 §12 |

**不改宠物窗口的任何尺寸、位置与命中逻辑** —— 延续 M2 ③ 的核心取舍（ADR 012 §1）。

## 2. 规格依据

- 功能基线 2 / 3 / 4（上文 §0 表）；
- 架构 6.1：「窗口 B · 控制条层 … **仅在需要交互时创建/显示，可接受焦点**。与窗口 A 一起移动，
  避免使用者感到"两个东西"。」→ 本设计的"跟随宠物"与"失焦收起"都源自这句；
- 架构 4.1 设计公理：「宠物永远不抢焦点、不弹窗、不发系统通知」——**控制条不属于"宠物"**，
  它是用户主动唤出的工具面板，可以拿焦点。这条边界要在 ADR 里写死，否则以后有人会拿它当借口
  做常驻弹窗。

## 3. 关键取舍 ①：控制条是本项目第一个**可聚焦**窗口

现有三层窗口的对照（新增一列，差异一目了然）：

| 属性 | 宠物层 | 气泡层 | **控制条层** |
|---|---|---|---|
| `focusable` | false | false | **true** |
| 显示方式 | `showInactive()` | `showInactive()` | **`show()`（抢焦点）/ `showInactive()`（不抢）双路径** |
| 命中行为 | 常态整窗穿透，渲染层按 alpha 显式判定（ADR 008） | 常态整窗穿透、永不切换 | **系统默认命中（矩形面板）** |
| 隐藏→显示后是否需 reload | **必须**（ADR 009） | 不需要（从不收按钮事件） | **需实测**（见 §3.3） |
| 参与 `hide()`→`show()` 的输入通路坑 | 是（ADR 009） | 否 | 大概率是，且可能更严重 |

### 3.1 双路径显示：谁能抢焦点

| 唤出方式 | 显示调用 | 抢焦点 | 理由 |
|---|---|---|---|
| 悬停出现（基线 2） | `showInactive()` | **否** | 悬停是"垂手可得"，不是"要交互"。用户可能正在 IDE 里打字，鼠标划过宠物不能打断他 |
| 快捷键（基线 4） | `show()` + 渲聚焦 | **是** | 用户明确按了键，就是要用键盘操作它 |
| 点宠物右键菜单里的"控制条"项 | `showInactive()` | 否 | 菜单已经拿到了交互，控制条只是展示态 |

### 3.2 命中行为：唯一不适用 ADR 008 逐像素纪律的窗口

宠物层与气泡层之所以要做显式 alpha 判定，是因为**它们的窗口矩形远大于可视内容**
（134×146 的框里只有一个精灵）。控制条不同：它是**一个填满窗口的面板**，
窗口矩形 ≈ 可视矩形。

因此本轮决定：**控制条用矩形、直角、不透明面板**，窗口矩形 = 可视矩形，
"矩形窗口吃掉自己矩形的点击"是正常窗口语义，不适用 ADR 008 的逐像素纪律。

代价：**本轮不做圆角**。圆角会留下 4 个透明三角形（约 1% 面积）去吃掉下层应用的点击 ——
在这个项目里这是需要显式接受的纵容，不值得为观感付。要圆角得先解决"透明区不吃点击"，
那是 ADR 008 的地盘，另开一轮。

### 3.3 必须实测的一条：ADR 009 在**键盘**路径上是否复现

ADR 009 的结论是"`hide()` → `show()` 之后 Windows 不再把**鼠标按钮事件**路由到该窗口，
只有重建渲染层能恢复"。控制条要收**键盘输入**（Esc、将来的输入框），而键盘事件的投递
走的是另一条路径（焦点 → 消息队列），**没有验过**。

两种可能都要预先设计好应对：

| 实测结果 | 应对 |
|---|---|
| 键盘不受影响 | 隐藏/显示不需要 reload；更简单 |
| 键盘也断（或都断） | 每次显示后 `reload()` 渲染层（与 `resumePet()` 同一套纪律） |

**为什么现在敢接受 reload**：本轮控制条的内容是**只读**的（状态仪表盘 + 按钮），
主进程在 `did-finish-load` 时重推一次 `CH.barView` 即可，reload 完全幂等。

**为什么必须提前记一笔**：M3 加输入框后，reload 会**清空用户正在输入的文字**。
到那时要么改成"隐藏时不移除窗口"（例如移出工作区），要么在主进程留存草稿。
这条写进 §12 遗留项，免得 M3 踩。

## 4. 关键取舍 ②：显示/隐藏做成**纯函数状态机**

与 `kernel/bubble-policy.ts` 同一个套路：把"什么时候该显示"做成纯 TS（无 Electron、
时钟由调用方注入），因为这条策略里最容易错的规则**肉眼看不出对错**。

```ts
// src/kernel/bar-policy.ts
export interface BarPolicy {
  hoverDelayMs: number;    // 悬停需连续保持多久才出现（防"划过宠物"就弹出来）
  hoverGraceMs: number;    // 光标离开后多久收起（给"从宠物移到控制条上"留时间）
  blurHideMs: number;      // 失去焦点后多久收起
  toggleSuppressMs: number;// 快捷键收起后，抑制悬停重新唤出的时长
  showOnHover: boolean;    // 由 desktop-pet.json 配置；false = 只能靠快捷键/菜单唤出
}

export interface BarState {
  visible: boolean;
  hasFocus: boolean;
  hoverSince: number | null;   // 悬停计时起点；null = 当前无悬停
  hideAt: number | null;       // 计划收起时刻；null = 不计划
  suppressUntil: number | null;// 抑制悬停唤出的截止时刻
}

export type BarEvent =
  | { kind: 'hover'; over: boolean }   // 光标是否在「宠物 ∪ 控制条矩形」内
  | { kind: 'focus'; hasFocus: boolean }
  | { kind: 'toggle' }                 // 快捷键
  | { kind: 'request-close' }          // Esc / 关闭按钮
  | { kind: 'pet-hidden' };            // 宠物被隐藏或全屏让位

export function nextBarState(prev: BarState, ev: BarEvent, policy: BarPolicy, now: number): BarState;
export function tickBarState(prev: BarState, policy: BarPolicy, now: number): BarState;
export function parseBarPolicy(raw: unknown): BarPolicy;
```

规则（逐条列清，避免"面板自己弹出来/收不掉"这类无法解释的症状）：

1. `pet-hidden` → 立即隐藏并清空全部计时。**宠物回来时不自动重现**（否则全屏退出瞬间会冒出一个面板）。
2. `toggle` → 取反。收起时置 `suppressUntil = now + toggleSuppressMs`。
3. `request-close` → 立即隐藏。
4. `hover(true)`：
   - 若 `suppressUntil` 未过期 → 不启动计时（**这就是规则 2 存在的原因**：光标还停在宠物上，
     快捷键收起后如果不抑制，下一个 tick 就会把它弹回来，表现为"快捷键关不掉控制条"）；
   - `suppressUntil` 过期后**不补唤出**，需光标重新进入（`hover` 从 false → true）才计时；
   - 若已 `visible` → 清 `hideAt`（光标回来了）。
5. `hover(false)` → 清 `hoverSince`；若 `visible && !hasFocus` → `hideAt = now + hoverGraceMs`。
6. `focus(true)` → 清 `hideAt`（**有焦点就不自动收**，否则用户正在点它、它自己消失了）。
7. `focus(false)` → 若 `visible` → `hideAt = now + blurHideMs`。
8. `tick`：
   - `!visible && hoverSince !== null && now - hoverSince >= hoverDelayMs` → 显示（**不抢焦点**）；
   - `visible && hideAt !== null && now >= hideAt` → 隐藏。

**"光标在宠物 ∪ 控制条上"怎么算**：主进程已经有 16ms 光标轮询（`pollPointer`），
和渲染层每帧复评的 `CH.interactive`（`lastInteractive`）。所以：

- `over = lastInteractive || cursorInControlBarRect`；
- **不需要新增任何 IPC** —— 悬停检测完全在主进程完成。

## 5. 位置与跟随

贴宠物**下方**居中（基线 2 原文："宠物下方控制条"），间距 `gapBelowPet = 8` DIP
（气泡在上方，间距 10，两者不冲突）：

```
        ┌──────────────┐  ← 气泡层（上方，已有的）
        │   需要输入   │
        └──────────────┘
              ▲ 10
          ┌────────┐
          │  宠物  │
          └────────┘
              ▼ 8
     ┌────────────────────┐  ← 控制条层（本轮新增）
     │ ● 需要输入 · 2 会话 │
     └────────────────────┘
```

规则：

1. **宽度固定**（`controlBar.width`，默认 260）。自适应宽度会让窗口在会话列表变化时横向抖动，
   而尺寸由主进程估算是这个项目已有的坑（`estimateBubbleWidth`）。
2. **高度按内容**：44（无会话）/ 44 + 每行 28，最多 5 行 + "另有 N 条"一行；有上限。
3. **纵向翻转**：下方放不下（宠物贴工作区底边）时翻到宠物上方，用 `gapAbovePet = 10`；
   若两者都放不下（罕见）→ 夹进工作区。
4. **定位用实测高度**：气泡层实测过"下发 32 DIP 高度会读回 38"（ADR 012 负面结论 3）。
   控制条改高度后同样**用实测值反推 y**，保证"离宠物 8 DIP"这个唯一要紧的观感指标精确。
5. **跟随**：`overlay.moveBy()` / `setScale()` / 缩放后调用 `controlBar.followPet(bounds)`，
   与 `bubble.followPet()` 并列，同一处接线。
6. **夹取**：一律夹进宠物所在显示器的工作区（复用气泡层那套 `screen.getDisplayNearestPoint`）。

## 6. 内容与数据契约

### 6.1 控制条长什么样

```
┌──────────────────────────────────────────────┐
│ ● 需要输入 · 2 条会话                     ×  │  ← 状态行（现读 arbiter）+ 收起
├──────────────────────────────────────────────┤
│ ● default   需要输入   12 秒前        [确认] │  ← 会话行：单击 = 确认该会话
│ ○ abc       运行中     3 分钟前              │
├──────────────────────────────────────────────┤
│ [隐藏宠物]  [−] 100% [+]  [↺]        [⋯ 更多] │  ← 动作排（全部走命令 id）
└──────────────────────────────────────────────┘
```

- **为什么值得做**：托盘菜单只有一行"状态：需要输入 · 另有 2 条会话"，
  用户看不出**是哪条会话在等**、等了多久、能不能就地确认。这是本轮唯一的真信息增量。
- `● / ○`：`●` = 当前主状态；`○` = 其它活动会话。
- 「确认」按钮只在 `status === 'needs-input' && !acknowledged` 时出现。
- 「更多」= 弹出**同一份原生菜单**（`buildPetMenuTemplate`），所以"退出"这类动作不需要
  在控制条里再实现一遍，也不会因为多一个"退出"按钮而增加误点风险。

### 6.2 状态层接口（本轮唯一的内核改动）

现在 `arbiter.snapshot()` 返回的是原始 `SessionRecord`，但仪表盘需要"这条会话是否已被确认"
（已确认的 needs-input 在仲裁里按 idle 参与排序，UI 上应显示为"已确认"而不是继续显示"需要输入"，
否则界面上会永远挂着一条假的待办）。

```ts
// src/kernel/status.ts（新增，只读，不改仲裁行为）
export interface SessionView {
  sessionId: string;
  status: PetStatus;        // **原始**状态（不加 ack 降级，避免 UI 说谎）
  acknowledged: boolean;    // 已被用户确认（needs-input 的粘滞已解除）
  title?: string;
  ts: number;               // 最近一次事件时刻
  primary: boolean;         // 是否当前主状态（对应 arbiter.state.sessionId）
}
export class StatusArbiter {
  // ...
  viewSessions(): SessionView[];
}
```

- `status` 与 `acknowledged` **分开暴露**，让 UI 自己决定怎么呈现（"需要输入（已确认）"），
  而不是在内核里替 UI 决定显示成 idle；这样单测可以钉住"ack 不改原始状态"这条。
- 已知会话静默过期由 `pruneStale` 处理，视图天然不会显示死会话。

### 6.3 命令白名单（渲染层唯一能触发的东西）

```ts
export type BarCommandId =
  | 'hide-pet'        // 隐藏宠物（控制条随之收起）
  | 'scale-up'        // 按 scaleStep 放大
  | 'scale-down'
  | 'reset-scale'     // 回到宠物包默认值
  | 'ack-session'     // 需要 arg = sessionId
  | 'popup-menu'      // 弹出同一份原生菜单（覆盖退出等全部动作）
  | 'close-bar';      // 收起控制条（等同 Esc）
```

主进程侧：查表 → 未知 id **忽略并记日志** → 执行。渲染层拿不到 `actions` 对象，
也传不了任意参数（`ack-session` 的 arg 还会再校验"这个 sessionId 真的存在"）。
**M3 只需在这里加一个 `agent-send`**。

## 7. 快捷键语义修订（对 ADR 012 的行为变更）

基线 4 明确写的是「显示控制条并**聚焦 Quick Chat**」，而 ADR 012 把 `Win+Alt+P` 定成了
"切换宠物显示/隐藏"。本轮按规格对齐：

| | 现在（ADR 012） | 本轮 |
|---|---|---|
| `Win+Alt+P` | 切换宠物显示/隐藏 | **唤出 / 收起控制条** |
| 宠物当前是隐藏的 | （无关） | **先恢复宠物，再唤出控制条**（控制条锚定宠物，不能悬在半空；也避免"按了没反应"） |
| 隐藏宠物的入口 | 快捷键 + 托盘单击 + 右键菜单 | **托盘单击 + 右键菜单 + 控制条里的"隐藏宠物"**（不减能力，只是换了入口） |
| 归一化 / 降级链 | `normalizeAccelerator()` + 四级降级 | **不变**（ADR 012 的负面结论 1 继续生效：`Win+…` 必须归一化成 `Super+…`） |

顺带要改的文案：`pet-menu.ts` 里那行「快捷键：…」应写成
`快捷键：Super+Alt+P（唤出控制条）`，否则菜单在说谎。

> 备选（如认为不该动既有语义）：保留"切换显示/隐藏"，控制条另注册第二个快捷键。
> 代价是多一次全局注册（冲突风险翻倍）+ 与规格不符。**推荐按规格改。**

## 8. IPC 契约

```ts
// src/shared/ipc.ts（新增）
export const CH = {
  // ... 既有
  /** 主进程 → 控制条：整份视图数据（状态、会话列表、缩放、快捷键…）。 */
  barView: 'pet:bar-view',
  /** 主进程 → 控制条：请把焦点给输入区/首屏（快捷键唤出时用）。 */
  barFocus: 'pet:bar-focus',
  /** 控制条 → 主进程：执行一个白名单动作。 */
  barCommand: 'pet:bar-command',
} as const;

export interface BarView {
  status: PetStatus;
  statusText: string;              // 复用 main 里的 STATUS_TEXT
  sessions: SessionView[];
  scale: number;
  defaultScale: number;
  scaleRange: [number, number];
  scaleStep: number;
  hotkey: string | null;           // null = 注册失败（如实显示，不静默）
  petVisible: boolean;
  rev: number;                     // 与 StatusPush.rev 同源，渲染层用来识别"重载后的第一帧"
}

export interface BarCommand { id: BarCommandId; arg?: string }
```

新增 `src/main/preload-bar.ts`（**独立 preload，最小权限**，与 `preload-bubble.ts` 同理）：

```ts
contextBridge.exposeInMainWorld('petBar', {
  onView: (cb) => ipcRenderer.on(CH.barView, (_e, v: BarView) => cb(v)),
  onFocus: (cb) => ipcRenderer.on(CH.barFocus, () => cb()),
  command: (c: BarCommand) => ipcRenderer.send(CH.barCommand, c),
});
```

## 9. 模块划分与构建链

```
新增
  src/host/control-bar.ts        窗口创建/显示/隐藏/定位/跟随/失焦回调（唯一的窗口脏活）
  src/kernel/bar-policy.ts       显示状态机（纯函数 + 虚拟时钟可测）
  src/renderer/control-bar.html  面板版式（DOM，不用 canvas）
  src/renderer/control-bar.ts    渲染视图 + 点击 → 命令 id
  src/main/preload-bar.ts        最小权限通道
  spikes/m2-control/             探针工程（见 §10）
改动
  src/kernel/status.ts           + viewSessions()
  src/shared/ipc.ts              + 3 个通道 + BarView / BarCommand / SessionView
  src/main/index.ts              接线：悬停判定、快捷键语义、全屏让位、拖动跟随、命令表
  src/host/pet-menu.ts           快捷键那行文案
  desktop-pet.json               + controlBar 段；interaction.hideShortcut.action 文案更新
  package.json                   构建链加两个入口
```

构建链扩展（ADR 005 的顺序）：
`build:main → build:preload → build:preload-bubble → build:preload-bar → build:renderer → build:bubble → build:bar → copy-assets`

sidecar 新增段（**自研参数不进 `pet.json`**，ADR 002）：

```json
"controlBar": {
  "note": "悬浮控制条：本项目第一个可聚焦窗口。可聚焦 ⇒ 可以拿焦点；但它只在用户主动唤出时拿（快捷键），悬停出现一律 showInactive。圆角会留透明四角吃点击，故本轮为直角矩形面板（不适用 ADR 008 的逐像素纪律，因为窗口矩形≈可视矩形）。",
  "width": 260,
  "height": 44,
  "rowHeight": 28,
  "maxRows": 5,
  "gapBelowPet": 8,
  "gapAbovePet": 10,
  "hoverDelayMs": 300,
  "hoverGraceMs": 500,
  "blurHideMs": 200,
  "toggleSuppressMs": 1500,
  "showOnHover": true
}
```

## 10. 验证计划

新增探针 `spikes/m2-control/`（照既有约定：`run.mjs` 统一入口、逐条断言、输出 json + log）：

| # | 探针 | 验什么 | 判据 |
|---|---|---|---|
| 1 | `probe-focus.js` | **焦点行为**（本项目零经验区） | 三条路径各自的前台窗口变化；悬停出现**不改变**前台窗口；快捷键唤出**改变**它 |
| 2 | `probe-key-path.js` | ADR 009 在键盘路径是否复现 | 注入按键：首次 `show()` 后能收到；`hide()`→`show()` 往返后能否收到（决定是否必须 reload） |
| 3 | `probe-bar.js` | 控制条本身 | 贴宠物下方 8 DIP、水平居中；宠物拖到屏幕底边时翻到上方；拖动宠物时跟随；Esc 与失焦收起；会话列表条数与内容与仲裁器一致；点「确认」后粘滞解除（`events.jsonl` 佐证） |
| 4 | `probe-commands.js` | 命令白名单 | 每个合法 id 都落到真动作（缩放尺寸变化、隐藏后窗口不可见）；**非法 id 被忽略且不抛异常**；`ack-session` 传不存在的 id 被拒 |
| 5 | `probe-alt-tab.js` | 流氓软件风险（PLAN §8） | 控制条**不出现在 Alt+Tab / 任务栏**（读扩展样式位 `WS_EX_TOOLWINDOW`），焦点后也不改变这点 |
| 6 | 单测（`tools/status-arbiter.test.mjs`） | 纯逻辑 | `bar-policy` 全部规则（含"快捷键收起后被悬停弹回来"那条）+ `viewSessions()`；现有 **87 项**不得回归 |

必跑回归（改了窗口创建/显示/隐藏 —— 按 AGENTS.md 的硬性约束）：

```bash
node spikes/m2-hittest/run.mjs probe.js           # 命中图：应穿透却被吃必须为 0（新增窗口尤其要跑）
node spikes/m2-hittest/run.mjs probe-fs-verify.js # 全屏让位与恢复后的点击/拖动
node spikes/m2-menu/run-tray.mjs                  # 隐藏/显示往返、缩放尺寸与锚点、自启、退出
node tools/status-arbiter.test.mjs                # 状态层单测
node spikes/m2-hotkey/run.mjs                     # 气泡与快捷键（快捷键语义改了，必须重跑）
```

人工验收（用户执行）：控制条好不好用、悬停出现是否烦人、焦点被拿走是否可接受、
会话仪表盘是否看得懂、`Win+Alt+P` 新语义是否顺手。

## 11. 需要确认的点

| # | 问题 | 推荐 |
|---|---|---|
| D1 | **范围**：A（控制条 + 仪表盘 + 动作，不含输入框）还是 B（另加本地命令通道）？ | **A**。理由见 §0：规格里输入框的去处全在 agent 通道；B 不推进验收项且语义会与 M3 打架 |
| D2 | **快捷键语义**：`Win+Alt+P` 改为"唤出/收起控制条"（规格 §3.4）？ | **改**。宠物隐藏时按下 = 先恢复宠物再唤出。隐藏宠物仍有托盘/右键/控制条三个入口 |
| D3 | **悬停出现**要不要做（基线 2 要求）？延迟与宽限取值？ | **做**，300ms 出现 / 500ms 宽限，配置在 sidecar；不舒服可直接关（`showOnHover: false`） |
| D4 | **动作排**放哪几个？ | 隐藏宠物 / − / 缩放值 / + / 重置 / 更多（弹原生菜单）。**不放"退出"**（避免误点，托盘已有） |
| D5 | **Mini 模式**（基线 13）本轮做吗？ | **不做**。它要求控制条**自有位置记忆 + 长期常驻**，与"锚定宠物"冲突，属另一轮 |

## 12. 本设计不做的事（含刻意留的坑）

- 不做自由文本输入框、不做铅笔/语音/铃铛按钮（全部依赖 M3 的 agent 通道）；
- 不做 Mini 模式、控制条钉住、控制条位置记忆；
- 不做圆角/投影美化（透明四角会吃下层点击，见 §3.2）；
- 不改宠物窗口的尺寸/位置/命中逻辑；不改"单击宠物 = 确认"的既有语义（ADR 010）；
- **遗留项（M3 必读）**：若实测确认 ADR 009 在键盘路径也复现，控制条每次显示前要 reload
  渲染层。本轮内容只读、reload 幂等；**加了输入框之后 reload 会清空用户正在输入的文字**，
  到那时必须换掉"隐藏即 `hide()`"的做法（或把草稿留在主进程侧）。

## 13. 实现回写（落地后补，2026-09-16）

实现与本文档的四处偏差，都已写进 ADR 014：

1. **§4 的状态机多了一个 `armed` 位**。文档只写了"清空计时"，但规则 1（快捷键收起不被悬停弹回）
   与规则 2（宠物让位回来不自动重现）**只有清计时实现不了** —— 这两条发生时"由非悬停路径引起的
   隐藏"已经发生，而光标往往还停在原地，下一个 tick 的 `hover(true)` 会被当成"刚刚进入"。
   `armed` 置真的唯一时机是 `hover(false)`（光标真的离开过）。**这是文档漏掉的一条必要机制。**
2. **§5 的"高度按内容"落成三段式**：`headerHeight` 30 + 行数 × `rowHeight` 28 + `footerHeight` 42。
   文档 §9 的 `"height": 44` 是示意值 —— 面板有固定顶栏与底部动作排，两段都不可压缩，
   一个数字描述不了。sidecar 字段相应改为四个。
3. **§3.3 的实测答案：键盘路径不受影响**，`hide()`→`show()` 往返后键盘照常投递
   ⇒ **不需要 reload**。文档留的两个分支取"更简单"的那个。
4. **§3.2 的矩形面板必须显式设 `WS_EX_TOOLWINDOW`**：文档假设 `skipTaskbar: true` 就够，
   实测它不会加这个样式位（读回 `0x108`，无 `0x80`），Alt+Tab 仍可能列出来。
   `host/control-bar.ts` 里用 koffi 显式设置，修后读回 `0x188`。

另外两条只在实现期才发现、但值得记在这里的：

5. **到点收起不能顺手撤销 `armed`**（否则"悬停唤出"永久失效，且只有读代码能看出来）。
6. **`win.isVisible()` 不能做显示记账**：`show()` 同一 tick 内它可能仍返回 false，
   会让抢焦点的路径上重复 `show()` 一次（第二次是 `showInactive`，正好把刚拿到的焦点让出去）。
   改为由 `show`/`hide` 事件驱动记账。
