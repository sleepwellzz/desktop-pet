import type {
  BehaviorOverride, DragDelta, FullscreenNotice, PointerHint, ReadyInfo, RendererInit, StatusPush,
} from '../shared/ipc';

interface PetBridge {
  onInit(cb: (payload: RendererInit) => void): void;
  onFullscreen(cb: (notice: FullscreenNotice) => void): void;
  /** 窗口移动后主进程回报光标位置（窗口内容区 CSS 像素），据此重新采样命中状态。 */
  onPointerHint(cb: (hint: PointerHint) => void): void;
  /** 仲裁后的状态。主进程是唯一真值来源，渲染层只负责画。 */
  onStatus(cb: (push: StatusPush) => void): void;
  /** 行为层的动画覆盖（漫游/微动作/打盹）。null = 交回仲裁器。 */
  onBehavior(cb: (o: BehaviorOverride) => void): void;
  dragBy(delta: DragDelta): void;
  /** 拖动开始/结束。行为层据此判断"现在不许自己动"。 */
  dragState(dragging: boolean): void;
  /** 上报命中状态：true = 光标在宠物实体像素上，窗口需可交互；false = 整窗穿透。 */
  setInteractive(interactive: boolean): void;
  /** 用户确认（单击宠物）：解除 needs-input 粘滞。 */
  ack(): void;
  /** 在宠物上按了右键：请主进程唤出/收起控制条。 */
  requestContextMenu(): void;
  log(message: string): void;
  /** 报到：可以下发 init 了（顺带上报渲染层才知道的偏好，如「减少动态效果」）。 */
  ready(info?: ReadyInfo): void;
}

declare global {
  interface Window {
    pet: PetBridge;
  }
}

export {};
