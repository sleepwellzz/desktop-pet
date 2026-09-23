#!/usr/bin/env node
/**
 * 静态检查：**每一个定时器都必须能被人关掉。**
 *
 * 起因（ADR 035）：2026-09-22 用户在便携版点「退出宠物」弹出
 * `TypeError: Object has been destroyed`。根因是两条 `setInterval` 的句柄从未被保存
 * （250ms 仲裁推进是一条裸语句；600ms 全屏监听的返回值没人接），退出时清理不掉，
 * 于是在窗口销毁之后又 tick 了一次，撞在已销毁的 `webContents` 上。
 *
 * 那种缺陷**跑测试很难抓** —— 它是竞态（退出瞬间还剩 0~N 毫秒），本轮写了三版探针
 * 都没能稳定复现（同步忙等会锁事件循环；拦截 `app.quit` 会让 Electron 卡在半死状态）。
 * 但它在代码里是**一眼可见**的：定时器的句柄没被接收。
 * 那就把它变成一条机器判据 —— 不靠运气撞见，靠规则挡住。
 *
 * 规则一：`setInterval(...)` 的返回值必须被接收（赋值、或传给登记函数）。
 * 规则二：`startXxxWatch(...)` 这类"返回 dispose 函数"的调用，返回值同样必须被接收。
 *
 * 用法一：`node tools/check-timers.mjs`（命令行，退出码即结论）
 * 用法二：`import { checkTimers } from './check-timers.mjs'`（单测里直接用返回值断言）
 *
 * ⚠️ **不要再用「spawn 一个 node 子进程去跑它」的方式接进单测**（2026-09-23 改）：
 * 那种写法让单测多了一个与结论无关的失败面 —— 本机沙箱会让 `spawnSync` 间歇性返回
 * `EBUSY`，于是"定时器都接住了"这条断言会因为"起不了子进程"而变红，而它要测的东西
 * 根本没问题。**断言不该被它测以外的东西判红。** 导出一个纯函数就没有这个问题。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：工程路径**含空格**，必须走 fileURLToPath，字符串替换会留下 %20（踩过一次）
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      walk(p, acc);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs') || e.name.endsWith('.js')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * 扫一遍产品代码，返回违规清单（**不打印、不退出** —— 由调用方决定怎么处理）。
 *
 * 只扫 `src/`（产品代码）。**不扫 `spikes/`** —— 那里的脚本是一次性的探索/探针，
 * 用完就丢；让它们遵守产品级规范只会让人不敢在那儿做实验。规则要有边界，才有说服力。
 */
export function checkTimers(rootDir = ROOT) {
  const violations = [];
  let checked = 0;

  for (const file of walk(join(rootDir, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*')) return;

      // 统计**扫过的调用点总数**（不是违规数）—— 报告里写清楚，否则"0 处"会被读成"没检查"
      checked += (line.match(/\bsetInterval\s*\(/g) || []).length
        + (line.match(/\bstart\w*Watch\s*\(/g) || []).length;

      // 规则一：**裸语句**的 setInterval —— trim 之后行首就是它，句柄当场丢失。
      // 反过来，`const t = setInterval(` / `timers.x = setInterval(` 都是被接住了的，不算违规。
      if (/^setInterval\s*\(/.test(line)) {
        violations.push(
          `${file}:${i + 1}  setInterval 的句柄没有被接收 —— 退出时关不掉它\n` +
          `      ${line.slice(0, 110)}\n` +
          `      写法：把结果赋给变量，并登记到 dispose 集合（见 index.ts 的 processTimerDisposers）`,
        );
      }

      // 规则二：`*Watch()` 返回 dispose，若作为裸语句调用，那个 dispose 当场丢失
      const watch = line.match(/^(start\w*Watch)\s*\(/);
      if (watch) {
        violations.push(
          `${file}:${i + 1}  ${watch[1]}() 返回一个 dispose 函数，但这里把它丢了\n` +
          `      ${line.slice(0, 110)}`,
        );
      }
    });
  }

  return { violations, checked };
}

// —— CLI（被 import 时不执行）——
const isCli = process.argv[1] && basename(process.argv[1]) === 'check-timers.mjs';
if (isCli) {
  const { violations, checked } = checkTimers();
  if (violations.length) {
    console.error('❌ 定时器检查未通过 —— 有定时器无法被关闭：\n');
    for (const v of violations) console.error('  ' + v + '\n');
    process.exit(1);
  }
  console.log(`✅ 定时器检查通过：所有 setInterval / *Watch 的句柄都被接住了（扫到 ${checked} 处）`);
}
