// 探针驱动：GUI 子系统进程拿不到 stdout，所以「启动 → 阻塞等待落盘 → 打印报告」一条命令内完成。
// 用法：node spikes/m2-menu/run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(DIR, 'probe-menu-native.js');
const REPORT = path.join(DIR, 'menu-native.json');
const LOG = path.join(DIR, 'menu-native.log');

try { fs.rmSync(REPORT, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;      // 宿主注入，否则 Electron 退化成纯 Node

const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`spawned electron pid=${child.pid} probe=probe-menu-native.js`);

const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] report=${fs.existsSync(REPORT)} log=${fs.existsSync(LOG) ? fs.statSync(LOG).size + 'B' : -1}`);
  if (fs.existsSync(REPORT)) break;
}

console.log('--- probe-menu-native.log ---');
try { console.log(fs.readFileSync(LOG, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }
console.log('--- menu-native.json ---');
try { console.log(fs.readFileSync(REPORT, 'utf8')); } catch (e) { console.log('(no report) ' + e.message); }
