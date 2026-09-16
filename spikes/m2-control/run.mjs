// 控制条探针的驱动：启动 → 等落盘 → 打印日志与判定。
// 用法：node spikes/m2-control/run.mjs [key-path|control|all]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const PROBES = {
  'key-path': { file: 'probe-key-path.js', report: 'key-path.json', log: 'key-path.log' },
  control: { file: 'probe-control.js', report: 'control.json', log: 'control.log' },
};

const which = process.argv[2] ?? 'all';
const names = which === 'all' ? Object.keys(PROBES) : [which];
if (names.some((n) => !PROBES[n])) {
  console.error(`未知探针：${which}（可选 ${Object.keys(PROBES).join(' / ')} / all）`);
  process.exit(2);
}

let failed = 0;
for (const name of names) {
  const p = PROBES[name];
  const report = path.join(DIR, p.report);
  const log = path.join(DIR, p.log);
  const STATUS_FILE = path.join(DIR, 'probe-status.json');
  for (const f of [report, log, STATUS_FILE]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;      // 宿主是 Electron：这个变量会让 electron.exe 退化成纯 node
  const child = spawn(EXE, [path.join(DIR, p.file)], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
  child.unref();
  console.log(`\n=== ${name} ===\nspawned electron pid=${child.pid} probe=${p.file}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await new Promise((r) => setTimeout(r, 4000));
    if (fs.existsSync(report)) break;
  }
  try { console.log(fs.readFileSync(log, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }
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
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(failed === 0 ? '\n全部探针 PASS' : `\n${failed} 个探针未通过`);
process.exit(failed === 0 ? 0 : 1);
