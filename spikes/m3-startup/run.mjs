// 启动耗时探针：在 boot() 的关键节点打戳，量出"从进程起跑到窗口可见"的分布。
//
// 为什么必须实测而不能靠读代码推断：
//   启动耗时是"加总效应" —— 十几个几十毫秒的同步调用叠起来才是用户感知到的"数秒"，
//   单看任何一处都"看起来没问题"。本项目已有五次"推断的结论被实测推翻"。
//
// 用法（从工程根目录）：
//   node spikes/m3-startup/run.mjs
// 产出：startup-timing.json（各阶段毫秒数）
//
// 手段：用 Node 侧 spawn electron，读主进程 stdout 里的打戳行。
// 打戳行由 src/main/index.ts 在 `--trace-boot` 下输出（生产路径零开销）。
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!existsSync(electron)) {
  console.error('找不到 electron：' + electron);
  process.exit(1);
}

// 从 env 里删掉 ELECTRON_RUN_AS_NODE：宿主 WorkBuddy 自己是 Electron 应用，
// 会把该变量继承给子进程，导致 electron.exe 退化成纯 Node 模式（app 为 undefined）。
const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

const t0 = Date.now();
const child = spawn(electron, ['.', '--trace-boot', '--no-status-source'], {
  cwd: root,
  env,
  shell: false,
  windowsHide: false,
});

const lines = [];
child.stdout.on('data', (b) => {
  const s = b.toString();
  for (const line of s.split(/\r?\n/)) if (line.trim()) lines.push(line.trim());
});
child.stderr.on('data', (b) => {
  const s = b.toString();
  for (const line of s.split(/\r?\n/)) if (line.trim()) lines.push('[err] ' + line.trim());
});

// 观察到"窗口已显示"就打戳收工 —— 那是用户能看见宠物的时刻。
// 上限 60 秒（首次启动可能被 Windows Defender 扫）。
const DEADLINE = 60_000;

function finish(reason) {
  const elapsed = Date.now() - t0;
  const marks = [];
  for (const l of lines) {
    const m = l.match(/\[boot\]\s*\+?(\d+)\s*ms\s+(.*)$/);
    if (m) marks.push({ ms: Number(m[1]), label: m[2] });
  }
  const report = {
    ok: lines.some((l) => l.includes('窗口已显示')),
    reason,
    spawnToExitMs: elapsed,
    marks,
    rawTail: lines.slice(-40),
  };
  writeFileSync(join(here, 'startup-timing.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n=== 启动耗时（spawn → 收尾，${elapsed}ms）===`);
  if (marks.length === 0) {
    console.log('（没有采到任何打戳行 —— 检查 --trace-boot 是否真的输出）');
    console.log(report.rawTail.join('\n'));
  } else {
    for (const m of marks) console.log(String(m.ms).padStart(8) + ' ms  ' + m.label);
  }
  console.log('\n报告：spikes/m3-startup/startup-timing.json');

  try { process.kill(child.pid); } catch { /* 已退出 */ }
  // 只杀自己这条进程树：child.kill 带不走 detached 的 Electron（ADR 010 负面结论）
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  process.exit(report.ok ? 0 : 1);
}

const timer = setInterval(() => {
  if (lines.some((l) => l.includes('窗口已显示'))) { clearInterval(timer); setTimeout(() => finish('窗口已显示'), 800); }
}, 100);

setTimeout(() => { clearInterval(timer); finish('超时'); }, DEADLINE);
