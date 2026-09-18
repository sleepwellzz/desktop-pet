// 状态源适配器之一：状态文件 + 监听。
//
// 为什么第一个真实 hook 选文件而不是本地 HTTP（2026-09-11 与用户确认）：
//   - 任意 agent 的 hook 点都能用一条命令写入，不需要额外依赖；
//   - 不引入监听端口 → 没有端口占用、防火墙弹窗与"疑似流氓软件"的观感风险；
//   - 进程重启后状态自然还在（快照语义），HTTP 推送则要求双方同时在线。
//
// 契约：文件是**快照**（谁在什么状态），本适配器负责 diff 成**增量事件**再交给仲裁器。
// 这样仲裁器可以保持纯函数，读写文件这种脏活全部压在这一层。
import { closeSync, fstatSync, openSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { isPetStatus, type PetStatus, type StatusEvent } from '../kernel/status';
import type { StatusSource } from './types';

export const DEFAULT_SESSION_ID = 'default';
export const STATUS_FILE_SCHEMA = 'desktop-pet/status/v1';

export interface StatusFileSourceOptions {
  /** 状态文件的绝对路径。 */
  path: string;
  /** 轮询兜底间隔（默认 1000ms）。 */
  pollMs?: number;
  log?: (message: string) => void;
}

interface Entry {
  status: PetStatus;
  title?: string;
  /**
   * 写侧自称的**通道来源**（`'hook'` = 挂在 agent hook 上的客户端；缺省时本适配器标 `'file'`）。
   *
   * 为什么需要它：ADR 020 规定"一个 agent 只由一条通道负责"，而内核判断这件事
   * 只能靠 `origin`（`StatusArbiter` 的告警见 `kernel/status.ts`）。没有它，
   * 所有事件都长一个样，"同一个 agent 被两条通道同时盯"就永远是个只写在文档里的约束。
   * 取值按投毒点的同一套纪律校验：长度与字符白名单，不认识的丢弃（而不是原样透传）。
   */
  origin?: string;
  /** 事件时刻（epoch ms）。缺省表示写侧不提供心跳，此时"存活时间"只能靠状态变化刷新。 */
  ts?: number;
  /**
   * 上面那个 `ts` 是**快照的写入时刻**（文件 mtime），不是条目自带的时间戳。
   *
   * 这类条目**不参与 `diff` 里"ts 变了就算心跳"那条分支**：同一份文件里的所有会话
   * 共享一个 mtime，把它当心跳，任**别**的会话被写一次就等于给这条陈旧的、
   * 早已不存在的会话续命 15 分钟 —— 那正是本字段存在的理由（ADR 016）。
   */
  tsFromFile?: boolean;
}

/**
 * 读取并校验一个会话条目。状态值不在白名单内一律丢弃并告警 ——
 * 状态文件是任意进程都能写的投毒点，这里沿用宠物包校验的同一套纪律：
 * 不认识的字段不读、不认识的取值不用、文本限长。
 *
 * @param fileTime 这份快照的写入时刻（mtime）。**只在条目自己没写 `ts` 时使用**，
 *   详见下方注释 —— 这是"陈旧会话被当成新鲜"那个缺陷的修复点（ADR 016）。
 */
function toEntry(
  raw: unknown,
  log: (m: string) => void,
  who: string,
  fileTime: number | null,
): Entry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isPetStatus(o['status'])) {
    log(`会话 ${who} 的状态取值非法，已忽略：${JSON.stringify(o['status'])}`);
    return null;
  }
  // 刻意**不**在这里补 Date.now()：那样每次轮询读盘都会得到一个"新"时间戳，
  // 于是轮询本身变成了假心跳，静默兜底会永远不触发（等于悄悄关掉了一道保险）。
  const ts = typeof o['ts'] === 'number' && Number.isFinite(o['ts']) ? o['ts'] : undefined;
  const title = typeof o['title'] === 'string' ? o['title'].slice(0, 120) : undefined;
  const origin = typeof o['origin'] === 'string' ? o['origin'].slice(0, 32) : undefined;
  const entry: Entry = { status: o['status'] };
  if (title !== undefined) entry.title = title;
  // 只认 `[A-Za-z0-9_-]`：来源是诊断用的短标签，不是自由文本，也不该进 UI。
  if (origin !== undefined && /^[A-Za-z0-9_-]+$/.test(origin)) entry.origin = origin;
  if (ts !== undefined) {
    entry.ts = ts;
  } else if (fileTime !== null) {
    // 条目没写 ts —— 补**快照的写入时刻**，而不是"现在"。
    //
    // 为什么（2026-09-17 实测，spikes/m2-status/probe-stale-sessions.mjs）：快照是
    // 原样读回的，一份昨天写的、不带 ts 的 `running` 快照，此前会被内核的兜底
    // `ts ?? now` 盖章成"现在"，于是这条早已死掉的会话在启动后"新鲜"整整 15 分钟 ——
    // 用户看到的是"一启动就显示某某在运行中"。
    // 正确语义是：**"不知道"不等于"刚刚"**。快照的 mtime 是唯一可用的时间证据，
    // 拿它兜底，旧快照会立刻落进静默兜底，新写的快照照常有效。
    entry.ts = fileTime;
    entry.tsFromFile = true;
  }
  return entry;
}

/**
 * 归一化成 sessions 快照。返回 null 表示"这份内容不是一份可识别的快照"，
 * 此时调用方必须保留上一次的好值 —— 半截文件、编辑器里的临时内容都不该让状态清零。
 *
 * `unusable` 记录"写了但读不懂"的会话 id。它必须与"没写"区分开：
 * 前者是**未知**（保留上一次状态），后者才是**消失**（补一条 idle 收尾）。
 * 把二者混为一谈的后果是：一条字段写错的状态会让宠物立刻掉回 idle ——
 * 单测里正是这一条先挂的。
 */
function normalize(
  raw: unknown,
  log: (m: string) => void,
  fileTime: number | null,
): { entries: Map<string, Entry>; unusable: Set<string> } | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const sessions = obj['sessions'];
  if (sessions && typeof sessions === 'object') {
    const entries = new Map<string, Entry>();
    const unusable = new Set<string>();
    for (const [id, v] of Object.entries(sessions as Record<string, unknown>)) {
      const e = toEntry(v, log, id, fileTime);
      if (e) entries.set(id, e);
      else unusable.add(id);
    }
    // 显式写了 sessions（哪怕是空对象）= 一份合法快照，含义是"这些会话之外都不存在"。
    return { entries, unusable };
  }

  // 单会话简写：{"status":"running","title":"…"}
  if ('status' in obj) {
    const e = toEntry(obj, log, DEFAULT_SESSION_ID, fileTime);
    return e ? { entries: new Map([[DEFAULT_SESSION_ID, e]]), unusable: new Set() } : null;
  }
  return null;
}

export function createStatusFileSource(opts: StatusFileSourceOptions): StatusSource {
  const pollMs = opts.pollMs ?? 1000;
  const log = opts.log ?? (() => {});
  const path = opts.path;

  let last: Map<string, Entry> | null = null;
  let emit: ((e: StatusEvent) => void) | null = null;
  let watcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let started = false;
  let parseWarnAt = 0;

  function readOnce(): void {
    let text: string;
    let fileTime: number;
    try {
      // 用**同一个 fd** 取"这份内容的写入时刻"：分两次打开（先 stat 再 read）会有竞态，
      // 而快照的 mtime 是"条目没写 ts"时唯一可用的时间证据（详见 toEntry）。
      const fd = openSync(path, 'r');
      try {
        fileTime = fstatSync(fd).mtimeMs;
        text = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      // 文件不存在是正常起点（还没接过 hook），不是错误。
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') log(`读取状态文件失败：${String(e)}`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // 解析失败保留上一次好值。限流告警：写侧可能有半截写入。
      const now = Date.now();
      if (now - parseWarnAt > 5000) {
        parseWarnAt = now;
        log(`状态文件不是合法 JSON，已保留上一次状态：${path}`);
      }
      return;
    }
    const prev = last;
    const next = normalize(raw, log, fileTime);
    if (!next) {
      const now = Date.now();
      if (now - parseWarnAt > 5000) {
        parseWarnAt = now;
        log(`状态文件结构不可识别（既无 sessions 也无 status），已保留上一次状态`);
      }
      return;
    }
    diff(prev, next);
    // 读不懂的会话保留上一次的已知值：它属于"未知"而不是"消失"，
    // 丢掉它会让下一次快照里它的缺席被误读成"已被移除"。
    const merged = new Map(next.entries);
    if (prev) {
      for (const id of next.unusable) {
        const old = prev.get(id);
        if (old) merged.set(id, old);
      }
    }
    last = merged;
  }

  /** 把快照差异变成增量事件。ts 变化也算事件 —— 那是心跳，用来刷新会话存活时间。 */
  function diff(
    prev: Map<string, Entry> | null,
    next: { entries: Map<string, Entry>; unusable: Set<string> },
  ): void {
    const send = emit;
    if (!send) return;
    for (const [id, e] of next.entries) {
      const old = prev?.get(id);
      const changed = !old || old.status !== e.status || old.title !== e.title;
      if (changed) {
        send({ sessionId: id, status: e.status, title: e.title, ts: e.ts, origin: e.origin ?? 'file' });
        log(`文件状态：${id} → ${e.status}${e.title ? `（${e.title}）` : ''}`);
      } else if (old.ts !== e.ts && !e.tsFromFile) {
        // 心跳：同一状态被重新写入，只刷新时间戳，不产生状态切换。
        //
        // `tsFromFile` 的条目**刻意排除在外**：它的时间戳来自快照的 mtime，而同一份文件
        // 里的所有会话共享一个 mtime —— 不排除的话，只要**任何一条**会话被写入，
        // 其它无 ts 的陈旧会话都会被续命 15 分钟（ADR 016 实测过这条路径）。
        send({ sessionId: id, status: e.status, title: e.title, ts: e.ts, origin: e.origin ?? 'file' });
      }
    }
    // 从文件里消失的会话 = 写侧主动收尾（比如 --clear）。补一条 idle，
    // 比等 15 分钟静默超时准确得多。
    // 注意排除 unusable：那一条是"写了但读不懂"，属于未知而不是消失。
    if (prev) {
      for (const [id, e] of prev) {
        if (next.entries.has(id) || next.unusable.has(id)) continue;
        send({ sessionId: id, status: 'idle', title: e.title, ts: Date.now(), origin: 'file' });
        log(`文件状态：会话 ${id} 已被移除，按 idle 处理`);
      }
    }
  }

  function schedule(): void {
    if (debounce) clearTimeout(debounce);
    // fs.watch 对一次写入常常连发多个事件（缓冲写入会分多次落盘），去抖一次读盘。
    debounce = setTimeout(readOnce, 50);
  }

  return {
    id: 'status-file',

    start(onEvent) {
      if (started) return;
      started = true;
      emit = onEvent;
      readOnce();                       // 先读一次，进程重启后立刻反映既有状态
      try {
        // 监听**目录**而不是文件本身：写侧用临时文件 + rename 原子替换，
        // 监听文件句柄会在第一次替换后就失效（这是文件监听最经典的坑）。
        watcher = watch(dirname(path), { persistent: false }, schedule);
        watcher.on('error', (e) => log(`目录监听出错（轮询兜底仍然有效）：${String(e)}`));
      } catch (e) {
        log(`无法监听状态文件所在目录（轮询兜底仍然有效）：${String(e)}`);
      }
      // 轮询兜底：Windows 上 fs.watch 会漏事件，只靠它会出现"状态偶尔不动"。
      pollTimer = setInterval(readOnce, pollMs);
    },

    stop() {
      started = false;
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (watcher) { watcher.close(); watcher = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      emit = null;
    },

    /**
     * 忘掉"上一次读到的快照"这份记忆（`StatusSource.reset`，可选）。
     *
     * 谁需要它：主进程的「清空状态会话」会**先把文件写空**，如果适配器手里还留着旧快照，
     * 下一次读盘就会把每条会话 diff 成"已移除"、各补一条 idle 收尾 —— 刚清掉的会话
     * 又以前缀 idle 的形式回到仲裁器里（面板重新列出两行、菜单计数回到 2），
     * 也就是 2026-09-17 实测到的"清了宠物没清视图"（ADR 016）。
     * 清掉记忆后，空文件对适配器就是"本来就没有会话"，不会再补事件；
     * 随后立刻重读一次，把记忆建立在新内容（空快照）上。
     */
    reset() {
      last = null;
      if (started) readOnce();
    },

    describe() {
      return `状态文件 ${path}（监听目录 + ${pollMs}ms 轮询兜底）`;
    },
  };
}
