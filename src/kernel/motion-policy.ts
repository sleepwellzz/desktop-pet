// 系统「减少动态效果」（prefers-reduced-motion）的应对策略：**纯函数**，可离线断言。
//
// 为什么单独抽出来：这条策略直接决定"宠物动不动"，而它出错时的表现
// （点了动作却是一张静态贴图）**在单台机器上根本看不出来** —— 只有开关取值不同的
// 两台机器对照才暴露。所以必须做成纯函数、用断言钉住，不能留在渲染层里当个 if。
//
// 2026-09-23 事故：分发给朋友后回报"所有动作都是静态图、炒菜站着不动、走路只是平移"，
// 而另一个朋友的机器一切正常。根因不是依赖缺失，是渲染层读 matchMedia 后关掉了帧推进，
// 把用户**显式触发**的动画也一起吞了（详见 ADR 043）。
//
// 边界（很重要，别再扩大）：
//   - **行为层**（自动漫游 / 微动作 / 踱步位移）继续尊重这个系统设置 —— 那是"它自作主张乱跑"，
//     用户没要求看，停下来是对的（ADR 018 已决策，不动）。
//   - **动画播放**（业务状态、手动把玩、单击致意）**不该被停** ——
//     用户主动打开一个桌宠、还点了"炒菜"，却看到一张不会动的图，这叫产品坏了。

/** `desktop-pet.json → reducedMotion.strategy` 的取值。 */
export type ReducedMotionStrategy =
  /**
   * 动画照常播放。**默认**。
   * 「减少动态效果」只管它自作主张乱跑（由行为层负责），不冻结动画本身。
   */
  | 'animate'
  /**
   * 只画固定的一帧：连状态动画与手动把玩一起冻住。
   * 给确实需要完全静止的人（前庭敏感等）—— 但要他**主动**去 sidecar 里改，不是默认。
   */
  | 'freeze-frame';

export interface MotionPolicy {
  strategy: ReducedMotionStrategy;
  /** `freeze-frame` 时固定画哪一帧（通常 0）。`animate` 下不使用。 */
  frameIndex: number;
}

export const DEFAULT_MOTION_POLICY: MotionPolicy = {
  strategy: 'animate',
  frameIndex: 0,
};

const STRATEGIES: readonly ReducedMotionStrategy[] = ['animate', 'freeze-frame'];

/** 从 sidecar 解析策略。缺字段或写错值一律回落到默认 —— 宠物包不该因为漏配这个就跑不起来。 */
export function parseMotionPolicy(raw: unknown): MotionPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = o['strategy'];
  const strategy: ReducedMotionStrategy =
    typeof s === 'string' && (STRATEGIES as readonly string[]).includes(s)
      ? (s as ReducedMotionStrategy)
      : DEFAULT_MOTION_POLICY.strategy;
  const fi = o['frameIndex'];
  const frameIndex =
    typeof fi === 'number' && Number.isFinite(fi) && fi >= 0
      ? Math.floor(fi)
      : DEFAULT_MOTION_POLICY.frameIndex;
  return { strategy, frameIndex };
}

/**
 * 这一策略下**帧推进要不要照常跑**。
 *
 * 判据下沉到策略自己身上（而不是在渲染层的每个调用点各写一遍 `!reducedMotion`）：
 * 调用点会新增（`tick` / 状态迁移 / 单击致意），策略只有一个。
 */
export function shouldAdvanceFrames(policy: MotionPolicy): boolean {
  return policy.strategy !== 'freeze-frame';
}

/** 给日志用的一句话说明，避免"看到策略名却不知道它意味着什么"。 */
export function describeMotionPolicy(policy: MotionPolicy): string {
  return shouldAdvanceFrames(policy)
    ? '动画照常（只停自主漫游/微动作）'
    : `动画冻结，只画第 ${policy.frameIndex} 帧`;
}
