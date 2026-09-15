// 宠物包加载与校验：pet.json（原生，只读）+ behavior-map.json + desktop-pet.json（自研 sidecar）。
// 纯 TS，不依赖 Electron。校验失败一律抛错，绝不带病进入渲染层。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type {
  BehaviorMap, BehaviorState, PetManifest, PetPack, ResolvedState, RuntimeManifest, RuntimeState,
} from './types';
import { CELL, HARD_MAX_BYTES, MAX_UPLOAD_BYTES, expectedAtlasSize, sniffImageFile } from './image-size';

export class PetPackError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail ? `${message}：${detail}` : message);
    this.name = 'PetPackError';
  }
}

function readJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new PetPackError(`缺少${label}`, path);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    throw new PetPackError(`${label}不是合法 JSON`, (e as Error).message);
  }
}

/**
 * 路径穿越防护：清单里声明的 spritesheetPath 必须落在宠物包目录内。
 * 恶意宠物包可用 "../../evil.png" 之类的相对路径把任意文件喂进来。
 */
function resolveInside(packDir: string, rel: string, label: string): string {
  if (isAbsolute(rel)) throw new PetPackError(`${label}不允许使用绝对路径`, rel);
  const full = resolve(packDir, rel);
  const root = resolve(packDir);
  if (full !== root && !full.startsWith(root + '\\') && !full.startsWith(root + '/')) {
    throw new PetPackError(`${label}逃逸出宠物包目录`, rel);
  }
  return full;
}

export function loadPack(packDirInput: string): PetPack {
  const dir = resolve(packDirInput);
  if (!existsSync(dir)) throw new PetPackError('宠物包目录不存在', dir);

  const manifest = readJson<PetManifest>(resolve(dir, 'pet.json'), 'pet.json');
  if (!manifest.id || typeof manifest.id !== 'string') throw new PetPackError('pet.json 缺少 id');
  if (!manifest.spritesheetPath) throw new PetPackError('pet.json 缺少 spritesheetPath');

  const warnings: string[] = [];

  // sidecar：文件名按约定取
  const runtime = readJson<RuntimeManifest>(resolve(dir, 'desktop-pet.json'), 'desktop-pet.json');
  const behavior = readJson<BehaviorMap>(resolve(dir, 'behavior-map.json'), 'behavior-map.json');

  const sheetPath = resolveInside(dir, manifest.spritesheetPath, 'spritesheetPath');
  if (!existsSync(sheetPath)) throw new PetPackError('精灵图不存在', sheetPath);

  // —— 体积闸 ——
  const bytes = statSync(sheetPath).size;
  if (bytes > HARD_MAX_BYTES) {
    throw new PetPackError('精灵图体积超出硬上限 64 MiB', `${(bytes / 1048576).toFixed(1)} MiB`);
  }
  if (bytes > MAX_UPLOAD_BYTES) {
    warnings.push(`精灵图 ${(bytes / 1048576).toFixed(1)} MiB，超过官方 20 MiB 上限（本地可用，建议压缩）`);
  }

  // —— 魔数与尺寸闸 ——
  const { info } = sniffImageFile(sheetPath, HARD_MAX_BYTES);
  const version = manifest.spriteVersionNumber ?? runtime.pack?.spriteVersionNumber ?? 1;
  const expected = expectedAtlasSize(version);
  if (info.width !== expected.width || info.height !== expected.height) {
    throw new PetPackError(
      `图集尺寸 ${info.width}x${info.height} 与契约不符`,
      `spriteVersionNumber=${version} 时应为 ${expected.width}x${expected.height}`
    );
  }

  const rows = expected.height / CELL.height;
  const grid = { columns: expected.width / CELL.width, rows };

  // —— 状态合流：behavior-map 给帧列，desktop-pet.json 给 fps 与锚点 ——
  const groundY = runtime.anchor?.groundY;
  if (typeof groundY !== 'number') throw new PetPackError('desktop-pet.json 缺少 anchor.groundY');

  const states: Record<string, ResolvedState> = {};
  for (const [id, bState] of Object.entries(behavior.states ?? {})) {
    const rState: RuntimeState | undefined = runtime.states?.[id];
    if (!rState) { warnings.push(`状态 ${id} 在 desktop-pet.json 中没有渲染参数，已跳过`); continue; }

    assertState(id, bState, rState, grid, groundY, warnings);
    states[id] = {
      id,
      row: rState.row,
      frames: rState.frames,
      fps: rState.fps,
      loop: rState.loop,
      offsetY: rState.offsetY,
      frameColumns: bState.frameColumns.slice(0, rState.frames),
      role: rState.role,
      fallbackState: rState.fallbackState,
    };
  }

  if (!states.idle) throw new PetPackError('宠物包缺少 idle 状态，无法作为常驻状态');

  const scale = clampScale(runtime.render?.defaultScale ?? 1);
  return {
    dir, manifest, behavior, runtime,
    sheetPath, sheetBytes: bytes,
    sheet: { width: info.width, height: info.height, format: info.format },
    cell: { width: CELL.width, height: CELL.height },
    grid, groundY, scale, states, warnings,
  };
}

function assertState(
  id: string, b: BehaviorState, r: RuntimeState,
  grid: { columns: number; rows: number }, groundY: number, warnings: string[]
): void {
  if (b.row !== r.row) throw new PetPackError(`状态 ${id} 行号不一致`, `behavior-map=${b.row} runtime=${r.row}`);
  if (b.loop !== r.loop) throw new PetPackError(`状态 ${id} 循环标记不一致`, `${b.loop} vs ${r.loop}`);
  if (b.frames !== r.frames) throw new PetPackError(`状态 ${id} 帧数不一致`, `${b.frames} vs ${r.frames}`);
  if (r.row < 0 || r.row >= grid.rows) throw new PetPackError(`状态 ${id} 行号越界`, `row=${r.row}`);
  if (r.frames < 1 || r.frames > grid.columns) throw new PetPackError(`状态 ${id} 帧数越界`, `frames=${r.frames}`);
  if (!(r.fps > 0)) throw new PetPackError(`状态 ${id} fps 非法`, String(r.fps));

  // 锚点自洽：offsetY 必须等于 groundY - baselineY，否则脚会离地
  const expectedOffset = groundY - r.baselineY;
  if (r.offsetY !== expectedOffset) {
    throw new PetPackError(
      `状态 ${id} 锚点不自洽`,
      `offsetY=${r.offsetY}，但 groundY - baselineY = ${expectedOffset}`
    );
  }

  if (b.frameColumns.length < r.frames) {
    warnings.push(`状态 ${id} 的 frameColumns 不足 ${r.frames} 列`);
  }
  // 播放帧必须从第 0 列开始连续（官方契约第 6 条）
  for (let i = 0; i < Math.min(r.frames, b.frameColumns.length); i++) {
    const col = b.frameColumns[i];
    if (typeof col !== 'number' || col !== i) {
      warnings.push(`状态 ${id} 的播放帧不连续：第 ${i} 帧落在第 ${String(col)} 列`);
      break;
    }
  }
}

function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(3, Math.max(0.5, s));
}
