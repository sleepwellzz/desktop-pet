// 探针：复刻用户报告的**真实失败序列** —— "单击宠物后状态又自己回来了"。
//
// 假设（由 events.jsonl 的真实数据推出，本探针负责证实/推翻）：
//   状态文件里那条 `needs-input` 的 `ts` 每隔十几秒就被上游刷新一次
//   （events.jsonl 实测：357 条里绝大多数是同一会话的 needs-input，origin=file，
//   间隔 15–60 秒，持续数小时）。文件源会把"ts 变了"翻译成一条新事件。
//
//   而 `ingest()` 里的复位条件写的是 **"非 needs-input → needs-input"才清确认位**：
//   `if (e.status === 'needs-input' && prev?.status !== 'needs-input')`
//   —— 状态**没变**时不清。看起来是对的，但真正的问题是**另一条更隐晦的路径**：
//   文件源和 hook 通道**同时**盯同一个 agent（ADR 020 明令互斥），
//   两者交替写入会让状态在 needs-input ↔ 其它 之间来回跳，
//   每次跳回来都清一次确认位 ⇒ 用户点一次只能安静一会儿。
//
// 本探针不猜：直接把真实的事件序列喂进真实仲裁器，看确认位到底会不会被撤销。
import { StatusArbiter } from '../../dist/kernel/status.js';

const statusMap = {
  idle: { state: 'idle', priority: 4 },
  running: { state: 'running', priority: 4 },
  'needs-input': { state: 'waiting', priority: 1 },
  blocked: { state: 'failed', priority: 2 },
  ready: { state: 'waving', then: 'review', priority: 3 },
};

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}  （实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`);
}

const SID = 'wb:de8d4bad-6104-4719-96ac-7071476e5b9a';
let clock = 100_000_000;
const now = () => clock;

// ============================================================
console.log('=== 情形 1：同一会话反复重报 needs-input（ts 每次都变）===');
{
  clock = 100_000_000;
  const arb = new StatusArbiter({ statusMap, now });

  arb.ingest({ sessionId: SID, status: 'needs-input', ts: clock, title: 'WB' });
  check('初始主状态 = needs-input', arb.state.status, 'needs-input');
  check('会话 acknowledged = false', arb.viewSessions()[0].acknowledged, false);

  // 用户单击宠物
  arb.ack();
  check('单击后主状态 = idle', arb.state.status, 'idle');
  check('单击后 acknowledged = true', arb.viewSessions()[0].acknowledged, true);

  // 上游继续每 20 秒重报一次（ts 每次都变，状态不变）
  let revived = false;
  for (let i = 0; i < 12; i++) {
    clock += 20_000;
    arb.ingest({ sessionId: SID, status: 'needs-input', ts: clock, title: 'WB' });
    arb.tick(clock);
    if (arb.state.status === 'needs-input') { revived = true; break; }
  }
  const v = arb.viewSessions()[0];
  console.log(`  重报 12 次后：主状态 = ${arb.state.status}，acknowledged = ${v.acknowledged}`);
  check('同状态重报**不该**撤销用户的确认', revived, false);
}

console.log('\n=== 情形 2：文件源(needs-input) 与 hook(running) 交替写入 —— 双通道打架 ===');
{
  clock = 200_000_000;
  const arb = new StatusArbiter({ statusMap, now });

  arb.ingest({ sessionId: SID, status: 'needs-input', ts: clock, title: 'WB' });
  arb.ack();
  console.log(`  单击后：主状态 = ${arb.state.status}`);

  // hook 通道说在 running，文件通道说还在等输入 —— 交替来。
  // 这是 ADR 020 明令禁止、但生产里确实发生过的组合。
  const seq = [
    ['running', 'hook'],
    ['needs-input', 'file'],
    ['running', 'hook'],
    ['needs-input', 'file'],
  ];
  let revivals = 0;
  for (const [status, src] of seq) {
    clock += 5_000;
    arb.ingest({ sessionId: SID, status, ts: clock, origin: src, title: 'WB' });
    arb.tick(clock);
    console.log(`    ← ${src} 报 ${status.padEnd(12)} ⇒ 主状态 = ${arb.state.status.padEnd(12)} acknowledged = ${arb.viewSessions()[0].acknowledged}`);
    if (arb.state.status === 'needs-input') revivals += 1;
  }
  console.log(`  交替 ${seq.length} 次中，需要输入"复活"了 ${revivals} 次`);
  // 修复前实测 revivals = 3（用户点完之后十几秒宠物又把手举起来）；
  // 修复后必须为 0 —— 迟滞窗口把交替重报认成"同一次求助的续报"。
  check('双通道交替**不该**让确认位复活', revivals, 0);
  check('全程 acknowledged 保持 true', arb.viewSessions()[0].acknowledged, true);
}

console.log('\n=== 情形 2b：迟滞窗口**之外**的重新举手仍应生效 ===');
{
  clock = 250_000_000;
  const arb = new StatusArbiter({ statusMap, now });
  arb.ingest({ sessionId: SID, status: 'needs-input', ts: clock });
  arb.ack();
  check('确认后回 idle', arb.state.status, 'idle');
  // 等过迟滞窗口（60s）后，会话真的又提出了一个新问题。
  //
  // ⚠️ 两次 ingest 之间**必须推进时钟**：仲裁器的变化限流窗格是 500ms
  // （`Math.max(minDisplayMs 400, throttleMs 500)`），同一时刻连续 ingest
  // 会让 `needs-input` 被挡进 `pending` —— 断言会量到"限流"而不是"迟滞窗口"，
  // 属于**判据不纯**（M2 ④ 第一版探针犯过同样的错）。这里按真实时序各给 1 秒。
  clock += 90_000;
  arb.ingest({ sessionId: SID, status: 'running', ts: clock });
  arb.tick(clock);
  console.log(`    ← running 后：主状态 = ${arb.state.status}`);
  clock += 1_000;
  arb.ingest({ sessionId: SID, status: 'needs-input', ts: clock });
  arb.tick(clock);
  console.log(`  距上次求助 90 秒后重新举手：主状态 = ${arb.state.status}，acknowledged = ${arb.viewSessions()[0].acknowledged}`);
  check('迟滞窗口外的新求助应重新举手', arb.state.status, 'needs-input');
  check('新求助的 acknowledged 应复位', arb.viewSessions()[0].acknowledged, false);
}

console.log('\n=== 情形 3：ready 被文件源重报（ts 变化）===');
{
  clock = 300_000_000;
  const arb = new StatusArbiter({ statusMap, now });

  arb.ingest({ sessionId: SID, status: 'ready', ts: clock, title: 'WB' });
  arbpoll: {
    for (let i = 0; i < 3; i++) { clock += 15_000; arb.ingest({ sessionId: SID, status: 'ready', ts: clock }); arb.tick(clock); }
  }
  check('重复重报 ready 不延长通报时效（仍会到期）', (() => {
    clock += 61_000; arb.tick(clock); return arb.state.status;
  })(), 'idle');

  // 重报 ready 后单击
  const arb2 = new StatusArbiter({ statusMap, now });
  clock = 400_000_000;
  arb2.ingest({ sessionId: SID, status: 'ready', ts: clock });
  arb2.ack();
  check('单击 ready 后回 idle', arb2.state.status, 'idle');
  clock += 20_000;
  arb2.ingest({ sessionId: SID, status: 'ready', ts: clock });   // 上游又重报一次
  arb2.tick(clock);
  console.log(`  重报一次 ready 后：主状态 = ${arb2.state.status}，expired = ${arb2.viewSessions()[0].expired}`);
  check('重报 ready **不该**让已确认的它复活', arb2.state.status, 'idle');
}

const failed = results.filter((x) => !x.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  ❌ ${f.name}（实际 ${JSON.stringify(f.actual)} / 期望 ${JSON.stringify(f.expected)}）`);
process.exit(failed.length ? 1 : 0);
