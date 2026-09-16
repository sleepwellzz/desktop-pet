'use strict';
/**
 * 探针：候选全局快捷键在本机能不能注册上（M2 ③ 的前置事实）。
 *
 * 为什么必须先测：`Win+Alt+P` 是 `desktop-pet.json` 里的默认值，且它自己都标注了冲突风险。
 * 全局快捷键的"能不能注册"是纯平台/环境事实（取决于当前装了哪些软件），不许推断 ——
 * 设计阶段就要知道默认值可用不可用、备选里哪个能兜底。
 *
 * 结果落盘（GUI 进程拿不到 stdout）：spikes/m2-hotkey/hotkey.json
 */
const { app, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const REPORT = path.join(__dirname, 'hotkey.json');

/** Electron 里 Windows 键写作 Super；CommandOrControl 在 Windows 上是 Ctrl。 */
const CANDIDATES = [
  'Super+Alt+P',          // 规格里的默认值
  'Ctrl+Alt+P',
  'Super+Shift+P',
  'CommandOrControl+Shift+Alt+P',
  'Super+Alt+Space',
  'CommandOrControl+Alt+B',
];

app.whenReady().then(() => {
  const results = [];
  for (const acc of CANDIDATES) {
    let ok = false;
    let err = null;
    try {
      ok = globalShortcut.register(acc, () => { /* 探针不做事 */ });
    } catch (e) {
      err = String(e);
    }
    results.push({ accelerator: acc, registered: ok, error: err, isRegistered: globalShortcut.isRegistered(acc) });
  }
  globalShortcut.unregisterAll();
  const report = { platform: process.platform, results };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  app.exit(0);
});
