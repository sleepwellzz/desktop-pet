# M3 第二块 · 状态源生态（⑦-b）接口设计

> 状态：**待用户确认**（2026-09-18 出稿 / 同日按 D1 答复重写，尚无实现代码）
> 本文只回答三件事：**本轮做什么、按什么判据验收、哪些地方要你先拍板**。
> 纪律：标「实测」的都是本机真跑出来的；标「文档」的来自官方文档、**未必适用于本机构建**；
> 标「推测」的未经证实。三者不允许混用。

---

## 0. 本版相对初稿的变化

初稿的目标 agent 是 Codex。D1 答复把目标改成 **WorkBuddy（主力）+ Proma（Pi agent 架构）**，
于是重做了调研，结论有实质变化：

1. **WorkBuddy 自带完整 hook 引擎**（初稿完全没料到，也是本版最大的发现）：
   它内嵌的 agent CLI 里有 Claude 系的 14 个生命周期事件与整套 hook 执行器。
2. **WorkBuddy 还额外暴露了两处结构化运行状态**（进程心跳 + 任务项状态），
   即使 hook 走不通也有一条被动通路。
3. **Proma 未发现可配置的 hook 面**，但它把**每次会话实时写成 JSONL**，被动通路可行。
4. Codex 从"本轮目标"降为"顺带兼容"（可用但已不是主力：最后一次活动 2026-08-07）。

---

## 1. 结论先行

**选 ⑦-b，不选 ⑦-c。** ⑦-c 的前置（素材导入流程 + 规格标准）绑定在 ADR 015 的重启条件②上，
而"要不要做素材导入这条产品线"你还没拍板 —— 在未定的前提上开工不划算。
⑦-b 则直接对着 PLAN §8 风险表里唯一还写着 **"仍待验证"** 的那条：*"真 agent 的 hook 配起来好不好用"*。

**本轮的一句话目标**：让桌宠**如实**反映你手上真实 agent 的活动 —— 不再靠"喂状态"模拟。

**覆盖策略（关键）**：不要为每个工具写一套。真实情况是**两条通道**，而不是六个适配器：

| 通道 | 形态 | 覆盖谁 | 能给到什么 |
|---|---|---|---|
| **A · 事件驱动 hook** | 各家的 `settings.json` 里写 `hooks`，命令收到 **stdin JSON** 后回写状态文件 | **WorkBuddy**（主）、Codex、将来的 Claude Code —— **同一套事件名与契约** | 全五态，**含 `needs-input`（等你授权）** |
| **B · 被动会话源** | 只读各家的会话/状态文件并归一化 | **Proma**（主）、WorkBuddy 兜底 | `running` / `ready` / `idle` + **会话标题**；**拿不到 `needs-input`** |

两条通道都产出同一种东西 —— `StatusEvent`。**而 `StatusSource` 接口在 M2 ① 就已经是这个形状了**
（`start/stop/reset/describe`，见 `src/source/types.ts`），所以本轮不需要动内核，只是往插座上多插两个头。

---

## 1.1 闸门结论（判据 0，2026-09-18 已完成 = **YES**）

用户提出的问题：*"WorkBuddy 桌面到底会不会执行 `.codebuddy/settings.json` 里的 hooks？"*
—— 初稿只能写成"两种可能，必须实测"。**现已实测完毕，答案是会。**

**证据 1 · 进程树（读一次当前进程表）** WorkBuddy 桌面把 agent 跑在内嵌 CLI 上：

```
WorkBuddy.exe(187856)   主进程
 └─ WorkBuddy.exe(188924)   app.asar/main/daemon-app-server-entry.js --stdio
     └─ WorkBuddy.exe(189196)  app.asar/main/sidecar-entry.js --token … --control-pipe-uuid …
         └─ WorkBuddy.exe(203516)  app.asar.unpacked/cli/bin/codebuddy --serve
                                    --session-id ab2f75f8-9494-401f-b73e-01ad3286ae79
                                    --permission-mode fullAccess …
             ├─ WorkBuddy.exe(170152)  cli/bin/windows-child-process-containment.cjs --codebuddy-windows-job-launcher …
             ├─ WorkBuddy.exe(200828)  … --codebuddy-windows-job-launcher -- C:\Users\<用户名>\.workbuddy\binaries\node\vers…
             └─ WorkBuddy.exe(208824)  … -- C:\WINDOWS\system32\cmd.exe /d /s /c "C:\Use…
```

**跨证据吻合**：进程里的 `--session-id ab2f75f8-9494-401f-b73e-01ad3286ae79` 与
`~/.workbuddy/sessions/203516.json` 里的 `sessionId` **完全是同一个值** —— 说明既有的会话心跳文件
与真实 agent 进程是一一对应的（这条对通道 B 也是好消息）。

**证据 2 · 设置作用域（读 CLI 代码）**

```js
DEFAULT_SCOPES = [SettingsScope.USER, SettingsScope.PROJECT, SettingsScope.PROJECT_LOCAL]
```

`--setting-sources` 若不给就取默认。而真正跑 agent 的那个进程（pid 203516）**命令行里没有
`--setting-sources`**（只有另一条 prewarm/后台进程 `187808` 带 `--setting-sources user`）
⇒ **工程级 `.codebuddy/settings.json` 会被读取**。

> 这条同时**佐证了 D5 的取舍**（只写工程级配置）：不是"为了保守所以选工程级"，
> 而是**实测过工程级确实生效、且影响面可控**。

**证据 3 · 一条对判据 3 的坏消息** 同一个进程带着 `--permission-mode fullAccess`
（以及 `--permission-mode-before-plan bypassPermissions`）⇒ 当前配置下**不会弹审批**，
所以**"`needs-input` 端到端"在本机当前配置下构造不出来**。判据 3 已据此修订（见 §5）。

---

## 1.2 多 agent 并存的答案（用户提问：两个软件同时跑会冲突还是叠加？）

用户原话：*"万一我之后是两个软件同时运行的话，那它是同时读取这两个软件的输入吗？
那不就会有冲突或者是会有叠加的情况发生。"*

**答案分三层，前两层是"不用做"，第三层是"必须做"。**

**第一层 · 同时读取本身不需要新机制。**
仲裁器从 M2 ① 起就是**多会话**形状：`sessions` 是一张以 `sessionId` 为键的表，
`pickPrimary()` 按 **优先级 → 非 idle 优先 → 事件最新者胜** 选出一条主状态，
`state.badgeCount` 统计"除主状态之外仍在要求注意的会话数" —— 就是气泡上那个 `+N` 角标。
所以"两个 agent 同时在跑"在这个设计里**本来就是一个已经被支持的场景**，不是新增负担。
当前优先级表（`desktop-pet.json → statusMap`）：`needs-input`=1 ＞ `blocked`=2 ＞ `ready`=3 ＞ `running`=4。
⇒ 两个都在跑时，宠物演优先级高的那条，另一条计入 `+N`。**这是正确的行为，不需要改。**

**第二层 · 真正的冲突只有一种，而且它来自我们的设计而不是来自多 agent。**
两个**不同**的 agent 各占一个 sessionId，彼此天然隔离，不会"叠加"。
会打架的是**同一个 agent 被两条通道同时盯**：hook 说 `running`、被动源说 `idle`，
两边来回刷 —— 症状是宠物在两帧之间反复横跳，且**没有任何报错**。

> **因此新增一条硬规则（ADR 020 记录）：一个 agent 只由一条通道负责，两条通道互斥。**
> 被动源的角色是"该 agent 没配 hook 时的唯一来源"**或**"hook 失效时的降级来源"，
> **不是并行兜底**。降级是**切换**，不是叠加。

**第三层 · 两件必须做的事（低成本，但不做迟早出事）。**

1. **`sessionId` 必须带来源前缀**：`wb:<pid>` / `proma:<uuid>`。
   否则两个 app 的 UUID 万一相撞，一个会覆盖另一个 —— 概率低，但后果是状态乱跳且难查。
   前缀还有第二个用处：**用户的选择功能靠它实现**（见下）。
2. **标题要能区分来源**：气泡与控制条上显示 `[WorkBuddy] 重构 pack.ts` / `[Proma] 合同标注`，
   否则两个 agent 都叫"某会话"时分不清谁是谁。

**关于你说的"我可以自己选择这个宠物连接哪个 agent 的状态，但这个功能不太好做"** ——
**它比你想的便宜得多**：因为 sessionId 已经带来源前缀了，
"选择连接谁"就是**一次按前缀过滤**，不是新机制。落地形态有两种，都是几行的事：

| 形态 | 怎么做 | 适合 |
|---|---|---|
| **配置开关**（建议先做这个） | `desktop-pet.json → statusSources.{workbuddy,proma}.enabled` | 一次性偏好，改完重启即生效 |
| **面板筛选项** | 控制条会话区加一个来源筛选（复用 `BarCommand` 白名单通道，加一个命令 id） | 边用边切 |

⇒ **结论：两个都能覆盖，可以同时挂钩，不需要为"冲突"发明任何东西；
需要的是"每 agent 一通道"的互斥规则 + 带前缀的命名空间。**

---

## 2. 实测事实基础

### 2.1 WorkBuddy（当前主力；写本文时本机有 9 个进程在跑）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 桌面应用在 `D:\Program\WorkBuddy`（Electron），内嵌 agent 运行时 = **`@genie/agent-cli`**，入口 `resources/app.asar.unpacked/cli/bin/codebuddy`（bins：`codebuddy` / `codebuddy-code` / `cbc` / `cbc-prewarm`） | `cli/package.json` |
| 2 | **hook 引擎完整存在**：`executeHook`×32、`hookSpecificOutput`×50、`permissionDecision`×56、`additionalContext`×40、`disableAllHooks`、`allowManagedHooksOnly` | 扫 `cli/dist/codebuddy.js`（23 MB） |
| 3 | **事件表就在代码里**（14 个）：`PreToolUse` `PostToolUse` `PostToolUseFailure` `Notification` `UserPromptSubmit` `SessionStart` `SessionEnd` `Stop` `SubagentStart` `SubagentStop` `PreCompact` `PermissionRequest` `WorktreeCreate` `WorktreeRemove`；且 `hook_event_name` 出现 49 次 = **与 Claude/Codex 同一套 stdin 契约** | 同上，字面量数组直接可读 |
| 4 | hook 是**真的 spawn 子进程**：日志串 `[HookExecutor] spawn pid=… shell=… timeout=…ms cmd=…`，另有 `buildChildContextEnv` 与 Windows 分支（`isWindows() && shell !== …`） | 同上 |
| 5 | **配置位置**：`.codebuddy/settings.json`（含 `settings.local.json`）、`~/.codebuddy/…`、`~/.workbuddy/…`。官方错误文案直指 *"configure a WorktreeCreate hook in .codebuddy/settings.json"* ⇒ **hooks 就写在 `settings.json` 里**（Claude Code 同构） | 同上 |
| 6 | 工程内 `.codebuddy/` 与 `.claude/` **都不存在** ⇒ 全新铺开、无既有冲突 | 文件系统 |
| 7 | **`~/.workbuddy/sessions/<pid>.json` = 活进程心跳**：`pid` / `lastHeartbeat` / `sessionId` / **`cwd`** / `url`(本地端口) / `kind:"interactive"` / `version`。目录里有 **85 个文件、多数是陈旧会话**（最老 105 天前）⇒ **必须按心跳新鲜度过滤**。~~秒级新鲜~~ → **已更正，实测粒度约 30 秒且不能区分"在干活"，见 §2.5** | 直读 + 151s 采样探针 |
| 8 | **`~/.workbuddy/tasks/<uuid>/N.json` = 任务项结构化状态**：`subject` / `description` / `activeForm` / **`status`**（实测到 `completed`）/ `createdAt` / `updatedAt` | 直读 |
| 9 | 桌面 app.asar 里也有 `executeHook`×37 / `SessionStart`×45 / `PermissionRequest`×161，但 **`hook_event_name` = 0** | 扫 `resources/app.asar` |
| 10 | 其他运行态目录：`projects/`（9 个工作区，含 `…-desktop-pet`）、`logs/<日期>/`（35 天）、`plans/`（空）、`file-history/` | 文件系统 |

> **第 9 条是最重要的不确定项**：桌面本体带着 hook 执行器，但缺少 CLI bundle 里那套完整的
> `hook_event_name` 契约串。两种可能 —— ①桌面把 agent 跑在打包 CLI 上（那 hooks 就能生效），
> ②桌面有自己的进程内运行时（那 hooks 可能不生效）。**这是推断，不是结论，必须实测**（见 §5 判据 0）。

### 2.2 Proma（第二主力，Pi agent 架构；写本文时正在运行，7 个进程）

| # | 事实 | 证据 |
|---|---|---|
| 11 | 装在 `C:\Program Files\Proma`；`resources/bin/proma.exe`（82 MB）是内嵌 agent CLI；`resources/app.asar` 232 MB | 文件系统 + `tasklist` |
| 12 | **`app.asar` 里没有 Claude 系 hook 面**：`PreToolUse` **0**、`hook_event_name` **0**、`disableAllHooks` **0**。`SessionStart` 25 处**逐条看过上下文**，全是编辑器内部变量（`chatRestoredBeforeSessionStart`、`beforeSessionStart?.()`、`emit({type:"session_start",reason:"reload"})`），**不是 agent hook**；`onToolCall`(259)/`beforeToolCall`(24) 同属该组件内部回调 | 扫 app.asar（对照串正常：`AGENTS.md`×79、`SKILL.md`×91、`mcpServers`×172） |
| 13 | `resources/bin/proma.exe` 对全部 hook 关键词 **0 命中** —— **但对照串 `AGENTS.md`/`SKILL.md`/`mcpServers` 也是 0** ⇒ 该二进制的 JS 被压缩，**这条不能作为"不支持"的证据** | 对照实验 |
| 14 | **Proma 暴露的扩展面是 MCP + skills + AGENTS.md**（每个工作区有 `.claude/`（空）、`mcp.json`、`skills/`、`AGENTS.md`） | 文件系统 |
| 15 | **`~/.proma/agent-sessions.json`（1 MB 索引）**：`sessions` **218 条**，字段 `id` / **`title`** / `channelId` / `workspaceId` / `createdAt` / **`updatedAt`** / `stoppedByUser` / `pinned` / `archived` / `legacyTranscript`。标题形如「最新版合同标注来源锚点」 | 直读 |
| 16 | **`legacyTranscript.sourceRuntime` 分布 = `claude` 38 条 / 新（Pi）180 条** ⇒ 实证了你说的"老版本 Claude SDK → 现在 Pi agent SDK"，且**新会话走 Pi** | 直读 |
| 17 | **`~/.proma/agent-sessions/<uuid>.jsonl`**：202 个文件，最新 **2026-09-15**；格式是 Claude Agent SDK 消息流（`type: user\|assistant` + 末尾一条 `type:"result"`，含 `subtype:"success"`、**`terminal_reason:"completed"`**、`session_id`、`_durationMs`） | 解析真实文件（496 行） |
| 18 | `~/.proma/settings.json` 里有 `notificationSounds: {taskComplete, permissionRequest, exitPlanMode, planningReminder}` ⇒ **Proma 自己认这四个事件**，但未发现任何对外通知通道 | 直读 |
| 19 | `~/.proma/planning.db` 是待办/日历功能（19 张表，实测 `todos` 2 行、其余多空），**与 agent 状态无关** | `node:sqlite` 只读打开 |

### 2.3 Codex（初稿目标，现降为顺带兼容）

| # | 事实 | 证据 |
|---|---|---|
| 20 | `codex.exe` = **codex-cli 0.144.2**；`codex features list` → **`hooks` = stable / true**（默认开）；`--dangerously-bypass-hook-trust` 存在；`codex exec --json` 可把事件打成 JSONL（**真实回合可非交互驱动**） | 直接执行 |
| 21 | `~/.codex/config.toml` 的 `notify` 已被 Codex app 的 computer-use 占用；**hooks 是另一套机制**（`~/.codex/hooks.json`），**不冲突** | 读配置 + `codex doctor` |
| 22 | **最后一次活动 2026-08-07**，当前无 codex 进程 ⇒ **已非主力** | `sessions/*` mtime、`tasklist` |
| 23 | **Claude Code 未安装**（`~/.claude` 不存在、`where claude` 无结果） | 文件系统 |

### 2.4 跨通道的成本实测（两条都会用上）

| # | 事实 | 证据 |
|---|---|---|
| 24 | **node 冷启动 ~377 ms**（5 次：359/384/369/396/376） | `spawnSync` 计时 |
| 25 | **curl 冷启动 ~706 ms；连本机未监听端口 2341 ms** ⇒ "用 curl 当 hook 客户端更快"**被实测推翻** | `spawnSync` 计时 |

> 第 24 条直接约束通道 A：**每一次 hook 触发 = 一次进程启动 ≈ 0.4 秒**。
> 所以 A 通道**不允许无脑全开事件**，只挂低频高价值的几个。

---

## 2.5 被动源信号的实测结论（2026-09-18，151 秒 @1Hz 采样探针）

**为什么要先采再写**：查清候选信号里**哪一个真能区分"agent 在干活"与"只是活着"**，
只能实测 —— 本项目已有六次"推断结论被实测推翻"。探针：`spikes/m3-status-sources/probe-workbuddy-live.mjs`
（只读，原始时序落 `live-sample.jsonl`）。采样期间 agent 是**确实在干活**的（正在跑工具调用）。

**结果：WorkBuddy 的被动源拿到的是"存在性"，不是"活动性"。** 逐项：

| 候选信号 | 窗口内实测 | 判定 |
|---|---|---|
| `sessions/<pid>.json → lastHeartbeat` | 151 秒里**只刷新 5 次** ⇒ **粒度约 30 秒**；且刷新与"有没有在干活"无关（挂着不干也会刷） | ⚠️ **只能回答"这个会话进程还活着"**，区分不了 running / 空闲 |
| `tasks/<uuid>/N.json` | **0 次变更**（71 个条目），状态快照全程只有 1 种取值 `{completed:44,in_progress:2,pending:16}` | ❌ 不可用。它是 agent 的**待办清单**，只在建任务/完任务时写，不是活动指示器 |
| `file-history/`（526 条目） | **0 次变更** | ❌ 不可用 |
| `changes-index/`、`plans/` | **0 次变更**（`plans/` 为空） | ❌ 不可用 |
| `projects/`、`artifact-index/` | 4 次 / 2 次 —— 太少，不足以当信号 | ❌ 不可用 |
| `logs/` | **105 次写入**（约 1.4 秒一次）——看起来最像，但**逐项看过内容后否掉**：里面是 `vendor-extract.log` / `win-share-target-registrar.log` / `weixinpay/*.xlog` 这类**应用级日志**，与我干不干活无关 | ❌ 是噪声，不是 agent 活动 |

**由此产生的三条判断（重要，改了本轮的范围）**：

1. **通道 B 对 WorkBuddy 只能做"存在性"来源**（会话在 + `cwd` 当标题），
   **做不了 `running`/`ready` 判别**。把它接上去，宠物只会表现成"有会话就站着、没会话就没反应"，
   比不做更糟 —— 因为它会**看起来像在工作其实没有**（假阳性），而假阳性正是用户最不能接受的失败模式。
2. **通道 A（hooks）对 WorkBuddy 从"精度增强"升级为"唯一能拿到真实状态的手段"。**
   初稿把 B 排在 A 前面当"零风险的先赢"；实测证明 **A 才是 WorkBuddy 的主路径**，B 降为可选。
3. **Proma 的被动源仍值得做，但必须用同样的探针先验一遍** ——
   它的候选信号是**agent 自己的消息流**（`agent-sessions/<uuid>.jsonl` 的追加节奏与末尾 `type:"result"` 行），
   性质与 WorkBuddy 那堆应用日志不同，**很可能真的可用**。但"很可能"不是结论，要采。

> **一条方法论记录**：事实 7 最初写的"秒级新鲜"来自**只看了一次文件的当前年龄**（"它现在很新"），
> 而不是**看它的更新频率**（"它多久更新一次"）。这两件事完全不同 ——
> 前者能推出"刚刚有人写过"，推不出"它一直在写"。更正已回写 §2.1 事实 7。

---

## 2.6 本轮已落地的代码资产（2026-09-18）

| 文件 | 作用 | 状态 |
|---|---|---|
| `tools/codebuddy-hook-map.mjs` | 通道 A 的**纯函数**映射层：14 个 hook 事件 → 业务状态、`sessionId` 命名空间前缀、标题归一化。不 import 任何 electron，可离线测 | ✅ 已落地 |
| `tools/pet-hook-cb.mjs` | 通道 A 的 **hook 客户端**：读 stdin JSON → 原子写状态文件。**退出码恒 0**（观测者不该能拦住 agent）；`--dump` 原样落 payload 供判据 1 取证；stdin 有超时兜底 | ✅ 已落地 |
| `tools/codebuddy-hook.test.mjs` | 上面两者的离线单测：**62 项**（事件表 / 命名空间 / 非法输入 / 真实进程端到端 / **"不踩掉别的 agent 的会话"** / 不碰 `pet-hook.mjs`） | ✅ 62/62 通过 |
| `spikes/m3-status-sources/probe-workbuddy-live.mjs` | 被动源信号采样探针（只读），本轮结论的来源 | ✅ 已跑 |
| `.codebuddy/settings.json` 安装器 | 生成/合并工程级 hook 配置，**默认 dry-run** | ⏳ 待做（下一件） |

**回归**：既有 `tools/status-arbiter.test.mjs` **219 项全绿**（本轮没动 `src/`，只加了两个 tools 端文件）
⇒ 合计 **281 项**。

---

## 3. 范围

### 3.1 做

1. **纯函数归一化层**（两条通道共用）：`事件名/日志行 → PetStatus`，加 `会话 id → sessionId`、`cwd/标题 → title`。
   未知事件、缺字段、非法取值一律**忽略并保留上次好值**（沿用状态文件的投毒纪律）。
2. **通道 A · WorkBuddy hook 适配**：一个读 stdin JSON 的 hook 客户端 + 一份 `settings.json` 的生成器。
3. **通道 B · 被动会话源**：
   - WorkBuddy：`sessions/<pid>.json` 心跳 + `tasks/<uuid>/N.json` 任务状态；
   - Proma：`agent-sessions.json` 索引 + `agent-sessions/<uuid>.jsonl` 末尾的 `result` 行。
4. **真实回合探针**（判据的核心）：用**真实 WorkBuddy 会话**与**真实 Proma 会话**跑，交叉对账。
5. **保守起步**：`.codebuddy/settings.json` 只挂 `SessionStart` / `Stop` 两个事件，确认无害后再加。

### 3.2 不做

- **不做宠物包工具链（⑦-c）**、**不做"忙碌动作"/跨屏**（已关闭）、**不改 `notify`**。
- **不改状态层仲裁规则**（`kernel/status.ts` 一行不动）—— 本轮只加**来源**。
- **不写用户 home 的配置**（见 §7 D5）。
- **不承诺 Proma 的 `needs-input`**：实测未发现 Proma 的对外事件通道，端到端不可验证的东西不写进判据。

---

## 4. 方案骨架

```
通道 A（事件驱动，精度高、含 needs-input）
  WorkBuddy hook ──stdin JSON──▶ tools/pet-hook-cb.mjs ──▶ ~/.desktop-pet/status.json
  Codex hook  ────（同一客户端，仅配置路径不同）      │        │
                                                      ▼        ▼
                                          纯函数映射（事件名→PetStatus）   createStatusFileSource
                                                                   │
通道 B（被动，零配置、零信任、拿不到 needs-input）                        ▼
  ~/.workbuddy/sessions/*.json ┐                            StatusArbiter（唯一真值，不改）
  ~/.workbuddy/tasks/*/N.json  ├─▶ source/workbuddy-live.ts ─┤        │
  ~/.proma/agent-sessions*     ┘   source/proma-sessions.ts ─┘   气泡 / 角标 / 动画 / 控制条
```

映射初稿（**每一行都要靠探针实测校正，不许照抄**）：

**A · 事件 → 状态（WorkBuddy / Codex / 将来的 Claude Code 共用）**

| 事件 | 宠物状态 | 说明 |
|---|---|---|
| `SessionStart` | `idle` | 注册会话，取 `cwd` 作标题 |
| `UserPromptSubmit` | `running` | 回合开始 |
| `Notification` | **`needs-input`** | Claude 系的"等你"事件（WorkBuddy 有此事件） |
| `PermissionRequest` | **`needs-input`** | 更精确的授权等待事件 |
| `Stop` | `ready` | 回合结束（宠物画 waving → review） |
| `SessionEnd` | `--clear` | 会话收尾 |
| `PreToolUse` / `PostToolUse` | **默认不挂** | 每次 0.4 s（实测 24），按判据 6 的数据决定 |

**B · 被动信号 → 状态**

| 信号 | 宠物状态 | 置信度 |
|---|---|---|
| WorkBuddy `lastHeartbeat` 新鲜（< N 秒）**且** `tasks/*` 里有 `status != completed` | `running` | 中（有"活着但闲着"的假阳性） |
| WorkBuddy 心跳新鲜但任务全 completed | `idle` / `ready` | 中 |
| WorkBuddy 心跳陈旧（> N 秒） | `idle`（会话已退） | 高 |
| Proma 会话 `.jsonl` 末尾是 `type:"result"` | `ready` | 高 |
| Proma 会话 `.jsonl` 末尾在追加 `assistant` 行 | `running` | 中 |
| Proma 索引 `updatedAt` 陈旧 | `idle` | 高 |

> 被动通道的调参（N 秒、如何区分"活着但闲着"）**必须先跑采样探针**再定，不预设。

---

## 5. 判据（可执行、可证伪）

| # | 判据 | 做法 | 通过标准 |
|---|---|---|---|
| **0** | ~~闸门：桌面是否执行 hooks~~ ✅ **已完成 = YES**（2026-09-18，证据见 §1.1）：桌面把 agent 跑在内嵌 `cli/bin/codebuddy --serve` 上，且默认作用域含 PROJECT ⇒ 工程级 `.codebuddy/settings.json` 会被读 | 进程树 + `DEFAULT_SCOPES` 定义 | 已给出明确结论与证据 |
| 1 | **hook 触发与 payload 实测**（含空格路径） | 工程级配置只挂 `SessionStart`+`Stop`，命令把 stdin 原样落盘 | payload 里 `session_id`/`cwd`/`hook_event_name` 齐全；**工程路径含空格仍能执行** |
| 2 | **状态序列对账（通道 A）** | 同一次真实回合，宠物侧 `events.jsonl` × agent 侧事件流按时间轴对齐 | 顺序 `running → … → ready`；**不允许卡在 running 不回 ready**；不允许出现映射表外的状态 |
| 3 | **`needs-input` 端到端** | 触发一次真实授权等待 | 宠物进 `needs-input` 且粘滞、确认后解除。**触发不了就如实记"未验证"，不许用模拟顶替** |
| 3a | **判据 3 的前置（2026-09-18 新增）** | 先确认能不能在本机造出审批 | **实测：当前会话带 `--permission-mode fullAccess` ⇒ 不会弹审批 ⇒ 判据 3 在本机当前配置下无法执行。** 需先找到一个会弹审批的配置（如把 permission-mode 调回默认/plan），**或如实把它记为"未验证"** |
| 4 | **被动源对账（通道 B）** | 你正常用 WorkBuddy / Proma 干活时后台采样，事后与真实时间轴比对 | `running`/`ready`/`idle` 的**判定准确率与假阳性率各出一个数字**；标题正确 |
| 5 | **不污染你的环境** | 探针全程 | `~/.workbuddy`、`~/.proma`、`~/.codex` 内容 hash 不变；探针状态文件用 `--file=` 指向临时路径 |
| 6 | **性能预算** | 计一次典型回合的额外耗时 | 出**数字**（事件数 × 0.377 s），据此定事件集 |
| 7 | **既有回归不破** | `status-arbiter.test.mjs` + 三条窗口探针（带 `--no-behavior`）+ `probe-stale-sessions.mjs` | 全绿；`喂状态.bat` / `pet-hook.mjs` 行为不变（新增参数一律可选） |
| 8 | **失败要能看出来** | 拔掉配置 / 杀掉 agent 后各跑一次 | 宠物**不报错、不乱跳**，只是不跟着动；日志里有一句可诊断的说明 |
| 9 | **你自己的活不能被拖慢** | 装了 hook 后正常用 WorkBuddy 一个回合 | 主观无感 + 判据 6 的数字有上界；**做不到就砍事件集，或整个弃用 A 通道** |

**判据纪律**（AGENTS.md 已载明）：判据必须只让被测的那条规则生效 —— 测 hook 触发时关掉行为层与被动源；
测被动源时关掉 hook。**平台结论一律以探针输出为准，文档只能用来写探针，不能用来写结论。**

---

## 6. 执行顺序（已按实测修订 2026-09-18）

初稿把"通道 B 先做"当作零风险的先赢。**§2.5 的实测推翻了这个排序**：
B 对 WorkBuddy 只能给"存在性"，给了反而制造假阳性 ⇒ **A 才是 WorkBuddy 的主路径**。修订后：

| 步 | 内容 | 判据 | 状态 |
|---|---|---|---|
| **Step 0** | 闸门：桌面是否派发 hook | 0 | ✅ **YES**（§1.1，进程树 + `DEFAULT_SCOPES`） |
| **Step 1** | 映射层（纯函数）+ hook 客户端 + 离线单测 | — | ✅ **已落地 62 项全绿**（§2.6） |
| **Step 2** | 安装器（**默认 dry-run**）→ 落工程级 `.codebuddy/settings.json` → **跑真实回合** | 1 / 2 / 6 / 9 | ⏳ 下一件。**需要你一句 go 才落盘**（D5 的承诺：先给你看 diff 与影响面） |
| **Step 3** | 通道 B：**先在 Proma 上跑同样的采样探针**，能用才写适配器；WorkBuddy 侧只保留"存在性"（如果它确实有用） | 4 / 8 | ⏳ |
| **Step 4** | 收工四件事 | — | ⏳ |

**止损设计仍然成立**：

- Step 2 若判据 9（拖慢你正常的活）不过，**就砍事件集或整个弃用 A** —— 那时本轮以
  "映射层 + 客户端 + 一条明确的负面结论"收尾，**不硬凑**。
- `needs-input`（判据 3）**在本机当前配置下大概率验证不了**
  （`--permission-mode fullAccess` 不弹审批，§1.1 证据 3）。**届时如实记"未验证"**，
  并给出"要哪种配置才能验"的说明 —— 不许用模拟顶替。

---

## 7. 待你拍板

**D1（你已答，此处收窄确认为一个选择）** —— 你说"两个都要覆盖"。我的建议是**架构按两条通道设计、
执行按 §6 的顺序**。请确认这三种范围取哪一种：

- **(S1) 两条通道都做 —— 推荐**：覆盖 WorkBuddy + Proma，含 `needs-input`。工作量最大。
- **(S2) 只做通道 B（被动源）**：两个工具都覆盖，**零平台不确定性**，但**拿不到"等你授权"那个状态**。
  如果你想要"这轮一定有个稳的交付"，选它。
- **(S3) 只做通道 A（WorkBuddy hook）**：最精确，但只覆盖一个工具，且押在待验证的平台行为上。

**D2（你已答"按推荐"）** —— 采纳：**低频事件集**起步，只挂 `SessionStart` / `UserPromptSubmit` /
`Notification` / `PermissionRequest` / `Stop` / `SessionEnd`；**`PreToolUse`/`PostToolUse` 默认不挂**，
按判据 6 的数字再决定。理由：实测每次触发 ≈ 0.377 s（事实 24）。

**D3（你说"文件源"，我理解为随我定）** —— **修正为：必须做，而且先做**。
初稿建议"本轮不做被动源"，那是**在以为 Proma 有 hook 的前提下**写的。
现在实测推翻了那个前提（事实 12/13）：**被动源是覆盖 Proma 的唯一可行路径**，所以它从"可选"变成"必需"。

**D4（Claude Code）** —— **与你担心的相反：零冲突，而且不用现在碰。**
WorkBuddy 的 hook 引擎与 Claude Code **就是同一套协议**（同一份 14 事件表 + 同一个 `hook_event_name`
stdin 契约，事实 3）。所以：映射层是共用的，将来要支持 Claude Code ＝ 把同一份 hooks 配置写到
`~/.claude/settings.json`，代码零改动。而 Proma 的 SDK 迁移（Claude SDK → Pi agent SDK）**不影响这条线** ——
Proma 走的是完全独立的通道 B（读会话日志），不是 hook。**结论：本轮不装 Claude Code，
但在代码里把"配置落哪个路径"做成参数，将来加一行配置即可。**

**D5（安装器要不要真写配置）—— 我的自主分析结论：**

1. **探针阶段只碰工程级 `.codebuddy/settings.json`**，**不写 `~/.codebuddy/` 或 `~/.workbuddy/`**。
   理由：用户级配置会作用于你**所有** WorkBuddy 会话 —— 包括你现在正用来跟我说话的这个。
   一个写坏的 hook 会拖慢或干扰你手头上所有的活，而工程级的影响面是可控、可 git 回滚的。
2. **安装器默认 dry-run**：打印将要写入的 JSON diff 与**影响面**（会拖慢什么、怎么撤回），
   要你确认后才落盘；`--user` 才允许写用户级，且必须先备份。
3. **起步只挂 2 个事件**（`SessionStart` + `Stop`），确认无害后按判据 6 的数字再加。
4. **提供 `--uninstall`**，并把"怎么确认已经彻底摘干净"写进 README。
5. **工程级配置会进 git** —— 这是好事（有 diff、能回滚），但要在 `.gitignore` 里想清楚
   `settings.local.json` 是否排除（我建议排除，理由：本机路径因人而异）。

**另需一项授权**：判据 0/1/2/3 需要跑**真实 WorkBuddy 回合**（会消耗你的额度）；
判据 4 需要在你正常干活时后台采样（不打扰你，只读文件）。请一并确认。

---

## 8. 风险与止损

| 风险 | 止损 |
|---|---|
| **WorkBuddy 桌面不派发 hook**（事实 9 的不确定项） | 判据 0 是第一道闸；答 no 就转纯通道 B，并把结论写进 ADR |
| hook 拖慢你正常的活 | 判据 9 + 事件集起步只两个 + 默认 dry-run；不过就砍 A 通道 |
| Proma 日志格式随版本变（未文档化内部格式） | 按投毒纪律处理：白名单取值、解析失败保留上次好值、**失败即静默降级**；格式变化要有可诊断日志 |
| 被动源把"活着但闲着"判成 `running` | 判据 4 出**假阳性率数字**；必要时降级为"只报存在性，不报 running" |
| 探针搞乱你的真实状态 | 判据 5：只读 + `--file=` 指向临时路径 |
| 两件事压进一轮、出问题分不清层 | §6 的顺序 + 两个独立探针；任一通道单独可交付 |
| Proma `agent-sessions.json` 是 1 MB 且频繁重写 | 被动源监听**目录**而非文件（沿用 `status-file.ts` 的既有做法），并设轮询兜底 |

---

## 9. 收工四件事（AGENTS.md）

1. 更新 `PLAN.md` §3 状态表与 §9 变更日志；
2. 本轮"为什么这么决定"落 `docs/decisions/020-*.md`（至少含判据 0 的平台结论）；
3. `journal/2026-09-18-*.md` 追加当日记录；
4. `git add -A && git commit`。

---

## 10. 附：已实测排除的路径

- **用 `curl` 做 hook 客户端**：706 ms 起（node 377 ms），连不通端口 2341 ms —— 正常路径更慢、失败路径慢 6 倍。排除。
- **常驻 pipe/本地服务 + 每次 hook 起一个客户端进程**：客户端仍是进程，省下的只有"读一个文件"，
  相对 0.377 s 可忽略。排除。
- **让 hook 直接读 Codex 的 `notify`**：单槽且已被 Codex app 占用。排除。
- **Proma 走 hook**：实测 app.asar 无 hook 面（对照实验通过，事实 12）；82 MB CLI 二进制被压缩，
  既不能肯定也不能否定，但**没有可配置的入口**已经足够下"不作为本轮路径"的判断。
- **Proma 的 `planning.db`**：19 张表，是待办/日历功能，与 agent 状态无关（事实 19）。排除。
