// M0 探针：全屏检测与自动让位
//
// 检测信号取两个互补来源：
//   1) 前台窗口矩形是否覆盖其所在显示器的整个矩形（覆盖最大化 / 无边框全屏）
//   2) SHQueryUserNotificationState 是否为 RUNNING_D3D_FULL_SCREEN（覆盖独占全屏的游戏）
// 另外用 EnumWindows 做不依赖焦点的兜底扫描。
//
// 验证方式：拉起一个铺满主显示器的窗口，看检测是否翻转为 true，撤掉后是否回落。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { api, C, pump, detectFullscreen, scanCoversMonitor, primaryMonitorRect } = require('./win32');

const NODE = process.execPath;
const HERE = __dirname;

function snapshot(label) {
  const d = detectFullscreen();
  const s = scanCoversMonitor(null);
  const line = {
    label,
    fgTitle: d.fgTitle,
    foregroundCoversMonitor: d.foregroundCoversMonitor,
    fgRect: d.fgRect || null,
    quns: d.qunsName,
    scanCovers: s.found,
    scanWindows: (s.windows || []).map((w) => w.title).slice(0, 3),
  };
  console.log(JSON.stringify(line));
  return line;
}

(async () => {
  const mon = primaryMonitorRect();
  console.log('主显示器矩形:', JSON.stringify(mon));
  const out = { at: new Date().toISOString(), monitor: mon, steps: [] };

  out.steps.push(snapshot('baseline-无全屏窗口'));

  // 拉起铺满主显示器的靶窗口
  const logPath = path.join(HERE, '_target-fullscreen.log');
  const child = spawn(NODE, [path.join(HERE, 'target-window.js'),
    mon.left, mon.top, mon.right - mon.left, mon.bottom - mon.top, logPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('全屏靶窗口启动超时')), 15000);
    child.stdout.on('data', (d) => { if (/READY/.test(d.toString())) { clearTimeout(t); resolve(); } });
  });
  pump(600);
  out.steps.push(snapshot('fullscreen-铺满窗口已存在'));

  fs.writeFileSync(logPath + '.stop', '1');
  await Promise.race([
    new Promise((r) => child.on('exit', r)),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  child.kill();
  pump(600);
  out.steps.push(snapshot('after-撤掉全屏窗口'));
  try { fs.unlinkSync(logPath); } catch (e) { /* 忽略 */ }

  fs.writeFileSync(path.join(HERE, 'result-fullscreen.json'), JSON.stringify(out, null, 2));
  console.log('\n结果已写入 result-fullscreen.json');
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
