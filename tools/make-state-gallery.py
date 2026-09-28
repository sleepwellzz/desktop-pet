#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把淘淘的各个状态**单独抠成一张张透明底的小图**，供 README / 文档并排展示。

为什么不做成一张大对照卡：整块卡放进 README 又宽又小、读者要眯眼看，
而且它把"说明文字"和"形象"焊死在一张图里，改一次文案就得重出一次图。
拆成独立小图之后，**图只管形象，说明交给 Markdown** —— 排版能调、图能复用。

和 `make-status-reference.py` 的区别：
  - 那个出**对照卡**（图 + 文字焊在一起），给验收和查行号用；
  - 这个出**独立的形象图**，给 README / 文档展示用。
  两者共用同一套渲染口径（原生格尺寸 + offsetY 锚点补偿），所以看到的一致。

关键设计 —— **统一地平线**：
  各状态的身高差很大（`failed` 是趴着，offsetY 高达 61；`running` 戴着高帽）。
  直接按原尺寸摆在一起，趴着的那只会浮在半空。所以这里做三步：
  ①按 offsetY 把图**落回它真实的站立基线**；②裁到内容紧致框；
  ③再**贴回统一画布的底部并水平居中**。这样并排时几只狗踩在同一条线上。

用法：python tools/make-state-gallery.py   → docs/states/<状态>.png
"""
import json
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "states")
SHEET = os.path.join(ROOT, "spritesheet.webp")

CELL_W, CELL_H = 192, 208      # 精灵图原生格尺寸（与运行时一致）
CANVAS_W, CANVAS_H = 200, 216  # 输出画布：比格子略大一点，留出帽顶和爪子的余量
PAD = 4                        # 内容与画布边缘的最小留白

# 展示顺序 = 用户实际会遇到的顺序，不是 statusMap 的字典序。
# (业务状态 id, 动画状态 id, 展示用标题)
GALLERY = [
    ("idle", "idle", "空闲"),
    ("running", "running", "运行中"),
    ("needs-input", "waiting", "需要输入"),
    ("blocked", "failed", "已受阻"),
    ("ready", "waving", "就绪"),
]


def load():
    sheet = Image.open(SHEET).convert("RGBA")
    with open(os.path.join(ROOT, "desktop-pet.json"), encoding="utf-8") as fh:
        runtime = json.load(fh)
    return sheet, runtime


def cutout(sheet, runtime, anim_state):
    """按应用的绘制方式取一格：整格取出 → 按 offsetY 下移 → 裁到内容紧致框。"""
    row = runtime["states"][anim_state]["row"]
    offset_y = runtime["states"][anim_state]["offsetY"]
    cell = sheet.crop((0, row * CELL_H, CELL_W, row * CELL_H + CELL_H))
    # offsetY 越大 = 这一格画得越靠上（脚底留白越多），先补出来再裁才不会切到爪子
    if offset_y > 0:
        padded = Image.new("RGBA", (CELL_W, CELL_H + offset_y), (0, 0, 0, 0))
        padded.alpha_composite(cell, (0, 0))
        cell = padded
    elif offset_y < 0:
        padded = Image.new("RGBA", (CELL_W, CELL_H - offset_y), (0, 0, 0, 0))
        padded.alpha_composite(cell, (0, -offset_y))
        cell = padded
    box = cell.getbbox()
    return cell.crop(box) if box else cell


def on_canvas(cut):
    """贴到统一画布底部并水平居中 —— 这一步保证几只狗踩同一条地平线。"""
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    max_w = CANVAS_W - 2 * PAD
    max_h = CANVAS_H - 2 * PAD
    if cut.width > max_w or cut.height > max_h:      # 只在必要时等比缩，不放大
        ratio = min(max_w / cut.width, max_h / cut.height)
        cut = cut.resize((max(1, round(cut.width * ratio)),
                          max(1, round(cut.height * ratio))), Image.LANCZOS)
    x = (CANVAS_W - cut.width) // 2
    y = CANVAS_H - PAD - cut.height                  # 底对齐
    canvas.alpha_composite(cut, (x, y))
    return canvas


def main():
    sheet, runtime = load()
    os.makedirs(OUT_DIR, exist_ok=True)
    for business, anim, label in GALLERY:
        img = on_canvas(cutout(sheet, runtime, anim))
        path = os.path.join(OUT_DIR, business + ".png")
        img.save(path)
        print(f"  {business:<12} -> {os.path.relpath(path, ROOT)}  "
              f"{img.width}x{img.height}  {label}")


if __name__ == "__main__":
    print("生成状态形象图（透明底 / 统一地平线）:")
    main()
