// 托盘/缩放/自启/退出的探针驱动。
// 用法：node spikes/m2-menu/run-tray.mjs
// 除了"启动 → 等落盘 → 打印"，它还多做一件事：**核对退出后进程真的消失**（PID 查询）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(DIR, 'probe-tray.js');
const REPORT = path.join(DIR, 'tray.json');
const LOG = path.join(DIR, 'tray.log');
const STATUS_FILE = path.join(DIR, 'tray-status.json');

for (const f of [REPORT, LOG, STATUS_FILE]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
const pid = child.pid;
child.unref();
console.log(`spawned electron pid=${pid} probe=probe-tray.js`);

const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] report=${fs.existsSync(REPORT)}`);
  if (fs.existsSync(REPORT)) break;
}

console.log('--- probe-tray.log ---');
try { console.log(fs.readFileSync(LOG, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }

// 退出核对：报告落盘后 quit()，等它退，再查 PID 是否还在
await new Promise((r) => setTimeout(r, 6000));
const alive = (() => {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return /electron\.exe/i.test(r.stdout || '');
})();
const logText = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
/** 退出途中抓到的未捕获异常。**只看"进程消失"是不够的** —— 进程崩了也一样会消失。 */
const crashesInLog = logText.split('\n').filter((l) => l.includes('[uncaught]'));

console.log(alive
  ? `\n❌ 退出用例失败：pid=${pid} 仍在运行`
  : crashesInLog.length
    ? `\n❌ 退出用例失败：进程是退了，但**退出途中崩了 ${crashesInLog.length} 次** ——\n`
      + `   第一条：${crashesInLog[0].trim().slice(0, 200)}\n`
      + `   （"进程消失"不等于"退出干净"；2026-09-22 就是被这条漏判坑的，详见 ADR 035）`
    : `\n✅ 退出用例通过：pid=${pid} 已消失，且退出途中没有未捕获异常`);

try {
  const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  console.log(`探针判定：${r.verdict || '(未完成)'} ${r.failures && r.failures.length ? '—— ' + r.failures.join('；') : ''}`);
} catch { /* ignore */ }

// 收尾：确保不自留进程与隔离用的状态文件
try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }
