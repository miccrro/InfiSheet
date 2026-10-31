#!/usr/bin/env python3
"""打包：把「能直接跑的工程」压成 zip，放进 dist/。

    python tools/pack.py              # 程序包（不含 data/）
    python tools/pack.py --with-data  # 额外打一个只有 data/ 的存档包
    python tools/pack.py --out D:/x   # 指定输出目录

打包规则：
- 只收白名单（server.py / mcp_server.py / selftest.py / 启动.bat / README.md / 验收报告.md / static /
  presets / package.json 等工程文件），data/、node_modules、tests/.tmp、__pycache__、dist 一律不进；
- zip 内路径统一用 `/`、文件名用 UTF-8 —— Windows 自带压缩会用反斜杠，macOS/Linux 解压会变成怪名字。
"""

from __future__ import annotations

import argparse
import json
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

INCLUDE_FILES = [
    "server.py",
    "mcp_server.py",
    "selftest.py",
    "启动.bat",
    "README.md",
    "验收报告.md",
    "package.json",
    "package-lock.json",
    ".gitignore",
    ".editorconfig",
    ".prettierrc",
]
INCLUDE_DIRS = ["static", "presets", "docs", "tools", "tests", ".github"]
EXCLUDE_PARTS = {"node_modules", ".tmp", "__pycache__", "data", "dist", ".git", "shots"}


def iter_files(base: Path):
    if base.is_file():
        yield base
        return
    for p in sorted(base.rglob("*")):
        if not p.is_file():
            continue
        if any(part in EXCLUDE_PARTS for part in p.relative_to(ROOT).parts):
            continue
        yield p


def build(out_dir: Path, with_data: bool) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = date.today().isoformat()
    version = "dev"
    try:
        version = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version", "dev")
    except Exception:
        pass

    written: list[Path] = []
    app_zip = out_dir / f"infisheet-{version}-{stamp}.zip"
    with zipfile.ZipFile(app_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in INCLUDE_FILES:
            p = ROOT / name
            if p.is_file():
                zf.write(p, f"infisheet/{name}")
        for name in INCLUDE_DIRS:
            d = ROOT / name
            if not d.is_dir():
                continue
            for p in iter_files(d):
                rel = p.relative_to(ROOT).as_posix()
                if rel.endswith(".pyc") or "/.tmp/" in "/" + rel:
                    continue
                zf.write(p, f"infisheet/{rel}")
    written.append(app_zip)

    if with_data:
        data_zip = out_dir / f"infisheet-data-{version}-{stamp}.zip"
        data_dir = ROOT / "data"
        with zipfile.ZipFile(data_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            if data_dir.is_dir():
                for p in sorted(data_dir.rglob("*")):
                    if p.is_file():
                        zf.write(p, f"infisheet/{p.relative_to(ROOT).as_posix()}")
        written.append(data_zip)
    return written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist"), help="输出目录（默认 dist/）")
    ap.add_argument("--with-data", action="store_true", help="顺便打一个只有 data/ 的存档包")
    args = ap.parse_args()

    for z in build(Path(args.out), args.with_data):
        size = z.stat().st_size / 1024
        print(f"{z}  {size:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
