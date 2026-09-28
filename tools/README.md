# tools/ —— 脚本索引

> **不搬动文件，只建索引。** 2026-09-28 逐个核实过引用面后决定：
> 分类带来的收益（别人好找）远小于搬动带来的风险（引用网断裂）。
> 与 `ADR 003`（根目录不整理，因存在相对引用网）同一条纪律。
>
> 全部脚本的工程根都从**脚本自身位置**推导，不写死绝对路径。

## 一、构建与产物（`npm run build` 会用到）

| 脚本 | 作用 | 备注 |
|---|---|---|
| `run-build.cjs` | **完整构建的唯一入口**：tsc + 6 个 esbuild + copy-assets + 写构建戳 | Bypass npm/shell，直接调 node |
| `stamp-build.mjs` | 构建戳：`dist/.build-stamp.json` 记下当时 `src/` 的内容哈希 | `--check` 只校验不写 |
| `copy-assets.mjs` | 把 `assets/`、`renderer/*.html` 复制进 `dist/` | 构建链一环 |
| `make-portable.mjs` | 打包免安装绿色目录（`--zip` 另压 zip） | **只复制 `dist/`，自己不构建** ⇒ 先 `run-build.cjs` |
| `zip-dir.mjs` | 纯 Node zip 实现（`zlib.deflateRawSync` + 手写 ZIP 结构） | ADR 044；压完回读魔数 |
| `npm-run.mjs` | 替 `npm run <script>` 干活 | 本环境 Bash shim 没有 npm |
| `make-status-reference.py` | 生成 `docs/status-reference.png` | 资产脚本 |

## 二、判据（测试与守门）

| 脚本 | 作用 | 触发时机 |
|---|---|---|
| `status-arbiter.test.mjs` | **主单测**，452 项断言 | 改了 `kernel/` / `source/` / `host/` / `main/` |
| `codebuddy-hook.test.mjs` | hook 映射层单测（70 项） | 改了 `pet-hook*.mjs` 或映射层 |
| `check-timers.mjs` | 定时器登记守门（ADR 035） | 改了主进程任何定时器 |
| `check-probe-hooks.mjs` | 探针调用的 `dbg.*` 是否还在 `__petDebug` 桥上 | **删了功能之后**（ADR 047） |
| `check-evidence.mjs` | 入库证据是否"内含崩溃却报 PASS" | 常态（接进主单测 ⓪c，**不阻断**） |
| `measure-latency.mjs` | 事件端到端延迟（`--since=60`） | 改状态源接线后取客观数字 |

⚠️ **前三道闸门在主单测里是硬失败**（`⓪` dist 新鲜度、`⓪b` 探针钩子、
以及 dist 缺产物）—— 改完 `src` 不重新构建会**直接拒绝运行**（退出码 2）。
`⓪c` 证据卫生**刻意不阻断**（历史污染只能靠重跑探针修，长期亮红反而会被忽略，见 ADR 048）。

## 三、宠物包规格（权威来源是用户级技能 `codex-pet-pack`）

| 脚本 | 作用 |
|---|---|
| `pet_spec.py` | **规格常量与解析工具**（被其他脚本 import，勿动位置） |
| `validate_pet.py` | 契约校验器（`npm run pet:validate`） |
| `pet-hook.mjs` / `pet-hook-cb.mjs` | WorkBuddy hook 客户端（退出码恒 0，ADR 020） |
| `codebuddy-hook-map.mjs` | hook 事件映射层（未知事件忽略而非报错） |
| `install-codebuddy-hooks.mjs` | 装机脚本，**默认 dry-run**、幂等、可卸载、带备份 |

## 四、资产与图标（**一次性生成器，平时不用跑**）

改了精灵图或宠物包才需要重跑。**它们会覆盖产物文件**（`assets/tray.ico`、
`atlas-map.png`、文档里的对照图）—— 跑之前先确认要重新生成。

| 脚本 | 产出 |
|---|---|
| `make-tray-icon.py` | `assets/tray.ico` + `tray.png` |
| `anchor_calibrate.py` | `anchor-report.txt` / `anchor-report.json`（读 `spritesheet.webp`） |
| `make-row-compare.py` | 第 7 行 vs 第 8 行逐帧对照图 |
| `make-state-gallery.py` | 各状态透明底小图（文档展示用） |
| `make_pet_template.py` | 图集模板底稿 |
| `make_demo_pet.py` | 合规示例宠物包（`examples/demo-pet`） |
| `pet_sheet_probe.py` | 图集地图 `atlas-map.png`（⚠️ 曾因误提交泄露桌面，**只导出单图**） |

## 五、测试怎么被覆盖

主单测 `status-arbiter.test.mjs` 直接引用了 §1 与 §2 的这些脚本：

- `check-timers.mjs` → 导出的 `checkTimers()` **直接调用**（不 spawn 子进程，
  ADR 044 §2：本沙箱会间歇 `EBUSY`，spawn 会让一条无关断言被环境判红）
- `zip-dir.mjs` → 单测第 ㉒ 节真压一个小目录后**自己解析中央目录**读回内容
- `make-portable.mjs` → 被**读取源码做结构性断言**（版本号派生、自启值名那几条）
- `stamp-build.mjs` / `check-probe-hooks.mjs` / `check-evidence.mjs` → ⓪ / ⓪b / ⓪c 三节

## 约定

- **新增脚本进 `tools/`，不新增平级目录。**
- 一次性脚本用 `.py`（资产处理），长期工具用 `.mjs` / `.cjs`（工程链）——
  这不是硬规则，但能让人一眼看出哪些是"平时不用碰的"。
- 任何脚本**不得写死绝对路径**；工程根从 `__dirname` / `import.meta.url` 推导
  （ADR 041 §痕迹清理：写死的路径是真 bug，不只是痕迹）。
