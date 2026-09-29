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
 * 用法一：`node tools/check-timers.mjs`（命令行，退出码即结论）
 * 用法二：`import { checkTimers } from './check-timers.mjs'`（单测里直接用返回值断言）
 *
 * ⚠️ **不要再用「spawn 一个 node 子进程去跑它」的方式接进单测**（2026-09-23 改）：
 * 那种写法让单测多了一个与结论无关的失败面 —— 本机沙箱会让 `spawnSync` 间歇性返回
 * `EBUSY`，于是"定时器都接住了"这条断言会因为"起不了子进程"而变红，而它要测的东西
 * 根本没问题。**断言不该被它测以外的东西判红。** 导出一个纯函数就没有这个问题。
 *
 * ═══ 规则在 2026-09-29 重写过（审计 P1-3）═══
 *
 * 旧实现只有两条**行首**正则（`^setInterval\s*\(` / `^start\w*Watch\s*\(`），实测漏判：
 *
 *   | 样本 | 旧实现 | 为什么该抓 |
 *   |---|---|---|
 *   | `window.setInterval(...)` | 漏 | 成员调用照样丢句柄 |
 *   | `init(); setInterval(...)` | 漏 | 同行前置语句后仍是裸调用 |
 *   | `const t = setInterval(…)` 而 `t` 从没进过任何 disposer | 漏 | **这正是 ADR 035 的原始形态** |
 *   | `const t =\n  setInterval(...)` | **误报** | 跨行赋值其实是接住了的 |
 *
 * 而 `src/` 里 4 处 `setInterval` 全是 `const` / `timers.x =` 赋值形式 ⇒ **旧规则在当前代码上
 * 恒不触发**：它报"通过"这件事本身不携带任何信息。现在的规则：
 *
 *   - **规则一（句柄丢失）**：`setInterval` 出现在**语句位置**（前面既不是赋值、也不是实参）⇒ 违规。
 *   - **规则二（接了没人关）**：`X = setInterval(...)` / `const X = setInterval(...)`，
 *     但整个文件里找不到 `clearInterval(X)` 或 `push(X)` ⇒ 违规。
 *   - **规则三（dispose 工厂）**：`start*Watch(...)` 这类"返回 dispose 函数"的调用，
 *     作为裸语句调用 ⇒ 违规（沿用旧规则，命名约定仍有效）。
 *
 * **明确的边界（不假装覆盖）**：`setTimeout` **只统计不判违规**。
 * 它是一次性定时器，句柄丢失通常无害；而真实代码里 `new Promise((r) => setTimeout(r, ms))`
 * 这种箭头函数简写体到处都是 —— 判它违规会制造噪音，而**长期误报的判据会被习惯性忽略**
 * （PLAN §4 #16 记的就是这个过程）。宁可诚实地说"这条没覆盖"。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：工程路径**含空格**，必须走 fileURLToPath，字符串替换会留下 %20（踩过一次）
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** `setInterval(` / `setTimeout(`，**允许成员调用前缀**（`window.` / `this.` / `utils.t.`）。 */
const TIMER_CALL = /(?:\b[A-Za-z_$][\w$]*\.)*\b(setInterval|setTimeout)\s*\(/g;
/** 赋值目标的末端：`X =` / `a.b =` —— 用它判断"返回值被谁接走了"。 */
const ASSIGN_TARGET = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*$/;
/** 标识符（可带成员路径）—— clear* / push 的参数用它。 */
const IDENT = '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)';

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
  /** 不判违规但值得知道的（如"命名了却没关的 setTimeout"）—— 让人看见边界。 */
  const notes = [];
  let checked = 0;

  for (const file of walk(join(rootDir, 'src'))) {
    const text = readFileSync(file, 'utf8');

    // 本文件里"被关掉或被登记"的标识符集合 —— 规则二用它判断"接了但没人关"。
    // 成员形式（`timers.behavior`）必须按完整路径收集，因为 `clearInterval(timers.behavior)`
    // 与 `timers.behavior = ...` 要能对上。
    const cleared = new Set();
    for (const re of [
      new RegExp(`clear(?:Interval|Timeout)\\s*\\(\\s*${IDENT}\\s*\\)`, 'g'),
      new RegExp(`push\\s*\\(\\s*${IDENT}\\s*\\)`, 'g'),
    ]) {
      for (const m of text.matchAll(re)) cleared.add(m[1]);
    }

    text.split('\n').forEach((raw, i, lines) => {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*')) return;
      // 剥掉行尾注释：否则"把 setInterval 的返回值接住"这种说明文字会被当成调用点统计进去。
      const code = line.replace(/\/\/.*$/, '');

      for (const m of code.matchAll(TIMER_CALL)) {
        checked++;
        const kind = m[1];
        let before = code.slice(0, m.index);
        // **跨行赋值**：`const t =` 换行后才是 `setInterval(...)`。只看本行会把上一行的 `=`
        // 丢掉，于是把"接住了"误报成"丢了"（旧实现就有这个误报；实测样本 `f-multiline`）。
        // 本行调用点前全是空白时，把上一行的尾部接进来一起判断。
        if (!before.trim() && i > 0) before = lines[i - 1].replace(/\/\/.*$/, '') + before;
        const target = (before.match(ASSIGN_TARGET) || [])[1] ?? null;

        if (target) {
          // 接住了 —— 但它进过清理路径吗？
          if (cleared.has(target)) continue;
          if (kind === 'setInterval') {
            violations.push(
              `${file}:${i + 1}  ${target} = setInterval(...) —— 句柄接了却**没有任何地方关掉它**\n`
              + `      ${code.slice(0, 110)}\n`
              + '      这就是 ADR 035 的原始形态：退出时它还会再 tick 一次，撞在已销毁的对象上。\n'
              + '      写法：登记进 dispose 集合（见 index.ts 的 processTimerDisposers）',
            );
          } else {
            notes.push(
              `${file}:${i + 1}  ${target} = setTimeout(...) —— 一次性定时器，未登记清理（不判违规，仅提示）`,
            );
          }
          continue;
        }

        // 没接住 —— 只有"语句位置"才算丢句柄；实参/箭头函数体位置是正常的。
        const looksLikeStatement = !/(?:=|[,(\[:]\s*|return\s+)$/.test(before);
        if (!looksLikeStatement) continue;
        if (kind === 'setInterval') {
          violations.push(
            `${file}:${i + 1}  setInterval 的句柄没有被接收 —— 退出时关不掉它\n`
            + `      ${code.slice(0, 110)}\n`
            + '      写法：把结果赋给变量，并登记到 dispose 集合（见 index.ts 的 processTimerDisposers）',
          );
        } else {
          notes.push(`${file}:${i + 1}  setTimeout 的返回值未被接收（一次性，不判违规；仅提示）`);
        }
      }

      // 规则三：`*Watch()` 返回 dispose，若作为裸语句调用，那个 dispose 当场丢失
      for (const m of code.matchAll(/(?:\b[A-Za-z_$][\w$]*\.)*(start\w*Watch)\s*\(/g)) {
        checked++;
        const before = code.slice(0, m.index);
        if (!/^\s*$/.test(before) && !/[;{}]\s*$/.test(before)) continue;
        violations.push(
          `${file}:${i + 1}  ${m[1]}() 返回一个 dispose 函数，但这里把它丢了\n`
          + `      ${code.slice(0, 110)}`,
        );
      }
    });
  }

  return { violations, notes, checked };
}

// —— CLI（被 import 时不执行）——
const isCli = process.argv[1] && basename(process.argv[1]) === 'check-timers.mjs';
if (isCli) {
  const { violations, notes, checked } = checkTimers();
  if (violations.length) {
    console.error('❌ 定时器检查未通过 —— 有定时器无法被关闭：\n');
    for (const v of violations) console.error('  ' + v + '\n');
    process.exit(1);
  }
  console.log(`✅ 定时器检查通过：扫过的 ${checked} 个调用点全部可回收`
    + '（setInterval 句柄均被接收且可清理；start*Watch 的 dispose 均被接收）');
  if (notes.length) {
    console.log(`\nℹ️ 以下 ${notes.length} 处属**明确不判违规**的边界（setTimeout 是一次性的，句柄丢失通常无害）：`);
    for (const n of notes) console.log('  · ' + n);
  }
}
