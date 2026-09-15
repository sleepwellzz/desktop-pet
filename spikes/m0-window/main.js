// M0 Electron 宿主验证
//   npm run electron                 可视化 HUD，人工点两下验证
//   npm run electron -- --hit-test   额外装上 WM_NCHITTEST 逐像素命中测试
//   npm run electron -- --self-test  自动点击测试（会拉起另一个进程的靶窗口）
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { koffi, api, C, state, getExStyle, setExStyle, installHitTest, detectFullscreen, getWindowTitle } =
  require('./host/win32-host');
const { pump, clickAt } = require('./probe/win32');

const ARGS = process.argv.slice(2);
const HIT_TEST = ARGS.includes('--hit-test');
const SELF_TEST = ARGS.includes('--self-test');

const W = 220, H = 240;             // 窗口尺寸（略大于单格 192x208）
const CELL = { w: 192, h: 208 };

let win = null;
let hwnd = null;
let mask = null;                    // { w, h, data: Uint8Array }
let lastClick = null;
let hiddenByFullscreen = false;

const sampleAlpha = (x, y) => {
  if (!mask) return true;           // 还没收到掩码时保守处理：整窗可点
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return false;
  return mask.data[(y | 0) * mask.w + (x | 0)] > 8;
};

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: W, height: H,
    x: 320, y: area.height - H - 60,
    transparent: true, frame: false, hasShadow: false,
    skipTaskbar: true, resizable: false, movable: true, fullscreenable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    const before = getExStyle(hwnd);
    const after = setExStyle(hwnd, C.WS_EX_NOACTIVATE | C.WS_EX_TOOLWINDOW, C.WS_EX_APPWINDOW);
    const hitOk = HIT_TEST ? installHitTest(hwnd, sampleAlpha) : false;

    const info = {
      hwnd: String(hwnd),
      exStyleBefore: '0x' + (before >>> 0).toString(16),
      exStyleAfter: '0x' + (after >>> 0).toString(16),
      noActivate: !!(after & C.WS_EX_NOACTIVATE),
      layered: !!(after & C.WS_EX_LAYERED),
      topmost: !!(after & C.WS_EX_TOOLWINDOW) && win.isAlwaysOnTop(),
      hitTestInstalled: hitOk,
      electron: process.versions.electron,
      node: process.versions.node,
    };
    console.log('[pet] 窗口样式 ' + JSON.stringify(info));

    // 用 data URL 传图，避免 file:// 图片污染 canvas 导致 getImageData 抛安全异常
    const sheetPath = path.join(__dirname, '..', '..', 'spritesheet.webp');
    let sheet = null;
    try {
      sheet = 'data:image/webp;base64,' + fs.readFileSync(sheetPath).toString('base64');
    } catch (e) {
      console.log('[pet] 读取图集失败，退回程序绘制: ' + e.message);
    }
    win.webContents.send('pet:init', { sheet, cell: CELL, info });
    win.showInactive();

    if (SELF_TEST) runSelfTest();
  });
}

// —— 全屏检测：命中就让位 ——
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const d = detectFullscreen();
  const shouldHide = d.foregroundCoversMonitor;
  if (shouldHide && !hiddenByFullscreen) { win.hide(); hiddenByFullscreen = true; }
  else if (!shouldHide && hiddenByFullscreen) { win.showInactive(); hiddenByFullscreen = false; }
  win.webContents.send('pet:hud', {
    fgTitle: d.fgTitle,
    fgRect: d.fgRect || '',
    monitorRect: d.monitorRect || '',
    coversMonitor: d.foregroundCoversMonitor,
    quns: d.qunsName,
    hiddenByFullscreen,
    lastHit: state.lastHit,
    hitCount: state.hitCount,
    lastClick,
    exStyle: hwnd ? '0x' + (getExStyle(hwnd) >>> 0).toString(16) : null,
  });
}, 400);

ipcMain.on('pet:mask', (_e, m) => { mask = { w: m.w, h: m.h, data: Uint8Array.from(m.data) }; });
const petClicks = [];
ipcMain.on('pet:clicked', (_e, c) => { lastClick = c; petClicks.push(c); });

// —— 自动点击测试：拉起另一个进程的靶窗口垫在下面，点两点看归属 ——
async function runSelfTest() {
  const logPath = path.join(__dirname, 'probe', '_target-electron.log');
  // 用 Win32 物理坐标，不用 Electron 的 getBounds（那是 DIP，会被缩放系数错位）
  const physical = () => {
    const r = {};
    api.GetWindowRect(hwnd, r);
    return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
  };
  let b = physical();
  const child = spawn(process.execPath,
    [path.join(__dirname, 'probe', 'target-window.js'),
      b.x - 10, b.y - 10, b.w + 20, b.h + 20, logPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('靶窗口超时')), 15000);
    child.stdout.on('data', (d) => { if (/READY/.test(d.toString())) { clearTimeout(t); res(); } });
  });

  // 靶窗口同为置顶窗口且后建，会盖住宠物：必须重新把宠物顶到最上层，否则测的是靶窗口
  await new Promise((r2) => setTimeout(r2, 400));
  api.SetWindowPos(hwnd, -1n, 0, 0, 0, 0, C.SWP_NOMOVE | C.SWP_NOSIZE | C.SWP_NOACTIVATE);
  await new Promise((r2) => setTimeout(r2, 400));

  b = physical();
  const pts = {
    opaque: { x: b.x + Math.round(b.w * 0.45), y: b.y + Math.round(b.h * 0.5) },
    transparent: { x: b.x + 3, y: b.y + 3 },
  };
  console.log('[self-test] 宠物物理矩形 ' + JSON.stringify(b) + ' 测试点 ' + JSON.stringify(pts));
  const fgBefore = getWindowTitle(api.GetForegroundWindow());

  const c0 = countClicks(logPath);
  clickAt(pts.transparent.x, pts.transparent.y);
  await new Promise((r2) => setTimeout(r2, 700));
  const c1 = countClicks(logPath);
  const petAfterTransparent = petClicks.length;

  clickAt(pts.opaque.x, pts.opaque.y);
  await new Promise((r2) => setTimeout(r2, 700));
  const c2 = countClicks(logPath);
  const petAfterOpaque = petClicks.length;
  const fgAfter = getWindowTitle(api.GetForegroundWindow());

  const result = {
    at: new Date().toISOString(),
    mode: HIT_TEST ? 'nchittest' : 'native',
    petRectPhysical: b,
    points: pts,
    transparentClick: { childGotIt: c1 > c0, petGotIt: petAfterTransparent > 0 },
    opaqueClick: { childGotIt: c2 > c1, petGotIt: petAfterOpaque > petAfterTransparent },
    childClickCounts: { before: c0, afterTransparent: c1, afterOpaque: c2 },
    petClicks,
    focus: { before: fgBefore, after: fgAfter, stolen: fgAfter !== fgBefore },
    hitTestCount: state.hitCount,
    lastHit: state.lastHit,
  };
  fs.writeFileSync(path.join(__dirname, 'probe', `result-electron-${result.mode}.json`),
    JSON.stringify(result, null, 2));
  console.log('[self-test] ' + JSON.stringify(result, null, 2));

  fs.writeFileSync(logPath + '.stop', '1');
  await Promise.race([new Promise((r3) => child.on('exit', r3)), new Promise((r3) => setTimeout(r3, 8000))]);
  child.kill();
  if (!process.env.M0_KEEP_OPEN) app.quit();
}

function countClicks(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').split('\n')
      .filter((l) => l.includes('LBUTTONDOWN')).length;
  } catch (e) { return 0; }
}

app.disableHardwareAcceleration?.();
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
