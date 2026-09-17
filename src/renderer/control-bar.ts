// 控制条渲染层：把主进程下发的整份视图画成一个面板，并把点击翻译成**命令 id**。
//
// 这层是**哑面板**：不持有状态、不读文件、不算业务，收到的 BarView 就是全部真相
// （与气泡层同一个纪律，见 shared/ipc.ts 的 BarView 注释）。
// 用 DOM 而不是 canvas：文字排版、省略号、按钮交互交给浏览器最省事，也不需要关心 DPR。
import type { BarCommand, BarCommandId, BarView } from '../shared/ipc';

const barEl = document.getElementById('bar') as HTMLDivElement;
const dotEl = document.getElementById('dot') as HTMLSpanElement;
const summaryEl = document.getElementById('summary') as HTMLSpanElement;
const sessionsEl = document.getElementById('sessions') as HTMLDivElement;
const scaleEl = document.getElementById('scale') as HTMLSpanElement;

/** 白名单的镜像，仅用于"发之前再确认一次"。真正的白名单在主进程。 */
const KNOWN_IDS: readonly BarCommandId[] = [
  'hide-pet', 'ack-session', 'popup-menu', 'close-bar',
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
  const sid = hit.dataset['sid'];
  send(sid ? { id, arg: sid } : { id });
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
  for (const s of shown) {
    const row = document.createElement('div');
    row.className = 'row';
    const needsAck = s.status === 'needs-input' && !s.acknowledged;
    if (needsAck) {
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
    // 如实显示"需要输入（已确认）"而不是显示成"空闲" —— 内核把 original status 与
    // acknowledged 分开暴露，就是为了让界面不说谎（见 kernel/status.ts 的 SessionView 注释）。
    st.textContent = needsAck ? label(s.status) : s.acknowledged ? `${label(s.status)}（已确认）` : label(s.status);
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

    if (needsAck) {
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

  // —— 动作排 ——
  // 只剩一个只读的缩放值与两个按钮（隐藏宠物 / ⋯），不再有需要按状态禁用的控件。
  scaleEl.textContent = `${Math.round(v.scale * 100)}%`;
}

/** 相对时间每秒刷新。只改文本节点，不重建 DOM —— 否则按钮的 hover 状态会每秒闪一次。 */
setInterval(() => {
  if (!lastView) return;
  const now = Date.now();
  for (const it of liveTimes) {
    it.el.textContent = relTime(it.ts, now);
    it.el.classList.toggle('stale', now - it.ts > STALE_HINT_MS);
  }
}, 1000);

window.petBar.onView(render);

// 快捷键唤出时主进程会下令聚焦。本轮面板没有输入框，把焦点交给面板本身即可 ——
// 这样 Esc 一定收得到（M3 加输入框后，这里改成聚焦输入框，别的地方都不用动）。
barEl.tabIndex = -1;
window.petBar.onFocus(() => barEl.focus());
