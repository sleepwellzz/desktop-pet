// 端到端驱动：扮演 agent，用真实 hook CLI 往状态文件里写状态，然后核对宠物**实际绘制的帧行号**。
//
// 为什么要外层驱动：GUI 进程拿不到 stdout（见 spikes/m2-hittest/README.md），
// 而且这一步必须让"写状态的进程"与"看状态的进程"是分开的两个进程 —— 那才是真实拓扑。
//
// 用法：node spikes/m2-status/run-status-e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(DIR, 'probe-status-e2e.js');
const REPORT = path.join(DIR, 'status-e2e.json');
const LOG = path.join(DIR, 'status-e2e.log');
const STATUS_FILE = path.join(DIR, 'status-e2e-status.json');
const HOOK = path.join(ROOT, 'tools', 'pet-hook.mjs');

/** 每个业务状态期望出现的帧行号（精灵图行语义，见 codex-pet-pack 技能）。 */
const ROWS = { idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };

// 时间线：六步覆盖五个业务状态 + 「会话被移除」的收尾路径。
// ready 特意放在 needs-input 之后清理过的干净会话上，否则会被粘滞挡住（那是正确行为，但演示不清）。
const STEPS = [
  { status: 'running', expect: [ROWS.running], why: '处理中 → 第 7 行' },
  { status: 'needs-input', expect: [ROWS.waiting], why: '需要输入 → 第 6 行（等待）' },
  { clear: true, expect: [ROWS.idle], why: '会话被移除 → 收尾回 idle' },
  { status: 'ready', expect: [ROWS.waving, ROWS.review], why: '就绪 → 挥手(3) 后落到 review(8)' },
  { status: 'blocked', expect: [ROWS.failed], why: '受阻 → 第 5 行（趴卧）' },
  { status: 'idle', expect: [ROWS.idle], why: '任务结束 → 回 idle' },
];
const STEP_GAP_MS = 1800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } }
async function waitForLog(pattern, timeoutMs, what) {
  const re = new RegExp(pattern);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (re.test(readLog())) return true;
    await sleep(300);
  }
  console.log(`  ✗ 等待超时：${what}`);
  return false;
}

try { fs.rmSync(REPORT, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }
// 必须连日志一起清掉：探针要等 Electron 起来才会截断它，中间这段时间驱动会读到
// 上一次运行的残留日志，把"探针已开始采样"误判成成立（实测踩过）。
try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }

// 运行标识：与探针共享，用来确认日志里的就绪行确实出自本次运行。
const RUN = `${Date.now()}-${process.pid}`;
const env = { ...process.env, PET_E2E_RUN: RUN };
delete env.ELECTRON_RUN_AS_NODE;      // 宿主注入，否则 Electron 退化成纯 Node
env.PET_ALLOW_MULTI = '1';   // 单实例锁的逃生开关：探针要能独立起实例（P0-6）
const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`已启动桌宠（pid=${child.pid}，run=${RUN}），等待状态源就绪 …`);

const failures = [];
/**
 * 调一次真实 hook CLI（这就是"扮演 agent"的那一半：写状态的进程与看状态的进程分开）。
 *
 * ⚠️ **2026-09-29 从 `spawnSync` 改成异步 `spawn`**：本机沙箱会**间歇性**直接拒绝同步起进程
 * （`spawnSync` 返回 `status: null`，进程根本没起来），于是一次重跑把六个步骤全判成
 * `hook 调用失败（…）：null` ⇒ **整条判据 FAIL，而它要测的东西根本没被触发**。
 * 这正是 ADR 044 §2 那条纪律的现场："断言不该被它测以外的东西判红"。
 * 异步 `spawn` 在同一环境里正常（`make-portable.mjs` 的 `rcedit` 也是因此从 spawnSync 换过来的）。
 */
async function runHook(step) {
  const args = [HOOK, ...(step.status ? [step.status] : []), `--file=${STATUS_FILE}`];
  if (step.clear) args.push('--clear');
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.stderr.on('data', (d) => { out += d.toString(); });
    c.on('error', (e) => resolve({ code: null, out: `spawn error: ${e.code} ${e.message}` }));
    c.on('close', (code) => resolve({ code, out }));
  });
  if (r.code !== 0) failures.push(`hook 调用失败（${step.status ?? '--clear'}）：${r.out.trim() || r.code}`);
}

try {
  if (!(await waitForLog('\\[pet\\] 状态源：', 25000, '状态源启动'))) throw new Error('应用未就绪');
  const marker = new RegExp(`\\[probe\\] 采样开始 run=${RUN} epoch=\\d+`);
  if (!(await waitForLog(marker.source, 25000, '探针开始采样（本次运行）'))) throw new Error('探针未开始采样');
  const raw = readLog();
  const baseLogLen = raw.length;
  const epoch = Number((raw.match(new RegExp(`采样开始 run=${RUN} epoch=(\\d+)`)) || [])[1]);
  console.log(`  探针开始采样（epoch=${epoch}），开始注入 …`);

  const timeline = [];
  for (const step of STEPS) {
    const at = Date.now();
    await runHook(step);
    timeline.push({ ...step, at, from: at + 400, to: at + STEP_GAP_MS });
    console.log(`  → 注入 ${step.clear ? '--clear' : step.status}（${step.why}）`);
    await sleep(STEP_GAP_MS);
  }

  // 等探针收尾并落盘
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !fs.existsSync(REPORT)) await sleep(500);
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const appLog = readLog().slice(baseLogLen);

  console.log('\n=== 链路日志（应用侧） ===');
  for (const line of appLog.split('\n')) {
    if (/\[pet\]\[status\]|\[pet\]\[renderer\] 状态|\[pet\]\[source\]/.test(line)) console.log('  ' + line);
  }

  console.log('\n=== 帧行号核对（渲染层实际在画什么） ===');
  for (const step of timeline) {
    const inWindow = report.samples.filter((s) => s.t >= step.from && s.t <= step.to).map((s) => s.row);
    // ready 要求顺序：先挥手再落到 review
    let ok;
    if (step.expect.length === 1) {
      ok = inWindow.includes(step.expect[0]);
    } else {
      const first = inWindow.indexOf(step.expect[0]);
      ok = first >= 0 && inWindow.slice(first + 1).includes(step.expect[1]);
    }
    const label = step.clear ? '--clear' : step.status;
    const seen = [...new Set(inWindow)].join(',') || '(无采样)';
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(12)} 期望行 [${step.expect.join(' → ')}]，实际出现 [${seen}]`);
    if (!ok) failures.push(`${label}：期望行 ${step.expect.join('→')}，实际 ${seen}`);
  }

  // 链路自述也要对得上：主进程推送过、渲染层收过
  for (const step of STEPS) {
    if (!step.status) continue;
    if (!new RegExp(`\\[pet\\]\\[status\\] 推送 ${step.status}`).test(appLog)) failures.push(`主进程没有推送 ${step.status}`);
    if (!new RegExp(`\\[pet\\]\\[renderer\\] 状态 ${step.status}`).test(appLog)) failures.push(`渲染层没有收到 ${step.status}`);
  }
  const eventCount = fs.existsSync(path.join(DIR, 'status-e2e-events.jsonl'))
    ? fs.readFileSync(path.join(DIR, 'status-e2e-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  console.log(`\n事件流水（events.jsonl）共 ${eventCount} 条，采样点 ${report.samples.length} 个`);

  const fsReport = {
    结论: failures.length === 0 ? 'PASS' : 'FAIL',
    失败项: failures,
    时间线: timeline.map((t) => ({ 注入: t.clear ? '--clear' : t.status, 期望行: t.expect, 起: t.from, 止: t.to })),
    采样行号: [...new Set(report.samples.map((s) => s.row))].sort((a, b) => a - b),
    事件条数: eventCount,
  };
  fs.writeFileSync(path.join(DIR, 'status-e2e-summary.json'), JSON.stringify(fsReport, null, 1));
  console.log(`\n结论：${fsReport.结论}`);
  for (const f of failures) console.log('  - ' + f);
} catch (e) {
  console.log('驱动失败：' + ((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  // 只杀自己这条进程树：桌宠是 detached 的，child.kill() 不一定带得走它下面的渲染进程，
  // 而残留实例会继续读写同一个状态文件、污染下一次运行。绝不能按镜像名杀 electron.exe
  // —— WorkBuddy 自身也是 Electron 应用。
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
  try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }
}
process.exit(process.exitCode ?? (failures.length ? 1 : 0));
