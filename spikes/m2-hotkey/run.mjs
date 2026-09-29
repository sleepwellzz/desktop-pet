// 气泡与快捷键探针的驱动：启动 → 等落盘 → 打印日志与判定。
// 用法：node spikes/m2-hotkey/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = path.join(DIR, 'probe-bubble-hotkey.js');
const REPORT = path.join(DIR, 'bubble-hotkey.json');
const LOG = path.join(DIR, 'bubble-hotkey.log');
const STATUS_FILE = path.join(DIR, 'probe-status.json');
// 探针写的是固定文件名（它自己不知道 RUN_ID），所以最后由本驱动把临时文件落位。
// 若探针在写报告前就抛了，REPORT_TMP 会是空壳 —— 那种情况**不 rename**，
// 让已入库的旧证据原封不动地留着（它会过时，但不会凭空消失）。
const REPORT_FRESH_MIN = 1; // 1 字节 —— 空壳为 0 字节，据此区分

// 证据产物的写法：**先写临时文件，确认拿到新报告后再 rename 覆盖**。
//
// 为什么不能先 rmSync（旧写法）：判据失败时（新报告没生成）旧证据已经没了，
// 而 diff 里只表现为“文件被删了”而不是“判据红了” —— 两种信号的含义完全相反
// （ADR 纪律 3(b)：我怎么证明这份证据是本次产生的？rename 之后答案就是确定的）。
// 旧写法在 m2-hotkey 上真实造成过损失：ADR 032 删掉快捷键后探针必然抛错，
// 照 build-probe.md 跑一次“必跑判据”的净效果是既没验成、又丢了已入库的那份。
const RUN_ID = `${process.pid}`;
const REPORT_TMP = `${REPORT}.${RUN_ID}.tmp`;
const LOG_TMP = `${LOG}.${RUN_ID}.tmp`;

// 探针自己会清空 LOG 并写 REPORT（见 probe-bubble-hotkey.js 顶部），所以**不能**让它
// 写正式文件名 —— 必须用环境变量把它的输出指到临时路径，拿到结果后再 rename 覆盖。
// 之前那一版只改了驱动侧、没改探针侧，两者会各写各的：探针把正式那份截断并重写，
// 而 rename 又拿临时那份盖回去 —— 判据失败时仍然会毁掉旧证据。**这正是“改了但没改全”的形状。**
try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PET_ALLOW_MULTI = '1';   // 单实例锁的逃生开关：探针要能独立起实例（P0-6）
env.PROBE_LOG = LOG_TMP;
env.PROBE_REPORT = REPORT_TMP;
const child = spawn(EXE, [PROBE], { cwd: ROOT, detached: true, stdio: 'ignore', env, windowsHide: true });
child.unref();
console.log(`spawned electron pid=${child.pid} probe=probe-bubble-hotkey.js`);

// 等待期间只认临时报告路径 —— 正式文件在这一刻**必须还没被动过**。
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 4000));
  if (fs.existsSync(REPORT_TMP)) break;
}
console.log('--- bubble-hotkey.log ---');
try { console.log(fs.readFileSync(LOG_TMP, 'utf8')); } catch (e) { console.log('(no log) ' + e.message); }

let verdict = null;
try {
  const r = JSON.parse(fs.readFileSync(REPORT_TMP, 'utf8'));
  verdict = r.verdict || '(未完成)';
  console.log(`\n探针判定：${verdict} ${r.failures?.length ? '—— ' + r.failures.join('；') : ''}`);
} catch { /* 下面统一处理 */ }
try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* ignore */ }

// —— 落位：只有真的拿到一份新报告时才覆盖旧证据。——
if (verdict !== null) {
  for (const [tmp, dst] of [[REPORT_TMP, REPORT], [LOG_TMP, LOG]]) {
    try { fs.renameSync(tmp, dst); } catch (e) { console.error(`写回 ${path.basename(dst)} 失败：${e.message}`); }
  }
  console.log('证据已覆盖为本次运行结果。');
} else {
  console.error(
    '\n⚠ 探针没有产出报告（可能在中途抛错）。**已入库的旧证据保持原样未动**。\n'
    + '  先看上面的日志定位错误；确认旧证据确实该作废时，手动删除 bubble-hotkey.json。');
  for (const tmp of [REPORT_TMP, LOG_TMP]) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
  process.exitCode = 1;
}