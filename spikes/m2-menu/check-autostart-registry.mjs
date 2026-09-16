'use strict';
// 自启注册表的**第二来源**核对：Electron 的 getLoginItemSettings 说"开了"，
// 但用户关心的是注册表里真有这一项（否则开机什么都不会发生）。
// 注册表读法用 PowerShell（本机安全策略禁用了 reg.exe，见 journal）。
//
// 用法：node spikes/m2-menu/check-autostart-registry.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const HOLD = path.join(DIR, 'autostart-hold.js');
const LOG = path.join(DIR, 'autostart-hold.log');

const REG = "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue | " +
  "Select-Object -Property * -ExcludeProperty PS* | ConvertTo-Json -Compress";
const query = () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', REG], { encoding: 'utf8' });
  return (r.stdout || '').trim() || '(空)';
};

console.log('写入前的 Run 项：', query());

try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(EXE, [HOLD], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();

await new Promise((r) => setTimeout(r, 6000));
console.log('写入后的 Run 项：', query());
console.log('holding…');

await new Promise((r) => setTimeout(r, 22000));
console.log('撤销后的 Run 项：', query());
try { console.log('--- 探针日志 ---\n' + fs.readFileSync(LOG, 'utf8')); } catch { /* ignore */ }
try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
