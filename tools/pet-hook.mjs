#!/usr/bin/env node
// 状态注入器 / 真实 hook 的落点。
//
// 两种用法，是同一条命令：
//   1. 接 agent hook：在 Codex / Claude Code 等工具的钩子点调用它，
//      例如 Stop 时写 ready、需要授权时写 needs-input；
//   2. 手工模拟器：直接在终端敲同一条命令，链路不依赖任何 agent 就能验证。
//
// 用法：
//   node tools/pet-hook.mjs <idle|running|needs-input|blocked|ready> [选项]
//
// 选项：
//   --session=<id>   会话标识（默认 default）。多会话聚合靠它分组。
//   --title=<text>   会话标题，用于日志与将来的气泡文案。
//   --file=<path>    状态文件路径（默认 ~/.desktop-pet/status.json）。
//   --clear          不带状态值使用：把该会话从文件里移除（等价于收尾）。
//   --list           只打印当前文件内容，不修改。
//
// 示例（写进 agent 的 hook 配置）：
//   node "E:/.../desktop-pet/tools/pet-hook.mjs" running --session=abc --title="重构 pack.ts"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const STATUSES = ['idle', 'running', 'needs-input', 'blocked', 'ready'];
const DEFAULT_FILE = join(homedir(), '.desktop-pet', 'status.json');
const SCHEMA = 'desktop-pet/status/v1';

function usage(code) {
  const lines = [
    '用法：node tools/pet-hook.mjs <idle|running|needs-input|blocked|ready> [选项]',
    '',
    '选项：',
    '  --session=<id>   会话标识（默认 default）',
    '  --title=<text>   会话标题',
    `  --file=<path>    状态文件路径（默认 ${DEFAULT_FILE}）`,
    '  --clear          移除该会话而不是写入状态',
    '  --list           打印当前文件内容后退出',
    '',
    '例：node tools/pet-hook.mjs needs-input --title="要你确认删除 3 个文件"',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length === 0) usage(2);

const opts = { session: 'default', title: undefined, file: DEFAULT_FILE, clear: false, list: false };
const positional = [];
for (const a of argv) {
  if (a === '--clear') opts.clear = true;
  else if (a === '--list') opts.list = true;
  else if (a.startsWith('--session=')) opts.session = a.slice('--session='.length) || 'default';
  else if (a.startsWith('--title=')) opts.title = a.slice('--title='.length);
  else if (a.startsWith('--file=')) opts.file = resolve(a.slice('--file='.length));
  else if (a === '-h' || a === '--help') usage(0);
  else if (a.startsWith('-')) { process.stderr.write(`未知选项：${a}\n`); usage(2); }
  else positional.push(a);
}

const file = opts.file;

if (opts.list) {
  process.stdout.write(existsSync(file) ? readFileSync(file, 'utf8') : `（状态文件尚不存在：${file}）\n`);
  process.exit(0);
}

const status = positional[0];
// --clear 不带状态值（它表达的是"这个会话收尾了"），其余情况状态值是必需的。
if (!status && !opts.clear) { process.stderr.write('缺少状态值。\n'); usage(2); }
if (status && !opts.clear && !STATUSES.includes(status)) {
  process.stderr.write(`非法状态：${status}（可选 ${STATUSES.join(' / ')}）\n`);
  usage(2);
}
if (positional.length > 1) { process.stderr.write(`多余的参数：${positional.slice(1).join(' ')}\n`); usage(2); }

/** 读现有文件。内容损坏时不抛异常，直接以空快照重建 —— hook 绝不能因为读文件失败而挂掉 agent。 */
function readExisting() {
  if (!existsSync(file)) return { schema: SCHEMA, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
      return { schema: raw.schema ?? SCHEMA, sessions: { ...raw.sessions } };
    }
    return { schema: SCHEMA, sessions: {} };
  } catch {
    return { schema: SCHEMA, sessions: {} };
  }
}

const doc = readExisting();
if (opts.clear) {
  delete doc.sessions[opts.session];
} else {
  // 保留已有 title，除非本次显式给了新的
  const prev = doc.sessions[opts.session] ?? {};
  const entry = { status, ts: Date.now() };
  const title = opts.title ?? (typeof prev.title === 'string' ? prev.title : undefined);
  if (title) entry.title = title;
  doc.sessions[opts.session] = entry;
}

// 原子替换：写临时文件再 rename。直接截断重写会让读侧读到半截 JSON
// （读侧虽然会保留上一次好值，但会刷出一条无意义的告警）。
mkdirSync(dirname(file), { recursive: true });
const tmp = `${file}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
} catch (e) {
  try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  process.stderr.write(`写入状态文件失败：${String(e)}\n`);
  process.exit(1);
}

process.stdout.write(
  opts.clear
    ? `已移除会话 ${opts.session} → ${file}\n`
    : `已写入 ${opts.session} = ${status}${doc.sessions[opts.session].title ? `（${doc.sessions[opts.session].title}）` : ''} → ${file}\n`,
);
