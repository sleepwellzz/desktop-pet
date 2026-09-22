// 控制条的显示策略：**纯函数**，只回答"现在该不该显示控制条"。
//
// 与 `kernel/bubble-policy.ts` 同一个套路，理由也一样：这条策略里最容易错的规则
// 肉眼看不出对错（"面板多待了一会儿"和"面板自己冒出来"在屏幕上都只是一瞬间的事），
// 只有把它抽成纯函数、用虚拟时钟断言才钉得住。窗口与 IPC 的脏活全在 `host/control-bar.ts`。
//
// **2026-09-17 大幅缩小（ADR 016）**：悬停唤出整条路径被移除，唤出入口只剩**显式动作**
// （右键宠物 / ~~`Win+Alt+P`~~ / 托盘菜单「控制条」）。**2026-09-21 起快捷键那条也删了（ADR 032），
// 现只剩两条。** 依据是产品判断（用户拍板）：
// 桌宠常驻屏幕角落，光标是"顺便"掠过的（拖窗口、去任务栏、切应用都会经过它），
// 任何基于悬停的自动弹出都必然产生"我没叫它、它自己冒出来"的体验 ——
// 延迟 2~3 秒只降低频率，不改变性质；而左键单击宠物要播一个动作，
// 把"光标停在它身上"变成"会触发另一种 UI"，语义上就打架了。
//
// 因此这份状态机不再需要：悬停计时、悬停宽限、`armed` 位（"光标没真离开过就不许悬停唤出"）
// 与 `suppressUntil`（"快捷键收起后不被悬停弹回来"）。**那两条最容易错的规则连同它们的机制
// 一起删掉**——它们要防的场景在悬停消失后不再存在。留下的规则只有五条，逐条可读。
//
// **2026-09-22 加第六条与第七条（ADR 039）**：`walk-hide` / `walk-restore` ——
// 手动把玩的位移类动作（左右走）期间把面板收起、走完还回去（面板锚在宠物身上，会跟着飘）。
// 它们与悬停唤出**不是一回事**（那是"无人触发地自己冒出来"，这是**用户显式动作的延续**），
// 但正因为沾了"面板自动出现"这个敏感面，判断放在这里而不是主进程里 —— 要能单测。

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
  /**
   * "面板是**被宠物走路**临时收起来的，走完要还回去"（2026-09-22，ADR 039）。
   *
   * 为什么它是一个**状态**而不是主进程里的一个布尔：它决定"面板要不要自己冒出来"，
   * 而"面板自己冒出来"正是 ADR 016 花过学费要根除的体验 —— 这类判断必须能单测，
   * 所以和其他显示规则一起住在这个纯函数状态机里。
   *
   * 与悬停唤出的**根本区别**（别拿 ADR 016 来反对这一条）：
   * 这里不是"无人触发地弹出来"，而是**用户显式动作的延续** —— 是他自己点了「左走」，
   * 程序只是把面板还回原处。悬停那条是"我没叫它它自己冒出来"。
   *
   * 三条不变量：
   *  ① 只有 `walk-hide` 能置位（而且仅在面板当时可见时）；
   *  ② **面板一可见，欠账即作废** —— 用户已经自己把它叫回来了，走完不许再开一次
   *     （`toggle` / `request-close` / `pet-hidden` 走的是同一条：见 `nextBarState` 末尾）；
   *  ③ `walk-restore` **没有欠账就什么都不做**（绝不自作主张显示）。
   */
  restoreAfterWalk: boolean;
}

export type BarEvent =
  /** 唤出 / 收起。右键宠物与托盘菜单「控制条」两条路径共用这一条（原第三条「全局快捷键」已删，ADR 032）。 */
  | { kind: 'toggle' }
  /** Esc、面板右上角的收起按钮。 */
  | { kind: 'request-close' }
  | { kind: 'focus'; hasFocus: boolean }
  /** 宠物被隐藏（托盘 / 右键菜单 / 全屏让位）。 */
  | { kind: 'pet-hidden' }
  /**
   * 位移类手动把玩（左右走）**即将开始**：面板锚在宠物身上，走路会拖着它一起飘 ——
   * 用户不接受那个观感（ADR 038 负面结论 2 被 ADR 039 取代）。所以先收起来，走完再还。
   * 面板本来就没显示时什么都不做（没有"收起来"这回事，也没有欠账）。
   */
  | { kind: 'walk-hide' }
  /** 位移类手动把玩**结束**：把面板还回去。没有欠账时什么都不做。 */
  | { kind: 'walk-restore' };

export const BAR_HIDDEN: BarState = {
  visible: false,
  hasFocus: false,
  hideAt: null,
  restoreAfterWalk: false,
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

/**
 * 统一的"收起来"：清计划、放弃焦点记账。
 *
 * **刻意不动 `restoreAfterWalk`**：那是"欠用户一次显示"，与"现在收起来"是两件事。
 * `walk-hide` 正是"收起 + 记账"的组合。
 */
function hide(s: BarState): BarState {
  return normalize({ ...s, visible: false, hideAt: null, hasFocus: false });
}

/**
 * 消费一个事件，算出新的状态。调用方比较前后 `visible` 即可知道"该显示还是该隐藏"。
 *
 * 规则逐条列清（避免"面板自己冒出来 / 收不掉"这类无法解释的症状）：
 *  1. `pet-hidden` → 立即隐藏（宠物不在，面板锚在半空没有意义）；
 *  2. `walk-hide` → 可见则收起并记下"待恢复"（位移类手动把玩，ADR 039）；
 *  3. `walk-restore` → **有待恢复**才重新显示（没有就什么都不做，绝不自作主张冒出来）；
 *  4. `toggle` → 取反 —— 两条唤出路径都是这一条，所以"再按一次就收起"天然成立；
 *  5. `request-close` → 立即隐藏（Esc / ×）；
 *  6. `focus(true)` → 清 `hideAt`（有焦点就不自动收，否则用户正在点它、它自己消失了）；
 *  7. `focus(false)` → 可见则 `blurHideMs` 后收起。"点到别处即关"是面板唯一的
 *     **非显式**关闭途径，也是它像"一个真窗口"而不是"贴纸"的地方。
 *
 * **不变量②③（`nextBarState` 末尾那两段）**：面板一旦**可见**，`restoreAfterWalk` 一律作废；
 * 用户/环境明确要求它**关着**时（`pet-hidden` / Esc / ×）同样作废。
 * 少了②，用户自己唤回面板后走完会被再开一次；少了③，走路期间宠物被隐藏时
 * 走完会把面板**开到半空**（这两个都是 2026-09-22 由单测真抓到的，不是想出来的）。
 *
 * 抢不抢焦点由宿主层按唤出路径决定，状态机不表态 —— 它只记"当前有没有焦点"。
 */
export function nextBarState(
  prev: BarState,
  ev: BarEvent,
  policy: BarPolicy,
  now: number,
): BarState {
  const next = applyEvent(prev, ev, policy, now);

  // 不变量②：**面板一旦可见，欠账即作废。** 无论它是被 `toggle` 还是被 `walk-restore`
  // 自己弄可见的，都意味着这份欠账已经结清 —— 用户已经看到了面板。
  if (next.visible) return { ...next, restoreAfterWalk: false };

  // 不变量③：**用户/环境明确要求它关着时，欠账也作废**（`pet-hidden` / Esc / ×）。
  // 少了这条就有两个真实缺陷（2026-09-22 单测抓到）：
  //   · 走路期间宠物被隐藏（托盘 / 全屏让位）⇒ 走完 `walk-restore` 会把面板**开到半空**；
  //   · 用户在走路期间按 Esc / 点 × ⇒ 他刚关掉，走完又自动开一次 = "它自己冒出来"。
  if (ev.kind === 'pet-hidden' || ev.kind === 'request-close') {
    return next.restoreAfterWalk ? { ...next, restoreAfterWalk: false } : next;
  }
  return next;
}

function applyEvent(
  prev: BarState,
  ev: BarEvent,
  policy: BarPolicy,
  now: number,
): BarState {
  switch (ev.kind) {
    case 'pet-hidden':
      return hide(prev);

    case 'walk-hide':
      // 本来就没显示 ⇒ 没有"收起来"这回事，也不该产生欠账（否则走完会凭空冒出一个面板）
      return prev.visible ? hide({ ...prev, restoreAfterWalk: true }) : prev;

    case 'walk-restore':
      // 没有欠账就什么都不做 —— 这是"绝不自作主张显示"的落点
      if (!prev.restoreAfterWalk) return prev;
      return normalize({ ...prev, visible: true, hideAt: null, restoreAfterWalk: false });

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
