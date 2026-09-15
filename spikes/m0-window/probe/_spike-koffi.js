// 最小可行性试验：能否用 koffi 注册窗口类、建窗、收到消息。
// 目的只有一个：确认 koffi 回调可以作为 WNDPROC 嵌入 WNDCLASSEX 结构体。
const koffi = require('../node_modules/koffi');
const user32 = koffi.load('user32.dll');

const WndProc = koffi.proto('intptr __stdcall WNDPROC(void *hwnd, uint msg, uintptr wParam, intptr lParam)');
console.log('[1] koffi.proto ok, WNDPROC type =', typeof WndProc);

const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint',
  style: 'uint',
  lpfnWndProc: 'void *',
  cbClsExtra: 'int',
  cbWndExtra: 'int',
  hInstance: 'void *',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'char16_t *',
  lpszClassName: 'char16_t *',
  hIconSm: 'void *',
});
console.log('[2] struct ok, size =', koffi.sizeof(WNDCLASSEXW), '(期望 80)');

const RegisterClassExW = user32.func('ushort RegisterClassExW(const WNDCLASSEXW *cls)');
const CreateWindowExW = user32.func(
  'void *CreateWindowExW(uint dwExStyle, char16_t *cls, char16_t *name, uint style,' +
  ' int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)'
);
const PeekMessageW = user32.func('bool PeekMessageW(void *msg, void *hwnd, uint min, uint max, uint remove)');
const TranslateMessage = user32.func('bool TranslateMessage(const void *msg)');
const DispatchMessageW = user32.func('intptr DispatchMessageW(const void *msg)');
const PostQuitMessage = user32.func('void PostQuitMessage(int code)');
const GetLastErrorFn = koffi.load('kernel32.dll').func('uint GetLastError()');

const seen = [];
const cb = function WndProc(hwnd, msg) {
  seen.push(msg);
  if (seen.length === 1) console.log('[5] WNDPROC 被回调，首条 msg=0x' + msg.toString(16), 'hwnd=', hwnd);
  if (msg === 0x0002 /* WM_DESTROY */) { PostQuitMessage(0); return 0; }
  return 0;
};
// 保持回调存活，避免被 GC 回收导致原生侧跳进野指针。
// koffi.register 返回跳板地址（bigint），结构体字段里要传这个地址而非函数本身。
const wndProcAddr = koffi.register(cb, koffi.pointer(WndProc));
console.log('[3] callback ok, trampoline = 0x' + wndProcAddr.toString(16));

const cls = {
  cbSize: koffi.sizeof(WNDCLASSEXW),
  style: 0,
  lpfnWndProc: wndProcAddr,
  cbClsExtra: 0,
  cbWndExtra: 0,
  hInstance: null,
  hIcon: null,
  hCursor: null,
  hbrBackground: null,
  lpszMenuName: null,
  lpszClassName: 'M0ProbeClass',
  hIconSm: null,
};
const atom = RegisterClassExW(cls);
console.log('[4] RegisterClassExW atom =', atom, atom ? 'OK' : ('FAILED GetLastError=' + GetLastErrorFn()));

const hwnd = CreateWindowExW(0x00080000 /* WS_EX_LAYERED */, 'M0ProbeClass', 'm0-probe',
  0x80000000 /* WS_POPUP */, 100, 100, 200, 200, null, null, null, null);
console.log('[6] CreateWindowExW hwnd =', hwnd, hwnd ? 'OK' : ('FAILED GetLastError=' + GetLastErrorFn()));

const msg = Buffer.alloc(48);
let n = 0;
while (n < 200) {
  if (PeekMessageW(msg, null, 0, 0, 1 /* PM_REMOVE */)) {
    TranslateMessage(msg);
    DispatchMessageW(msg);
  }
  n++;
}
console.log('[7] 消息循环跑完，收到的消息数 =', seen.length);
console.log('[8] 结论：', seen.length > 0 ? 'koffi 回调作 WNDPROC 可行' : '不可行，需换 C++ 插件路线');
process.exit(0);
