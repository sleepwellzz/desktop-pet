// 控制条渲染层：把主进程下发的整份视图画成一个面板，并把点击翻译成**命令 id**。
//
// 这层是**哑面板**：不持有状态、不读文件、不算业务，收到的 BarView 就是全部真相
// （与气泡层同一个纪律，见 shared/ipc.ts 的 BarView 注释）。
// 用 DOM 而不是 canvas：文字排版、省略号、按钮交互交给浏览器最省事，也不需要关心 DPR。
import type { BarCommand, BarCommandId, BarView } from '../shared/ipc';
// 判据从内核取，不在这层另写一份 —— 见 kernel/status.ts 的 `isAckable` 注释：
// 两处各写一份已经失配过一次（`ready` 在面板上连「确认」按钮都没有）。
import { isAckable } from '../kernel/status';

const barEl = document.getElementById('bar') as HTMLDivElement;
const dotEl = document.getElementById('dot') as HTMLSpanElement;
const summaryEl = document.getElementById('summary') as HTMLSpanElement;
const sessionsEl = document.getElementById('sessions') as HTMLDivElement;
const playsEl = document.getElementById('plays') as HTMLDivElement;
const petNameEl = document.getElementById('pet-name') as HTMLSpanElement;
const clearAllEl = document.getElementById('clear-all') as HTMLButtonElement;

/** 白名单的镜像，仅用于"发之前再确认一次"。真正的白名单在主进程。 */
const KNOWN_IDS: readonly BarCommandId[] = [
  'hide-pet', 'ack-session', 'ack-all', 'popup-menu', 'close-bar', 'play-action',
];

/**
 * 超过这个时长没动静的会话，在行里显式标出来。
 *
 * 起因（2026-09-16 用户实测）：状态文件是快照，上一次运行留下的会话会在下次启动时
 * 被原样读回来 —— 用户看到"一启动就显示 default 在运行中"，却不知道那是残留，
 * 只觉得"状态改不动"。把"很久没动静"标出来，是让界面自己解释这件事的最小手段。
 */
const STALE_HINT_MS = 5 * 60_000;

function send(cmd: BarCommand): void {
  if (!KNOWN_IDS.includes(cmd.id)) return;      // 正常路径不会走到；防御性
  window.petBar.command(cmd);
}

// —— 事件委托：面板内容会整块重建，绑定在 document 上一次即可 ——
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const hit = target?.closest<HTMLElement>('[data-cmd]');
  if (!hit) return;
  const id = hit.dataset['cmd'] as BarCommandId | undefined;
  if (!id) return;
  // 命令参数：会话行用 `data-sid`（会话 id），动作排用 `data-state`（状态 id）。
  // 两者都只是"给主进程查表用的 id"，主进程会各自校验它真的存在。
  const arg = hit.dataset['sid'] ?? hit.dataset['state'];
  send(arg ? { id, arg } : { id });
});

// Esc 收起。控制条是本项目唯一收键盘的窗口，这条路径同时也在验证
// "hide→show 之后键盘事件还进不进得来"（ADR 009 的鼠标版结论不能直接搬过来，见 ADR 014）。
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    send({ id: 'close-bar' });
  }
});

let lastView: BarView | null = null;
/** 需要随时间刷新的元素（"12 秒前"这类），与它们的 ts。 */
let liveTimes: { el: HTMLElement; ts: number }[] = [];

function relTime(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

function dot(status: string, primary: boolean): HTMLSpanElement {
  const el = document.createElement('span');
  // 主状态醒目、其余会话压暗 —— 一眼看出"哪条在决定宠物现在的样子"
  el.className = primary ? `dot s-${status}` : `dot dim s-${status}`;
  return el;
}

/**
 * 这条会话是否**在等用户处理**（要不要给「确认」按钮、行要不要可点）。
 *
 * ⚠️ 2026-09-18 的教训：这里此前自己写了一份判据（只认 `needs-input`），
 * 于是 `ready` 在面板上**既没有「确认」按钮、行也不可点** —— 用户看到状态一直挂着，
 * 却没有任何手段清掉它。而内核 `ack()` 早就同时覆盖两类。
 *
 * 现在两边都调内核的 `isAckable`，结构上不可能再漂移。语义留在内核的那份注释里。
 */
const needsAck = isAckable;

/**
 * 动作排的按钮与它对应的状态 id。
 *
 * 清单不变时**只改高亮、不重建 DOM**：面板内容会随状态推送重画，而重建会把
 * 光标下（或正按下）的那个按钮换成一个新元素 —— 那可能吞掉一次点击。
 * 会话行是全量重建的，那是它的既有做法；动作排是"要点的东西"，这里不沿用。
 */
let playButtons: { el: HTMLButtonElement; state: string }[] = [];
/** 上次渲染的动作清单签名（state:label 拼接）。用来判断"要不要重建"。 */
let playSignature = '';

/**
 * 动作排（2026-09-22，ADR 038）：手动把玩按钮。
 *
 * 每项 = 宠物包里的一个动作（文字取自 sidecar 的 `actions.list[].label`）。
 * 点一下 → 发 `play-action` 命令；**正在演的那一个再点一下 = 停止**（主进程做 toggle）。
 * 高亮用的是 `BarView.actions[].active`（主进程的真相），渲染层不自己记"我点过哪个"。
 */
function renderActions(v: BarView): void {
  const signature = v.actions.map((a) => `${a.state}=${a.label}`).join('|');
  if (signature !== playSignature) {
    playSignature = signature;
    playsEl.textContent = '';
    playButtons = v.actions.map((a) => {
      const b = document.createElement('button');
      // data-cmd 是事件委托的钩子；data-state 是命令参数（见上面的 click 委托）
      b.dataset['cmd'] = 'play-action';
      b.dataset['state'] = a.state;
      b.textContent = a.label;
      b.title = `让${v.petName}演一次「${a.label}」（正在演时再点一次即停止；手动把玩不显示气泡）`;
      playsEl.appendChild(b);
      return { el: b, state: a.state };
    });
  }
  for (const { el, state } of playButtons) {
    el.classList.toggle('on', v.actions.some((a) => a.state === state && a.active));
  }

  // 排版参数**全部**来自主进程（`desktop-pet.json → controlBar.actionColumns / actionRowHeight`）：
  // 面板高度是那边按同一对值算出来再 `setContentBounds` 的，两边各写一份就会出现
  // "面板比窗口矮一截、底部被切"。总高必须显式给 —— `#plays` 是 flex item，
  // 否则高度由内容（行数 × autoRows + 那条 border）决定，正好差 1px。
  const cols = Math.max(1, Math.round(v.actionColumns));
  const rows = v.actions.length === 0 ? 0 : Math.ceil(v.actions.length / cols);
  playsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  playsEl.style.gridAutoRows = `${v.actionRowHeight}px`;
  playsEl.style.height = `${rows * v.actionRowHeight}px`;
  playsEl.hidden = v.actions.length === 0;
}

function render(v: BarView): void {
  lastView = v;
  const label = (s: string): string => v.statusLabels?.[s as keyof typeof v.statusLabels] ?? s;

  dotEl.className = `dot s-${v.status}`;
  const n = v.sessions.length;
  summaryEl.textContent = label(v.status) + (n > 1 ? ` · ${n} 条会话` : '');
  summaryEl.title = summaryEl.textContent;

  // —— 会话列表 ——
  sessionsEl.textContent = '';
  liveTimes = [];
  const shown = v.sessions.slice(0, v.maxRows);
  let ackableCount = 0;                    // 有几条在等确认（决定动作排要不要放「全部已确认」）
  for (const s of shown) {
    const row = document.createElement('div');
    row.className = 'row';
    const needs = needsAck(s);
    if (needs) {
      ackableCount += 1;
      row.classList.add('ackable');
      row.dataset['cmd'] = 'ack-session';
      row.dataset['sid'] = s.sessionId;
      row.style.cursor = 'pointer';
    }
    row.appendChild(dot(s.status, s.primary));

    const sid = document.createElement('span');
    sid.className = 'sid';
    sid.textContent = s.title ? `${s.sessionId} · ${s.title}` : s.sessionId;
    sid.title = sid.textContent;
    row.appendChild(sid);

    const st = document.createElement('span');
    st.className = 'st';
    if (needs) {
      st.textContent = label(s.status);
    } else if (s.acknowledged) {
      st.textContent = `${label(s.status)}（已确认）`;
    } else if (s.expired) {
      // 内核已按到期把它降级为 idle（宠物不再摆那副姿态）。如实说明，
      // 否则用户会以为"面板坏了"或"还得再点一下"。
      // 兜底分支：`viewSessions()` 已把过期的 `ready` 过滤掉（ADR 024），正常路径到不了这里。
      st.textContent = `${label(s.status)}（已过期）`;
    } else {
      st.textContent = label(s.status);
    }
    row.appendChild(st);

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = relTime(s.ts, Date.now());
    if (Date.now() - s.ts > STALE_HINT_MS) {
      t.classList.add('stale');
      t.title = '这条会话很久没有动静了 —— 可能是上一次运行留下的残留。'
        + '右键宠物或托盘菜单里的「清空状态会话」可以一键清掉。';
    }
    row.appendChild(t);
    liveTimes.push({ el: t, ts: s.ts });

    if (needs) {
      const ack = document.createElement('button');
      ack.className = 'ack';
      ack.textContent = '确认';
      ack.dataset['cmd'] = 'ack-session';
      ack.dataset['sid'] = s.sessionId;
      row.appendChild(ack);
    }
    sessionsEl.appendChild(row);
  }
  if (n > v.maxRows) {
    const more = document.createElement('div');
    more.className = 'row more';
    more.textContent = `另有 ${n - v.maxRows} 条会话`;
    sessionsEl.appendChild(more);
  }

  // —— 手动把玩动作排 ——
  renderActions(v);

  // —— 底部动作排 ——
  // 面板刻意只有三个东西：一个动作（隐藏宠物）、一个身份（是谁）、一个出口（⋯ 完整菜单）。
  // 缩放曾经在这里有一个只读的百分比，2026-09-17 换成宠物名 —— 只读的 `70%` 既点不动、
  // 也不是用户关心的事，而"这块面板是谁的"才是它该回答的（ADR 016）。
  petNameEl.textContent = v.petName;
  petNameEl.title = `宠物包：${v.petName}（大小在托盘 / 右键菜单的「宠物大小」里改）`;

  // 「全部已确认」：有多条在等确认时才出现（只有一条时行内那个「确认」已经够了）。
  // 用户要求的就是"一个能把这种状态消干净的按钮"（2026-09-18）——
  // 行内按钮解决"这一条"，这里解决"一次清完"，两者配合才不必逐行点。
  clearAllEl.hidden = ackableCount === 0;
  if (ackableCount > 0) {
    clearAllEl.textContent = ackableCount > 1 ? `全部已确认（${ackableCount}）` : '已确认';
    clearAllEl.title = '把「在等你看」的会话一次性标为已读，宠物立刻回到待机';
  }
}

/** 相对时间每秒刷新。只改文本节点，不重建 DOM —— 否则按钮的 hover 状态会每秒闪一次。 */
// 句柄留着并在页面卸载时清掉 —— 这条本身无害（渲染层的定时器随 JS 上下文一起消失），
// 但它被 `tools/check-timers.mjs` 判为"关不掉的定时器"，而那条检查是为了主进程那次
// 真实崩溃（ADR 035：窗口都销毁了还在 tick）才立的。**对例外要解释清楚，不要加白名单了事。**
const relTimeTimer = setInterval(() => {
  if (!lastView) return;
  const now = Date.now();
  for (const it of liveTimes) {
    it.el.textContent = relTime(it.ts, now);
    it.el.classList.toggle('stale', now - it.ts > STALE_HINT_MS);
  }
}, 1000);
window.addEventListener('beforeunload', () => clearInterval(relTimeTimer));

window.petBar.onView(render);

// 唤出时主进程会下令聚焦（右键宠物 / 托盘菜单「控制条」）。本轮面板没有输入框，把焦点交给面板本身即可 ——
// 这样 Esc 一定收得到（M3 加输入框后，这里改成聚焦输入框，别的地方都不用动）。
barEl.tabIndex = -1;
window.petBar.onFocus(() => barEl.focus());
