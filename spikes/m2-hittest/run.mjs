// 探针驱动：GUI 子系统进程无法在前台捕获输出，所以「启动 → 阻塞等待落盘 → 打印」一条命令内完成。
// 用法：node spikes/m2-hittest/run.mjs [探针文件名] [产出文件名]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = '<工程目录>';
const DIR = ROOT + '/spikes/m2-hittest';
const EXE = ROOT + '/node_modules/electron/dist/electron.exe';
const probeName = process.argv[2] || 'probe.js';
const PROBE = DIR + '/' + probeName;
const REPORT = DIR + '/' + (process.argv[3] || 'report.json');
const LOG = DIR + '/' + probeName.replace(/\.js$/, '') + '.log';

try { fs.unlinkSync(REPORT); } catch {}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;      // 宿主会注入，否则 Electron 退化成纯 Node

const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`spawned electron pid=${child.pid} probe=${probeName}`);

const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  await new Promise((r) => setTimeout(r, 6000));
  const size = fs.existsSync(LOG) ? fs.statSync(LOG).size : -1;
  const done = fs.existsSync(REPORT);
  console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] report=${done} log=${size}B`);
  if (done) break;
}
console.log('--- ' + probeName + ' 日志 ---');
try { console.log(fs.readFileSync(LOG, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }
