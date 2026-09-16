// 气泡层 preload 暴露的窄接口（气泡页面自己的全局声明，与宠物层分开）。
interface PetBubbleBridge {
  onBubble(cb: (payload: { text: string; badge: number }) => void): void;
}

declare global {
  interface Window {
    petBubble: PetBubbleBridge;
  }
}

export {};
