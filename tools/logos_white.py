"""把 static/logos 下的模型商标统一成「白色 + 透明底」的单色图标。

用法（在仓库根目录跑，路径是相对的）：

    python tools/logos_white.py

会**原地覆盖** static/logos/*.png，换图前先备份。改完记得把 static/app.js 里的
WF_LOGO_VER 加一——那批图带一天缓存，URL 不变的话浏览器会继续用旧图。

难点：10 张图来自不同厂商，图层结构完全不一样。
  1. 透明底 + 单色图形      flux / qwen
  2. 透明底 + 实心方块 + 反白图形   hidream（蓝方块里挖白字）
  3. 透明底 + 多色图形      wan（紫面 + 白边）
  4. 实心白底 + 彩色图形    hunyuan / krea / ltx / sd
  5. 实心彩底 / 黑底 + 图形  mochi / kolors

做法分两步：

**第一步：抠形状（算 alpha）**
  - 四角透明 → 图形就是 alpha 本身。但如果非透明区域里有一种「主色」占比不足 90%，
    说明里面还有一层实心方块底（hidream 的蓝方块），改以主色为基准算色距，把方块抠掉、
    只留反白的字。
  - 四角不透明 → 底色就是边缘一圈的中位色，算色距。

**第二步：用亮度做层次**
  白化之后所有像素都是纯白，图形内部的明暗差别会全部消失（hunyuan 的白盘、wan 的六边形
  就是这么糊掉的）。所以在抠出的图形区域内做一次亮度 min-max 归一化，把最亮映射到 1.0、
  最暗映射到 0.45，当作 alpha 的乘数。
  - 单色图形（krea 的黑线、qwen 的蓝块）区域内亮度方差极小，直接给 1.0，不受影响。
  - 多色图形（wan 的紫面白边、hunyuan 的蓝绿渐变）层次就保住了。

最后统一裁到图形外框、等比缩进 128 画布居中，让 10 个图标视觉重量一致。
"""
import glob
import os
import sys
from collections import Counter

from PIL import Image

SRC = "static/logos"
PAD = 0.06
CANVAS = 128
LO, HI = 0.03, 0.28      # 色距归一化后低于 LO 算底色，高于 HI 算纯图形
FLOOR = 0.55             # 图形内部最暗处保留的不透明度下限
PURE = 0.90              # 主色占比 ≥ 此值：透明底 + 单一色图形（qwen）
PLATE = 0.60             # 主色占比 ≥ 此值且 < PURE：透明底 + 纯色方块 + 反白图形（hidream）
                         # 低于 PLATE 的是多色渐变图形（wan），不能抠，要整体保留

# 个别图要单独调色距阈值：
#   mochi  底色是四角各不相同的浅蓝渐变，中位色代表不了整片底，残差会在角落留一层雾，
#          低阈值提到 0.12 才吃得掉（方块与底差 0.28，还留得下）。
#   hunyuan 白底上的浅蓝部分只差 0.15，按 0.03 起算整片圆盘都算图形，白化后是个灰盘；
#          提到 0.10 让浅蓝边缘自然变透明，漩涡才浮得出来。
LO_OVERRIDE = {"mochi": 0.12, "hunyuan": 0.10}


def luma(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def edge_color(px, w, h):
    vals = []
    for x in range(w):
        for y in (0, 1, h - 2, h - 1):
            vals.append(px[x, y][:3])
    for y in range(h):
        for x in (0, 1, w - 2, w - 1):
            vals.append(px[x, y][:3])
    return tuple(sorted(v[i] for v in vals)[len(vals) // 2] for i in range(3))


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5 / 441.673


def dominant_color(px, w, h):
    """把颜色粗量化后统计众数，返回 (主色, 占比)。只看不透明的像素。"""
    cnt = Counter()
    n = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 200:
                cnt[(r // 24, g // 24, b // 24)] += 1
                n += 1
    if not n:
        return (0, 0, 0), 0.0
    (qr, qg, qb), c = cnt.most_common(1)[0]
    return (qr * 24 + 12, qg * 24 + 12, qb * 24 + 12), c / n


def build_alpha(im, name=""):
    """返回 (shape, note)。shape 是 0..1 的形状蒙版。"""
    w, h = im.size
    px = im.load()
    lo = LO_OVERRIDE.get(name, LO)
    corners = [px[0, 0][3], px[w - 1, 0][3], px[0, h - 1][3], px[w - 1, h - 1][3]]

    if min(corners) < 10:
        dom, ratio = dominant_color(px, w, h)
        if ratio >= PURE:
            note = f"透明底·纯图形(主色{ratio:.0%})"
            use_dom = False
        elif ratio >= PLATE:
            base = dom
            note = f"透明底·抠内层方块(主色{ratio:.0%})"
            use_dom = True
        else:
            # 多色渐变图形（wan 的紫面 + 白边）：整体保留，靠亮度调制分层次
            note = f"透明底·多色图形(主色{ratio:.0%})"
            use_dom = False
    else:
        base = edge_color(px, w, h)
        note = "实心底"
        use_dom = True

    shape = {}
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not use_dom:
                s = a / 255.0
            else:
                d = dist((r, g, b), base)
                t = (d - lo) / (HI - lo)
                s = 0.0 if t <= 0 else (1.0 if t >= 1 else t)
                s *= a / 255.0
            shape[(x, y)] = s
    return shape, note


def apply_luma(shape, im):
    """给「彩色图形」做亮度分层，灰度图形不动。

    白化会把所有像素变成纯白，彩色图形内部的明暗差别（wan 的紫面 + 白边、hunyuan 的蓝绿
    渐变）就全没了，只剩一坨轮廓。所以按亮度做一次 min-max 归一化，乘到 alpha 上。

    但灰度图形（krea 的墨线、sd 的黑 S.）不能这么干——它们的「层次」本来就不该有，而且
    图形边缘那一圈抗锯齿像素混了底色，会把 hi 拉到很高，整片黑字就被压成半透明灰。
    所以先用图形区域的颜色纯度（max-min 通道差的中位数）判断是不是彩色图。

    统计用 10%~90% 分位而不是 2%~98%，同样是为了避开抗锯齿边缘。
    """
    px = im.load()
    for cut in (0.9, 0.5):
        inner = [(x, y) for (x, y), s in shape.items() if s > cut]
        if len(inner) >= 50:
            break
    if not inner:
        return shape

    chroma = sorted(max(px[x, y][:3]) - min(px[x, y][:3]) for x, y in inner)
    if chroma[len(chroma) // 2] < 25:      # 灰度图形，纯剪影
        return shape

    vals = sorted(luma(px[x, y][:3]) for x, y in inner)
    lo = vals[int(len(vals) * 0.10)]
    hi = vals[int(len(vals) * 0.90)]
    if hi - lo < 25:
        return shape
    out = {}
    for (x, y), s in shape.items():
        L = luma(px[x, y][:3])
        t = (L - lo) / (hi - lo)
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        out[(x, y)] = s * (FLOOR + (1 - FLOOR) * t)
    return out


def render(shape, w, h):
    # 底色必须是「白色 + 全透明」而不是 (0,0,0,0)：后面 fit_canvas 要用 LANCZOS 缩放，
    # 它会按通道独立插值，透明区域若是黑 RGB，图形边缘就被混出一圈灰边。
    out = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    op = out.load()
    for (x, y), s in shape.items():
        if s > 0.002:
            op[x, y] = (255, 255, 255, int(min(1.0, s) * 255))
    return out


def fit_canvas(im):
    box = im.getbbox()
    if box:
        im = im.crop(box)
    w, h = im.size
    inner = int(CANVAS * (1 - 2 * PAD))
    scale = min(inner / w, inner / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 0))
    canvas.paste(im, ((CANVAS - nw) // 2, (CANVAS - nh) // 2), im)
    return canvas


def main():
    files = sorted(glob.glob(os.path.join(SRC, "*.png")))
    if not files:
        sys.exit(f"没找到图：{SRC}/*.png")
    for f in files:
        name = os.path.basename(f)[:-4]
        im = Image.open(f).convert("RGBA")
        w, h = im.size
        shape, note = build_alpha(im, name)
        shape = apply_luma(shape, im)
        out = fit_canvas(render(shape, w, h))
        out.save(f, optimize=True)
        px = out.load()
        solid = sum(1 for y in range(CANVAS) for x in range(CANVAS) if px[x, y][3] > 128)
        print(f"  {name:8s} {note:26s} 实心 {solid:5d} ({solid / CANVAS / CANVAS * 100:4.1f}%) "
              f"{os.path.getsize(f) / 1024:4.1f}KB")


if __name__ == "__main__":
    main()
