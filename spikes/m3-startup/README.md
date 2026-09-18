# spikes/m3-startup — 启动耗时归因

## 这个探针验什么

「启动要数秒」这件事**慢在哪一段**。启动耗时是加总效应，每一处单独看都"几十毫秒、不像问题"，
所以必须让每一段自己报数。

## 怎么跑

```bash
node spikes/m3-startup/run-cost.cjs     # 分三段量：build / npm start / 直接跑 electron
node spikes/m3-startup/run.mjs          # 拉起 Electron（带 --trace-boot），解析打戳行
```

两个脚本都会往本目录写 JSON：`startup-cost.json`、`startup-timing.json`。

## 判据

不是断言式探针（它不判 PASS/FAIL），而是**定量输出**。判据是人工读表：

| 你想知道的事 | 看哪个字段 |
|---|---|
| 启动总耗时是多少 | `startup-cost.json` 的 `totalMs` |
| 慢在哪一段 | 同上，`buildMs` / `npmStartMs` / `electronMs` |
| 应用代码自己花了多久 | `startup-timing.json` 里 `app ready` → `boot() 返回` 的差 |
| 构建本身有效耗时 | `run-cost.cjs` 输出里的 tsc / esbuild / copy-assets 分项 |

## 2026-09-18 实测结论（留档）

| 阶段 | 耗时 | 占比 |
|---|---|---|
| `npm run build`（无条件全量） | **29,941 ms** | **93%** |
| `npm start` 的 npm 引导 | 1,232 ms | 4% |
| Electron → 窗口可见 | 871 ms | 3% |
| 合计 | **≈ 32 s** | 100% |

`boot()` 内部只花 **322 ms**（283ms app ready → 605ms boot 返回）—— **应用代码不是瓶颈**。
拆开构建链（`tools/run-build.cjs`）有效构建仅 ≈5.3s（tsc 3.3s + 6×esbuild 1.4s + copy-assets 0.6s），
**约 24.6 秒是 npm 自身的解析/加载开销**。

## 注意

- `--trace-boot` 是生产路径零开销的接缝：不开这个开关时 `bootMark` 是空函数。
- 驱动脚本必须 `import { spawn, execSync } from 'node:child_process'`（**ESM 里没有 `require`**，
  初版在这里报过 `require is not defined`）。
- 结束要 `taskkill /PID <pid> /T /F` —— `child.kill()` 带不走 detached 的 Electron。
- 本工程路径含空格，解析 `import.meta.url` 必须用 `fileURLToPath`，直接做字符串替换会留下 `%20`。
