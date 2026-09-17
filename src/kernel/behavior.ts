// 行为层：**只回答"宠物现在该演什么、该往哪走"**。纯函数、时钟与随机数都可注入，不碰窗口、不碰 IPC。
//
// 为什么必须做成纯函数（与 `bubble-policy.ts` / `bar-policy.ts` 同一套路）：
// 这条策略的规则全是"到点才发生"的 —— 25 秒还是 28 秒后开始走、走到边界是停还是掉头、
// 拖动结束后要不要接着走，这些在屏幕上**完全看不出对错**（早 3 秒晚 3 秒都只是"它在走"）。
// 只有把它抽出来、接虚拟时钟与固定随机种子，才钉得住；真实窗口那部分留给探针（`spikes/m3-behavior`）。
//
// 边界（本轮的取舍，理由见 ADR 018）：
//   - **只在仲裁器主状态 = `idle` 时活动**：有任务在跑（running / needs-input / blocked / ready）时
//     宠物原地演状态动画，不漫游 —— 正在干活时它跑掉反而像"擅离职守"；
//   - 只沿地平线**左右**走（y 不动）：这只包的第 1、2 行是横向位移姿态，没有上下位移语义；
//   - 只在**当前窗口所在显示器的工作区**内活动，目标点会被夹进去；跨屏漫游留到后续；
//   - 拖动中 / 宠物被隐藏 / 控制条打开 / 「减少动态效果」下都不动（前两者由调用方合成 suppressed）。
import type { PetStatus } from './status';

export interface Rect { x: number; y: number; width: number; height: number }

/** 宠物面向哪边 —— 决定播 `running-left` 还是 `running-right`。 */
export type Facing = 'left' | 'right';

export type BehaviorPhase = 'idle' | 'roaming' | 'acting' | 'sleeping';

export interface RangeMs { min: number; max: number }

/**
 * 行为层的一句话请求。调用方（主进程）照着做，不做二次判断 ——
 * 判断全在这里，这样规则才只有一处、才测得动。
 *
 * `play` 是**边沿触发**的（缺省 = 这一 tick 不改动画）：
 *   - 缺省：动画覆盖不变（例如漫游途中的每一 tick）；
 *   - `null`：**交回仲裁器**（渲染层按业务状态演）；
 *   - 对象：按它演（`loop:false` 是一次性动作）。
 * 三态而不是两态，是因为"没有新指令"与"撤销覆盖"在窗口上的效果完全不同 ——
 * 混成一个 `null` 会让渲染层每 tick 都被重置一次（走路会被每秒压回去 30 次）。
 */
export interface BehaviorCommand {
  play?: { state: string; loop: boolean } | null;
  /** 窗口左上角该去的 x（绝对值，DIP）；null = 这一 tick 不动。 */
  moveX: number | null;
}

export interface BehaviorPolicy {
  enabled: boolean;
  roamEnabled: boolean;
  roamEveryMs: RangeMs;
  roamDistancePx: RangeMs;
  /** 默认缩放下的位移速度（屏幕像素/秒），实际速度按 `scale / defaultScale` 线性换算。 */
  speedPxPerSec: number;
  defaultScale: number;
  microEnabled: boolean;
  /** 微动作候选（已过滤掉宠物包里不存在的状态）。 */
  microCandidates: string[];
  microEveryMs: RangeMs;
  /** 各状态播一遍的时长（毫秒）：`frames / fps × 1000`。一次性微动作靠它算结束时刻。 */
  clipMs: Record<string, number>;
  sleepAfterMs: number;
  sleepState: string;
  /** 位移姿态。null = 这个包没有位移行 ⇒ **不漫游**（而不是硬编码 running-left/right）。 */
  locomotion: { left: string; right: string } | null;
}

export interface BehaviorState {
  phase: BehaviorPhase;
  /** 下一次漫游的到点时刻；null = 还没排程（首次 tick 会排）。 */
  nextRoamAt: number | null;
  /** 下一次微动作的到点时刻；null = 还没排程。 */
  nextActionAt: number | null;
  /** 漫游目标 x（窗口左上角，绝对 DIP）；null = 没在漫游。 */
  targetX: number | null;
  facing: Facing;
  /** 进入 idle 相的时刻；null = 当前不在 idle 相（用于打盹计时）。 */
  idleSinceAt: number | null;
  /** 正在播的微动作结束时刻；null = 没在播。 */
  actUntil: number | null;
  /** 上一 tick 的时刻：位移要按真实 dt 积分，不能假设固定步长。 */
  lastStepAt: number;
  /** 打盹姿态是否已经下发过（避免每 tick 重复下发同一条命令）。 */
  sleepPlaying: boolean;
  /** 最近一次下发的动画覆盖，用于去抖（只在变化时下发）。 */
  sentPlay: { state: string; loop: boolean } | null;
}

export interface BehaviorInput {
  now: number;
  /** 窗口内容区当前矩形（DIP）。 */
  pet: Rect;
  /** 宠物所在显示器的工作区（DIP）。 */
  workArea: Rect;
  /** 当前缩放，用于位移速度归一化。 */
  scale: number;
  /** 仲裁器主状态。行为层只在 `idle` 时活动。 */
  status: PetStatus;
  /** 拖动中 / 宠物被隐藏 / 全屏让位 / 控制条打开 —— 任一成立就不动。 */
  suppressed: boolean;
  /** 系统「减少动态效果」：不做位移与微动作（打盹这种静态姿态仍然允许）。 */
  reducedMotion: boolean;
}

/** 单次位移积分的 dt 上限：机器休眠/卡顿后不该让宠物"瞬移"一段。 */
const MAX_STEP_MS = 120;
/** 目标点离当前位置近于这个距离就当作"够不到"，换方向或放弃这次漫游。 */
const MIN_ROAM_PX = 6;
/** 到达判定：距目标不足这个距离就直接贴上去。 */
const ARRIVE_EPS_PX = 0.6;

export const BEHAVIOR_IDLE: BehaviorState = {
  phase: 'idle',
  nextRoamAt: null,
  nextActionAt: null,
  targetX: null,
  facing: 'right',
  idleSinceAt: null,
  actUntil: null,
  lastStepAt: 0,
  sleepPlaying: false,
  sentPlay: null,
};

const num = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def;

/**
 * 解析 sidecar 里的 `[minSec, maxSec]` **秒**区间，换成**毫秒**。
 *
 * 单位在字段名里说清楚（`...Ms` 就必须是毫秒）—— 第一版这里留着秒、到用的时候再 `× 1000`，
 * 结果单测里按名字写 `{min:100,max:100}` 期望"100 毫秒后动"，实际变成 100 秒，测试红了才发现。
 * 那种"名字与单位不一致"的坑不值得留给下一个人。
 */
const rangeMs = (v: unknown, def: RangeMs): RangeMs => {
  const arr = Array.isArray(v) ? v : null;
  if (!arr || arr.length < 2) return def;
  const a = num(arr[0], NaN), b = num(arr[1], NaN);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return def;
  return { min: Math.min(a, b) * 1000, max: Math.max(a, b) * 1000 };
};

/**
 * 从 sidecar 的 `behavior` 段 + 宠物包的状态表解析策略。
 *
 * 两点是**刻意不硬编码**的（换成别的宠物包也得能跑）：
 *   - 位移姿态按 `role` 找（`locomotion-left` / `locomotion-right`），找不到就不漫游；
 *   - 微动作候选过滤掉包里不存在的状态（写错名字不会让宠物卡住）。
 */
export function parseBehaviorPolicy(
  raw: unknown,
  pack: { states: Record<string, { frames: number; fps: number; role?: string }>; scale: number },
  warn: (message: string) => void = () => {},
): BehaviorPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const roam = (o['idleRoam'] ?? {}) as Record<string, unknown>;
  const micro = (o['idleMicroActions'] ?? {}) as Record<string, unknown>;

  let left: string | null = null;
  let right: string | null = null;
  const clipMs: Record<string, number> = {};
  for (const [id, s] of Object.entries(pack.states)) {
    if (s.fps > 0) clipMs[id] = Math.round((s.frames / s.fps) * 1000);
    if (s.role === 'locomotion-left') left = id;
    if (s.role === 'locomotion-right') right = id;
  }
  if (!left || !right) {
    warn('宠物包没有声明 locomotion-left/right 位移姿态 ⇒ 本次不漫游（其余行为照常）');
  }

  const candidates = (Array.isArray(micro['candidates']) ? micro['candidates'] : [])
    .filter((c): c is string => typeof c === 'string')
    .filter((c) => {
      if (clipMs[c] !== undefined) return true;
      warn(`微动作候选 "${c}" 不在宠物包里，已忽略`);
      return false;
    });

  const sleepState = typeof o['sleepState'] === 'string' ? o['sleepState'] : 'idle';
  if (clipMs[sleepState] === undefined) warn(`sleepState "${sleepState}" 不在宠物包里，打盹会静默跳过`);

  return {
    enabled: o['enabled'] !== false,
    roamEnabled: roam['enabled'] !== false,
    roamEveryMs: rangeMs(roam['everySec'], { min: 25_000, max: 90_000 }),
    roamDistancePx: (() => {
      const r = (roam['distancePx'] ?? []) as unknown[];
      const a = num(r[0], NaN), b = num(r[1], NaN);
      return Number.isFinite(a) && Number.isFinite(b)
        ? { min: Math.min(a, b), max: Math.max(a, b) }
        : { min: 80, max: 320 };
    })(),
    speedPxPerSec: Math.max(1, num(roam['speedPxPerSec'], 96)),
    defaultScale: pack.scale > 0 ? pack.scale : 1,
    microEnabled: micro['enabled'] !== false,
    microCandidates: candidates,
    microEveryMs: rangeMs(micro['everySec'], { min: 40_000, max: 150_000 }),
    clipMs,
    sleepAfterMs: Math.max(0, num(o['sleepAfterIdleSec'], 300)) * 1000,
    sleepState,
    locomotion: left && right ? { left, right } : null,
  };
}

const randBetween = (r: RangeMs, rng: () => number): number =>
  r.min + (r.max - r.min) * Math.min(1, Math.max(0, rng()));

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 位移速度：按缩放线性换算，保证大小不同的宠物"每秒走过几个身位"的观感一致。 */
export function roamSpeedPxPerSec(policy: BehaviorPolicy, scale: number): number {
  return policy.speedPxPerSec * (scale / policy.defaultScale);
}

/** 把状态拉回"刚空闲"：清目标、清打盹、重排两项计时。用户交互（单击/拖动）与状态变化都走这里。 */
export function rearmBehavior(
  prev: BehaviorState,
  policy: BehaviorPolicy,
  now: number,
  rng: () => number,
): BehaviorState {
  return {
    ...prev,
    phase: 'idle',
    targetX: null,
    actUntil: null,
    idleSinceAt: now,
    sleepPlaying: false,
    nextRoamAt: now + randBetween(policy.roamEveryMs, rng),
    nextActionAt: now + randBetween(policy.microEveryMs, rng),
  };
}

/**
 * 用户与宠物交互了（单击 / 拖动）→ 醒来。
 * 打盹是"没人理它"的表现，被摸一下当然要醒，并重新开始计时。
 */
export function wakeBehavior(
  prev: BehaviorState,
  policy: BehaviorPolicy,
  now: number,
  rng: () => number,
): BehaviorState {
  return rearmBehavior(prev, policy, now, rng);
}

/**
 * 推进一 tick，返回新状态与这一 tick 的请求。
 *
 * 规则逐条（顺序即优先级）：
 *  0. 未启用 / 有任务在跑 → 一切归零，交回仲裁器（`play: null`）；
 *  1. `suppressed`（拖动/隐藏/全屏/控制条开着）→ 不动、不切换，但**保留排程**（松开接着走）；
 *  2. 空闲超过 `sleepAfterMs` → 播 `sleepState`（打盹，静态姿态，`reducedMotion` 下也允许）；
 *  3. 微动作到点 → 播一个候选（一次性），`clipMs` 之后回到第 0 相；
 *  4. 漫游到点 → 挑目标、按朝向播位移姿态、按 `speed × dt` 逐 tick 推进，到了就停下重排程。
 */
export function tickBehavior(
  prev: BehaviorState,
  input: BehaviorInput,
  policy: BehaviorPolicy,
  rng: () => number = Math.random,
): { state: BehaviorState; command: BehaviorCommand } {
  const { now } = input;
  const dt = prev.lastStepAt === 0 ? 0 : clamp(now - prev.lastStepAt, 0, MAX_STEP_MS);
  const next: BehaviorState = { ...prev, lastStepAt: now };

  // —— 规则 0：不在"空闲"这个前提里，就没有自主行为（交回仲裁器，只发一次）——
  if (!policy.enabled || input.status !== 'idle') {
    const command: BehaviorCommand = prev.sentPlay === null ? { moveX: null } : { play: null, moveX: null };
    return {
      state: {
        ...next, phase: 'idle', targetX: null, actUntil: null,
        idleSinceAt: null, sleepPlaying: false, sentPlay: null,
      },
      command,
    };
  }

  // 首次进入 idle：排程 + 开始打盹计时（所以启动后不会立刻乱跑）
  if (next.idleSinceAt === null) {
    next.idleSinceAt = now;
    next.nextRoamAt = now + randBetween(policy.roamEveryMs, rng);
    next.nextActionAt = now + randBetween(policy.microEveryMs, rng);
  }

  // —— 规则 1：被抑制（拖动中 / 隐藏 / 全屏 / 控制条开着）——
  // 不动、不改相（排程保留，松开手接着走），但**要交回动画** ——
  // 否则用户一抓住它，它还举着"正在跑"的腿。
  if (input.suppressed) {
    const command: BehaviorCommand = next.sentPlay === null ? { moveX: null } : { play: null, moveX: null };
    return {
      state: { ...next, sleepPlaying: false, sentPlay: null },
      command,
    };
  }

  // —— 规则 2：打盹（优先级高于漫游与微动作：睡着了就别再蹦跶）——
  // 但**不打断正在走的这一程**：走到一半突然趴下比"多走两秒再趴下"更像个 bug。
  // `idleSinceAt` 只在"状态离开 idle"或"用户碰了它"时重置（见规则 0 与 wakeBehavior），
  // 漫游与微动作都不重置它 —— 否则"每 25–90 秒走一次"会把 5 分钟的打盹计时无限推后，
  // 表现为**永远睡不着**（这类 bug 在屏幕上只会表现为"它就是不打盹"，没有任何报错）。
  const idleFor = now - (next.idleSinceAt ?? now);
  const napDue = policy.sleepAfterMs > 0
    && idleFor >= policy.sleepAfterMs
    && policy.clipMs[policy.sleepState] !== undefined;
  if (napDue && next.phase !== 'roaming') {
    const play = { state: policy.sleepState, loop: true };
    const needSend = !next.sleepPlaying || !samePlay(next, play);
    const command: BehaviorCommand = { moveX: null };
    if (needSend) command.play = play;
    return {
      state: { ...next, phase: 'sleeping', targetX: null, actUntil: null, sleepPlaying: true, sentPlay: play },
      command,
    };
  }

  // —— 规则 3：一次性微动作 ——
  if (next.phase === 'acting' && next.actUntil !== null) {
    if (now < next.actUntil) return { state: next, command: { moveX: null } };
    const done: BehaviorState = {
      ...next, phase: 'idle', actUntil: null, sentPlay: null,
    };
    done.nextActionAt = now + randBetween(policy.microEveryMs, rng);
    return { state: done, command: { play: null, moveX: null } };
  }

  if (
    next.phase === 'idle' &&
    policy.microEnabled &&
    !input.reducedMotion &&
    policy.microCandidates.length > 0 &&
    next.nextActionAt !== null &&
    now >= next.nextActionAt
  ) {
    const pick = policy.microCandidates[Math.floor(Math.min(0.999, Math.max(0, rng())) * policy.microCandidates.length)];
    const stateId = pick ?? policy.microCandidates[0];
    if (stateId !== undefined) {
      const play = { state: stateId, loop: false };
      return {
        state: {
          ...next, phase: 'acting', sleepPlaying: false, sentPlay: play,
          actUntil: now + (policy.clipMs[stateId] ?? 500),
        },
        command: { play, moveX: null },
      };
    }
  }

  // —— 规则 4：漫游 ——
  if (next.phase === 'roaming' && next.targetX !== null) {
    const speed = roamSpeedPxPerSec(policy, input.scale);
    const step = (speed * dt) / 1000;
    const remaining = next.targetX - input.pet.x;
    if (Math.abs(remaining) <= Math.max(ARRIVE_EPS_PX, step)) {
      // 到达：贴到目标点、停下、重排程，并把动画交回仲裁器
      const arrived: BehaviorState = {
        ...next, phase: 'idle', targetX: null, sentPlay: null,
      };
      arrived.nextRoamAt = now + randBetween(policy.roamEveryMs, rng);
      return {
        state: arrived,
        command: { play: null, moveX: Math.round(next.targetX) },
      };
    }
    const facing: Facing = remaining > 0 ? 'right' : 'left';
    const want = policy.locomotion
      ? { state: facing === 'right' ? policy.locomotion.right : policy.locomotion.left, loop: true }
      : null;
    const command: BehaviorCommand = {
      moveX: Math.round(input.pet.x + Math.sign(remaining) * step),
    };
    // 只在"要演的位移姿态和上次不同"时才发（同一条命令 30Hz 重发没有意义）
    if (want && !samePlay(next, want)) command.play = want;
    return { state: { ...next, facing, sentPlay: want }, command };
  }

  if (
    next.phase === 'idle' &&
    policy.roamEnabled &&
    !input.reducedMotion &&
    policy.locomotion &&
    next.nextRoamAt !== null &&
    now >= next.nextRoamAt
  ) {
    const target = pickRoamTarget(next, input, policy, rng);
    if (target === null) {
      // 两头都够不到（工作区比宠物宽不了多少，或贴着两边）→ 放弃这次，重新排程
      return {
        state: { ...next, nextRoamAt: now + randBetween(policy.roamEveryMs, rng) },
        command: { moveX: null },
      };
    }
    const facing: Facing = target > input.pet.x ? 'right' : 'left';
    const play = {
      state: facing === 'right' ? policy.locomotion.right : policy.locomotion.left,
      loop: true,
    };
    return {
      state: { ...next, phase: 'roaming', targetX: target, facing, sentPlay: play },
      command: { play, moveX: null },
    };
  }

  // 什么都不用做：若之前覆盖着动画，这一 tick 交回仲裁器（边沿，只发一次）
  if (next.sentPlay !== null) {
    return { state: { ...next, sentPlay: null }, command: { play: null, moveX: null } };
  }
  return { state: next, command: { moveX: null } };
}

function samePlay(s: BehaviorState, p: { state: string; loop: boolean }): boolean {
  return !!s.sentPlay && s.sentPlay.state === p.state && s.sentPlay.loop === p.loop;
}

/**
 * 挑一个漫游目标：在 `distancePx` 区间里取距离，随机取方向；
 * 目标会被夹进工作区，够不到就换另一个方向，都不行返回 null。
 * 夹取就是 `edgePolicy` 里"屏幕边缘停止"的落地方式 —— 宠物不会走出工作区。
 */
function pickRoamTarget(
  prev: BehaviorState,
  input: BehaviorInput,
  policy: BehaviorPolicy,
  rng: () => number,
): number | null {
  const { pet, workArea } = input;
  const lo = workArea.x;
  const hi = workArea.x + workArea.width - pet.width;
  if (hi <= lo) return null;                       // 工作区比宠物还窄（异常配置），不动
  const dist = randBetween(policy.roamDistancePx, rng);
  const first: Facing = rng() < 0.5 ? 'left' : 'right';
  for (const dir of [first, first === 'left' ? 'right' : 'left'] as const) {
    const want = pet.x + (dir === 'right' ? dist : -dist);
    const target = clamp(want, lo, hi);
    if (Math.abs(target - pet.x) >= MIN_ROAM_PX) {
      return Math.round(target);
    }
  }
  return null;
}
