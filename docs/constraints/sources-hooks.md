# 约束 · 状态源与 hook（双通道）

> 2026-09-18 从 `AGENTS.md`「硬性约束」按主题拆出（内容未改，只搬位置）。
> 触发：改 `tools/pet-hook*.mjs`、`tools/codebuddy-hook-map.mjs`、安装器、`src/source/*` 时读这份。

- **状态源是两条通道，且一个 agent 只由一条通道负责**（ADR 020）：
  **A 事件驱动 hook**（WorkBuddy / Codex / 将来的 Claude Code —— **同一套事件名与 stdin 契约**）｜
  **B 被动会话源**（Proma，**已冻结**，见 `docs/design/m3-proma-passive-source.md`）。
  两个**不同** agent 同时跑天然不冲突（仲裁器本来就是多会话形状）；
  会打架的是**同一个 agent 被两条通道同时盯**（hook 说 running、被动源说 idle，来回刷且无报错）
  —— 被动源是**降级来源，是切换不是叠加**。`sessionId` 必须带来源前缀（`wb:` / `proma:`）。
- **改了 hook 映射层或客户端必跑** `node tools/codebuddy-hook.test.mjs`（离线、秒级、**70 项**）。
  **hook 客户端不许有能力影响 agent**：退出码恒 0（Claude 系约定里 2 = 阻断）、有超时、
  任何异常都吞掉；映射层未知事件**忽略而不是报错**。
- **`Notification` 必须按 `notification_type` 分流，不能一律给 `needs-input`**（ADR 020 真实回合实测）：
  `idle_prompt`（"干完了、在等你说话"）在 `Stop` 之后**约一分钟必然出现**，
  一律给 `needs-input` 会变成**每次干完活宠物都举手**，让这个最宝贵的状态**贬值**。
  良性类型走白名单；`PermissionRequest` 才是"要授权"的精确通道。
  **这条只有跑真实回合才能发现**（单测写不出来 —— 当时不知道有这个取值）。
- **hook 配置只写工程级**（用户级会作用于用户**正在用的所有**会话），且默认写
  `.codebuddy/settings.local.json`（命令含本机绝对路径，已 gitignore）。
  安装器 `node tools/install-codebuddy-hooks.mjs` **默认 dry-run**、幂等、可卸载、带备份；
  **不要手写这个文件**，改动走安装器（它会先摘后装，保证幂等）。
- **判断一个信号的时间分辨率，要看它的更新频率，不是看它当前的年龄**（ADR 020 负面结论 1）：
  "心跳文件看起来很新"推不出"它一直在写"。同源纪律：**被动源给的"存在"不等于"在干活"**——
  把它当 running 判据会制造**假阳性**，而假阳性是最不能接受的失败模式。
- **`~/.desktop-pet/events.jsonl` 里的 `ts` 是"写侧产生时刻"，不是"宠物收到的时刻"**（ADR 020 实测）：
  拿它算端到端延迟会**严重低估**（实测两者只差 2ms，那只是 hook 进程内"落 payload → 写状态文件"的间隔）。
  要算真实延迟得另找时间基准（主进程日志，或探针自己加戳 —— 判据 6 的 `recvAt` 就是为此）。
