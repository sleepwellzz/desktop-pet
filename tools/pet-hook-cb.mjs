#!/usr/bin/env node
// 通道 A · 挂在 agent 的 hook 点上的客户端：**读 stdin JSON → 写状态文件**。
//
// 与 `pet-hook.mjs` 的分工（两个都保留，不是替代关系）：
//   - `pet-hook.mjs`：**人工验收入口**（`喂状态.bat` 与多个探针依赖它），参数是人话，
//     刻意不动它，避免把既有回归的着力点搬走。
//   - 本文件：**机器入口**，被 agent 的 hook 配置调用，输入是 hook 给的 stdin JSON。
// 两者写的是同一份快照与同一个 schema，所以仲裁器与渲染层完全不需要知道有几条通道。
//
// 退出码纪律（Claude 系 hook 的约定）：0 = 放行；2 = 阻断。**本客户端永远返回 0** ——
// 它只做观测，不该有能力拦住 agent 的任何一个动作。任何异常都吞掉并写 stderr。
//
// 用法（写进 .codebuddy/settings.json 的 command 里）：
//   node "<工程>/tools/pet-hook-cb.mjs" --source=wb --label=WorkBuddy
//
// 选项：
//   --source=<前缀>   会话 id 命名空间前缀（默认 wb）。多 agent 并存时靠它隔离。
//   --label=<名字>    标题前缀，显示用（默认 WorkBuddy）。
//   --file=<路径>     状态文件（默认 ~/.desktop-pet/status.json）。
//   --dump=<路径>     把**原始 stdin 原样追加**到该文件 —— 判据 1 取证用（payload 实测，不靠文档）。
//   --list            只打印当前快照后退出。
//   --stdin-timeout=<ms>  stdin 迟迟不结束的兜底（默认 5000）。hook 若被挂住，宁可空跑也不能悬着。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeHookEvent } from './codebuddy-hook-map.mjs';

const SCHEMA = 'desktop-pet/status/v1';
const DEFAULT_FILE = join(homedir(), '.desktop-pet', 'status.json');

const argv = process.argv.slice(2);
const opts = { source: 'wb', label: 'WorkBuddy', file: DEFAULT_FILE, dump: null, list: false, stdinTimeout: 5000 };
for (const a of argv) {
  if (a === '--list') opts.list = true;
  else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length) || 'wb';
  else if (a.startsWith('--label=')) opts.label = a.slice('--label='.length) || 'WorkBuddy';
  else if (a.startsWith('--file=')) opts.file = resolve(a.slice('--file='.length));
  else if (a.startsWith('--dump=')) opts.dump = resolve(a.slice('--dump='.length));
  else if (a.startsWith('--stdin-timeout=')) {
    const n = Number(a.slice('--stdin-timeout='.length));
    if (Number.isFinite(n) && n > 0) opts.stdinTimeout = n;
  }
}

function readExisting() {
  if (!existsSync(opts.file)) return { schema: SCHEMA, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(opts.file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
      return { schema: raw.schema ?? SCHEMA, sessions: { ...raw.sessions } };
    }
  } catch {
    /* 读不懂就以空快照重建 —— hook 不能因为读文件失败而挂掉 agent */
  }
  return { schema: SCHEMA, sessions: {} };
}

if (opts.list) {
  process.stdout.write(existsSync(opts.file) ? readFileSync(opts.file, 'utf8') : `（状态文件尚不存在：${opts.file}）\n`);
  process.exit(0);
}

/** 读满 stdin。带超时兜底：hook 被挂住时不能悬在这里等。 */
function readStdin(timeoutMs) {
  return new Promise((resolveText) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveText(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const text = await readStdin(opts.stdinTimeout);

// 取证：**先落原样 payload**，再解析。判据 1 要的是"agent 实际给了什么"，
// 而不是"文档说它会给什么"—— 本项目已有六次"推断被实测推翻"，这是防第七次的那一步。
if (opts.dump) {
  try {
    mkdirSync(dirname(opts.dump), { recursive: true });
    appendFileSync(opts.dump, JSON.stringify({ at: Date.now(), raw: text }) + '\n', 'utf8');
  } catch (e) {
    process.stderr.write(`[pet-hook-cb] 写 dump 失败：${String(e)}\n`);
  }
}

const ev = normalizeHookEvent(text, { source: opts.source, label: opts.label });
if (!ev) {
  // 未知事件 / 读不懂 / 非法取值 —— 一律静默放行，不写、不动别人的状态。
  process.exit(0);
}

const doc = readExisting();
if (ev.clear) {
  delete doc.sessions[ev.sessionId];
} else {
  const prev = doc.sessions[ev.sessionId] ?? {};
  const entry = { status: ev.status, ts: Date.now() };
  const title = ev.title ?? (typeof prev.title === 'string' ? prev.title : undefined);
  if (title) entry.title = title;
  doc.sessions[ev.sessionId] = entry;
}

// 原子替换：写临时文件再 rename。直接截断重写会让读侧读到半截 JSON。
mkdirSync(dirname(opts.file), { recursive: true });
const tmp = `${opts.file}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(tmp, opts.file);
} catch (e) {
  try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  process.stderr.write(`[pet-hook-cb] 写状态文件失败：${String(e)}\n`);
}

// 永远 0。见文件头的退出码纪律。
process.exit(0);
