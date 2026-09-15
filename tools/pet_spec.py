"""
pet_spec.py — Codex / ChatGPT Pets 宠物包规格常量与解析工具

规格来源（2026-09 核对）：
  - OpenAI 官方文档  https://learn.chatgpt.com/docs/pets
  - hatch-pet 技能契约（references/codex-pet-contract.md、references/animation-rows.md）
  - 社区实现一致口径：codexpet.xyz/spec、awesome-codex-pets/pet-contract.md

本文件只描述“契约”，不包含任何绘制逻辑，便于被模板生成器与校验器共同复用。
"""

from __future__ import annotations

from dataclasses import dataclass

# ---------------------------------------------------------------- 图集几何

CELL_W = 192
CELL_H = 208
COLUMNS = 8

# 每个动画行：(行号, 状态名, 建议帧数, 设计含义)
ROWS_V1: tuple[tuple[int, str, int, str], ...] = (
    (0, "idle", 6, "中性的呼吸与眨眼循环"),
    (1, "running-right", 8, "面向屏幕右侧移动"),
    (2, "running-left", 8, "面向屏幕左侧移动"),
    (3, "waving", 4, "抬爪打招呼"),
    (4, "jumping", 5, "起跳、腾空、落地"),
    (5, "failed", 8, "受阻并逐渐趴平"),
    (6, "waiting", 6, "等待用户输入或批准"),
    (7, "running", 6, "非位移式的任务处理中"),
    (8, "review", 6, "专注检查与审阅结果"),
)

# V2 在第 9、10 行追加 16 个顺时针视线方向（屏幕坐标：0°=上 90°=右 180°=下 270°=左）
ROWS_V2_EXTRA: tuple[tuple[int, str, int, str], ...] = (
    (9, "look-directions-a", 8, "视线 000° / 022.5° / 045° / 067.5° / 090° / 112.5° / 135° / 157.5°"),
    (10, "look-directions-b", 8, "视线 180° / 202.5° / 225° / 247.5° / 270° / 292.5° / 315° / 337.5°"),
)

# 完整图集尺寸：(列 x 行) x (格宽 x 格高)
ATLAS_V1 = (COLUMNS * CELL_W, 9 * CELL_H)   # 1536 x 1872
ATLAS_V2 = (COLUMNS * CELL_W, 11 * CELL_H)  # 1536 x 2288

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 官方网页端上传上限 20 MiB

# ---------------------------------------------------------------- 状态机契约

# 宠物对外呈现的四态（官方定义），按仲裁优先级从高到低排列
PET_STATUS_PRIORITY: tuple[tuple[str, str, str], ...] = (
    ("needs_input", "Needs input", "有对话需要批准、回答或其他决策"),
    ("blocked", "Blocked", "有对话失败或遇到系统级错误"),
    ("ready", "Ready", "有对话已完成且存在未读活动"),
    ("running", "Running", "有对话正在处理中"),
)

# 状态 -> 动画行 的映射。
# 说明：官方文档只定义了四个状态，未公开像素级映射表；
# 下表为「官方状态语义」与「hatch-pet 行语义」严格对齐后的推论，社区实现（petdex / li-mao 等）口径一致。
STATUS_TO_ROW: dict[str, int] = {
    "needs_input": 6,   # waiting — 等待用户输入或批准
    "blocked": 5,       # failed  — 受阻并逐渐趴平
    "ready": 8,         # review  — 专注检查与审阅结果
    "running": 7,       # running — 非位移式的任务处理中
    "idle": 0,          # 无活动时的默认行
}


@dataclass(frozen=True)
class PetManifest:
    """pet.json 的结构化视图。所需字段极少，这是刻意设计。"""

    id: str
    display_name: str
    description: str
    spritesheet_path: str
    sprite_version_number: int = 1

    @classmethod
    def from_dict(cls, data: dict) -> "PetManifest":
        return cls(
            id=str(data.get("id", "")),
            display_name=str(data.get("displayName", "")),
            description=str(data.get("description", "")),
            spritesheet_path=str(data.get("spritesheetPath", "spritesheet.webp")),
            sprite_version_number=int(data.get("spriteVersionNumber", 1) or 1),
        )

    def rows(self) -> tuple[tuple[int, str, int, str], ...]:
        if self.sprite_version_number >= 2:
            return ROWS_V1 + ROWS_V2_EXTRA
        return ROWS_V1

    def expected_atlas(self) -> tuple[int, int]:
        return ATLAS_V2 if self.sprite_version_number >= 2 else ATLAS_V1

    def missing_fields(self) -> list[str]:
        missing = []
        if not self.id:
            missing.append("id")
        if not self.display_name:
            missing.append("displayName")
        if not self.description:
            missing.append("description")
        if not self.spritesheet_path:
            missing.append("spritesheetPath")
        return missing


MANIFEST_TEMPLATE = """{{
  "id": "{pet_id}",
  "displayName": "{display_name}",
  "description": "{description}",
  "spritesheetPath": "{spritesheet}",
  "spriteVersionNumber": {version}
}}
"""


def force_utf8_stdout() -> None:
    """Windows 控制台默认代码页会吃掉中文输出，统一改为 UTF-8。"""
    import sys

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

