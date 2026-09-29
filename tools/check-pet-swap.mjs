// 换宠物流程的静态判据：给**任意**宠物包做体检，不启动 Electron。
//
// 为什么需要（ADR 049）：
//   工程里换宠物的基础其实已经很齐（`loadPack(packDir)` 收目录参数、`--pet=` 启动参数、
//   网格规格由 `spriteVersionNumber` 推导、行号全走 behavior-map 而非硬编码），
//   **但"这个包能不能用"目前只能靠双击试** —— 而双击看不出下面这些：
//
//   ① `loadPack` 对「behavior-map 有、desktop-pet.json 没有」的状态只 `warnings.push` 后
//      `continue`（pack.ts:87）⇒ **少配一个动作不报错，只是静默少一个**。
//      换宠物时这正是最常见的翻车方式：包能加载，宠物少了"挥手"或"左右走"。
//   ② 它只强制要求 `idle` 存在。**5 个业务状态与 9 个面板动作全靠 statusMap/actions 指过去**，
//      少配一个 ⇒ 该按钮/该状态永远不出现，且无任何报错。
//   ③ 托盘图标写死在工程根 `assets/tray.ico`（index.ts:520）⇒ **换完宠物托盘还是旧的脸**。
//   ④ 锚点不自洽（`offsetY ≠ groundY - baselineY`）在 loadPack 里会抛，但**只有加载到才抛**。
//
// ⇒ 这个检查的定位：**在打包/分发之前把上面四条堵掉**，并给出可直接照做的修复动作。
//   它不重复 `loadPack` 已有的校验（魔数、尺寸、体积、路径穿越、行号/帧数一致性）——
//   **判据不该把它能查的重复一遍**（ADR 044 §2 纪律：判据不该被它测以外的东西判红）。
//
// 用法：
//   node tools/check-pet-swap.mjs                      体检工程根（= 淘淘自己）
//   node tools/check-pet-swap.mjs <目录> [<目录>…]     体检指定的宠物包
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 业务状态全集 —— 抄自 src/kernel/status.ts 的 PET_STATUSES。 */
export const PET_STATUSES = ['idle', 'running', 'needs-input', 'blocked', 'ready'];
/** 气泡与动作排会用到的动画状态。桌面宠物自己的 = 这 9 个。 */
const TAOTAO_STATES = [
  'idle', 'running-right', 'running-left', 'waving', 'jumping',
  'failed', 'waiting', 'running', 'review',
];

const readJson = (p, label) => {
  if (!existsSync(p)) return { error: `缺少 ${label}` };
  try { return { value: JSON.parse(readFileSync(p, 'utf8')) }; }
  catch (e) { return { error: `${label} 不是合法 JSON：${e.message}` }; }
};

/**
 * 体检一个宠物包。
 * 返回 { errors[], warnings[], info{} } —— errors 是"这个包不能分发"，warnings 是"能用但要留意"。
 */
export function checkPack(packDir) {
  const dir = resolve(packDir);
  const errors = [];
  const warnings = [];
  const info = { dir, states: [], missingBusiness: [], missingActions: [] };

  if (!existsSync(dir)) return { errors: [`宠物包目录不存在：${dir}`], warnings, info };

  const m = readJson(join(dir, 'pet.json'), 'pet.json');
  const b = readJson(join(dir, 'behavior-map.json'), 'behavior-map.json');
  const r = readJson(join(dir, 'desktop-pet.json'), 'desktop-pet.json');
  for (const [res, name] of [[m, 'pet.json'], [b, 'behavior-map.json'], [r, 'desktop-pet.json']]) {
    if (res.error) { errors.push(res.error); return { errors, warnings, info }; }
  }
  const { value: manifest } = m, { value: behavior } = b, { value: runtime } = r;

  // —— 基本字段（与 loadPack 同源，但把"报错点"提前到静态阶段）——
  if (!manifest.id) errors.push('pet.json 缺少 id');
  if (!manifest.displayName) warnings.push('pet.json 没有 displayName —— 托盘悬停与面板会回落到 id');
  if (!manifest.spritesheetPath) errors.push('pet.json 缺少 spritesheetPath');

  // —— 精灵图存在（loadPack 会抛，但静态先报出来更直观）——
  const sheet = manifest.spritesheetPath ? join(dir, manifest.spritesheetPath) : null;
  if (sheet && !existsSync(sheet)) errors.push(`精灵图不存在：${manifest.spritesheetPath}`);
  else if (sheet) {
    const mb = (statSync(sheet).size / 1048576).toFixed(1);
    info.sheetBytes = statSync(sheet).size;
    if (statSync(sheet).size > 20 * 1048576) warnings.push(`精灵图 ${mb} MiB，超过官方 20 MiB 上限（本地可用，建议压缩）`);
  }

  // —— ② 状态覆盖：behavior-map 有、runtime 没有 ⇒ loadPack 静默跳过（pack.ts:87）——
  const bStates = Object.keys(behavior.states ?? {});
  const rStates = Object.keys(runtime.states ?? {});
  info.states = bStates;
  for (const id of bStates) {
    if (!rStates.includes(id)) {
      errors.push(`状态 ${id} 在 behavior-map.json 里有、desktop-pet.json 里没有 —— 加载时会被静默跳过，宠物少这个动作`);
    }
  }
  for (const id of rStates) {
    if (!bStates.includes(id)) {
      errors.push(`状态 ${id} 在 desktop-pet.json 里有、behavior-map.json 里没有 —— 同样会被跳过`);
    }
  }
  if (!bStates.includes('idle')) errors.push('缺少 idle —— loadPack 会直接抛"无法作为常驻状态"');

  // —— 业务状态可达性：statusMap 指向的动画状态必须真实存在 ——
  const target = (s) => s && s.state;
  for (const [biz, map] of Object.entries(runtime.statusMap ?? {})) {
    const t = target(map);
    if (t && !bStates.includes(t)) {
      errors.push(`statusMap.${biz} 指向动画状态「${t}」，但 behavior-map.json 里没有它 ⇒ agent 进入 ${biz} 时宠物无动作可演`);
    }
    if (t && map.then && !bStates.includes(map.then)) {
      errors.push(`statusMap.${biz}.then 指向「${map.then}」，但 behavior-map.json 里没有它`);
    }
  }
  for (const biz of PET_STATUSES) {
    if (!runtime.statusMap?.[biz]) errors.push(`statusMap 缺业务状态「${biz}」—— 五个业务状态都要有落点`);
  }

  // —— 面板动作排：按钮只从 actions.list 生成，少配 = 少按钮 ——
  const actions = runtime.actions?.list ?? [];
  for (const a of actions) {
    if (a.state && !bStates.includes(a.state)) {
      errors.push(`动作排引用了不存在的状态「${a.state}」⇒ 面板会渲染出一个演不出来的按钮`);
    }
  }
  if (runtime.controlBar?.actionColumns && actions.length) {
    const rows = Math.ceil(actions.length / runtime.controlBar.actionColumns);
    // 面板高度是四段算式（idle 72 → 132 DIP），动作排多一行就得重算 —— 提示而非报错
    info.actionRows = rows;
  }

  // —— ④ 锚点自洽：静态先算一遍，不用等到加载时抛 ——
  const groundY = runtime.anchor?.groundY;
  if (typeof groundY !== 'number') errors.push('desktop-pet.json 缺 anchor.groundY');
  else {
    for (const [id, rs] of Object.entries(runtime.states ?? {})) {
      if (typeof rs.baselineY !== 'number') { errors.push(`状态 ${id} 缺 baselineY（锚点无法自洽）`); continue; }
      if (rs.offsetY !== groundY - rs.baselineY) {
        errors.push(`状态 ${id} 锚点不自洽：offsetY=${rs.offsetY}，但 groundY - baselineY = ${groundY - rs.baselineY} ⇒ 脚会离地`);
      }
    }
  }

  // —— ③ 托盘图标（ADR 049 修的绑定问题：改为随包解析，这里同步校验）——
  const tray = join(dir, 'tray.ico');
  info.hasTray = existsSync(tray);
  if (!info.hasTray) {
    warnings.push('包内没有 tray.ico ⇒ 托盘会用工程默认图标（不是这个宠物的脸）。'
      + '生成：python tools/make-tray-icon.py <图集路径>');
  }

  return { errors, warnings, info };
}

export function checkAll(dirs) {
  const targets = dirs.length ? dirs : [root];
  return targets.map((d) => ({ ...checkPack(d), isDefault: !dirs.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const dirs = process.argv.slice(2);
  const results = checkAll(dirs);
  let bad = 0;
  for (const { errors, warnings, info } of results) {
    const head = info.isDefault ? '工程根（淘淘自己）' : info.dir;
    process.stdout.write(`\n── ${head} ──\n`);
    process.stdout.write(`状态 ${info.states.length} 个：${info.states.join(', ') || '（无）'}\n`);
    for (const w of warnings) process.stdout.write(`  warn  ${w}\n`);
    for (const e of errors) { process.stdout.write(`  FAIL  ${e}\n`); bad += 1; }
    if (!errors.length) process.stdout.write('  ✅ 可用\n');
  }
  process.stdout.write(bad ? `\n${bad} 个问题需修\n` : '\n全部宠物包可用\n');
  process.exit(bad ? 1 : 0);
}
