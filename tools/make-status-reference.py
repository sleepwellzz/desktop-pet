#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成"业务状态 → 动画状态 → 精灵图行 → 屏幕上实际长什么样"的对照卡。

为什么需要：人工验收时，说明文字里的"跑动"这类措辞很容易和这只包作者的实际作画对不上
（淘淘 New 的第 7 行 `running` 画的是生日姿态，不是跑动 —— 我们已经在验收说明里写错过一次）。
对照卡按**应用真实绘制方式**（0.75 缩放 + 行级 offsetY 锚点补偿）渲染缩略图，
所以卡上看到的就是屏幕上看到的。

用法：python tools/make-status-reference.py   → docs/status-reference.png
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "status-reference.png")
SCALE = 0.75                     # 与运行时默认缩放一致
CELL_W, CELL_H = 192, 208
THUMB_W, THUMB_H = round(CELL_W * SCALE), round(CELL_H * SCALE)   # 144x156
FONT = "C:/Windows/Fonts/msyh.ttc"

BG = (255, 255, 255, 255)
INK = (28, 32, 36, 255)
MUTED = (110, 118, 126, 255)
WARN = (190, 90, 20, 255)
LINE = (222, 226, 230, 255)

f_title = ImageFont.truetype(FONT, 30)
f_sub = ImageFont.truetype(FONT, 16)
f_name = ImageFont.truetype(FONT, 22)
f_meta = ImageFont.truetype(FONT, 17)
f_note = ImageFont.truetype(FONT, 15)


def load():
    sheet = Image.open(os.path.join(ROOT, "spritesheet.webp")).convert("RGBA")
    with open(os.path.join(ROOT, "desktop-pet.json"), encoding="utf-8") as fh:
        runtime = json.load(fh)
    return sheet, runtime


def thumb(sheet, runtime, state_id):
    """按应用的绘制方式出图：整格缩放到 0.75，再下移 offsetY*scale。"""
    st = runtime["states"][state_id]
    cell = sheet.crop((0, st["row"] * CELL_H, CELL_W, st["row"] * CELL_H + CELL_H))
    cell = cell.resize((THUMB_W, THUMB_H), Image.LANCZOS)
    canvas = Image.new("RGBA", (THUMB_W, THUMB_H), (0, 0, 0, 0))
    canvas.alpha_composite(cell, (0, round(st["offsetY"] * SCALE)))
    return canvas


def main():
    sheet, runtime = load()
    status_map = runtime["statusMap"]
    order = ["idle", "running", "needs-input", "blocked", "ready"]
    labels = {
        "idle": ("空闲", None),
        "running": ("运行中", "注意：这一行作者画的是「生日」姿态（派对帽 + 蛋糕），不是跑动。\n"
                            "　　　写验收说明的人（我）曾把它描述成「原地跑动」，是错的。"),
        "needs-input": ("需要输入", None),
        "blocked": ("已受阻", None),
        "ready": ("就绪（未读）", "顺序：先播挥手，再落到小厨师姿态"),
    }

    W = 900
    header_h = 116
    row_h = THUMB_H + 30
    footer_h = 320
    H = header_h + row_h * len(order) + footer_h
    img = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((28, 26), "桌宠状态对照卡 · 淘淘 New", font=f_title, fill=INK)
    d.text((28, 68),
           "业务状态 → 动画状态 → 精灵图行。缩略图按应用真实绘制方式（0.75 缩放 + 行级锚点补偿）渲染。",
           font=f_sub, fill=MUTED)
    d.line((28, header_h - 12, W - 28, header_h - 12), fill=LINE, width=1)

    y = header_h
    for key in order:
        entry = status_map[key]
        name, note = labels[key]
        d.text((28, y + 4), f"{key}", font=f_name, fill=INK)
        name_x = 28 + d.textlength(key, font=f_name) + 12
        d.text((name_x, y + 7), name, font=f_meta, fill=MUTED)
        d.text((28, y + 38), f"动画 {entry['state']} · 第 {runtime['states'][entry['state']]['row']} 行",
               font=f_meta, fill=MUTED)
        if entry.get("then"):
            d.text((28, y + 64),
                   f"播完落到 {entry['then']} · 第 {runtime['states'][entry['then']]['row']} 行",
                   font=f_meta, fill=MUTED)
        if note:
            d.multiline_text((28, y + 92), note, font=f_note, fill=WARN, spacing=4)

        x = 420
        first = thumb(sheet, runtime, entry["state"])
        img.alpha_composite(first, (x, y))
        d.rectangle((x, y, x + THUMB_W - 1, y + THUMB_H - 1), outline=LINE, width=1)
        if entry.get("then"):
            d.text((x + THUMB_W + 10, y + THUMB_H // 2 - 10), "→", font=f_name, fill=MUTED)
            x2 = x + THUMB_W + 44
            img.alpha_composite(thumb(sheet, runtime, entry["then"]), (x2, y))
            d.rectangle((x2, y, x2 + THUMB_W - 1, y + THUMB_H - 1), outline=LINE, width=1)

        y += row_h
        d.line((28, y - 15, W - 28, y - 15), fill=LINE, width=1)

    # 备选区：跑动两行当前没有任何业务状态映射过去
    d.text((28, y + 8), "备选：跑动姿态（第 1、2 行）", font=f_name, fill=INK)
    d.text((28, y + 44),
           "这两行是真正的「跑动」，但当前 statusMap 没有把任何业务状态指过去。",
           font=f_meta, fill=MUTED)
    d.text((28, y + 70),
           "若希望「运行中」看起来像在忙、而不是在过生日，把 running 指到第 1 行即可（待定项）。",
           font=f_note, fill=WARN)
    yy = y + 104
    for i, sid in enumerate(["running-right", "running-left"]):
        x = 28 + i * (THUMB_W + 28)
        img.alpha_composite(thumb(sheet, runtime, sid), (x, yy))
        d.rectangle((x, yy, x + THUMB_W - 1, yy + THUMB_H - 1), outline=LINE, width=1)
        d.text((x, yy + THUMB_H + 6), f"第 {runtime['states'][sid]['row']} 行 · {sid}", font=f_note, fill=MUTED)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.convert("RGB").save(OUT)
    print(f"已生成 {OUT}  ({W}x{H})")
    for key in order:
        entry = status_map[key]
        rows = f"第 {runtime['states'][entry['state']]['row']} 行"
        if entry.get("then"):
            rows += f" → 第 {runtime['states'][entry['then']]['row']} 行"
        print(f"  {key:<12} → {entry['state']:<10} {rows}")


if __name__ == "__main__":
    main()
