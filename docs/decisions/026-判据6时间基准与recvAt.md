# ADR 026：判据 6 的时间基准落地（+ 挂起清单 #8 / #9 清账）

- 日期：2026-09-18
- 状态：已实施
- 关联：ADR 020（负面结论：`events.jsonl` 的 `ts` 是写侧时刻）、PLAN.md §4 挂起清单
- 触发：M3 第二块收尾 —— WorkBuddy 通道成品化，判据 6 需要"端到端延迟"这个数字

## 0. 结论

`recordEvent()` 增加 `recvAt`（宠物收到的时刻），**端到端延迟 = `recvAt - ts`**。
实测（真实窗口、真实两进程拓扑）：**6/6 条事件带 `recvAt`，延迟 105–113ms，中位 110ms**。

**对照**：此前用 `ts` 之差算出来只有 **2ms** —— 低估约 **55 倍**。
ADR 020 那条负面结论（"`ts` 是写侧产生时刻，拿它算延迟会严重低估"）由此从推断变成有数字。

## 1. 改了什么

| 项 | 内容 |
|---|---|
| `src/main/index.ts` | `recordEvent()` 落盘时写 `{ ...e, recvAt: Date.now() }`，并注释说明为什么必须有这个字段 |
| `tools/measure-latency.mjs`（新） | 离线读 `events.jsonl`，按通道/会话统计 min/中位/p95/max；支持 `--since=` / `--budget=`；**没有 `recvAt` 的旧记录单列计数、不参与统计**（否则"测不出来"会被误报成"延迟很低"） |
| `spikes/m3-latency/run.mjs`（新） | 真实验证：启动桌宠 → 用 `pet-hook.mjs` 喂 6 条（**两个进程，与真实拓扑一致**）→ 读回流 → 判定 |

## 2. 判据

- 单测 **304 项**全过；`npm run typecheck` **0 错**；完整 `npm run build` 0 错。
- `spikes/m2-control/run.mjs` **PASS**（`STATUS_TEXT` 改写法后面板状态文案链路正常）。
- `spikes/m3-latency/run.mjs` **PASS**：喂 6 条收到 6 条（无丢失）、6/6 带 `recvAt`、无负延迟、最大 113ms。
- `node tools/measure-latency.mjs` 对旧流水正确报"430 条无 recvAt、无法测量"（不误报）。

## 3. 顺带清掉的两项挂起（#8 / #9）

- **#8 `badgeCount` 注释错位**：注释写"仍在**要求注意**的会话数"，实现是
  `effectiveStatus !== 'idle'` ⇒ `running` / `blocked` / `ready` 也都算。
  **实现是对的（角标语义就是"还有几条在活动"），改的是注释**，把"不限于要求注意那两类"写清楚。
- **#9 `STATUS_TEXT` 缺 `satisfies`**：从 `Record<PetStatus, string>` 注解改为
  `satisfies Record<PetStatus, string>`。好处是**漏写一种状态变成编译错误**，
  同时保留字面量键类型（`statusLabels` 传给渲染层时键名仍然精确）。

## 4. 为什么"加一个时间戳"也值得一份 ADR

因为它是**判据 6 唯一可用的时间基准**，而判据 6 是"WorkBuddy 通道能不能算成品"的两条判据之一。
没有它，判据 9（会不会拖慢你正常的活）拿到主观感受后，也**没有一个客观数字可以对照** ——
用户说"感觉有点卡"，我们拿不出"延迟是多少"来定位。

同时它纠正了一个会被反复犯的错：**以后任何人想量"延迟"，都会先去减两个 `ts`** ——
现在 ADR、`recordEvent()` 的注释、`measure-latency.mjs` 的文件头三处都写了为什么不行。

## 5. 下一步（判据 9 还差用户一次真实回合）

判据 6 已能出数字；**判据 9（会不会拖慢正常的活）只能由用户在真实回合里回答**。
流程：用户正常干活（桌宠开着）→ 事后跑 `node tools/measure-latency.mjs --since=60` 取数
→ 对照主观感受四问（有没有卡顿感、有没有被抢焦点、气泡有没有打扰、快捷键有没有误触）。
