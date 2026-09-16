'use strict';
// 配合 check-autostart-registry.mjs：把开机自启打开、保持 20 秒、再关掉。
// 不启动 UI（只 require 宿主模块），这样核查注册表时不受宠物窗口干扰。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const LOG = path.join(__dirname, 'autostart-hold.log');
const { writeAutoStart, isAutoStartEnabled } = require(path.join(__dirname, '..', '..', 'dist', 'host', 'autostart.js'));

app.whenReady().then(async () => {
  try {
    writeAutoStart(true);
    fs.appendFileSync(LOG, `写入后回读 = ${isAutoStartEnabled()}\n`);
    await new Promise((r) => setTimeout(r, 20000));
    writeAutoStart(false);
    fs.appendFileSync(LOG, `撤销后回读 = ${isAutoStartEnabled()}\n`);
  } catch (e) {
    fs.appendFileSync(LOG, '出错：' + String(e) + '\n');
  }
  app.exit(0);
});
