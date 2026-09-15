// Electron 宿主适配层：只做三件事——改扩展样式、装逐像素命中测试、查全屏状态。
// 复用 probe/win32.js 的绑定；若 M1 落地，这部分就是 ADR 001 里说的"几百行适配层"的雏形。
const { koffi, api, C, WNDPROC, detectFullscreen, getWindowTitle } = require('../probe/win32');

const state = { lastHit: null, hitCount: 0, installed: false };

function getExStyle(hwnd) {
  return Number(api.GetWindowLongPtrW(hwnd, C.GWL_EXSTYLE));
}

/** 增删扩展样式位。传 BigInt 形式的 HWND 指针。 */
function setExStyle(hwnd, addBits, removeBits) {
  const cur = Number(api.GetWindowLongPtrW(hwnd, C.GWL_EXSTYLE));
  const next = (cur | addBits) & ~(removeBits || 0);
  api.SetWindowLongPtrW(hwnd, C.GWL_EXSTYLE, BigInt(next));
  return getExStyle(hwnd);
}

/**
 * 安装 WM_NCHITTEST 逐像素命中测试。
 * sample(clientX, clientY) => boolean（true 表示不透明、应当吃掉点击）
 */
function installHitTest(hwnd, sample) {
  const prev = api.GetWindowLongPtrW(hwnd, C.GWLP_WNDPROC);
  const proc = (h, msg, wp, lp) => {
    if (msg === C.WM_NCHITTEST) {
      const v = Number(lp);
      let sx = v & 0xffff, sy = (v >>> 16) & 0xffff;
      if (sx > 32767) sx -= 65536;
      if (sy > 32767) sy -= 65536;
      const r = {};
      api.GetWindowRect(h, r);
      const hit = !!sample(sx - r.left, sy - r.top);
      state.lastHit = { sx, sy, hit };
      state.hitCount++;
      return hit ? C.HTCLIENT : C.HTTRANSPARENT;
    }
    return api.CallWindowProcW(prev, h, msg, wp, lp);
  };
  const addr = koffi.register(proc, koffi.pointer(WNDPROC));
  const ok = api.SetWindowLongPtrW(hwnd, C.GWLP_WNDPROC, addr);
  state.installed = ok !== 0n && ok !== 0;
  return state.installed;
}

module.exports = {
  koffi, api, C, state,
  getExStyle, setExStyle, installHitTest, detectFullscreen, getWindowTitle,
};
