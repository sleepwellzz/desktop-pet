// 靶窗口进程：一个普通可激活的不透明窗口，记录它收到的鼠标点击与激活状态。
// 它跑在**独立进程**里，用来判定"透明区域的点击是否真的穿透到了别的进程"。
//
// 用法: node target-window.js <x> <y> <w> <h> <logPath>
const fs = require('fs');
const path = require('path');
const { koffi, api, C, WNDPROC, registerClass, pump, lastError, setDpiAwareness } = require('./win32');

// 与 Electron 拉齐坐标系：否则点击落点会整体偏移
console.log('DPI 感知切换:', setDpiAwareness());

const [x, y, w, h] = process.argv.slice(2, 6).map(Number);
const logPath = process.argv[6];
const stopPath = logPath + '.stop';

if ([x, y, w, h].some((v) => !Number.isFinite(v)) || !logPath) {
  console.error('用法: node target-window.js <x> <y> <w> <h> <logPath>');
  process.exit(2);
}

fs.writeFileSync(logPath, '');
const log = (obj) => fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...obj }) + '\n');

const CLS = 'M0TargetClass_' + process.pid;
const states = { activate: [], clicks: [], hitTests: 0 };

function wndProc(hwnd, msg, wp, lp) {
  switch (msg) {
    case C.WM_LBUTTONDOWN: {
      const px = lp & 0xffff, py = (lp >> 16) & 0xffff;
      states.clicks.push({ x: px, y: py, screenX: x + px, screenY: y + py });
      log({ ev: 'LBUTTONDOWN', clientX: px, clientY: py });
      return 0;
    }
    case C.WM_NCHITTEST:
      states.hitTests++;
      break;
    case 0x0006: // WM_ACTIVATE
      states.activate.push(wp);
      log({ ev: 'ACTIVATE', state: Number(wp) });
      return 0;
    case C.WM_CLOSE:
      api.DestroyWindow(hwnd);
      return 0;
    case C.WM_DESTROY:
      api.PostQuitMessage(0);
      return 0;
    default:
      break;
  }
  return api.DefWindowProcW(hwnd, msg, wp, lp);
}

// 只注册一次：显式指定浅蓝背景画刷，肉眼可与宠物窗口区分
const { atom } = registerClass(CLS, wndProc, { hbrBackground: api.CreateSolidBrush(0x00ffcc99) });
if (!atom) { console.error('RegisterClass 失败 ' + lastError()); process.exit(1); }

const hwnd = api.CreateWindowExW(
  C.WS_EX_TOPMOST, CLS, 'M0-TARGET',
  C.WS_POPUP | C.WS_VISIBLE, x, y, w, h, null, null, null, null
);
if (!hwnd) { console.error('CreateWindowEx 失败 ' + lastError()); process.exit(1); }

api.SetWindowPos(hwnd, C.HWND_TOPMOST, x, y, 0, 0, C.SWP_NOSIZE | C.SWP_SHOWWINDOW);
api.ShowWindow(hwnd, C.SW_SHOW);

// 通知父进程：窗口已就绪，并给出 HWND
process.stdout.write('READY ' + hwnd + '\n');
log({ ev: 'READY', hwnd: String(hwnd) });

const deadline = Date.now() + 60000;
while (!fs.existsSync(stopPath) && Date.now() < deadline) pump(100);

try { fs.unlinkSync(stopPath); } catch (e) { /* 忽略 */ }
console.log(JSON.stringify({ hwnd: String(hwnd), clicks: states.clicks.length, hitTests: states.hitTests }));
process.exit(0);
