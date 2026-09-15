'use strict';
// 「外部全屏应用」替身：独立 Electron 进程，开一个铺满显示器的全屏窗口，若干秒后自己退出。
// 用它来触发真实的全屏让位路径（而不是在同一个进程里开窗口，避免共享进程状态干扰结论）。
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const LOG = path.join(__dirname, 'fs-child.log');
const lifeArg = process.argv.find((a) => a.startsWith('--life='));
const life = lifeArg ? Number(lifeArg.slice('--life='.length)) : 7000;

app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay().bounds;
    const w = new BrowserWindow({
      x: d.x, y: d.y, width: d.width, height: d.height,
      fullscreen: true, frame: false, backgroundColor: '#1b2a4a',
      skipTaskbar: true, show: true, webPreferences: { contextIsolation: true },
    });
    await w.loadURL('data:text/html,<body style="margin:0;background:%231b2a4a"></body>');
    w.show();
    w.focus();
    fs.appendFileSync(LOG, `[child] 全屏窗口已显示 bounds=${JSON.stringify(w.getBounds())} display=${JSON.stringify(d)}\n`);
    setTimeout(() => app.exit(0), life);
  } catch (e) {
    fs.appendFileSync(LOG, '[child] 失败：' + ((e && e.stack) || e) + '\n');
    app.exit(1);
  }
});
