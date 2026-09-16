// 状态层离线单测：仲裁器（虚拟时钟）+ 状态文件适配器（真实临时目录）。
//
// 为什么值得单独写：设计文档要求"仲裁器的粘滞与限流逻辑可以接虚拟时钟做确定性单测"，
// 而这三条防抖规则恰恰是"状态直连动画"最容易翻车的地方 —— 它们靠肉眼看宠物根本看不出对错
// （少一次限流只是画面抖一下），只有把它们钉在断言里才能防止后续改动悄悄破坏。
//
// 跑法：node tools/status-arbiter.test.mjs   （需先 npm run build，测的是 dist 产物）
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { StatusArbiter, resolveAnimation } = require(join(root, 'dist/kernel/status.js'));
const { PetPlayer } = require(join(root, 'dist/kernel/player.js'));
const { createStatusFileSource } = require(join(root, 'dist/source/status-file.js'));
// 用真实运行参数做断言，而不是测试里另写一份映射表 —— 否则测的是测试自己的假设。
const runtimeManifest = require(join(root, 'desktop-pet.json'));

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; process.stdout.write(`  ok   ${name}\n`); }
  else { failures.push(`${name}${detail ? ' —— ' + detail : ''}`); process.stdout.write(`  FAIL ${name}${detail ? ' —— ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(title) { process.stdout.write(`\n${title}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 虚拟时钟：一切与时间有关的断言都在它上面做，不依赖机器快慢。 */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
}

// —— ① 真实宠物包的 statusMap 解析契约 ——
section('① statusMap → 动画（用 desktop-pet.json 的真实配置）');
{
  const sm = runtimeManifest.statusMap;
  eq('running → running', resolveAnimation(sm, 'running').state, 'running');
  eq('needs-input → waiting', resolveAnimation(sm, 'needs-input').state, 'waiting');
  eq('blocked → failed', resolveAnimation(sm, 'blocked').state, 'failed');
  eq('idle → idle', resolveAnimation(sm, 'idle').state, 'idle');
  const ready = resolveAnimation(sm, 'ready');
  eq('ready → waving', ready.state, 'waving');
  eq('ready 的序列落点 = review', ready.then, 'review');
  eq('缺映射时回落 defaultState', resolveAnimation({}, 'running', 'idle').state, 'idle');
  eq('statusMap 整个缺失也不抛异常', resolveAnimation(undefined, 'blocked').state, 'idle');
}

// —— ② 优先级与多会话 ——
section('② 优先级 / 同分裁决 / 多会话角标');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  eq('初始为 idle', arb.state.status, 'idle');
  arb.ingest({ sessionId: 'a', status: 'running' });
  eq('首个状态立即生效（不受限流窗格影响）', arb.state.status, 'running');
  eq('无其他会话时角标为 0', arb.state.badgeCount, 0);

  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'ready' });
  eq('ready(3) 压过 running(4)', arb.state.status, 'ready');
  eq('角标统计其余活动会话', arb.state.badgeCount, 1);

  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'blocked' });
  eq('blocked(2) 压过 ready(3)', arb.state.status, 'blocked');

  clock.advance(600);
  arb.ingest({ sessionId: 'c', status: 'needs-input' });
  eq('needs-input(1) 优先级最高', arb.state.status, 'needs-input');
  eq('此时有 2 条其余活动会话', arb.state.badgeCount, 2);
  eq('气泡文案取自 statusMap', arb.state.bubble, '需要输入');
  eq('attentionPulse 透传', arb.state.attentionPulse, true);
}
{
  // 人工验收里的实际场景（喂状态.bat 按 4 再按 8）：needs-input 先进入粘滞，
  // 之后**另一个会话**转 running —— 角标必须变 +1，且主状态仍是 needs-input
  // （粘滞不该被 running 顶掉）。单会话永远得不出 +1，这是用户实际困惑过的点。
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'default', status: 'needs-input' });
  eq('粘滞起点：needs-input', arb.state.status, 'needs-input');
  eq('只有一个会话时角标为 0（这就是"开两个终端也看不到 +1"的原因）', arb.state.badgeCount, 0);

  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'running' });
  eq('第二个会话出现后角标变 1', arb.state.badgeCount, 1);
  eq('粘滞期间主状态仍是 needs-input', arb.state.status, 'needs-input');
  eq('气泡文案仍是 needs-input 那条', arb.state.bubble, '需要输入');

  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'idle' });
  eq('第二个会话转 idle 后角标归零', arb.state.badgeCount, 0);
}

// —— ③ 变化限流 + 最短展示 ——
section('③ 变化限流 / 最短展示（不丢弃，等窗格过后补上）');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  // 注意：idle 事件不产生切换（输出本来就是 idle），所以第一个**真实**切换是 running。
  // 断言必须挂在真实切换上，否则测的是"什么都没发生"。
  arb.ingest({ sessionId: 'a', status: 'running' });
  eq('起点 running', arb.state.status, 'running');

  clock.advance(100);
  arb.ingest({ sessionId: 'a', status: 'blocked' });
  eq('切换后 100ms 内的高优状态被挡下', arb.state.status, 'running');

  clock.advance(100);          // 距上次切换共 200ms，仍不足 500ms
  eq('tick 未到窗格不切换', arb.tick(), false);
  eq('200ms 时仍是 running', arb.state.status, 'running');

  clock.advance(300);          // 累计 500ms
  eq('窗格到期后由 tick 应用（不是丢弃）', arb.tick(), true);
  eq('被挡下的目标最终生效', arb.state.status, 'blocked');

  clock.advance(600);
  arb.ingest({ sessionId: 'a', status: 'running' });
  eq('窗格外的切换立即生效', arb.state.status, 'running');
}

// —— ④ 粘滞（needs-input 不被覆盖）——
section('④ 粘滞：needs-input 驻留至确认或超时');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'needs-input' });
  eq('进入 needs-input', arb.state.status, 'needs-input');

  clock.advance(600);
  arb.ingest({ sessionId: 'a', status: 'running' });
  eq('同一会话改口 running 也不能覆盖粘滞', arb.state.status, 'needs-input');

  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'blocked' });
  eq('其他会话的高优状态同样被粘滞挡住', arb.state.status, 'needs-input');

  clock.advance(600);
  eq('用户确认后解除', arb.ack(), true);
  eq('确认后回落到当前最优状态', arb.state.status, 'blocked');

  clock.advance(600);
  arb.ingest({ sessionId: 'a', status: 'needs-input' });
  eq('同一会话再次求助会重新进入粘滞（确认记录被清掉）', arb.state.status, 'needs-input');
}
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'needs-input' });
  clock.advance(300_000);       // 恰好到粘滞上限
  arb.tick();
  eq('达到粘滞上限后自动解除（而不是每 5 分钟重置一次）', arb.state.status, 'idle');
  clock.advance(600);
  arb.ingest({ sessionId: 'a', status: 'running' });
  eq('超时确认只降级 needs-input，该会话的 running 仍正常参与仲裁', arb.state.status, 'running');
}
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'needs-input' });
  eq('先进入 needs-input', arb.state.status, 'needs-input');
  clock.advance(600);           // 越过限流窗格，让断言只测粘滞本身
  arb.ingest({ sessionId: 'a', status: 'idle' });
  eq('会话自己改口 idle → 粘滞解除（不再举着手）', arb.state.status, 'idle');
}

// —— ⑤ 静默兜底 ——
section('⑤ 静默兜底：会话过期按 idle 处理');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'running' });
  eq('running 中', arb.state.status, 'running');
  clock.advance(899_000);
  eq('未到期时不回落', arb.tick(), false);
  clock.advance(2_000);
  eq('超过 15 分钟按 idle 处理', arb.tick(), true);
  eq('状态回到 idle', arb.state.status, 'idle');
  eq('过期会话被移除', arb.snapshot().length, 0);
}

// —— ⑥ 心跳：仅刷新时间戳不应产生状态迁移 ——
section('⑥ 心跳不引起状态切换');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'running' });
  clock.advance(600);
  eq('同状态心跳不产生输出变化', arb.ingest({ sessionId: 'a', status: 'running', ts: clock.now() }), false);
  clock.advance(899_000);
  eq('心跳把存活时间刷新了，不会静默过期', arb.tick(), false);
  eq('仍在 running', arb.state.status, 'running');
}

// —— ⑦ 播放器的一次性动作序列（ready → waving → review）——
section('⑦ 播放器的 then 落点');
{
  const states = {
    idle: { id: 'idle', row: 0, frames: 2, fps: 10, loop: true, offsetY: 2, frameColumns: [0, 1] },
    waving: { id: 'waving', row: 3, frames: 2, fps: 10, loop: false, offsetY: 1, frameColumns: [0, 1], fallbackState: 'idle' },
    review: { id: 'review', row: 8, frames: 2, fps: 10, loop: true, offsetY: 0, frameColumns: [0, 1] },
  };
  const p = new PetPlayer({ states }, 'idle');
  p.setState('waving', { then: 'review' });
  eq('播的是 waving', p.stateId, 'waving');
  eq('waving 是一次性动作', p.isOneShot, true);
  for (let i = 0; i < 30; i += 1) p.update(10);      // 推进 300ms，足够播完 2 帧
  eq('播完落到 then（review）而不是 fallback(idle)', p.stateId, 'review');

  const q = new PetPlayer({ states }, 'idle');
  q.setState('waving');
  for (let i = 0; i < 30; i += 1) q.update(10);
  eq('未指定 then 时仍走状态自身的 fallbackState', q.stateId, 'idle');
}

// —— ⑧ 状态文件适配器：快照 → 增量事件 ——
section('⑧ 状态文件适配器');
const dir = mkdtempSync(join(tmpdir(), 'pet-status-'));
const file = join(dir, 'status.json');
const events = [];
const source = createStatusFileSource({ path: file, pollMs: 50, log: () => {} });
try {
  source.start((e) => events.push(e));
  await sleep(150);
  eq('文件尚不存在时不产生事件', events.length, 0);

  writeFileSync(file, JSON.stringify({ status: 'running', title: '单会话简写' }), 'utf8');
  await sleep(400);
  eq('单会话简写被识别', events.at(-1)?.sessionId, 'default');
  eq('状态被识别', events.at(-1)?.status, 'running');
  eq('标题被带上', events.at(-1)?.title, '单会话简写');

  const before = events.length;
  writeFileSync(file, JSON.stringify({ status: 'running', title: '单会话简写' }), 'utf8');
  await sleep(400);
  eq('内容未变时不重复产生事件', events.length, before);

  writeFileSync(file, JSON.stringify({
    schema: 'desktop-pet/status/v1',
    sessions: { 'sess-a': { status: 'needs-input', title: '等你拍板', ts: Date.now() } },
  }), 'utf8');
  await sleep(400);
  check('多会话格式被识别', events.some((e) => e.sessionId === 'sess-a' && e.status === 'needs-input'));
  // 换成多会话快照时，前一步的单会话 default 就此从快照里消失，应当被补一条 idle 收尾
  check('快照里不再出现的会话补 idle 收尾',
    events.some((e) => e.sessionId === 'default' && e.status === 'idle'));

  const beforeInvalid = events.length;
  writeFileSync(file, JSON.stringify({ sessions: { 'sess-a': { status: '炸了' } } }), 'utf8');
  await sleep(400);
  eq('非法状态值被丢弃：不产生事件', events.length, beforeInvalid);

  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  await sleep(400);
  eq('半截/损坏内容被忽略并保留上一次好值', events.length, beforeInvalid);

  writeFileSync(file, JSON.stringify({ schema: 'desktop-pet/status/v1', sessions: {} }), 'utf8');
  await sleep(400);
  const last = events.at(-1);
  eq('会话从文件消失时补一条 idle', last?.status, 'idle');
  eq('补的 idle 属于消失的那个会话（非法条目没把它误判成消失）', last?.sessionId, 'sess-a');
} finally {
  source.stop();
  rmSync(dir, { recursive: true, force: true });
}

// —— ⑨ 气泡策略（纯函数 + 虚拟时钟）——
section('⑨ 气泡显示策略');
{
  const { nextBubbleState, bubbleExpired, parseBubblePolicy, BUBBLE_HIDDEN } =
    require(join(root, 'dist/kernel/bubble-policy.js'));
  // 用真实运行参数做断言（desktop-pet.json 的 bubble 段），而不是测试里另写一份策略
  const policy = parseBubblePolicy(runtimeManifest.bubble);
  eq('策略来自宠物包：needs-input 常驻', policy.stickyStatuses.includes('needs-input'), true);
  eq('策略来自宠物包：running 2 秒', policy.holdMsByStatus['running'], 2000);

  const clock = makeClock();
  let st = { ...BUBBLE_HIDDEN };

  // idle 没有文案 → 隐藏
  st = nextBubbleState(st, { status: 'idle', text: null, badgeCount: 0 }, policy, clock.now());
  eq('idle（无文案）→ 不显示', st.visible, false);

  // running：显示并在 2 秒后到期
  st = nextBubbleState(st, { status: 'running', text: '运行中', badgeCount: 0 }, policy, clock.now());
  eq('running → 显示', st.visible, true);
  eq('running 的到期时刻 = now+2000', st.hideAt, clock.now() + 2000);
  eq('未到期', bubbleExpired(st, clock.now() + 1999), false);
  eq('到期后需要收起', bubbleExpired(st, clock.now() + 2000), true);

  // **心跳不重置计时**：同状态再推一次，hideAt 必须原样不动
  const before = st.hideAt;
  clock.advance(800);
  const same = nextBubbleState(st, { status: 'running', text: '运行中', badgeCount: 0 }, policy, clock.now());
  eq('同状态重复推送不重置计时（心跳不该把气泡刷出来）', same.hideAt, before);

  // 同状态 + 角标变化 → 只更新角标
  const withBadge = nextBubbleState(st, { status: 'running', text: '运行中', badgeCount: 2 }, policy, clock.now());
  eq('角标变化会更新', withBadge.badge, 2);
  eq('角标变化不重置计时', withBadge.hideAt, before);

  // 已经收起之后，同状态的心跳**不能**把它重新刷出来
  let hidden = { ...st, visible: false, hideAt: null };
  hidden = nextBubbleState(hidden, { status: 'running', text: '运行中', badgeCount: 0 }, policy, clock.now());
  eq('已收起后同状态心跳不重新冒出', hidden.visible, false);

  // needs-input 常驻
  let sticky = nextBubbleState(hidden, { status: 'needs-input', text: '需要输入', badgeCount: 0 }, policy, clock.now());
  eq('needs-input → 显示', sticky.visible, true);
  eq('needs-input 常驻（hideAt=null）', sticky.hideAt, null);
  eq('常驻状态永不到期', bubbleExpired(sticky, clock.now() + 999_999), false);

  // 状态变化 → 重新计时
  const afterSticky = nextBubbleState(sticky, { status: 'blocked', text: '已受阻', badgeCount: 0 }, policy, clock.now());
  eq('状态变化后换成新文案', afterSticky.text, '已受阻');
  eq('状态变化后重新计时（4 秒）', afterSticky.hideAt, clock.now() + 4000);
}

// —— ⑩ 快捷键写法的归一化 ——
section('⑩ 快捷键人话 → Electron accelerator');
{
  const { normalizeAccelerator } = require(join(root, 'dist/host/hotkey.js'));
  eq('Win+Alt+P → Super+Alt+P（Windows 键在 Electron 里叫 Super）',
    normalizeAccelerator('Win+Alt+P'), 'Super+Alt+P');
  eq('小写 ctrl 归一化', normalizeAccelerator('ctrl+alt+p'), 'Control+Alt+P');
  eq('裸单字符键名大写', normalizeAccelerator('Super+Alt+space'), 'Super+Alt+space');
  eq('已是 Electron 写法则不变', normalizeAccelerator('CommandOrControl+Shift+Alt+P'), 'CommandOrControl+Shift+Alt+P');
  eq('windows 别名', normalizeAccelerator('windows+shift+p'), 'Super+Shift+P');
  eq('多字符键名保留', normalizeAccelerator('Ctrl+Alt+F5'), 'Control+Alt+F5');
  // 关键：宠物包里写的就是人话（Win+...），不归一化会注册成功但永不触发
  eq('宠物包里的默认值归一化后可用', normalizeAccelerator(runtimeManifest.interaction.hideShortcut.default), 'Super+Alt+P');
}

// —— ⑪ 控制条显示策略（纯函数 + 虚拟时钟）——
// 这个 section 里有两组"肉眼看不出对错"的规则，它们是这个功能最容易坏掉的地方：
//   1. 快捷键收起后**不能被悬停弹回来**；2. 宠物从全屏让位回来后**不能自动冒出面板**。
// 两者都靠同一个 `armed` 位实现（光标没离开过就不许悬停唤出），而它唯一无法从
// "当前光标在哪"推导出来 —— 所以必须钉在断言里，改动时一旦破坏立刻红。
section('⑪ 控制条显示策略');
{
  const { nextBarState, tickBarState, parseBarPolicy, BAR_HIDDEN } =
    require(join(root, 'dist/kernel/bar-policy.js'));
  // 用真实运行参数（desktop-pet.json 的 controlBar 段），而不是测试里另写一份策略
  const policy = parseBarPolicy(runtimeManifest.controlBar);
  eq('策略来自宠物包：悬停 300ms 出现', policy.hoverDelayMs, 300);
  eq('策略来自宠物包：离开 500ms 收起', policy.hoverGraceMs, 500);
  eq('策略来自宠物包：失焦 200ms 收起', policy.blurHideMs, 200);
  eq('策略来自宠物包：悬停默认开启', policy.showOnHover, true);
  const fallback = parseBarPolicy(undefined);
  eq('漏配 controlBar 时仍有兜底策略', fallback.hoverDelayMs > 0 && fallback.showOnHover, true);

  const clock = makeClock();
  const ev = (s, e) => nextBarState(s, e, policy, clock.now());
  const hover = (s, over) => ev(s, { kind: 'hover', over });
  const after = (s, ms) => { clock.advance(ms); return tickBarState(s, policy, clock.now()); };

  // —— 悬停：计时 → 到点出现 ——
  let st = hover({ ...BAR_HIDDEN }, true);
  eq('光标进入 → 开始计时', st.hoverSince, clock.now());
  eq('不足 hoverDelayMs 不显示', tickBarState(st, policy, clock.now() + 299).visible, false);
  st = tickBarState(st, policy, clock.now() + 300);
  eq('到点显示', st.visible, true);
  eq('悬停唤出不给自己记焦点（要 showInactive）', st.hasFocus, false);

  // —— 悬停：离开 → 宽限内回来则取消收起 ——
  st = hover(st, false);
  eq('离开后安排宽限收起', st.hideAt, clock.now() + policy.hoverGraceMs);
  st = hover(st, true);
  eq('宽限内光标回来 → 取消收起', st.hideAt, null);
  eq('仍然可见', st.visible, true);

  // —— 到点收起后必须**仍能再次悬停唤出** ——
  // 这条防的是"tick 收起时顺手撤销 armed"：那样 armed 再也没有事件能解开，
  // 表现为悬停唤出永久失效，而屏幕上看起来只是"控制条不再自动出现"。
  st = hover(st, false);
  st = after(st, policy.hoverGraceMs);
  eq('宽限到点收起', st.visible, false);
  st = hover(st, true);
  eq('收起后光标再进来仍能开始计时（armed 没被到点收起吃掉）', st.hoverSince !== null, true);
  st = after(st, policy.hoverDelayMs);
  eq('能够再次显示', st.visible, true);

  // —— 有焦点就不自动收，失焦才收 ——
  let f = after(hover({ ...BAR_HIDDEN }, true), policy.hoverDelayMs);
  f = ev(f, { kind: 'focus', hasFocus: true });
  f = hover(f, false);
  eq('有焦点时即使光标离开也不安排收起', f.hideAt, null);
  eq('仍可见', f.visible, true);
  const blurAt = clock.now();
  f = ev(f, { kind: 'focus', hasFocus: false });
  eq('失焦后安排 blurHideMs 收起', f.hideAt, blurAt + policy.blurHideMs);
  f = after(f, policy.blurHideMs);
  eq('到点收起', f.visible, false);

  // —— 核心反面用例①：快捷键收起后，光标还停在宠物上 ——
  let t = after(hover({ ...BAR_HIDDEN }, true), policy.hoverDelayMs);
  t = ev(t, { kind: 'toggle' });
  eq('快捷键收起', t.visible, false);
  eq('同时进入抑制窗口', t.suppressUntil, clock.now() + policy.toggleSuppressMs);
  t = hover(t, true);                                    // 光标原地没动 → 仍然 over=true
  t = after(t, policy.toggleSuppressMs + 100);
  eq('抑制期内不被悬停弹回来', t.visible, false);
  t = hover(t, true);
  t = after(t, policy.hoverDelayMs + 50);
  eq('抑制过期后、光标从未离开 → 仍不补唤出', t.visible, false);
  t = hover(t, false);
  t = hover(t, true);
  t = after(t, policy.hoverDelayMs);
  eq('光标真的离开再回来 → 恢复可唤出', t.visible, true);

  // —— 核心反面用例②：宠物被隐藏后不自动重现 ——
  let h = after(hover({ ...BAR_HIDDEN }, true), policy.hoverDelayMs);
  h = ev(h, { kind: 'pet-hidden' });
  eq('宠物隐藏 → 控制条立即收起', h.visible, false);
  h = hover(h, true);
  h = after(h, policy.hoverDelayMs + 100);
  eq('宠物回来后光标还停在原处 → 不自动冒出面板', h.visible, false);

  // —— request-close：Esc / 收起按钮 ——
  let c = after(hover({ ...BAR_HIDDEN }, true), policy.hoverDelayMs);
  c = ev(c, { kind: 'request-close' });
  eq('Esc → 立即隐藏', c.visible, false);

  // —— showOnHover=false：悬停彻底不响应，快捷键仍可用 ——
  const noHover = parseBarPolicy({ ...runtimeManifest.controlBar, showOnHover: false });
  let n = nextBarState({ ...BAR_HIDDEN }, { kind: 'hover', over: true }, noHover, clock.now());
  n = tickBarState(n, noHover, clock.now() + 10_000);
  eq('showOnHover=false 时悬停永不唤出', n.visible, false);
  n = nextBarState(n, { kind: 'toggle' }, noHover, clock.now());
  eq('但快捷键仍可唤出', n.visible, true);

  // —— 不变量：不可见的状态不得自称有焦点 / 留着收起计划 ——
  const inv = ev(ev({ ...BAR_HIDDEN }, { kind: 'focus', hasFocus: true }), { kind: 'pet-hidden' });
  eq('隐藏后清掉焦点记账', inv.hasFocus, false);
  eq('隐藏后不留收起计划', inv.hideAt, null);
}

// —— ⑫ 控制条仪表盘：会话视图（只读，不改仲裁行为）——
section('⑫ 会话视图 viewSessions');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'running', title: '重构 pack.ts' });
  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'needs-input' });
  let v = arb.viewSessions();
  eq('两条会话都列出', v.length, 2);
  eq('主状态排第一', v[0].sessionId, 'b');
  eq('主状态被打标', v[0].primary, true);
  eq('其余会话不是 primary', v[1].primary, false);
  eq('原始状态如实暴露', v[0].status, 'needs-input');
  eq('未确认', v[0].acknowledged, false);
  eq('标题透传', v[1].title, '重构 pack.ts');

  // 确认之后：**原始状态不变**，只多一个 acknowledged。
  // 界面据此显示"需要输入（已确认）"而不是把它说成"空闲" —— 内核不替 UI 说这个谎。
  arb.ack('b');
  v = arb.viewSessions();
  const b = v.find((x) => x.sessionId === 'b');
  eq('确认后原始状态仍是 needs-input', b.status, 'needs-input');
  eq('确认标记为真', b.acknowledged, true);
  // 主状态**不会立刻**让给下一条：确认也要走 ADR 010 那条变化限流窗格。
  // 界面因此会先显示"需要输入（已确认）"，半秒后才换成 running —— 这是既有设计的正常表现。
  eq('确认后限流窗格内主状态仍是 b', v[0].sessionId, 'b');
  clock.advance(600);
  arb.tick();
  eq('限流窗格过后主状态让给下一条', arb.viewSessions()[0].sessionId, 'a');

  clock.advance(901_000);
  arb.tick();
  eq('静默过期的会话不出现在视图里', arb.viewSessions().length, 0);
}

// —— 汇总 ——
process.stdout.write(`\n${'─'.repeat(56)}\n`);
if (failures.length === 0) {
  process.stdout.write(`全部通过：${passed} 项断言\n`);
  process.exit(0);
}
process.stdout.write(`通过 ${passed} 项，失败 ${failures.length} 项：\n`);
for (const f of failures) process.stdout.write(`  - ${f}\n`);
process.exit(1);
