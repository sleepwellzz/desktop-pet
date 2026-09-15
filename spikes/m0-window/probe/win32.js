// 共享的 Win32 绑定层。只暴露 M0 探针需要的 API，不做通用封装。
// 坐标一律使用进程当前的 DPI 虚拟化坐标系（父子进程同为 Node，默认一致）。
const koffi = require('../node_modules/koffi');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

// ---------- 类型 ----------
const WNDPROC = koffi.proto('intptr __stdcall WNDPROC(void *hwnd, uint msg, uintptr wParam, intptr lParam)');
const WNDENUMPROC = koffi.proto('bool __stdcall WNDENUMPROC(void *hwnd, intptr lParam)');

const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint', style: 'uint', lpfnWndProc: 'void *', cbClsExtra: 'int', cbWndExtra: 'int',
  hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
  lpszMenuName: 'char16_t *', lpszClassName: 'char16_t *', hIconSm: 'void *',
});
const RECT = koffi.struct('RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT = koffi.struct('POINT', { x: 'int', y: 'int' });
const SIZE = koffi.struct('SIZE', { cx: 'int', cy: 'int' });
const BLENDFUNCTION = koffi.struct('BLENDFUNCTION', {
  BlendOp: 'uchar', BlendFlags: 'uchar', SourceConstantAlpha: 'uchar', AlphaFormat: 'uchar',
});
const MONITORINFO = koffi.struct('MONITORINFO', {
  cbSize: 'uint', rcMonitor: 'RECT', rcWork: 'RECT', dwFlags: 'uint',
});
const MSG_SIZE = 48;

// ---------- 函数 ----------
const api = {
  // kernel32
  GetLastError: kernel32.func('uint GetLastError()'),
  GetModuleHandleW: kernel32.func('void *GetModuleHandleW(char16_t *name)'),
  Sleep: kernel32.func('void Sleep(uint ms)'),

  // user32
  RegisterClassExW: user32.func('ushort RegisterClassExW(const WNDCLASSEXW *cls)'),
  CreateWindowExW: user32.func(
    'void *CreateWindowExW(uint dwExStyle, char16_t *cls, char16_t *name, uint style,' +
    ' int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)'
  ),
  DestroyWindow: user32.func('bool DestroyWindow(void *hwnd)'),
  DefWindowProcW: user32.func('intptr DefWindowProcW(void *hwnd, uint msg, uintptr wParam, intptr lParam)'),
  PeekMessageW: user32.func('bool PeekMessageW(void *msg, void *hwnd, uint min, uint max, uint remove)'),
  TranslateMessage: user32.func('bool TranslateMessage(const void *msg)'),
  DispatchMessageW: user32.func('intptr DispatchMessageW(const void *msg)'),
  PostQuitMessage: user32.func('void PostQuitMessage(int code)'),
  PostMessageW: user32.func('bool PostMessageW(void *hwnd, uint msg, uintptr wParam, intptr lParam)'),
  GetWindowLongPtrW: user32.func('intptr GetWindowLongPtrW(void *hwnd, int index)'),
  CallWindowProcW: user32.func('intptr CallWindowProcW(void *prev, void *hwnd, uint msg, uintptr wParam, intptr lParam)'),
  SetProcessDpiAwarenessContext: user32.func('bool SetProcessDpiAwarenessContext(void *ctx)'),
  SetWindowLongPtrW: user32.func('intptr SetWindowLongPtrW(void *hwnd, int index, intptr value)'),
  SetWindowPos: user32.func('bool SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint flags)'),
  ShowWindow: user32.func('bool ShowWindow(void *hwnd, int cmd)'),
  GetWindowRect: user32.func('bool GetWindowRect(void *hwnd, _Out_ RECT *rect)'),
  GetClientRect: user32.func('bool GetClientRect(void *hwnd, _Out_ RECT *rect)'),
  GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
  SetForegroundWindow: user32.func('bool SetForegroundWindow(void *hwnd)'),
  GetWindowTextW: user32.func('int GetWindowTextW(void *hwnd, char16_t *buf, int n)'),
  GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(void *hwnd)'),
  GetDC: user32.func('void *GetDC(void *hwnd)'),
  ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
  UpdateLayeredWindow: user32.func(
    'bool UpdateLayeredWindow(void *hwnd, void *hdcDst, POINT *pptDst, SIZE *psize,' +
    ' void *hdcSrc, POINT *pptSrc, uint crKey, BLENDFUNCTION *pblend, uint flags)'
  ),
  SendInput: user32.func('uint SendInput(uint count, const void *inputs, int size)'),
  GetSystemMetrics: user32.func('int GetSystemMetrics(int index)'),
  MonitorFromWindow: user32.func('void *MonitorFromWindow(void *hwnd, uint flags)'),
  // 注意：这里不能加 _Out_，否则 koffi 会把入参结构体清零，cbSize 变 0 导致 87 参数非法
  GetMonitorInfoW: user32.func('bool GetMonitorInfoW(void *hMonitor, MONITORINFO *info)'),
  IsIconic: user32.func('bool IsIconic(void *hwnd)'),
  IsWindowVisible: user32.func('bool IsWindowVisible(void *hwnd)'),
  GetShellWindow: user32.func('void *GetShellWindow()'),
  GetDesktopWindow: user32.func('void *GetDesktopWindow()'),
  EnumWindows: user32.func('bool EnumWindows(void *cb, intptr lParam)'),
  IsWindow: user32.func('bool IsWindow(void *hwnd)'),
  GetWindow: user32.func('void *GetWindow(void *hwnd, uint cmd)'),

  // gdi32
  CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
  CreateCompatibleBitmap: gdi32.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)'),
  SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
  DeleteObject: gdi32.func('bool DeleteObject(void *obj)'),
  DeleteDC: gdi32.func('bool DeleteDC(void *hdc)'),
  SetDIBits: gdi32.func(
    'int SetDIBits(void *hdc, void *hbm, uint start, uint lines, const void *bits, const void *bmi, uint usage)'
  ),
  CreateSolidBrush: gdi32.func('void *CreateSolidBrush(uint color)'),
  FillRect: user32.func('int FillRect(void *hdc, const RECT *rect, void *brush)'),

  // shell32
  SHQueryUserNotificationState: shell32.func('int SHQueryUserNotificationState(_Out_ int *state)'),
};

// ---------- 常量 ----------
const C = {
  WS_POPUP: 0x80000000,
  WS_VISIBLE: 0x10000000,
  WS_EX_TOPMOST: 0x00000008,
  WS_EX_TOOLWINDOW: 0x00000080,
  WS_EX_LAYERED: 0x00080000,
  WS_EX_NOACTIVATE: 0x08000000,
  WS_EX_TRANSPARENT: 0x00000020,
  GWL_EXSTYLE: -20,
  GWLP_WNDPROC: -4,
  WM_DESTROY: 0x0002, WM_CLOSE: 0x0010, WM_PAINT: 0x000f, WM_ERASEBKGND: 0x0014,
  WM_MOUSEMOVE: 0x0200, WM_LBUTTONDOWN: 0x0201, WM_LBUTTONUP: 0x0202,
  WM_NCLBUTTONDOWN: 0x00a1, WM_NCHITTEST: 0x0084, WM_MOUSEACTIVATE: 0x0021,
  WM_QUIT: 0x0012, WM_TIMER: 0x0113,
  HTCLIENT: 1, HTCAPTION: 2, HTTRANSPARENT: -1, HTNOWHERE: 0,
  MA_ACTIVATE: 1, MA_NOACTIVATE: 3,
  SWP_NOSIZE: 0x0001, SWP_NOMOVE: 0x0002, SWP_NOZORDER: 0x0004,
  SWP_NOACTIVATE: 0x0010, SWP_SHOWWINDOW: 0x0040, SWP_FRAMECHANGED: 0x0020,
  SW_SHOW: 5, SW_SHOWNOACTIVATE: 4, SW_HIDE: 0,
  HWND_TOPMOST: -1n,
  ULW_ALPHA: 2,
  AC_SRC_ALPHA: 1,
  DIB_RGB_COLORS: 0,
  MONITOR_DEFAULTTOPRIMARY: 1,
  MOUSEEVENTF_MOVE: 0x0001, MOUSEEVENTF_LEFTDOWN: 0x0002, MOUSEEVENTF_LEFTUP: 0x0004,
  MOUSEEVENTF_ABSOLUTE: 0x8000,
  INPUT_MOUSE: 0,
  QUNS: { 1: 'NOT_PRESENT', 2: 'BUSY', 3: 'RUNNING_D3D_FULL_SCREEN', 4: 'PRESENTATION_MODE', 5: 'ACCEPTS_NOTIFICATIONS', 6: 'QUIET_TIME', 7: 'APP' },
};

// ---------- 工具 ----------
function lastError() { return api.GetLastError(); }

/**
 * 把进程切成"每显示器 DPI 感知"（v2）。
 * Electron 默认就是感知的；Node 默认不感知。两边不一致会让屏幕坐标对不上，
 * 所以靶窗口进程必须先切到同一坐标系再谈点击归属。
 */
function setDpiAwareness() {
  const PER_MONITOR_AWARE_V2 = -4n;
  try {
    return !!api.SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2);
  } catch (e) {
    return false;
  }
}

/** 注册窗口类。wndProc 为 JS 函数；override 可覆盖结构体字段（如 hbrBackground）。 */
function registerClass(className, wndProc, override) {
  const addr = koffi.register(wndProc, koffi.pointer(WNDPROC));
  const atom = api.RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW),
    style: 0,
    lpfnWndProc: addr,
    cbClsExtra: 0, cbWndExtra: 0,
    hInstance: null, hIcon: null, hCursor: null, hbrBackground: null,
    lpszMenuName: null, lpszClassName: className, hIconSm: null,
    ...(override || {}),
  });
  return { atom, addr };
}

/** 消息泵：持续派发消息 durationMs 毫秒。必须在建窗的同一线程调用。 */
function pump(durationMs) {
  const msg = Buffer.alloc(MSG_SIZE);
  const end = Date.now() + durationMs;
  do {
    if (api.PeekMessageW(msg, null, 0, 0, 1)) {
      api.TranslateMessage(msg);
      api.DispatchMessageW(msg);
    } else {
      api.Sleep(1);
    }
  } while (Date.now() < end);
}

/** 用 SendInput 在绝对坐标 (x, y) 点一次左键。 */
function clickAt(x, y) {
  const cx = api.GetSystemMetrics(0);
  const cy = api.GetSystemMetrics(1);
  const ax = Math.round((x * 65535) / (cx - 1));
  const ay = Math.round((y * 65535) / (cy - 1));
  const buf = Buffer.alloc(40 * 3);
  const write = (i, flags) => {
    const o = i * 40;
    buf.writeUInt32LE(C.INPUT_MOUSE, o);
    buf.writeInt32LE(ax, o + 8);        // dx（结构体前 4 字节为 type，4 字节对齐填充）
    buf.writeInt32LE(ay, o + 12);       // dy
    buf.writeUInt32LE(0, o + 16);       // mouseData
    buf.writeUInt32LE(flags, o + 20);   // dwFlags
    buf.writeUInt32LE(0, o + 24);       // time
    buf.writeBigUInt64LE(0n, o + 32);   // dwExtraInfo（8 字节，偏移 32）
  };
  write(0, C.MOUSEEVENTF_MOVE | C.MOUSEEVENTF_ABSOLUTE);
  write(1, C.MOUSEEVENTF_LEFTDOWN | C.MOUSEEVENTF_ABSOLUTE);
  write(2, C.MOUSEEVENTF_LEFTUP | C.MOUSEEVENTF_ABSOLUTE);
  return api.SendInput(3, buf, 40);
}

/**
 * 用 32bpp BGRA（预乘 alpha）位图更新分层窗口。
 * pixels 为 Uint8Array，长度 w*h*4。
 */
function updateLayered(hwnd, w, h, pixels) {
  const hdcScreen = api.GetDC(null);
  const hdcMem = api.CreateCompatibleDC(hdcScreen);
  const hbm = api.CreateCompatibleBitmap(hdcScreen, w, h);
  const old = api.SelectObject(hdcMem, hbm);

  // BITMAPINFOHEADER(40) + bmiColors[1](4)
  const bmi = Buffer.alloc(44);
  bmi.writeUInt32LE(40, 0);            // biSize
  bmi.writeInt32LE(w, 4);              // biWidth
  bmi.writeInt32LE(-h, 8);             // biHeight 负值 = 自上而下
  bmi.writeUInt16LE(1, 12);            // biPlanes
  bmi.writeUInt16LE(32, 14);           // biBitCount
  bmi.writeUInt32LE(0, 16);            // biCompression = BI_RGB

  const bits = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const scan = api.SetDIBits(hdcMem, hbm, 0, h, bits, bmi, C.DIB_RGB_COLORS);
  if (!scan) console.error('  [warn] SetDIBits 失败, GetLastError=' + lastError());

  const blend = { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: C.AC_SRC_ALPHA };
  const ok = api.UpdateLayeredWindow(
    hwnd, hdcScreen, { x: 0, y: 0 }, { cx: w, cy: h },
    hdcMem, { x: 0, y: 0 }, 0, blend, C.ULW_ALPHA
  );
  const err = lastError();

  api.SelectObject(hdcMem, old);
  api.DeleteObject(hbm);
  api.DeleteDC(hdcMem);
  api.ReleaseDC(null, hdcScreen);
  return { ok, err, scanLines: scan };
}

function getWindowTitle(hwnd) {
  if (!hwnd) return '(null)';
  const len = api.GetWindowTextLengthW(hwnd);
  if (len <= 0) return '(无标题)';
  const buf = Buffer.alloc((len + 1) * 2);
  const n = api.GetWindowTextW(hwnd, buf, len + 1);
  return buf.toString('utf16le', 0, n * 2);
}

/**
 * 取显示器矩形。koffi 不会把嵌套结构体字段回写到 JS 对象，
 * 所以传 Buffer 进来手工解码：cbSize(0) rcMonitor(4..20) rcWork(20..36) dwFlags(36)
 */
function getMonitorRect(hMonitor) {
  const buf = Buffer.alloc(koffi.sizeof(MONITORINFO));
  buf.writeUInt32LE(koffi.sizeof(MONITORINFO), 0);
  if (!api.GetMonitorInfoW(hMonitor, buf)) return null;
  const rect = (off) => ({
    left: buf.readInt32LE(off), top: buf.readInt32LE(off + 4),
    right: buf.readInt32LE(off + 8), bottom: buf.readInt32LE(off + 12),
  });
  return { rcMonitor: rect(4), rcWork: rect(20) };
}

/** 构造一个字段完整的 MONITORINFO（保留给需要对象入参的场景）。 */
function newMonitorInfo() {
  return {
    cbSize: koffi.sizeof(MONITORINFO),
    rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
    rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
    dwFlags: 0,
  };
}

/** 取主显示器矩形（与 GetSystemMetrics 同一坐标系）。 */
function primaryMonitorRect() {
  const hMon = api.MonitorFromWindow(null, C.MONITOR_DEFAULTTOPRIMARY);
  const info = getMonitorRect(hMon);
  if (info) return info.rcMonitor;
  // 兜底：主显示器尺寸，坐标系与 SendInput / GetSystemMetrics 一致
  return { left: 0, top: 0, right: api.GetSystemMetrics(0), bottom: api.GetSystemMetrics(1), fallback: true };
}

/**
 * 扫描是否存在覆盖整个显示器的可见窗口（不依赖焦点）。
 * excludeHwnd: 自己的窗口，要排除。
 */
function scanCoversMonitor(excludeHwnd) {
  const monitor = primaryMonitorRect();
  if (!monitor) return { found: false, reason: 'no-monitor' };
  const shell = api.GetShellWindow();
  const desktop = api.GetDesktopWindow();
  const found = [];
  const cb = (hwnd) => {
    // 只统计"真正的全屏应用"：排除自己、壳窗口、桌面、工具窗、无标题窗、有属主的窗
    if (excludeHwnd && String(hwnd) === String(excludeHwnd)) return true;
    if (String(hwnd) === String(shell) || String(hwnd) === String(desktop)) return true;
    if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return true;
    if (api.GetWindowTextLengthW(hwnd) <= 0) return true;
    if (api.GetWindow(hwnd, 4 /* GW_OWNER */)) return true;
    const exStyle = Number(api.GetWindowLongPtrW(hwnd, C.GWL_EXSTYLE));
    if (exStyle & (C.WS_EX_NOACTIVATE | C.WS_EX_TOOLWINDOW)) return true;
    const r = {};
    if (api.GetWindowRect(hwnd, r)) {
      const cover = r.left <= monitor.left && r.top <= monitor.top &&
        r.right >= monitor.right && r.bottom >= monitor.bottom;
      if (cover) {
        found.push({
          hwnd: String(hwnd),
          title: getWindowTitle(hwnd),
          rect: `${r.left},${r.top},${r.right},${r.bottom}`,
        });
      }
    }
    return true;
  };
  const enumAddr = koffi.register(cb, koffi.pointer(WNDENUMPROC));
  api.EnumWindows(enumAddr, 0n);
  return { found: found.length > 0, windows: found, monitor };
}

/** 全屏检测：前台窗口是否覆盖其所在显示器的整个工作区。 */
function detectFullscreen() {
  const fg = api.GetForegroundWindow();
  const shell = api.GetShellWindow();
  const desktop = api.GetDesktopWindow();
  const out = {
    fgHwnd: String(fg), fgTitle: getWindowTitle(fg),
    isShell: fg === shell, isDesktop: fg === desktop,
    foregroundCoversMonitor: false,
    quns: null, qunsName: null,
  };
  const st = [0];
  if (api.SHQueryUserNotificationState(st) === 0) {
    out.quns = st[0];
    out.qunsName = C.QUNS[st[0]] || ('UNKNOWN_' + st[0]);
  }
  if (fg && fg !== shell && fg !== desktop && api.IsWindowVisible(fg) && !api.IsIconic(fg)) {
    const r = {};
    if (api.GetWindowRect(fg, r)) {
      out.fgRect = `${r.left},${r.top},${r.right},${r.bottom}`;
      const hMon = api.MonitorFromWindow(fg, C.MONITOR_DEFAULTTOPRIMARY);
      const info = getMonitorRect(hMon);
      if (info) {
        const m = info.rcMonitor;
        out.monitorRect = `${m.left},${m.top},${m.right},${m.bottom}`;
        const cover = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        out.foregroundCoversMonitor = cover;
      }
    }
  }
  return out;
}

module.exports = {
  koffi, api, C, WNDPROC, MONITORINFO, lastError, registerClass, pump, clickAt,
  updateLayered, getWindowTitle, detectFullscreen, scanCoversMonitor, primaryMonitorRect,
  setDpiAwareness,
};
