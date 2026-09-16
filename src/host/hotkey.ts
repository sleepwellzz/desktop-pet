// 全局快捷键：注册、占用检测、降级。
//
// 规格（`desktop-pet.json` 的 `interaction.hideShortcut`）要求：默认 `Win+Alt+P`，有冲突风险，
// 必须支持自定义，且**注册失败要提示并降级** —— 静默失败是最糟的结果：用户按了没反应，
// 又不知道去托盘操作。
//
// 本机实测（`spikes/m2-hotkey/`）：`Super+Alt+P` 可用，`Super+Shift+P` 已被占用。
import { globalShortcut } from 'electron';

export interface HotkeyAttempt {
  accelerator: string;
  ok: boolean;
}

export interface HotkeyResult {
  /** 最终生效的快捷键（**归一化之后**的写法）；全部失败时为 null。 */
  accelerator: string | null;
  /** 生效的是首选还是降级链里的某个（true = 降级）。 */
  usedFallback: boolean;
  /** 首选写法被归一化过（如 Win+Alt+P → Super+Alt+P）时为原始写法。 */
  normalizedFrom: string | null;
  /** 逐个尝试的结果（含失败的），用于提示与日志。 */
  attempts: HotkeyAttempt[];
  ok: boolean;
}

/**
 * 把"人话"归一化成 Electron 的 accelerator 词汇表。
 *
 * **为什么必须有这一步**（2026-09-16 实测）：宠物包里写的是 `Win+Alt+P`（人话），
 * 而 Electron 里 Windows 键叫 `Super`。直接拿 `Win+Alt+P` 去注册，`register()` 会**返回 true**，
 * 但真实按下 Win+Alt+P 永远不触发 —— 静默失效，没有任何报错。
 * 探针（`spikes/m2-hotkey/`）抓到的现象是"注册成功但注入击键没有任何反应"，
 * 再用分离实验证明注入本身有效（裸 keybd_event 能触发 globalShortcut），才定位到这里。
 */
const MODIFIER_ALIASES: Record<string, string> = {
  win: 'Super', windows: 'Super', super: 'Super', meta: 'Super',
  cmd: 'Super', command: 'Super', commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
};

export function normalizeAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((raw) => {
      const token = raw.trim();
      if (!token) return token;
      const alias = MODIFIER_ALIASES[token.toLowerCase()];
      if (alias) return alias;
      // 单字符键名统一大写（p → P）；多字符键名（Space / F1 / Up）原样保留
      return token.length === 1 ? token.toUpperCase() : token;
    })
    .filter(Boolean)
    .join('+');
}

/**
 * 依次尝试 `preferred` 与 `fallbacks`，第一个注册成功的生效。
 * 失败的信息一并返回，交给调用方提示（不在这里弹窗/写日志，保持纯逻辑）。
 */
export function registerHotkey(
  preferred: string,
  fallbacks: string[],
  onTrigger: () => void,
): HotkeyResult {
  const attempts: HotkeyAttempt[] = [];
  const candidates = [preferred, ...fallbacks]
    .filter((s, i, a) => s && a.indexOf(s) === i)
    .map(normalizeAccelerator);
  for (let i = 0; i < candidates.length; i += 1) {
    const accel = candidates[i] ?? '';
    if (globalShortcut.isRegistered(accel)) {
      attempts.push({ accelerator: accel, ok: false });
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, onTrigger);
    } catch {
      ok = false;
    }
    attempts.push({ accelerator: accel, ok });
    if (ok) {
      return {
        accelerator: accel,
        ok: true,
        usedFallback: i > 0,
        normalizedFrom: i === 0 && accel !== preferred ? preferred : null,
        attempts,
      };
    }
  }
  return { accelerator: null, ok: false, usedFallback: false, normalizedFrom: null, attempts };
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
