// 全屏检测：判断当前是否有应用铺满显示器，宠物应当让位。
//
// 判据（来自 M0 实测，见 spikes/m0-window/README.md）：
//   1) 前台窗口矩形 ⊇ 该窗口所在显示器的矩形 —— 覆盖最大化 / 无边框全屏（主判据）
//   2) SHQueryUserNotificationState == RUNNING_D3D_FULL_SCREEN —— 覆盖独占全屏的游戏（辅助）
// 刻意**不用** EnumWindows 扫描：Microsoft Text Input Application 等系统窗口恒为"覆盖"态，误报严重。
import koffi from 'koffi';

export interface FullscreenStatus {
  available: boolean;
  coversMonitor: boolean;
  fgTitle: string;
  /** 前台窗口的窗口类名（诊断用：桌面一族靠它排除，见 SHELL_CLASSES）。 */
  fgClass?: string | null;
  fgRect: string | null;
  monitorRect: string | null;
  quns: string | null;
}

const QUNS: Record<number, string> = {
  1: 'NOT_PRESENT', 2: 'BUSY', 3: 'RUNNING_D3D_FULL_SCREEN',
  4: 'PRESENTATION_MODE', 5: 'ACCEPTS_NOTIFICATIONS', 6: 'QUIET_TIME', 7: 'APP',
};

const UNAVAILABLE: FullscreenStatus = {
  available: false, coversMonitor: false, fgTitle: '', fgRect: null, monitorRect: null, quns: null,
};

interface Win32 {
  GetForegroundWindow: () => unknown;
  GetShellWindow: () => unknown;
  GetDesktopWindow: () => unknown;
  GetClassNameW: (hwnd: unknown, buf: Buffer, n: number) => number;
  GetWindowTextLengthW: (hwnd: unknown) => number;
  GetWindowTextW: (hwnd: unknown, buf: Buffer, n: number) => number;
  GetWindowRect: (hwnd: unknown, rect: Buffer) => boolean;
  IsWindowVisible: (hwnd: unknown) => boolean;
  IsIconic: (hwnd: unknown) => boolean;
  MonitorFromWindow: (hwnd: unknown, flags: number) => unknown;
  GetMonitorInfoW: (hMonitor: unknown, info: Buffer) => boolean;
  SHQueryUserNotificationState: (out: number[]) => number;
  RECT_SIZE: number;
  MONITORINFO_SIZE: number;
}

/**
 * 桌面/任务栏一族窗口的类名。它们天然"铺满整块屏幕"，但不是全屏应用。
 *
 * 2026-09-16 实测（`spikes/m2-menu` 探针，用本函数原样复算，证据在该目录的 report）：
 * 点任务栏右下角的"显示桌面"条之后，前台窗口变成 **WorkerW**（2560×1600、标题为空、
 * 可见、未最小化），`GetShellWindow()` 与 `GetDesktopWindow()` 两个排除项**都拦不住它**
 * —— WorkerW 是 Progman 的子窗口，是第三个 HWND。于是 `coversMonitor` 判为 true，
 * 宠物把自己隐藏了。用户视角就是"**点一下桌面/那条竖线，宠物不见了**"。
 */
const SHELL_CLASSES = new Set(['WorkerW', 'Progman', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

/** MONITOR_DEFAULTTONEAREST：要"窗口所在"的那块屏，不是主屏。 */
const MONITOR_DEFAULTTONEAREST = 2;

let win32: Win32 | null = null;
let loadError: string | null = null;

function ensureLoaded(): Win32 | null {
  if (win32) return win32;
  if (loadError) return null;
  try {
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    koffi.struct('DP_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
    koffi.struct('DP_MONITORINFO', {
      cbSize: 'uint', rcMonitor: 'DP_RECT', rcWork: 'DP_RECT', dwFlags: 'uint',
    });
    win32 = {
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      GetShellWindow: user32.func('void *GetShellWindow()'),
      GetDesktopWindow: user32.func('void *GetDesktopWindow()'),
      GetClassNameW: user32.func('int GetClassNameW(void *hwnd, char16_t *buf, int n)'),
      GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(void *hwnd)'),
      GetWindowTextW: user32.func('int GetWindowTextW(void *hwnd, char16_t *buf, int n)'),
      GetWindowRect: user32.func('bool GetWindowRect(void *hwnd, DP_RECT *rect)'),
      IsWindowVisible: user32.func('bool IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('bool IsIconic(void *hwnd)'),
      MonitorFromWindow: user32.func('void *MonitorFromWindow(void *hwnd, uint flags)'),
      GetMonitorInfoW: user32.func('bool GetMonitorInfoW(void *hMonitor, void *info)'),
      SHQueryUserNotificationState: shell32.func('int SHQueryUserNotificationState(_Out_ int *state)'),
      RECT_SIZE: koffi.sizeof('DP_RECT'),
      MONITORINFO_SIZE: koffi.sizeof('DP_MONITORINFO'),
    };
    return win32;
  } catch (e) {
    loadError = (e as Error).message;
    return null;
  }
}

/**
 * koffi 不会把结构体回写进 JS 对象，所以 RECT / MONITORINFO 一律传 Buffer 手工解。
 *
 * 2026-09-15 实测教训：`GetWindowRect(fg, jsObject)` 传 JS 对象时，koffi 返回 true
 * 但对象上读不到任何字段（全 undefined），于是 `rect.right >= m.right` 恒为 false，
 * `coversMonitor` 永远 false —— 表现为"全屏播放视频时宠物不消失"，且没有任何报错。
 * 与 M0 里嵌套结构体踩的是同一个坑（见 ADR 004）。
 */
function decodeRect(buf: Buffer, off: number) {
  return {
    left: buf.readInt32LE(off), top: buf.readInt32LE(off + 4),
    right: buf.readInt32LE(off + 8), bottom: buf.readInt32LE(off + 12),
  };
}

function decodeMonitorInfo(buf: Buffer) {
  return { rcMonitor: decodeRect(buf, 4), rcWork: decodeRect(buf, 20) };
}

export function detectFullscreen(): FullscreenStatus {
  const w = ensureLoaded();
  if (!w) return { ...UNAVAILABLE };

  const fg = w.GetForegroundWindow();
  const status: FullscreenStatus = {
    available: true, coversMonitor: false, fgTitle: '', fgRect: null, monitorRect: null, quns: null,
  };

  const out: number[] = [0];
  if (w.SHQueryUserNotificationState(out) === 0) status.quns = QUNS[out[0] ?? 0] ?? `UNKNOWN_${out[0]}`;

  if (!fg) return status;
  const len = w.GetWindowTextLengthW(fg);
  if (len > 0) {
    const buf = Buffer.alloc((len + 1) * 2);
    const n = w.GetWindowTextW(fg, buf, len + 1);
    status.fgTitle = buf.toString('utf16le', 0, n * 2);
  }

  const shell = w.GetShellWindow();
  const desktop = w.GetDesktopWindow();
  if (String(fg) === String(shell) || String(fg) === String(desktop)) return status;
  if (!w.IsWindowVisible(fg) || w.IsIconic(fg)) return status;

  // 桌面/任务栏一族（WorkerW 等）同样铺满屏幕，但那是"桌面"不是"全屏应用"。
  // 注意 GetClassNameW 的返回值**不含**结尾空字符（与 GetWindowTextW 同约定），
  // 所以截断长度是 clsLen*2；写成 (clsLen-1)*2 会把 "WorkerW" 读成 "Worker"，
  // 白名单恒不匹配 —— 这个差一错误实测让本修复静默失效过一轮。
  const classBuf = Buffer.alloc(512);
  const clsLen = w.GetClassNameW(fg, classBuf, 256);
  const cls = clsLen > 0 ? classBuf.toString('utf16le', 0, clsLen * 2) : '';
  if (cls && SHELL_CLASSES.has(cls)) {
    status.fgClass = cls;
    return status;
  }
  status.fgClass = cls || null;

  const rectBuf = Buffer.alloc(w.RECT_SIZE);
  if (!w.GetWindowRect(fg, rectBuf)) return status;
  const rc = decodeRect(rectBuf, 0);
  status.fgRect = `${rc.left},${rc.top},${rc.right},${rc.bottom}`;

  const hMon = w.MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
  const mi = Buffer.alloc(w.MONITORINFO_SIZE);
  mi.writeUInt32LE(w.MONITORINFO_SIZE, 0);
  if (!w.GetMonitorInfoW(hMon, mi)) return status;

  const m = decodeMonitorInfo(mi).rcMonitor;
  status.monitorRect = `${m.left},${m.top},${m.right},${m.bottom}`;

  // 主判据：前台窗口矩形包含整块显示器（覆盖最大化 / 无边框全屏）。
  // 辅助判据：QUNS 报告独占 D3D 全屏（部分游戏的全屏窗口矩形与显示器不完全重合）。
  status.coversMonitor =
    (rc.left <= m.left && rc.top <= m.top && rc.right >= m.right && rc.bottom >= m.bottom) ||
    status.quns === 'RUNNING_D3D_FULL_SCREEN';

  return status;
}

/** 轮询检测，状态变化时回调。返回停止函数。 */
export function startFullscreenWatch(onChange: (s: FullscreenStatus) => void, intervalMs = 500): () => void {
  let last: boolean | null = null;
  const timer = setInterval(() => {
    const s = detectFullscreen();
    if (last === null) {
      // 首次只记录基线，且仅当"启动瞬间就已在全屏"时才回调——
      // 否则会抢在 ready-to-show 之前调 show()，把还没加载完的窗口顶出来。
      last = s.coversMonitor;
      if (s.coversMonitor) onChange(s);
      return;
    }
    if (s.coversMonitor !== last) {
      last = s.coversMonitor;
      onChange(s);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** koffi 不可用时给出原因，便于在 HUD 上提示而不是静默失败。 */
export function fullscreenUnavailableReason(): string | null { return loadError; }
