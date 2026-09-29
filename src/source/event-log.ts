// 事件流水落盘（`~/.desktop-pet/events.jsonl`）。
//
// 为什么单独一个模块（2026-09-29，审计 P1-6 / P1-10）：原实现是主进程里一行
// `appendFileSync(...)`，带来三个问题，而它们**都不能被测**：
//
//   1. **每次追加都重新打开文件** —— `appendFileSync` 每次 open/close，事件密集时是纯浪费。
//   2. **无上限、无轮转** —— 开机自启场景下常驻运行，长期无限增长。
//   3. **`recvAt` 的值没有任何自动化覆盖** —— 而它是判据 6（端到端延迟）的**唯一时间基准**。
//      它若被误写成 `ts` 的副本，延迟会恒为 0，而 `tools/measure-latency.mjs` 仍会
//      输出一张**看起来完全合理**的延迟分布图 —— 典型的静默失败。
//
// 抽出来之后：路径、上限、时钟都可注入 ⇒ 轮转与 `recvAt` 的语义能在单测里钉住。
//
// ═══ 为什么是同步 fd 而不是 `createWriteStream`（一个被推翻的建议）═══
//
// 审计 P1-6 的建议原文是"改为异步追加（`fs.createWriteStream`）"。**没有照做**，理由有三条，
// 都是实测/推演出来的，不是偏好：
//
//   ① **轮转要求"改名时文件必须是关闭的"**。流式写的 `end()` 是异步的，改名必须等 `close`
//      事件；而"等到 close 再改名"会让 `append()` 变成异步 API —— 调用方（`recordEvent`）
//      根本不在乎，却要为每个调用点引入回调或队列。同步 fd 让"关闭 → 改名 → 重开"是
//      一条直线，中间没有任何可被打断的窗口。
//   ② **可测性**。异步写在测试里只能靠 sleep 猜 flush 时机，而**靠时间猜的判据就是本项目
//      反复吃亏的那种**（mtime 骗过人、`grep -c && cp` 链断过）。同步写落盘即生效，
//      断言不需要任何等待。
//   ③ **代价很小**。事件是**秒级**的（不是每帧），每条几百字节；`writeSync` 写进 page cache
//      就返回，不做 fsync。原实现的开销大头在"每次重新 open/close 文件"，而这一点已经消除。
//
// 结论：保留同步，但把"每次重开文件"换成"持有一个 fd"，并补上轮转与 `recvAt` 的判据。
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** 单个文件的默认上限（5 MiB）。到上限就轮转，只保留一份 `.1`。 */
export const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface EventLogWriter {
  /** 追加一条事件。会**附加 `recvAt`**（宠物收到的时刻），调用方不要自己写这个字段。 */
  append(event: { ts?: number } & Record<string, unknown>): void;
  /** 关闭底层 fd（退出时调用）。幂等。 */
  close(): void;
  /** 当前文件已写入的字节数（测试用）。 */
  size(): number;
  /** 已发生的轮转次数（测试用）。 */
  rotations(): number;
  readonly path: string;
}

export interface EventLogOptions {
  path: string;
  /** 超过它会轮转（默认 {@link EVENT_LOG_MAX_BYTES}）。 */
  maxBytes?: number;
  /** 取"宠物收到事件的时刻"。默认 `Date.now`；注入它是为了让单测能确定性地断言。 */
  now?: () => number;
  /** 写失败时的告警出口（默认吞掉 —— 日志写失败绝不能影响运行）。 */
  onError?: (message: string) => void;
}

/**
 * 创建写入器。初始即打开（append 模式），每次追加复用同一个 fd。
 *
 * 轮转策略：**写入前**检查记账字节数，超限就把当前文件改名为 `<path>.1`（覆盖上一份）再开新文件。
 * 刻意不做多份编号轮转 —— 这份流水是排查用的，一份足够；多份只是在磁盘上留更多垃圾。
 * 改名的前提是**我们持有且已关闭那个 fd**，所以顺序固定为「关 → 改名 → 重开」，中间不打岔。
 */
export function createEventLogWriter(opts: EventLogOptions): EventLogWriter {
  const { path, maxBytes = EVENT_LOG_MAX_BYTES, now = () => Date.now() } = opts;
  const warn = opts.onError ?? ((): void => { /* 静默：写日志失败不该影响运行 */ });

  let fd: number | null = null;
  let written = 0;
  let rotated = 0;

  const closeFd = (): void => {
    if (fd === null) return;
    try { closeSync(fd); } catch { /* 已经关掉了 */ }
    fd = null;
  };

  const open = (): void => {
    closeFd();                       // ① 先确保没有打开的句柄（否则改名会 EBUSY）
    try {
      if (existsSync(path) && statSync(path).size >= maxBytes) {
        const prev = path + '.1';
        try { rmSync(prev, { force: true }); } catch { /* 上一份删不掉就覆盖写 */ }
        renameSync(path, prev);
        rotated++;                   // ② 改名
      }
    } catch (e) {
      warn('事件日志轮转失败（继续写当前文件）：' + String(e));
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      written = existsSync(path) ? statSync(path).size : 0;
      fd = openSync(path, 'a');      // ③ 重开
    } catch (e) {
      fd = null;
      warn('事件日志打开失败（不影响运行）：' + String(e));
    }
  };

  open();

  return {
    path,
    append(event) {
      const line = JSON.stringify({ ...event, recvAt: now() }) + '\n';
      // 到上限就轮转一次（不是每次写入都查 —— 只有真的越线才走这条分支）
      if (fd === null || written >= maxBytes) open();
      if (fd === null) return;                 // 打不开就静默丢弃：日志失败不该影响宠物
      try {
        writeSync(fd, line);
        written += Buffer.byteLength(line, 'utf8');
      } catch (e) {
        warn('事件日志写入失败（不影响运行）：' + String(e));
        closeFd();
      }
    },
    close: closeFd,
    size: () => written,
    rotations: () => rotated,
  };
}
