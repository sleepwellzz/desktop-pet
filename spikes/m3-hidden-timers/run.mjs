// 探针驱动：GUI 子系统进程无法在前台捕获输出，所以「启动 → 阻塞等待落盘 → 打印」一条命令内完成。
// 用法：node spikes/m3-hidden-timers/run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径含空格 ⇒ 必须走 fileURLToPath，不能手拼 `import.meta.url`（会出现 %20）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = ROOT + '/spikes/m3-hidden-timers';
const EXE = ROOT + '/node_modules/electron/dist/electron.exe';
const PROBE = DIR + '/probe.js';
const REPORT = DIR + '/report.json';
const LOG = DIR + '/run.log';

try { fs.unlinkSync(REPORT); } catch {}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;      // 宿主会注入，否则 Electron 退化成纯 Node

const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`spawned electron pid=${child.pid}`);

const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  await new Promise((r) => setTimeout(r, 5000));
  const size = fs.existsSync(LOG) ? fs.statSync(LOG).size : -1;
  const done = fs.existsSync(REPORT);
  console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] report=${done} log=${size}B`);
  if (done) break;
}
console.log('--- 日志 ---');
try { console.log(fs.readFileSync(LOG, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }
