// 气泡层渲染：把主进程给的文案与角标画成一个小胶囊。
//
// 用 DOM 而不是 canvas：文字排版、圆角、省略号交给浏览器最省事，也不必关心 DPR。
// 这一层**不参与命中判定**（窗口常态整窗穿透），所以这里没有任何指针事件处理。
interface BubblePush {
  text: string;
  badge: number;
}

const body = document.body;
const textEl = document.getElementById('text') as HTMLSpanElement;
const badgeEl = document.getElementById('badge') as HTMLSpanElement;

window.petBubble.onBubble((payload: BubblePush) => {
  const text = payload?.text ?? '';
  const badge = payload?.badge ?? 0;
  if (!text) {
    body.classList.add('hidden');
    return;
  }
  textEl.textContent = text;
  badgeEl.textContent = badge > 0 ? `+${badge}` : '';
  body.classList.remove('hidden');
});
