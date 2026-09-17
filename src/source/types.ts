// 状态源适配器的契约。
//
// 设计文档 §7.6 把这个模块的接口写成 `subscribe(cb)`。这里改成 start/stop 两个生命周期方法：
// 源自己持有资源（文件监听句柄、将来的监听端口），只有一个 subscribe 无法表达"何时开始、
// 何时释放"。名字的变更记在 ADR 010。
//
// 约束：本层与宿主无关（不 import electron），只依赖 node 内置模块，因此可以在纯 node 单测里跑。
import type { StatusEvent } from '../kernel/status';

export interface StatusSource {
  /** 诊断标识，如 'status-file'。 */
  readonly id: string;
  /** 开始产出事件。emit 是同步回调，实现方不应在其中做重活。 */
  start(emit: (e: StatusEvent) => void): void | Promise<void>;
  /** 停止并释放资源。必须幂等。 */
  stop(): void | Promise<void>;
  /**
   * 忘掉内部累计的"上一次已知状态"（可选）。
   *
   * 调用方是主进程的「清空状态会话」：它先把来源写空，再让源丢掉记忆、让仲裁器丢掉记录 ——
   * 否则"清空文件"这一步会被适配器 diff 成"每条会话都消失了"，各补一条 idle 收尾，
   * 于是界面上的会话只是变了个状态、并没有消失（2026-09-17 实测，见 ADR 016）。
   * 快照型来源（文件）需要它；无状态来源（HTTP 推送）可以没有。
   */
  reset?(): void;
  /** 人可读的配置描述，用于启动日志与将来的托盘提示。 */
  describe(): string;
}
