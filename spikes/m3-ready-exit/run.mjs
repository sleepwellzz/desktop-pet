// 探针驱动：起一个 Electron，注入一条 ready，核对渲染层实际绘制的帧行号是否按通报时效退场。
//
// 为什么要外层驱动（与 spikes/m2-status/run-status-e2e.mjs 同因）：
//   - GUI 进程拿不到 stdout，所以日志落盘、驱动读盘；
//   - "写状态的进程"与"看状态的进程"必须是两个进程，那才是真实拓扑。
//
// 用法：node spikes/m3-ready-exit/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(DIR, 'probe-ready-exit.js');
const REPORT = path.join(DIR, 'ready-exit.json');
const LOG = path.join(DIR, 'ready-exit.log');
const STATUS_FILE = path.join(DIR, 'ready-exit-status.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };

for (const f of [REPORT, STATUS_FILE, LOG]) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const RUN = `${Date.now()}-${process.pid}`;
const env = { ...process.env, PET_READY_RUN: RUN };
delete env.ELECTRON_RUN_AS_NODE;   // 宿主注入，否则 Electron 退化成纯 Node
const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`已启动桌宠（pid=${child.pid}），等待探针开始采样 …`);

const failures = [];
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !/\[probe\] 采样结束/.test(readLog())) {
    if (/\[probe\] 失败/.test(readLog())) break;
    await sleep(500);
  }
  if (!fs.existsSync(REPORT)) throw new Error('探针没有产出报告（超时或崩溃）');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));

  console.log('\n=== 应用侧日志 ===');
  for (const line of readLog().split('\n')) {
    if (/\[pet\]/.test(line) && /ready|idle|推送|状态 /.test(line)) console.log('  ' + line);
  }

  console.log('\n=== 帧行号核对（渲染层实际在画什么） ===');
  console.log(`  通报时效 = ${report.readyMs}ms，采样 ${report.samples.length} 个点，观察 ${report.durationMs / 1000}s`);
  console.log(`  通报期内（<${report.readyMs}ms）行号：[${(report.rowsDuring ?? []).join(', ')}]   ← 期望含 8（小厨师）`);
  console.log(`  到期后（>${report.readyMs}ms）行号：[${(report.rowsAfter ?? []).join(', ')}]   ← 期望为 0（idle）且不含 8`);
  failures.push(...(report.failures ?? []));
  if (report.error) failures.push(report.error);

  // 把行号随时间的轨迹也打出来（取证用）
  const trail = report.samples.map((s) => `${(s.t / 1000).toFixed(1)}s:${s.row}`);
  console.log(`\n  轨迹：${trail.join(' ')}`);

  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(DIR, 'ready-exit-summary.json'), JSON.stringify({
    结论: verdict, 失败项: failures, 通报时效ms: report.readyMs,
    通报期内行号: report.rowsDuring, 到期后行号: report.rowsAfter,
  }, null, 1));
  console.log(`\n探针判定：${verdict}`);
  for (const f of failures) console.log('  - ' + f);
} catch (e) {
  console.log('驱动失败：' + ((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  // 只杀自己这条进程树（桌宠是 detached 的）。绝不能按镜像名杀 electron.exe
  // —— WorkBuddy 自身也是 Electron 应用。
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }
}
process.exit(process.exitCode ?? (failures.length ? 1 : 0));
