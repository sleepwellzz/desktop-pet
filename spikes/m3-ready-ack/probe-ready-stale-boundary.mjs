// 探针：`ready` 与 `stale` 的**时间边界**（2026-09-18 之前这两条完全无覆盖）。
//
// 为什么单测不够、还要单独一条探针：这两条规则都是"到点才发生"的，而且**界面上的症状
// 互相矛盾** —— 主状态已经回 idle，面板却可能还挂着一行。它们只在"时间真的走过去"之后
// 才成立，靠读代码推演很容易看漏（本项目已有五次推断被实测推翻）。
//
// 本探针要回答三件事：
//   ① `ready` 的 60 秒通报时效：到点是不是真的退场（主状态回 idle）？
//   ② 上游**持续心跳**时（生产里就是这样：每 15 秒重报一次），16 分钟后面板长什么样？
//      交接文档里的推测是"`viewSessions()` 应为空" —— 本探针负责证实或推翻它。
//   ③ 「（已过期）」标签到底是不是一个永远不会出现的**死分支**？
//
// 判据纪律：两次输入之间必须显式推进时钟（仲裁器的变化限流窗格是 500ms），
// 否则量到的是限流而不是被测的超时规则。
import { StatusArbiter, isAckable } from '../../dist/kernel/status.js';

const statusMap = {
  idle: { state: 'idle', priority: 4 },
  running: { state: 'running', priority: 4 },
  'needs-input': { state: 'waiting', priority: 1 },
  blocked: { state: 'failed', priority: 2 },
  ready: { state: 'waving', then: 'review', priority: 3 },
};

const READY_MS = 60_000;        // 内核默认 statusTimeouts.readyMs
const STALE_MS = 900_000;       // 内核默认 sessionStaleMs（15 分钟）
const HEARTBEAT_MS = 15_000;    // 生产实测的上游重报节奏（events.jsonl：15–60 秒）

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}  （实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`);
}
function boot(start = 1_000_000) {
  let clock = start;
  const arb = new StatusArbiter({ statusMap, now: () => clock });
  return { arb, now: () => clock, advance(ms) { clock += ms; arb.tick(clock); } };
}

// ============================================================
console.log('=== ① ready 的通报时效边界：59 秒 / 61 秒 ===');
{
  const { arb, advance } = boot();
  arb.ingest({ sessionId: 'wb:1', status: 'ready', title: '干完了' });
  check('刚收到 ready：主状态 = ready', arb.state.status, 'ready');

  advance(59_000);
  check('59 秒：通报仍在时效内（主状态不动）', arb.state.status, 'ready');
  check('59 秒：面板不标"已过期"', arb.viewSessions()[0].expired, false);

  advance(2_000);
  check('61 秒：通报时效到点 ⇒ 主状态回 idle', arb.state.status, 'idle');
  check('61 秒：面板标"已过期"（原始状态仍是 ready）', arb.viewSessions()[0].expired, true);
  check('已过期的行不再给「确认」按钮', isAckable(arb.viewSessions()[0]), false);
}

console.log('\n=== ② 上游持续心跳的 ready（生产真实节奏）—— 16 分钟后面板长什么样 ===');
{
  const { arb, advance } = boot(2_000_000);
  arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 2_000_000, title: '干完了' });
  // 每 15 秒重报一次，持续 16 分钟（64 次）—— 心跳**只刷新 ts**，不动 readySince。
  for (let i = 0; i < 64; i++) advance(HEARTBEAT_MS), arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 2_000_000 + (i + 1) * HEARTBEAT_MS });
  advance(HEARTBEAT_MS);

  const v = arb.viewSessions();
  console.log(`  心跳 16 分钟后：主状态 = ${arb.state.status}，面板行数 = ${v.length}` +
    (v.length ? `，expired = ${v[0].expired}，原始状态 = ${v[0].status}` : ''));
  check('主状态回 idle（通报时效不因心跳而延长）', arb.state.status, 'idle');
  // ⚠️ 交接文档推测"viewSessions() 应为空"。实测推翻：心跳刷新的是 `ts`，
  // 而静默兜底看的正是 `ts` ⇒ 只要上游还在报，这条会话就永远不会过期。
  check('面板**仍有**这一行（心跳把 ts 一直刷新，静默兜底不触发）', v.length, 1);
  check('这一行被标为「已过期」', v.length ? v[0].expired : null, true);
  check('它不给「确认」按钮（宠物已经回待机，再给按钮是误导）', v.length ? isAckable(v[0]) : null, false);
}

console.log('\n=== ③ ready 之后**不再**心跳 —— 16 分钟后面板应当清空 ===');
{
  const { arb, advance } = boot(3_000_000);
  arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 3_000_000 });
  advance(61_000);
  check('61 秒：主状态回 idle', arb.state.status, 'idle');
  check('61 秒：面板仍留着这一行（标"已过期"）', arb.viewSessions().length, 1);
  advance(STALE_MS - 61_000 + 1_000);          // 跨过 15 分钟静默兜底
  check('静默 15 分钟后：面板一行不剩', arb.viewSessions().length, 0);
  check('主状态仍是 idle', arb.state.status, 'idle');
}

console.log('\n=== ④ 静默兜底的边界：14 分 59 秒 / 15 分 01 秒（running 对照组）===');
{
  const { arb, advance } = boot(4_000_000);
  arb.ingest({ sessionId: 'wb:1', status: 'running', ts: 4_000_000 });
  advance(STALE_MS - 1_000);
  check('14 分 59 秒：会话仍在面板上', arb.viewSessions().length, 1);
  check('14 分 59 秒：主状态仍是 running', arb.state.status, 'running');
  advance(2_000);
  check('15 分 01 秒：会话被静默兜底清掉', arb.viewSessions().length, 0);
  check('15 分 01 秒：主状态回 idle（疑似 agent 崩溃的唯一兜底）', arb.state.status, 'idle');
}

// ============================================================
console.log('\n=== 结论（由上面的实测得出，不是推断）===');
console.log('  · `ready` 的 60 秒通报时效生效：到点主状态回 idle，心跳**不会**延长它。');
console.log('  · 「（已过期）」**不是死分支** —— 只要会话还活着（上游还在心跳），');
console.log('    它就会一直显示：ts 被刷新 ⇒ 静默兜底永远不触发 ⇒ 面板那一行长期挂着。');
console.log('  · 上游停止上报后，15 分钟静默兜底才把这一行真正清掉。');

const failed = results.filter((x) => !x.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  ❌ ${f.name}（实际 ${JSON.stringify(f.actual)} / 期望 ${JSON.stringify(f.expected)}）`);
process.exit(failed.length ? 1 : 0);
