// 状态层离线单测：仲裁器（虚拟时钟）+ 状态文件适配器（真实临时目录）。
//
// 为什么值得单独写：设计文档要求"仲裁器的粘滞与限流逻辑可以接虚拟时钟做确定性单测"，
// 而这三条防抖规则恰恰是"状态直连动画"最容易翻车的地方 —— 它们靠肉眼看宠物根本看不出对错
// （少一次限流只是画面抖一下），只有把它们钉在断言里才能防止后续改动悄悄破坏。
//
// 跑法：node tools/status-arbiter.test.mjs   （需先 npm run build，测的是 dist 产物）
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

// —— ⑧b 陈旧快照：没有 ts 的条目按"快照写入时刻"兜底 ——
// 这是 2026-09-17 修掉的一条真缺陷（ADR 016）。缺陷形状：快照是原样读回的，而适配器
// **刻意不补 Date.now()**（补了轮询就变成假心跳），于是事件里的 ts 是 undefined，
// 内核的兜底 `ts ?? now` 把它盖章成"现在" —— 一份昨天写的 `running` 快照在启动后
// "新鲜"整整 15 分钟，用户看到的是"一启动就显示某某在运行中"。
// 正确语义是：**"不知道"不等于"刚刚"**。
// 探针证据（真实文件 + 真实适配器，不弹窗）：spikes/m2-status/probe-stale-sessions.mjs。
section('⑧b 没有 ts 的陈旧快照不再被当成新鲜');
{
  const HOUR = 3_600_000;

  /**
   * 起一轮真实适配器 + 真实仲裁器（临时文件、文件 mtime 倒回 ageMs）。
   * 仲裁器的时钟用虚拟时钟，起点 = 真实当前时间（这样它能与文件 mtime 比大小）。
   */
  const boot = async (snapshot, ageMs) => {
    const d = mkdtempSync(join(tmpdir(), 'pet-stale-'));
    const f = join(d, 'status.json');
    writeFileSync(f, JSON.stringify(snapshot), 'utf8');
    const past = new Date(Date.now() - ageMs);
    utimesSync(f, past, past);
    const clock = makeClock(Date.now());
    const logs = [];
    const events = [];
    const arb = new StatusArbiter({
      statusMap: runtimeManifest.statusMap, now: clock.now, log: (m) => logs.push(m),
    });
    const src = createStatusFileSource({ path: f, pollMs: 40, log: (m) => logs.push(m) });
    src.start((e) => { events.push(e); arb.ingest(e); });
    await sleep(250);
    return {
      status: arb.state.status, rows: arb.viewSessions().length, logs, events,
      stop: () => { src.stop(); rmSync(d, { recursive: true, force: true }); },
    };
  };

  const stale = await boot(
    { schema: 'desktop-pet/status/v1', sessions: { old: { status: 'running', title: '上次运行留下的' } } },
    HOUR,
  );
  eq('无 ts + 1 小时前的快照 → 启动就是空闲（不再"新鲜" 15 分钟）', stale.status, 'idle');
  eq('陈旧会话不出现在面板数据里', stale.rows, 0);
  check('日志里有静默兜底的留痕', stale.logs.some((l) => l.includes('静默超过')));
  stale.stop();

  const fresh = await boot({ sessions: { n: { status: 'running', title: '刚写的' } } }, 0);
  eq('刚写下的无 ts 快照照常生效（真在跑的会话不能被杀）', fresh.status, 'running');
  fresh.stop();

  const withTs = await boot({ sessions: { t: { status: 'running', ts: Date.now() - HOUR } } }, 0);
  eq('带 ts 的陈旧会话行为不变（本来就正确）', withTs.status, 'idle');
  withTs.stop();

  const badTs = await boot({ sessions: { bad: { status: 'running', ts: '昨天' } } }, HOUR);
  eq('ts 类型非法（非数字）也走 mtime 兜底', badTs.status, 'idle');
  badTs.stop();

  // —— 心跳排除：无 ts 的条目不得被"别的会话被写"带着续命 ——
  // 同一次写入会让文件里**所有**会话的 mtime 兜底值一起变；若不排除，
  // 只要任意一条会话被写，所有无 ts 的陈旧会话都会被续命 —— 等于把静默兜底关掉。
  const d2 = mkdtempSync(join(tmpdir(), 'pet-hb-'));
  const f2 = join(d2, 'status.json');
  writeFileSync(f2, JSON.stringify({
    schema: 'desktop-pet/status/v1',
    sessions: { a: { status: 'running' }, b: { status: 'running' } },
  }), 'utf8');
  const past2 = new Date(Date.now() - HOUR);
  utimesSync(f2, past2, past2);
  const ev2 = [];
  const src2 = createStatusFileSource({ path: f2, pollMs: 40, log: () => {} });
  try {
    src2.start((e) => ev2.push(e));
    await sleep(250);
    eq('首读：两条无 ts 会话各报一次', ev2.length, 2);
    check('它们的时间戳是快照写入时刻（1 小时前）而不是"现在"',
      ev2.every((e) => typeof e.ts === 'number' && Math.abs(e.ts - past2.getTime()) < 1000),
      JSON.stringify(ev2.map((e) => e.ts)));
    const n = ev2.length;
    // 只改 a 的标题：文件被重写、mtime 变新，b 的内容一字未动
    writeFileSync(f2, JSON.stringify({
      schema: 'desktop-pet/status/v1',
      sessions: { a: { status: 'running', title: '改了' }, b: { status: 'running' } },
    }), 'utf8');
    await sleep(300);
    const tail = ev2.slice(n);
    check('只有真正变化的那条产生事件（b 没有被顺手续命）',
      tail.length === 1 && tail[0].sessionId === 'a', JSON.stringify(tail));
  } finally {
    src2.stop();
    rmSync(d2, { recursive: true, force: true });
  }
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
// **2026-09-17 起这份状态机只剩五条规则**：悬停唤出被移除，连"悬停计时 / armed 位 /
// 抑制窗口"一起删掉了（ADR 016）——它们要防的场景（光标停在宠物上、快捷键收起后被弹回来、
// 宠物让位回来自己冒出来）在悬停消失后不复存在。
// 留下来的规则依旧"肉眼看不出对错"（收起早 200ms 与"面板自己冒出来"在屏幕上都是一瞬间），
// 所以照旧钉在断言里。
section('⑪ 控制条显示策略');
{
  const { nextBarState, tickBarState, parseBarPolicy, BAR_HIDDEN } =
    require(join(root, 'dist/kernel/bar-policy.js'));
  // 用真实运行参数（desktop-pet.json 的 controlBar 段），而不是测试里另写一份策略
  const policy = parseBarPolicy(runtimeManifest.controlBar);
  eq('策略来自宠物包：失焦 200ms 收起', policy.blurHideMs, 200);
  eq('漏配 controlBar 时仍有兜底策略', parseBarPolicy(undefined).blurHideMs > 0, true);

  const clock = makeClock();
  const ev = (s, e) => nextBarState(s, e, policy, clock.now());

  // —— 唤出 / 收起：三条唤出路径（右键宠物 / 快捷键 / 托盘菜单）共用 toggle ——
  let st = ev({ ...BAR_HIDDEN }, { kind: 'toggle' });
  eq('toggle → 唤出', st.visible, true);
  eq('状态机不替谁记焦点（焦点由窗口的真实 focus 事件送来）', st.hasFocus, false);
  st = ev(st, { kind: 'toggle' });
  eq('再 toggle → 收起', st.visible, false);

  // —— 焦点：有焦点就不自动收 ——
  let f = ev(ev({ ...BAR_HIDDEN }, { kind: 'toggle' }), { kind: 'focus', hasFocus: true });
  eq('有焦点时不安排收起', f.hideAt, null);
  const blurAt = clock.now();
  f = ev(f, { kind: 'focus', hasFocus: false });
  eq('失焦后按 blurHideMs 安排收起', f.hideAt, blurAt + policy.blurHideMs);
  eq('未到点仍可见', tickBarState(f, blurAt + policy.blurHideMs - 1).visible, true);
  const g = tickBarState(f, blurAt + policy.blurHideMs);
  eq('到点收起', g.visible, false);
  eq('收起后不留收起计划', g.hideAt, null);

  // —— 「⋯」弹原生菜单的场景：失焦后又在宽限内拿回焦点 → 取消收起 ——
  // 这条对应主进程里的 `barMenuOpen` 屏蔽（原生菜单会夺走面板焦点）：
  // 即便屏蔽失效、真的走到了失焦分支，只要焦点回来面板就不该消失。
  let m = ev(ev({ ...BAR_HIDDEN }, { kind: 'toggle' }), { kind: 'focus', hasFocus: true });
  m = ev(m, { kind: 'focus', hasFocus: false });
  m = ev(m, { kind: 'focus', hasFocus: true });
  eq('拿回焦点即取消收起', m.hideAt, null);
  eq('仍可见', m.visible, true);
  eq('有焦点时时间推进不会把它收掉', tickBarState(m, clock.now() + 600_000).visible, true);

  // —— 不可见时的失焦不该凭空安排收起 ——
  const idleBlur = ev({ ...BAR_HIDDEN }, { kind: 'focus', hasFocus: false });
  eq('不可见时失焦不安排收起', idleBlur.hideAt, null);

  // —— request-close：Esc / × ——
  const c = ev(ev({ ...BAR_HIDDEN }, { kind: 'toggle' }), { kind: 'request-close' });
  eq('Esc → 立即隐藏', c.visible, false);

  // —— pet-hidden：宠物被隐藏时面板一起收，且不会自己回来 ——
  // （从前这条要靠 `armed` 位挡住"全屏退出瞬间光标还停在原处 → 面板自己冒出来"；
  //   现在没有悬停路径，面板只在显式唤出时出现，所以这条是天然成立的。）
  let h = ev({ ...BAR_HIDDEN }, { kind: 'toggle' });
  h = ev(h, { kind: 'pet-hidden' });
  eq('宠物隐藏 → 控制条立即收起', h.visible, false);
  eq('宠物回来后也不会自动重现', tickBarState(h, clock.now() + 600_000).visible, false);

  // —— 不变量：不可见的状态不得自称有焦点 / 留着收起计划 ——
  const inv = ev(ev({ ...BAR_HIDDEN }, { kind: 'toggle' }), { kind: 'pet-hidden' });
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
  // 主状态**立刻**让给下一条 —— 人工确认是低频且明确的动作，不该被变化限流挡住
  // （限流是给 agent 的状态抖动用的）。这条是 2026-09-16 用户验收时报的
  // "点确认后响应非常缓慢"的直接修复：不改的话最多要等 500ms 窗格。
  eq('确认后立即让给下一条（不再等限流窗格）', arb.viewSessions()[0].sessionId, 'a');

  // 但限流本身没有被废掉：确认之后的另一次状态变化仍要等窗格。
  clock.advance(50);
  arb.ingest({ sessionId: 'a', status: 'blocked' });
  eq('确认之后的普通状态变化仍受限流约束', arb.state.status, 'running');
  clock.advance(600);
  arb.tick();
  eq('窗格到期后照常生效', arb.state.status, 'blocked');

  clock.advance(901_000);
  arb.tick();
  eq('静默过期的会话不出现在视图里', arb.viewSessions().length, 0);
}

// —— ⑬ clearSessions：菜单「清空状态会话」必须把**视图**也清掉 ——
// 2026-09-17 实测的缺陷（ADR 016）：清空状态文件后主状态回落 idle（宠物确实松手了），
// 但 `viewSessions()` 仍是两条 idle —— 面板照旧列两行、菜单照旧写「清空状态会话（2 条）」，
// 要等 15 分钟静默兜底才轮到它们。用户视角就是"没清干净"。
// 成因：适配器把"从快照消失"翻译成"补一条 idle 收尾"，仲裁器保留该记录，
// 而视图的过滤条件是"15 分钟内的记录" —— 清空产生的是一排 idle 行，不是"没有行"。
section('⑬ 清空会话：记录 / 视图 / 确认位一起清');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
  arb.ingest({ sessionId: 'a', status: 'running', title: 'a' });
  clock.advance(600);
  arb.ingest({ sessionId: 'b', status: 'needs-input', title: 'b' });
  eq('清空前：主状态是 needs-input', arb.state.status, 'needs-input');
  eq('清空前：面板两行', arb.viewSessions().length, 2);

  const changed = arb.clearSessions();
  eq('清空会改变仲裁输出（需要推给渲染层）', changed, true);
  eq('清空后主状态回落 idle', arb.state.status, 'idle');
  eq('清空后面板一行都不剩', arb.viewSessions().length, 0);
  eq('主状态的会话指针也清掉', arb.state.sessionId, null);

  // 清空是用户明确的破坏性动作，本身就是即时生效的（不被 500ms 限流窗格挡住）
  clock.advance(600);
  arb.ingest({ sessionId: 'c', status: 'blocked' });
  eq('清空之后状态层照常工作', arb.state.status, 'blocked');

  // —— 确认位也要清：否则同一个 sessionId 下次再出现会被当成"已读" ——
  const c2 = makeClock();
  const arb2 = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: c2.now });
  arb2.ingest({ sessionId: 'x', status: 'needs-input', title: 'x' });
  arb2.ack('x');
  eq('前置：该会话已被确认', arb2.viewSessions()[0].acknowledged, true);
  arb2.clearSessions();
  c2.advance(600);
  arb2.ingest({ sessionId: 'x', status: 'needs-input', title: 'x' });
  eq('清空后再出现的同一会话不再被当成已读', arb2.viewSessions()[0].acknowledged, false);
  eq('它会重新举手等用户确认', arb2.state.status, 'needs-input');
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
