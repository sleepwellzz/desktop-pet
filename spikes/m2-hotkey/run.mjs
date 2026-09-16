// 气泡与快捷键探针的驱动：启动 → 等落盘 → 打印日志与判定。
// 用法：node spikes/m2-hotkey/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(DIR, 'probe-bubble-hotkey.js');
const REPORT = path.join(DIR, 'bubble-hotkey.json');
const LOG = path.join(DIR, 'bubble-hotkey.log');
const STATUS_FILE = path.join(DIR, 'probe-status.json');

for (const f of [REPORT, LOG, STATUS_FILE]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`spawned electron pid=${child.pid} probe=probe-bubble-hotkey.js`);

const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 4000));
  if (fs.existsSync(REPORT)) break;
}
console.log('--- bubble-hotkey.log ---');
try { console.log(fs.readFileSync(LOG, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }
try {
  const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  console.log(`\n探针判定：${r.verdict || '(未完成)'} ${r.failures?.length ? '—— ' + r.failures.join('；') : ''}`);
} catch { /* ignore */ }
try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }
