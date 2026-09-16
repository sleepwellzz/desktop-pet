#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从宠物图集生成托盘图标（assets/tray.ico + tray.png）。

为什么要脚本生成而不是手画：换一只宠物包就该换一次图标，手画等于每换一次包就欠一笔债。
取的是 **idle 第 0 帧的头部**，裁成圆形徽章再加一圈底色 —— 不加底色的话，这只狗是奶白色的，
在浅色任务栏上会糊成一片。

用法：python tools/make-tray-icon.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEET = os.path.join(ROOT, "spritesheet.webp")
OUT_ICO = os.path.join(ROOT, "assets", "tray.ico")
OUT_PNG = os.path.join(ROOT, "assets", "tray.png")

CELL_W, CELL_H = 192, 208
SIZE = 256                      # 生成母版尺寸，缩小时足够干净
RING = (122, 90, 58, 255)       # 徽章底色（暖棕，深浅任务栏上都能看清）
HEAD_RATIO = 0.62               # 头部在宠物可见高度里占的比例


def main():
    sheet = Image.open(SHEET).convert("RGBA")
    idle = sheet.crop((0, 0, CELL_W, CELL_H))
    bbox = idle.getbbox()
    if bbox is None:
        raise SystemExit("idle 第 0 帧是空的，无法生成图标")
    x0, y0, x1, y1 = bbox
    cx = (x0 + x1) // 2
    side = int((y1 - y0) * HEAD_RATIO)          # 头部 + 肩部
    head = idle.crop((cx - side // 2, max(0, y0 - 6), cx + side // 2, max(0, y0 - 6) + side))
    head = head.resize((SIZE - 40, SIZE - 40), Image.LANCZOS)

    badge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(badge)
    d.ellipse((0, 0, SIZE - 1, SIZE - 1), fill=RING)
    # 头部也裁成圆形，避免方块边缘露出来
    mask = Image.new("L", head.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, head.size[0] - 1, head.size[1] - 1), fill=255)
    badge.paste(head, (20, 20), mask)

    os.makedirs(os.path.dirname(OUT_ICO), exist_ok=True)
    # Windows 托盘按 DPI 选尺寸，一次给全，避免系统缩放出毛边
    badge.save(OUT_ICO, sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64)])
    badge.resize((64, 64), Image.LANCZOS).save(OUT_PNG)
    print(f"已生成 {OUT_ICO} 与 {OUT_PNG}")
    print(f"  头部裁切：源 bbox={bbox}，取 cx={cx} 宽 {side}px")


if __name__ == "__main__":
    main()
