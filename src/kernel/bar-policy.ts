// 控制条的显示策略：**纯函数**，只回答"现在该不该显示控制条"。
//
// 与 `kernel/bubble-policy.ts` 同一个套路，理由也一样：这条策略里最容易错的规则
// 肉眼看不出对错 —— 快捷键收起控制条之后光标还停在宠物上，如果不做抑制，
// 下一个 tick 就会把它弹回来，表现为"快捷键根本关不掉控制条"。只有把它抽成纯函数、
// 用虚拟时钟断言才钉得住。窗口与 IPC 的脏活全在 `host/control-bar.ts`，这里不碰。

/** 控制条显示策略。取值来自 `desktop-pet.json` 的 `controlBar` 段。 */
export interface BarPolicy {
  /** 悬停需连续保持多久才出现（防"划过宠物"就弹出来）。 */
  hoverDelayMs: number;
  /** 光标离开后多久收起（给"从宠物移到控制条上"留时间）。 */
  hoverGraceMs: number;
  /** 失去焦点后多久收起。 */
  blurHideMs: number;
  /** 快捷键收起后，抑制悬停重新唤出的时长。 */
  toggleSuppressMs: number;
  /** false = 只能靠快捷键 / 菜单唤出，悬停不响应（sidecar 里可关）。 */
  showOnHover: boolean;
}

export interface BarState {
  visible: boolean;
  hasFocus: boolean;
  /** 悬停计时起点；null = 当前没有在计时。 */
  hoverSince: number | null;
  /** 计划收起时刻；null = 没有计划收起。 */
  hideAt: number | null;
  /** 抑制悬停唤出的截止时刻；null = 未抑制。 */
  suppressUntil: number | null;
  /**
   * 是否允许"悬停唤出"。
   *
   * 为什么必须有这个位（而不是只清空计时就够）：「由非悬停路径引起的隐藏」发生时，
   * 光标往往**还停在原地**（全屏让位时光标就在宠物上；按快捷键收起时也是）。
   * 此时若只把 `hoverSince` 清成 null，下一个 tick 的 `hover(true)` 就会被当成
   * "光标刚刚进入"，300ms 后控制条自己冒出来 —— 而规则 1 明确要求"宠物回来时
   * 不自动重现"、规则 2 要求"快捷键收起后不被悬停弹回来"。
   *
   * 置真的唯一时机是 `hover(false)`：光标**真的离开过一次**。这是这套规则里
   * 唯一无法从"当前光标在哪"推导出来的信息，所以必须显式存。
   */
  armed: boolean;
}

export type BarEvent =
  /** 光标是否在「宠物 ∪ 控制条矩形」内。由主进程的 16ms 光标轮询 + 渲染层命中状态算出。 */
  | { kind: 'hover'; over: boolean }
  | { kind: 'focus'; hasFocus: boolean }
  /** 全局快捷键：唤出 / 收起。 */
  | { kind: 'toggle' }
  /** Esc、面板上的收起按钮。 */
  | { kind: 'request-close' }
  /** 宠物被隐藏（托盘 / 右键菜单 / 全屏让位）。 */
  | { kind: 'pet-hidden' };

export const BAR_HIDDEN: BarState = {
  visible: false,
  hasFocus: false,
  hoverSince: null,
  hideAt: null,
  suppressUntil: null,
  armed: true,
};

const clampMs = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def;

/** 从 sidecar 的 `controlBar` 段解析策略。漏配不该让控制条起不来。 */
export function parseBarPolicy(raw: unknown): BarPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    hoverDelayMs: clampMs(o['hoverDelayMs'], 300),
    hoverGraceMs: clampMs(o['hoverGraceMs'], 500),
    blurHideMs: clampMs(o['blurHideMs'], 200),
    toggleSuppressMs: clampMs(o['toggleSuppressMs'], 1500),
    showOnHover: o['showOnHover'] !== false,
  };
}

/** 不变量①：不可见时不该留着"计划收起"，也不该自称还有焦点。 */
function normalize(s: BarState): BarState {
  if (s.visible) return s;
  if (s.hideAt === null && !s.hasFocus) return s;
  return { ...s, hideAt: null, hasFocus: false };
}

/** 统一的"收起来"：清计时、放弃焦点记账、并撤销悬停唤出资格。 */
function hide(s: BarState, extra: Partial<BarState> = {}): BarState {
  return normalize({ ...s, visible: false, hideAt: null, hasFocus: false, hoverSince: null, armed: false, ...extra });
}

/**
 * 消费一个事件，算出新的状态。调用方比较前后 `visible` 即可知道"该显示还是该隐藏"。
 *
 * 规则逐条列清（避免"面板自己弹出来 / 收不掉"这类无法解释的症状）：
 *  1. `pet-hidden` → 立即隐藏，**不自动重现**（宠物回来时等光标重新进入）；
 *  2. `toggle` → 取反。收起时置 `suppressUntil`；
 *  3. `request-close` → 立即隐藏；
 *  4. `hover(true)`：被抑制 / 策略禁用 / 资格未解锁 → 不启动计时；否则仅"首次进入"启计时；
 *     已可见则清 `hideAt`（光标回来了）；
 *  5. `hover(false)` → 清计时、**解锁悬停唤出**；可见且无焦点 → `hoverGraceMs` 后收起；
 *  6. `focus(true)` → 清 `hideAt`（有焦点就不自动收，否则用户正在点它、它自己消失了）；
 *  7. `focus(false)` → 可见则 `blurHideMs` 后收起。
 */
export function nextBarState(
  prev: BarState,
  ev: BarEvent,
  policy: BarPolicy,
  now: number,
): BarState {
  switch (ev.kind) {
    case 'pet-hidden':
      return hide(prev);

    case 'toggle':
      if (prev.visible) {
        return hide(prev, { suppressUntil: now + policy.toggleSuppressMs });
      }
      return normalize({ ...prev, visible: true, suppressUntil: null });

    case 'request-close':
      return hide(prev);

    case 'hover': {
      if (!ev.over) {
        // 光标离开：解锁悬停唤出（下次进入可重新计时），可见且无焦点则安排宽限收起。
        const next: BarState = { ...prev, hoverSince: null, armed: true, hideAt: null };
        if (prev.visible && !prev.hasFocus) next.hideAt = now + policy.hoverGraceMs;
        return normalize(next);
      }
      const suppressed = prev.suppressUntil !== null && now < prev.suppressUntil;
      // 不启动计时：策略禁用 / 正在抑制（快捷键刚收起）/ 资格未解锁（宠物刚从全屏回来）
      if (!policy.showOnHover || suppressed || !prev.armed) return normalize(prev);
      const next: BarState = { ...prev, armed: true };
      if (prev.hoverSince === null) next.hoverSince = now;
      if (prev.visible) next.hideAt = null;
      return normalize(next);
    }

    case 'focus': {
      if (ev.hasFocus) return normalize({ ...prev, hasFocus: true, hideAt: null });
      if (!prev.visible) return normalize({ ...prev, hasFocus: false });
      // 有焦点时由用户主动关（Esc / 收起按钮）才收；失焦则给一点宽限，避免
      // "从控制条移到宠物上"这一小段路被当成离开。
      return normalize({ ...prev, hasFocus: false, hideAt: now + policy.blurHideMs });
    }
  }
}

/**
 * 时间推进：到点显示 / 到点收起。
 *
 * "到点显示"只置 `visible`，**不置 hasFocus** —— 悬停唤出必须走 `showInactive()`
 * 不抢焦点（用户可能正在 IDE 里打字）。抢不抢焦点由宿主层按事件来源决定，状态机不表态。
 */
export function tickBarState(prev: BarState, policy: BarPolicy, now: number): BarState {
  if (!prev.visible) {
    if (
      policy.showOnHover &&
      prev.hoverSince !== null &&
      now - prev.hoverSince >= policy.hoverDelayMs
    ) {
      return { ...prev, visible: true, hideAt: null };
    }
    return normalize(prev);
  }
  if (prev.hideAt !== null && now >= prev.hideAt) {
    // 到点收起**不能**撤销 `armed`：这条路径的前置是"光标已经离开"（`hideAt` 只由
    // `hover(false)` / `focus(false)` 设置），此时光标早已不在宠物上，而 `hover(false)`
    // 只会在 over 真正翻转的那一次发出来 —— 若在这里把 armed 置回 false，
    // 就再也没有事件能把它解开，表现为**悬停唤出永久失效**（且只有读代码能看出来）。
    return normalize({ ...prev, visible: false, hideAt: null, hasFocus: false, hoverSince: null });
  }
  return normalize(prev);
}
