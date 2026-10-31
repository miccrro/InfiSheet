#!/usr/bin/env python3
"""不依赖 ComfyUI、不开浏览器的冒烟测试。

起一个隔离实例（随机端口 + tests/.tmp 下的临时 data 目录），确认：
静态资源、健康检查、预设直链、目录穿越、项目 CRUD、未知路由 404。
CI 里跑这个就够；要连 ComfyUI 的完整回归用 `python selftest.py`，要浏览器交互用 `npm run test:e2e`。

    python tests/smoke.py [--keep]
"""

from __future__ import annotations

import json
import os
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
    """等服务端 HTTP 起来。探 /api/projects 而不是 /api/health：
    后者会顺手去问 ComfyUI，ComfyUI 没开时那条代理要两秒才吐 connection refused，
    1 秒探测直接被超时吃掉，整轮 smoke 会误报「服务没起来」（真机踩过）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _ = request(base, "/api/projects", timeout=1.5)
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

    # MCP 安装会把条目写进客户端的 mcp.json —— 测试必须指向临时 HOME，绝不碰真配置
    mcp_home = data_dir / "mcp-home"
    env = dict(os.environ)
    env["INFISHEET_MCP_HOME"] = str(mcp_home)
    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", "server.py", "--port", str(port), "--data", str(data_dir), "--no-browser"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    base = f"http://127.0.0.1:{port}/"
    try:
        check("服务能起来（/api/projects 200）", wait_health(base))
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

        # 预设的「吃不吃图」由服务端扫图给出，前端靠它挑工作流：
        # 按名字猜的时候选中过 Moss_图像编辑 —— 那是纯文生图，参考图根本没进图。
        status, raw = request(base, "/api/library")
        lib = json.loads(raw or b"{}")
        by_file = {p["file"]: p for p in (lib.get("presets") or [])}
        check("库接口给每个预设标了 takes_image",
              status == 200 and all("takes_image" in p for p in by_file.values()),
              f"{len(by_file)} 个预设")
        moss = next((p for p in by_file.values() if "Moss" in p["file"]), None)
        check("纯文生图预设如实报 takes_image=False（Moss 不能被当成图像编辑用）",
              moss is not None and moss["takes_image"] is False,
              json.dumps({k: moss.get(k) for k in ("title", "takes_image")} if moss else {}, ensure_ascii=False))

        status, _ = request(base, "/presets/..%2Fserver.py")
        check("目录穿越被挡", status in (400, 403, 404), f"HTTP {status}")

        # ---- MCP 安装入口 ----
        # 顶栏那盏灯点开就是这个面板的数据源：端点 / stdio 命令 / 三个客户端的配置片段。
        # 门槛全在第一步（写错路径、漏了 type），所以这里验的是「照抄能不能用」。
        status, raw = request(base, "/api/mcp/setup")
        setup = json.loads(raw or b"{}")
        clients = {c["id"]: c for c in (setup.get("clients") or [])}
        check("接入信息齐全：端点 / python / 脚本路径",
              status == 200 and setup.get("endpoint", "").endswith(f":{port}/mcp")
              and setup.get("script", "").endswith("mcp_server.py") and bool(setup.get("python")),
              f"{setup.get('endpoint')} · {setup.get('script')}")
        check("三个客户端都在，配置片段指向 mcp_server.py",
              set(clients) == {"workbuddy", "claude", "cursor"}
              and all(c["config"]["mcpServers"]["infisheet"]["args"][0].endswith("mcp_server.py")
                      for c in clients.values()),
              ",".join(sorted(clients)))
        check("Claude 的条目不带 type（它的格式和别家不同）",
              "type" not in clients["claude"]["config"]["mcpServers"]["infisheet"]
              and clients["workbuddy"]["config"]["mcpServers"]["infisheet"]["type"] == "stdio")

        wb = Path(clients["workbuddy"]["path"])
        check("配置路径落在隔离目录里（不写用户真配置）",
              str(wb).startswith(str(mcp_home)), str(wb))

        status, raw = request(base, "/api/mcp/install", "POST", {"client": "workbuddy"})
        res = json.loads(raw or b"{}")
        written = json.loads(wb.read_text(encoding="utf-8")) if wb.is_file() else {}
        check("install 新建配置文件并写入 infisheet 条目",
              status == 200 and res.get("ok") is True
              and written.get("mcpServers", {}).get("infisheet", {}).get("args", [""])[0].endswith("mcp_server.py"),
              str(wb))

        # 再装一次：别人的条目要留着、要留备份、结果仍是合法 JSON（不能把用户配置写坏）
        cfg = json.loads(wb.read_text(encoding="utf-8"))
        cfg["mcpServers"]["someone-else"] = {"command": "x"}
        wb.write_text(json.dumps(cfg), encoding="utf-8")
        status, raw = request(base, "/api/mcp/install", "POST", {"client": "workbuddy"})
        after = json.loads(wb.read_text(encoding="utf-8"))
        backups = list(wb.parent.glob(wb.name + ".bak-*"))
        check("重复安装：保留别人的条目 + 留备份 + 结果仍是合法 JSON",
              status == 200 and "someone-else" in after["mcpServers"]
              and "infisheet" in after["mcpServers"] and bool(backups),
              f"backup={bool(backups)} keys={sorted(after['mcpServers'])}")

        # 坏文件：宁可报错也不能覆盖（用户的 mcp.json 里可能有一堆别的服务）
        wb.write_text("{ not json", encoding="utf-8")
        status, raw = request(base, "/api/mcp/install", "POST", {"client": "workbuddy"})
        check("现有配置不是合法 JSON 时拒绝写入，文件原样保留",
              status == 400 and wb.read_text(encoding="utf-8") == "{ not json", f"HTTP {status}")

        status, _ = request(base, "/api/mcp/install", "POST", {"client": "nope"})
        check("不认识的客户端回 400", status == 400, f"HTTP {status}")

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

        # ---- 生成进度百分比（纯函数，不连 ComfyUI）----
        # ComfyUI 的 progress / progress_state 是**指名发给提交任务那个 client_id** 的
        # （send_json 里 `elif sid in self.sockets`）。之前 ws 用 "canvas-progress"、
        # /prompt 用随机 uuid，于是画布上永远只有「生成中…」——这条断言守着这个不变式。
        src = (ROOT / "server.py").read_text(encoding="utf-8")
        check("ws 监听与 /prompt 提交共用同一个 client id（字面量只许出现一次）",
              src.count('"canvas-progress"') == 1 and srv.PROGRESS_CLIENT == "canvas-progress",
              f'"canvas-progress" 出现 {src.count(chr(34) + "canvas-progress" + chr(34))} 次')

        # 上排按钮不画「外面再套一圈」的焦点圈：用户两次说那是重复显示（截图里那颗蓝框）。
        # 这条规则一旦被删，点一下 / Tab 一下「风格」就会冒出一圈蓝线。
        css = " ".join((ROOT / "static" / "style.css").read_text(encoding="utf-8").split())
        check("上排按钮的焦点态不画额外焦点圈（.gen-chips .chip:focus → outline: none）",
              ".gen-chips .chip:focus-visible { outline: none;" in css, "")

        # 顶部进度条现在只画在工作流节点上；它要浮在「标题行 → 卡片」的缝里，不能贴回卡片顶上
        # （贴在顶上时那条 2px 圆角线会压着内容，图片节点当初就是因为这个被用户要求整条去掉的）。
        check("工作流节点的进度条浮在标题与卡片之间，不压在内容上",
              "top: -5px; height: 3px" in css and "border-radius: 999px" in css,
              "")

        srv.PROGRESS.clear()
        srv.PROGRESS_NODES.clear()
        srv._progress_update("tk", "7", 5, 20)
        p25 = srv.PROGRESS.get("tk")
        srv._progress_update("tk", "7", 20, 20)
        p_full = srv.PROGRESS.get("tk")
        srv._progress_update("tk", "8", 0, 10)          # 第二个采样器进来，分母变大
        p_two = srv.PROGRESS.get("tk")
        srv._progress_update("tk", "8", 10, 10)
        p_both = srv.PROGRESS.get("tk")
        srv._progress_update("tk", "8", 3, 10)          # 同一节点重跑：允许往回走，不能钉死
        p_redo = srv.PROGRESS.get("tk")
        srv._progress_update("tk2", "9", "x", 10)       # 脏数据不写
        check("进度：单节点按步数换算（5/20 → 25%）", p25 == 25, str(p25))
        check("进度：跑满也只报 99%（100% 留给「完成」那一刻）", p_full == 99, str(p_full))
        check("进度：多采样器按各节点步数加权（20/20 + 0/10 → 67%）", p_two == 67, str(p_two))
        check("进度：全部跑满 → 99%", p_both == 99, str(p_both))
        check("进度：同一节点重跑能往回走（23/30 → 77%）", p_redo == 77, str(p_redo))
        check("进度：脏数据不写进去", "tk2" not in srv.PROGRESS)

        # 一次性节点（解码 / 保存 / 文本编码，max 恒为 1）不能进分母：
        # 它们一进来就会把百分比往下拉（实测 99% → 94%），看着像任务重来了
        srv.PROGRESS.clear()
        srv.PROGRESS_NODES.clear()
        srv._progress_update("tk3", "7", 10, 20)
        p_half = srv.PROGRESS.get("tk3")
        srv._progress_update("tk3", "8", 0, 1)           # VAEDecode 开工
        p_decode0 = srv.PROGRESS.get("tk3")
        srv._progress_update("tk3", "8", 1, 1)           # VAEDecode 完成
        srv._progress_update("tk3", "9", 0, 1)           # SaveImage 开工
        p_decode1 = srv.PROGRESS.get("tk3")
        check("进度：一次性节点不进分母（10/20 一直是 50%）",
              p_half == 50 and p_decode0 == 50 and p_decode1 == 50,
              f"{p_half} / {p_decode0} / {p_decode1}")

        # 采样器开工前只有一次性节点（EmptyLatentImage 1/1、CLIPTextEncode 0/1）：
        # 这时一个数都不许编，否则会出现「先 50% 再掉到 7%」
        srv._progress_update("tk4", "6", 1, 1)
        srv._progress_update("tk4", "4", 0, 1)
        check("进度：采样器还没开工时不编数字（留空 →「生成中…」）",
              "tk4" not in srv.PROGRESS, str(srv.PROGRESS.get("tk4")))

        status, _ = request(base, "/definitely-not-here")
        check("未知路由 404", status == 404, f"HTTP {status}")

        # ---- 队列取消（队列面板逐条取消用的路由）----
        # 不带 prompt_id 必须 400：否则会把整条队列误删。
        status, raw = request(base, "/api/queue/cancel", "POST", {})
        check("取消任务缺 prompt_id 直接 400", status == 400, f"HTTP {status} {raw[:60]!r}")
        # 不存在的 pid：ComfyUI 在线时回 200 + removed=false（「它不在了」不是错误）；
        # 不在线时 502（连不上），但**绝不能 500** —— 前端要能把这句话原样显示出来。
        status, raw = request(base, "/api/queue/cancel", "POST", {"prompt_id": "smoke-not-a-real-pid"})
        body = json.loads(raw or b"{}")
        check("取消不存在的任务不报 500（在线：removed=false；离线：502）",
              status in (200, 502) and (status != 200 or body.get("removed") is False),
              f"HTTP {status} {str(body)[:80]}")
        # 只接受 POST：GET 走到 api_get 的兜底 404，避免被当成幂等查询反复打
        status, _ = request(base, "/api/queue/cancel")
        check("取消任务只认 POST", status == 404, f"HTTP {status}")

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

        # ---- 关闭服务 ----
        # 先验「跨站请求被挡」：本地服务没有鉴权，不能让任意网页一个 POST 就把画布关了。
        # 浏览器跨站发 POST 会带 Origin，同源校验足够挡住。
        import urllib.request as _ur

        req = _ur.Request(base + "api/shutdown", data=b"{}", method="POST",
                          headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        try:
            with _ur.urlopen(req, timeout=10) as res:
                code = res.status
        except urllib.error.HTTPError as exc:
            code = exc.code
        check("跨站的关闭请求被拒绝（403），服务还在", code == 403 and request(base, "/api/health")[0] == 200,
              f"HTTP {code}")

        status, raw = request(base, "/api/shutdown", "POST", {})
        body = json.loads(raw or b"{}")
        check("关闭服务：回 ok（先回响应，再停进程）",
              status == 200 and body.get("ok") is True, f"HTTP {status}")

        gone = False
        for _ in range(50):
            time.sleep(0.15)
            try:
                if request(base, "/api/projects", timeout=1)[0] != 200:
                    gone = True
                    break
            except Exception:
                gone = True
                break
        check("关闭服务：进程真的退出（端口不再响应）", gone)
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
