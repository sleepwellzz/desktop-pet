// 手动把玩：用户从控制条的动作排点一个动作，宠物就演一次 —— **与 agent 状态无关**。
//
// 为什么它必须独立于 `behavior.ts`（而不是往里加一条分支）：
// 行为层回答的是"**没人理它的时候**宠物自己在做什么"，它的规则全部由"到点"驱动，
// 且有一条硬约束 —— **控制条打开时它必须静止**（面板锚在宠物身上，宠物动了会一起飘）。
// 手动把玩恰好每一条都相反：由用户的显式动作触发、**必须**在面板打开时生效、
// 且要**盖住**业务状态。把两者塞进同一个状态机，"抑制时就交回仲裁器"与
// "手动把玩要高过仲裁器"会直接自相矛盾 —— 表现是手动动作被每秒冲掉 30 次。
//
// 与 `behavior.ts` 共用的只有两样东西：`BehaviorCommand`（三态 play + moveX）与位移速度
// 的缩放换算（`roamSpeedPxPerSec`，由调用方算好传进来）。速度取同一套的理由见
// `desktop-pet.json → actions.walkNote`：两处取不同值会有一处滑步。
//
// 纯函数、时钟与随机数可注入（与 `behavior.ts` / `bubble-policy.ts` / `bar-policy.ts` 同一套路）：
// 这里的规则同样是"到点才发生"的，肉眼看不出对错（演 5 秒还是 7 秒都只是"它在过生日"）。
import type { BehaviorCommand, Rect } from './behavior';
import type { ResolvedState } from './types';

/** 手动把玩的一项：一个动作 = 宠物包里的一格状态 + 面板上的一行文字。 */
export interface ManualAction {
  /** 宠物包里的状态 id。 */
  state: string;
  /** 面板按钮上的文字（只影响显示，不影响语义）。 */
  label: string;
  loop: boolean;
  /**
   * 播一遍的时长（ms = frames / fps × 1000）。
   *
   * 一次性动作靠它算结束时刻 —— 与行为层处理微动作用的是同一个量、同一个理由
   * （`behavior.ts` 的 `clipMs`）。**不能用 `dwellMs` 代替**：`loop:false` 播完不循环，
   * 画面会冻在末帧上摆好几秒。
   */
  clipMs: number;
  /**
   * 位移朝向；`null` = 这个动作不位移（原地演）。
   *
   * 由状态自己的 `role` 推出来（`locomotion-left` / `locomotion-right`），
   * **不按状态名猜** —— 换宠物包时状态名会变，role 不会。
   */
  facing: 'left' | 'right' | null;
}

/** 手动把玩策略。取值来自 `desktop-pet.json` 的 `actions` 段。 */
export interface ManualPlayPolicy {
  actions: ManualAction[];
  /** 循环类动作的演出时长（ms）。 */
  dwellMs: number;
  /** 位移距离区间（屏幕像素，默认缩放下）。 */
  walkDistancePx: { min: number; max: number };
}

/** 一次手动把玩的进行态。同一时刻最多一个（用户一次只点一个动作）。 */
export interface ManualPlay {
  state: string;
  loop: boolean;
  /**
   * 结束时刻（ms）。**永远有值**，因为它是"这次把玩一定会结束"的保证 ——
   * 位移类动作除了"走到位"之外还有这个上限兜底（窗口被别的东西卡住时不会永远走）。
   */
  until: number;
  /** 位移目标（窗口左上角 x，绝对 DIP）；null = 不位移。 */
  targetX: number | null;
  /** 上一 tick 时刻：位移按真实 dt 积分，不假设固定步长。 */
  lastStepAt: number;
}

/** 手动位移的可用空间小于这个值就当"走不动"（降级成原地演，见 walkNote）。 */
const MIN_WALK_PX = 20;
/** 目标点离当前位置近于这个距离就当到达。 */
const ARRIVE_EPS_PX = 0.6;
/** 单次位移积分的 dt 上限：机器休眠/卡顿后不该让宠物"瞬移"一段（与 behavior.ts 同值同因）。 */
const MAX_STEP_MS = 120;
/** 位移类动作的兜底时长上限：正常 300px / 96px·s⁻¹ ≈ 3.1 秒，给到 12 秒足够宽裕。 */
const WALK_TIMEOUT_MS = 12_000;
/**
 * 一次性动作播完之后多留一会儿再交回（ms）。
 *
 * 不留的话会在"最后一帧"上停留 0 毫秒 —— 那一帧往往正是动作的落定姿势（抱拳 / 落回地面），
 * 0 毫秒等于它没被看见。250ms 是"看见了"与"别赖着"之间的一个经验值。
 */
const ONESHOT_HOLD_MS = 250;

const num = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 从 `role` 推朝向。找不到位移 role 就是"原地演"，不按状态名猜。 */
function facingOf(role: string | undefined): 'left' | 'right' | null {
  if (role === 'locomotion-left') return 'left';
  if (role === 'locomotion-right') return 'right';
  return null;
}

/**
 * 从 sidecar 的 `actions` 段 + 宠物包的状态表解析策略。
 *
 * 两条是刻意**不硬编码**的（换成别的宠物包也得能跑）：
 *   - 清单里写错的状态名**丢弃并告警**，不让宠物卡在一个不存在的动作上；
 *   - 整个 `list` 省略时按**行号顺序**取全部状态、文字回落为状态 id。
 */
export function parseManualPlayPolicy(
  raw: unknown,
  pack: { states: Record<string, Pick<ResolvedState, 'row' | 'loop' | 'role' | 'frames' | 'fps'>> },
  warn: (message: string) => void = () => {},
): ManualPlayPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;

  const byRow = Object.entries(pack.states).sort((a, b) => a[1].row - b[1].row);
  const listed = Array.isArray(o['list']) ? (o['list'] as unknown[]) : null;

  const actions: ManualAction[] = [];
  const seen = new Set<string>();
  const push = (state: string, label: string): void => {
    const s = pack.states[state];
    if (!s) {
      warn(`动作 "${state}" 不在宠物包里，已忽略`);
      return;
    }
    if (seen.has(state)) {
      warn(`动作 "${state}" 在清单里重复，只保留第一次`);
      return;
    }
    seen.add(state);
    actions.push({
      state,
      label,
      loop: s.loop,
      clipMs: s.fps > 0 ? Math.round((s.frames / s.fps) * 1000) : 0,
      facing: facingOf(s.role),
    });
  };

  if (listed) {
    if (listed.length === 0) warn('actions.list 是空数组 ⇒ 面板上不会有动作按钮（省略整个 list 才会回落到"全部状态"）');
    for (const item of listed) {
      const it = (item ?? {}) as Record<string, unknown>;
      const state = typeof it['state'] === 'string' ? it['state'] : '';
      if (!state) { warn('actions.list 里有一条缺少 state，已忽略'); continue; }
      const label = typeof it['label'] === 'string' && it['label'] ? it['label'] : state;
      push(state, label);
    }
  } else {
    for (const [id] of byRow) push(id, id);
  }
  if (actions.length === 0 && byRow.length > 0) {
    warn('动作清单解析后为空 ⇒ 回落到"全部状态"（否则面板会没有可点的动作）');
    for (const [id] of byRow) push(id, id);
  }

  const dist = (Array.isArray(o['walkDistancePx']) ? o['walkDistancePx'] : []) as unknown[];
  const a = num(dist[0], NaN);
  const b = num(dist[1], NaN);
  const walkDistancePx = Number.isFinite(a) && Number.isFinite(b)
    ? { min: Math.min(a, b), max: Math.max(a, b) }
    : { min: 180, max: 300 };

  return {
    actions,
    dwellMs: Math.max(0, num(o['dwellMs'], 6000)),
    walkDistancePx,
  };
}

/**
 * 开始一次手动把玩，返回进行态与**第一条**要下发的行为命令。
 *
 * 位移类动作在这里就把目标点算好（距离随机取，再夹进工作区）—— 之后每 tick 只做积分。
 * **走不动时降级为原地演**而不是"挂着走路姿态却不动"：后者是滑步，
 * 而滑步的成因（速度与步频不匹配）本项目已经记录过一次。
 */
export function beginManualPlay(
  action: ManualAction,
  policy: ManualPlayPolicy,
  now: number,
  pet: Rect,
  workArea: Rect,
  speedPxPerSec: number,
  rng: () => number = Math.random,
): { play: ManualPlay; command: BehaviorCommand } {
  const play = { state: action.state, loop: action.loop };
  const command: BehaviorCommand = { play, moveX: null };
  /**
   * 这次把玩的演出时长。
   *
   * 一次性动作（`loop:false`：拜一拜、跳一下）**按自己的片长**走，不留到 `dwellMs` ——
   * `loop:false` 播完不循环，画面会冻在末帧上摆好几秒（那正是"看起来卡住了"）。
   * 循环动作才用 `dwellMs`：它的存在意义就是"别演个没完"（ADR 021 的学费）。
   */
  const holdMs = action.loop
    ? policy.dwellMs
    : action.clipMs + ONESHOT_HOLD_MS;

  if (!action.facing) {
    return {
      play: { ...play, until: now + Math.max(1, holdMs), targetX: null, lastStepAt: 0 },
      command,
    };
  }

  const lo = workArea.x;
  const hi = workArea.x + workArea.width - pet.width;
  const t = clamp(rng(), 0, 1);
  const dist = policy.walkDistancePx.min + (policy.walkDistancePx.max - policy.walkDistancePx.min) * t;
  const want = pet.x + (action.facing === 'right' ? dist : -dist);
  const target = Math.round(clamp(want, lo, hi));
  const reachable = hi > lo && Math.abs(target - pet.x) >= MIN_WALK_PX;

  if (!reachable) {
    // 走不动（贴着屏幕边缘 / 工作区比宠物还窄）→ 原地演一遍，**不假装走了**。
    // 用同一个 holdMs：走不动的必然是循环的位移姿态，所以它就是 dwellMs。
    return {
      play: { ...play, until: now + Math.max(1, holdMs), targetX: null, lastStepAt: 0 },
      command,
    };
  }

  // 兜底时长按"这段距离要走多久"给，再乘 2 加余量 —— 正常永远不会触发（到达就结束），
  // 但窗口被别的东西卡住时它保证这次把玩一定收得住。
  const travelMs = (Math.abs(target - pet.x) / Math.max(1, speedPxPerSec)) * 1000;
  return {
    play: {
      ...play,
      until: now + Math.min(WALK_TIMEOUT_MS, travelMs * 2 + 1500),
      targetX: target,
      lastStepAt: 0,
    },
    command,
  };
}

/**
 * 推进一 tick。
 *
 * 返回 `play: null` 表示**这次把玩结束**（到点 / 走到位）—— 调用方必须据此显式交回仲裁器，
 * 不能只把进行态清掉了事：覆盖是渲染层的一个变量，没人撤销它就永远停在那里
 * （行为层此时 `sentPlay` 已是 null，它不会替我们撤销）。
 */
export function tickManualPlay(
  prev: ManualPlay,
  now: number,
  pet: Rect,
  speedPxPerSec: number,
): { play: ManualPlay | null; command: BehaviorCommand } {
  const dt = prev.lastStepAt === 0 ? 0 : clamp(now - prev.lastStepAt, 0, MAX_STEP_MS);
  const next: ManualPlay = { ...prev, lastStepAt: now };

  if (now >= next.until) {
    return { play: null, command: { play: null, moveX: next.targetX === null ? null : Math.round(next.targetX) } };
  }
  if (next.targetX === null) return { play: next, command: { moveX: null } };

  const remaining = next.targetX - pet.x;
  const step = (speedPxPerSec * dt) / 1000;
  if (Math.abs(remaining) <= Math.max(ARRIVE_EPS_PX, step)) {
    return { play: null, command: { play: null, moveX: Math.round(next.targetX) } };
  }
  return {
    play: next,
    command: { moveX: Math.round(pet.x + Math.sign(remaining) * step) },
  };
}
