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
// ③ 已被本探针回答并**据此修了一个 bug（挂起清单 #14，ADR 024）**：它不是死分支，
// 而是会长期驻留 —— 且驻留的这一行不给「确认」按钮，等于没有出口。
// 修复后本探针的断言同步改为"过期即从面板退场"，并新增 ③b 反向用例（上游改口时行要能回来）。
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
  // ADR 024：退场必须走到视图 —— 只把仲裁输出改回 idle、面板却留一行"已过期"，
  // 等于给了它一个没有出口的状态（该行不给「确认」按钮，只能等 15 分钟静默兜底）。
  check('61 秒：面板不再列出这一行', arb.viewSessions().length, 0);
  check('61 秒：原始记录仍在（只是不展示，上游改口时行要能回来）', arb.snapshot().length, 1);
  check('已过期的行不给「确认」按钮', isAckable({ status: 'ready', expired: true }), false);
}

console.log('\n=== ② 上游持续心跳的 ready（生产真实节奏）—— 16 分钟后面板长什么样 ===');
{
  const { arb, advance } = boot(2_000_000);
  arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 2_000_000, title: '干完了' });
  // 每 15 秒重报一次，持续 16 分钟（64 次）—— 心跳**只刷新 ts**，不动 readySince。
  for (let i = 0; i < 64; i++) advance(HEARTBEAT_MS), arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 2_000_000 + (i + 1) * HEARTBEAT_MS });
  advance(HEARTBEAT_MS);

  const v = arb.viewSessions();
  console.log(`  心跳 16 分钟后：主状态 = ${arb.state.status}，面板行数 = ${v.length}`);
  check('主状态回 idle（通报时效不因心跳而延长）', arb.state.status, 'idle');
  // 交接文档推测"viewSessions() 应为空" —— 方向对，但机制说错了：
  // 不是静默兜底触发（心跳刷新 ts ⇒ 15 分钟那条永远不触发），
  // 而是 ADR 024 新增的"过期通报不再占面板"过滤。
  check('面板**不再**列出这一行（修 #14 前它会长期挂着）', v.length, 0);
  check('但原始记录仍在（心跳还在，会话本身没死）', arb.snapshot().length, 1);
}

console.log('\n=== ③ ready 之后**不再**心跳 —— 16 分钟后面板应当清空 ===');
{
  const { arb, advance } = boot(3_000_000);
  arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 3_000_000 });
  advance(61_000);
  check('61 秒：主状态回 idle', arb.state.status, 'idle');
  check('61 秒：面板不再列出这一行（通报已退场）', arb.viewSessions().length, 0);
  check('61 秒：原始记录仍在（还没到 15 分钟静默兜底）', arb.snapshot().length, 1);
  advance(STALE_MS - 61_000 + 1_000);          // 跨过 15 分钟静默兜底
  check('静默 15 分钟后：面板一行不剩', arb.viewSessions().length, 0);
  check('静默 15 分钟后：连记录本身也被清掉', arb.snapshot().length, 0);
  check('主状态仍是 idle', arb.state.status, 'idle');
}

console.log('\n=== ③b 反向用例：过期被过滤后，上游改口 running ⇒ 这一行必须回来（防误杀）===');
{
  const { arb, advance } = boot(3_500_000);
  arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 3_500_000 });
  advance(61_000);
  check('前置：通报已退场，面板没有它', arb.viewSessions().length, 0);
  // ⚠️ 判据纪律：两次输入之间必须显式推进时钟 —— 仲裁器的变化限流窗格是 500ms，
  // 同一钟值上连发会被挡下（本项目已栽过两次：这里量到的是限流，不是"退场/复活"）。
  arb.ingest({ sessionId: 'wb:1', status: 'running', ts: 3_500_000 + 61_000 });
  advance(600);
  check('上游改口 running ⇒ 面板重新列出这一行', arb.viewSessions().length, 1);
  check('主状态也跟着变 running（没被"已过期"误杀）', arb.state.status, 'running');
  check('这一行不再标"已过期"', arb.viewSessions()[0].expired, false);
  // 关键防复活：上游继续重报 ready 时，通报时效不能重新开始（否则宠物每 60 秒炒一次菜）。
  arb.ingest({ sessionId: 'wb:1', status: 'ready', ts: 3_500_000 + 62_000 });
  advance(600);
  check('再次 ready：重新起算一次计时（这是一次新的通报）', arb.state.status, 'ready');
  advance(61_000);
  check('又一个 60 秒后照常退场（重报不续期）', arb.state.status, 'idle');
  check('面板同样不再列出', arb.viewSessions().length, 0);
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
console.log('  · 修 #14 之前：面板会长期挂着一行「（已过期）」—— 心跳刷新 ts ⇒');
console.log('    静默兜底永远不触发 ⇒ 那一行既没有出口、也不给「确认」按钮（ADR 024 判定为 bug）。');
console.log('  · 修 #14 之后：过期的通报**同时**从仲裁输出与面板视图上退场；');
console.log('    原始记录保留，上游改口 running 时这一行会回来（③b 防误杀）。');
console.log('  · 上游停止上报后，15 分钟静默兜底才把记录本身清掉。');

const failed = results.filter((x) => !x.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  ❌ ${f.name}（实际 ${JSON.stringify(f.actual)} / 期望 ${JSON.stringify(f.expected)}）`);
process.exit(failed.length ? 1 : 0);
