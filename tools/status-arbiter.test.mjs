// 状态层离线单测：仲裁器（虚拟时钟）+ 状态文件适配器（真实临时目录）。
//
// 为什么值得单独写：设计文档要求"仲裁器的粘滞与限流逻辑可以接虚拟时钟做确定性单测"，
// 而这三条防抖规则恰恰是"状态直连动画"最容易翻车的地方 —— 它们靠肉眼看宠物根本看不出对错
// （少一次限流只是画面抖一下），只有把它们钉在断言里才能防止后续改动悄悄破坏。
//
// 跑法：node tools/status-arbiter.test.mjs   （需先 npm run build，测的是 dist 产物）
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { StatusArbiter, resolveAnimation, isAckable, PET_STATUSES } = require(join(root, 'dist/kernel/status.js'));
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

/**
 * 去掉注释再做"源码里有没有这个字符串"这类结构性检查。
 *
 * 起因（2026-09-22）：`tray.ts` 里那句"**不再用 `desktop-pet`**"的**注释**本身含有那个字符串，
 * 于是"托盘不再写死 desktop-pet"这条断言被自己的注释判红 —— **断言比它要测的东西更脆**。
 * 结构性检查一律先过这一步。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 虚拟时钟：一切与时间有关的断言都在它上面做，不依赖机器快慢。 */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
}

/** 确定性伪随机（LCG）：行为层的"走多远、往哪边"必须可复现，否则断言只能写成含糊的范围。 */
function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
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
  // blocked 也常驻（ADR 021）：第 5 行趴卧被「已受阻」与「打盹」共用，气泡是唯一的区分手段，
  // 4 秒就收起会让两种含义在画面上重新不可分。打盹没有气泡，那才是「没事」的默认样子。
  eq('策略来自宠物包：blocked 也常驻（区分 blocked 与打盹的唯一手段）',
    policy.stickyStatuses.includes('blocked'), true);
  eq('策略来自宠物包：running 2 秒', policy.holdMsByStatus['running'], 2000);
  eq('blocked 不再挂在定时表上（它走常驻那一支）', policy.holdMsByStatus['blocked'], undefined);

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

  // blocked 也常驻（ADR 021）：同样的断言形状，防止后续改动把它挪回定时表
  const blockedSticky = nextBubbleState(hidden, { status: 'blocked', text: '已受阻', badgeCount: 0 }, policy, clock.now());
  eq('blocked → 显示', blockedSticky.visible, true);
  eq('blocked 常驻（hideAt=null）', blockedSticky.hideAt, null);
  eq('blocked 常驻不过期', bubbleExpired(blockedSticky, clock.now() + 999_999), false);

  // 状态变化 → 重新计时（用 ready 这条仍然定时的状态来测）
  const afterSticky = nextBubbleState(sticky, { status: 'ready', text: '就绪（未读）', badgeCount: 0 }, policy, clock.now());
  eq('状态变化后换成新文案', afterSticky.text, '就绪（未读）');
  eq('状态变化后重新计时（6 秒）', afterSticky.hideAt, clock.now() + 6000);
}

// —— ⑨b `ready` 的到点收敛（ADR 021）——
// 这是本轮修掉的那条真缺陷：`ready` 是一个**通报**而不是求助，一次 Stop 事件就能让宠物
// 把那格姿态摆到 15 分钟静默兜底为止 —— 用户视角就是"我什么都没让它干，它却一直在炒菜"。
// 这条规则同样"肉眼看不出对错"（早 30 秒晚 30 秒都只表现为"它还摆着那副样子"），
// 所以钉在虚拟时钟上。
section('⑨b ready 的通报时效');
{
  const t = runtimeManifest.statusTimeouts;
  eq('策略来自宠物包：ready 通报 60 秒', t.readyMs, 60000);
  eq('策略来自宠物包：ready 比 needs-input 粘滞（5 分钟）短得多',
    t.readyMs < t.stickyMs, true);

  // —— ① 到点自动退场 ——
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'running' });
    eq('前置：running', arb.state.status, 'running');
    clock.advance(600);
    arb.ingest({ sessionId: 'a', status: 'ready' });
    eq('干完了 → ready', arb.state.status, 'ready');
    eq('动画是 waving → review（小厨师）', `${arb.state.animation.state}→${arb.state.animation.then}`, 'waving→review');

    clock.advance(59_000);
    eq('59 秒仍在 ready（用户还来得及看见）', arb.tick(), false);
    eq('59 秒时状态没变', arb.state.status, 'ready');

    clock.advance(2_000);          // 累计 61 秒
    eq('超过 60 秒 → 通报到期，输出变化', arb.tick(), true);
    eq('回落到 idle（宠物松手）', arb.state.status, 'idle');
    eq('角标也不再把这条算成活动会话', arb.state.badgeCount, 0);
  }

  // —— ② ready 期间的心跳不得把时效推后（与 needs-input 那条同源）——
  // 拿"每次心跳都刷新 ts"来实现保活的话，这条机制会在它最该生效的场景下失效。
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'ready' });
    eq('前置：ready', arb.state.status, 'ready');
    let pushed = 0;
    let expiredAt = null;
    for (let i = 1; i <= 10; i += 1) {
      clock.advance(10_000);       // 每 10 秒重报一次 ready（上游常见）
      const changed = arb.ingest({ sessionId: 'a', status: 'ready', ts: clock.now() });
      // 唯一允许的输出变化就是"到点退场"本身 —— 心跳不该刷出任何状态迁移。
      if (changed) {
        pushed += 1;
        expiredAt = i * 10_000;
        eq('唯一的输出变化只能是「到点退场」', arb.state.status, 'idle');
      }
    }
    eq('10 次心跳里只有一次输出变化（就是到点退场那次）', pushed, 1);
    // 这条是全部要害：**退场时刻必须仍是 t=0 起算的 60 秒，而不是最后一次心跳之后 60 秒**。
    eq('退场发生在第 60 秒（时效没被心跳推后）', expiredAt, 60_000);
    eq('累计 100 秒 → 已退场', arb.state.status, 'idle');
  }

  // —— ③ 时钟不前进也不该退场（"到期"必须真按时间算，不是按 tick 次数）——
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'ready' });
    for (let i = 0; i < 100; i += 1) arb.tick();   // 时间不动，tick 一百次
    eq('时间没走就不退场（判据是时刻而不是 tick 次数）', arb.state.status, 'ready');
  }

  // —— ④ 单击宠物（ack）立刻消解 ready ——
  // "点它一下"在两种状态下都是"我看到了"的意思。少了这条，用户点完之后
  // 宠物还要靠超时才肯放下那副姿态，观感就是"点了没用"。
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'ready' });
    eq('前置：ready', arb.state.status, 'ready');
    eq('单击宠物（ack）立刻改变输出', arb.ack(), true);
    eq('已读 → 回 idle，不用等 60 秒', arb.state.status, 'idle');
    // 关键反证：心跳不得把"已读"撤销（把计时删掉再靠 ts 判定就会这样）
    clock.advance(10_000);
    arb.ingest({ sessionId: 'a', status: 'ready', ts: clock.now() });
    eq('ack 之后的 ready 重报不会把它复活', arb.state.status, 'idle');
  }

  // —— ⑤ 会话自己转回 running 时，下一次 ready 重新起算（不是一次性的）——
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'ready' });
    clock.advance(61_000);
    arb.tick();
    eq('第一次通报到期', arb.state.status, 'idle');
    clock.advance(600);
    arb.ingest({ sessionId: 'a', status: 'running' });
    eq('又跑起来了', arb.state.status, 'running');
    clock.advance(600);
    arb.ingest({ sessionId: 'a', status: 'ready' });
    eq('第二次干完照样通报', arb.state.status, 'ready');
    clock.advance(61_000);
    arb.tick();
    eq('第二次通报也照样到期（机制可重复生效）', arb.state.status, 'idle');
  }

  // —— ⑥ 与 needs-input 共存：通报到期不该影响优先级更高的求助 ——
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'ready' });
    eq('前置：ready 压住别的', arb.state.status, 'ready');
    clock.advance(600);
    arb.ingest({ sessionId: 'b', status: 'ready' });
    eq('两条都 ready 时最近的那条为主', arb.state.sessionId, 'b');
    clock.advance(61_000);
    arb.tick();
    eq('两条都到期 → 全部回 idle（不是只退一条）', arb.state.status, 'idle');
  }

  // —— ⑦ 到期的通报从面板退场（ADR 024：退场必须走到视图，不能只改仲裁输出）——
  {
    const clock = makeClock();
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now, readyTimeoutMs: t.readyMs });
    arb.ingest({ sessionId: 'a', status: 'ready', title: '干完了' });
    let v = arb.viewSessions();
    eq('刚 ready 时未标记过期', v[0].expired, false);
    eq('原始状态如实暴露', v[0].status, 'ready');
    clock.advance(61_000);
    arb.tick();
    v = arb.viewSessions();
    // ADR 024：过期的通报**不再**留在面板上（此前它挂着不动、又不给「确认」按钮 = 没有出口）。
    // 记录本身保留（`snapshot()` 仍看得到），上游改口 running 时这一行会回来（见 ⑫b）。
    eq('到期后不再出现在面板上', v.length, 0);
    eq('原始记录仍保留（内核不替 UI 说谎，只是不展示）', arb.snapshot()[0].status, 'ready');
  }
}

// —— ⑩ 快捷键写法的归一化 —— **整段删除（ADR 032，2026-09-21）**：
// 全局快捷键功能被用户拍板移除（不用、且从未被真实按过一次），`src/host/hotkey.ts` 一并删除。
// 那段 7 条断言测的是 `normalizeAccelerator()` —— 随被测代码一起消失，不是"被跳过的测试"。
// 编号留空不重排：后面 ⑪–⑯ 共 9 节的编号一旦改动，只会让历史日志与这里的引用对不上。

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

  // —— 唤出 / 收起：两条唤出路径（右键宠物 / 托盘菜单「控制条」）共用 toggle ——
  // （第三条「全局快捷键」已于 ADR 032 删除；状态机本身不变，仍是一个 toggle 事件。）
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

  // —— ⑪b 走路时收起面板、走完还回去（ADR 039）——
  // 这是本项目唯一一处"面板会自己出现"的规则，所以必须钉死它**只有**一种触发源：
  // 用户自己点了「左走/右走」。任何被动原因都不许让它冒出来（ADR 016 的学费）。
  {
    const shown = ev({ ...BAR_HIDDEN }, { kind: 'toggle' });
    eq('前置：面板可见', shown.visible, true);

    // ① 走路开始：收起并记下欠账
    const walking = ev(shown, { kind: 'walk-hide' });
    eq('走路开始 → 面板收起', walking.visible, false);
    eq('走路开始 → 记下"待恢复"', walking.restoreAfterWalk, true);
    eq('收起时不留收起计划', walking.hideAt, null);
    eq('收起时放弃焦点记账', walking.hasFocus, false);
    // 走路期间时间推进不会把它弄回来（它本来就不可见）
    eq('走路期间 tick 不会让它冒出来', tickBarState(walking, clock.now() + 600_000).visible, false);
    eq('走路期间 tick 也不会把欠账清掉', tickBarState(walking, clock.now() + 600_000).restoreAfterWalk, true);

    // ② 走路结束：还回去，欠账结清
    const back = ev(walking, { kind: 'walk-restore' });
    eq('走路结束 → 面板回来', back.visible, true);
    eq('欠账结清', back.restoreAfterWalk, false);

    // ③ **没有欠账时 `walk-restore` 什么都不做** —— 这是"绝不自作主张显示"的落点
    const noDebt = ev({ ...BAR_HIDDEN }, { kind: 'walk-restore' });
    eq('没有欠账 ⇒ 面板不会凭空出现', noDebt.visible, false);
    // 传同一个对象进去，断言它被**原样返回**（不造新对象 = 这条路径零副作用）
    const hidden = { ...BAR_HIDDEN };
    eq('没有欠账 ⇒ 状态原样返回（连新对象都不造）', ev(hidden, { kind: 'walk-restore' }), hidden);

    // ④ 面板本来就没显示时 `walk-hide` 不该产生欠账（否则走完会凭空冒出一个面板）
    const hideWhenHidden = ev({ ...BAR_HIDDEN }, { kind: 'walk-hide' });
    eq('面板本来就不可见 ⇒ 不产生欠账', hideWhenHidden.restoreAfterWalk, false);
    eq('面板本来就不可见 ⇒ 走完也不会冒出来',
      ev(hideWhenHidden, { kind: 'walk-restore' }).visible, false);

    // ⑤ **不变量②：面板一可见，欠账即作废** —— 用户已经自己把它叫回来了
    const userReopened = ev(walking, { kind: 'toggle' });
    eq('用户自己唤回面板', userReopened.visible, true);
    eq('用户唤回 ⇒ 欠账作废', userReopened.restoreAfterWalk, false);
    eq('于是走完不会再自作主张开一次',
      ev(userReopened, { kind: 'walk-restore' }).visible, true);
    // 用户显式收起同理作废：他刚把面板关掉，走完再自动开一次就是"它自己冒出来"
    const userClosed = ev(ev(walking, { kind: 'toggle' }), { kind: 'request-close' });
    eq('用户显式关掉 ⇒ 欠账作废', userClosed.restoreAfterWalk, false);
    eq('于是走完不会自己冒出来', ev(userClosed, { kind: 'walk-restore' }).visible, false);
    // 宠物被隐藏同理（宠物不在了，面板锚在半空没有意义）
    const petGone = ev(walking, { kind: 'pet-hidden' });
    eq('宠物被隐藏 ⇒ 欠账作废', petGone.restoreAfterWalk, false);
    eq('于是走完不会把面板开在半空', ev(petGone, { kind: 'walk-restore' }).visible, false);

    // ⑥ 走路期间的失焦事件不得把欠账弄丢（收起窗口本身会触发一次 blur）
    const blurDuringWalk = ev(walking, { kind: 'focus', hasFocus: false });
    eq('走路期间的失焦不改变可见性', blurDuringWalk.visible, false);
    eq('走路期间的失焦不丢欠账', blurDuringWalk.restoreAfterWalk, true);
    eq('走完照样能还回去', ev(blurDuringWalk, { kind: 'walk-restore' }).visible, true);
  }

  // —— 结构性：这两条不许悄悄回退 ——
  {
    const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
    check('走路收起只在"真的会移动窗口"时触发（原地降级不收面板）',
      mainSrc.includes("if (res.play.targetX !== null) dispatchBar({ kind: 'walk-hide' })"));
    check('走路结束会把面板还回去',
      mainSrc.includes("if (targetX !== null) dispatchBar({ kind: 'walk-restore' })"));
    // 宠物名必须只有一处来源：面板身份位 / 托盘悬停提示 / 渲染层 init 各写一份，
    // 就会出现"面板写淘淘、托盘写 desktop-pet"这种同一个人两个名字（2026-09-22 用户报的）
    check('宠物名只有一处定义',
      mainSrc.includes('const petName = pack.manifest.displayName ?? pack.manifest.id;'));
    check('没有第二处各写一遍宠物名',
      !/petName:\s*pack\.manifest\.displayName/.test(mainSrc)
      && !/displayName:\s*pack\.manifest\.displayName/.test(mainSrc));

    const traySrc = stripComments(readFileSync(join(root, 'src/host/tray.ts'), 'utf8'));
    check('托盘悬停提示不再写死 desktop-pet（那是产品/进程名）',
      !traySrc.includes('desktop-pet'));
    check('托盘悬停提示取自宠物包的名字', traySrc.includes('view.petName'));

    // 宠物**窗口标题**必须保持 desktop-pet —— 所有探针都靠 `getTitle()` 找窗口，
    // 改了它会让整套回归静默失效（找不到窗口 ⇒ 报"未等到桌宠窗口"）。
    const petHtml = readFileSync(join(root, 'src/renderer/index.html'), 'utf8');
    check('宠物窗口标题仍是 desktop-pet（探针靠它找窗口，别顺手改）',
      /<title>desktop-pet<\/title>/.test(petHtml));
  }
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

// —— ⑫b 过期的 `ready` 通报不再占面板（挂起清单 #14，ADR 024）——
// 成因：`ready` 的 60 秒通报时效只改了**仲裁输出**（宠物回待机），没改**面板视图**，
// 于是留下一行常驻的「（已过期）」。它 `isAckable` 为 false ⇒ 没有「确认」按钮 ⇒
// 用户**没有任何手段**消掉它，只能等上游 15 分钟不心跳（而生产里上游每 15–60 秒重报一次，
// 重报刷新 `ts` ⇒ 静默兜底永远不触发）⇒ 这一行事实上永久驻留，还会撑高面板。
// 修法：视图过滤。**不删记录** —— 上游改口 running 时这一行要能回来。
section('⑫b 过期的 ready 通报不再占面板（ADR 024）');
{
  const clock = makeClock();
  const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: () => clock.now() });
  arb.ingest({ sessionId: 'wb:1', status: 'running' });
  arb.ingest({ sessionId: 'wb:1', status: 'ready', title: '干完了' });
  eq('前置：面板列出这一行', arb.viewSessions().length, 1);

  clock.advance(61_000);
  arb.tick();
  eq('通报到点：主状态回 idle（本就正确）', arb.state.status, 'idle');
  eq('通报到点：面板不再列出这一行（本次修的就是这条）', arb.viewSessions().length, 0);
  eq('记录本身仍在（只是不展示）', arb.snapshot().length, 1);

  // 反向用例（防误杀）：过滤不能变成"这条会话被遗忘"。
  arb.ingest({ sessionId: 'wb:1', status: 'running' });
  clock.advance(600);                       // 跨过 500ms 变化限流窗格（判据纪律）
  arb.tick();                               // 窗格由 tick 应用 —— 只推进时钟不会切主状态
  eq('上游改口 running ⇒ 面板重新列出这一行', arb.viewSessions().length, 1);
  eq('主状态跟着回 running（没被"已过期"误杀）', arb.state.status, 'running');
  eq('这一行不再标"已过期"', arb.viewSessions()[0].expired, false);

  // 其余状态不受影响：过滤范围必须窄（只针对 ready）。
  arb.ingest({ sessionId: 'wb:2', status: 'idle' });
  arb.ingest({ sessionId: 'wb:3', status: 'blocked' });
  clock.advance(61_000);                    // 只跨过通报时效，别跨到 15 分钟静默兜底
  arb.tick();
  eq('idle 与 blocked 不受这条过滤影响（仍在面板上）', arb.viewSessions().length, 3);

  // 已确认的 `needs-input` 行仍然显示（用户刚确认过，看到它是合理反馈，不算死行）。
  const clock2 = makeClock();
  const arb2 = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: () => clock2.now() });
  arb2.ingest({ sessionId: 'wb:x', status: 'needs-input' });
  arb2.ack('wb:x');
  eq('已确认的 needs-input 仍出现在面板上（带「已确认」标签）', arb2.viewSessions().length, 1);
  eq('它确实被标为已确认', arb2.viewSessions()[0].acknowledged, true);
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

// —— ⑭ 行为层：漫游 / 微动作 / 打盹（纯函数 + 虚拟时钟 + 固定随机种子）——
// 这四条规则全是"到点才发生"的：25 秒还是 28 秒后开始走、走到边界是停还是掉头、
// 用户抓住它时该不该动 —— 在屏幕上**完全看不出对错**（早几秒晚几秒都只是"它在走"）。
// 所以策略必须钉在这里；真实窗口那一半（窗口真的动了、拖动时真的停）在 spikes/m3-behavior。
section('⑭ 行为层策略');
{
  const { parseBehaviorPolicy, tickBehavior, BEHAVIOR_IDLE, roamSpeedPxPerSec } =
    require(join(root, 'dist/kernel/behavior.js'));

  const stateTable = {};
  for (const [id, s] of Object.entries(runtimeManifest.states)) {
    stateTable[id] = { frames: s.frames, fps: s.fps, role: s.role };
  }
  const warnings = [];
  const policy = parseBehaviorPolicy(
    runtimeManifest.behavior, { states: stateTable, scale: runtimeManifest.render.defaultScale },
    (m) => warnings.push(m),
  );
  eq('策略来自宠物包：漫游间隔 25–90 秒（字段是毫秒）',
    `${policy.roamEveryMs.min}-${policy.roamEveryMs.max}`, '25000-90000');
  eq('策略来自宠物包：一次走 80–320px', `${policy.roamDistancePx.min}-${policy.roamDistancePx.max}`, '80-320');
  eq('策略来自宠物包：速度 96px/s（默认缩放下）', policy.speedPxPerSec, 96);
  eq('策略来自宠物包：打盹 300 秒后落 failed', `${policy.sleepAfterMs}-${policy.sleepState}`, '300000-failed');
  eq('微动作候选两个都在包里', policy.microCandidates.join('/'), 'waving/jumping');
  eq('策略来自宠物包：踱步 60–180 秒一次',
    `${policy.paceEveryMs.min}-${policy.paceEveryMs.max}`, '60000-180000');
  eq('策略来自宠物包：踱步一次 60–300px（= 最多离开锚点 300px）',
    `${policy.paceDistancePx.min}-${policy.paceDistancePx.max}`, '60-300');
  check('踱步距离上限在"三四百像素"以内（用户要求，ADR 019）',
    policy.paceDistancePx.max <= 400, `${policy.paceDistancePx.max}px`);
  eq('踱步默认与漫游同速（位移速度是照着位移行的步频校过的）',
    policy.paceSpeedPxPerSec, policy.speedPxPerSec);
  // 位移姿态按 role 推导，不硬编码 running-left/right —— 换宠物包也能对上
  eq('位移姿态从 role 推导（左）', policy.locomotion?.left, 'running-left');
  eq('位移姿态从 role 推导（右）', policy.locomotion?.right, 'running-right');
  eq('一次性动作的时长由 frames/fps 算出（waving 4 帧 @8fps = 500ms）', policy.clipMs.waving, 500);
  eq('parse 时没有告警', warnings.length, 0);
  // 缺位移行 ⇒ 不漫游（而不是硬编码一个不存在的状态名）
  const noLoco = parseBehaviorPolicy(runtimeManifest.behavior, {
    states: { idle: { frames: 6, fps: 8 } }, scale: 0.7,
  }, () => {});
  eq('包里没有位移姿态时不漫游', noLoco.locomotion, null);

  // —— 模拟窗口：每 33ms 一 tick，并把 moveX 真的应用到"窗口"上（真实系统里那一步由宿主做）——
  const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
  const W = 134, H = 146;
  const clock = makeClock(1_000_000);
  const rng = makeRng(20260917);

  const simulate = (st0, totalMs, opt = {}) => {
    const p = opt.policy ?? policy;
    let st = st0;
    let x = opt.startX ?? 600;
    const trail = [];
    const plays = [];
    const n = Math.max(1, Math.ceil(totalMs / 33));
    for (let i = 0; i < n; i += 1) {
      clock.advance(33);
      const r = tickBehavior(st, {
        now: clock.now(), pet: { x, y: 800, width: W, height: H },
        workArea: opt.workArea ?? AREA,
        scale: opt.scale ?? 0.7, status: opt.status ?? 'idle',
        suppressed: opt.suppressed ?? false, reducedMotion: opt.reducedMotion ?? false,
      }, p, rng);
      st = r.state;
      if (r.command.moveX !== null && r.command.moveX !== x) {
        x = r.command.moveX;
        trail.push(x);
      }
      if (r.command.play !== undefined) plays.push({ at: i + 1, play: r.command.play });
    }
    return { state: st, x, trail, plays };
  };
  /** 造一个"现在就该动"的状态：抹掉排程与打盹计时，把两项计时都定在当前时刻。 */
  const dueNow = (over = {}) => ({
    ...BEHAVIOR_IDLE,
    idleSinceAt: clock.now(),
    nextRoamAt: clock.now(),
    nextActionAt: clock.now() + 10 * 60_000,   // 微动作排到很后面，专测漫游
    lastStepAt: clock.now(),
    ...over,
  });

  // —— ① 启动后不会立刻乱跑：先排程，什么都不做 ——
  {
    const t0 = clock.now();
    const r = simulate(BEHAVIOR_IDLE, 990);
    eq('开工 1 秒内一动不动', r.trail.length, 0);
    eq('也不改动画（交回仲裁器）', r.plays.length, 0);
    const roamsIn = (r.state.nextRoamAt ?? 0) - t0;
    check('首次漫游排在 25–90 秒之后', roamsIn >= 25_000 && roamsIn <= 90_000, `${Math.round(roamsIn / 1000)}s`);
  }

  // —— ② 到点开始走：播位移姿态、按朝向；到位后停下并重排程 ——
  {
    const r = simulate(dueNow({ phase: 'idle' }), 5000);
    const first = r.plays[0];
    check('开始漫游时下发一个位移姿态（循环）',
      !!first && first.play?.loop === true && /^running-(left|right)$/.test(first.play.state),
      JSON.stringify(first));
    check('确实在移动', r.trail.length > 10, `${r.trail.length} 次`);
    const dir = Math.sign(r.x - 600);
    eq('朝向与移动方向一致', r.state.facing, dir > 0 ? 'right' : 'left');
    eq('位移姿态与朝向一致',
      first?.play?.state, dir > 0 ? 'running-right' : 'running-left');
  }

  // —— ③ 速度按缩放线性归一化（锁定决策：96px/s @ 默认缩放 0.7）——
  // 目标点必须**足够远**，否则宠物中途就到了 —— 量到的是"走了多远"而不是"走多快"
  // （第一版就是这样：1.4 缩放那组因为在 1 秒内到达目标，只走了 145px，假红一次）。
  {
    eq('缩放 1.4 时速度翻倍', roamSpeedPxPerSec(policy, 1.4), 192);
    const far = { ...policy, roamDistancePx: { min: 900, max: 900 } };
    const a = simulate(dueNow(), 1000, { policy: far });
    const moved07 = Math.abs(a.x - 600);
    check('0.7 缩放下 1 秒走约 96px', moved07 >= 88 && moved07 <= 104, `实测 ${moved07}px`);
    clock.advance(1000);   // 隔开一点，别让两段共用同一个"到点"时刻
    const b = simulate(dueNow(), 1000, { policy: far, scale: 1.4 });
    const moved14 = Math.abs(b.x - 600);
    check('1.4 缩放下 1 秒走约 192px（观感一致）', moved14 >= 176 && moved14 <= 208, `实测 ${moved14}px`);
  }

  // —— ④ 边界：贴在右边缘时只能往左走（edgePolicy 的"停止并翻转朝向"）——
  {
    const rightEdge = AREA.x + AREA.width - W;
    const r = simulate(dueNow(), 1200, { startX: rightEdge });
    check('贴右边缘时不会往右走（也不会停在原地不动）',
      r.trail.length > 0 && r.x < rightEdge, `x=${r.x}（右边缘 ${rightEdge}）`);
    eq('朝向翻到左', r.state.facing, 'left');
    // 目标一定夹在工作区内
    check('漫游目标夹进工作区', (r.state.targetX ?? 0) >= AREA.x && (r.state.targetX ?? 0) <= rightEdge,
      String(r.state.targetX));
  }

  // —— ⑤ 用户抓着宠物时绝不自己动（这条是"抢方向盘"的唯一防线）——
  {
    const st = dueNow();
    const r1 = simulate(st, 300);
    const roaming = r1.state.phase === 'roaming';
    eq('前置：已经在漫游', roaming, true);
    const r2 = simulate(r1.state, 2000, { suppressed: true });
    eq('抑制期间一次都不动', r2.trail.length, 0);
    eq('抑制期间也不下发新的动画覆盖（只在第一次交回）',
      r2.plays.filter((p) => p.play === null).length, 1);
    eq('排程里的目标保留着（松手接着走）', r2.state.targetX !== null, true);
    const r3 = simulate(r2.state, 600);
    check('松手后接着走', r3.trail.length > 0, `${r3.trail.length} 次`);
  }

  // —— ⑥ 有任务在跑时不漫游：交回业务动画，改走"踱步模式" ——
  {
    // 前置：先真的走起来（这样"交回动画"才有东西可交）
    const walk = simulate(dueNow(), 300);
    eq('前置：已经在漫游', walk.state.phase, 'roaming');
    const r = simulate(walk.state, 1000, { status: 'running', startX: walk.x });
    eq('running 期间不漫游（踱步还没到点）', r.trail.length, 0);
    eq('running 期间交回动画（一次）', r.plays.length, 1);
    eq('交回的是 null', r.plays[0]?.play, null);
    eq('清掉打盹计时（有任务时不打盹）', r.state.idleSinceAt, null);
    eq('漫游目标也清掉（回到空闲时重新挑）', r.state.targetX, null);
    eq('切进踱步模式的瞬间锚在当前位置', r.state.anchorX, walk.x);
  }

  // —— ⑥b 任务中踱步（ADR 019）：低频、短距离、锚在进入任务状态时的位置附近 ——
  // 这一组量的是"用户看不到对错"的三件事：它到底走了多远、会不会越踱越远、频率有多低。
  {
    const fast = {
      ...policy,
      paceEveryMs: { min: 200, max: 200 },
      paceDistancePx: { min: 40, max: 200 },
    };
    const st = { ...BEHAVIOR_IDLE, lastStepAt: clock.now() };
    const r = simulate(st, 2000, { policy: fast, status: 'running' });
    eq('锚点 = 进入任务状态时的位置', r.state.anchorX, 600);
    check('到点后确实在走', r.trail.length > 5, `${r.trail.length} 次`);
    check('踱一步不超过配置上限（200px）', Math.abs(r.x - 600) <= 200, `实测 ${Math.abs(r.x - 600)}px`);
    check('朝工作区中心侧走（宠物在 600，落在左半屏 ⇒ 向右）', r.x >= 600, `x=${r.x}`);
    const moving = r.plays.find((p) => p.play && p.play.loop === true);
    check('踱步时画的是位移行（第 1/2 行）',
      !!moving && /^running-(left|right)$/.test(moving.play.state), JSON.stringify(moving));

    // **反复踱步不会越踱越远**：目标由锚点算、不由当前位置算（按当前位置累加会漂出去几百像素，
    // 而且屏幕上只表现为"它怎么跑那么远"，没有任何报错）。
    const many = simulate(r.state, 20_000, { policy: fast, status: 'running', startX: r.x });
    check('踱几十次之后仍在锚点 200px 以内（无累积漂移）',
      Math.abs(many.x - 600) <= 200, `实测 ${Math.abs(many.x - 600)}px`);
    eq('锚点始终没被踱步改掉', many.state.anchorX, 600);

    // 频率：默认节奏（60–180 秒）下 10 秒内一次都不该踱 —— 它是点缀，不是主要活动方式
    const slow = simulate({ ...BEHAVIOR_IDLE, lastStepAt: clock.now() }, 10_000, { status: 'running' });
    eq('默认节奏下 10 秒内一次都不踱', slow.trail.length, 0);

    // 「减少动态效果」：不位移（与空闲漫游同一对待）
    const rm = simulate({ ...BEHAVIOR_IDLE, lastStepAt: clock.now() }, 5000, {
      policy: fast, status: 'running', reducedMotion: true,
    });
    eq('「减少动态效果」下不踱步', rm.trail.length, 0);

    // 抑制：拖动/隐藏/全屏/控制条期间一步不动，且**清掉锚点**（恢复后在新位置重新锚定）
    const sup = simulate({ ...BEHAVIOR_IDLE, lastStepAt: clock.now() }, 2000, {
      policy: fast, status: 'running', suppressed: true,
    });
    eq('抑制期间一步不动', sup.trail.length, 0);
    eq('抑制期间清掉锚点（恢复后重新锚定）', sup.state.busySinceAt, null);

    // 关掉踱步：一次都不动，但仍然把已有的覆盖交回业务动画
    // （注意"交回"只在真有覆盖可交时才发 —— 本来就是干净状态时不该多发一条空命令）
    const off = { ...fast, paceEnabled: false };
    const offR = simulate({
      ...BEHAVIOR_IDLE, lastStepAt: clock.now(), sentPlay: { state: 'running-right', loop: true },
    }, 3000, { policy: off, status: 'running' });
    eq('busyPace.enabled=false 时一步不动', offR.trail.length, 0);
    eq('把已有覆盖交回业务状态（只发一次）', offR.plays.length, 1);
    eq('交回的是 null', offR.plays[0]?.play, null);

    // 回到空闲：清记账、重新排程（不会立刻乱跑），并且交回那条位移覆盖
    const pacing = {
      ...many.state, phase: 'pacing', targetX: many.x + 100,
      sentPlay: { state: 'running-right', loop: true },
    };
    const idled = simulate(pacing, 66, { policy: fast, status: 'idle', startX: many.x });
    eq('回到空闲后清掉踱步记账',
      `${idled.state.busySinceAt}-${idled.state.anchorX}-${idled.state.nextPaceAt}`, 'null-null-null');
    eq('丢掉踱步相（不会带着 pacing 停在半路）', idled.state.phase !== 'pacing', true);
    eq('回到空闲后重新开始打盹计时', idled.state.idleSinceAt !== null, true);
    eq('回到空闲时交回业务动画', idled.plays[0]?.play, null);
    const idleAfter = simulate(idled.state, 3000, { policy: fast, status: 'idle', startX: idled.x });
    eq('回到空闲后不会立刻乱跑（漫游仍要等 25–90 秒）', idleAfter.trail.length, 0);
  }

  // —— ⑥c 不跨屏（ADR 019 锁定）：工作区换成"另一块屏"时，目标点夹在新工作区内 ——
  // 落地机制：锚点每次（重）锚定都取当前位置 —— 把宠物拖到哪块屏，它就在哪块屏活动。
  {
    const second = { x: 1920, y: 0, width: 1280, height: 1024 };
    const fast = { ...policy, paceEveryMs: { min: 100, max: 100 }, paceDistancePx: { min: 200, max: 200 } };
    const r = simulate({ ...BEHAVIOR_IDLE, lastStepAt: clock.now() }, 1500, {
      policy: fast, status: 'running', workArea: second, startX: 3010,
    });
    check('踱步目标夹在"宠物所在那块屏"内',
      r.x >= second.x && r.x + W <= second.x + second.width, `x=${r.x}`);
    eq('锚点留在第二块屏上（没被拉回第一块屏）', r.state.anchorX >= second.x, true);
    check('朝第二块屏的中心侧走（3010 在其右半边 ⇒ 向左）', r.x <= 3010, `x=${r.x}`);

    const roamOther = simulate(dueNow(), 1200, {
      policy, workArea: second, startX: second.x + second.width - W,
    });
    check('漫游目标同样夹在宠物所在的那块屏',
      roamOther.x >= second.x && roamOther.x + W <= second.x + second.width, `x=${roamOther.x}`);
  }

  // —— ⑦ 打盹：空闲够久 → 播 sleepState；状态一变就醒；醒来重新计时 ——
  {
    const asleep = { ...BEHAVIOR_IDLE, idleSinceAt: clock.now() - 300_001, lastStepAt: clock.now() };
    const r = simulate(asleep, 66);
    eq('空闲超过 300 秒 → 播 sleepState（循环）', r.plays[0]?.play?.state, 'failed');
    eq('sleepState 是循环姿态', r.plays[0]?.play?.loop, true);
    eq('不会每 tick 重复下发', r.plays.length, 1);
    eq('相 = sleeping', r.state.phase, 'sleeping');
    const woke = simulate(r.state, 66, { status: 'needs-input' });
    eq('主状态一变就醒来（交回仲裁器）', woke.plays[0]?.play, null);
    eq('醒来后清掉打盹相', woke.state.phase, 'idle');
    const after = simulate(woke.state, 660);
    eq('醒来后重新计时（不会立刻又睡着）', after.state.phase !== 'sleeping', true);

    // 漫游/微动作**不得**重置打盹计时 —— 否则"每 25–90 秒走一次"会把 5 分钟的计时无限推后，
    // 表现为"它永远不打盹"，而且屏幕上没有任何报错可循（ADR 018 记了这个坑）。
    const nearlyAsleep = {
      ...BEHAVIOR_IDLE, idleSinceAt: clock.now() - 299_000,
      nextRoamAt: clock.now(), nextActionAt: clock.now() + 600_000, lastStepAt: clock.now(),
    };
    const roaming = simulate(nearlyAsleep, 1000);
    eq('前置：先走起来', roaming.state.phase, 'roaming');
    const napped = simulate(roaming.state, 6000);
    eq('走完这一程就打盹（计时没被漫游重置）', napped.state.phase, 'sleeping');
  }

  // —— ⑧ 微动作：到点播一个候选（一次性），播完交回仲裁器 ——
  {
    const fast = { ...policy, roamEnabled: false, microEveryMs: { min: 100, max: 100 } };
    const r = simulate({ ...BEHAVIOR_IDLE, lastStepAt: clock.now() }, 1200, { policy: fast });
    const act = r.plays.find((p) => p.play && p.play.loop === false);
    check('到点播一个候选（一次性）',
      !!act && ['waving', 'jumping'].includes(act.play.state), JSON.stringify(r.plays));
    const backIdx = r.plays.findIndex((p, i) => p.play === null && i > 0);
    check('播完把动画交回仲裁器', backIdx >= 0, JSON.stringify(r.plays.map((p) => p.play?.state ?? null)));
    eq('微动作期间不移动', r.trail.length, 0);
  }

  // —— ⑨ 「减少动态效果」：不漫游、不做微动作，但打盹（静态姿态）仍然允许 ——
  {
    const r = simulate(dueNow(), 1200, { reducedMotion: true });
    eq('减少动态效果下不漫游', r.trail.length, 0);
    eq('也不做微动作', r.plays.filter((p) => p.play && p.play.loop === false).length, 0);
    const asleep = { ...BEHAVIOR_IDLE, idleSinceAt: clock.now() - 300_001, lastStepAt: clock.now() };
    const s = simulate(asleep, 66, { reducedMotion: true });
    eq('但打盹照常（它只是换一个静止姿态）', s.plays[0]?.play?.state, 'failed');
  }

  // —— ⑩ 交回仲裁器是**边沿**：只发一次，不会每 tick 重发 ——
  {
    const r = simulate({ ...BEHAVIOR_IDLE, lastStepAt: clock.now(), sentPlay: { state: 'running-left', loop: true } }, 100);
    eq('第一条是交回', r.plays[0]?.play, null);
    eq('之后不再重发', r.plays.length, 1);
  }

  // —— ⑪ 总开关：behavior.enabled=false 时彻底安静 ——
  {
    const off = parseBehaviorPolicy({ ...runtimeManifest.behavior, enabled: false }, {
      states: stateTable, scale: 0.7,
    }, () => {});
    const r = simulate(dueNow(), 1200, { policy: off });
    eq('总开关关掉后不动', r.trail.length, 0);
    eq('总开关关掉后不播任何覆盖', r.plays.length, 0);
  }
}

// —— ⑮ 双通道互斥：运行期告警（ADR 020 的约束第一次在代码里有落点）——
// ADR 020 规定"一个 agent 只由一条通道负责"，但此前**只写在文档里** —— 同一个 agent
// 被 hook 与被动文件源同时盯着时，状态在两条通道之间来回跳且没有任何报错，
// 用户只能看到"点了宠物它又举手"（2026-09-18 的真实缺陷）。
// 这里只钉**告警**（不逐出：该信谁是产品决策），四条边界各一条断言。
section('⑮ 双通道冲突告警（只告警，不改状态）');
{
  const CONFLICT = '双通道冲突';
  const boot = () => {
    const clock = makeClock(5_000_000);
    const logs = [];
    const arb = new StatusArbiter({
      statusMap: runtimeManifest.statusMap, now: clock.now, log: (m) => logs.push(m),
    });
    return { clock, logs, arb, conflicts: () => logs.filter((l) => l.includes(CONFLICT)).length };
  };

  // ① 同一会话 10 秒内被两个不同 origin 上报 ⇒ 告警（这就是"被两条通道同时盯"）
  {
    const { clock, arb, conflicts } = boot();
    arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'file' });
    clock.advance(1_000);
    arb.ingest({ sessionId: 'wb:1', status: 'needs-input', origin: 'hook' });
    eq('同一会话 10 秒内换通道 ⇒ 告警', conflicts(), 1);
  }

  // ② 同一通道反复上报 ⇒ 不告警（正常心跳）
  {
    const { clock, arb, conflicts } = boot();
    for (let i = 0; i < 5; i++) {
      arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'file' });
      clock.advance(1_000);
    }
    eq('同一通道反复上报 ⇒ 不告警', conflicts(), 0);
  }

  // ③ 隔了很久才换通道 = 换了一次挂载方式（例如卸载 hook 后改用被动源），不是"同时被盯"
  {
    const { clock, arb, conflicts } = boot();
    arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'hook' });
    clock.advance(120_000);
    arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'file' });
    eq('隔 2 分钟才换通道 ⇒ 不告警（是换挂载，不是同时被盯）', conflicts(), 0);
  }

  // ④ 两个**不同**会话走不同通道 ⇒ 不告警（多 agent 并存是设计内的形状）
  {
    const { clock, arb, conflicts } = boot();
    arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'hook' });
    clock.advance(1_000);
    arb.ingest({ sessionId: 'proma:9', status: 'blocked', origin: 'file' });
    eq('两个不同会话各走一条通道 ⇒ 不告警', conflicts(), 0);
  }

  // ⑤ 冷却：一旦成立就是每次轮询都打一次，不冷却会把真正的状态变化从日志里淹没
  {
    const { clock, arb, conflicts } = boot();
    const origins = ['file', 'hook', 'file', 'hook', 'file', 'hook'];
    for (const o of origins) {
      arb.ingest({ sessionId: 'wb:1', status: 'running', origin: o });
      clock.advance(1_000);
    }
    eq('60 秒内反复交替只告警一次（有冷却）', conflicts(), 1);
    clock.advance(61_000);
    arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'file' });
    arb.ingest({ sessionId: 'wb:1', status: 'running', origin: 'hook' });
    eq('冷却过后再次冲突会重新告警', conflicts(), 2);
  }

  // ⑥ 没标来源的事件不参与判断（人工喂状态没有通道概念）
  {
    const { clock, arb, conflicts } = boot();
    arb.ingest({ sessionId: 'default', status: 'running' });
    clock.advance(1_000);
    arb.ingest({ sessionId: 'default', status: 'needs-input', origin: 'hook' });
    eq('无来源的事件不参与双通道判断', conflicts(), 0);
  }
}

// —— ⑮c 双通道**逐出**：hook 优先于被动源（ADR 027，此前只告警不处置）——
// 要钉住的核心命题：**按通道优先级，不按到达顺序**。
// 否决"后到者胜"是因为那正是状态来回刷的机制本身；否决"先到者锁定"是因为桌宠启动时
// 往往先读到快照（被动源），会把 hook 永久锁在外面 —— 与"被动源是降级来源"正好相反。
section('⑮c 双通道逐出（hook 优先，不按到达顺序）');
{
  const make = (dominance) => {
    const clock = makeClock(1_000_000);
    const logs = [];
    const arb = new StatusArbiter({
      statusMap: runtimeManifest.statusMap,
      now: clock.now,
      dominance,
      log: (m) => logs.push(m),
    });
    return { clock, arb, logs };
  };

  // ① hook 主导后，被动源的上报被丢弃（这才是"逐出"，此前只打告警）
  {
    const { clock, arb, logs } = make({ enabled: true, holdMs: 600_000 });
    arb.ingest({ sessionId: 's', status: 'running', origin: 'hook' });
    eq('前置：hook 主导下宠物在跑', arb.state.status, 'running');
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'idle', origin: 'file' });
    eq('被动源的「干完了」被丢弃（宠物不会被打回 idle）', arb.state.status, 'running');
    eq('丢弃留了日志（可诊断，不是静默消失）', logs.some((m) => m.includes('丢弃')), true);
  }

  // ② 反向：被动源先到，hook 随后**接管**（优先级更高，不是先到者锁定）
  {
    const { clock, arb } = make({ enabled: true, holdMs: 600_000 });
    arb.ingest({ sessionId: 's', status: 'idle', origin: 'file' });
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'running', origin: 'hook' });
    eq('hook 随后到达即接管（不会被被动源锁在门外）', arb.state.status, 'running');
  }

  // ③ 主导通道沉默超时后释放 —— 安全底线：hook 卸载/崩溃时被动源必须能接管
  {
    const { clock, arb } = make({ enabled: true, holdMs: 30_000 });
    arb.ingest({ sessionId: 's', status: 'running', origin: 'hook' });
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'idle', origin: 'file' });
    eq('未到 holdMs：被动源仍被丢弃', arb.state.status, 'running');
    clock.advance(31_000);
    arb.ingest({ sessionId: 's', status: 'idle', origin: 'file' });
    eq('超过 holdMs：被动源接管生效（宠物不会永久失明）', arb.state.status, 'idle');
  }

  // ④ 不同会话各管各的
  {
    const { clock, arb } = make({ enabled: true, holdMs: 600_000 });
    arb.ingest({ sessionId: 'a', status: 'running', origin: 'hook' });
    clock.advance(600);
    arb.ingest({ sessionId: 'b', status: 'blocked', origin: 'file' });
    eq('b 走被动源不受 a 的 hook 影响', arb.state.status, 'blocked');
  }

  // ⑤ 开关关掉 ⇒ 退回"只告警不逐出"的旧行为
  {
    const { clock, arb } = make({ enabled: false });
    arb.ingest({ sessionId: 's', status: 'running', origin: 'hook' });
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'blocked', origin: 'file' });
    eq('enabled=false：被动源照样生效（退回旧行为）', arb.state.status, 'blocked');
  }

  // ⑥ 没有通道标签的上报（人工喂状态）永远放行，且不改变主导通道
  {
    const { clock, arb } = make({ enabled: true, holdMs: 600_000 });
    arb.ingest({ sessionId: 's', status: 'running', origin: 'hook' });
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'blocked' });          // 人工喂，无 origin
    eq('人工喂状态不被逐出（否则手动干预会静默失效）', arb.state.status, 'blocked');
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'idle', origin: 'file' });
    eq('但人工喂状态不改变主导通道：hook 仍然把被动源挡在外面', arb.state.status, 'blocked');
  }

  // ⑦ 被丢弃的上报**不许**碰任何记账 —— 否则等于没逐出
  {
    const { clock, arb } = make({ enabled: true, holdMs: 600_000 });
    // hook 报 ready（开始通报计时），随后被动源谎报 running
    arb.ingest({ sessionId: 's', status: 'ready', origin: 'hook' });
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'running', origin: 'file' });   // 应被丢弃
    eq('被丢弃的上报不会顶掉 hook 的 ready', arb.state.status, 'ready');
    arb.ingest({ sessionId: 's', status: 'ready', origin: 'hook' });
    clock.advance(61_000);
    arb.tick();
    eq('ready 的通报时效照常到期（丢弃者没干扰它的计时）', arb.state.status, 'idle');
  }

  // ⑧ 真实现场：hook 的 needs-input 被确认后，被动源重报**不该**复活它
  {
    const { clock, arb } = make({ enabled: true, holdMs: 600_000 });
    arb.ingest({ sessionId: 's', status: 'needs-input', origin: 'hook' });
    eq('前置：举手', arb.state.status, 'needs-input');
    arb.ack();
    eq('用户确认后松手', arb.state.status, 'idle');
    clock.advance(600);
    arb.ingest({ sessionId: 's', status: 'needs-input', origin: 'file' });   // 被动源重报
    eq('被动源重报被丢弃：宠物不会"点完又举手"（ADR 022 那个缺陷的机制被切断）',
      arb.state.status, 'idle');
  }
}

// —— ⑮b 状态文件：`origin` 通道标签的透传与校验（投毒点纪律）——
section('⑮b 状态文件的 origin 透传');
{
  const d = mkdtempSync(join(tmpdir(), 'pet-origin-'));
  const f = join(d, 'status.json');
  const got = [];
  const src = createStatusFileSource({ path: f, pollMs: 40, log: () => {} });
  try {
    src.start((e) => got.push(e));
    await sleep(150);
    writeFileSync(f, JSON.stringify({
      schema: 'desktop-pet/status/v1',
      sessions: { 'wb:1': { status: 'running', ts: Date.now(), origin: 'hook' } },
    }), 'utf8');
    await sleep(400);
    eq('写侧自称的通道被透传', got.at(-1)?.origin, 'hook');

    writeFileSync(f, JSON.stringify({
      schema: 'desktop-pet/status/v1',
      sessions: { 'wb:2': { status: 'running', ts: Date.now() } },
    }), 'utf8');
    await sleep(400);
    eq('没写 origin 的条目由适配器标为 file', got.at(-1)?.origin, 'file');

    // 状态文件是谁都能写的投毒点：来源只是诊断用的短标签，不认识的取值丢弃（回落到 file），
    // 而不是原样透传去污染日志与将来的 UI。
    writeFileSync(f, JSON.stringify({
      schema: 'desktop-pet/status/v1',
      sessions: { 'wb:3': { status: 'running', ts: Date.now(), origin: '<script>alert(1)</script>' } },
    }), 'utf8');
    await sleep(400);
    eq('非法来源取值被丢弃（不原样透传）', got.at(-1)?.origin, 'file');
  } finally {
    src.stop();
    rmSync(d, { recursive: true, force: true });
  }
}

// —— ⑯ isAckable：**唯一**的"这条在等用户处理"判据（真值表）——
// 2026-09-18 的真实失配：内核 `ack()` 早已同时覆盖 needs-input 与 ready，而控制条渲染层
// 自己那份只认 needs-input ⇒ `ready` 在面板上连「确认」按钮都没有、行也不可点。
// 修法是把判据下沉到内核并让两边共用；这里钉住三件事：真值表本身、它与 `ack()` 的行为一致、
// 以及渲染层**不再**自带一份判据（否则漂移还会再来一次）。
section('⑯ isAckable 真值表（五种状态 × 已确认 × 已过期）');
{
  eq('状态集合取自内核（加状态会自己进真值表）', PET_STATUSES.length, 5);

  // ① 纯函数真值表：20 组全量断言
  let trueCount = 0;
  for (const status of PET_STATUSES) {
    for (const acknowledged of [false, true]) {
      for (const expired of [false, true]) {
        const got = isAckable({ status, acknowledged, expired });
        const want = !acknowledged && !expired && (status === 'needs-input' || status === 'ready');
        if (got) trueCount += 1;
        eq(`${status} / 已确认=${acknowledged} / 已过期=${expired} ⇒ ${want}`, got, want);
      }
    }
  }
  // 2 = needs-input 与 ready 各一组，且必须"未确认、未过期"；
  // 换句话说：五种状态里只有两类需要用户处理，而它们各自只有一个"真的在等"的组合。
  eq('20 组里恰好 2 组为真（needs-input 与 ready，且未确认、未过期）', trueCount, 2);

  // ② 与内核 `ack()` 的行为对齐：谓词说"能消解"的，`ack()` 必须真的消解（反之亦然）。
  // 这条才是防失配的关键 —— 只测纯函数的话，两边各改一处仍然对不上。
  for (const status of PET_STATUSES) {
    const clock = makeClock(7_000_000);
    const arb = new StatusArbiter({ statusMap: runtimeManifest.statusMap, now: clock.now });
    arb.ingest({ sessionId: 's', status });
    clock.advance(600);
    const want = isAckable({ status });
    arb.ack();
    const row = arb.viewSessions().find((x) => x.sessionId === 's');
    // "确认成功"在不同状态上表现不同，两种都算消解：
    //  · `needs-input` —— 行还在，但标上 acknowledged（用户确认过，留个痕迹是合理的）；
    //  · `ready` —— 确认即"已读"，通报当场退场 ⇒ 行从视图消失（ADR 024 之后这才可见）。
    // 其余状态 `ack()` 不记账 ⇒ 行还在且没标 acknowledged。
    const got = row ? row.acknowledged : true;
    eq(`ack() 对 ${status} 的记账与谓词一致`, got, want);
  }

  // ③ 结构性：渲染层不许再自带一份判据（它只能 import 内核那一份）
  const barSrc = readFileSync(join(root, 'src/renderer/control-bar.ts'), 'utf8');
  check('控制条渲染层从内核取判据', barSrc.includes("from '../kernel/status'"), '缺少 import');
  check('控制条渲染层不再自己写状态判据', !barSrc.includes("s.status === 'needs-input'"), '又抄了一份');
}

// —— ⑰ 手动把玩：面板动作排（2026-09-22，ADR 038）——
// 为什么也要做成纯函数并钉在这里：它和行为层是同一类规则 —— "到点才发生"，
// 屏幕上看不出对错（演 5 秒还是 7 秒、走 180px 还是 300px 都只表现为"它演了一下"）。
// 三条最要紧的：
//   ① **清单解析**：写错一个状态名不能让宠物卡住（丢弃 + 告警），也不能悄悄少一个动作；
//   ② **一次性动作按自身片长收尾** —— 用 dwellMs 会让画面冻在末帧上摆 6 秒；
//   ③ **位移类真的走**，且夹进工作区；走不动时降级为原地演（**不假装走了**）。
section('⑰ 手动把玩：动作清单解析 + 演出时长 + 位移（纯函数 + 虚拟时钟）');
{
  const { parseManualPlayPolicy, beginManualPlay, tickManualPlay } =
    require(join(root, 'dist/kernel/manual-play.js'));
  const { loadPack } = require(join(root, 'dist/kernel/pack.js'));
  // 用**真实宠物包**（loadPack 会校验精灵图与状态表），而不是测试里另造一份
  const pack = loadPack(root);
  const list = runtimeManifest.actions.list;

  // —— ① 真实 sidecar 的清单解析 ——
  const warns = [];
  const policy = parseManualPlayPolicy(runtimeManifest.actions, pack, (m) => warns.push(m));
  eq('动作个数 = sidecar 清单长度', policy.actions.length, list.length);
  eq('顺序与清单一致', policy.actions.map((a) => a.state).join(','), list.map((a) => a.state).join(','));
  eq('文字取自 sidecar（"过生日"是画面语义，不在 pet.json 里）',
    policy.actions.find((a) => a.state === 'running')?.label, '过生日');
  eq('解析真实清单时零告警', warns.length, 0);
  eq('dwellMs 取自 sidecar', policy.dwellMs, runtimeManifest.actions.dwellMs);
  eq('位移距离区间取自 sidecar',
    `${policy.walkDistancePx.min}-${policy.walkDistancePx.max}`,
    runtimeManifest.actions.walkDistancePx.join('-'));

  // 朝向由状态自己的 role 推出来（不按状态名猜 —— 换宠物包时状态名会变，role 不会）
  eq('running-left 的朝向 = left', policy.actions.find((a) => a.state === 'running-left')?.facing, 'left');
  eq('running-right 的朝向 = right', policy.actions.find((a) => a.state === 'running-right')?.facing, 'right');
  eq('过生日（循环、非位移）不位移', policy.actions.find((a) => a.state === 'running')?.facing, null);
  eq('待机不位移', policy.actions.find((a) => a.state === 'idle')?.facing, null);
  // 片长必须与宠物包一致（一次性动作靠它收尾）
  const wavingAct = policy.actions.find((a) => a.state === 'waving');
  eq('waving 是一次性', wavingAct.loop, false);
  eq('waving 的片长 = frames / fps',
    wavingAct.clipMs, Math.round((pack.states.waving.frames / pack.states.waving.fps) * 1000));

  // —— ①b 容错：写错状态名 / 省略清单 / 空清单 ——
  {
    const w = [];
    const p = parseManualPlayPolicy(
      { list: [{ state: '根本不存在的状态', label: 'x' }, { state: 'idle', label: '待机' }, { state: 'idle', label: '重复' }] },
      pack, (m) => w.push(m),
    );
    eq('不存在的动作被丢弃（不让宠物卡住）', p.actions.length, 1);
    eq('丢弃时告警', w.some((m) => m.includes('不在宠物包里')), true);
    eq('重复项只保留第一次', w.some((m) => m.includes('重复')), true);
    eq('留下的那一条是合法项', p.actions[0].state, 'idle');
  }
  for (const [name, raw] of [['省略 list', undefined], ['空 list', { list: [] }]]) {
    const p = parseManualPlayPolicy(raw, pack, () => {});
    eq(`${name} ⇒ 回落到全部状态（面板不能没有可点的动作）`,
      p.actions.length, Object.keys(pack.states).length);
    eq(`${name} 时的文字回落为状态 id`, p.actions[0].label, p.actions[0].state);
  }
  // 清单外多出来的状态（有渲染参数但没进 list）不该被硬塞进来 —— 清单是权威
  check('清单是权威：动作数 = 清单长度（不按行号自动补齐）',
    policy.actions.length === list.length && policy.actions.length <= Object.keys(pack.states).length);

  // —— ②③ 演出时长 / 位移：虚拟时钟 + 固定随机种子 ——
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const mid = { x: 900, y: 400, width: 134, height: 146 };
  const SPEED = 96;                              // 默认缩放下 96px/s（desktop-pet.json → behavior）
  const leftAct = policy.actions.find((a) => a.state === 'running-left');
  const rightAct = policy.actions.find((a) => a.state === 'running-right');
  const bdayAct = policy.actions.find((a) => a.state === 'running');

  // ② 循环动作 → dwellMs；一次性动作 → 自身片长 + 收尾停顿
  {
    const clock = makeClock();
    const r = beginManualPlay(bdayAct, policy, clock.now(), mid, area, SPEED, makeRng(1));
    eq('循环动作演 dwellMs', r.play.until - clock.now(), policy.dwellMs);
    eq('循环动作不位移', r.play.targetX, null);
    eq('第一条命令就带"演这个"',
      JSON.stringify(r.command.play), JSON.stringify({ state: 'running', loop: true }));

    const o = beginManualPlay(wavingAct, policy, clock.now(), mid, area, SPEED, makeRng(1));
    const held = o.play.until - clock.now();
    eq('一次性动作不位移', o.play.targetX, null);
    check('一次性动作的时长 < dwellMs（不能用它 —— loop:false 会冻在末帧）',
      held < policy.dwellMs, `实际 ${held}ms，dwellMs=${policy.dwellMs}`);
    check('一次性动作至少演满自己一个片长（落定姿势要看得见）',
      held >= wavingAct.clipMs, `实际 ${held}ms，片长 ${wavingAct.clipMs}ms`);

    // 到点前一直在演，到点立刻交回（并且**显式**下发 play:null）
    const midTick = tickManualPlay(o.play, o.play.until - 1, mid, SPEED);
    check('到点前仍在演', midTick.play !== null);
    const endTick = tickManualPlay(o.play, o.play.until, mid, SPEED);
    eq('到点 → 交回仲裁器', endTick.play, null);
    check('交回时是显式的 play:null（渲染层没人替我们撤销覆盖）',
      endTick.command.play === null, JSON.stringify(endTick.command));
  }

  // ③a 位移类真的走：目标方向正确、距离落在声明区间内、逐 tick 走到位后结束
  {
    const clock = makeClock();
    const start = beginManualPlay(leftAct, policy, clock.now(), mid, area, SPEED, makeRng(4242));
    check('往左走的目标在当前位置左侧', start.play.targetX !== null && start.play.targetX < mid.x,
      `targetX=${start.play.targetX}`);
    const dist = mid.x - start.play.targetX;
    check('走出的距离落在 sidecar 声明的区间内',
      dist >= policy.walkDistancePx.min && dist <= policy.walkDistancePx.max, `dist=${dist}`);
    eq('第一条命令带位移姿态',
      JSON.stringify(start.command.play), JSON.stringify({ state: 'running-left', loop: true }));

    let st = start.play;
    let x = mid.x;
    let steps = 0;
    while (st && steps < 5000) {
      const r = tickManualPlay(st, clock.advance(33), { ...mid, x }, SPEED);
      if (r.command.moveX !== null) x = r.command.moveX;
      st = r.play;
      steps += 1;
    }
    eq('走到目标点后结束', st, null);
    eq('落点正好是目标点', x, start.play.targetX);
    // 至少走了 1 秒（180px / 96px·s⁻¹ ≈ 1.9 秒）—— 钉住"不是瞬间贴过去"
    check('是走出去的，不是瞬移', steps * 33 >= 1000, `${steps} tick`);
  }

  // ③b 夹进工作区（不跨屏）：贴着右边缘时目标被夹住，距离随之变短
  {
    const clock = makeClock();
    const nearRight = { x: 1700, y: 400, width: 134, height: 146 };   // 右向只剩 86px
    const r = beginManualPlay(rightAct, policy, clock.now(), nearRight, area, SPEED, makeRng(1));
    eq('目标被夹进工作区右边界', r.play.targetX, area.x + area.width - nearRight.width);
    check('夹取后的距离小于声明的区间下限',
      r.play.targetX - nearRight.x < policy.walkDistancePx.min,
      `${r.play.targetX - nearRight.x}px`);
  }

  // ③c 走不动就**不假装走了**：贴着边缘时降级为原地演 dwellMs，但仍播位移姿态
  {
    const clock = makeClock();
    const atLeft = { x: area.x, y: 400, width: 134, height: 146 };
    const atRight = { x: area.x + area.width - 134, y: 400, width: 134, height: 146 };
    const l = beginManualPlay(leftAct, policy, clock.now(), atLeft, area, SPEED, makeRng(1));
    eq('贴左边缘时"往左走"降级为原地演', l.play.targetX, null);
    eq('降级后按 dwellMs 演', l.play.until - clock.now(), policy.dwellMs);
    eq('降级时仍然播位移姿态（动作本身要看得见）',
      JSON.stringify(l.command.play), JSON.stringify({ state: 'running-left', loop: true }));

    const r = beginManualPlay(rightAct, policy, clock.now(), atRight, area, SPEED, makeRng(1));
    eq('贴右边缘时"往右走"降级为原地演', r.play.targetX, null);
  }
  // 工作区比宠物还窄（异常配置）也不该崩、也不该乱走
  {
    const narrow = { x: 0, y: 0, width: 100, height: 200 };
    const clock = makeClock();
    const r = beginManualPlay(leftAct, policy, clock.now(), { x: 0, y: 0, width: 134, height: 146 }, narrow, SPEED, makeRng(1));
    eq('工作区比宠物还窄 ⇒ 原地演，不乱走', r.play.targetX, null);
  }

  // —— ④ 结构性：面板高度与白名单的两处"不许各写一份" ——
  {
    const hostSrc = readFileSync(join(root, 'src/host/control-bar.ts'), 'utf8');
    check('面板高度算式含有动作排（主进程按 sidecar 算）',
      hostSrc.includes('actionRows * opts.actionRowHeight'));
    const barRenderSrc = readFileSync(join(root, 'src/renderer/control-bar.ts'), 'utf8');
    check('控制条渲染层的白名单镜像含 play-action', barRenderSrc.includes("'play-action'"));
    check('渲染层的动作排排版取自下发参数（不自己写死行高）',
      barRenderSrc.includes('v.actionRowHeight') && barRenderSrc.includes('v.actionColumns'));
    const htmlSrc = readFileSync(join(root, 'src/renderer/control-bar.html'), 'utf8');
    check('CSS 里不写死动作排的行高/列数（否则改 sidecar 就两边对不上）',
      !/grid-(auto-rows|template-columns)\s*:\s*\d/.test(htmlSrc));
    // 手动把玩**不许**碰仲裁器：它是"陪它玩"，不是业务状态（气泡只由业务状态产生）
    const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
    const playHandler = mainSrc.slice(mainSrc.indexOf("'play-action'(arg)"), mainSrc.indexOf("'popup-menu'()"));
    check('play-action 不调用仲裁器（手动把玩不产生气泡，也不改 agent 状态）',
      !playHandler.includes('arbiter.'), '手动把玩里出现了 arbiter 调用');
  }
}

// —— ⑳ 定时器必须都能被关掉 ——
// 起因：2026-09-22 用户在便携版点「退出宠物」弹出 `Object has been destroyed`。
// 根因是两条 interval 的句柄从来没被接住（250ms 仲裁推进 + 600ms 全屏监听），
// 退出时清理不到，窗口销毁后又 tick 了一次。详见 ADR 035。
// 这个缺陷**跑测试抓不稳**（它是竞态，本轮写了三版探针都没能确定性复现），
// 但在代码里一眼可见 ⇒ 把它变成静态规则：不但修这一次，也挡住下一次。
{
  const r = spawnSync(process.execPath, [join(root, 'tools/check-timers.mjs')], { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  check('每一个定时器都能被关闭（setInterval / *Watch 的句柄都被接住）', r.status === 0, out.slice(0, 400));
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
