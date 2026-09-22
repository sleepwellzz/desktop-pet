'use strict';
/**
 * 探针：`app.setName()` 能不能改掉开机自启在注册表里的**值名**？（挂起 #15）
 *
 * 背景：2026-09-22 用户在便携版勾选开机自启后，实测写出的项是
 *   `electron.app.Electron = "...\dist-win\desktop-pet\desktop-pet.exe"`
 * 命令形态是对的，**自启功能是好的**，坏的只是它在注册表里叫 electron.app.Electron。
 *
 * 上一轮（ADR 034）把 `app.setName()` 这条路判成"大概率无效"，依据是 Electron 文档说
 * setName「does not affect the name that the OS uses」。**那个推理不成立** ——
 * 注册表值名不是 OS 决定的，是 Electron 自己写进去的，用的是它内部的 GetName()。
 * 所以这里老老实实做对照：同一份 autostart.js，跑两遍，只差一个 setName。
 *
 * 用法（由 run.mjs 驱动，**不要手动跑**，它会动 HKCU 的 Run 键）：
 *   electron.exe spikes/m3-autostart/probe.js [--set-name]
 */
const { app } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const OUT = process.env.PET_AUTOSTART_OUT || path.join(HERE, 'reg.txt');

const useSetName = process.argv.includes('--set-name');
if (useSetName) app.setName('desktop-pet');

const log = (m) => fs.appendFileSync(path.join(HERE, 'probe.log'), m + '\n');
try { fs.writeFileSync(path.join(HERE, 'probe.log'), ''); } catch { /* ignore */ }
globalThis.console = { log, warn: log, error: log };

app.whenReady().then(() => {
  log(`setName=${useSetName}｜app.getName()=${app.getName()}｜isPackaged=${app.isPackaged}`);
  const { writeAutoStart, isAutoStartEnabled } = require(path.join(ROOT, 'dist', 'host', 'autostart.js'));
  try {
    writeAutoStart(true);
    log(`writeAutoStart(true) 后回读=${isAutoStartEnabled()}`);
  } catch (e) {
    log('自启写入失败：' + ((e && e.stack) || e));
  }
  // 第二来源：直接用 PowerShell 把 Run 键读回来（reg.exe 被沙箱拦，这条路走得通）
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" | Out-File -FilePath "${OUT}" -Encoding utf8`,
  ], { encoding: 'utf8', windowsHide: true });
  log(`读注册表：status=${ps.status}`, ps.stderr ? `stderr=${String(ps.stderr).slice(0, 200)}` : '');
  app.exit(0);
});
