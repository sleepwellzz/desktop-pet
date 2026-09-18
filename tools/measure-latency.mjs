#!/usr/bin/env node
// 判据 6：端到端延迟 —— 从「agent 那边发生」到「宠物收到」要多久。
//
// 为什么需要单独一个脚本：事件里的 `ts` 是**写侧**（hook 进程）产生时刻，不是宠物收到的时刻
// （ADR 020 实测两者只差 2ms —— 那只是 hook 进程内"落 payload → 写状态文件"的间隔）。
// 主进程落盘时会另写一个 `recvAt`（见 `src/main/index.ts` 的 `recordEvent`），
// **端到端延迟 = recvAt - ts**。本脚本就是把这个差值算出来。
//
// 用法：
//   node tools/measure-latency.mjs                  # 读默认路径
//   node tools/measure-latency.mjs --file=<路径>
//   node tools/measure-latency.mjs --since=60       # 只看最近 60 分钟
//   node tools/measure-latency.mjs --budget=1500    # 给出预算（ms），超出即判 FAIL
//
// 注意：**没有 `recvAt` 的旧记录无法测量**（那是加这个字段之前写的），脚本会把它们单独计数，
// 不参与统计 —— 否则会把"测不出来"误报成"延迟很低"。
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const file = arg('file', join(homedir(), '.desktop-pet', 'events.jsonl'));
const sinceMin = Number(arg('since', '0'));
const budget = arg('budget', '') ? Number(arg('budget', '')) : null;

if (!existsSync(file)) {
  console.log(`没有找到事件流水：${file}`);
  console.log('（要跑一次真实回合才会产生；先启动桌宠，再正常用 agent 干一次活。）');
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const cutoff = sinceMin > 0 ? Date.now() - sinceMin * 60_000 : 0;
const rows = [];
let bad = 0;
let unmeasurable = 0;
let skippedOld = 0;

for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { bad += 1; continue; }
  if (!o || typeof o !== 'object') { bad += 1; continue; }
  const ts = Number(o['ts']);
  const recvAt = Number(o['recvAt']);
  if (!Number.isFinite(ts)) { bad += 1; continue; }
  if (ts < cutoff) { skippedOld += 1; continue; }
  if (!Number.isFinite(recvAt)) { unmeasurable += 1; continue; }
  rows.push({
    sessionId: String(o['sessionId'] ?? '?'),
    status: String(o['status'] ?? '?'),
    origin: typeof o['origin'] === 'string' ? o['origin'] : '?',
    delay: recvAt - ts,
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const fmt = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);

console.log(`事件流水：${file}`);
console.log(`总行数 ${lines.length}｜解析失败 ${bad}｜超出时间窗 ${skippedOld}｜**无 recvAt（无法测量）${unmeasurable}**｜可测 ${rows.length}`);

if (!rows.length) {
  console.log('\n没有可测的样本。');
  if (unmeasurable > 0) {
    console.log(`（${unmeasurable} 条没有 recvAt —— 它们是在加这个字段之前写的。`);
    console.log('  重新构建并重启桌宠，再跑一次真实回合即可。）');
  }
  process.exit(2);
}

const all = rows.map((r) => r.delay).sort((a, b) => a - b);
console.log(`\n=== 端到端延迟（recvAt - ts）===`);
console.log(`  样本 ${all.length}｜最小 ${fmt(all[0])}｜中位 ${fmt(pct(all, 50))}｜p95 ${fmt(pct(all, 95))}｜最大 ${fmt(all[all.length - 1])}`);
const mean = all.reduce((a, b) => a + b, 0) / all.length;
console.log(`  平均 ${fmt(mean)}`);

const byOrigin = new Map();
for (const r of rows) {
  const g = byOrigin.get(r.origin) ?? [];
  g.push(r.delay);
  byOrigin.set(r.origin, g);
}
console.log(`\n按通道：`);
for (const [k, v] of [...byOrigin].sort()) {
  const s = v.slice().sort((a, b) => a - b);
  console.log(`  ${k.padEnd(8)} ${String(s.length).padStart(4)} 条｜中位 ${fmt(pct(s, 50))}｜p95 ${fmt(pct(s, 95))}｜最大 ${fmt(s[s.length - 1])}`);
}

const bySid = new Map();
for (const r of rows) {
  const g = bySid.get(r.sessionId) ?? [];
  g.push(r.delay);
  bySid.set(r.sessionId, g);
}
console.log(`\n按会话（最多 8 条）：`);
for (const [k, v] of [...bySid].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  const s = v.slice().sort((a, b) => a - b);
  console.log(`  ${k.padEnd(34)} ${String(s.length).padStart(4)} 条｜中位 ${fmt(pct(s, 50))}｜最大 ${fmt(s[s.length - 1])}`);
}

const negatives = all.filter((d) => d < 0).length;
if (negatives) {
  console.log(`\n⚠️ 有 ${negatives} 条延迟为负 —— 两侧时钟不同步或 ts 被写过，这些样本不可信。`);
}

let verdict = 'INFO（未给预算）';
if (budget !== null) {
  const over = all.filter((d) => d > budget).length;
  verdict = over === 0 ? `PASS（全部 ≤ ${fmt(budget)}）` : `FAIL（${over}/${all.length} 条超出 ${fmt(budget)}）`;
  console.log(`\n预算 ${fmt(budget)} ⇒ ${verdict}`);
}
console.log(`\n=== 判据 6：${verdict} ===`);
