# -*- coding: utf-8 -*-
"""把「风格提示词」素材包导入到 static/styles/（只在导入/更新风格库时跑一次）。

数据源是 Krea2 的 397 个风格（10 个分类），每个 JSON 是一个**列表**，条目长这样：

    {"name": "Anime Style", "name_cn": "动漫风格",
     "prompt": "Style: ... Subject:{prompt}",   # {prompt} 是给主体提示词留的占位
     "negative_prompt": "", "thumbnail": "./samples/动漫__Anime Style.jpg"}

导入做三件事：
1. 把每个分类的 JSON 抄进 static/styles/<分类>.json，**只改 thumbnail 字段**——
   原图是 512×512 的 jpg（整包 89MB），浏览器一次列表要拉几百张，必须缩。
2. 缩略图按 160×160 存成 jpg（每张 5~8KB，397 张约 2MB），放 static/styles/thumbs/。
3. 写 static/styles/index.json（分类清单 + 封面），前端只读这一个文件，
   点开分类时再按需拉那一份，不在首屏把 397 条提示词全塞进内存。

前端读法见 app.js 的「风格」一节：fetch('styles/index.json') → fetch('styles/<file>')。

用法（需要能读图：本机系统 Python 带 PIL，托管 Python 没有）：
    E:\\python-3.13.11\\python.exe tools\\import_styles.py
    E:\\python-3.13.11\\python.exe tools\\import_styles.py --src "D:/别的素材包/styles"
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "static" / "styles"
DEFAULT_SRC = Path(r"C:\Users\Libubu\Desktop\风格提示词\styles")
THUMB = 160          # 缩略图边长：卡片实际显示 76~88px，2 倍够视网膜屏
QUALITY = 80

# 分类顺序就是前端标签栏的顺序：动漫放第一个（用户最常用）。
# (id, 中文标签, 源文件名主干)
CATS = [
    ("anime", "动漫", "krea2_397styles-anime_动漫"),
    ("photography", "摄影", "krea2_397styles-photography_摄影"),
    ("painting", "绘画", "krea2_397styles-painting_绘画"),
    ("drawing", "素描", "krea2_397styles-drawing_素描"),
    ("comics", "漫画", "krea2_397styles-comics_漫画"),
    ("cartoon", "卡通", "krea2_397styles-cartoon_卡通"),
    ("cover_art", "封面艺术", "krea2_397styles-cover_art_封面艺术"),
    ("design", "设计", "krea2_397styles-design_设计"),
    ("digital_painting", "数字绘画", "krea2_397styles-digital_painting_数字绘画"),
    ("3d_render", "3D渲染", "krea2_397styles-3d_render_3D渲染"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DEFAULT_SRC), help="素材包根目录（里面有 samples/ 和各个 json）")
    args = ap.parse_args()
    src = Path(args.src).expanduser()
    if not src.is_dir():
        print(f"找不到素材目录：{src}")
        return 1
    try:
        from PIL import Image
    except ImportError:
        print("缺少 Pillow：换系统 Python 跑（E:\\python-3.13.11\\python.exe），托管 Python 是裸环境")
        return 1

    thumbs_dir = DEST / "thumbs"
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    index, total, missed = [], 0, []

    for cid, label, stem in CATS:
        f = src / f"{stem}.json"
        if not f.is_file():
            print(f"跳过（源文件不存在）：{f.name}")
            continue
        items = json.loads(f.read_text(encoding="utf-8"))
        out = []
        for i, s in enumerate(items, 1):
            rel = (s.get("thumbnail") or "").replace("\\", "/")
            name = Path(rel).name
            thumb_name = f"{cid}-{i:03d}.jpg"
            target = thumbs_dir / thumb_name
            img_src = src / "samples" / name
            if img_src.is_file():
                im = Image.open(img_src)
                im = im.convert("RGB")
                im.thumbnail((THUMB, THUMB), Image.LANCZOS)
                im.save(target, "JPEG", quality=QUALITY, optimize=True)
            else:
                missed.append(name)          # 少一张图不算错，前端会给占位块
            out.append({
                "name": s.get("name") or f"{label} {i}",
                "name_cn": s.get("name_cn") or s.get("name") or "",
                # {prompt} 是主体占位符，前端用它把用户提示词拼进去
                "prompt": s.get("prompt") or "",
                "negative": s.get("negative_prompt") or "",
                "thumb": f"./thumbs/{thumb_name}" if target.is_file() else "",
            })
        # 紧凑写：397 条提示词带缩进会白涨 40% 体积，这文件是给机器读的
        (DEST / f"{cid}.json").write_text(
            json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index.append({"id": cid, "label": label, "file": f"{cid}.json",
                      "count": len(out), "cover": out[0]["thumb"] if out else ""})
        total += len(out)
        print(f"{label:<6} {len(out):>3} 条 → {cid}.json")

    (DEST / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    size = sum(f.stat().st_size for f in DEST.rglob("*") if f.is_file())
    print(f"\n共 {len(index)} 类 / {total} 条，{size / 1024 / 1024:.1f}MB → {DEST}")
    if missed:
        print(f"缺 {len(missed)} 张样图（已留空，前端显示占位块）：{', '.join(missed[:5])}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
