// 通道 A · hook 映射层与客户端的离线单测。
//
// 为什么必须有：跑一次真实 agent 回合很贵（额度 + 几十秒），而映射错一个事件名、
// 少一个命名空间前缀，在界面上只表现为"宠物偶尔不跟着动"——肉眼看不出对错。
// 这些规则只有钉在断言里才防得住后续改动。
//
// 跑法：node tools/codebuddy-hook.test.mjs   （不依赖 dist，纯 mjs）
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIGURED_EVENTS,
  HOOK_EVENT_STATUS,
  VERBOSE_EVENTS,
  normalizeHookEvent,
  parseHookPayload,
  sessionIdFor,
  titleFor,
} from './codebuddy-hook-map.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(root, 'tools/pet-hook-cb.mjs');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; process.stdout.write(`  ok   ${name}\n`); }
  else { failures.push(`${name}${detail ? ' —— ' + detail : ''}`); process.stdout.write(`  FAIL ${name}${detail ? ' —— ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t) { process.stdout.write(`\n${t}\n`); }

const tmp = mkdtempSync(join(tmpdir(), 'pet-hook-cb-'));
const statusFile = join(tmp, 'status.json');
const dumpFile = join(tmp, 'stdin-dump.jsonl');

/** 跑一次真实客户端进程。env 里删掉 ELECTRON_RUN_AS_NODE（宿主是 Electron，子进程会继承它）。 */
function runClient(args, stdin) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(process.execPath, [CLIENT, ...args], { input: stdin, encoding: 'utf8', env, timeout: 20000 });
}
function readStatus() {
  if (!existsSync(statusFile)) return null;
  return JSON.parse(readFileSync(statusFile, 'utf8'));
}
function mkPayload(event, extra = {}) {
  return JSON.stringify({ hook_event_name: event, session_id: 'abcdef12-3456', cwd: 'E:\\work\\desktop-pet', ...extra });
}

try {
  // —— ① 事件表本身 ——
  section('① 事件表：每个事件都映射到合法状态，且不自相矛盾');
  const legal = new Set(['idle', 'running', 'needs-input', 'blocked', 'ready', null]);
  for (const [ev, st] of Object.entries(HOOK_EVENT_STATUS)) {
    check(`${ev} → ${st}`, legal.has(st), '映射到了非法状态');
  }
  eq('SessionStart → idle', HOOK_EVENT_STATUS.SessionStart, 'idle');
  eq('UserPromptSubmit → running', HOOK_EVENT_STATUS.UserPromptSubmit, 'running');
  eq('Stop → ready', HOOK_EVENT_STATUS.Stop, 'ready');
  eq('PermissionRequest → needs-input', HOOK_EVENT_STATUS.PermissionRequest, 'needs-input');
  eq('Notification → needs-input', HOOK_EVENT_STATUS.Notification, 'needs-input');
  eq('SessionEnd → null（走收尾而不是写状态）', HOOK_EVENT_STATUS.SessionEnd, null);
  // Interrupt 是"用户自己按了停"，用 blocked（趴卧="已受阻"）会是对用户撒谎。
  eq('Interrupt → idle（不是 blocked）', HOOK_EVENT_STATUS.Interrupt, 'idle');
  check('默认事件集与详细事件集不重叠', DEFAULT_CONFIGURED_EVENTS.every((e) => !VERBOSE_EVENTS.includes(e)));
  check('默认事件集不含工具级事件（实测每次 377ms）',
    !DEFAULT_CONFIGURED_EVENTS.includes('PreToolUse') && !DEFAULT_CONFIGURED_EVENTS.includes('PostToolUse'));

  // —— ② 命名空间与标题 ——
  section('② sessionId 命名空间与标题（多 agent 并存的地基）');
  eq('带来源前缀', sessionIdFor('wb', 'abc-123'), 'wb:abc-123');
  eq('缺 id 时降级为 default', sessionIdFor('wb', undefined), 'wb:default');
  eq('缺 source 时降级为 agent', sessionIdFor(undefined, 'x'), 'agent:x');
  check('超长 id 被截断', sessionIdFor('wb', 'z'.repeat(500)).length <= 16 + 1 + 64);
  check('控制字符被清掉', !/[\u0000-\u001F]/.test(sessionIdFor('w\u0000b', 'a\u0001b')));
  eq('title 用 cwd 末段并带来源', titleFor({ cwd: 'E:\\work\\desktop-pet' }, 'WorkBuddy'), 'WorkBuddy · desktop-pet');
  eq('cwd 是 posix 路径也认', titleFor({ cwd: '/home/u/proj' }, 'WorkBuddy'), 'WorkBuddy · proj');
  eq('无 cwd 时回落到来源名', titleFor({}, 'WorkBuddy'), 'WorkBuddy');
  check('title 限长', titleFor({ cwd: 'x'.repeat(400) }, 'y'.repeat(100)).length <= 120);

  // —— ③ 归一化：非法输入一律"什么都不做" ——
  section('③ 归一化：读不懂的输入必须不产生事件（否则会踩掉别的 agent）');
  eq('空输入 → null', normalizeHookEvent(''), null);
  eq('半截 JSON → null', normalizeHookEvent('{"hook_event_name":"Stop"'), null);
  eq('JSON 是数组 → null', normalizeHookEvent('[]'), null);
  eq('JSON 是字符串 → null', normalizeHookEvent('"Stop"'), null);
  eq('没有 hook_event_name → null', normalizeHookEvent('{"session_id":"a"}'), null);
  eq('未知事件名 → null（忽略，不报错）', normalizeHookEvent(mkPayload('SomeFutureEvent')), null);
  eq('事件名大小写不匹配 → null（白名单不宽松匹配）', normalizeHookEvent(mkPayload('stop')), null);
  check('parseHookPayload 对正常输入可用', parseHookPayload('{"a":1}') !== null);

  const ok = normalizeHookEvent(mkPayload('Stop'), { source: 'wb', label: 'WorkBuddy' });
  eq('正常输入 → 状态', ok?.status, 'ready');
  eq('正常输入 → 命名空间', ok?.sessionId, 'wb:abcdef12-3456');
  eq('正常输入 → 标题', ok?.title, 'WorkBuddy · desktop-pet');
  eq('正常输入 → clear 为 false', ok?.clear, false);
  const end = normalizeHookEvent(mkPayload('SessionEnd'), { source: 'wb' });
  eq('SessionEnd → clear 为 true', end?.clear, true);

  // —— ④ 客户端端到端（真实进程 + 真实文件） ——
  section('④ 客户端端到端：真实 spawn + 真实状态文件');
  let r = runClient([`--file=${statusFile}`, `--dump=${dumpFile}`], mkPayload('UserPromptSubmit'));
  eq('退出码为 0', r.status, 0);
  let doc = readStatus();
  eq('写入了 running', doc?.sessions?.['wb:abcdef12-3456']?.status, 'running');
  eq('标题写进去了', doc?.sessions?.['wb:abcdef12-3456']?.title, 'WorkBuddy · desktop-pet');
  check('dump 原样落了 payload', existsSync(dumpFile) && readFileSync(dumpFile, 'utf8').includes('hook_event_name'));
  check('ts 是数字', typeof doc?.sessions?.['wb:abcdef12-3456']?.ts === 'number');

  // 关键判据：未知事件**不得改动文件**。
  const before = readFileSync(statusFile, 'utf8');
  r = runClient([`--file=${statusFile}`], mkPayload('SomeFutureEvent'));
  eq('未知事件退出码 0', r.status, 0);
  eq('未知事件不改动状态文件', readFileSync(statusFile, 'utf8'), before);

  // 关键判据：**另一个 agent 的会话不能被踩掉**（用户"两个软件同时跑"的顾虑）。
  doc = readStatus();
  doc.sessions['proma:other-agent'] = { status: 'needs-input', title: 'Proma · 合同标注', ts: Date.now() };
  writeFileSync(statusFile, JSON.stringify(doc), 'utf8');
  r = runClient([`--file=${statusFile}`], mkPayload('Stop'));
  eq('写入自己的状态退出码 0', r.status, 0);
  doc = readStatus();
  eq('自己的会话更新为 ready', doc?.sessions?.['wb:abcdef12-3456']?.status, 'ready');
  eq('别的 agent 的会话原样保留', doc?.sessions?.['proma:other-agent']?.status, 'needs-input');
  eq('两个会话同时存在（= 多会话仲裁的输入）', Object.keys(doc.sessions).length, 2);

  // SessionEnd 收尾：只摘自己那一行。
  r = runClient([`--file=${statusFile}`], mkPayload('SessionEnd'));
  doc = readStatus();
  check('SessionEnd 摘掉自己的会话', !('wb:abcdef12-3456' in doc.sessions));
  eq('别人的会话仍在', doc?.sessions?.['proma:other-agent']?.status, 'needs-input');

  // 坏文件不能让 hook 崩。
  writeFileSync(statusFile, '{ 半截', 'utf8');
  r = runClient([`--file=${statusFile}`], mkPayload('Stop'));
  eq('状态文件损坏时仍退出 0', r.status, 0);
  eq('损坏后以空快照重建并写入', readStatus()?.sessions?.['wb:abcdef12-3456']?.status, 'ready');

  // 空 stdin 不能悬住（超时兜底 + 静默放行）。
  r = runClient([`--file=${statusFile}`, '--stdin-timeout=300'], '');
  eq('空 stdin 退出 0', r.status, 0);

  // —— ⑤ 回归：人工验收入口没被动过 ——
  section('⑤ 人工验收入口（pet-hook.mjs）的契约未受影响');
  const petHook = join(root, 'tools/pet-hook.mjs');
  const r2 = spawnSync(process.execPath, [petHook, '--help'], { encoding: 'utf8' });
  check('pet-hook.mjs 仍可执行', r2.status === 0 && /用法/.test(r2.stdout ?? ''), `status=${r2.status}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${passed} 项通过，${failures.length} 项失败\n`);
for (const f of failures) process.stdout.write(`  - ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
