// 离线探针：状态快照里的"陈旧会话"到底会不会被当成"新鲜"。
//
// 起因（PLAN §1 点名的一条**未实测线索**）：状态文件是快照、重启后原样读回；若某条会话记录
// **没有 `ts` 字段**，`kernel/status.ts` 的 ingest 会把它盖章成"现在"，于是这条陈旧会话在启动后
// "新鲜" 15 分钟 —— 表现是"一启动就显示某某在运行中"。
//
// 这条链路横跨两层，任何单层的单测都看不到全貌：
//   source/status-file.ts 刻意**不**补 Date.now()（避免轮询变成假心跳）
//   kernel/status.ts      ingest 对缺失 ts 的兜底是 now
// 所以本探针用**真实的适配器 + 真实的仲裁器 + 真实临时文件**跑，只把时钟换成虚拟的。
//
// 顺带验第二个问题：「清空状态会话」之后，面板/菜单里的那些行到底清没清掉。
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
const STALE_MS = 15 * MIN;                    // 与 kernel/status.ts 的 sessionStaleMs 默认值一致

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

const openDry = async (name, doc, opts = {}) => {
  const file = join(dir, `status-${seq++}.json`);
  writeSnapshot(file, doc);
  if (opts.mtimeMs !== undefined) {
    const s = statSync(file);
    utimesSync(file, s.atime, new Date(opts.mtimeMs));
  }
  const h = boot(file);
  await sleep(400);                           // 等首次读盘（start 里同步读一次，这里留余量）
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

// —— ② 疑似缺陷：同一条会话**只删掉 ts** ——
section('② 疑似缺陷：没有 ts 的陈旧会话（同样的 running，只是没写 ts）');
let suspect = null;
{
  const h = await openDry('无 ts 快照',
    { schema: 'desktop-pet/status/v1', sessions: { default: { status: 'running', title: 'manual-acceptance' } } });
  suspect = h;
  eq('启动后主状态 = running（陈旧会话被盖章成"现在"）', h.first.status, 'running');
  eq('面板里这条会话显示为"0 秒前"', h.first.sessions.length === 1 ? Math.round((h.vt.t - h.first.sessions[0].ts) / 1000) : null, 0);
}

// —— ③ 同一个文件，mtime 倒回 1 小时：文件里明明带着"陈旧"的证据 ——
section('③ 无 ts + 文件 mtime 倒回 1 小时（陈旧性证据其实存在，只是没被用）');
{
  const file = join(dir, `status-${seq++}.json`);
  const old = Date.now() - 60 * MIN;
  writeSnapshot(file, { schema: 'desktop-pet/status/v1', sessions: { default: { status: 'running', title: 'manual-acceptance' } } });
  const s = statSync(file);
  utimesSync(file, s.atime, new Date(old));
  const h = boot(file);
  await sleep(400);
  await h.settle();
  const age = Math.round((h.vt.t - statSync(file).mtimeMs) / MIN);
  console.log(`  · 文件 mtime 距今 ${age} 分钟（> 15 分钟 = 早该判静默）`);
  check('文件 mtime 确实倒回了 1 小时（前置成立）', age >= 55 && age <= 65, `实测 ${age} 分钟`);
  eq('然而主状态仍是 running（兜底拿不到这个证据）', h.arb.state.status, 'running');
  h.stop();
}

// —— ④ 简写形态：{"status":"running"} 同样没有 ts ——
section('④ 简写快照 {"status":"running"}（适配器支持的另一种入口，同样不带 ts）');
{
  const h = await openDry('简写快照', { status: 'running', title: '手写的一行' });
  eq('主状态 = running', h.first.status, 'running');
  check('这条简写的 ts 也是被盖章成"现在"的',
    h.first.sessions.length === 1 && Math.round((h.vt.t - h.first.sessions[0].ts) / 1000) === 0);
  h.stop();
}

// —— ⑤ 持续多久：这就是"一启动就显示某某在运行中"的时长 ——
section('⑤ 续上 ②：这条"新鲜"能撑多久');
if (suspect) {
  await suspect.advance(14 * MIN);
  eq('14 分钟后仍显示 running', suspect.arb.state.status, 'running');
  await suspect.advance(2 * MIN);
  eq('越过 15 分钟后才回落 idle', suspect.arb.state.status, 'idle');
  suspect.stop();
}

// —— ⑥ 「清空状态会话」之后：宠物确实松手了，但面板/菜单里的行还在 ——
section('⑥ 「清空状态会话」之后的残留');
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

  // 复刻 main/index.ts 的 clearStatusSessions()：原子写一份空快照
  writeSnapshot(file, { schema: 'desktop-pet/status/v1', sessions: {} });
  await h.settle();
  eq('清空后：宠物不再显示在运行 / 等输入（主状态回落 idle）', h.arb.state.status, 'idle');
  const rows = h.arb.viewSessions();
  console.log(`  · 清空后面板会话：${rows.length ? rows.map((r) => `${r.sessionId}:${r.status}`).join(' / ') : '无'}`);
  eq('清空后：面板行数归零', rows.length, 0);
  eq('清空后：菜单里「清空状态会话（N 条）」的 N 归零', rows.length, 0);
  check('日志里有"会话已被移除，按 idle 处理"的留痕',
    h.logs.some((l) => l.includes('已被移除')), '（无）');
  h.stop();
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n合计 ${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
