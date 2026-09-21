// 用户偏好持久化。
//
// 为什么放用户目录（`~/.desktop-pet/prefs.json`）而不是工程的 `desktop-pet.json`：
// 后者是宠物包的 sidecar、已进 git，把运行期偏好写进去会造成版本库 churn，
// 而且换一只宠物包偏好就丢了 —— 而"我喜欢多大"显然不是某只包的属性。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Prefs {
  /** 用户选定的缩放。缺省表示"跟随宠物包的 defaultScale"。 */
  scale?: number;
  // （原 `hotkey?: string` 随全局快捷键功能一起删除，ADR 032。
  //  旧 prefs.json 里若还留着这个字段，loadPrefs 会直接忽略它 —— 不报错、不迁移。）
}

export function prefsPath(): string {
  return join(homedir(), '.desktop-pet', 'prefs.json');
}

/** 读偏好。文件不存在/损坏一律回落到空偏好 —— 读偏好失败绝不能挡住宠物启动。 */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(prefsPath(), 'utf8')) as Record<string, unknown>;
    const p: Prefs = {};
    const scale = raw['scale'];
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) p.scale = scale;
    // 旧版本写过的 `hotkey` 字段在这里被自然忽略（ADR 032）—— 不需要迁移逻辑，
    // 读不到就当没有，写回时也不会再带上它。
    return p;
  } catch {
    return {};
  }
}

/** 合并写入。显式传 `undefined` 表示删掉这一项（例如"重置大小"）。 */
export function savePrefs(patch: Partial<Prefs>): void {
  const next: Prefs = { ...loadPrefs() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k as keyof Prefs];
    else (next as Record<string, unknown>)[k] = v;
  }
  const file = prefsPath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 临时文件 + rename 原子替换：与状态文件写入同一套做法，避免读侧读到半截 JSON
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    console.warn('[pet] 偏好写入失败（不影响运行）：' + String(e));
  }
}
