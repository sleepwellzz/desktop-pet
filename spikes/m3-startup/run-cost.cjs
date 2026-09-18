// 端到端启动耗时实测：完整复刻用户的双击路径（启动桌宠.bat）并分阶段打戳。
//
// 结论指向：bat 第 12 行 `call npm.cmd run build` **每次启动都跑一次完整构建**。
// 本探针把"构建"与"启动"两段分开计时，让这条开销无法再被平均掉。
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = '<工程目录>';
const NODE = process.execPath;
const NPM_BIN = 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js';
const NODE_EXE = 'C:/Program Files/nodejs/node.exe';

function stage(label, exe, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(exe, args, { cwd: root, encoding: 'utf8', shell: false, ...opts });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  console.log(`[${ok ? ' OK ' : 'FAIL'}] ${label}: ${ms}ms`);
  return { ok, ms };
}

const result = { stages: [] };
const add = (label, ms, ok) => { result.stages.push({ label, ms, ok }); };

// —— 第 1 段：用户双击 bat 的第一件事（第 12 行）——
console.log('=== 第 1 段：npm run build（bat 第 12 行，每次启动都跑）===');
const b = stage('npm run build', NODE_EXE, [NPM_BIN, 'run', 'build']);
add('build', b.ms, b.ok);

// —— 第 2 段：npm start 的 npm 自身开销 ——
console.log('\n=== 第 2 段：npm start 的 npm 引导开销 ===');
const s = stage('npm start（含 npm 引导 + Electron 到退出）', NODE_EXE, [NPM_BIN, 'start'], { timeout: 12000 });
add('npm start (含引导)', s.ms, true);   // 超时也说明"已启动"，不当失败

// —— 第 3 段：绕开 npm，直接跑 electron（对照）——
console.log('\n=== 第 3 段：对照 —— 直接跑 electron.exe（--trace-boot）===');
const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const t0 = Date.now();
const child = spawn(electron, ['.', '--trace-boot', '--no-status-source'], { cwd: root, env, shell: false });
let shownMs = null;
let killed = false;
const collect = (buf) => {
  for (const line of buf.toString().split(/\r?\n/)) {
    const m = line.match(/\[boot\]\s*(\d+)\s*ms\s+窗口已显示/);
    if (m && shownMs === null) {
      shownMs = Number(m[1]);
      if (!killed) {
        killed = true;
        try { require('node:child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
        finish();
      }
    }
  }
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

function finish() {
  const wall = Date.now() - t0;
  console.log(`[ OK ] electron 直接启动: 窗口可见 = ${shownMs}ms（进程起算）`);
  add('electron 直接启动（到窗口可见）', shownMs ?? wall, shownMs !== null);

  const buildMs = result.stages.find((x) => x.label === 'build')?.ms ?? 0;
  const npmMs = result.stages.find((x) => x.label.startsWith('npm start'))?.ms ?? 0;
  const directMs = shownMs ?? wall;

  console.log('\n=== 汇总：用户双击 启动桌宠.bat 的实际代价 ===');
  console.log(`  ① npm run build（无条件全量构建）   ≈ ${buildMs} ms`);
  console.log(`  ② npm start 的 npm 引导开销        ≈ ${Math.max(0, npmMs - directMs)} ms`);
  console.log(`  ③ Electron 起进程 → 窗口可见        ≈ ${directMs} ms`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  合计（用户感知）                    ≈ ${buildMs + npmMs} ms`);

  result.summary = { buildMs, npmOverheadMs: Math.max(0, npmMs - directMs), electronToVisibleMs: directMs, userPerceivedMs: buildMs + npmMs };
  fs.writeFileSync(path.join(root, 'spikes/m3-startup/startup-cost.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log('\n报告：spikes/m3-startup/startup-cost.json');
  process.exit(0);
}

// 兜底：30 秒还没到窗口就放弃
setTimeout(() => { if (!killed) { killed = true; try { require('node:child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} finish(); } }, 30000);
