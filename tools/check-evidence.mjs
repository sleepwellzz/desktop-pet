// 入库探针证据的卫生检查：不启动 Electron，纯静态。
//
// 为什么需要（ADR 047 / ADR 048）：
//   入库的 `.out` / `*.json` 证据**是被 ADR 直接引用的论证依据**
//   （ADR 008/014/023/035/038/039 都点名了具体文件），所以它们不能出库。
//   但"能引用"不等于"永远新鲜"：P0-1 发现六份证据内含
//   `[uncaught] TypeError: Object has been destroyed` 却报 `PASS` ——
//   **内含未捕获异常却报通过**，这种文件一旦入库就在系统性地把"崩溃过"说成"通过"。
//   而 AGENTS.md 纪律 3(b) 推荐的 mtime 验证法在这里会给错答案
//   （内容是 09-18 的、mtime 是 09-22 的）。
//
// 本检查只报"可疑"，不删不改任何文件：删证据是人的决定，不是脚本的。
// 用法：node tools/check-evidence.mjs
//       （已接进 tools/status-arbiter.test.mjs 的 ⓪c 节）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 内含这些标记却声称通过 = 证据自相矛盾，必须报出来。 */
const CRASH_MARKERS = [
  /\[uncaught\]/i,
  /Uncaught\s+(TypeError|Error|Exception)/i,
  /A JavaScript error occurred in the main process/i,
];
/** 声称通过的两种写法。 */
const PASS_MARKERS = [/\bPASS\b/, /"verdict"\s*:\s*"PASS"/, /探针判定[：:]\s*PASS/];

function listEvidence(dir = join(root, 'spikes')) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(out|json|log)$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function checkEvidence() {
  const findings = [];
  let scanned = 0;

  for (const p of listEvidence()) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    scanned += 1;
    const rel = relative(root, p).split('\\').join('/');

    const crash = CRASH_MARKERS.find((re) => re.test(text));
    if (!crash) continue;
    const claimsPass = PASS_MARKERS.some((re) => re.test(text));
    findings.push({
      file: rel,
      marker: String(crash),
      claimsPass,
      severity: claimsPass ? 'error' : 'warn',
      // 判据"测了但没验成"与"测了且验出崩溃"是两件事，前者更危险
      note: claimsPass
        ? '内含未捕获异常却报 PASS —— 这份证据在把"崩溃过"说成"通过"，任何据此下的结论都不成立'
        : '内含未捕获异常（未声称通过）—— 若这不是有意留证的失败现场，应重跑该探针',
    });
  }
  return { ok: findings.every((f) => f.severity !== 'error'), findings, scanned };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = checkEvidence();
  process.stdout.write(`扫描 ${r.scanned} 份入库探针证据\n`);
  for (const f of r.findings) {
    const tag = f.severity === 'error' ? 'FAIL' : 'warn';
    process.stdout.write(`  ${tag} ${f.file}\n        ${f.note}\n`);
  }
  if (r.ok) { process.stdout.write('\n没有"内含未捕获异常却报通过"的证据\n'); process.exit(0); }
  process.stderr.write(
    '\n这些证据已被 ADR 引用为论证依据，所以**不能靠删除来修**（那会切断决策链）。\n'
    + '正确处置只有一条：**重跑对应探针**，产出真实的新证据后覆盖。\n'
    + '重跑会启动 Electron（弹窗、抢焦点、可能改写产物）⇒ 先向用户确认。\n');
  process.exit(1);
}
