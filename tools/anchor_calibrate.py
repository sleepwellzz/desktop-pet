#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""分析各状态行的横向居中情况与纵向基线，产出锚点校准数据。"""
import io, json, os
from PIL import Image

base = r"<工作区>\2026-09-15-17-23-06\desktop-pet"
im = Image.open(os.path.join(base, "spritesheet.webp")).convert("RGBA")
W, H = im.size
CW, CH = 192, 208
px = im.load()

NAMES = ["idle", "running-right", "running-left", "waving", "jumping",
         "failed", "waiting", "running", "review"]
FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6]

rows_out = []
lines = []
for r, (name, nf) in enumerate(zip(NAMES, FRAMES)):
    y0 = r * CH
    fx = []
    for c in range(nf):
        x0 = c * CW
        minx, miny, maxx, maxy = 10**9, 10**9, -1, -1
        for y in range(y0, y0 + CH):
            for x in range(x0, x0 + CW):
                if px[x, y][3] > 10:
                    if x < minx: minx = x
                    if y < miny: miny = y
                    if x > maxx: maxx = x
                    if y > maxy: maxy = y
        fx.append((minx - x0, miny - y0, maxx - x0, maxy - y0))
    top = min(f[1] for f in fx)
    bottom = max(f[3] for f in fx)
    left = min(f[0] for f in fx)
    right = max(f[2] for f in fx)
    cx = (left + right) / 2.0
    rows_out.append({
        "row": r, "name": name, "frames": nf,
        "topY": top, "bottomY": bottom, "leftX": left, "rightX": right,
        "centerX": cx, "height": bottom - top + 1, "width": right - left + 1,
        "bottomJitter": bottom - min(f[3] for f in fx),
    })
    lines.append("row%d %-14s frames=%d  X[%d..%d] cx=%.1f(==%.0f?)  Y[%d..%d] h=%d  触地点帧间抖动=%d"
                 % (r, name, nf, left, right, cx, CW / 2.0, top, bottom, bottom - top + 1,
                    bottom - min(f[3] for f in fx)))

GROUND = max(r["bottomY"] for r in rows_out)   # 所有状态中最低的触地点 = 地面基准
lines.append("")
lines.append("基准地面 GROUND = %d (单元格内)" % GROUND)
for r in rows_out:
    off = GROUND - r["bottomY"]
    lines.append("  %-14s baseline=%3d -> 需下移补偿 offsetY=%+d px  %s"
                 % (r["name"], r["bottomY"], off, "" if off == 0 else "★需校准"))

with io.open(os.path.join(base, "anchor-report.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

with io.open(os.path.join(base, "anchor-report.json"), "w", encoding="utf-8") as f:
    json.dump({"ground": GROUND, "rows": rows_out}, f, ensure_ascii=False, indent=2)
