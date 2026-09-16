'use strict';
/**
 * 检查 喂状态.bat 的交互菜单（含新加的"第二会话"）。
 *
 * 为什么不用 spawnSync(input)：spawnSync 写完输入就关 stdin，等价于"输入立刻 EOF"，
 * 测不出"连按多次菜单不退出"这件事。正确测法是 spawn + **延时逐行写 stdin 且先不关**，
 * 最后再 end() —— 这才等价于真人按键（2026-09-16 踩过：用 spawnSync 时菜单空转到跑满一个核）。
 *
 * 用法：node spikes/m2-hotkey/check-feed-bat.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAT = join(ROOT, '喂状态.bat');
const STATUS_FILE = join(homedir(), '.desktop-pet', 'status.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }

/** 读状态文件里的会话 → 状态映射。 */
function sessions() {
  if (!existsSync(STATUS_FILE)) return null;
  try {
    const doc = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    return Object.fromEntries(Object.entries(doc.sessions ?? {}).map(([k, v]) => [k, v.status]));
  } catch {
    return { parseError: true };
  }
}

const child = spawn('cmd.exe', ['/c', BAT], { cwd: ROOT });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += '[ERR]' + d.toString(); });

const checks = [];
const record = (label, pass, detail) => {
  checks.push({ label, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${label} —— ${detail}`);
};

const done = new Promise((r) => child.on('exit', r));
(async () => {
  await sleep(1500);
  child.stdin.write('4\n');            // default = needs-input
  await sleep(2200);
  let s = sessions();
  record('按 4：只写入 default 这一个会话', JSON.stringify(s) === JSON.stringify({ default: 'needs-input' }), JSON.stringify(s));

  child.stdin.write('8\n');            // 第二会话 b = running
  await sleep(2200);
  s = sessions();
  record('按 8：出现第二个会话 b=running（这才是 +1 的来源）',
    s && s.default === 'needs-input' && s.b === 'running',
    JSON.stringify(s));

  child.stdin.write('9\n');            // 清掉会话 b
  await sleep(2200);
  s = sessions();
  record('按 9：会话 b 被移除，只剩 default', s && s.b === undefined && s.default === 'needs-input', JSON.stringify(s));

  child.stdin.write('Q\n');
  await sleep(1500);
  child.stdin.end();
  await done;

  const menus = (out.match(/Press 1-9/g) || []).length;
  record('菜单循环重绘（按完回菜单，不用重开窗口）', menus >= 4, `重绘 ${menus} 次`);
  record('没有空转（EOF 保护仍在）', !/Unknown choice/.test(out), `Unknown choice 出现 ${(out.match(/Unknown choice/g) || []).length} 次`);
  record('未退出码异常', child.exitCode === 0, `exit=${child.exitCode}`);

  // 收尾：把测试写下的状态文件清掉，别让用户下次启动时看到残留
  try { rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }

  const bad = checks.filter((c) => !c.pass);
  console.log(`\n${bad.length === 0 ? 'PASS' : 'FAIL'}：${checks.length - bad.length}/${checks.length} 项通过`);
  process.exit(bad.length === 0 ? 0 : 1);
})();
