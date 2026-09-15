// M0 核心探针：逐像素穿透 + 不夺焦点
//
// 场景：父进程建一个 WS_EX_LAYERED 的"宠物窗口"（圆形不透明、四周 alpha=0），
//       其下方是**另一个进程**的靶窗口。用 SendInput 在两点各点一次，
//       看点击到底落在谁身上，以及前台窗口是否被抢走。
//
// 两种模式各跑一遍：
//   native    —— 完全交给 DefWindowProcW，验证"分层窗口 alpha=0 天然穿透"是否成立
//   nchittest —— 自己处理 WM_NCHITTEST，alpha=0 返回 HTTRANSPARENT
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { koffi, api, C, WNDPROC, registerClass, pump, clickAt, updateLayered, getWindowTitle, lastError } =
  require('./win32');

const T0 = Date.now();
const step = (msg) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

const NODE = process.execPath;
const HERE = __dirname;

// 靶窗口与宠物窗口完全重合，确保两点都在两层窗口内
const RECT = { x: 120, y: 120, w: 420, h: 420 };
const CTR = { x: RECT.x + RECT.w / 2, y: RECT.y + RECT.h / 2 };   // 圆心，不透明
const CORNER = { x: RECT.x + 14, y: RECT.y + 14 };                // 左上角，alpha=0
const RADIUS = 130;
const ALPHA_THRESHOLD = 8;

function makePixels() {
  const px = new Uint8Array(RECT.w * RECT.h * 4);
  for (let yy = 0; yy < RECT.h; yy++) {
    for (let xx = 0; xx < RECT.w; xx++) {
      const dx = xx - RECT.w / 2, dy = yy - RECT.h / 2;
      if (dx * dx + dy * dy <= RADIUS * RADIUS) {
        const i = (yy * RECT.w + xx) * 4;
        px[i] = 0x40; px[i + 1] = 0xc0; px[i + 2] = 0xff; px[i + 3] = 0xff; // BGRA，预乘后相同
      }
    }
  }
  return px;
}

function spawnTarget(tag) {
  const logPath = path.join(HERE, `_target-${tag}.log`);
  const child = spawn(NODE, [path.join(HERE, 'target-window.js'),
    RECT.x, RECT.y, RECT.w, RECT.h, logPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('靶窗口启动超时')), 15000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/READY\s+(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, logPath, hwnd: m[1] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[target] ' + d));
  });
}

function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return { raw: l }; }
    });
  } catch (e) { return []; }
}
const countClicks = (log) => log.filter((e) => e.ev === 'LBUTTONDOWN').length;

async function runMode(mode) {
  console.log(`\n===== 模式: ${mode} =====`);
  const { child, logPath, hwnd: targetHwnd } = await spawnTarget(mode);
  console.log('靶窗口 HWND =', targetHwnd);
  step('靶窗口就绪');

  // —— 对照组：宠物窗口还没建，点击应当全部落到靶窗口 ——
  pump(200);
  const before0 = countClicks(readLog(logPath));
  clickAt(CTR.x, CTR.y);
  pump(400);
  const controlOk = countClicks(readLog(logPath)) > before0;
  console.log(`对照（无宠物窗口时点击圆心）: 靶窗口收到点击 = ${controlOk ? '是' : '否'}`);

  // —— 建宠物窗口 ——
  const pet = { clicks: [], hittest: [] };
  const px = makePixels();
  const alphaAt = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= RECT.w || cy >= RECT.h) return 0;
    return px[((cy | 0) * RECT.w + (cx | 0)) * 4 + 3];
  };

  const wndProc = (hwnd, msg, wp, lp) => {
    switch (msg) {
      case C.WM_NCHITTEST: {
        const v = Number(lp);
        let sx = v & 0xffff, sy = (v >>> 16) & 0xffff;
        if (sx > 32767) sx -= 65536;
        if (sy > 32767) sy -= 65536;
        const a = alphaAt(sx - RECT.x, sy - RECT.y);
        const hit = a >= ALPHA_THRESHOLD;
        pet.hittest.push({ sx, sy, a, hit });
        if (mode === 'nchittest') return hit ? C.HTCLIENT : C.HTTRANSPARENT;
        break;
      }
      case C.WM_LBUTTONDOWN: {
        const v = Number(lp);
        let cx = v & 0xffff, cy = (v >>> 16) & 0xffff;
        if (cx > 32767) cx -= 65536;
        if (cy > 32767) cy -= 65536;
        pet.clicks.push({ cx, cy });
        return 0;
      }
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
  };

  const CLS = 'M0PetClass_' + mode;
  const { atom } = registerClass(CLS, wndProc);
  if (!atom) throw new Error('RegisterClass 失败 ' + lastError());

  const petHwnd = api.CreateWindowExW(
    C.WS_EX_LAYERED | C.WS_EX_TOPMOST | C.WS_EX_NOACTIVATE | C.WS_EX_TOOLWINDOW,
    CLS, 'M0-PET', C.WS_POPUP, RECT.x, RECT.y, RECT.w, RECT.h, null, null, null, null
  );
  if (!petHwnd) throw new Error('CreateWindowEx 失败 ' + lastError());

  const ex = api.GetWindowLongPtrW(petHwnd, C.GWL_EXSTYLE);
  const painted = updateLayered(petHwnd, RECT.w, RECT.h, px);
  api.ShowWindow(petHwnd, C.SW_SHOWNOACTIVATE);
  api.SetWindowPos(petHwnd, C.HWND_TOPMOST, RECT.x, RECT.y, 0, 0, C.SWP_NOSIZE | C.SWP_NOACTIVATE);
  pump(400);

  console.log(`宠物窗口 HWND=${petHwnd} 扩展样式=0x${(Number(ex) >>> 0).toString(16)}`,
    `NOACTIVATE=${!!(Number(ex) & C.WS_EX_NOACTIVATE)} LAYERED=${!!(Number(ex) & C.WS_EX_LAYERED)} TOPMOST=${!!(Number(ex) & C.WS_EX_TOPMOST)}`);
  console.log(`UpdateLayeredWindow: ok=${painted.ok} 扫描线=${painted.scanLines} err=${painted.err}`);

  // —— 测试 1：点击 alpha=0 的角落，期望穿透到靶窗口 ——
  step('测试1：点击透明角落');
  const before1 = countClicks(readLog(logPath));
  const petClicksBefore1 = pet.clicks.length;
  clickAt(CORNER.x, CORNER.y);
  pump(500);
  const t1ChildGot = countClicks(readLog(logPath)) > before1;
  const t1PetGot = pet.clicks.length > petClicksBefore1;

  // —— 测试 2：点击不透明圆心，期望宠物窗口吃掉点击 ——
  step('测试2：点击不透明圆心');
  const fgBefore = api.GetForegroundWindow();
  const fgBeforeTitle = getWindowTitle(fgBefore);
  const before2 = countClicks(readLog(logPath));
  const petClicksBefore2 = pet.clicks.length;
  clickAt(CTR.x, CTR.y);
  pump(500);
  const t2ChildGot = countClicks(readLog(logPath)) > before2;
  const t2PetGot = pet.clicks.length > petClicksBefore2;
  const fgAfter = api.GetForegroundWindow();
  const fgAfterTitle = getWindowTitle(fgAfter);

  const result = {
    mode,
    exStyle: '0x' + (Number(ex) >>> 0).toString(16),
    noActivateSet: !!(Number(ex) & C.WS_EX_NOACTIVATE),
    layeredSet: !!(Number(ex) & C.WS_EX_LAYERED),
    updateLayeredOk: painted.ok,
    scanLines: painted.scanLines,
    controlOk,
    transparentCorner: { childGotClick: t1ChildGot, petGotClick: t1PetGot },
    opaqueCenter: { childGotClick: t2ChildGot, petGotClick: t2PetGot },
    noActivate: {
      fgBefore: fgBeforeTitle, fgAfter: fgAfterTitle,
      stolen: String(fgAfter) === String(petHwnd),
    },
    hitTestSamples: pet.hittest.slice(-6),
    hitTestCount: pet.hittest.length,
    petHwnd: String(petHwnd),
    targetHwnd,
  };

  console.log('测试1 透明角落: 靶窗口收到=' + t1ChildGot + ' 宠物收到=' + t1PetGot +
    '  => ' + (t1ChildGot && !t1PetGot ? '穿透成立' : '未穿透'));
  console.log('测试2 不透明圆心: 靶窗口收到=' + t2ChildGot + ' 宠物收到=' + t2PetGot +
    '  => ' + (t2PetGot && !t2ChildGot ? '命中宠物成立' : '未命中'));
  console.log('不夺焦点: 点击前前台="' + fgBeforeTitle + '" 点击后前台="' + fgAfterTitle +
    '" 被宠物抢走=' + result.noActivate.stolen);
  console.log('WM_NCHITTEST 次数:', pet.hittest.length, '末尾样本:', JSON.stringify(pet.hittest.slice(-3)));

  // —— 收尾：通知靶窗口退出，并加超时兜底（子进程可能先于监听退出，别把主流程吊死）——
  step('收尾：关闭宠物窗口');
  api.PostMessageW(petHwnd, C.WM_CLOSE, 0n, 0n);
  pump(300);
  step('通知靶窗口退出');
  fs.writeFileSync(logPath + '.stop', '1');
  await Promise.race([
    new Promise((r) => child.on('exit', r)),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  child.kill();
  try { fs.unlinkSync(logPath); } catch (e) { /* 忽略 */ }
  step('靶窗口已回收');
  return result;
}

(async () => {
  const results = [];
  for (const mode of ['native', 'nchittest']) {
    try { results.push(await runMode(mode)); }
    catch (e) { console.error(`模式 ${mode} 失败:`, e.message); results.push({ mode, error: e.message }); }
  }
  const out = path.join(HERE, 'result-hit-test.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log('\n结果已写入 ' + out);
  process.exit(0);
})();
