// 定位 CreateWindowExW 返回 126 的原因：逐项变量测试
const koffi = require('../node_modules/koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetLastErrorFn = kernel32.func('uint GetLastError()');
const GetModuleHandleW = kernel32.func('void *GetModuleHandleW(char16_t *name)');

const WndProc = koffi.proto('intptr __stdcall WNDPROC(void *hwnd, uint msg, uintptr wParam, intptr lParam)');
const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint', style: 'uint', lpfnWndProc: 'void *', cbClsExtra: 'int', cbWndExtra: 'int',
  hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
  lpszMenuName: 'char16_t *', lpszClassName: 'char16_t *', hIconSm: 'void *',
});
const DefWindowProcW = user32.func('intptr DefWindowProcW(void *, uint, uintptr, intptr)');
const RegisterClassExW = user32.func('ushort RegisterClassExW(const WNDCLASSEXW *cls)');
const CreateWindowExW = user32.func(
  'void *CreateWindowExW(uint dwExStyle, char16_t *cls, char16_t *name, uint style,' +
  ' int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)'
);

const hInst = GetModuleHandleW(null);
console.log('hInstance =', hInst);

function tryCase(label, { exStyle, style, useHInstInClass, useHInstInCreate, clsName }) {
  const name = clsName || ('M0Case_' + label);
  const cb = function (hwnd, msg, w, l) { return DefWindowProcW(hwnd, msg, w, l); };
  const addr = koffi.register(cb, koffi.pointer(WndProc));
  const atom = RegisterClassExW({
    cbSize: 80, style: 0, lpfnWndProc: addr, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: useHInstInClass ? hInst : null,
    hIcon: null, hCursor: null, hbrBackground: null,
    lpszMenuName: null, lpszClassName: name, hIconSm: null,
  });
  if (!atom) { console.log(`${label}: RegisterClass 失败 ${GetLastErrorFn()}`); return; }
  const hwnd = CreateWindowExW(exStyle, name, 't', style, 10, 10, 100, 100,
    null, null, useHInstInCreate ? hInst : null, null);
  console.log(`${label}: atom=${atom} hwnd=${hwnd ? 'OK' : 'null err=' + GetLastErrorFn()}`);
  global[label + '_cb'] = cb;
}

tryCase('A_overlapped', { exStyle: 0, style: 0x00cf0000 });
tryCase('B_popup', { exStyle: 0, style: 0x80000000 });
tryCase('C_popup_layered', { exStyle: 0x00080000, style: 0x80000000 });
tryCase('D_popup_layered_hinst', { exStyle: 0x00080000, style: 0x80000000, useHInstInClass: true, useHInstInCreate: true });
tryCase('E_overlapped_hinst', { exStyle: 0, style: 0x00cf0000, useHInstInClass: true, useHInstInCreate: true });
process.exit(0);
