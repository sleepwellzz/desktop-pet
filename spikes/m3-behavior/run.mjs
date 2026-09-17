// 行为层探针的驱动：启动 → 等落盘 → 打印日志与判定。
//
// 用法：node spikes/m3-behavior/run.mjs
// 跑之前先构建（探针读的是 dist/）：node tools/npm-run.mjs build
//
// 为什么单独一个 run.mjs 而不是直接跑 electron：GUI 进程拿不到 stdout，
// 探针把日志与判定写进文件，驱动负责读出来并给退出码 —— 与 spikes/m2-control 同一套。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const PROBE = { file: 'probe-behavior.js', report: 'behavior.json', log: 'behavior.log' };
const report = path.join(DIR, PROBE.report);
const logFile = path.join(DIR, PROBE.log);
const STATUS_FILE = path.join(DIR, 'probe-status.json');
for (const f of [report, logFile, STATUS_FILE]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;      // 宿主是 Electron：这个变量会让 electron.exe 退化成纯 node
const child = spawn(EXE, [path.join(DIR, PROBE.file)], {
  cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true,
});
child.unref();
console.log(`spawned electron pid=${child.pid} probe=${PROBE.file}`);

const TIMEOUT_MS = Number(process.env.PET_BEHAVIOR_TIMEOUT_MS || 240000);
const t0 = Date.now();
while (Date.now() - t0 < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 4000));
  if (fs.existsSync(report)) break;
}
try { console.log(fs.readFileSync(logFile, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }

let failed = 0;
try {
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  console.log(`探针判定：${r.verdict || '(未完成)'}${r.failures?.length ? ' —— ' + r.failures.join('；') : ''}`);
  if (r.verdict !== 'PASS') failed += 1;
} catch {
  console.log('探针判定：(报告未生成)');
  failed += 1;
}
try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }

console.log(failed === 0 ? '\n行为层探针 PASS' : '\n行为层探针未通过');
process.exit(failed === 0 ? 0 : 1);
