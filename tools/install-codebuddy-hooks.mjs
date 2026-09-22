#!/usr/bin/env node
// 通道 A · WorkBuddy hook 配置安装器。
//
// 设计原则（对应 docs/design/m3-status-ecosystem.md §7 D5）：
//   1. **默认 dry-run**：不带 `--apply` 只打印将要写入的内容与影响面，一个字节都不写。
//   2. **只碰工程级**：默认写 `.codebuddy/settings.local.json`（PROJECT_LOCAL 作用域）。
//      用户级（`~/.codebuddy/`、`~/.workbuddy/`）会作用于**你所有** WorkBuddy 会话 ——
//      包括你正在用的那个；工程级的影响面可控、可 git 回滚，所以默认只用它。
//   3. **为什么是 settings.local.json 而不是 settings.json**：命令里带**本机绝对路径**
//      （node 可执行文件），天然因人而异；PROJECT_LOCAL 就是为这个准备的，且已进 .gitignore。
//   4. **幂等 + 可撤回**：重复安装只更新自己的那几条；`--uninstall` 只摘掉命令里含
//      `pet-hook-cb.mjs` 的条目，别人的 hook 一行不动。写入前先备份。
//
// 用法：
//   node tools/install-codebuddy-hooks.mjs                     # 预览（默认）
//   node tools/install-codebuddy-hooks.mjs --apply             # 落盘
//   node tools/install-codebuddy-hooks.mjs --apply --dump=...  # 落盘并记录原始 payload
//   node tools/install-codebuddy-hooks.mjs --uninstall --apply # 摘掉
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIGURED_EVENTS, VERBOSE_EVENTS } from './codebuddy-hook-map.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(root, 'tools', 'pet-hook-cb.mjs');
/** 标记串：靠它认出"哪些 hook 是我们装的"。卸载与幂等更新都依赖它。 */
const MARKER = 'pet-hook-cb.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
function opt(n, dflt) {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : dflt;
}

const apply = flag('apply');
const uninstall = flag('uninstall');
const shared = flag('shared'); // 写 settings.json（会进 git）而不是 settings.local.json
const eventsMode = opt('events', 'default');
const source = opt('source', 'wb');
const label = opt('label', 'WorkBuddy');
const dump = opt('dump', null);

if (eventsMode !== 'default' && eventsMode !== 'all') {
  process.stderr.write(`--events 只支持 default | all，收到 ${eventsMode}\n`);
  process.exit(2);
}
if (!existsSync(CLIENT)) {
  process.stderr.write(`找不到客户端：${CLIENT}\n`);
  process.exit(2);
}

const targetFile = join(root, '.codebuddy', shared ? 'settings.json' : 'settings.local.json');
const events = eventsMode === 'all'
  ? [...DEFAULT_CONFIGURED_EVENTS, ...VERBOSE_EVENTS]
  : [...DEFAULT_CONFIGURED_EVENTS];

/**
 * 命令串。**必须给两个路径都加双引号** —— 工程所在目录可能含空格
 * （例如 `...\Agent Base\...`），不加引号会被 shell 从空格处截断。
 * 这条在本项目已经栽过一次（见用户级记忆：含空格路径不要走 shell 拼接）。
 */
function buildCommand() {
  const parts = [
    `"${process.execPath}"`,
    `"${CLIENT}"`,
    `--source=${source}`,
    `--label=${label}`,
  ];
  if (dump) parts.push(`--dump="${dump}"`);
  return parts.join(' ');
}

/** 生成我们那一份 hooks（纯数据，便于与既有内容合并）。 */
function buildHooks() {
  const cmd = buildCommand();
  const hooks = {};
  for (const ev of events) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: cmd, timeout: 10, statusMessage: 'desktop-pet 记录状态' }] }];
  }
  return hooks;
}

/** 从某个事件的分组里摘掉我们装的 handler；返回新数组与该事件的"是否还有别人的 hook"。 */
function stripOurs(groups) {
  if (!Array.isArray(groups)) return { groups: null, removed: 0 };
  let removed = 0;
  const kept = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') { kept.push(g); continue; }
    const handlers = Array.isArray(g.hooks) ? g.hooks : [];
    const others = handlers.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(MARKER)));
    removed += handlers.length - others.length;
    if (others.length > 0) kept.push({ ...g, hooks: others });
    else if (handlers.length === 0) kept.push(g); // 原本就没有 handler 的分组原样保留
  }
  return { groups: kept.length ? kept : null, removed };
}

function readExisting() {
  if (!existsSync(targetFile)) return { doc: {}, existed: false };
  try {
    const j = JSON.parse(readFileSync(targetFile, 'utf8'));
    return { doc: j && typeof j === 'object' && !Array.isArray(j) ? j : {}, existed: true };
  } catch (e) {
    process.stderr.write(`目标文件不是合法 JSON，已中止（不会覆盖你的配置）：${String(e)}\n`);
    process.exit(2);
  }
}

const { doc, existed } = readExisting();
const before = JSON.stringify(doc, null, 2);

// —— 先摘后装：保证幂等（重复安装只会留下我们这一份） ——
const next = JSON.parse(JSON.stringify(doc));
next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
let removed = 0;
for (const [ev, groups] of Object.entries(next.hooks)) {
  const r = stripOurs(groups);
  removed += r.removed;
  if (r.groups === null) delete next.hooks[ev];
  else next.hooks[ev] = r.groups;
}
let added = 0;
if (!uninstall) {
  for (const [ev, groups] of Object.entries(buildHooks())) {
    next.hooks[ev] = [...(next.hooks[ev] ?? []), ...groups];
    added += 1;
  }
}
if (Object.keys(next.hooks).length === 0) delete next.hooks;

const after = JSON.stringify(next, null, 2);
const changed = before !== after;

// 预览必须可读：把 before/after 按行 diff。
function diffLines(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const setA = new Set(la);
  const setB = new Set(lb);
  const out = [];
  for (const l of la) if (!setB.has(l)) out.push(`  - ${l}`);
  for (const l of lb) if (!setA.has(l)) out.push(`  + ${l}`);
  return out.join('\n');
}

process.stdout.write(`desktop-pet · WorkBuddy hook 安装器\n`);
process.stdout.write(`  模式      ${apply ? '**落盘**' : '预览（dry-run，不改任何文件）'}\n`);
process.stdout.write(`  动作      ${uninstall ? '卸载（只摘掉本工程的 hook）' : '安装'}\n`);
process.stdout.write(`  目标文件  ${targetFile}${existed ? '（已存在，将合并）' : '（不存在，将新建）'}\n`);
process.stdout.write(`  作用域    PROJECT_LOCAL（只影响本工程目录下的会话）\n`);
process.stdout.write(`  客户端    ${CLIENT}\n`);
process.stdout.write(`  事件      ${events.join(' / ')}（共 ${events.length} 个）\n`);
process.stdout.write(`  命令      ${buildCommand()}\n`);
process.stdout.write(`  清理      ${removed} 条本工程既有 hook 被替换或摘除\n`);
process.stdout.write(`  新增      ${added} 个事件挂上\n`);
process.stdout.write(`\n影响面：\n`);
process.stdout.write(`  · 只影响 cwd 在本工程目录下的 WorkBuddy 会话；其它会话与其它工程不受影响\n`);
process.stdout.write(`  · 每个事件触发 = 一次 node 进程启动 ≈ 0.377s（本机实测）\n`);
process.stdout.write(`  · 客户端**退出码恒 0**、有 10s 超时上限 —— 它观测状态，不拦截 agent 的任何动作\n`);
process.stdout.write(`  · 卸载：node tools/install-codebuddy-hooks.mjs --uninstall --apply\n`);
if (changed) {
  process.stdout.write(`\n差异（- 现有 / + 写入后）：\n${diffLines(before, after)}\n`);
} else {
  process.stdout.write(`\n差异：无（目标文件已经是最新状态）\n`);
}

if (!apply) {
  process.stdout.write(`\n以上是预览。要落盘请加 --apply。\n`);
  process.exit(0);
}
if (!changed) {
  process.stdout.write(`\n无需写入。\n`);
  process.exit(0);
}

mkdirSync(dirname(targetFile), { recursive: true });
if (existed) {
  const backup = `${targetFile}.bak-${Date.now()}`;
  copyFileSync(targetFile, backup);
  process.stdout.write(`\n已备份原文件 → ${backup}\n`);
}
const tmp = `${targetFile}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, after + '\n', 'utf8');
  renameSync(tmp, targetFile);
} catch (e) {
  try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  process.stderr.write(`写入失败：${String(e)}\n`);
  process.exit(1);
}
process.stdout.write(`已写入 ${targetFile}\n`);
process.stdout.write(`\n下一步（验证 hook 是否真的被派发）：\n`);
process.stdout.write(`  1. 在 WorkBuddy 里对本工程发一条消息（会触发 UserPromptSubmit）\n`);
process.stdout.write(`  2. node tools/pet-hook-cb.mjs --list   # 应看到 wb: 前缀的会话\n`);
if (dump) process.stdout.write(`  3. 原始 payload 落在 ${dump}\n`);
