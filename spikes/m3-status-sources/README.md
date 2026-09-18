# spikes/m3-status-sources

通道 B（被动会话源）的**信号采样探针**。结论已回写到 `docs/decisions/020-状态源生态与双通道.md`
与 `docs/design/m3-status-ecosystem.md` §2.5，本目录按 AGENTS.md 的约定**可丢弃**。

## 为什么先采再写

被动源要区分"agent 在干活"与"只是活着"。候选信号有一堆（心跳新鲜度、任务状态、各运行目录的 mtime），
但**哪一个真能区分，只能实测** —— 本项目已有六次"推断结论被实测推翻"。
所以在写适配器之前先采一段真实时间线。

## 跑法

```bash
node spikes/m3-status-sources/probe-workbuddy-live.mjs --seconds=150
```

只读：全程不写 `~/.workbuddy` 下的任何文件。输出落 `live-sample.jsonl`（已 gitignore，可重跑生成）。

## 2026-09-18 的结论（WorkBuddy）

采样期间 agent **确实在干活**（正在跑工具调用）。结果：

| 候选信号 | 窗口内实测 | 判定 |
|---|---|---|
| `sessions/<pid>.json → lastHeartbeat` | 151 秒里**只刷新 5 次** ⇒ **粒度约 30 秒**，且与"在不在干活"无关 | ⚠️ 只能给**存在性** |
| `tasks/<uuid>/N.json` | **0 次变更**（待办清单，只在建/完任务时写） | ❌ |
| `file-history/`、`changes-index/`、`plans/` | **0 次变更** | ❌ |
| `projects/`、`artifact-index/` | 4 次 / 2 次（太少） | ❌ |
| `logs/` | 105 次写入，但内容是 `vendor-extract.log`、`win-share-target-registrar.log`、`weixinpay/*.xlog` 这类**应用级日志** | ❌ 噪声 |

**结论：WorkBuddy 的被动源只能给"存在性"，给不了"活动性"。** 硬接上去会制造**假阳性**
（看起来像在工作其实没有），而假阳性是最不能接受的失败模式
⇒ **通道 A（hooks）才是 WorkBuddy 的主路径**。

## 下一步（Proma）

Proma 的候选信号**性质不同** —— 是 **agent 自己的消息流**
（`~/.proma/agent-sessions.json` 的 `updatedAt`、`agent-sessions/<uuid>.jsonl` 的追加节奏
与末尾 `type:"result"` 行），不是应用日志。**很可能真的可用，但"很可能"不是结论，要采。**

跑之前把探针的读取路径参数化（现在硬编码 `~/.workbuddy`）。
