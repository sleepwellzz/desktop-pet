#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成「第 7 行 vs 第 8 行」的逐帧并列对照图，用于回答"Running 到底是哪个动画"。

为什么需要它：用户 2026-09-18 记混了 running 与 ready 的动画外观 —— 这不该靠文字描述争论。
把两行**每一帧**都按应用真实绘制方式（0.75 缩放 + 行级 offsetY 锚点补偿）铺开，
一眼就能看出：第 7 行是「过生日」，第 8 行是「小厨师炒菜」。

用法：python tools/make-row-compare.py   → docs/row-7-vs-8.png
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "row-7-vs-8.png")
SCALE = 0.7                       # 与运行时默认缩放一致（此前脚本写的 0.75 是旧值）
CELL_W, CELL_H = 192, 208
TW, TH = round(CELL_W * SCALE), round(CELL_H * SCALE)
FONT = "C:/Windows/Fonts/msyh.ttc"

BG = (255, 255, 255, 255)
INK = (28, 32, 36, 255)
MUTED = (110, 118, 126, 255)
WARN = (190, 90, 20, 255)
GOOD = (22, 120, 60, 255)
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


def frame_thumb(sheet, runtime, state_id, col):
    """按应用真实绘制方式出一帧：整格缩放 → 下移 offsetY*scale。"""
    st = runtime["states"][state_id]
    box = (col * CELL_W, st["row"] * CELL_H, (col + 1) * CELL_W, st["row"] * CELL_H + CELL_H)
    cell = sheet.crop(box).resize((TW, TH), Image.LANCZOS)
    canvas = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    canvas.alpha_composite(cell, (0, round(st["offsetY"] * SCALE)))
    return canvas


def main():
    sheet, runtime = load()
    status_map = runtime["statusMap"]

    # 找出生意上谁在用第 7/8 行
    users = {}
    for key, entry in status_map.items():
        users.setdefault(entry["state"], []).append(f"{key}（主）")
        if entry.get("then"):
            users.setdefault(entry["then"], []).append(f"{key}（落点）")

    blocks = [
        ("running", "running", 7,
         "业务「运行中」现在用它 → 屏幕上看到的是一顶派对帽 + 蛋糕（过生日）"),
        ("review", "review", 8,
         "业务「就绪·未读」的落点 → 屏幕上看到的是围裙 + 平底锅（小厨师炒菜）"),
    ]

    W = 1180
    header_h = 132
    row_h = TH + 74
    footer_h = 300
    H = header_h + row_h * len(blocks) + footer_h
    img = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((28, 24), "第 7 行 vs 第 8 行 · 逐帧对照（回答「Running 是哪个动画」）", font=f_title, fill=INK)
    d.text((28, 66),
           "每一帧都按应用真实绘制方式渲染（0.7 缩放 + 行级 offsetY 锚点补偿），卡上即屏幕上所见。",
           font=f_sub, fill=MUTED)
    d.text((28, 92),
           "结论：Running（运行中）用的是第 7 行「过生日」；小厨师姿态是第 8 行，属于 ready 的落点。两者本来就不同",
           font=f_note, fill=GOOD)
    d.line((28, header_h - 12, W - 28, header_h - 12), fill=LINE, width=1)

    y = header_h
    for state_id, business, row, note in blocks:
        st = runtime["states"][state_id]
        n = st["frames"]
        d.text((28, y + 4), f"第 {row} 行 · 状态 {state_id}", font=f_name, fill=INK)
        d.text((28, y + 40), f"帧数 {n} · {st['fps']}fps · {'循环' if st['loop'] else '一次性'} · "
                            f"offsetY {st['offsetY']}", font=f_meta, fill=MUTED)
        d.multiline_text((28, y + 70), note, font=f_note, fill=WARN, spacing=4)
        used_by = "、".join(users.get(state_id, [])) or "（当前无业务状态引用）"
        d.text((28, y + 112), f"被引用：{used_by}", font=f_note, fill=MUTED)

        x0 = 470
        for col in range(n):
            x = x0 + col * (TW + 10)
            img.alpha_composite(frame_thumb(sheet, runtime, state_id, col), (x, y))
            d.rectangle((x, y, x + TW - 1, y + TH - 1), outline=LINE, width=1)
            d.text((x, y + TH + 6), f"#{col}", font=f_note, fill=MUTED)

        y += row_h
        d.line((28, y - 18, W - 28, y - 18), fill=LINE, width=1)

    # 底部：当前完整映射链
    d.text((28, y + 8), "当前完整映射链（改之前先核对这张）", font=f_name, fill=INK)
    yy = y + 48
    for key in ["idle", "running", "needs-input", "blocked", "ready"]:
        e = status_map[key]
        chain = f"{key:<12} → {e['state']:<8} 第 {runtime['states'][e['state']]['row']} 行"
        if e.get("then"):
            t = e["then"]
            chain += f" → 落到 {t} 第 {runtime['states'][t]['row']} 行（{'循环' if runtime['states'][t]['loop'] else '一次性'}）"
        d.text((28, yy), chain, font=f_meta, fill=INK)
        yy += 26

    d.text((28, yy + 14),
           "★ ready 的落点第 8 行是循环态：一旦落到那里，在下一个状态事件到来之前没有任何机制让它退场。",
           font=f_note, fill=WARN)
    d.text((28, yy + 38),
           "  气泡对 ready 只显示 6 秒就收起，宠物却一直停在那一格 —— 这就是「没 agent 在跑却还在炒菜」。",
           font=f_note, fill=WARN)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.convert("RGB").save(OUT)
    print(f"已生成 {OUT}  ({W}x{H})")
    for state_id, business, row, _ in blocks:
        print(f"  第 {row} 行: {state_id}  被引用 → {'、'.join(users.get(state_id, [])) or '无'}")


if __name__ == "__main__":
    main()
