#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从宠物图集生成托盘图标（默认写工程 assets/tray.ico；给了包目录则写包内 tray.ico）。

为什么要脚本生成而不是手画：换一只宠物包就该换一次图标，手画等于每换一次包就欠一笔债。
取的是 **idle 第 0 帧的头部**，裁成圆形徽章再加一圈底色 —— 不加底色的话，这只狗是奶白色的，
在浅色任务栏上会糊成一片。

用法：
    python tools/make-tray-icon.py                 # 自己的包：写工程 assets/tray.ico
    python tools/make-tray-icon.py <宠物包目录>     # 别人的包：写 <包>/tray.ico（ADR 049）

2026-09-29 加参数（ADR 049）：原先写死读工程根的 `spritesheet.webp`、写死写工程 assets/，
而主进程已改成**托盘图标随包走**（包内 tray.ico 优先）。
两边不一致的后果很具体：新作者照着旧用法给新包做图标，
生成的文件落在工程 assets/ 里 —— 于是托盘上还是上一只宠物的脸，**且没有任何报错**。

精灵图文件名从该包的 `pet.json → spritesheetPath` 读，不写死 `spritesheet.webp`。
"""
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SHEET = os.path.join(ROOT, "spritesheet.webp")
DEFAULT_ICO = os.path.join(ROOT, "assets", "tray.ico")
DEFAULT_PNG = os.path.join(ROOT, "assets", "tray.png")

CELL_W, CELL_H = 192, 208
SIZE = 256                      # 生成母版尺寸，缩小时足够干净
RING = (122, 90, 58, 255)       # 徽章底色（暖棕，深浅任务栏上都能看清）
HEAD_RATIO = 0.62               # 头部在宠物可见高度里占的比例


def resolve_targets(pack_dir):
    """返回 (精灵图路径, ico 输出, png 输出)。给了包目录就一切跟着那个包走。"""
    if not pack_dir:
        return DEFAULT_SHEET, DEFAULT_ICO, DEFAULT_PNG
    pack_dir = os.path.abspath(pack_dir)
    manifest = os.path.join(pack_dir, "pet.json")
    sheet_name = "spritesheet.webp"
    if os.path.exists(manifest):
        # 从清单读图集名：别人可能叫别的文件名，写死就等于给新作者埋坑
        try:
            with open(manifest, encoding="utf-8") as fh:
                sheet_name = json.load(fh).get("spritesheetPath") or sheet_name
        except (OSError, ValueError) as e:
            print(f"警告：读不到 {manifest} 的 spritesheetPath（{e}），按默认 {sheet_name} 处理")
    else:
        print(f"警告：{pack_dir} 下没有 pet.json —— 只用到默认图集名 {sheet_name}")
    return (os.path.join(pack_dir, sheet_name),
            os.path.join(pack_dir, "tray.ico"),
            os.path.join(pack_dir, "tray.png"))


def main():
    pack_dir = sys.argv[1] if len(sys.argv) > 1 else None
    sheet_path, out_ico, out_png = resolve_targets(pack_dir)

    if not os.path.exists(sheet_path):
        raise SystemExit(f"找不到精灵图：{sheet_path}")

    with Image.open(sheet_path) as im:
        sheet = im.convert("RGBA")
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

    os.makedirs(os.path.dirname(out_ico), exist_ok=True)
    # Windows 托盘按 DPI 选尺寸，一次给全，避免系统缩放出毛边
    badge.save(out_ico, sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64)])
    badge.resize((64, 64), Image.LANCZOS).save(out_png)
    print(f"已生成 {out_ico} 与 {out_png}")
    print(f"  头部裁切：源 bbox={bbox}，取 cx={cx} 宽 {side}px")
    if pack_dir:
        print("  提示：包内 tray.ico 会被主进程优先采用（ADR 049），所以放这里就对了。")


if __name__ == "__main__":
    main()
