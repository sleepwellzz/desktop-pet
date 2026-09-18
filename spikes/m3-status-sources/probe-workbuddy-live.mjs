// 通道 B · WorkBuddy 被动源的信号采样探针（只读）。
//
// 为什么先写它再写适配器：
//   被动源要区分"agent 在干活"与"只是活着"。候选信号有一堆（心跳新鲜度、tasks 状态、
//   各运行目录的 mtime），但**哪一个真能区分，只能实测**——本项目已有六次"推断结论被实测推翻"。
//   所以在写 `source/workbuddy-live.ts` 之前，先用这个探针采一段真实时间线。
//
// 只读保证：全程不写任何 `~/.workbuddy` 下的文件，只 stat/read。
//   输出落到本探针自己的目录（`live-sample.jsonl`）。
//
// 用法：
//   node spikes/m3-status-sources/probe-workbuddy-live.mjs [--seconds=90] [--file=<输出路径>]
//
// 读什么（都来自实测事实，见 docs/design/m3-status-ecosystem.md §2.1）：
//   ~/.workbuddy/sessions/<pid>.json   → { pid, sessionId, cwd, lastHeartbeat, kind, url }
//   ~/.workbuddy/tasks/<uuid>/N.json   → { subject, status, updatedAt }
//   ~/.workbuddy/{file-history,projects,logs,plans}/ → 目录最新 mtime
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
function argNum(name, dflt) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = Number(hit.slice(name.length + 3));
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const seconds = argNum('seconds', 90);
const outArg = argv.find((a) => a.startsWith('--file='));
const outFile = outArg
  ? resolve(outArg.slice('--file='.length))
  : join(import.meta.dirname, 'live-sample.jsonl');

const WB = join(homedir(), '.workbuddy');

/** 读一个 JSON 文件；失败返回 null（探针绝不能因为读不到文件而挂掉）。 */
function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** sessions/<pid>.json → 归一化心跳记录。取值白名单化（文件是任意进程可写的投毒点）。 */
function readSessions(now) {
  const dir = join(WB, 'sessions');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const j = readJson(join(dir, n));
    if (!j || typeof j !== 'object') continue;
    const hb = typeof j.lastHeartbeat === 'number' ? j.lastHeartbeat : null;
    out.push({
      file: n,
      pid: typeof j.pid === 'number' ? j.pid : null,
      sessionId: typeof j.sessionId === 'string' ? j.sessionId.slice(0, 40) : null,
      cwd: typeof j.cwd === 'string' ? j.cwd : null,
      kind: typeof j.kind === 'string' ? j.kind : null,
      /** 心跳距今多少毫秒 —— 这是"这个会话还活着吗"的主判据候选。 */
      ageMs: hb === null ? null : Math.round(now - hb),
    });
  }
  return out.sort((a, b) => (a.ageMs ?? 1e18) - (b.ageMs ?? 1e18));
}

/** tasks/<uuid>/N.json → 按状态计数。用来试"任务在跑"能不能当 running 的判据。 */
function readTasks() {
  const dir = join(WB, 'tasks');
  let uuids;
  try {
    uuids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { dirs: 0, byStatus: {}, newestMtime: null, newestAt: null };
  }
  const byStatus = {};
  let newestMtime = null;
  let newestAt = null;
  for (const u of uuids) {
    const d = join(dir, u);
    let files;
    try {
      files = readdirSync(d).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(d, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (newestMtime === null || st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs;
        newestAt = st.mtime.toISOString();
      }
      const j = readJson(p);
      const s = j && typeof j.status === 'string' ? j.status : '(未知)';
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
  }
  return { dirs: uuids.length, byStatus, newestMtime, newestAt };
}

/** 若干目录的"最新子项 mtime" —— 用来找有没有哪一处的写入跟着 agent 的活儿走。 */
function newestIn(rel, depth = 3) {
  const root = join(WB, rel);
  let best = null;
  let count = 0;
  function walk(p, d) {
    if (d > depth) return;
    let ents;
    try {
      ents = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      count += 1;
      const f = join(p, e.name);
      try {
        const st = statSync(f);
        if (best === null || st.mtimeMs > best) best = st.mtimeMs;
      } catch {
        /* 忽略 */
      }
      if (e.isDirectory()) walk(f, d + 1);
    }
  }
  walk(root, 0);
  return { newest: best, entries: count };
}

const CANDIDATE_DIRS = ['tasks', 'file-history', 'projects', 'plans', 'logs', 'changes-index', 'artifact-index'];

const startedAt = Date.now();
const lines = [];
let tick = 0;
let prevFingerprint = '';

function sample() {
  const now = Date.now();
  const sessions = readSessions(now);
  const tasks = readTasks();
  const dirs = {};
  for (const d of CANDIDATE_DIRS) dirs[d] = newestIn(d);

  const rec = {
    t: now - startedAt,
    iso: new Date(now).toISOString(),
    sessions: sessions.map((s) => ({ pid: s.pid, ageMs: s.ageMs, kind: s.kind, cwd: s.cwd })),
    tasks,
    dirs,
  };
  lines.push(JSON.stringify(rec));

  // 只在"指纹变了"时打屏幕，避免 90 行噪声。
  const fp = JSON.stringify({
    s: sessions.map((s) => `${s.pid}:${s.ageMs === null ? 'n' : Math.round(s.ageMs / 1000)}`),
    t: tasks.byStatus,
    d: Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, v.newest === null ? null : Math.round((now - v.newest) / 1000)])),
  });
  if (fp !== prevFingerprint) {
    prevFingerprint = fp;
    const ageList = sessions.map((s) => `${s.pid}=${s.ageMs === null ? '?' : (s.ageMs / 1000).toFixed(1) + 's'}`).join(' ');
    const dirList = Object.entries(dirs)
      .map(([k, v]) => `${k}:${v.newest === null ? '-' : Math.round((now - v.newest) / 1000) + 's'}`)
      .join(' ');
    process.stdout.write(
      `[${((now - startedAt) / 1000).toFixed(0)}s] 心跳年龄 ${ageList || '(无会话)'}\n` +
        `        任务 ${JSON.stringify(tasks.byStatus)}（${tasks.dirs} 组）\n` +
        `        目录新鲜度 ${dirList}\n`,
    );
  }
}

process.stdout.write(
  `WorkBuddy 被动源信号采样开始：${seconds}s @1Hz\n` +
    `  监测 ~/.workbuddy/{sessions,tasks,${CANDIDATE_DIRS.join(',')}}\n` +
    `  只读；输出 → ${outFile}\n\n`,
);

sample();
const timer = setInterval(() => {
  tick += 1;
  sample();
  if (Date.now() - startedAt >= seconds * 1000) {
    clearInterval(timer);
    finish();
  }
}, 1000);

function finish() {
  const now = Date.now();
  const sessions = readSessions(now);
  const tasks = readTasks();
  const dirs = {};
  for (const d of CANDIDATE_DIRS) dirs[d] = newestIn(d);

  process.stdout.write(`\n──── 采样结束（${(seconds).toFixed(0)}s，${tick + 1} 个采样点）────\n`);
  process.stdout.write(`存活会话（按心跳新鲜度）：\n`);
  for (const s of sessions) {
    process.stdout.write(
      `  pid=${s.pid}  age=${s.ageMs === null ? '?' : (s.ageMs / 1000).toFixed(1) + 's'}  kind=${s.kind}  cwd=${s.cwd}\n`,
    );
  }
  process.stdout.write(`任务状态分布: ${JSON.stringify(tasks.byStatus)}\n`);
  process.stdout.write(`各目录最新写入距现在：\n`);
  for (const [k, v] of Object.entries(dirs)) {
    process.stdout.write(`  ${k.padEnd(16)} ${v.newest === null ? '（无内容）' : Math.round((now - v.newest) / 1000) + 's 前'}  条目 ${v.entries}\n`);
  }

  try {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
    process.stdout.write(`\n原始时序 → ${outFile}\n`);
  } catch (e) {
    process.stdout.write(`\n写采样文件失败：${String(e)}\n`);
  }
  process.exit(0);
}
