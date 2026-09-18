# spikes/m3-ready-ack — `ready` / `needs-input` 的消解链

## 这个探针验什么

用户报告「agent 干完后 `ready` 的炒菜动画一直保持，点了也不回待机」。这一组探针
**逐层排除**，最后定位到两个独立成因。

三个探针，按"从内核到真实配置到真实缺陷序列"递进：

| 探针 | 验什么 | 判据 |
|---|---|---|
| `probe-ready-ack.mjs` | 手写简化 statusMap 下，内核 `ack()` 对 `ready` 与 `needs-input` 是否都能消解 | 11/11 |
| `probe-real-config.mjs` | **真实** `desktop-pet.json` 的 statusMap + 真实 `behavior-map.json` 下同样成立 | 5/5 |
| `probe-ack-revival.mjs` | **复刻用户的真实失败序列** —— 确认位会不会被自己"回来" | 13/13 |

## 怎么跑

```bash
node spikes/m3-ready-ack/probe-ready-ack.mjs
node spikes/m3-ready-ack/probe-real-config.mjs
node spikes/m3-ready-ack/probe-ack-revival.mjs
```

都是离线、秒级、无窗口。

## `probe-ack-revival` 的四个情形

1. **同一会话反复重报 `needs-input`（`ts` 每次都变）** —— 同状态重报**不该**撤销用户的确认。
2. **双通道交替（hook 报 `running` / file 报 `needs-input`）** —— 交替**不该**让确认位复活。
   `acknowledged` 全程必须保持 `true`。
   - **这是用户报告的那个缺陷**：修复前 revivals = **3**（点完十几秒宠物又举手），修复后 **0**。
   - 机制：`source/status-file.ts:202` 把"`ts` 变了"翻译成一条新事件，而 `ingest()` 原判据
     按**状态字符串**记账（"非 needs-input → needs-input 就清确认位"），双通道来回跳就反复清。
   - 修法：新增 `reAskMinIntervalMs` 迟滞窗口（默认 60s），把确认锚定在**求助的实例**上；
     **离开 `needs-input` 刻意不清 `needsInputSince`** —— 交替正是靠这一点被挡住。
2b. **迟滞窗口之外的重新举手仍应生效** —— **反向用例，防误杀**。会话隔 90 秒后真的又提了个新问题，
   必须重新举手且 `acknowledged` 复位。缺了这条，"修复"可能只是把机制彻底焊死。
3. **`ready` 被文件源重报** —— 重报不该延长通报时效，也不该让已确认的它复活。

## 两个坑（都踩过）

1. **两次 `ingest` 之间必须显式推进时钟**。情形 2b 首版在同一次钟值上连发两条 `ingest`，
   结果量到的是 500ms **限流窗格**（`Math.max(minDisplayMs 400, throttleMs 500)`）而不是被测的
   **迟滞窗口** —— 断言报假失败。这与 M2 ④ 第一版探针"没先把宠物挪离右下角就测贴边"是
   **同一类判据不纯**。现已各给 1 秒。
2. **断言方向别写反**。情形 2 的断言最初写成"缺陷存在"（`revivals > 0`），修复后 revivals=0
   反而"失败"。断言要表达的是**期望行为**（不该复活 → 期望 0），不是"当前缺陷的样子"。

## 注意

- 本工程路径含空格：解析根目录必须 `fileURLToPath(new URL('../../', import.meta.url))`，
  直接对 URL 做字符串替换会得到 `desktop%20Base` 然后 ENOENT。
- 探针跑的是 `dist/kernel/status.js` —— **改了 `src/` 必须先构建**，否则量的是旧代码。
