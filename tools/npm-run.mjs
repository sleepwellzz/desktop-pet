// 替 `npm run <script>` 干活。
// 为什么需要：这个环境里的 Bash shim 没有 npm，而用 node -e 拼 cmd.exe 调用时
// 反斜杠/引号要转义四五层，极易出错（本项目已踩过一次）。
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv[2];
if (!script) {
  console.error('用法：node tools/npm-run.mjs <script>   （例：build / typecheck / start）');
  process.exit(2);
}

const r = spawnSync('cmd.exe', ['/c', `npm run ${script}`], { cwd: root, encoding: 'utf8', timeout: 600000 });
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
console.log(`\n[npm-run] npm run ${script} 退出码 = ${r.status}`);
process.exit(r.status ?? 1);
