// 通道 A · hook 事件 → 业务状态的**纯函数**映射层。
//
// 为什么单独一个文件：
//   1. 映射必须能**离线单测**（跑真实 agent 回合很贵，而且失败面很窄，不该靠它兜回归）；
//   2. 这份映射**同时服务 WorkBuddy / Codex / 将来的 Claude Code** —— 三者的 hook 事件名与
//      stdin 契约是同一套（WorkBuddy 内嵌 CLI 里就是那份 14 事件表），所以"配置落哪个路径"
//      是调用方的事，映射层不认识任何具体 agent。
//
// 纪律（与状态文件适配器同一套）：事件名走白名单，未知事件**忽略而不是报错**；
//   文本限长；取值非法一律保留上次好值（即：直接不产出事件）。
//   这个文件是 agent 会在每次工具调用后执行的热路径，**不允许抛异常**。

/**
 * 事件名 → 业务状态。`null` 表示"这个事件不改变状态，只做收尾"。
 *
 * 为什么这么分（每条都有理由，改之前先读 docs/design/m3-status-ecosystem.md §4）：
 *   - `Stop` 是"一轮结束、有结果可看" ⇒ `ready`（宠物画 waving → review）。
 *   - `Notification` / `PermissionRequest` 都是"agent 在等你" ⇒ `needs-input`。
 *     前者是 Claude 系的通用"需要你"，后者是更精确的授权等待；两个都给，宁可重复也不漏。
 *   - `Interrupt` 是**用户自己**按了停止 ⇒ `idle`，不是 `blocked`。
 *     `blocked` 的动画是趴卧（"已受阻"），用它表达"我把它停了"是在对用户撒谎。
 *     （且本构建是否真的发出 `Interrupt` 尚未实测，见设计文档 §2.2 的待证实项。）
 *   - 工具级事件给 `running`：它们是"还在干活"的心跳，**默认不挂进配置**
 *     （实测每次 hook 触发 = 一次进程启动 ≈ 377ms，见设计文档事实 24）。
 *   - `WorktreeCreate` / `WorktreeRemove` 与活动状态无关 ⇒ 忽略。
 */
export const HOOK_EVENT_STATUS = Object.freeze({
  SessionStart: 'idle',
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  PostToolUseFailure: 'running',
  PermissionRequest: 'needs-input',
  Notification: 'needs-input',
  SubagentStart: 'running',
  SubagentStop: 'running',
  PreCompact: 'running',
  PostCompact: 'running',
  Stop: 'ready',
  Interrupt: 'idle',
  // 会话收尾：不写状态，而是把这个会话从快照里摘掉（等价于 pet-hook.mjs --clear）。
  SessionEnd: null,
});

/** 默认**挂进配置**的事件集：只放低频高价值的，工具级事件留给 "按预算再加"。 */
export const DEFAULT_CONFIGURED_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
]);

/** 工具级/子代理级事件：进 `--events=all` 才挂。 */
export const VERBOSE_EVENTS = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Interrupt',
]);

const STATUS_VALUES = new Set(['idle', 'running', 'needs-input', 'blocked', 'ready']);
const MAX_SESSION_ID = 64;
const MAX_TITLE = 120;

/** 去掉控制字符与前后空白，并限长 —— 这两个字段会进状态文件，也会进气泡。 */
function cleanText(v, max) {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * 会话 id 命名空间：**必须带来源前缀**。
 *
 * 为什么（2026-09-18 用户提问"两个软件同时跑会不会冲突"）：
 *   两个 agent 各占一个 sessionId 本来天然隔离；但**不带前缀**时，两个 app 的 UUID 万一相撞，
 *   一个会覆盖另一个 —— 概率低、后果是状态乱跳且难查。
 *   前缀还有第二个用处：用户"只想连某一个 agent"时，就是一次按前缀过滤，不需要新机制。
 */
export function sessionIdFor(source, rawId) {
  const src = cleanText(source, 16) ?? 'agent';
  const id = cleanText(rawId, MAX_SESSION_ID) ?? 'default';
  return `${src}:${id}`;
}

/**
 * 标题：用 `cwd` 的末段，并**带上来源**。
 *
 * 为什么要带来源：气泡与控制条上只显示一个标题，两个 agent 同时在跑时
 * 不带来源就分不清谁是谁（用户 2026-09-18 提的"叠加"顾虑在界面上的样子）。
 */
export function titleFor(payload, sourceLabel) {
  const cwd = cleanText(payload?.['cwd'], 260);
  const base = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const label = cleanText(sourceLabel, 24);
  const who = label ?? cleanText(payload?.['source'], 24) ?? 'agent';
  if (!base) return who;
  const t = `${who} · ${base}`;
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE) : t;
}

/** 解析 stdin 文本。解析失败返回 null —— 绝不让半截 JSON 把 agent 的回合搞挂。 */
export function parseHookPayload(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * 把一份 hook payload 归一化成"要写进状态文件的那一行"。
 *
 * @returns {null | { sessionId: string, status: string, title?: string, clear: boolean, event: string }}
 *   `null` 表示这份输入不产生任何状态变化（未知事件 / 非法取值 / 读不懂）。
 *   调用方必须把 `null` 当作"什么都不做"，而不是"写 idle"——那会在两个 agent 同时跑时
 *   把别人的状态踩掉。
 */
export function normalizeHookEvent(raw, opts = {}) {
  const payload = typeof raw === 'string' ? parseHookPayload(raw) : raw;
  if (!payload) return null;

  const event = cleanText(payload['hook_event_name'], 40);
  if (!event) return null;
  if (!(event in HOOK_EVENT_STATUS)) return null; // 未知事件：忽略

  const status = HOOK_EVENT_STATUS[event];
  if (status !== null && !STATUS_VALUES.has(status)) return null;

  const source = cleanText(opts.source, 16) ?? 'agent';
  return {
    event,
    sessionId: sessionIdFor(source, payload['session_id']),
    status,
    title: titleFor(payload, opts.label),
    clear: status === null,
  };
}
