// 探针：用**真实宠物包的真实 statusMap** 复刻用户场景，找出"单击无效"的真成因。
//
// 上一版探针（probe-ready-ack.mjs）用的是手写的简化 statusMap，11/11 通过 ——
// 说明逻辑本身没问题。因此差异只可能来自**真实配置**。本探针把它换成
// `desktop-pet.json` 里那一份（原样读入，不篡改），再看同样的动作会怎样。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StatusArbiter } from '../../dist/kernel/status.js';
import { PetPlayer } from '../../dist/kernel/player.js';

// ⚠️ 必须用 fileURLToPath：本工程路径含空格，直接对 URL 做字符串替换会留下 %20，读文件必失败。
const root = fileURLToPath(new URL('../../', import.meta.url));
const cfg = JSON.parse(readFileSync(root + 'desktop-pet.json', 'utf8'));
const statusMap = cfg.statusMap;

console.log('真实 statusMap：');
for (const [k, v] of Object.entries(statusMap)) {
  console.log(`  ${k.padEnd(13)} state=${String(v.state).padEnd(12)} then=${String(v.then ?? '-').padEnd(10)} priority=${v.priority}  bubble=${v.bubble ?? '-'}`);
}
console.log('');
console.log('真实 statusTimeouts：');
for (const [k, v] of Object.entries(cfg.statusTimeouts)) {
  if (k.endsWith('Note') || k === 'note') continue;
  console.log(`  ${k} = ${v} ms`);
}
console.log('');

// 真实宠物包的状态表（从 behavior-map.json 读行号/帧数，与运行时一致）
const bm = JSON.parse(readFileSync(root + 'behavior-map.json', 'utf8'));
const states = {};
const src = bm.states ?? bm;
for (const [id, s] of Object.entries(src)) {
  const st = s;
  if (typeof st?.row !== 'number') continue;
  states[id] = {
    id,
    row: st.row,
    frames: st.frames ?? 4,
    fps: st.fps ?? 6.4,
    loop: st.loop !== false,
    frameColumns: st.frameColumns ?? Array.from({ length: st.frames ?? 4 }, (_, i) => i),
    offsetY: st.offsetY ?? 0,
  };
}
console.log('真实状态表：' + Object.entries(states).map(([k, v]) => `${k}(行${v.row}${v.loop ? '' : ',一次性'})`).join(' '));
console.log('');

let clock = 10_000_000;
const now = () => clock;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}  （实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`);
}

// 与 renderer.ts 同构
function makeRenderer(arbiter, player) {
  let lastStatus = null;
  let lastStatusRev = -1;
  const resting = (p) => p.animation.then ?? p.animation.state;
  return {
    onStatus(p) {
      const isNew = p.rev !== lastStatusRev;
      lastStatus = p; lastStatusRev = p.rev;
      if (!player) return;
      if (player.isOneShot && player.stateId !== p.animation.state) return;
      player.setState(isNew && !p.replay ? p.animation.state : resting(p), { then: p.animation.then });
    },
    onClick() {
      const changed = arbiter.ack();
      if (changed) this.onStatus({ ...arbiter.state, replay: false });
      if (!player.setState('waving')) player.setState('idle');
      return changed;
    },
  };
}
const pump = (player, n = 30) => { for (let i = 0; i < n; i++) { clock += 130; player.update(130); } };

// ============================================================
console.log('=== 场景 A：真实配置下，ready 驻留后单击宠物 ===');
{
  clock = 10_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  const player = new PetPlayer({ states }, 'idle');
  const r = makeRenderer(arbiter, player);

  arbiter.ingest({ sessionId: 'wb:1', status: 'ready', ts: clock, title: 'WorkBuddy · desktop-pet' });
  r.onStatus({ ...arbiter.state, replay: false });
  console.log(`  注入 ready → 播放器 = ${player.stateId}`);
  pump(player);
  console.log(`  播完 → 播放器 = ${player.stateId}（行 ${states[player.stateId]?.row}）`);

  const changed = r.onClick();
  console.log(`  单击 → ack=${changed}，仲裁=${arbiter.state.status}，播放器=${player.stateId}`);
  pump(player);
  console.log(`  播完 → 播放器 = ${player.stateId}（行 ${states[player.stateId]?.row}）`);
  check('单击后播放器回到 idle', player.stateId, 'idle');
}

console.log('\n=== 场景 B：一个真实回合的完整事件序列（Stop → idle_prompt → ...）===');
{
  clock = 11_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  const player = new PetPlayer({ states }, 'idle');
  const r = makeRenderer(arbiter, player);

  const feed = (label, e) => {
    arbiter.ingest(e);
    r.onStatus({ ...arbiter.state, replay: false });
    pump(player, 8);
    console.log(`  ${label.padEnd(28)} → 主状态=${arbiter.state.status.padEnd(12)} 播放器=${player.stateId}(行${states[player.stateId]?.row})`);
  };

  feed('UserPromptSubmit (running)', { sessionId: 'wb:1', status: 'running', ts: clock, title: 'WB' });
  feed('停止思考（无事件，时钟前进）', { sessionId: 'wb:1', status: 'running', ts: clock, title: 'WB' });
  pump(player, 40);
  feed('Stop → ready', { sessionId: 'wb:1', status: 'ready', ts: clock, title: 'WB' });
  pump(player, 40);

  console.log('  —— 此刻用户去看结果并单击宠物 ——');
  const changed = r.onClick();
  pump(player, 40);
  console.log(`  单击后：ack=${changed} 主状态=${arbiter.state.status} 播放器=${player.stateId}(行${states[player.stateId]?.row})`);
  check('单击后回到待机（行 0）', states[player.stateId]?.row, 0);

  console.log('  —— 60 秒后：agent 又发了一次心跳/idle_prompt ——');
  clock += 61_000;
  const t = arbiter.tick(clock);
  r.onStatus({ ...arbiter.state, replay: false });
  pump(player, 20);
  console.log(`  tick 变化=${t} 主状态=${arbiter.state.status} 播放器=${player.stateId}(行${states[player.stateId]?.row})`);
  check('心跳后仍在待机', player.stateId, 'idle');
}

console.log('\n=== 场景 C：ready 到期（60s）后的行为 ===');
{
  clock = 12_000_000;
  const arbiter = new StatusArbiter({ statusMap, now });
  const player = new PetPlayer({ states }, 'idle');
  const r = makeRenderer(arbiter, player);
  arbiter.ingest({ sessionId: 'wb:1', status: 'ready', ts: clock });
  r.onStatus({ ...arbiter.state, replay: false });
  pump(player, 40);
  console.log(`  ready 驻留：播放器=${player.stateId}(行${states[player.stateId]?.row})`);
  clock += 61_000;
  const t = arbiter.tick(clock);
  r.onStatus({ ...arbiter.state, replay: false });
  pump(player, 40);
  console.log(`  60 秒后 tick 变化=${t} 主状态=${arbiter.state.status} 播放器=${player.stateId}(行${states[player.stateId]?.row})`);
  check('到期后自动回 idle', player.stateId, 'idle');
  const v = arbiter.viewSessions()[0];
  check('面板把该会话标为 expired', v.expired, true);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  ❌ ${f.name}（实际 ${JSON.stringify(f.actual)} / 期望 ${JSON.stringify(f.expected)}）`);
process.exit(failed.length ? 1 : 0);
