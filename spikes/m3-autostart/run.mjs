// 对照实验：`app.setName()` 到底能不能改注册表值名。
// 会临时写 HKCU\...\Run —— 驱动负责**先备份、后恢复**，不破坏用户已勾选的自启。
//
// 用法：node spikes/m3-autostart/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const REG = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const TMP = path.join(HERE, 'reg-snapshot.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRun(outFile) {
  const r = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-ItemProperty -Path "${REG}" | Out-File -FilePath "${outFile}" -Encoding utf8`,
  ], { encoding: 'utf8', windowsHide: true });
  return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : `(读失败 status=${r.status})`;
}

/** 抓出所有电子 slugs：值名 -> 命令 */
function pickElectronEntries(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(electron\.app\.[A-Za-z0-9_.]+|\bdesktop-pet\b)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

console.log('=== 0. 备份用户当前的 Run 键 ===');
const before = readRun(TMP);
const beforeEntries = pickElectronEntries(before);
console.log(JSON.stringify(beforeEntries, null, 1));

async function runCase(name, args) {
  console.log(`\n=== ${name} ===`);
  const outFile = path.join(HERE, `reg-${name}.txt`);
  for (const f of [outFile, path.join(HERE, 'probe.log')]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  const env = { ...process.env, PET_AUTOSTART_OUT: outFile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [path.join(HERE, 'probe.js'), ...args], {
    cwd: ROOT, env, stdio: 'ignore', detached: true, windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40 && !fs.existsSync(outFile); i++) await sleep(1000);
  await sleep(1500);
  try { process.kill(child.pid); } catch { /* 已退出 */ }
  const text = readRun(outFile);
  const entries = pickElectronEntries(text);
  console.log('  ' + (fs.existsSync(path.join(HERE, 'probe.log')) ? fs.readFileSync(path.join(HERE, 'probe.log'), 'utf8').trim().split('\n').join('\n  ') : '(无 probe.log)'));
  console.log('  Run 键里自启相关项：' + JSON.stringify(entries));
  return entries;
}

const without = await runCase('baseline', []);
const withName = await runCase('setname', ['--set-name']);

console.log('\n===== 对照结论 =====');
const baseKeys = Object.keys(without).filter((k) => k.startsWith('electron.app.'));
const nameKeys = Object.keys(withName).filter((k) => !k.startsWith('electron.app.'));
console.log(`  未 setName → 值名：${JSON.stringify(baseKeys)}`);
console.log(`  setName 后 → 值名：${JSON.stringify(Object.keys(withName))}`);
if (nameKeys.length) console.log(`✅ app.setName('desktop-pet') **有效**：值名变成了 ${JSON.stringify(nameKeys)}`);
else console.log('❌ app.setName 没能改变值名 —— 只能走改 exe 版本资源那条路（ADR 034 方案 C）');

// 收尾：把用户的自启恢复到探针动手之前的样子
console.log('\n=== 收尾：恢复用户原本的自启设置 ===');
const after = readRun(TMP);
const afterEntries = pickElectronEntries(after);
console.log('  恢复前：' + JSON.stringify(afterEntries));
for (const [name, cmd] of Object.entries(beforeEntries)) {
  const escaped = String(cmd).replace(/'/g, "''");
  const r = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Set-ItemProperty -Path "${REG}" -Name "${name}" -Value '${escaped}'`,
  ], { encoding: 'utf8', windowsHide: true });
  console.log(`  写回 ${name}：status=${r.status}${r.stderr ? ' err=' + String(r.stderr).slice(0, 120) : ''}`);
}
const restored = pickElectronEntries(readRun(TMP));
console.log('  恢复后：' + JSON.stringify(restored));
console.log('  ⚠️ 若上面缺了某项（探针写入覆盖了用户的便携版条目），需要手动确认 —— 见输出');
