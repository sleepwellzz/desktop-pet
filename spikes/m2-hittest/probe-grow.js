'use strict';
/**
 * 窗口尺寸漂移探针（spike）：验证"多次移动窗口后，窗口矩形是否会变大"。
 *
 * 起因：命中探针里真实拖动一次（12 次 setPosition）后，getBounds() 从 148x160
 * 变成 185x235 DIP。若属实，这就是用户报告的"拖动后无法响应的区域越变越大"的根因——
 * 修复前生效命中区域 = 整个窗口矩形，窗口变大 = 死区变大。
 *
 * 用法：node spikes/m2-hittest/run.mjs probe-grow.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const LOG = path.join(__dirname, 'grow.log');
const log = (m) => { try { fs.appendFileSync(LOG, m + '\n'); } catch (_) { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch (_) { /* ignore */ }
const console = { log: (...a) => log(a.map(String).join(' ')), error: (...a) => log('[ERROR] ' + a.map(String).join(' ')), warn: (...a) => log('[WARN] ' + a.map(String).join(' ')) };
process.on('uncaughtException', (e) => log('[uncaught] ' + ((e && e.stack) || e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
koffi.struct('G_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const RECT_SIZE = koffi.sizeof('G_RECT');
const GetWindowRect = user32.func('bool GetWindowRect(void *h, G_RECT *r)');
function phys(win) {
  const raw = win.getNativeWindowHandle();
  const n = raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0);
  const b = Buffer.alloc(RECT_SIZE);
  if (!GetWindowRect(n, b)) return null;
  const r = { left: b.readInt32LE(0), top: b.readInt32LE(4), right: b.readInt32LE(8), bottom: b.readInt32LE(12) };
  return { ...r, w: r.right - r.left, h: r.bottom - r.top };
}

require(path.join(DIST, 'main', 'index.js'));

async function waitForPetWindow(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === 'desktop-pet');
    if (w && w.isVisible()) return w;
    await sleep(250);
  }
  throw new Error('未等到桌宠窗口');
}

app.whenReady().then(async () => {
  try {
    const win = await waitForPetWindow(20000);
    await sleep(2500);
    const rec = [];
    const snap = (label) => {
      const b = win.getBounds(), c = win.getContentBounds(), p = phys(win);
      rec.push({ label, dipW: b.width, dipH: b.height, contentW: c.width, contentH: c.height, physW: p && p.w, physH: p && p.h });
      log(`[grow] ${label}: DIP ${b.width}x${b.height} 内容 ${c.width}x${c.height} 物理 ${p ? p.w + 'x' + p.h : 'n/a'}`);
    };
    snap('初始');
    for (let i = 1; i <= 6; i++) {
      const b = win.getBounds();
      win.setPosition(b.x - 40, b.y - 30, false);
      await sleep(350);
      snap('第' + i + '次移动');
    }
    fs.writeFileSync(path.join(__dirname, 'grow.json'), JSON.stringify(rec, null, 1));
    log('[grow] 完成');
  } catch (e) {
    log('[grow] 失败：' + ((e && e.stack) || e));
  }
  app.exit(0);
});
