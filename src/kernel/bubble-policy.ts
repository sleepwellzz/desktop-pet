// 气泡的显示策略：**纯函数**，只做"这次该显示什么、什么时候该隐藏"的判断。
//
// 为什么单独抽出来：这条策略里最容易出错的规则肉眼看不出对错 ——
// "同一状态重复推送不重置计时"（否则 agent 每次 hook 心跳都会把气泡反复刷出来），
// 只有把它做成纯函数、用虚拟时钟断言才钉得住。窗口与 IPC 的脏活在宿主层，这里不碰。
import type { PetStatus } from './status';

export interface BubblePolicy {
  /** 常驻显示的状态（不自动隐藏），对应 `statusMap[*].attentionPulse` 的语义。 */
  stickyStatuses: string[];
  /** 各状态的展示时长（ms）：`0` = 立即隐藏，`null` = 常驻；缺省用 defaultHoldMs。 */
  holdMsByStatus: Record<string, number | null>;
  defaultHoldMs: number;
}

export interface BubbleInput {
  status: PetStatus;
  /** 来自 `statusMap[status].bubble`；null 表示这个状态不该有气泡。 */
  text: string | null;
  badgeCount: number;
}

export interface BubbleState {
  visible: boolean;
  text: string | null;
  badge: number;
  /** 到期时刻（epoch ms）；null = 常驻或当前不可见。 */
  hideAt: number | null;
  /** 最近一次决定所依据的状态。用于识别"同状态重复推送"。 */
  status: PetStatus | '';
}

export const BUBBLE_HIDDEN: BubbleState = {
  visible: false, text: null, badge: 0, hideAt: null, status: '',
};

/**
 * 算出新的气泡状态。
 *
 * 规则：
 *  1. 该状态没有文案（idle）→ 隐藏；
 *  2. **状态与上次相同 → 原样返回**（不重置计时、不因为心跳重新冒出来），仅当角标数变化时更新角标；
 *  3. 状态变化 → 按策略定时：常驻状态 hideAt=null，`0` 时长立即隐藏，其余 now+hold。
 */
export function nextBubbleState(
  prev: BubbleState,
  next: BubbleInput,
  policy: BubblePolicy,
  now: number,
): BubbleState {
  if (!next.text) {
    return prev.visible || prev.status !== '' ? { ...BUBBLE_HIDDEN, status: next.status } : prev;
  }
  if (prev.status === next.status) {
    // 同一条状态的心跳：计时不动。角标变了就跟一下（角标不属于"提醒"，随时可以更新）。
    return prev.badge === next.badgeCount ? prev : { ...prev, badge: next.badgeCount };
  }
  if (policy.stickyStatuses.includes(next.status)) {
    return { visible: true, text: next.text, badge: next.badgeCount, hideAt: null, status: next.status };
  }
  const hold = policy.holdMsByStatus[next.status];
  const holdMs = hold === undefined ? policy.defaultHoldMs : hold;
  if (holdMs === null) {
    return { visible: true, text: next.text, badge: next.badgeCount, hideAt: null, status: next.status };
  }
  if (holdMs <= 0) {
    return { ...BUBBLE_HIDDEN, status: next.status };
  }
  return { visible: true, text: next.text, badge: next.badgeCount, hideAt: now + holdMs, status: next.status };
}

/** 到期检查（主进程定时器调用）。 */
export function bubbleExpired(state: BubbleState, now: number): boolean {
  return state.visible && state.hideAt !== null && now >= state.hideAt;
}

/** 从宠物包清单里解析策略（缺字段就用兜底值，宠物包不该因为漏配这个就跑不起来）。 */
export function parseBubblePolicy(raw: unknown): BubblePolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const sticky = Array.isArray(o['stickyStatuses'])
    ? o['stickyStatuses'].filter((s): s is string => typeof s === 'string')
    : ['needs-input'];
  const holds: Record<string, number | null> = {};
  const rawHolds = o['holdMsByStatus'];
  if (rawHolds && typeof rawHolds === 'object') {
    for (const [k, v] of Object.entries(rawHolds as Record<string, unknown>)) {
      if (v === null) holds[k] = null;
      else if (typeof v === 'number' && Number.isFinite(v)) holds[k] = v;
    }
  }
  const def = typeof o['defaultHoldMs'] === 'number' ? (o['defaultHoldMs'] as number) : 3000;
  return { stickyStatuses: sticky, holdMsByStatus: holds, defaultHoldMs: def };
}
