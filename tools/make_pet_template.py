"""
make_pet_template.py — 生成 Codex / ChatGPT Pets 图集模板（设计用底稿）

输出：
    A) 标注稿 <out>/pet_atlas_guide_v{1|2}.png
       1536x1872（V1）或 1536x2288（V2），8 列网格、单元格 192x208，
       每行标注状态名与建议帧数，每格标注列号，未使用格以斜纹标出。
       该文件仅供设计对位，不可作为成品精灵图提交（成品不得含网格线与文字）。

    B) 空图集 <out>/pet_atlas_blank_v{1|2}.png
       同尺寸、全透明、无任何标记，可直接作为绘制底稿或占位资源。

用法：
    python make_pet_template.py
    python make_pet_template.py --version 2 --out ../assets
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pet_spec import CELL_H, CELL_W, COLUMNS, PetManifest  # noqa: E402

ROW_TINTS = [
    (0xE6, 0xF1, 0xFB),
    (0xEA, 0xF3, 0xDE),
    (0xFA, 0xEE, 0xDA),
    (0xEE, 0xED, 0xFE),
    (0xFB, 0xEA, 0xF0),
    (0xFC, 0xEB, 0xEB),
    (0xE1, 0xF5, 0xEE),
    (0xF1, 0xEF, 0xE8),
    (0xE6, 0xF1, 0xFB),
    (0xEE, 0xED, 0xFE),
    (0xEE, 0xED, 0xFE),
]
TEXT_DARK = (0x2C, 0x2C, 0x2A, 255)
TEXT_MUTED = (0x5F, 0x5E, 0x5A, 200)
GRID = (0x88, 0x87, 0x80, 90)
BORDER = (0x44, 0x44, 0x41, 220)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\seguisb.ttf",
        r"C:\Windows\Fonts\DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def build_guide(version: int) -> Image.Image:
    manifest = PetManifest(id="guide", display_name="Guide", description="guide", spritesheet_path="x", sprite_version_number=version)
    rows = manifest.rows()
    width, height = manifest.expected_atlas()

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")

    font_axis = load_font(30)
    font_label = load_font(22)
    font_small = load_font(18)

    for row_index, state, expected_frames, _meaning in rows:
        top = row_index * CELL_H
        tint = ROW_TINTS[row_index % len(ROW_TINTS)]

        for col in range(COLUMNS):
            left = col * CELL_W
            used = col < expected_frames
            if used:
                draw.rectangle([left, top, left + CELL_W - 1, top + CELL_H - 1], fill=(*tint, 255))
            else:
                draw.rectangle([left, top, left + CELL_W - 1, top + CELL_H - 1], fill=(0xF4, 0xF3, 0xEF, 255))
                for offset in range(-CELL_H, CELL_W, 26):
                    draw.line(
                        [left + offset, top + CELL_H, left + offset + CELL_H, top],
                        fill=(0xB4, 0xB2, 0xA9, 90),
                        width=2,
                    )

            draw.rectangle([left, top, left + CELL_W - 1, top + CELL_H - 1], outline=GRID, width=2)

            marker = f"r{row_index}c{col}"
            draw.text((left + 10, top + CELL_H - 30), marker, font=font_small, fill=TEXT_MUTED)
            if used:
                draw.text((left + CELL_W - 34, top + 8), str(col), font=font_small, fill=TEXT_MUTED)

        draw.rectangle([0, top, CELL_W * COLUMNS - 1, top + CELL_H - 1], outline=BORDER, width=4)

        label_x = 14
        label_y = top + 14
        draw.text((label_x, label_y), f"{row_index:>2}  {state}", font=font_label, fill=TEXT_DARK)
        draw.text(
            (label_x, label_y + 30),
            f"{expected_frames} frames",
            font=font_axis,
            fill=(0x18, 0x5F, 0xA5, 255),
        )

    draw.rectangle([0, 0, width - 1, height - 1], outline=BORDER, width=6)
    return image


def build_blank(version: int) -> Image.Image:
    manifest = PetManifest(id="blank", display_name="Blank", description="blank", spritesheet_path="x", sprite_version_number=version)
    return Image.new("RGBA", manifest.expected_atlas(), (0, 0, 0, 0))


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 Pets 图集模板")
    parser.add_argument("--version", type=int, default=1, choices=[1, 2], help="图集版本，1（9 行）或 2（11 行）")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "assets")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    guide = build_guide(args.version)
    blank = build_blank(args.version)

    guide_path = args.out / f"pet_atlas_guide_v{args.version}.png"
    blank_path = args.out / f"pet_atlas_blank_v{args.version}.png"
    guide.save(guide_path)
    blank.save(blank_path)

    print(f"guide  -> {guide_path}  ({guide.width}x{guide.height})")
    print(f"blank  -> {blank_path}  ({blank.width}x{blank.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
