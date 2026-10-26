#!/usr/bin/env python3
"""不依赖 ComfyUI、不开浏览器的冒烟测试。

起一个隔离实例（随机端口 + tests/.tmp 下的临时 data 目录），确认：
静态资源、健康检查、预设直链、目录穿越、项目 CRUD、未知路由 404。
CI 里跑这个就够；要连 ComfyUI 的完整回归用 `python selftest.py`，要浏览器交互用 `npm run test:e2e`。

    python tests/smoke.py [--keep]
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "tests" / ".tmp"

PASS = 0
FAIL = 0
SKIP = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}" + (f"   [{detail}]" if detail else ""))
    else:
        FAIL += 1
        print(f"FAIL  {name}" + (f"   [{detail}]" if detail else ""))


def request(base: str, path: str, method: str = "GET", body: dict | None = None, timeout: float = 10.0):
    url = base + path.lstrip("/")
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def wait_health(base: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _ = request(base, "/api/health", timeout=1.0)
            if status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


def main() -> int:
    keep = "--keep" in sys.argv
    TMP.mkdir(parents=True, exist_ok=True)
    data_dir = TMP / f"smoke-{int(time.time())}-{id(object()) % 1000}"
    (data_dir / "projects").mkdir(parents=True, exist_ok=True)

    import random
    import socket
    import subprocess

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", "server.py", "--port", str(port), "--data", str(data_dir), "--no-browser"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}/"
    try:
        check("服务能起来（/api/health 200）", wait_health(base))
        status, raw = request(base, "/api/health")
        health = json.loads(raw or b"{}")
        check(
            "health 字段完整",
            status == 200 and health.get("ok") is True and "presets" in (health.get("features") or []),
            f"comfy={health.get('comfy')}",
        )

        for path, must in [
            ("/", "icons.js"),
            ("/app.js", "buildGenPanel"),
            ("/icons.js", "ICON_PATHS"),
            ("/style.css", "--canvas-bg"),
        ]:
            status, raw = request(base, path)
            text = raw.decode("utf-8", "replace")
            check(f"静态资源 {path}", status == 200 and must in text, f"{status} {len(raw)}B")

        status, raw = request(base, "/presets/krea2-txt2img.api.json")
        preset = json.loads(raw or b"{}")
        check("预设直链可读", status == 200 and isinstance(preset, dict) and len(preset) > 0, f"{status} {len(preset)} 节点")

        status, _ = request(base, "/presets/..%2Fserver.py")
        check("目录穿越被挡", status in (400, 403, 404), f"HTTP {status}")

        # ---- 插槽排序（纯函数，不连 ComfyUI）----
        # 前端取 texts[0] 当正向提示词。Qwen-image-2.1 编辑流的编码器同时有
        # prompt 与 negative_prompt，字母序前者在后，排错就把用户文案写进负面词了。
        sys.path.insert(0, str(ROOT))
        import server as srv

        def slot(kind, node, name):
            return {"kind": kind, "node": node, "input": name}

        ordered = sorted(
            [slot("text", "487", "negative_prompt"), slot("text", "487", "prompt"), slot("image", "504", "image")],
            key=srv.slot_sort_key)
        check("正向提示词排在负面之前", [s["input"] for s in ordered] == ["image", "prompt", "negative_prompt"],
              " > ".join(s["input"] for s in ordered))
        by_num = sorted([slot("text", "100", "text"), slot("text", "9", "text")], key=srv.slot_sort_key)
        check("节点 id 按数值排序（9 在 100 之前）", [s["node"] for s in by_num] == ["9", "100"],
              " > ".join(s["node"] for s in by_num))

        status, _ = request(base, "/definitely-not-here")
        check("未知路由 404", status == 404, f"HTTP {status}")

        status, raw = request(base, "/api/projects")
        projects = json.loads(raw or b"{}")
        check("项目列表接口", status == 200 and projects.get("ok") is True, f"{len(projects.get('items') or [])} 个")

        status, raw = request(base, "/api/projects", "POST", {"name": "smoke 测试项目"})
        created = json.loads(raw or b"{}")
        pid = created.get("id")
        check("新建项目", status == 200 and bool(pid), str(pid))
        check("项目文件落在临时目录", (data_dir / "projects" / f"{pid}.json").is_file())

        status, raw = request(base, f"/api/projects/{pid}")
        got = json.loads(raw or b"{}")
        canvas = got.get("canvas") or {}
        check("读取项目", status == 200 and got.get("ok") is True and canvas.get("name") == "smoke 测试项目",
              str(canvas.get("name")))

        status, _ = request(base, f"/api/projects/{pid}", "DELETE")
        check("删除项目", status == 200)

        status, raw = request(base, "/api/health")
        check("跑完仍健康", status == 200)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if not keep:
            import shutil

            shutil.rmtree(data_dir, ignore_errors=True)
        else:
            print(f"保留临时目录：{data_dir}")

    total = PASS + FAIL + SKIP
    print("-" * 60)
    print(f"共 {total} 项：通过 {PASS} · 跳过 {SKIP} · 失败 {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
