'use strict';
/**
 * 分离实验：用 `keybd_event` 注入的 Win+Alt+P 到底能不能触发 `globalShortcut`？
 *
 * 这与应用代码无关 —— 是本项目的"平台行为必须实测"纪律：
 * 如果注入根本触发不了全局快捷键，那么 `probe-bubble-hotkey.js` 里那条失败
 * 就不能算应用缺陷，得换一种验证方式（并且要在文档里如实标注）。
 *
 * 三种注入变体各试一次：
 *   A. 裸 keybd_event（不带扩展位）
 *   B. LWIN 带 KEYEVENTF_EXTENDEDKEY
 *   C. 先 tap 一下别的键制造真实键盘活动，再按 A 的方式注入
 */
const { app, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const REPORT = path.join(__dirname, 'keyinject.json');
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const keybd_event = user32.func('void keybd_event(uint vk, uint scan, uint flags, uint64_t extra)');
const KEYUP = 0x0002, EXTENDED = 0x0001;
const VK_LWIN = 0x5B, VK_MENU = 0x12, VK_P = 0x50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inject({ extendedWin, preTap }) {
  if (preTap) {
    keybd_event(0x10, 0, 0, 0);           // Shift 轻敲一下，制造键盘活动
    keybd_event(0x10, 0, KEYUP, 0);
  }
  const wf = extendedWin ? EXTENDED : 0;
  keybd_event(VK_LWIN, 0, wf, 0);
  keybd_event(VK_MENU, 0, 0, 0);
  keybd_event(VK_P, 0, 0, 0);
  return () => {
    keybd_event(VK_P, 0, KEYUP, 0);
    keybd_event(VK_MENU, 0, KEYUP, 0);
    keybd_event(VK_LWIN, 0, KEYUP | wf, 0);
  };
}

app.whenReady().then(async () => {
  let fired = 0;
  const ok = globalShortcut.register('Super+Alt+P', () => { fired += 1; });
  const results = [{ variant: 'registered', ok }];

  for (const [name, opts] of [['A 裸注入', {}], ['B LWIN 带扩展位', { extendedWin: true }], ['C 先按键再注入', { preTap: true }]]) {
    const before = fired;
    const release = inject(opts);
    await sleep(80);
    release();
    await sleep(900);
    results.push({ variant: name, fired: fired - before });
  }

  globalShortcut.unregisterAll();
  fs.writeFileSync(REPORT, JSON.stringify({ results }, null, 1));
  app.exit(0);
});
