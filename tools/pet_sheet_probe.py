#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pet_sheet_probe.py — Codex / ChatGPT Pets 雪碧图（sprite sheet）解析与校验工具
=============================================================================
用途：
  1. 读取 pet.json + spritesheet.webp，校验是否符合 V1 / V2 规格；
  2. 逐行测量真实帧数（从第 0 列起连续非空单元格）；
  3. 标出末尾空单元格、单元格内容包围盒（用于设计锚点 anchor / 碰撞盒）；
  4. 导出标准化的 behavior-map.json（行为映射 sidecar）；
  5. 导出带行标签的图集地图 atlas-map.png，供开发与美术核对。

规格（Codex Pets）：
  V1  8 列 x 9 行   = 1536 x 1872   单格 192 x 208
  V2  8 列 x 11 行  = 1536 x 2288   单格 192 x 208（需 pet.json 声明 spriteVersionNumber: 2）

用法：
  python pet_sheet_probe.py <pet目录> [--export-map] [--export-atlas]

依赖：Pillow
"""

import argparse
import io
import json
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.stderr.write("需要 Pillow：pip install Pillow\n")
    raise

CELL_W, CELL_H = 192, 208
COLS = 8

# V1 标准 9 行状态（顺序即行号）
V1_ROWS = [
    ("idle",          6, "待机。保持在场感，做轻微呼吸/眨眼循环。"),
    ("running-right", 8, "向右跑动。位移行为的右向循环。"),
    ("running-left",  8, "向左跑动。位移行为的左向循环。"),
    ("waving",        4, "挥手。一次性信号：完成、致意、交接。"),
    ("jumping",       5, "跳跃。一次性动作：越过边界、庆祝突破。"),
    ("failed",        8, "失败/受阻。平躺或沮丧循环，表示错误可恢复。"),
    ("waiting",       6, "等待输入。停在操作闸口，等人批准或补充信息。"),
    ("running",       6, "处理中。原地忙碌循环，表示任务正在推进。"),
    ("review",        6, "检查结果。审视产出、发现下一步。"),
]
V2_EXTRA_ROWS = [
    ("look-directions-a", 8, "视线方向 0°–157.5°（V2 新增）。"),
    ("look-directions-b", 8, "视线方向 180°–337.5°（V2 新增）。"),
]


def load_manifest(pet_dir):
    p = os.path.join(pet_dir, "pet.json")
    if not os.path.exists(p):
        return None, p
    with io.open(p, "r", encoding="utf-8") as f:
        return json.load(f), p


def detect_version(manifest, w, h):
    """依据尺寸与声明判定版本；返回 (version, rows, cols)。"""
    declared = (manifest or {}).get("spriteVersionNumber", 1)
    if (w, h) == (1536, 2288) or (declared == 2 and h > 1872):
        return 2, 11, 8
    if (w, h) == (1536, 1872):
        return 1, 9, 8
    # 非标准尺寸：按单格推导
    rows = h // CELL_H
    return (2 if declared == 2 else 1), rows, w // CELL_W


def row_frames(px, w, h, row_index, cols=COLS, alpha_threshold=10):
    """返回该行 {连续非空帧数, 每帧包围盒列表, 空帧列}"""
    y0 = row_index * CELL_H
    y1 = min(y0 + CELL_H, h)
    frames = []
    empty_cols = []
    consecutive = 0
    still_counting = True
    for c in range(cols):
        x0, x1 = c * CELL_W, min((c + 1) * CELL_W, w)
        minx, miny, maxx, maxy = 10 ** 9, 10 ** 9, -1, -1
        for y in range(y0, y1):
            for x in range(x0, x1):
                if px[x, y][3] > alpha_threshold:
                    if x < minx:
                        minx = x
                    if y < miny:
                        miny = y
                    if x > maxx:
                        maxx = x
                    if y > maxy:
                        maxy = y
        if maxx < 0:
            empty_cols.append(c)
            still_counting = False
            frames.append(None)
        else:
            if still_counting:
                consecutive += 1
            frames.append({
                "column": c,
                "bbox": [minx - x0, miny - y0, maxx - minx + 1, maxy - miny + 1],
            })
    return consecutive, frames, empty_cols


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pet_dir")
    ap.add_argument("--export-map", action="store_true")
    ap.add_argument("--export-atlas", action="store_true")
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()

    pet_dir = os.path.abspath(args.pet_dir)
    out_dir = args.out_dir or pet_dir
    manifest, manifest_path = load_manifest(pet_dir)
    if manifest is None:
        sys.stderr.write("未找到 pet.json：%s\n" % manifest_path)
        return 2

    sheet_rel = manifest.get("spritesheetPath", "spritesheet.webp")
    sheet_path = os.path.join(pet_dir, sheet_rel)
    if not os.path.exists(sheet_path):
        sys.stderr.write("未找到雪碧图：%s\n" % sheet_path)
        return 2

    im = Image.open(sheet_path).convert("RGBA")
    w, h = im.size
    px = im.load()
    version, rows, cols = detect_version(manifest, w, h)

    print("=" * 68)
    print("pet id        : %s" % manifest.get("id"))
    print("displayName   : %s" % manifest.get("displayName"))
    print("manifest      : %s" % manifest_path)
    print("spritesheet   : %s" % sheet_rel)
    print("image         : %d x %d  mode=RGBA" % (w, h))
    print("declared ver  : %s" % manifest.get("spriteVersionNumber", "(未声明，按 V1 处理)"))
    print("detected ver  : V%d  ->  %d 列 x %d 行, 单格 %dx%d" % (version, cols, rows, CELL_W, CELL_H))
    print("=" * 68)

    expected = V1_ROWS + (V2_EXTRA_ROWS if version == 2 else [])
    states = {}
    atlas_rows = []
    total_frames = 0
    problems = []

    for r in range(rows):
        n, frames, empty_cols = row_frames(px, w, h, r, cols)
        name, exp_frames, intent = expected[r] if r < len(expected) else ("unknown-row-%d" % r, None, "")
        total_frames += n
        mark = "OK"
        if exp_frames is not None and n != exp_frames:
            mark = "!! 期望 %d 帧" % exp_frames
            problems.append("row %d (%s): 实测 %d 帧, 规格建议 %d 帧" % (r, name, n, exp_frames))
        print("row %-2d %-18s frames=%d  %s" % (r, name, n, mark))
        if frames and frames[0]:
            boxes = [f for f in frames if f]
            print("        bbox 首帧=%s 末帧=%s 尾空列=%s"
                  % (boxes[0]["bbox"], boxes[-1]["bbox"], empty_cols or "无"))
        states[name] = {
            "row": r,
            "frames": n,
            "frameColumns": list(range(n)),
            "loop": name in ("idle", "running-right", "running-left", "failed", "running", "waiting", "review"),
            "bboxes": [f["bbox"] if f else None for f in frames],
            "intent": intent,
        }
        atlas_rows.append((r, name, n))

    print("-" * 68)
    print("总帧数: %d" % total_frames)
    if problems:
        print("差异提示:")
        for p in problems:
            print("  - " + p)
    else:
        print("校验结果: 全部行帧数与官方规格一致。")

    if args.export_map:
        cells = []
        for _, frames, _ in [row_frames(px, w, h, r, cols) for r in range(rows)]:
            for f in frames:
                if f:
                    cells.append(f["bbox"])
        xs = [b[0] for b in cells]
        ys = [b[1] for b in cells]
        x2 = [b[0] + b[2] for b in cells]
        y2 = [b[1] + b[3] for b in cells]
        behavior_map = {
            "schema": "codex-pet-behavior-map/v1",
            "pet": {
                "id": manifest.get("id"),
                "displayName": manifest.get("displayName"),
                "manifestPath": "pet.json",
                "spritesheetPath": sheet_rel,
                "spriteVersionNumber": version,
                "cellSize": {"width": CELL_W, "height": CELL_H},
                "grid": {"columns": cols, "rows": rows},
            },
            "rendererContract": {
                "nativeCodexStates": "fixed-v%d-rows" % version,
                "semanticAliases": "sidecar",
                "note": "原生 Codex 清单保持严格；本 sidecar 供外部行为编排与自研渲染器使用，不向 pet.json 添加未支持字段。",
            },
            "contentBounds": {
                "minX": min(xs), "minY": min(ys),
                "maxX": max(x2), "maxY": max(y2),
                "note": "单元格坐标下的内容包围盒并集，用于推导锚点与碰撞盒。",
            },
            "semanticAliases": {
                "observe": "idle",
                "move-right": "running-right",
                "move-left": "running-left",
                "signal": "waving",
                "celebrate": "jumping",
                "blocked": "failed",
                "await-approval": "waiting",
                "thinking": "running",
                "inspect": "review",
            },
            "states": states,
        }
        dst = os.path.join(out_dir, "behavior-map.json")
        with io.open(dst, "w", encoding="utf-8") as f:
            f.write(json.dumps(behavior_map, ensure_ascii=False, indent=2))
        print("已导出: %s" % dst)

    if args.export_atlas:
        scale = 0.5
        prev = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        canvas = Image.new("RGBA", (prev.size[0] + 150, prev.size[1]), (255, 255, 255, 255))
        canvas.alpha_composite(prev, (150, 0))
        d = ImageDraw.Draw(canvas)
        for r, name, n in atlas_rows:
            y = int(r * CELL_H * scale)
            d.line([(150, y), (canvas.size[0], y)], fill=(0, 120, 255, 255), width=1)
            d.text((6, y + 40), "row %d" % r, fill=(20, 20, 20, 255))
            d.text((6, y + 56), name[:18], fill=(180, 20, 20, 255))
            d.text((6, y + 72), "%d frames" % n, fill=(20, 20, 20, 255))
        for c in range(cols + 1):
            x = 150 + int(c * CELL_W * scale)
            d.line([(x, 0), (x, canvas.size[1])], fill=(255, 0, 0, 255), width=1)
        dst = os.path.join(out_dir, "atlas-map.png")
        canvas.convert("RGB").save(dst)
        print("已导出: %s" % dst)

    return 0


if __name__ == "__main__":
    sys.exit(main())
