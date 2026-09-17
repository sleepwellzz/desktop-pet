// 控制条的显示策略：**纯函数**，只回答"现在该不该显示控制条"。
//
// 与 `kernel/bubble-policy.ts` 同一个套路，理由也一样：这条策略里最容易错的规则
// 肉眼看不出对错（"面板多待了一会儿"和"面板自己冒出来"在屏幕上都只是一瞬间的事），
// 只有把它抽成纯函数、用虚拟时钟断言才钉得住。窗口与 IPC 的脏活全在 `host/control-bar.ts`。
//
// **2026-09-17 大幅缩小（ADR 016）**：悬停唤出整条路径被移除，唤出入口只剩**显式动作**
// （右键宠物 / `Win+Alt+P` / 托盘菜单「控制条」）。依据是产品判断（用户拍板）：
// 桌宠常驻屏幕角落，光标是"顺便"掠过的（拖窗口、去任务栏、切应用都会经过它），
// 任何基于悬停的自动弹出都必然产生"我没叫它、它自己冒出来"的体验 ——
// 延迟 2~3 秒只降低频率，不改变性质；而左键单击宠物要播一个动作，
// 把"光标停在它身上"变成"会触发另一种 UI"，语义上就打架了。
//
// 因此这份状态机不再需要：悬停计时、悬停宽限、`armed` 位（"光标没真离开过就不许悬停唤出"）
// 与 `suppressUntil`（"快捷键收起后不被悬停弹回来"）。**那两条最容易错的规则连同它们的机制
// 一起删掉**——它们要防的场景在悬停消失后不再存在。留下的规则只有五条，逐条可读。

/** 控制条显示策略。取值来自 `desktop-pet.json` 的 `controlBar` 段。 */
export interface BarPolicy {
  /** 失去焦点后多久收起（给"从面板移回宠物"这类一小段路留时间）。 */
  blurHideMs: number;
}

export interface BarState {
  visible: boolean;
  hasFocus: boolean;
  /** 计划收起时刻；null = 没有计划收起。 */
  hideAt: number | null;
}

export type BarEvent =
  /** 唤出 / 收起。右键宠物、全局快捷键、托盘菜单「控制条」三条路径共用这一条。 */
  | { kind: 'toggle' }
  /** Esc、面板右上角的收起按钮。 */
  | { kind: 'request-close' }
  | { kind: 'focus'; hasFocus: boolean }
  /** 宠物被隐藏（托盘 / 右键菜单 / 全屏让位）。 */
  | { kind: 'pet-hidden' };

export const BAR_HIDDEN: BarState = {
  visible: false,
  hasFocus: false,
  hideAt: null,
};

/** 从 sidecar 的 `controlBar` 段解析策略。漏配不该让控制条起不来。 */
export function parseBarPolicy(raw: unknown): BarPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const v = o['blurHideMs'];
  return { blurHideMs: typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 200 };
}

/** 不变量①：不可见时不该留着"计划收起"，也不该自称还有焦点。 */
function normalize(s: BarState): BarState {
  if (s.visible) return s;
  if (s.hideAt === null && !s.hasFocus) return s;
  return { ...s, hideAt: null, hasFocus: false };
}

/** 统一的"收起来"：清计划、放弃焦点记账。 */
function hide(s: BarState): BarState {
  return normalize({ ...s, visible: false, hideAt: null, hasFocus: false });
}

/**
 * 消费一个事件，算出新的状态。调用方比较前后 `visible` 即可知道"该显示还是该隐藏"。
 *
 * 规则逐条列清（避免"面板自己冒出来 / 收不掉"这类无法解释的症状）：
 *  1. `pet-hidden` → 立即隐藏（宠物不在，面板锚在半空没有意义）；
 *  2. `toggle` → 取反 —— 三条唤出路径都是这一条，所以"再按一次就收起"天然成立；
 *  3. `request-close` → 立即隐藏（Esc / ×）；
 *  4. `focus(true)` → 清 `hideAt`（有焦点就不自动收，否则用户正在点它、它自己消失了）；
 *  5. `focus(false)` → 可见则 `blurHideMs` 后收起。"点到别处即关"是面板唯一的
 *     **非显式**关闭途径，也是它像"一个真窗口"而不是"贴纸"的地方。
 *
 * 抢不抢焦点由宿主层按唤出路径决定，状态机不表态 —— 它只记"当前有没有焦点"。
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
      return prev.visible ? hide(prev) : normalize({ ...prev, visible: true, hideAt: null });

    case 'request-close':
      return hide(prev);

    case 'focus': {
      if (ev.hasFocus) return normalize({ ...prev, hasFocus: true, hideAt: null });
      if (!prev.visible) return normalize({ ...prev, hasFocus: false });
      return normalize({ ...prev, hasFocus: false, hideAt: now + policy.blurHideMs });
    }
  }
}

/**
 * 时间推进：到点收起。
 *
 * 主进程把它挂在 16ms 的光标轮询上（没有单独的定时器）：`hideAt` 到期时用户的光标
 * 往往已经静止，只剩那个轮询还在转。不可见时本函数是恒等的，不产生任何开销。
 */
export function tickBarState(prev: BarState, now: number): BarState {
  if (!prev.visible) return normalize(prev);
  if (prev.hideAt !== null && now >= prev.hideAt) {
    return normalize({ ...prev, visible: false, hideAt: null, hasFocus: false });
  }
  return normalize(prev);
}
