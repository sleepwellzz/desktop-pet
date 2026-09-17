// 离线探针：状态快照里的"陈旧会话"到底会不会被当成"新鲜"（**修复后的回归哨兵**）。
//
// 背景（PLAN §1 点名的一条线索，2026-09-17 实测证实为真缺陷，见 ADR 016）：
//   状态文件是快照、重启后原样读回；若某条会话记录**没有 `ts` 字段**，
//   适配器刻意不补 Date.now()（补了轮询就变成假心跳），事件里 ts 就是 undefined，
//   `kernel/status.ts` 的 ingest 兜底 `ts ?? now` 把它盖章成"现在" ——
//   一条早已死掉的会话在启动后"新鲜"整整 15 分钟，表现是"一启动就显示某某在运行中"。
//   而"陈旧"的证据其实就在文件里（mtime），只是没人用它。
//
// 修法：无 `ts` 的条目改用**快照写入时刻（mtime）**兜底，且这类条目不参与
//       "ts 变了就算心跳"那条分支（同一次写入会让所有会话的兜底值一起变）。
//
// 本探针用**真实适配器 + 真实仲裁器 + 真实临时文件**跑（只把时钟换成虚拟的），
// 因为这条链路横跨两层：任何单层的单测都看不到全貌。它同时充当修复的**回归哨兵** ——
// 六段里只要有一段的期望被改回去，这里立刻红。
//
// 顺带验第二件事：「清空状态会话」之后，面板/菜单里的那些行到底清没清掉。
//
// 跑法：node spikes/m2-status/probe-stale-sessions.mjs   （需先 npm run build，读的是 dist）
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { StatusArbiter } = require(join(root, 'dist/kernel/status.js'));
const { createStatusFileSource } = require(join(root, 'dist/source/status-file.js'));
const runtimeManifest = require(join(root, 'desktop-pet.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ' —— ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' —— ' + detail : ''}`); }
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
const section = (t) => console.log(`\n${t}`);

const MIN = 60_000;

const dir = mkdtempSync(join(tmpdir(), 'pet-stale-'));
let seq = 0;

/** 起一套"真实适配器 + 真实仲裁器"，时钟虚拟化。返回控制柄。 */
function boot(file) {
  const vt = { t: Date.now() };
  const logs = [];
  const arb = new StatusArbiter({
    statusMap: runtimeManifest.statusMap,
    now: () => vt.t,
    log: (m) => logs.push(m),
  });
  const source = createStatusFileSource({ path: file, pollMs: 60, log: (m) => logs.push(m) });
  source.start((e) => arb.ingest(e));
  return {
    vt, logs, arb, source,
    /** 推进虚拟时钟（同时给真实 fs.watch 一点时间） */
    async advance(ms) {
      // 分小步推进并 tick：粘滞/静默都是"到点才发生"的规则，一步到位会掩盖中间态
      const step = 30_000;
      for (let done = 0; done < ms; done += step) {
        vt.t += Math.min(step, ms - done);
        arb.tick();
        await sleep(5);
      }
      arb.tick();
    },
    /**
     * 让"刚写进文件的状态"真正落到输出上。
     *
     * 为什么不只 sleep：真实运行时仲裁 tick 每 250ms 推进真实时钟，被 500ms 限流挡下的那次切换
     * 会**在下一次 tick 时补上**；而本探针的时钟是虚拟的，只 sleep 不推进虚拟时间，
     * 拍下来的就是"限流中间态"（第一版 ⑥ 段两条断言正是这样假失败的）。
     */
    async settle(ms = 700) {
      await sleep(450);                       // 等 fs.watch / 轮询把文件读进来
      await this.advance(ms);
      await sleep(50);
    },
    stop() { source.stop(); },
  };
}

function writeSnapshot(file, doc) {
  const tmp = `${file}.tmp-${process.pid}-${seq++}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);                      // 与 pet-hook.mjs 同款的原子替换
}

/** 写一份快照，并把它的 mtime 倒回 ageMs（模拟"上次运行留下的文件"）。 */
function writeAged(file, doc, ageMs) {
  writeSnapshot(file, doc);
  if (ageMs) {
    const s = statSync(file);
    utimesSync(file, s.atime, new Date(Date.now() - ageMs));
  }
}

const openDry = async (name, doc, ageMs = 0) => {
  const file = join(dir, `status-${seq++}.json`);
  writeAged(file, doc, ageMs);
  const h = boot(file);
  await sleep(400);                           // 等首次读盘（start 里同步读了一次，这里留余量）
  const first = { status: h.arb.state.status, sessions: h.arb.viewSessions() };
  console.log(`  · ${name}：启动后主状态=${first.status}` +
    (first.sessions.length
      ? `，面板会话=${first.sessions.map((s) => `${s.sessionId}:${s.status}@${Math.round((h.vt.t - s.ts) / 1000)}秒前`).join(' / ')}`
      : '，面板会话=无'));
  return { file, ...h, first };
};

// —— ① 对照：带了旧 ts 的会话，启动时应当被静默兜底清掉 ——
section('① 对照：有 ts 的陈旧会话（1 小时前写的 running）');
{
  const h = await openDry('旧 ts 快照',
    { schema: 'desktop-pet/status/v1', sessions: { default: { status: 'running', title: 'manual-acceptance', ts: Date.now() - 60 * MIN } } });
  eq('启动后主状态 = idle（旧会话被静默兜底清掉）', h.first.status, 'idle');
  eq('面板里不残留这条会话', h.first.sessions.length, 0);
  check('日志里有"静默超过 15 分钟"的留痕', h.logs.some((l) => l.includes('静默超过 15 分钟')),
    h.logs.filter((l) => l.includes('静默')).join(' | ') || '（无）');
  h.stop();
}

// —— ② 无 ts **但刚写**：必须照常生效（不能因为修 bug 误杀正在跑的会话）——
section('② 无 ts 的快照是**刚写的** → 照常生效（修复不能误杀）');
{
  const h = await openDry('刚写的无 ts 快照',
    { schema: 'desktop-pet/status/v1', sessions: { default: { status: 'running', title: 'manual-acceptance' } } });
  eq('主状态 = running（写入时刻就是"现在"）', h.first.status, 'running');
  eq('面板里这条会话显示为"0 秒前"', h.first.sessions.length === 1 ? Math.round((h.vt.t - h.first.sessions[0].ts) / 1000) : null, 0);
  h.stop();
}

// —— ③ 修复点：无 ts + 文件 mtime 倒回 1 小时 ——
section('③ 无 ts + mtime 倒回 1 小时 → 启动即判静默（**这次的修复点**）');
let fixed = null;
{
  const h = await openDry('陈旧的无 ts 快照',
    { schema: 'desktop-pet/status/v1', sessions: { default: { status: 'running', title: 'manual-acceptance' } } },
    60 * MIN);
  fixed = h;
  const age = Math.round((h.vt.t - statSync(h.file).mtimeMs) / MIN);
  console.log(`  · 文件 mtime 距今 ${age} 分钟（> 15 分钟 = 早该判静默）`);
  check('文件 mtime 确实倒回了 1 小时（前置成立）', age >= 55 && age <= 65, `实测 ${age} 分钟`);
  eq('启动后主状态 = idle（不再"新鲜" 15 分钟）', h.first.status, 'idle');
  eq('面板里不残留这条会话', h.first.sessions.length, 0);
  check('日志里有"静默超过 15 分钟"的留痕', h.logs.some((l) => l.includes('静默超过 15 分钟')),
    h.logs.filter((l) => l.includes('静默')).join(' | ') || '（无）');
  h.stop();
}

// —— ④ 简写形态：{"status":"running"} 同样没有 ts ——
section('④ 简写快照 {"status":"running"}（另一种入口，同样不带 ts）');
{
  const fresh = await openDry('简写·刚写', { status: 'running', title: '手写的一行' });
  eq('刚写的简写快照 → running', fresh.first.status, 'running');
  fresh.stop();
  const old = await openDry('简写·1 小时前', { status: 'running', title: '手写的一行' }, 60 * MIN);
  eq('1 小时前的简写快照 → idle（同一条兜底规则覆盖简写形态）', old.first.status, 'idle');
  old.stop();
}

// —— ⑤ 心跳排除：无 ts 的条目不得被"别的会话被写"续命 ——
// 同一份文件里的所有会话共享一个 mtime；若不把无 ts 条目排除在"ts 变了算心跳"之外，
// 只要任意一条会话被写，所有陈旧会话都会被续命 —— 等于把静默兜底悄悄关掉。
section('⑤ 无 ts 的陈旧会话不会被"别的会话被写"续命');
{
  const file = join(dir, `status-${seq++}.json`);
  writeAged(file, {
    schema: 'desktop-pet/status/v1',
    sessions: {
      a: { status: 'running', title: 'a' },
      b: { status: 'running', title: 'b' },
    },
  }, 60 * MIN);
  const h = boot(file);
  await sleep(400);
  eq('两者都是陈旧的无 ts 会话 → 启动即 idle', h.arb.state.status, 'idle');
  eq('面板 0 行（两条都过期了）', h.arb.viewSessions().length, 0);

  // 只动 a（写文件 → mtime 变新，b 的内容一字未改）
  writeSnapshot(file, {
    schema: 'desktop-pet/status/v1',
    sessions: {
      a: { status: 'running', title: 'a 又动了' },
      b: { status: 'running', title: 'b' },
    },
  });
  await h.settle();
  const rows = h.arb.viewSessions();
  console.log(`  · 只写 a 之后：面板会话=${rows.length ? rows.map((r) => `${r.sessionId}:${r.status}`).join(' / ') : '无'}`);
  eq('被写的那条恢复（真的有人动它）', rows.some((r) => r.sessionId === 'a' && r.status === 'running'), true);
  eq('没被写的那条仍然过期（没有被顺手续命）', rows.some((r) => r.sessionId === 'b'), false);
  h.stop();
}

// —— ⑥ 「清空状态会话」：文件 + 适配器记忆 + 仲裁器记录，三处都要清 ——
section('⑥ 「清空状态会话」之后不再有残留（复刻 main 的三步顺序）');
{
  const file = join(dir, `status-${seq++}.json`);
  writeSnapshot(file, {
    schema: 'desktop-pet/status/v1',
    sessions: {
      a: { status: 'running', title: 'a', ts: Date.now() },
      b: { status: 'needs-input', title: '等你拍板', ts: Date.now() },
    },
  });
  const h = boot(file);
  await sleep(400);
  await h.settle();
  eq('清空前：主状态 = needs-input', h.arb.state.status, 'needs-input');
  eq('清空前：面板 2 行', h.arb.viewSessions().length, 2);

  // 复刻 main/index.ts 的 clearStatusSessions()：① 原子写一份空快照；
  // ② 让适配器忘掉上一次读到的快照（否则空文件会被 diff 成"每条会话都消失了"，
  //    各补一条 idle 收尾 —— 刚清掉的会话立刻以 idle 的形式回来）；
  // ③ 让仲裁器丢掉记录（否则记录仍在：面板照旧列两行、菜单计数照旧是 2）。
  writeSnapshot(file, { schema: 'desktop-pet/status/v1', sessions: {} });
  h.source.reset();
  const changed = h.arb.clearSessions();
  await h.settle();

  const rows = h.arb.viewSessions();
  console.log(`  · 清空后面板会话：${rows.length ? rows.map((r) => `${r.sessionId}:${r.status}`).join(' / ') : '无'}`);
  eq('清空改变了仲裁输出（面板/气泡/托盘都要刷新）', changed, true);
  eq('清空后主状态回落 idle（宠物松手）', h.arb.state.status, 'idle');
  eq('清空后面板行数归零', rows.length, 0);
  check('清空后**没有**"会话已被移除，按 idle 处理"的补事件（reset 生效）',
    !h.logs.some((l) => l.includes('已被移除')), '（仍出现了该日志 ⇒ 适配器记忆没清）');
  // 已经没有任何会话了：此后也不能因为一次读盘重新冒出来
  await h.settle();
  eq('再读几轮文件也不会把会话读回来', h.arb.viewSessions().length, 0);
  h.stop();
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n合计 ${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
