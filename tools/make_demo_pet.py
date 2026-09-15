"""
make_demo_pet.py — 参照 hatch-pet 的组装阶段，凭空合成一个合规宠物包

目的：给你一条“程序化组装图集”的最小可用参考路径，对应 hatch-pet 技能里
      compose_atlas.py 所做的事 —— 把逐行帧图按 8 列网格贴进 1536x1872 画布，
      再写出 pet.json。

与 hatch-pet 的差异（重要）：
    hatch-pet 禁止用本地脚本“绘制”宠物视觉，所有视觉必须由图像生成模型产出，
    脚本只做确定性的几何组装。本文件为演示目的使用纯色方块代替生成图，
    正式流程中请把 frames/<state>/NN.png 换成 $imagegen 的输出。

用法：
    python make_demo_pet.py --out ../examples/demo-pet
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pet_spec import CELL_H, CELL_W, MANIFEST_TEMPLATE, PetManifest, force_utf8_stdout  # noqa: E402

force_utf8_stdout()


PALETTE = {
    0: (0x37, 0x8A, 0xDD),
    1: (0x63, 0x99, 0x22),
    2: (0x63, 0x99, 0x22),
    3: (0xBA, 0x75, 0x17),
    4: (0x7F, 0x77, 0xDD),
    5: (0xE2, 0x4B, 0x4A),
    6: (0x1D, 0x9E, 0x75),
    7: (0x53, 0x4A, 0xB7),
    8: (0xD4, 0x53, 0x7E),
}


def render_frame(state: str, row: int, frame: int, frames: int) -> Image.Image:
    """生成一格 192x208 的透明帧。真实流程中这里应替换为模型生成的帧图。"""
    cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(cell, "RGBA")
    base = PALETTE.get(row, (0x88, 0x87, 0x80))

    # 用垂直偏移模拟 6~8 帧的循环位移，视觉上能看出动画在跑
    bob = int(round(10 * (frame / max(frames - 1, 1) * 2 - 1)))
    body_top = 60 + bob
    draw.rounded_rectangle([48, body_top, 144, body_top + 96], radius=28, fill=(*base, 255))
    draw.ellipse([72, body_top + 22, 90, body_top + 40], fill=(0xFF, 0xFF, 0xFF, 255))
    draw.ellipse([102, body_top + 22, 120, body_top + 40], fill=(0xFF, 0xFF, 0xFF, 255))
    draw.ellipse([78, body_top + 28, 84, body_top + 34], fill=(0x2C, 0x2C, 0x2A, 255))
    draw.ellipse([108, body_top + 28, 114, body_top + 34], fill=(0x2C, 0x2C, 0x2A, 255))
    return cell


def main() -> int:
    parser = argparse.ArgumentParser(description="合成演示宠物包")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "examples" / "demo-pet")
    parser.add_argument("--pet-id", default="demo-sentinel")
    parser.add_argument("--version", type=int, default=1, choices=[1, 2])
    parser.add_argument(
        "--broken",
        action="store_true",
        help="故意生成一个不合规的宠物包（某行留空 + 行内出现空洞导致后续帧不可播放），用于验证校验器能报错",
    )
    args = parser.parse_args()

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    sheet_name = "spritesheet.webp"
    manifest = PetManifest(
        id=args.pet_id,
        display_name="Demo Sentinel",
        description="A synthetic 9-state pet used to verify the atlas contract and the validator.",
        spritesheet_path=sheet_name,
        sprite_version_number=args.version,
    )

    width, height = manifest.expected_atlas()
    atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    for row_index, state, frame_count, _meaning in manifest.rows():
        if args.broken and row_index == 4:
            continue  # 第 4 行（jumping）整行留空
        for frame in range(frame_count):
            if args.broken and row_index == 1 and frame == 3:
                continue  # 制造空洞：第 1 行第 3 帧缺失，导致后续帧无法播放
            atlas.paste(
                render_frame(state, row_index, frame, frame_count),
                (frame * CELL_W, row_index * CELL_H),
            )

    sheet_path = out / manifest.spritesheet_path
    atlas.save(sheet_path, format="WEBP", lossless=True, quality=100, method=6)

    manifest_path = out / "pet.json"
    manifest_path.write_text(
        MANIFEST_TEMPLATE.format(
            pet_id=manifest.id,
            display_name=manifest.display_name,
            description=manifest.description,
            spritesheet=manifest.spritesheet_path,
            version=manifest.sprite_version_number,
        ),
        encoding="utf-8",
    )

    print(f"atlas   -> {sheet_path}  ({atlas.width}x{atlas.height})")
    print(f"manifest-> {manifest_path}")
    print(json.dumps(json.loads(manifest_path.read_text(encoding="utf-8")), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
