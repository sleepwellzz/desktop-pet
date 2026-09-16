// 状态机 + 帧播放器。纯 TS、无副作用、不依赖宿主，可放在主进程也可放在渲染层。
//
// 规则：
//   - loop=true  的状态常驻循环；
//   - loop=false 的状态播完一次后回落到 fallbackState，没有则回 idle；
//   - 同状态重复 setState 不打断当前播放（避免每帧重置动画）。
import type { Frame, ResolvedState } from './types';

/** 播放器的最小依赖：只要有状态表就能跑，便于在渲染层复用而不必持有完整宠物包。 */
export interface PlayablePack {
  states: Record<string, ResolvedState>;
}

export class PetPlayer {
  private current: ResolvedState;
  private frameIndex = 0;
  private elapsedInFrame = 0;
  /**
   * 本次一次性动作播完后的落点，优先于状态自身的 fallbackState。
   * 用途：statusMap 里 `ready → waving（致意）→ then: review（未读）` 这类序列。
   * 把它放在播放器内部而不是让调用方"播完再 setState"，是为了消除
   * "一次性动作播完先回落到 fallback，下一帧才被切成 then"的那一帧闪烁。
   */
  private pendingThen: string | null = null;

  constructor(private readonly pack: PlayablePack, initial = 'idle') {
    const s = pack.states[initial];
    if (!s) throw new Error(`宠物包没有状态 ${initial}`);
    this.current = s;
  }

  get stateId(): string { return this.current.id; }

  /** 当前帧是否是一次性动作（播完要回落）。 */
  get isOneShot(): boolean { return !this.current.loop; }

  /** 一次性动作播完的落点（未指定则为 null，播放器走 fallbackState）。 */
  get thenState(): string | null { return this.pendingThen; }

  setState(id: string, opts?: { then?: string }): boolean {
    const next = this.pack.states[id];
    if (!next) return false;
    if (next.id === this.current.id) {
      // 同一状态不打断当前播放，但落点要更新：否则"同一个 ready 又来了"
      // 会因为沿用旧落点而停在错误的姿态上。
      this.pendingThen = opts?.then ?? this.pendingThen;
      return false;
    }
    this.current = next;
    this.frameIndex = 0;
    this.elapsedInFrame = 0;
    this.pendingThen = opts?.then ?? null;
    return true;
  }

  /** 推进 dtMs 毫秒，返回当前应绘制的帧。 */
  update(dtMs: number): Frame {
    const frameDuration = 1000 / this.current.fps;
    this.elapsedInFrame += dtMs;
    while (this.elapsedInFrame >= frameDuration) {
      this.elapsedInFrame -= frameDuration;
      this.advance();
    }
    return this.frame();
  }

  private advance(): void {
    this.frameIndex += 1;
    if (this.frameIndex < this.current.frames) return;

    if (this.current.loop) {
      this.frameIndex = 0;
      return;
    }
    // 一次性动作播完：落到 then（statusMap 指定的序列）或 fallbackState，最后兜到 idle
    const fallbackId = this.pendingThen ?? this.current.fallbackState ?? 'idle';
    this.pendingThen = null;
    const fallback = this.pack.states[fallbackId];
    this.current = fallback ?? this.pack.states.idle!;
    this.frameIndex = 0;
  }

  frame(): Frame {
    const s = this.current;
    const column = s.frameColumns[this.frameIndex] ?? this.frameIndex;
    return {
      stateId: s.id,
      row: s.row,
      column,
      offsetY: s.offsetY,
      index: this.frameIndex,
    };
  }
}
