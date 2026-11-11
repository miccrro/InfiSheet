#!/usr/bin/env python3
"""从 static/icon.svg 生成各平台图标，并包出带图标的启动器。

    python tools/icons.py              # 图标 + 启动器
    python tools/icons.py --icons-only # 只出图标文件（不想动启动器时）

为什么需要这一步：`.bat` / `.command` / `.sh` **本身带不了图标**，图标由系统按文件类型给。
想让入口显示 InfiSheet 的图标，每个平台得有个外壳：

    Windows  InfiSheet.lnk        快捷方式，IconLocation 指向 static/icon.ico
    macOS    InfiSheet.app/       Contents/Resources/icon.icns
    Linux    InfiSheet.desktop    Icon= 指向 static/icon-512.png

光栅化用本机 Chrome（`--headless --screenshot`）——项目零依赖，不引入 cairosvg /
ImageMagick；找不到 Chrome 就直接报错，不去猜一个"差不多"的图标。

产物：
    static/icon.ico           16/24/32/48/64/128/256 多尺寸（Windows 资源管理器认这个）
    static/icon.icns          16…1024（macOS）
    static/icon-512.png       通用大图（Linux 桌面、文档、商店页）
    static/icon-256.png       通用中图
    InfiSheet.app/            macOS 应用包
    InfiSheet.desktop         Linux 桌面入口
    InfiSheet.lnk             Windows 快捷方式（只在 Windows 上生成，且**不进版本库**——
                              它里面存的是绝对路径，换台机器就失效；给别人用请跑
                              `创建快捷方式.vbs`，那个按脚本自身位置算路径）
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "static" / "icon.svg"
STATIC = ROOT / "static"

# ICO 要哪几档：16/24/32 是任务栏和小图标列表，48/64 是中图标，128/256 是大图标/预览
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# 单独出的位图（Linux 桌面、README、商店页都够用）
PNG_SIZES = [256, 512]
# 渲染窗口固定这么大：Chrome headless 的最小视口在 500px 上下，小窗口会被它忽略
CANVAS = 1024


def app_version() -> str:
    try:
        return str(json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"])
    except Exception:  # noqa: BLE001
        return "0.0.0"


def find_chrome() -> Path | None:
    """找一个能跑 --headless --screenshot 的 Chrome / Chromium。"""
    cands: list[Path] = []
    if os.name == "nt":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                     os.environ.get("LOCALAPPDATA")):
            if base:
                cands.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
                cands.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    elif sys.platform == "darwin":
        cands.append(Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
        cands.append(Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            found = shutil.which(name)
            if found:
                cands.append(Path(found))
    for c in cands:
        if c.exists():
            return c
    return None


def render(chrome: Path, size: int, out: Path, tmp: Path) -> Path:
    """把 SVG 按目标像素渲染成 size×size 的透明 PNG。

    不能直接把 `--window-size` 设成目标尺寸：Chrome headless 有最小视口（实测约 500px），
    比它小的 window-size 会被忽略，截图只截到页面左上角一块 —— 256px 出来是一整块黑，
    16px 更是完全不对。所以窗口固定 1024，让页面里的 <img> 就排成目标尺寸，
    截完裁左上角那一块：浏览器仍然按目标像素作画，小尺寸照样干净。
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    page = tmp / f"wrap-{size}.html"
    page.write_text(f"""<!doctype html><meta charset="utf-8">
<style>html,body{{margin:0;padding:0;background:transparent;overflow:hidden}}
img{{display:block;width:{size}px;height:{size}px}}</style>
<img src="{SVG.as_uri()}">
""", encoding="utf-8")
    raw = tmp / f"raw-{size}.png"
    subprocess.run(
        [str(chrome), "--headless", "--disable-gpu", "--hide-scrollbars",
         "--no-first-run", "--no-default-browser-check", "--disable-extensions",
         "--force-device-scale-factor=1",
         "--default-background-color=00000000",      # 圆角外要透明，不能给白底
         f"--window-size={CANVAS},{CANVAS}",
         f"--screenshot={raw}", page.as_uri()],
        check=True, capture_output=True, timeout=180,
    )
    from PIL import Image
    with Image.open(raw) as im:
        im.convert("RGBA").crop((0, 0, size, size)).save(out)
    return out


def build_icons(chrome: Path, tmp: Path) -> dict:
    from PIL import Image

    shots: dict[int, Path] = {}
    for size in sorted(set(ICO_SIZES + PNG_SIZES + [CANVAS])):
        shots[size] = render(chrome, size, tmp / f"{size}.png", tmp)

    # ICO：每档都用自己渲染的那张，别让 Pillow 从 1024 缩（小尺寸会糊）
    imgs = [Image.open(shots[s]).convert("RGBA") for s in ICO_SIZES]
    ico = STATIC / "icon.ico"
    imgs[-1].save(ico, format="ICO", sizes=[(s, s) for s in ICO_SIZES],
                  append_images=imgs[:-1])

    # ICNS：Pillow 会自己挑尺寸集，给它最大的那张
    icns = STATIC / "icon.icns"
    Image.open(shots[CANVAS]).convert("RGBA").save(icns, format="ICNS")

    for s in PNG_SIZES:
        shutil.copyfile(shots[s], STATIC / f"icon-{s}.png")

    return {"ico": ico, "icns": icns, "png": [STATIC / f"icon-{s}.png" for s in PNG_SIZES]}


def build_app() -> Path:
    """macOS 应用包。用相对定位回到项目根，整个目录可以随便搬。"""
    app = ROOT / "InfiSheet.app"
    macos = app / "Contents" / "MacOS"
    res = app / "Contents" / "Resources"
    macos.mkdir(parents=True, exist_ok=True)
    res.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(STATIC / "icon.icns", res / "icon.icns")
    ver = app_version()

    (app / "Contents" / "Info.plist").write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>InfiSheet</string>
    <key>CFBundleDisplayName</key><string>InfiSheet</string>
    <key>CFBundleIdentifier</key><string>local.infisheet.launcher</string>
    <key>CFBundleExecutable</key><string>InfiSheet</string>
    <key>CFBundleIconFile</key><string>icon.icns</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>{ver}</string>
    <key>CFBundleVersion</key><string>{ver}</string>
    <key>LSMinimumSystemVersion</key><string>10.13</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
""", encoding="utf-8", newline="\n")

    # 双击 .app 不会给终端窗口：转手交给 Terminal 打开项目根那个 启动.command，
    # 这样日志、报错、"按任意键关闭"全都和原来一样，只是图标换成了 InfiSheet。
    # 换行必须 LF —— 在 Windows 上生成出 CRLF 的话，macOS 会报 bad interpreter。
    launcher = macos / "InfiSheet"
    launcher.write_text("""#!/bin/bash
# InfiSheet.app 的入口：只负责把项目根那个 启动.command 交给 Terminal 跑。
# 用 $0 反推项目根（Contents/MacOS/ 往上三层），所以整个 .app 可以跟着项目一起搬。
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
if [ ! -f "$ROOT/启动.command" ]; then
  osascript -e 'display alert "找不到 启动.command" message "InfiSheet.app 必须放在项目根目录里（和 启动.command 同一层）。"' >/dev/null 2>&1
  exit 1
fi
exec open -a Terminal "$ROOT/启动.command"
""", encoding="utf-8", newline="\n")
    launcher.chmod(0o755)
    return app


def build_desktop() -> Path:
    """Linux 桌面入口。

    `%k` 是 .desktop 自己的路径，靠它把工作目录定回项目根 —— 写死绝对路径的话，
    换台机器 / 换个目录就点不动了。`Icon=` 没有等价的字段码：在 Linux 上生成时写
    绝对路径，其它平台退回相对路径（见下面那段注释）。
    换行必须是 LF：CRLF 的 .desktop 在部分桌面环境里会被当成损坏文件。
    """
    out = ROOT / "InfiSheet.desktop"
    # Icon= 认「绝对路径」或「主题里的图标名」，没有 %k 那种字段码可用。
    # 在 Windows/macOS 上生成时给不出 Linux 路径（写个 E:\ 过去只会更糟），
    # 退回相对路径——多数桌面环境按 .desktop 所在目录解析它。
    icon = (str(STATIC / "icon-512.png") if sys.platform.startswith("linux")
            else "static/icon-512.png")
    out.write_text(f"""# InfiSheet 桌面入口。
# Exec 里的 %k 是 .desktop 自己的位置，靠它把工作目录定回项目根，所以整个目录能随便搬。
# Icon 在非 Linux 上生成时只能写相对路径，个别桌面环境不认 —— 那种情况在项目根跑一次
#   python tools/icons.py
# 就会换成绝对路径。
[Desktop Entry]
Type=Application
Version=1.0
Name=InfiSheet
GenericName=Infinite Canvas
Comment=本地 ComfyUI 的无限画布
Exec=bash -c 'cd "$(dirname "$1")" && exec ./start.sh' infisheet %k
Icon={icon}
Terminal=true
Categories=Graphics;Development;
Keywords=comfyui;canvas;image;
StartupNotify=false
""", encoding="utf-8", newline="\n")
    out.chmod(0o755)
    return out


def build_lnk() -> Path | None:
    """Windows 快捷方式。只在 Windows 上做，而且不进版本库（里面是绝对路径）。"""
    if os.name != "nt":
        return None
    out = ROOT / "InfiSheet.lnk"
    ps = (
        "$ErrorActionPreference='Stop';"
        f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{out}');"
        f"$s.TargetPath='{ROOT / '启动.bat'}';"
        f"$s.WorkingDirectory='{ROOT}';"
        f"$s.IconLocation='{STATIC / 'icon.ico'},0';"
        "$s.Description='InfiSheet · 无限画布';"
        "$s.WindowStyle=1;$s.Save()"
    )
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                   check=True, capture_output=True, timeout=60)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="生成各平台图标与带图标的启动器")
    ap.add_argument("--icons-only", action="store_true", help="只出图标文件，不碰启动器")
    args = ap.parse_args()

    if not SVG.exists():
        print(f"[错误] 找不到 {SVG}", file=sys.stderr)
        return 1
    chrome = find_chrome()
    if not chrome:
        print("[错误] 没找到 Chrome / Chromium，无法把 SVG 光栅化。\n"
              "       装一个 Chrome（或 Edge），或者手动把 icon.svg 导成 ico/icns。",
              file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as td:
        made = build_icons(chrome, Path(td))
    for p in [made["ico"], made["icns"], *made["png"]]:
        print(f"图标  {p.relative_to(ROOT)}  ({p.stat().st_size // 1024} KB)")

    if args.icons_only:
        return 0

    app = build_app()
    print(f"macOS {app.relative_to(ROOT)}/")
    desk = build_desktop()
    print(f"Linux {desk.relative_to(ROOT)}")
    lnk = build_lnk()
    if lnk:
        print(f"Windows {lnk.relative_to(ROOT)}（绝对路径，不进版本库）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
