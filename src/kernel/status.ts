// 状态层：业务状态事件 → 仲裁 → 动画意图。纯 TS、无副作用、时钟可注入。
//
// 为什么需要仲裁器（而不是把状态直接接到动画上）：
//   - 状态闪烁：running / needs-input 高频抖动会让动作抽帧；
//   - 重要状态被淹没：needs-input 只闪 0.2 秒就被下一条 running 盖掉；
//   - 多会话争抢：三条会话同时活动，宠物来回横跳。
// 三条策略分别对应：变化限流、粘滞、多会话聚合。
//
// 本模块是"全应用唯一的真值来源"：托盘提示、气泡文案、角标数量与动画选择都从这里取，
// 不允许下游各算一份。时钟通过 options.now 注入，因此可以接虚拟时钟做确定性单测。
import type { RuntimeManifest } from './types';

export const PET_STATUSES = ['idle', 'running', 'needs-input', 'blocked', 'ready'] as const;
export type PetStatus = (typeof PET_STATUSES)[number];

export function isPetStatus(v: unknown): v is PetStatus {
  return typeof v === 'string' && (PET_STATUSES as readonly string[]).includes(v);
}

/**
 * 状态源产出的事件：**只增不改**的单向事件流。
 * 事件是"某会话此刻处于某状态"的声明；适配器负责把各种形态的来源（快照文件、HTTP 推送、
 * agent hook）统一归一化成它，仲裁器因此不必知道外部世界长什么样。
 */
export interface StatusEvent {
  /** 多会话聚合的分组键。单会话场景用 'default'。 */
  sessionId: string;
  status: PetStatus;
  /** 会话标题，用于气泡与日志。 */
  title?: string;
  /** 事件时刻（epoch ms）。缺失时由接收方补当前时间。 */
  ts?: number;
  /** 来源标识，仅用于诊断（'file' / 'cli' / 'http'）。 */
  origin?: string;
}

/** desktop-pet.json → statusMap，业务状态到动画状态的映射表。 */
export type StatusMap = NonNullable<RuntimeManifest['statusMap']>;
export type StatusMapEntry = NonNullable<StatusMap[string]>;

/** 仲裁结果里"该演什么"的部分。 */
export interface AnimationIntent {
  /** 立即要播的状态。 */
  state: string;
  /**
   * 一次性动作播完之后的落点。`ready` 映射为 `waving`（致意）→ `then: review`（未读），
   * 若不指定则走播放器自身的 fallbackState。
   */
  then?: string;
}

/** 推给渲染层、同时也是全应用唯一真值的仲裁输出。 */
export interface ArbiterState {
  /** 仲裁后的主状态（业务态，不是动画态）。 */
  status: PetStatus;
  /** 主状态所属会话；无活动会话时为 null。 */
  sessionId: string | null;
  title?: string;
  animation: AnimationIntent;
  /** 提示文案，来自 statusMap；M2 本轮只算不画（气泡要占窗口外区域，见 ADR 010）。 */
  bubble: string | null;
  /** 除主状态之外仍在活动的会话数（多会话角标）。 */
  badgeCount: number;
  attentionPulse: boolean;
  /** 每次输出变化递增，渲染层可据此识别"这条是新状态还是重载后的补推"。 */
  rev: number;
}

/**
 * 单条会话的**只读**视图，供控制条的仪表盘使用（M2 ④）。
 *
 * 为什么 `status` 与 `acknowledged` 分开暴露、而不是在内核里就把已确认的 needs-input
 * 降级成 idle：降级是**仲裁**内部的事（`effectiveStatus`），界面需要如实显示
 * "这条会话在等，但你已经确认过了"。内核替 UI 决定显示成 idle 会让界面说谎，
 * 也会让"ack 不改原始状态"这条单测失去着力点。
 */
export interface SessionView {
  sessionId: string;
  /** **原始**状态（不套 acknowledged / ready 超时的降级）。 */
  status: PetStatus;
  /** 已被用户确认（needs-input 的粘滞已解除）。 */
  acknowledged: boolean;
  /**
   * 该会话的 `ready` 通报时效已过（超过 `readyTimeoutMs`），它已不参与仲裁。
   *
   * 与 `acknowledged` 同一个套路：**原始 `status` 不改**，另给一个标记让界面决定怎么显示。
   * 面板若显示"就绪（未读）"而宠物其实已经回 idle，用户会以为面板坏了。
   */
  expired: boolean;
  title?: string;
  /** 最近一次事件时刻（epoch ms）。 */
  ts: number;
  /** 是否当前主状态（对应 `state.sessionId`）。 */
  primary: boolean;
}

export interface ArbiterOptions {
  statusMap?: StatusMap;
  /** statusMap 里查不到时的兜底动画状态。 */
  defaultState?: string;
  /** 任何状态被激活后至少展示多久才能被切换（默认 400ms）。 */
  minDisplayMs?: number;
  /** 两次状态切换之间的最小间隔（默认 500ms）。 */
  throttleMs?: number;
  /** needs-input 粘滞的上限，超过则自动解除（默认 5min）。 */
  stickyTimeoutMs?: number;
  /**
   * **`ready`（结果未读）的驻留上限，超过则按 idle 处理（默认 60s）。**
   *
   * 为什么 `ready` 也必须有一条到点退场的规则 —— 它与 `needs-input` 的形状**不同**：
   *   - `needs-input` 是"它挡着路，非你不可"，所以有粘滞 + `stickyTimeoutMs` 安全阀；
   *   - `ready` 是"干完了，结果给你看"，是一个**通报**而不是**求助**。通报没有出口的话，
   *     一次 `Stop` 事件就能让宠物把那格姿态举到 15 分钟静默兜底为止 ——
   *     用户视角就是"我什么都没让它干，它却一直摆着那副'有东西给你'的样子"
   *     （2026-09-18 报告的"没有 agent 在跑，它还在炒菜"）。
   *
   * 取 60 秒：足够用户切回窗口时看见"它刚才干完了"（气泡 6 秒是**逐字阅读**用的，
   * 姿态是**余温**，可以长得多），又不会久到变成噪音。
   * 注意这条**不是**"结果被读掉了"—— 我们没有读回执；它只是"通报的时效到期"。
   */
  readyTimeoutMs?: number;
  /**
   * 会话静默多久视为失效（默认 15min）。
   * 这是"agent 崩溃后宠物永远停在 running"的唯一兜底：hook 正常会在结束时写 idle，
   * 但崩溃/拔电时不会，所以需要一条与业务无关的到期规则。
   * 取值必须大于一次合法任务中最长的"无 hook 空档"（例如一次长思考期间没有任何工具调用），
   * 否则会在任务进行中把宠物误判为结束。
   */
  sessionStaleMs?: number;
  /** 注入时钟，便于单测（默认 Date.now）。 */
  now?: () => number;
  /** 诊断输出，默认静默。 */
  log?: (message: string) => void;
}

interface SessionRecord {
  sessionId: string;
  status: PetStatus;
  title?: string;
  ts: number;
}

interface Output {
  status: PetStatus;
  sessionId: string | null;
  title?: string;
}

const DEFAULTS = {
  minDisplayMs: 400,
  throttleMs: 500,
  stickyTimeoutMs: 300_000,
  readyTimeoutMs: 60_000,
  sessionStaleMs: 900_000,
  defaultState: 'idle',
};

/**
 * 把业务状态解析成动画意图。缺映射时回落到 defaultState 并只告警一次 ——
 * 自定义宠物包漏写 statusMap 不应该让运行时抛异常。
 */
export function resolveAnimation(
  statusMap: StatusMap | undefined,
  status: PetStatus,
  defaultState = DEFAULTS.defaultState,
): AnimationIntent {
  const entry: StatusMapEntry | undefined = statusMap?.[status];
  if (!entry?.state) return { state: defaultState };
  return entry.then ? { state: entry.state, then: entry.then } : { state: entry.state };
}

function priorityOf(statusMap: StatusMap | undefined, status: PetStatus): number {
  // 数字越小优先级越高；缺失视为最低。
  return statusMap?.[status]?.priority ?? 99;
}

export class StatusArbiter {
  private readonly opts: Required<Omit<ArbiterOptions, 'statusMap' | 'log'>> & {
    statusMap?: StatusMap;
    log?: (m: string) => void;
  };
  private readonly sessions = new Map<string, SessionRecord>();
  /**
   * 已"确认不再要求注意"的会话。两个来源，语义完全相同，因此共用一个集合：
   *   1. 用户确认（单击宠物 / 打开会话）；
   *   2. 粘滞超时自动确认 —— 安全阀：用户始终没理，不能让宠物无限举着手。
   * 效果是把该会话的 needs-input 降级为 idle（但**只降级这一种状态**：
   * 它之后若报 running/blocked，仍要正常参与仲裁，否则用户一确认宠物就"失明"了）。
   */
  private readonly acknowledged = new Set<string>();
  /**
   * `ready` 通报的计时起点（会话 id → 进入 ready 的时刻）。
   *
   * 为什么单独记一份而不复用 `SessionRecord.ts`：`ts` 是**事件时刻**，每次心跳都会刷新
   * （`ingest` 无条件写入），而它同时又是"心跳保活"的判据 —— 两者是同一枚硬币的两面。
   * 拿它算 ready 的驻留时长，会让"上游每分钟重报一次 ready"变成永久驻留，
   * 也就是这条机制**在自己要防的那个场景下恰好失效**（与本文件里其它"兜底值取错东西"
   * 的教训同源）。这里只在**状态真正变成 ready 的那一次**记时，重复推送不动它。
   */
  private readonly readySince = new Map<string, number>();
  private out: Output = { status: 'idle', sessionId: null };
  /** 被限流挡下的目标状态，等窗格过后由 tick 应用（不丢弃）。 */
  private pending: Output | null = null;
  private sticky: { sessionId: string; since: number } | null = null;
  /** 上次真正切换输出的时刻；初值 -Infinity 保证首个状态立刻生效。 */
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private rev = 0;
  private warnedMissing = new Set<PetStatus>();

  constructor(options: ArbiterOptions = {}) {
    this.opts = {
      defaultState: options.defaultState ?? DEFAULTS.defaultState,
      minDisplayMs: options.minDisplayMs ?? DEFAULTS.minDisplayMs,
      throttleMs: options.throttleMs ?? DEFAULTS.throttleMs,
      stickyTimeoutMs: options.stickyTimeoutMs ?? DEFAULTS.stickyTimeoutMs,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
      sessionStaleMs: options.sessionStaleMs ?? DEFAULTS.sessionStaleMs,
      now: options.now ?? (() => Date.now()),
      statusMap: options.statusMap,
      log: options.log,
    };
  }

  /** 摄入一条状态事件。返回仲裁输出是否因此发生变化（变化才需要推送渲染层）。 */
  ingest(e: StatusEvent): boolean {
    const now = this.opts.now();
    const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : now;
    const prev = this.sessions.get(e.sessionId);
    // 会话重新提出新问题（非 needs-input → needs-input）时清掉旧的确认记录，
    // 否则第二次求助会被静默地当成"已读"。
    if (e.status === 'needs-input' && prev?.status !== 'needs-input') {
      this.acknowledged.delete(e.sessionId);
    }
    // `ready` 的驻留计时**只在状态真正变成 ready 的那一次**起算（见 readySince 的注释）。
    // 从 ready 走到别的状态就清掉；重复报 ready 不动它 —— 否则超时会被心跳无限推后。
    if (e.status === 'ready') {
      if (prev?.status !== 'ready') this.readySince.set(e.sessionId, now);
    } else {
      this.readySince.delete(e.sessionId);
    }
    this.sessions.set(e.sessionId, {
      sessionId: e.sessionId,
      status: e.status,
      title: e.title ?? prev?.title,
      ts,
    });
    return this.recompute(now);
  }

  /** 时间推进：处理粘滞超时、会话静默过期、限流窗格到期。返回输出是否发生变化。 */
  tick(now = this.opts.now()): boolean {
    return this.recompute(now);
  }

  /**
   * 用户确认（打开会话 / 单击宠物 / 面板的就地「确认」）。
   *
   * 两种"要求注意"的信号都在这里被消解，因为它们对用户是**同一个动作**：
   *   1. needs-input 的粘滞 —— 不再举着手；
   *   2. ready 的通报 —— 不再摆着"有东西给你看"的姿态。
   * 第二条是 2026-09-18 补的（ADR 021）：单击宠物一直是 ack 的调用点，
   * 而"点它一下"在两种状态下都是"我看到了"的意思。少了这条，用户点完之后
   * 宠物还要靠 60 秒超时才肯放下那副姿态，观感就是"点了没用"。
   *
   * 返回输出是否变化。不传 sessionId 表示确认所有待处理的会话（单击宠物即此语义）。
   */
  ack(sessionId?: string): boolean {
    const now = this.opts.now();
    const want = (s: SessionRecord): boolean => s.status === 'needs-input' || s.status === 'ready';
    const targets = sessionId
      ? [sessionId].filter((id) => {
        const rec = this.sessions.get(id);
        return rec !== undefined && want(rec);
      })
      : [...this.sessions.values()].filter(want).map((s) => s.sessionId);
    for (const id of targets) {
      this.acknowledged.add(id);
      // ready 用"把计时推到已超时"来实现消解，而不是删掉计时 ——
      // 删掉会让 `effectiveStatus` 退回 `rec.ts` 判定，而 `ts` 可能刚被心跳刷新过，
      // 于是"确认"在下一秒被撤销（症状：点完宠物，姿态过一会儿又回来了）。
      // 推到 now 则确定性地立即失效，且不需要给 ready 单开一份"已读"集合。
      const rec = this.sessions.get(id);
      if (rec?.status === 'ready') this.readySince.set(id, now - this.opts.readyTimeoutMs);
    }
    if (this.sticky && (!sessionId || this.sticky.sessionId === sessionId)) this.sticky = null;
    // 单击会频繁触发 ack，没有待处理会话时不要刷日志（否则真正的状态变化会被淹没）。
    if (targets.length > 0) {
      this.log(`用户确认：${targets.join('、')}`);
      // **用户的确认是低频且明确的动作，不该被状态变化限流挡住。**
      // 限流（minDisplay/throttle）是给 agent 的状态抖动用的；不重置窗格的话，
      // 点完「确认」面板与宠物最多要等 500ms 才反应 —— 用户报告的观感就是"点了没反应"。
      // 只在真有目标时重置：`ack()` 也是"单击宠物"的实现，每次都重置会把限流彻底废掉。
      this.lastChangeAt = Number.NEGATIVE_INFINITY;
    }
    return this.recompute(now);
  }

  /**
   * 清空**全部**会话记录（菜单「清空状态会话」，2026-09-17 补）。
   *
   * 为什么必须有它：状态文件是快照，"把文件写空"只解决了**来源**，仲裁器手里那份记录
   * 不会因此消失 —— 适配器把"从快照里消失"翻译成"补一条 idle 收尾"，记录仍然留着，
   * 于是 `viewSessions()` 依旧列出两行 idle、菜单依旧写「清空状态会话（2 条）」，
   * 要等 15 分钟静默兜底才轮到它。用户视角就是"没清干净"（实测证据见 ADR 016）。
   *
   * 顺手清掉三样与会话绑定的东西：确认位（记录都没了，留着一个 id 只会在它下次出现时
   * 被错误地当成"已读"）、被限流挡下的目标状态、以及粘滞指针。
   * 与 `ack()` 同理，这是用户明确的破坏性动作，不该被状态限流挡 500ms。
   *
   * @returns 仲裁输出是否因此变化（变化才需要推送渲染层）。
   */
  clearSessions(): boolean {
    const now = this.opts.now();
    this.sessions.clear();
    this.acknowledged.clear();
    this.readySince.clear();
    this.pending = null;
    this.sticky = null;
    this.lastChangeAt = Number.NEGATIVE_INFINITY;
    return this.recompute(now);
  }

  get state(): ArbiterState {
    const statusMap = this.opts.statusMap;
    const entry = statusMap?.[this.out.status];
    if (statusMap && !entry) this.warnMissing(this.out.status);
    const animation = resolveAnimation(statusMap, this.out.status, this.opts.defaultState);
    const primary = this.out.sessionId;
    // 角标 = 除主状态之外、仍在要求注意的会话数（已确认的 needs-input 不算）。
    const now = this.opts.now();
    const others = [...this.sessions.values()].filter(
      (s) => s.sessionId !== primary && this.effectiveStatus(s, now) !== 'idle',
    );
    return {
      status: this.out.status,
      sessionId: this.out.sessionId,
      title: this.out.title,
      animation,
      bubble: entry?.bubble ?? null,
      // 角标只统计"其余活动会话"；主状态自己不计数，否则会恒 ≥1。
      badgeCount: others.length,
      attentionPulse: Boolean(entry?.attentionPulse),
      rev: this.rev,
    };
  }

  /** 诊断快照（日志/未来托盘提示用）。 */
  snapshot(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.ts - a.ts);
  }

  /**
   * 控制条仪表盘用的会话视图：主状态排第一，其余按最近活动倒序。
   *
   * 过期过滤在这里再做一遍（不删记录、无副作用）：`pruneStale` 只在 `recompute` 路径上跑，
   * 而视图可能在任何时刻被读 —— 让一个已经死掉的会话出现在面板上，比多一次判断更糟。
   */
  viewSessions(): SessionView[] {
    const now = this.opts.now();
    const primary = this.out.sessionId;
    return [...this.sessions.values()]
      .filter((r) => now - r.ts <= this.opts.sessionStaleMs)
      .sort((a, b) => {
        if (a.sessionId === primary) return -1;
        if (b.sessionId === primary) return 1;
        return b.ts - a.ts;
      })
      .map((r) => ({
        sessionId: r.sessionId,
        status: r.status,
        acknowledged: this.acknowledged.has(r.sessionId),
        // "已过期"= 它不再参与仲裁（`effectiveStatus` 把它看成 idle），但原始 status 仍如实保留。
        expired: r.status === 'ready' && this.effectiveStatus(r, now) !== 'ready',
        title: r.title,
        ts: r.ts,
        primary: r.sessionId === primary,
      }));
  }

  // —— 内部 ——

  private warnMissing(status: PetStatus): void {
    if (this.warnedMissing.has(status)) return;
    this.warnedMissing.add(status);
    this.log(`statusMap 缺少 "${status}" 的映射，动画回落为 "${this.opts.defaultState}"`);
  }

  private log(message: string): void {
    this.opts.log?.('[status] ' + message);
  }

  /** 重算并（在允许时）提交输出。返回输出是否变化。 */
  private recompute(now: number): boolean {
    this.pruneStale(now);
    const desired = this.desired(now);
    const target: Output = desired ?? { status: 'idle', sessionId: null };

    if (this.sameAs(this.out, target)) {
      this.pending = null;
      return false;
    }
    // 最短展示与变化限流在这里合并成一个窗格：两者都是"距上次切换多久"，
    // 因此窗口取 max。默认 400 / 500 时由限流主导；把 minDisplayMs 调大于
    // throttleMs 才会体现出独立作用。不假装它们是两套独立机制。
    const waitMs = Math.max(this.opts.minDisplayMs, this.opts.throttleMs);
    if (now - this.lastChangeAt < waitMs) {
      if (!this.pending || !this.sameAs(this.pending, target)) {
        this.pending = target;
        this.log(`状态切换被限流（等待 ${waitMs}ms 窗格）：${this.out.status} → ${target.status}`);
      }
      return false;
    }
    this.pending = null;
    this.commit(target, now);
    return true;
  }

  /** 提交输出并递增版本。 */
  private commit(target: Output, now: number): void {
    const from = this.out.status;
    this.out = target;
    this.lastChangeAt = now;
    this.rev += 1;
    const who = target.sessionId ? ` @${target.sessionId}` : '';
    this.log(`状态 ${from} → ${target.status}${who}（rev=${this.rev}）`);
  }

  /** 清掉静默过久的会话，并解除指向它们的粘滞。 */
  private pruneStale(now: number): void {
    for (const [id, rec] of this.sessions) {
      if (now - rec.ts <= this.opts.sessionStaleMs) continue;
      const minutes = Math.round(this.opts.sessionStaleMs / 60_000);
      this.sessions.delete(id);
      this.acknowledged.delete(id);
      this.readySince.delete(id);
      this.log(`会话 ${id} 静默超过 ${minutes} 分钟，按 idle 处理（疑似 agent 崩溃或未收尾）`);
    }
  }

  /**
   * 期望的输出状态：先取优先级最高的会话，再套粘滞。
   *
   * 粘滞的解除条件（逐条列清，避免"宠物一直举着手"这类无法解释的症状）：
   *   1. 用户确认（ack）；或
   *   2. **超时自动确认** —— 到点后把该会话记为已确认，宠物不再举着手；或
   *   3. 会话已静默过期；或
   *   4. 该会话自己改口说 idle —— 它不再要输入了，继续举着手就是在撒谎。
   *
   * 第 2 条必须是"自动确认"而不只是"解除粘滞"：会话仍然停在 needs-input 上，
   * 单解除粘滞的话下一次仲裁会立刻把它重新选为主状态、重新建立粘滞 ——
   * 表现为超时形同虚设（每 5 分钟重置一次计时器）。这一点由单测钉住。
   * 第 4 条是对文档措辞的补充：文档说"不被 running 覆盖"（完整实现），
   * 额外允许 idle 解除，是为了避免"用户已在终端里回答完"时宠物还举着手。
   */
  private desired(now: number): Output | null {
    if (this.sticky) {
      const sid = this.sticky.sessionId;
      const rec = this.sessions.get(sid);
      const timedOut = now - this.sticky.since >= this.opts.stickyTimeoutMs;
      const released =
        !rec ||
        rec.status === 'idle' ||
        this.acknowledged.has(sid) ||
        timedOut;
      if (released) {
        const reason = !rec ? '会话已过期'
          : rec.status === 'idle' ? '会话转为 idle'
          : this.acknowledged.has(sid) ? '用户已确认'
          : `超时（${Math.round(this.opts.stickyTimeoutMs / 1000)}s）自动确认`;
        if (timedOut && rec?.status === 'needs-input') this.acknowledged.add(sid);
        this.log(`粘滞解除（会话 ${sid}，原因：${reason}）`);
        this.sticky = null;
      } else {
        return { status: 'needs-input', sessionId: sid, title: rec.title };
      }
    }

    const primary = this.pickPrimary();
    if (!primary || primary.status === 'idle') return null;   // 没有会话在要求注意
    if (primary.status === 'needs-input' && !this.sticky && primary.sessionId) {
      this.sticky = { sessionId: primary.sessionId, since: now };
      this.log(`进入粘滞：会话 ${primary.sessionId} 需要输入，驻留至用户确认或 ${Math.round(this.opts.stickyTimeoutMs / 1000)}s 超时`);
    }
    return { status: primary.status, sessionId: primary.sessionId, title: primary.title };
  }

  /**
   * 选主：优先级数字最小者胜；同分时非 idle 胜；再同分取事件最新者。
   * 最后一条是为了让"多条会话同为 running"时宠物跟随最近有动静的那条。
   * 已确认的会话在这里被按 idle 参与排序（只影响它的 needs-input）。
   */
  private pickPrimary(): Output | null {
    const now = this.opts.now();
    let best: Output | null = null;
    let bestPriority = Number.POSITIVE_INFINITY;
    let bestIdle = 1;
    let bestTs = Number.NEGATIVE_INFINITY;
    for (const rec of this.sessions.values()) {
      const status = this.effectiveStatus(rec, now);
      const priority = priorityOf(this.opts.statusMap, status);
      const idle = status === 'idle' ? 1 : 0;
      const better =
        priority < bestPriority ||
        (priority === bestPriority && idle < bestIdle) ||
        (priority === bestPriority && idle === bestIdle && rec.ts > bestTs);
      if (!better) continue;
      best = { status, sessionId: rec.sessionId, title: rec.title };
      bestPriority = priority;
      bestIdle = idle;
      bestTs = rec.ts;
    }
    return best;
  }

  /**
   * 参与仲裁时用的**有效**状态。两条降级，都是"某状态不该无限期占着画面"的落地：
   *   1. 已确认的 needs-input → idle（用户已经知道了，别再举着手）；
   *   2. 超时的 ready → idle（通报的时效过了，别一直摆着"有东西给你"的姿态）。
   * 除这两种之外一律原样返回 —— 降级范围必须窄，否则用户一确认/一超时宠物就"失明"。
   */
  private effectiveStatus(rec: SessionRecord, now: number): PetStatus {
    if (rec.status === 'needs-input' && this.acknowledged.has(rec.sessionId)) return 'idle';
    if (rec.status === 'ready') {
      const since = this.readySince.get(rec.sessionId);
      // 没有计时起点（例如进程重启后从快照读回的 ready）**不能**当成"刚到"：
      // 那等于给一条陈旧快照再续 60 秒，与本文件 ⑧b 那条"不知道 ≠ 刚刚"同源。
      // 起点缺失时用事件时刻（`ts`，读取侧已按 mtime 兜底）来判定，仍不新鲜就按 idle。
      const start = since ?? rec.ts;
      if (now - start >= this.opts.readyTimeoutMs) return 'idle';
    }
    return rec.status;
  }

  private sameAs(a: Output, b: Output): boolean {
    return a.status === b.status && a.sessionId === b.sessionId;
  }
}
