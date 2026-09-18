// 探针：验证「单击宠物能否立刻把 ready 收回待机」。
//
// 用户报告（2026-09-18）：agent 干完后 ready 的炒菜动画一直保持，单击宠物也不恢复待机。
//
// 本探针按内核真实路径复刻场景，不启动 Electron —— 因为失败点在**内核与渲染层的判断**
// 上，那里的逻辑是纯函数/可离线重现的，跑窗口反而会让"到底是哪一层错了"变模糊。
// 关键：这里用的是**真实仲裁器 + 真实播放器**，不是各写一份等价逻辑。
import { StatusArbiter } from '../../dist/kernel/status.js';
import { PetPlayer } from '../../dist/kernel/player.js';

const statusMap = {
  idle: { state: 'idle', priority: 4 },
  running: { state: 'running', priority: 4 },
  'needs-input': { state: 'waving', bubble: '需要输入', priority: 1 },
  blocked: { state: 'falling', priority: 2 },
  ready: { state: 'waving', then: 'review', bubble: '就绪（未读）', priority: 3 },
};

// 宠物包状态表（与真实包同构：waving 一次性、review 循环）
const states = {
  idle: { id: 'idle', row: 0, frames: 4, fps: 6.4, loop: true, frameColumns: [0, 1, 2, 3], offsetY: 0 },
  running: { id: 'running', row: 7, frames: 4, fps: 6.4, loop: true, frameColumns: [0, 1, 2, 3], offsetY: 0 },
  waving: { id: 'waving', row: 3, frames: 4, fps: 8, loop: false, frameColumns: [0, 1, 2, 3], offsetY: 0 },
  review: { id: 'review', row: 8, frames: 4, fps: 6.4, loop: true, frameColumns: [0, 1, 2, 3], offsetY: 0 },
  falling: { id: 'falling', row: 5, frames: 4, fps: 6.4, loop: true, frameColumns: [0, 1, 2, 3], offsetY: 0 },
};

let clock = 0;
const now = () => clock;

const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}  （实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`);
}

// —— 复刻渲染层的 onStatus 逻辑（与 src/renderer/renderer.ts:143-165 同构）——
function makeRenderer(arbiter, player) {
  let lastStatus = null;
  let lastStatusRev = -1;
  const reducedMotion = false;

  const resting = (p) => p.animation.then ?? p.animation.state;

  return {
    // 与 renderer.ts 的 onStatus 同构
    onStatus(p) {
      const isNew = p.rev !== lastStatusRev;
      lastStatus = p;
      lastStatusRev = p.rev;
      if (!player) return;
      if (reducedMotion) { player.setState(resting(p), { then: p.animation.then }); return; }
      if (player.isOneShot && player.stateId !== p.animation.state) return;   // ← 可疑的那一行
      player.setState(isNew && !p.replay ? p.animation.state : resting(p), { then: p.animation.then });
    },
    // 与 renderer.ts:320-323 的单击路径同构
    onClick() {
      const ackChanged = arbiter.ack();
      if (ackChanged) this.onStatus(snapshot(arbiter));
      // 单击顺带播一次挥手（与真实渲染层一致）
      if (!reducedMotion && !player.setState('waving')) player.setState('idle');
      return ackChanged;
    },
    get renderer_missing() { return lastStatus === null; },
  };
}

function snapshot(arbiter) {
  const s = arbiter.state;
  return { ...s, replay: false };
}

// ============================================================
console.log('=== 场景 1：ready 驻留期间单击宠物 ===');
{
  clock = 1_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  const player = new PetPlayer({ states }, 'idle');
  const r = makeRenderer(arbiter, player);

  // agent 干完 → ready
  arbiter.ingest({ sessionId: 'wb:1', status: 'ready', ts: clock });
  r.onStatus(snapshot(arbiter));
  console.log(`  注入 ready 后：播放器状态 = ${player.stateId}`);
  // 推几帧让 waving 播完，落到 review（第 8 行小厨师）
  for (let i = 0; i < 20; i++) { clock += 130; player.update(130); }
  console.log(`  waving 播完后：播放器状态 = ${player.stateId}（期望 review = 第 8 行小厨师）`);
  check('waving 播完落到 review', player.stateId, 'review');

  // 用户单击宠物
  const changed = r.onClick();
  console.log(`  单击后：ack 返回 ${changed}；仲裁状态 = ${arbiter.state.status}；播放器状态 = ${player.stateId}`);
  // 让 waving 播完，看最终落点
  for (let i = 0; i < 20; i++) { clock += 130; player.update(130); }
  console.log(`  再推 20 帧后：播放器状态 = ${player.stateId}`);
  check('单击后播放器不再停在 review（应回 idle）', player.stateId === 'review', false);
  check('单击后仲裁状态已变 idle', arbiter.state.status, 'idle');
}

console.log('\n=== 场景 2：内核侧 ack 是否真的能消解 ready ===');
{
  clock = 2_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  arbiter.ingest({ sessionId: 'wb:1', status: 'ready', ts: clock });
  check('注入后主状态 = ready', arbiter.state.status, 'ready');
  const changed = arbiter.ack();
  check('ack() 返回 true（输出有变化）', changed, true);
  check('ack() 后主状态 = idle', arbiter.state.status, 'idle');
  const v = arbiter.viewSessions()[0];
  check('会话原始 status 仍如实保留为 ready', v.status, 'ready');
  check('会话 expired 标记为 true', v.expired, true);
}

console.log('\n=== 场景 3：渲染层在"一次性动作播放中"收到 ack 的状态推送 ===');
{
  clock = 3_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  const player = new PetPlayer({ states }, 'idle');
  const r = makeRenderer(arbiter, player);

  arbiter.ingest({ sessionId: 'wb:1', status: 'ready', ts: clock });
  r.onStatus(snapshot(arbiter));
  for (let i = 0; i < 20; i++) { clock += 130; player.update(130); }
  console.log(`  ready 驻留（播放器 = ${player.stateId}）`);

  // 关键时序：单击 → 先 ack 推状态，再 setState('waving')
  // 此时播放器正处于 review（循环），isOneShot=false，所以推送应该能生效
  arbiter.ack();
  r.onStatus(snapshot(arbiter));
  console.log(`  ack 推送后（尚未播挥手）：播放器 = ${player.stateId}`);
  check('ack 推送把播放器拉回 idle', player.stateId, 'idle');
}

console.log('\n=== 场景 4：ready 未到期 + 有其它会话在 running ===');
{
  clock = 4_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  arbiter.ingest({ sessionId: 'wb:1', status: 'ready', ts: clock });
  arbiter.ingest({ sessionId: 'wb:2', status: 'running', ts: clock });
  console.log(`  注入 ready + running 后的主状态 = ${arbiter.state.status}`);
  // running priority 4 比 ready priority 3 低，所以 ready 应该赢
  check('ready(优先级 3) 胜过 running(优先级 4)', arbiter.state.status, 'ready');
  arbiter.ack('wb:1');
  console.log(`  只 ack wb:1 后主状态 = ${arbiter.state.status}（应回落到 running）`);
  check('只确认 wb:1 后主状态回落 running', arbiter.state.status, 'running');
}

// —— 汇总 ——
const failed = results.filter((x) => !x.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name}（实际 ${JSON.stringify(f.actual)} / 期望 ${JSON.stringify(f.expected)}）`);
}
process.exit(failed.length ? 1 : 0);
