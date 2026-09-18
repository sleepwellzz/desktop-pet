// 判据 6 的落地验证：桌宠真的会把 `recvAt` 写进事件流水，且能算出端到端延迟。
//
// 为什么不能只靠读代码：`recordEvent()` 在 `boot()` 内部，单测够不着；
// 而"字段写了但没落盘""落盘了但时间基准不对"都不会报错 —— 只有真跑一遍才知道。
// （本项目纪律：平台行为一律探针实测，不推断。）
//
// 拓扑与真实场景一致：**写状态的进程**（pet-hook.mjs）与**看状态的进程**（桌宠）是两个进程。
// 用法：node spikes/m3-latency/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const EVENTS = path.join(homedir(), '.desktop-pet', 'events.jsonl');
const SID = `wb:latency-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readEvents = () => {
  try {
    return fs.readFileSync(EVENTS, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;   // 宿主注入，否则 Electron 退化成纯 Node
const child = spawn(EXE, ['.'], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`已启动桌宠（pid=${child.pid}），等它起来 …`);

const failures = [];
try {
  await sleep(9000);   // 启动 + 状态源就绪（构建产物冷启动约 1 秒，留足余量）

  const before = readEvents().length;
  const statuses = ['running', 'needs-input', 'running', 'ready', 'running', 'idle'];
  const sent = [];
  for (const st of statuses) {
    const t = Date.now();
    spawnSync(process.execPath, [path.join(ROOT, 'tools', 'pet-hook.mjs'), st,
      `--session=${SID}`, '--title=判据6延迟探针'], { stdio: 'ignore', windowsHide: true });
    sent.push({ st, t });
    await sleep(500);
  }
  await sleep(2500);   // 等轮询兜底把最后几条读到

  const rows = readEvents().filter((o) => o['sessionId'] === SID);
  console.log(`\n喂了 ${statuses.length} 条，宠物侧收到 ${rows.length} 条（新增事件总数 ${readEvents().length - before}）`);

  const withRecv = rows.filter((o) => Number.isFinite(Number(o['recvAt'])));
  console.log(`其中**带 recvAt** 的：${withRecv.length} / ${rows.length}`);

  if (!withRecv.length) {
    failures.push('没有任何一条事件带 recvAt —— 判据 6 的时间基准没落地');
  } else {
    const delays = withRecv.map((o) => Number(o['recvAt']) - Number(o['ts'])).sort((a, b) => a - b);
    const fmt = (ms) => `${Math.round(ms)}ms`;
    const p95 = delays[Math.floor(0.95 * delays.length)] ?? delays[delays.length - 1];
    console.log(`\n=== 端到端延迟（recvAt - ts）===`);
    console.log(`  样本 ${delays.length}｜最小 ${fmt(delays[0])}｜中位 ${fmt(delays[Math.floor(delays.length / 2)])}｜p95 ${fmt(p95)}｜最大 ${fmt(delays[delays.length - 1])}`);
    console.log(`  逐条：${withRecv.map((o) => `${o['status']}=${fmt(Number(o['recvAt']) - Number(o['ts']))}`).join('  ')}`);

    // 状态源是"目录监听 + 1000ms 轮询兜底"，所以 1.5 秒是宽松上界；超出说明链路里有别的阻塞。
    if (delays[delays.length - 1] > 1500) {
      failures.push(`最大延迟 ${fmt(delays[delays.length - 1])} 超过 1500ms（状态源是监听+1s 轮询兜底，不该这么慢）`);
    }
    if (delays.some((d) => d < 0)) failures.push('出现了负延迟 —— 时间基准有问题');
  }

  if (rows.length < statuses.length) {
    failures.push(`喂了 ${statuses.length} 条只收到 ${rows.length} 条 —— 有事件丢了`);
  }

  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(DIR, 'latency.json'), JSON.stringify({
    结论: verdict, 失败项: failures, 样本数: withRecv.length,
    延迟ms: withRecv.map((o) => Number(o['recvAt']) - Number(o['ts'])),
  }, null, 1));
  console.log(`\n探针判定：${verdict}`);
  for (const f of failures) console.log('  - ' + f);
} catch (e) {
  console.log('驱动失败：' + ((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  // 只杀自己这条进程树（桌宠是 detached 的）。绝不按镜像名杀 electron.exe —— 宿主自己也是 Electron。
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  try {
    spawnSync(process.execPath, [path.join(ROOT, 'tools', 'pet-hook.mjs'), '--clear',
      `--session=${SID}`], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}
process.exit(process.exitCode ?? (failures.length ? 1 : 0));
