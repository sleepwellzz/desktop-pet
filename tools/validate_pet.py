"""
validate_pet.py — Codex / ChatGPT Pets 宠物包契约校验器

用法：
    python validate_pet.py <宠物目录或精灵图文件>
    python validate_pet.py <宠物目录或精灵图文件> --json      # 输出机器可读结果
    python validate_pet.py <宠物目录或精灵图文件> --template   # 同时生成一份标注模板图

校验内容（全部来自官方与社区一致的公开契约）：
    1. pet.json 存在且必填字段完整
    2. spritesheetPath 指向的文件存在、是关键帧图（PNG / WebP）、带 alpha 通道
    3. 图集尺寸与 spriteVersionNumber 匹配：V1=1536x1872，V2=1536x2288
    4. 单元格 192x208，8 列网格对齐
    5. 每个动画行至少有 1 个非空帧
    6. 播放帧从第 0 列开始连续，末尾空单元格应被忽略 —— 本脚本会报出“非连续”这一常见错误
    7. 文件体积是否超过官方 20 MiB 上传上限（仅提示，桌面本地宠物不受此限）

退出码：0 = 通过；1 = 存在错误；2 = 无法读取输入。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("需要 Pillow：pip install Pillow", file=sys.stderr)
    raise SystemExit(2)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pet_spec import (  # noqa: E402
    CELL_H,
    CELL_W,
    COLUMNS,
    MAX_UPLOAD_BYTES,
    PetManifest,
    force_utf8_stdout,
)

force_utf8_stdout()


def cell_has_content(atlas: Image.Image, row: int, col: int, alpha_threshold: int = 8) -> bool:
    """判断某个单元格是否存在可见像素（alpha 超过阈值即视为非空）。"""
    box = (col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H)
    cell = atlas.crop(box)
    if cell.mode != "RGBA":
        cell = cell.convert("RGBA")
    alpha = cell.getchannel("A")
    return alpha.getextrema()[1] > alpha_threshold


def validate(pet_dir: Path) -> dict:
    result: dict = {"petDir": str(pet_dir), "errors": [], "warnings": [], "rows": []}

    manifest_path = pet_dir / "pet.json"
    if not manifest_path.is_file():
        result["errors"].append(f"缺少清单文件：{manifest_path}")
        return result

    try:
        manifest = PetManifest.from_dict(json.loads(manifest_path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        result["errors"].append(f"pet.json 不是合法 JSON：{exc}")
        return result

    missing = manifest.missing_fields()
    if missing:
        result["errors"].append(f"pet.json 缺少必填字段：{', '.join(missing)}")
    result["petId"] = manifest.id
    result["spriteVersionNumber"] = manifest.sprite_version_number

    sheet_path = pet_dir / manifest.spritesheet_path
    if not sheet_path.is_file():
        result["errors"].append(f"清单声明的精灵图不存在：{manifest.spritesheet_path}")
        return result

    size_bytes = sheet_path.stat().st_size
    result["bytes"] = size_bytes
    if size_bytes > MAX_UPLOAD_BYTES:
        result["warnings"].append(
            f"文件 {size_bytes / 1048576:.1f} MiB 超过官方网页端 20 MiB 上传上限"
            "（桌面端本地宠物不受此限，但建议压缩）"
        )

    try:
        with Image.open(sheet_path) as img:
            img.load()
            atlas = img.convert("RGBA")
    except OSError as exc:
        result["errors"].append(f"精灵图无法解析：{exc}")
        return result

    result["format"] = sheet_path.suffix.lower()
    result["size"] = list(atlas.size)

    if sheet_path.suffix.lower() not in {".png", ".webp"}:
        result["errors"].append(f"格式 {sheet_path.suffix} 不被契约支持，应为 .png 或 .webp")

    expected = manifest.expected_atlas()
    if atlas.size != expected:
        result["errors"].append(
            f"图集尺寸 {atlas.width}x{atlas.height} 与契约不符，"
            f"spriteVersionNumber={manifest.sprite_version_number} 时必须是 {expected[0]}x{expected[1]}"
        )
        return result

    row_count = expected[1] // CELL_H
    result["grid"] = f"{COLUMNS}x{row_count} @ {CELL_W}x{CELL_H}"

    for row_index, state, expected_frames, meaning in manifest.rows():
        flags = [cell_has_content(atlas, row_index, col) for col in range(COLUMNS)]
        playable = 0
        for flag in flags:
            if flag:
                playable += 1
            else:
                break
        trailing_used = sum(1 for f in flags[playable:] if f)

        row_info = {
            "row": row_index,
            "state": state,
            "expectedFrames": expected_frames,
            "playableFrames": playable,
            "meaning": meaning,
        }
        result["rows"].append(row_info)

        if playable == 0:
            result["errors"].append(f"第 {row_index} 行（{state}）没有任何非空帧 —— 每个动作行至少需要 1 帧")
        if trailing_used:
            result["errors"].append(
                f"第 {row_index} 行（{state}）在空单元格之后仍有内容："
                f"播放只从第 0 列开始读取连续非空帧，第 {playable} 列之后的 {trailing_used} 帧将永远不会播放"
            )
        if playable and playable != expected_frames:
            result["warnings"].append(
                f"第 {row_index} 行（{state}）可播放 {playable} 帧，建议值为 {expected_frames} 帧"
            )

    return result


def print_human(result: dict) -> None:
    print("=" * 68)
    print(f"宠物包：{result['petDir']}")
    if "petId" in result:
        print(f"id={result['petId']}  spriteVersion={result.get('spriteVersionNumber')}")
    if "size" in result:
        print(f"图集：{result['size'][0]}x{result['size'][1]}  {result.get('format')}  网格 {result.get('grid')}")
        print(f"体积：{result.get('bytes', 0) / 1024:.1f} KiB")
    print("=" * 68)

    if result["rows"]:
        print(f"{'行':>3}  {'状态':<16} {'可播放':>6} / {'建议':<4} 说明")
        for r in result["rows"]:
            print(f"{r['row']:>3}  {r['state']:<16} {r['playableFrames']:>6} / {r['expectedFrames']:<4} {r['meaning']}")

    print()
    if result["errors"]:
        print(f"错误 {len(result['errors'])} 项：")
        for e in result["errors"]:
            print(f"  [x] {e}")
    if result["warnings"]:
        print(f"警告 {len(result['warnings'])} 项：")
        for w in result["warnings"]:
            print(f"  [!] {w}")
    if not result["errors"] and not result["warnings"]:
        print("通过：宠物包符合全部契约要求。")


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 Codex / ChatGPT Pets 宠物包")
    parser.add_argument("target", type=Path, help="宠物目录（含 pet.json 与精灵图）")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    args = parser.parse_args()

    target = args.target
    if not target.exists():
        print(f"路径不存在：{target}", file=sys.stderr)
        return 2
    pet_dir = target if target.is_dir() else target.parent

    result = validate(pet_dir)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_human(result)
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
