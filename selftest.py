#!/usr/bin/env python3
"""Comfy 无限画布 · 零依赖回归自测

起一个临时实例（独立端口 + 独立数据目录），把服务端契约逐项断言完再关掉，
不碰你正在用的 data/ 目录，也不需要浏览器。

用法：
    python selftest.py                 # 跑全部（会真的提交一个 64×64 的秒级任务）
    python selftest.py --no-run        # 只测接口契约，不碰 ComfyUI 队列
    python selftest.py --upload        # 额外测上传（会在 input/ 留一张测试图）
    python selftest.py -v              # 打印实例地址与请求明细

退出码：0 = 全部通过（允许 SKIP），1 = 有 FAIL。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"
PRESET = "krea2-txt2img.api.json"

# 控制台统一 UTF-8：Windows 默认 GBK，中文断言名会乱码（bat 里也已 chcp 65001）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


# --------------------------------------------------------------------------- #
# HTTP 小工具
# --------------------------------------------------------------------------- #
def http(method: str, url: str, body=None, headers=None, timeout=20):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()


def jget(base: str, path: str, timeout=20):
    status, _, raw = http("GET", base + path, timeout=timeout)
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return status, None


def jpost(base: str, path: str, body):
    status, _, raw = http("POST", base + path, body=body)
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return status, None


def http_raw(method: str, url: str, body: bytes, content_type: str, timeout=30):
    """原样发字节（上传用），不做 JSON 编码。"""
    req = urllib.request.Request(url, data=body, method=method,
                                headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()


# --------------------------------------------------------------------------- #
# 进程
# --------------------------------------------------------------------------- #
def free_port() -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def wait_ready(base: str, proc: subprocess.Popen, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            status, data = jget(base, "/api/health", timeout=3)
            if status == 200 and isinstance(data, dict) and data.get("ok"):
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.15)
    return False


# --------------------------------------------------------------------------- #
# 断言
# --------------------------------------------------------------------------- #
class Checks:
    def __init__(self, verbose: bool = False):
        self.rows: list[tuple[str, str, str]] = []
        self.verbose = verbose

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.rows.append((name, "PASS" if ok else "FAIL", detail))
        line = f"{'PASS' if ok else 'FAIL'}  {name}"
        if detail:
            line += f"   [{detail}]"
        print(line)

    def skip(self, name: str, reason: str) -> None:
        self.rows.append((name, "SKIP", reason))
        print(f"SKIP  {name}   [{reason}]")

    def summary(self) -> int:
        fails = [r for r in self.rows if r[1] == "FAIL"]
        skips = [r for r in self.rows if r[1] == "SKIP"]
        print("-" * 60)
        print(f"共 {len(self.rows)} 项：通过 {len(self.rows) - len(fails) - len(skips)} · "
              f"跳过 {len(skips)} · 失败 {len(fails)}")
        return 0 if not fails else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Comfy 无限画布回归自测")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印请求明细")
    ap.add_argument("--no-run", action="store_true",
                    help="不真的往 ComfyUI 提交任务（只测接口契约）")
    ap.add_argument("--upload", action="store_true",
                    help="测 /api/upload（会在 ComfyUI input/ 留一个 67 字节的 selftest-upload.png）")
    ap.add_argument("--keep", action="store_true", help="保留临时数据目录（排查用）")
    args = ap.parse_args()

    c = Checks(args.verbose)
    # 临时目录固定在项目内（.selftest-tmp/run），跑完即删。
    # 注意：这里用 Path.mkdir 而不是 tempfile.mkdtemp —— 后者在 Windows 上会带上
    # 仅本进程可用的权限，导致子进程写不进去、事后也删不掉。
    staging = ROOT / ".selftest-tmp"
    tmp = staging / "run"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    log_path = tmp / "server.log"      # 服务进程自己继承控制台输出，这里只留路径给报错提示
    proc = subprocess.Popen(
        [sys.executable, "-u", str(SERVER), "--port", str(port),
         "--no-browser", "--data", str(tmp / "data")],
        cwd=str(ROOT),
    )
    if args.verbose:
        print(f"实例: {base}  数据目录: {tmp / 'data'}")

    try:
        if not wait_ready(base, proc):
            print("FAIL  服务没能启动（上面的服务输出即原因）")
            return 1

        # ---------------- 1. 健康与静态资源 ----------------
        status, health = jget(base, "/api/health")
        c.check("health 200 + ok", status == 200 and (health or {}).get("ok") is True,
                f"comfy={(health or {}).get('comfy')} v={(health or {}).get('version')}")
        comfy_up = bool((health or {}).get("comfy"))

        status, _, raw = http("GET", base + "/")
        c.check("首页可访问且含品牌名",
                status == 200 and "Comfy 无限画布" in raw.decode("utf-8", "replace"),
                f"HTTP {status} {len(raw)}B")
        status, _, raw = http("GET", base + "/app.js")
        c.check("app.js 可访问",
                status == 200 and b"function buildGenPanel" in raw, f"HTTP {status}")

        # 目录穿越必须被挡
        status, _, _ = http("GET", base + "/presets/../../server.py")
        c.check("presets 目录穿越被拒", status in (400, 403, 404), f"HTTP {status}")
        status, _, _ = http("GET", base + "/../server.py")
        c.check("静态目录穿越被拒", status in (400, 403, 404), f"HTTP {status}")

        # ---------------- 2. 预设与插槽分析 ----------------
        status, lib = jget(base, "/api/library")
        presets = (lib or {}).get("presets") or []
        c.check("library 列出内置预设", status == 200 and len(presets) >= 1,
                f"presets={len(presets)} items={len((lib or {}).get('items') or [])}")
        kinds = (presets[0] or {}).get("kinds") if presets else None
        c.check("预设带 kinds 能力标记", isinstance(kinds, list) and "image" in (kinds or []),
                f"kinds={kinds}")

        status, preset = jget(base, f"/presets/{PRESET}")
        graph = (preset or {}).get("graph")
        c.check("预设文件可读取并含 graph",
                status == 200 and isinstance(graph, dict) and len(graph) >= 1,
                f"nodes={len(graph or {})}")

        status, analysis = jpost(base, "/api/analyze", {"graph": graph})
        slots = (analysis or {}).get("slots") or []
        outputs = (analysis or {}).get("outputs") or []
        c.check("analyze 识别出插槽", status == 200 and len(slots) >= 4, f"slots={len(slots)}")
        c.check("插槽含 text 类型", any(s.get("kind") == "text" for s in slots),
                "kinds=" + ",".join(sorted({s.get("kind", "?") for s in slots})))
        c.check("analyze 识别出 SaveImage 输出",
                any(o.get("class_type") == "SaveImage" for o in outputs),
                f"outputs={[o.get('class_type') for o in outputs]}")

        broken = dict(graph)
        broken["99"] = {"class_type": "NoSuchNodeXYZ", "inputs": {"a": 1}}
        status, analysis2 = jpost(base, "/api/analyze", {"graph": broken})
        c.check("未知节点被标记 unknown_types",
                status == 200 and any("NoSuchNodeXYZ" in u for u in (analysis2 or {}).get("unknown_types") or []),
                f"unknown={(analysis2 or {}).get('unknown_types')}")

        # 界面格式（nodes / links / widgets_values）导入：前端存的必须是服务端转好的 API 图。
        # 否则存档里塞的是导出者整份 UI 数据，运行时 ComfyUI 只回一句 node_errors。
        ui_graph = {
            "nodes": [
                {"id": 1, "type": "CLIPTextEncode", "inputs": [{"name": "clip", "link": 1}],
                 "outputs": [{"name": "CONDITIONING", "links": [2]}], "widgets_values": ["一只淋雨的猫"]},
                {"id": 2, "type": "CLIPLoader", "inputs": [],
                 "outputs": [{"name": "CLIP", "links": [1]}], "widgets_values": ["qwen3vl_4b_fp8_scaled.safetensors", "krea2", "default"]},
                {"id": 3, "type": "EmptyLatentImage", "inputs": [],
                 "outputs": [{"name": "LATENT", "links": [3]}], "widgets_values": [512, 512, 1]},
            ],
            "links": [[1, 2, 0, 1, 0, "CLIP"], [2, 1, 0, 9, 0, "CONDITIONING"], [3, 3, 0, 9, 1, "LATENT"]],
        }
        status, ui_analysis = jpost(base, "/api/analyze", {"graph": ui_graph})
        back = (ui_analysis or {}).get("graph") or {}
        c.check("界面格式导入后回传的是转换好的 API 图（不是原始 nodes/widgets_values）",
                status == 200 and isinstance(back, dict) and "nodes" not in back
                and all(isinstance(v, dict) and v.get("class_type") for v in back.values()),
                f"nodes={list(back)[:4]}")
        c.check("转换后的 API 图带着工作流里字面量参数（widgets_values 已对齐到输入名）",
                (back.get("3") or {}).get("inputs", {}).get("width") == 512
                and (back.get("1") or {}).get("inputs", {}).get("text") == "一只淋雨的猫",
                json.dumps((back.get("3") or {}).get("inputs") or {}, ensure_ascii=False)[:80])

        # ---------------- 3. 画布快照与写保护 ----------------
        status, canvas = jget(base, "/api/canvas")
        c.check("新数据目录初始无画布", status == 200 and (canvas or {}).get("canvas") is None)

        snap = {"version": 2, "name": "自测画布", "bootAt": 2000, "nodes": [{"id": "t1", "type": "text"}],
                "links": [], "groups": [], "view": {"x": 0, "y": 0, "k": 1}}
        status, res = jpost(base, "/api/canvas", {"canvas": snap})
        c.check("写入画布快照", status == 200 and (res or {}).get("ok") is True and not (res or {}).get("stale"))

        old = dict(snap, name="旧会话", bootAt=1000)
        status, res = jpost(base, "/api/canvas", {"canvas": old})
        status2, canvas = jget(base, "/api/canvas")
        name_now = ((canvas or {}).get("canvas") or {}).get("name")
        c.check("旧 bootAt 写入被写保护拦下",
                (res or {}).get("stale") is True and name_now == "自测画布", f"stale={(res or {}).get('stale')} name={name_now}")
        c.check("快照落在 --data 指定目录",
                (tmp / "data" / "canvas.json").is_file(), str(tmp / "data" / "canvas.json"))

        status, _ = jpost(base, "/api/canvas", {})
        _, canvas = jget(base, "/api/canvas")
        c.check("空 canvas 写入被拒且不动存档",
                status == 400 and ((canvas or {}).get("canvas") or {}).get("name") == "自测画布",
                f"HTTP {status} name={((canvas or {}).get('canvas') or {}).get('name')}")

        status, _, _ = http("DELETE", base + "/api/canvas")
        status2, canvas = jget(base, "/api/canvas")
        c.check("DELETE 画布后快照清空",
                status == 200 and (canvas or {}).get("canvas") is None, f"HTTP {status}/{status2}")

        # ---------------- 4. 工作流库往返 ----------------
        lib_name = urllib.parse.quote("自测-快速")
        status, _, res = http("PUT", f"{base}/api/library/{lib_name}", body={"graph": graph})
        payload = json.loads(res.decode("utf-8")) if res else {}
        c.check("PUT 工作流入库", status == 200 and payload.get("ok") is True, f"HTTP {status}")

        status, lib2 = jget(base, "/api/library")
        names = [i.get("name") for i in ((lib2 or {}).get("items") or [])]
        c.check("库里出现新工作流", "自测-快速" in names, f"items={names}")

        status, got = jget(base, f"/api/library/{lib_name}")
        c.check("GET 单条工作流含 graph", status == 200 and isinstance((got or {}).get("graph"), dict))

        status, _, _ = http("DELETE", f"{base}/api/library/{lib_name}")
        status2, lib3 = jget(base, "/api/library")
        c.check("DELETE 后工作流消失",
                status == 200 and not [i for i in ((lib3 or {}).get("items") or []) if i.get("name") == "自测-快速"])

        status, _, _ = http("PUT", f"{base}/api/library/{urllib.parse.quote('非法/名字')}", body={"graph": graph})
        c.check("非法库名被拒", status == 400, f"HTTP {status}")

        status, hist_bad = jget(base, "/api/history?limit=abc")
        c.check("非法 limit 不报 500",
                status == 200 and isinstance((hist_bad or {}).get("entries"), list), f"HTTP {status}")

        # ---------------- 4.5 上传（前端把图片节点改成 /api/view?type=input 依赖它） ----------------
        if not args.upload:
            c.skip("上传图片返回 name/subfolder/type", "加 --upload 才测（会在 ComfyUI input/ 留一个测试图）")
        else:
            png = base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            boundary = "----canvas-selftest-boundary"
            payload = b"".join([
                (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; '
                 f'filename="selftest-upload.png"\r\nContent-Type: image/png\r\n\r\n').encode("utf-8"),
                png,
                (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"'
                 f'\r\n\r\ntrue\r\n--{boundary}--\r\n').encode("utf-8"),
            ])
            status, _, raw = http_raw("POST", base + "/api/upload", payload,
                                      f"multipart/form-data; boundary={boundary}")
            up = {}
            try:
                up = json.loads(raw.decode("utf-8"))
            except Exception:  # noqa: BLE001
                pass
            c.check("上传图片返回 name/subfolder/type",
                    status == 200 and (up or {}).get("ok") is True and (up or {}).get("image"),
                    f"HTTP {status} image={up.get('image')} type={up.get('type')} sub={up.get('subfolder')!r}")
            if up.get("image"):
                qs = urllib.parse.urlencode({"filename": up["image"],
                                             "subfolder": up.get("subfolder", ""),
                                             "type": up.get("type") or "input"})
                status, headers, back = http("GET", f"{base}/api/view?{qs}")
                c.check("上传的图能按 type=input 取回",
                        status == 200 and back == png, f"HTTP {status} {len(back)}B")

        # ---------------- 5. 任务状态（依赖 ComfyUI） ----------------
        if comfy_up:
            status, job = jget(base, "/api/job?pid=selftest-no-such-prompt")
            c.check("未知 prompt_id 返回 unknown（供前端宽限后报丢失）",
                    status == 200 and (job or {}).get("status") == "unknown",
                    f"status={(job or {}).get('status')}")
            status, _, raw = http("GET", base + "/api/view?filename=no-such-file.png&type=output")
            c.check("不存在的产物返回错误而不是 200",
                    status in (400, 404, 500), f"HTTP {status}")

            # 真实跑一次：EmptyImage → SaveImage（不用任何模型，秒级完成）
            arts = []
            if args.no_run:
                c.skip("提交并完成一次真实任务", "--no-run")
            else:
                # 故意用非正方形的 96×48：出图尺寸要能原样回来（面板上选的尺寸就是靠这一条落地）
                mini = {
                    "1": {"class_type": "EmptyImage",
                          "inputs": {"width": 96, "height": 48, "batch_size": 1, "color": 331933}},
                    "2": {"class_type": "SaveImage",
                          "inputs": {"images": ["1", 0], "filename_prefix": "comfy-canvas/selftest"}},
                }
                status, run = jpost(base, "/api/run", {"graph": mini})
                submitted = status == 200 and (run or {}).get("ok") is True
                c.check("提交任务到 ComfyUI", submitted, f"pid={(run or {}).get('prompt_id')}")
                job = {}
                if submitted:
                    pid = (run or {}).get("prompt_id")
                    deadline = time.time() + 60
                    while time.time() < deadline:
                        _, job = jget(base, f"/api/job?pid={urllib.parse.quote(pid)}")
                        if (job or {}).get("status") in ("success", "error"):
                            break
                        time.sleep(0.5)
                    c.check("任务状态收敛到 success", (job or {}).get("status") == "success",
                            f"status={(job or {}).get('status')} err={(job or {}).get('error')}")
                    arts = (job or {}).get("artifacts") or []
                    c.check("取回图片产物",
                            any(a.get("kind") == "image" for a in arts),
                            f"artifacts={[a.get('filename') for a in arts]}")

            if arts:
                a = arts[0]
                qs = urllib.parse.urlencode({"filename": a["filename"],
                                             "subfolder": a.get("subfolder", ""),
                                             "type": a.get("type", "output")})
                status, headers, raw = http("GET", f"{base}/api/view?{qs}",
                                            headers={"Range": "bytes=0-99"})
                c.check("产物支持 Range(206) 透传",
                        status == 206 and len(raw) <= 100 and "Content-Range" in headers,
                        f"HTTP {status} {len(raw)}B {headers.get('Content-Range')}")
                status, headers, raw = http("GET", f"{base}/api/view?{qs}")
                c.check("产物完整取回 200",
                        status == 200 and len(raw) > 100 and headers.get("Accept-Ranges") == "bytes",
                        f"HTTP {status} {len(raw)}B")
                # 提交的宽高必须真的决定出图尺寸——不然「面板上选 1280×720、拿到 1024×1024」
                if raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR":
                    w = int.from_bytes(raw[16:20], "big")
                    h = int.from_bytes(raw[20:24], "big")
                    c.check("出图尺寸 = 提交的宽高", (w, h) == (96, 48), f"{w}×{h}")
                else:
                    c.skip("出图尺寸校验", "产物不是 PNG")

                # 资产管理：产物要能被 /api/assets 汇总出来（不扫目录、不复制文件，只从 history 里索引）
                status, lib = jget(base, "/api/assets?limit=200&refresh=1", timeout=40)
                items = (lib or {}).get("items") or []
                mine = [x for x in items if x.get("filename") == a["filename"]]
                c.check("资产接口把刚出的图列出来（source=output）",
                        status == 200 and bool(mine)
                        and mine[0].get("source") == "output"
                        and str(mine[0].get("url", "")).startswith("/api/view?"),
                        f"HTTP {status} items={len(items)} hit={bool(mine)}")
                # 列表要是「新的在前」：资产面板第一屏就该是最近那张，不用往下翻。
                # 反序的话，刚出的图会排在几十条历史的最末尾。
                pos = next((i for i, x in enumerate(items) if x.get("filename") == a["filename"]), -1)
                c.check("资产列表新的排前面（刚出的那张在前几条里）",
                        0 <= pos < 5, f"pos={pos} total={len(items)}")
            else:
                c.skip("产物 Range 透传", "没有可用产物")
        else:
            c.skip("任务状态接口", "ComfyUI 未连接")
            c.skip("提交并完成一次真实任务", "ComfyUI 未连接")
            c.skip("产物 Range 透传", "ComfyUI 未连接")

        # ---------------- 6. ComfyUI 不可达：要报清楚，而不是「含无法识别的节点」 ----------------
        dead_proc = None
        try:
            missing = free_port()
            dead_port = free_port()
            while dead_port == missing:
                dead_port = free_port()
            dead_base = f"http://127.0.0.1:{dead_port}"
            dead_proc = subprocess.Popen(
                [sys.executable, "-u", str(SERVER), "--port", str(dead_port),
                 "--no-browser", "--data", str(tmp / "data-dead"),
                 "--comfy", f"http://127.0.0.1:{missing}"],
                cwd=str(ROOT),
            )
            if wait_ready(dead_base, dead_proc, timeout=15):
                status, health3 = jget(dead_base, "/api/health")
                c.check("ComfyUI 不可达时 health 仍 200 且 comfy=false",
                        status == 200 and (health3 or {}).get("comfy") is False, f"HTTP {status}")
                status, ana = jpost(dead_base, "/api/analyze", {"graph": graph})
                err = str((ana or {}).get("error") or "")
                c.check("不可达时 analyze 报 502 且指向 object_info",
                        status == 502 and "object_info" in err, f"HTTP {status} err={err[:48]}")
                status2, _ = jpost(dead_base, "/api/analyze", {"graph": graph})
                c.check("失败结果不进缓存（第二次同样明确报错）", status2 == 502, f"HTTP {status2}")
                # 资产面板是「顺手用用」的功能：ComfyUI 挂了它必须退化成空列表 + comfy=false，
                # 而不是 500——否则前端一打开抽屉就弹错误，画布上的图也跟着看不见了。
                status, lib = jget(dead_base, "/api/assets?refresh=1")
                c.check("ComfyUI 不可达时资产接口退化成空列表（不 500）",
                        status == 200 and (lib or {}).get("comfy") is False
                        and (lib or {}).get("items") == [],
                        f"HTTP {status} comfy={(lib or {}).get('comfy')} err={str((lib or {}).get('error'))[:40]}")
            else:
                c.check("第二个实例（ComfyUI 指向死端口）能启动", False)
        finally:
            if dead_proc:
                dead_proc.terminate()
                try:
                    dead_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    dead_proc.kill()

        # ---------------- 7. 进程仍健康 ----------------
        status, health2 = jget(base, "/api/health")
        c.check("跑完全部用例后服务仍响应", status == 200 and (health2 or {}).get("ok") is True)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if args.keep:
            print(f"临时目录保留在: {tmp}")
        else:
            for _ in range(3):
                try:
                    shutil.rmtree(tmp)
                    break
                except OSError:
                    time.sleep(0.2)
            try:
                staging.rmdir()      # 空了就顺手收掉
            except OSError:
                pass

    return c.summary()


if __name__ == "__main__":
    sys.exit(main())
