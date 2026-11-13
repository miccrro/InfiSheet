#!/usr/bin/env python3
"""不依赖 ComfyUI、不开浏览器的冒烟测试。

起一个隔离实例（随机端口 + tests/.tmp 下的临时 data 目录），确认：
静态资源、健康检查、预设直链、目录穿越、项目 CRUD、未知路由 404。
CI 里跑这个就够；要连 ComfyUI 的完整回归用 `python selftest.py`，要浏览器交互用 `npm run test:e2e`。

    python tests/smoke.py [--keep]
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "tests" / ".tmp"
# 工作流样本（真机导出的 API 图）：e2e / mcp / smoke / selftest 共用这一份
FIXTURE_WF = ROOT / "tests" / "fixtures" / "workflows"

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


def skip(name: str, detail: str = "") -> None:
    """跑不了的检查要显式记账：默默少一条比红一条更难发现。"""
    global SKIP
    SKIP += 1
    print(f"SKIP  {name}" + (f"   [{detail}]" if detail else ""))


def _png(width: int, height: int, rgb=(40, 80, 120)) -> bytes:
    """纯标准库生成一张纯色 PNG：测缩略图用，不引入 PIL 依赖。"""
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def _jpeg_size(data: bytes):
    """从 JPEG 的 SOF 段里读宽高（只为断言缩略图真的缩了，不解像素）。"""
    import struct
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h = struct.unpack(">H", data[i + 5:i + 7])[0]
            w = struct.unpack(">H", data[i + 7:i + 9])[0]
            return (w, h)
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg = struct.unpack(">H", data[i + 2:i + 4])[0]
        i += 2 + seg
    return None


def local_ipv4() -> list[str]:
    """本机所有可用的非回环 IPv4，按「最像局域网」的顺序。

    三个来源叠加，因为没有一个能通吃：
    * `getaddrinfo(hostname)` —— macOS 上能拿到 en0 的地址（Linux 容器里也常是网卡地址）；
    * Linux 的 `SIOCGIFADDR` ioctl —— 容器里 hostname 解析不出东西时兜底；
    * 默认路由的源地址 —— 都没有时的最后一路。
    必须剔掉 198.18.0.0/15：开着 Clash/Surge 这类 TUN 代理时默认路由的源地址就落在这个
    假网段里，连过去会被代理接走，本机服务根本收不到请求（实测 macOS 上就是它）。
    回环地址也必须剔掉 —— 127.0.0.1 被服务端豁免，拿它测令牌门禁永远是 200。
    """
    found: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass

    if sys.platform.startswith("linux"):
        try:
            import fcntl
            import struct

            for _, name in socket.if_nameindex():
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                        packed = fcntl.ioctl(s.fileno(), 0x8915,  # SIOCGIFADDR（Linux）
                                             struct.pack("256s", name[:15].encode("utf-8")))
                except OSError:
                    continue                  # 没配 IPv4 的网卡（lo / docker 网桥）会在这里掉出去
                found.append(socket.inet_ntoa(packed[20:24]))
        except (ImportError, AttributeError, OSError):
            pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))       # 文档用地址，不会真的发包
            found.append(s.getsockname()[0])
    except OSError:
        pass

    bad = ("127.", "169.254.", "0.", "198.18.", "198.19.")
    out: list[str] = []
    for ip in found:                          # 去重但保序
        if ip not in out and not ip.startswith(bad):
            out.append(ip)
    return out


def http_call(host: str, port: int, path: str, headers: dict | None = None, method: str = "GET"):
    """直连、不跟随 302：令牌换 cookie 那一步要看 Location 和 Set-Cookie。"""
    import http.client

    conn = http.client.HTTPConnection(host, port, timeout=10)
    try:
        conn.request(method, path, headers=headers or {})
        res = conn.getresponse()
        return res.status, dict(res.getheaders()), res.read()
    finally:
        conn.close()


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
    # 工作流样本灌进临时 data 的 library：内置预设已整档删掉，工作流只剩「库」一个来源。
    # 灌的是临时目录，跑测试不会碰用户自己的 data/library/。
    lib_dir = data_dir / "library"
    lib_dir.mkdir(parents=True, exist_ok=True)
    for f in FIXTURE_WF.glob("*.json"):
        shutil.copy2(f, lib_dir / f.name)

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
            status == 200 and health.get("ok") is True
            and "wf_library" in (health.get("features") or []),
            f"comfy={health.get('comfy')}",
        )

        # 更新入口：版本号本地读、不联网；检查更新要打 GitHub，所以只断言「有结论、不 500」，
        # 不把测试绑在「当前这台机器有没有外网」上。
        pkg_ver = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version")
        status, raw = request(base, "/api/version")
        ver = json.loads(raw or b"{}")
        check("/api/version 报的版本和 package.json 一致（更新检查拿它比）",
              status == 200 and ver.get("version") == pkg_ver, f"{ver.get('version')} vs {pkg_ver}")
        status, raw = request(base, "/api/update/check")
        upd = json.loads(raw or b"{}")
        check("/api/update/check 没网/没发版也只是一句话（不 500，仍回 current）",
              status == 200 and upd.get("current") == pkg_ver
              and (upd.get("ok") is True or bool(upd.get("error"))),
              f"ok={upd.get('ok')} latest={upd.get('latest')} err={upd.get('error')}")

        for path, must in [
            ("/", "icons.js"),
            ("/app.js", "buildGenPanel"),
            ("/icons.js", "ICON_PATHS"),
            ("/style.css", "--canvas-bg"),
        ]:
            status, raw = request(base, path)
            text = raw.decode("utf-8", "replace")
            check(f"静态资源 {path}", status == 200 and must in text, f"{status} {len(raw)}B")

        # 报错定位：execution_error 要拆成「谁、在哪、什么错」。
        # 这一条只能直接调函数——造一个真会抛 execution_error 的图代价太大，
        # 而这里要验的正是「从报文到一句话」的那段拼装。
        sys.path.insert(0, str(ROOT))
        import server as _srv  # noqa: PLC0415  只有这一段需要 import 服务端模块

        _entry = {"prompt": [0, "pid", {"3": {"class_type": "LoadImage", "_meta": {"title": "加载图像"}}}]}
        _d = _srv.execution_error_detail(
            {"node_id": "3", "node_type": "LoadImage",
             "exception_message": "Invalid image file", "exception_type": "RuntimeError"}, _entry)
        check("execution_error 拆得出节点标题 + 节点号（不是只有 LoadImage）",
              _d.get("where") == "加载图像 · LoadImage（节点 3）"
              and _d.get("title") == "加载图像" and _d.get("message") == "Invalid image file",
              json.dumps(_d, ensure_ascii=False))
        _d2 = _srv.execution_error_detail({"node_id": "9", "node_type": "KSampler",
                                           "exception_message": "CUDA out of memory"}, {})
        check("拿不到节点标题时退回类型 + 节点号，不空着",
              _d2.get("where") == "KSampler（节点 9）" and _d2.get("summary").startswith("KSampler"),
              json.dumps(_d2, ensure_ascii=False))
        _d3 = _srv.execution_error_detail({}, {})
        check("报文什么都没有也说得出「某个节点 报错」，不是空串",
              _d3.get("where") == "某个节点" and "报错" in _d3.get("summary", ""),
              json.dumps(_d3, ensure_ascii=False))

        # 工作流的「吃不吃图」由服务端扫图给出，前端靠它挑工作流：
        # 按名字猜的时候选中过 Moss_图像编辑 —— 那是纯文生图，参考图根本没进图。
        status, raw = request(base, "/api/library")
        lib = json.loads(raw or b"{}")
        by_file = {p["file"]: p for p in (lib.get("items") or [])}
        check("工作流库是唯一来源：/api/library 只回 items，不再有 presets 字段",
              status == 200 and by_file and "presets" not in lib,
              f"{len(by_file)} 个工作流 · keys={sorted(lib)}")

        # 文件名从库里取，不写死：改过名的话写死会让这条断言整条红掉，看起来像功能坏了。
        txt2img = next((p for p in by_file.values() if p.get("category") == "txt2img"), None)
        if txt2img:
            status, raw = request(base, "/api/library/" + urllib.parse.quote(txt2img["name"]))
            graph = (json.loads(raw or b"{}") or {}).get("graph") or {}
            check("库里的工作流能按名字直接读出来",
                  status == 200 and isinstance(graph, dict) and len(graph) > 0,
                  f"{status} {len(graph)} 节点 {txt2img['name']}")
        else:
            check("库里的工作流能按名字直接读出来", False, "库里没有 txt2img 工作流")
        check("库接口给每个工作流标了 takes_image",
              status == 200 and all("takes_image" in p for p in by_file.values()),
              f"{len(by_file)} 个工作流")
        # 分类：每个入口按用途自动挑工作流，靠的就是这个字段
        cats = {p["category"] for p in by_file.values()}
        check("库接口给每个工作流标了分类（category + 中文名）",
              all(p.get("category") and p.get("category_label") for p in by_file.values()),
              ",".join(sorted(cats)))
        check("三个关键类别都有人（文生图 / 图生图 / 高清放大）",
              {"txt2img", "img2img", "upscale"} <= cats, ",".join(sorted(cats)))
        vosr = next((p for p in by_file.values() if "Vosr" in p["file"]), None)
        check("放大类工作流归到 upscale（高清按钮要挑它，挑成图生图只会重画）",
              vosr is not None and vosr["category"] == "upscale",
              vosr["category"] if vosr else "无")
        check("吃图但不放大的归到 img2img",
              all(p["category"] == "img2img" for p in by_file.values()
                  if p["takes_image"] and p["category"] not in ("upscale", "video", "audio")),
              "")

        moss = next((p for p in by_file.values() if "Moss" in p["file"]), None)
        check("纯文生图工作流如实报 takes_image=False（Moss 不能被当成图像编辑用）",
              moss is not None and moss["takes_image"] is False,
              json.dumps({k: moss.get(k) for k in ("title", "takes_image")} if moss else {}, ensure_ascii=False))

        status, _ = request(base, "/api/library/" + urllib.parse.quote("../server"))
        check("库路径穿越被挡", status in (400, 403, 404), f"HTTP {status}")

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

        # ---- 资产库：分组 / 移动 / 移除 ----
        # 这三样是纯本地用户数据（DATA/asset-lib.json），不碰 ComfyUI，所以 CI 里也能验。
        # 最要紧的一条：移除只写 hidden 标记，绝不删磁盘文件——资产是 ComfyUI 的产物，
        # 删了不可恢复，而用户点「删除」时想的多半只是「别在资产库里烦我」。
        status, raw = request(base, "/api/assets?limit=5")
        a0 = json.loads(raw or b"{}")
        check("资产接口带上分组表与归属表（前端合并画布图时要靠它查）",
              status == 200 and isinstance(a0.get("groups"), list) and isinstance(a0.get("meta"), dict),
              f"groups={len(a0.get('groups') or [])} comfy={a0.get('comfy')}")

        status, raw = request(base, "/api/assets/lib", "POST", {"op": "group-add", "name": "人像"})
        added = json.loads(raw or b"{}")
        gid = added.get("id") or ""
        check("新建分组", status == 200 and added.get("ok") is True
              and [g["name"] for g in (added.get("groups") or [])] == ["人像"], f"{gid}")

        status, _ = request(base, "/api/assets/lib", "POST", {"op": "group-add", "name": "人像"})
        check("同名分组拒绝（不然下拉里两个「人像」谁也分不清）", status == 400, f"HTTP {status}")

        # 键故意用两张不同来源的图：output 和 input 里可以有同名文件，
        # 只按文件名归组会把两张完全不同的图认成一张。
        k1, k2 = "output:/a.png", "input:/b.png"
        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "assign", "keys": [k1, k2], "group": gid})
        moved = json.loads(raw or b"{}")
        meta = moved.get("meta") or {}
        check("批量移动：两张都归到新分组",
              status == 200 and meta.get(k1, {}).get("group") == gid
              and meta.get(k2, {}).get("group") == gid,
              json.dumps(meta, ensure_ascii=False))

        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "hide", "keys": [k1], "hidden": True})
        hid = json.loads(raw or b"{}")
        check("移除只写 hidden 标记，分组还留着（恢复时能回到原位）",
              status == 200 and (hid.get("meta") or {}).get(k1) == {"group": gid, "hidden": True},
              json.dumps((hid.get("meta") or {}).get(k1), ensure_ascii=False))

        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "assign", "keys": [k1], "group": ""})
        ungroup = json.loads(raw or b"{}")
        check("移回未分组但仍是隐藏态（顺手把它复活是个坑）",
              (ungroup.get("meta") or {}).get(k1) == {"group": "", "hidden": True},
              json.dumps((ungroup.get("meta") or {}).get(k1), ensure_ascii=False))

        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "group-rename", "id": gid, "name": "人物"})
        renamed = json.loads(raw or b"{}")
        check("分组改名", status == 200
              and [g["name"] for g in (renamed.get("groups") or [])] == ["人物"], "")

        status, raw = request(base, "/api/assets/lib", "POST", {"op": "group-remove", "id": gid})
        gone = json.loads(raw or b"{}")
        gmeta = gone.get("meta") or {}
        check("删分组：组内资产回「未分组」，资产本身不丢",
              status == 200 and gone.get("groups") == [] and gmeta.get(k1, {}).get("group") == "",
              json.dumps(gmeta, ensure_ascii=False))
        check("既没分组也没隐藏的条目不留残渣（文件不会越用越大）", k2 not in gmeta, ",".join(gmeta))

        libfile = data_dir / "asset-lib.json"
        check("落盘到 asset-lib.json，且没留下 .tmp（原子写的副产物必须清掉）",
              libfile.is_file() and not (data_dir / "asset-lib.json.tmp").exists(), str(libfile))

        status, _ = request(base, "/api/assets/lib", "POST", {"op": "nope"})
        check("不认识的 op 回 400", status == 400, f"HTTP {status}")
        status, _ = request(base, "/api/assets/lib", "POST", {"op": "assign", "keys": [], "group": ""})
        check("空 keys 回 400（「没选中」不能被当成「全部」）", status == 400, f"HTTP {status}")

        # ---- 提示词预设：用户自己攒的常用提示词 ----
        # 存在 DATA/prompt-presets.json，和资产库分组分开：一个是图片归属，一个是文字片段。
        status, raw = request(base, "/api/prompts")
        check("预设列表一开始是空的", status == 200 and json.loads(raw or b"{}").get("items") == [],
              raw[:80].decode("utf-8", "replace"))
        status, raw = request(base, "/api/prompts", "POST",
                              {"op": "save", "name": "人像", "text": "柔和侧光，浅景深",
                               "html": "<div>柔和侧光，<b>浅景深</b></div>"})
        saved = json.loads(raw or b"{}")
        pid = (saved.get("item") or {}).get("id") or ""
        check("存一条预设：回 id、纯文本和 html 都在",
              status == 200 and pid and saved["item"]["text"] == "柔和侧光，浅景深"
              and "<b>" in saved["item"]["html"], json.dumps(saved, ensure_ascii=False)[:160])
        status, raw = request(base, "/api/prompts", "POST",
                              {"op": "save", "text": "  雨夜霓虹巷口  "})
        two = json.loads(raw or b"{}")
        check("不填名字就用前几个字当名字，且新的排最前",
              status == 200 and two["items"][0]["name"] == "雨夜霓虹巷口" and len(two["items"]) == 2,
              json.dumps([x["name"] for x in two.get("items", [])], ensure_ascii=False))
        status, _ = request(base, "/api/prompts", "POST", {"op": "save", "text": "   "})
        check("空提示词不许存（回 400）", status == 400, f"HTTP {status}")
        status, raw = request(base, "/api/prompts", "POST", {"op": "update", "id": pid, "name": "人像·柔光"})
        check("改名：按 id 改，别的字段不动",
              status == 200 and any(x["id"] == pid and x["name"] == "人像·柔光"
                                    and x["text"] == "柔和侧光，浅景深"
                                    for x in json.loads(raw or b"{}").get("items", [])),
              raw[:160].decode("utf-8", "replace"))
        pfile = data_dir / "prompt-presets.json"
        check("预设落盘到 prompt-presets.json，且没留下 .tmp",
              pfile.is_file() and not (data_dir / "prompt-presets.json.tmp").exists(), str(pfile))
        status, raw = request(base, "/api/prompts", "POST", {"op": "remove", "ids": [pid]})
        left = json.loads(raw or b"{}")
        check("删一条预设：只剩另一条",
              status == 200 and [x["name"] for x in left.get("items", [])] == ["雨夜霓虹巷口"],
              json.dumps(left, ensure_ascii=False)[:160])
        status, _ = request(base, "/api/prompts", "POST", {"op": "nope"})
        check("不认识的 op 回 400（预设）", status == 400, f"HTTP {status}")

        # ---- 首次使用引导：先确认生成的图存哪 ----
        # 只问一次：点过（setup_done）或库里已经有图（老用户）都不再弹。
        # 这一段必须在往资产库塞图**之前**跑，否则「空库要问」这个前提就没了。
        status, raw = request(base, "/api/setup")
        st0 = json.loads(raw or b"{}")
        check("空库第一次打开：要问一次「生成的图存哪」",
              status == 200 and st0.get("needsSetup") is True and st0.get("writable") is True,
              json.dumps(st0, ensure_ascii=False))
        check("引导里给出默认目录（数据目录下的 assets，测试实例隔离）",
              str(st0.get("defaultDir") or "").replace("\\", "/").endswith("/assets"),
              str(st0.get("defaultDir")))

        # ---- 资产库的目录：收进库 / 改名 / 删除 / 改路径 ----
        # 上面那些验的是「列表里的分组」，这一段验**磁盘**：库内文件就是目录里的文件，
        # 收进库是复制、改名是改文件名、删除是移进 .trash（不是 unlink）。
        # 所以断言直接看文件系统——列表对了但文件没动，等于没做。
        adir = data_dir / "assets"
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "group-add", "name": "素材"})
        g2 = (json.loads(raw or b"{}").get("id") or "")
        check("新建分组会在资产目录里建同名文件夹",
              status == 200 and (adir / "素材").is_dir(), str(adir / "素材"))

        # 画布上的图服务端看不见，收进库时由前端把字节带上来（这里模拟那段 base64）
        png = b"\x89PNG\r\n\x1a\n" + b"smoke-test-bytes"
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "import", "items": [
            {"key": "canvas:demo:1:0", "filename": "小图.png",
             "data": base64.b64encode(png).decode("ascii")}]})
        got = json.loads(raw or b"{}")
        check("收进库：把画布上的图复制进资产目录（磁盘上真有这个文件）",
              status == 200 and got.get("imported") == 1 and (adir / "小图.png").read_bytes() == png,
              f"imported={got.get('imported')} 目录={[p.name for p in adir.iterdir()] if adir.is_dir() else '无'}")

        status, raw = request(base, "/api/assets?limit=50")
        listed = json.loads(raw or b"{}")
        libs = [it for it in (listed.get("items") or []) if it.get("source") == "lib"]
        check("列表里出现库内文件：source=lib、key 以 lib: 开头、url 指向 /api/assets/file",
              len(libs) == 1 and libs[0]["key"].startswith("lib:")
              and libs[0]["url"].startswith("/api/assets/file?path="),
              json.dumps(libs[:1], ensure_ascii=False))

        status, raw = request(base, libs[0]["url"] if libs else "/api/assets/file?path=x")
        check("按 url 能把库内文件取回来（字节一致）", status == 200 and raw == png, f"HTTP {status} {len(raw)}B")

        status, _ = request(base, "/api/assets/file?path=" + urllib.parse.quote("../asset-lib.json"))
        check("目录穿越：拿不到资产目录之外的文件", status == 400, f"HTTP {status}")

        # ---- 缩略图：几百张原图滚不动，宫格改走 /api/thumb ----
        # 上面那张是 20 字节的假 PNG：PIL 打不开 → 必须**原样回退**，不能让格子空着
        status, raw = request(base, "/api/thumb?w=320&src="
                              + urllib.parse.quote(libs[0]["url"], safe=""))
        check("缩略图：缩不了的原样回退（不返回空 body）",
              status == 200 and raw == png, f"HTTP {status} {len(raw)}B")
        status, _ = request(base, "/api/thumb?w=320&src="
                            + urllib.parse.quote("http://example.com/x.png", safe=""))
        check("缩略图：只认自家两个图片入口（不做任意 URL 代理）", status == 400, f"HTTP {status}")

        big = _png(900, 600, (40, 80, 120))
        request(base, "/api/assets/lib", "POST", {"op": "import", "items": [
            {"key": "canvas:demo:2:0", "filename": "大图.png",
             "data": base64.b64encode(big).decode("ascii")}]})
        big_url = "/api/assets/file?path=" + urllib.parse.quote("大图.png")
        status, raw = request(base, "/api/thumb?w=320&src=" + urllib.parse.quote(big_url, safe=""))
        if raw[:2] == b"\xff\xd8":
            dim = _jpeg_size(raw)
            check("缩略图：900px 宽缩到 320（JPEG，按宽度等比）",
                  status == 200 and dim and dim[0] == 320 and dim[1] == 213,
                  f"HTTP {status} {len(raw)}B {dim}")
            check(f"缩略图比原图小（原图 {len(big)} B）", len(raw) < len(big), f"{len(raw)}B")
        else:
            skip("缩略图缩放", "这台机器的 Python 没装 PIL，服务端只回原图")
        # 这张只为缩略图而建，删掉——下面「改存放路径」那条断言的是「目录已经搬空」
        request(base, "/api/assets/lib", "POST", {"op": "delete", "keys": ["lib:大图.png"]})

        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "assign", "keys": [libs[0]["key"]], "group": g2})
        check("移动库内文件：真的搬到分组文件夹里（不是只改列表）",
              status == 200 and (adir / "素材" / "小图.png").is_file()
              and not (adir / "小图.png").exists(), str(adir / "素材"))

        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "rename", "key": "lib:素材/小图.png", "name": "封面"})
        rn = json.loads(raw or b"{}")
        check("改名：磁盘上的文件名跟着变，扩展名自动保留",
              status == 200 and (adir / "素材" / "封面.png").is_file() and rn.get("key") == "lib:素材/封面.png",
              json.dumps({k: rn.get(k) for k in ("key", "filename")}, ensure_ascii=False))

        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "delete", "keys": ["lib:素材/封面.png"]})
        dl = json.loads(raw or b"{}")
        check("删除库内文件：真删（进系统回收站），原位置不再有，也不留 .trash",
              status == 200 and dl.get("trashed") == 1 and not (adir / "素材" / "封面.png").exists()
              and not (adir / ".trash").exists(), json.dumps(dl, ensure_ascii=False))

        # 库外的图：没配 ComfyUI 目录时只从列表移除（绝不猜路径去删别人的产物）
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "delete", "keys": ["output:/x.png"]})
        d2 = json.loads(raw or b"{}")
        check("没配 ComfyUI 目录时，库外的图只写 hidden（trashed=0）",
              status == 200 and d2.get("trashed") == 0 and d2.get("hidden") == 1,
              json.dumps(d2, ensure_ascii=False))

        # 配了就能真删：按 <根>/output/... 拼出磁盘路径，进回收站
        fake_comfy = data_dir / "comfy"
        (fake_comfy / "output").mkdir(parents=True, exist_ok=True)
        (fake_comfy / "output" / "x.png").write_bytes(png)
        status, raw = request(base, "/api/assets/lib", "POST",
                              {"op": "comfy-dir", "path": str(fake_comfy / "output")})
        cd = json.loads(raw or b"{}")
        check("ComfyUI 目录：填 output/ 也能认，自动退到根目录",
              status == 200 and cd.get("comfyDir") == str(fake_comfy), json.dumps(cd, ensure_ascii=False))
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "delete", "keys": ["output:/x.png"]})
        d3 = json.loads(raw or b"{}")
        check("配了 ComfyUI 目录：库外的图也真删（磁盘上没了）",
              status == 200 and d3.get("trashed") == 1 and not (fake_comfy / "output" / "x.png").exists(),
              json.dumps(d3, ensure_ascii=False))

        newroot = data_dir / "pics"
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "root-set", "path": str(newroot)})
        rs = json.loads(raw or b"{}")
        check("改存放路径：文件搬到新目录，配置里记的是新路径",
              status == 200 and rs.get("moved") == 0 and newroot.is_dir()
              and json.loads((data_dir / "asset-lib.json").read_text(encoding="utf-8"))["root"] == str(newroot),
              json.dumps(rs, ensure_ascii=False))

        status, _ = request(base, "/api/assets/lib", "POST", {"op": "root-set", "path": "相对路径/assets"})
        check("改路径只收绝对路径（相对路径会跟着启动目录飘）", status == 400, f"HTTP {status}")

        # ---- 自动入库的命名与去重 ----
        # 每次生成完都自动存一份进库（时间+序号命名）。这里直接打 import 接口验两件事：
        # 同一批不能互相覆盖，同一个 ComfyUI 文件也不能存两遍。
        auto1 = b"\x89PNG\r\n\x1a\n" + b"auto-one"
        auto2 = b"\x89PNG\r\n\x1a\n" + b"auto-two"
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "import", "nameMode": "time", "items": [
            {"key": "output:/auto1.png", "filename": "auto1.png",
             "data": base64.b64encode(auto1).decode("ascii")},
            {"key": "output:/auto2.png", "filename": "auto2.png",
             "data": base64.b64encode(auto2).decode("ascii")}]})
        ti = json.loads(raw or b"{}")
        tnames = [s.get("name") or "" for s in (ti.get("saved") or [])]
        check("自动入库按「时间+序号」命名，同批两张不互相覆盖",
              status == 200 and ti.get("imported") == 2 and len(set(tnames)) == 2
              and all(re.fullmatch(r"\d{8}-\d{6}-\d{2}\.png", n) for n in tnames),
              ",".join(tnames) or "没存下来")

        status, raw = request(base, "/api/assets/lib", "POST", {"op": "import", "nameMode": "time", "items": [
            {"key": "output:/auto1.png", "filename": "auto1.png",
             "data": base64.b64encode(auto1).decode("ascii")}]})
        dup = json.loads(raw or b"{}")
        check("同一个 ComfyUI 文件重复入库不会再存一份（MCP 与浏览器都会触发，不去重会攒垃圾）",
              status == 200 and dup.get("imported") == 0
              and bool((dup.get("saved") or [{}])[0].get("dup")), json.dumps(dup, ensure_ascii=False))

        # 恢复默认：清空路径。改过一次自定义路径的人得有路可退，
        # 否则只能去数据目录里翻 asset-lib.json 手改。
        status, raw = request(base, "/api/assets/lib", "POST", {"op": "root-set", "path": ""})
        rd = json.loads(raw or b"{}")
        rd_root = json.loads((data_dir / "asset-lib.json").read_text(encoding="utf-8")).get("root")
        check("清空路径 = 恢复默认（配置里存空，不是写死一个绝对路径）",
              status == 200 and rd_root == "" and rd.get("root") == str(adir),
              f"root={rd_root!r} → {rd.get('root')}")

        # ---- 首次引导：有图就不再打扰 + 两个按钮都真的生效 ----
        status, raw = request(base, "/api/setup")
        st1 = json.loads(raw or b"{}")
        check("库里已经有图 = 老用户，即使没点过引导也不再弹",
              status == 200 and st1.get("needsSetup") is False and st1.get("setupDone") is False,
              json.dumps(st1, ensure_ascii=False))

        setup_dir = data_dir / "picked"
        status, raw = request(base, "/api/setup", "POST",
                              {"action": "set", "path": str(setup_dir)})
        st2 = json.loads(raw or b"{}")
        check("引导里「保存到这个目录」：目录生效且记下 setupDone",
              status == 200 and st2.get("setupDone") is True
              and st2.get("root") == str(setup_dir) and st2.get("rootDefault") is False
              and setup_dir.is_dir(), json.dumps(st2, ensure_ascii=False))

        status, raw = request(base, "/api/setup", "POST", {"action": "default"})
        st3 = json.loads(raw or b"{}")
        check("引导里「用默认」：回到默认目录",
              status == 200 and st3.get("rootDefault") is True
              and st3.get("root") == str(adir), json.dumps(st3, ensure_ascii=False))

        status, _ = request(base, "/api/setup", "POST", {"action": "nope"})
        check("引导只认两个按钮，别的 action 回 400", status == 400, f"HTTP {status}")

        # 可写性预检：目录能建不等于能写。Program Files / .app 包内 / 只读挂载都是这个毛病，
        # 得在设置的时候就拦住，别等用户生成完才发现图没存下。
        # 用「系统上一定写不进去的位置」验：Windows 给不存在的盘符，POSIX 给 /proc。
        sys.path.insert(0, str(ROOT))
        import server as _srv_setup

        def srv_probe(d):
            return _srv_setup.probe_dir_writable(d)[0]

        bad_dir = Path("Z:/infisheet-nope") if os.name == "nt" else Path("/proc/infisheet-nope")
        check("可写性预检：写得进去的目录判 True", srv_probe(adir) is True, str(adir))
        check("可写性预检：写不进去的目录判 False（不是等生成完才炸）",
              srv_probe(bad_dir) is False, str(bad_dir))

        # 默认路径跟着程序走，不是数据目录：整个文件夹拷到别的机器，图还在。
        # 用纯函数验（不动磁盘）：假造一个「程序装在 prog、旧数据目录不存在」的环境。
        sys.path.insert(0, str(ROOT))
        import server as _srv
        saved_globals = (_srv.DATA_EXPLICIT, _srv.ROOT, _srv.DATA)
        prog = data_dir / "prog"
        prog.mkdir(parents=True, exist_ok=True)
        try:
            _srv.DATA_EXPLICIT, _srv.ROOT, _srv.DATA = False, prog, data_dir / "nodata"
            dflt = _srv.asset_root_default()
        finally:
            _srv.DATA_EXPLICIT, _srv.ROOT, _srv.DATA = saved_globals
        check("默认存放路径在程序目录下的 assets/（不是平台数据目录）",
              dflt == prog / "assets", str(dflt))

        # 显式指定数据目录（INFISHEET_DATA / --data）时跟着数据目录走：
        # 测试、多实例、容器挂卷都靠这条，不然图会写到程序目录里去。
        try:
            _srv.DATA_EXPLICIT, _srv.ROOT, _srv.DATA = True, prog, data_dir / "portable"
            portable = _srv.asset_root_default()
        finally:
            _srv.DATA_EXPLICIT, _srv.ROOT, _srv.DATA = saved_globals
        check("显式指定数据目录时，资产库跟着数据目录走（测试/多实例不写脏程序目录）",
              portable == data_dir / "portable" / "assets", str(portable))

        # 文件坏了：留档后从空库开始，绝不覆盖——这个文件手改不回来
        libfile.write_text("{ broken", encoding="utf-8")
        status, raw = request(base, "/api/assets?limit=1")
        broken = json.loads(raw or b"{}")
        check("资产库文件坏了：留档 .bad-* 并空库启动，原文件不覆盖",
              status == 200 and broken.get("groups") == []
              and bool(list(data_dir.glob("asset-lib.json.bad-*"))), str(libfile))

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

        # ---- 进度兜底：读 ComfyUI 控制台日志里的 tqdm 行 ----
        # websocket 那条链路哑掉时只剩这条路。它必须分得清「这一单的 42%」和「上一单的
        # 100%」——日志是最近 300 条的环形缓冲，上一单跑完那行 100% 会一直躺在里面，
        # 不按提交时刻筛掉的话，新任务刚提交就会顶着 100% 一动不动。
        real_entries = srv._log_entries

        def _stamp(ts: float) -> str:
            return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) + ".000000"

        now = time.time()
        log = [
            {"t": _stamp(now - 600), "m": "\r100%|██████████| 25/25 [01:18<00:00,  3.13s/it]"},
            {"t": _stamp(now - 2), "m": "\r 42%|████      | 10/25 [00:12<00:18,  1.38s/it]"},
            {"t": _stamp(now - 1), "m": "[INFO] got prompt"},
        ]
        srv._log_entries = lambda: log
        srv.PROMPT_START["lg"] = now - 60
        srv.PROGRESS_LOG.clear()
        p_log = srv._log_progress("lg")
        check("进度兜底：日志里只认本单的 tqdm 行（上一单的 100% 不算）", p_log == 42, str(p_log))
        log.append({"t": _stamp(now), "m": "\r100%|██████████| 25/25 [02:22<00:00,  5.72s/it]"})
        p_log_full = srv._log_progress("lg")
        check("进度兜底：日志说 100% 也只报 99%（100% 留给「完成」那一刻）",
              p_log_full == 99, str(p_log_full))
        srv._log_entries = lambda: [{"t": _stamp(now - 600), "m": "100%|██| 25/25"}]
        check("进度兜底：日志里只有上一单的行就不给数字（宁可不显示，也不显示错的）",
              srv._log_progress("lg") is None, str(srv._log_progress("lg")))
        check("进度兜底：没记过提交时刻的 pid 直接跳过（没有起点就无从筛）",
              srv._log_progress("lg-nope") is None, "")
        srv._log_entries = real_entries
        srv.PROMPT_START.pop("lg", None)

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

        status, raw = request(base, f"/api/projects/{pid}/rename", "POST", {"name": "smoke 改名"})
        renamed = json.loads(raw or b"{}")
        check("重命名项目", status == 200 and renamed.get("name") == "smoke 改名", str(renamed.get("name")))

        # 封面：没图就没有封面；data: 图要落成文件再发地址（首页一次列 30 个项目，
        # 把 base64 直接塞进列表响应就是几十 MB）
        status, raw = request(base, f"/api/projects/{pid}/cover", "POST",
                              {"src": "data:image/png;base64,iVBORw0KGgo="})
        cover = json.loads(raw or b"{}")
        cover_url = cover.get("cover") or ""
        check("设置封面：回一个能直接 <img src> 的地址", status == 200 and "/cover?v=" in cover_url, cover_url)
        status, blob = request(base, cover_url)
        check("封面能取回来（PNG 魔数对得上）", status == 200 and (blob or b"")[:4] == b"\x89PNG",
              str(len(blob or b"")))

        status, _ = request(base, f"/api/projects/{pid}", "DELETE")
        check("删除项目", status == 200)
        check("删项目顺手删封面文件", not (data_dir / "covers" / f"{pid}.img").exists())

        status, raw = request(base, "/api/health")
        check("跑完仍健康", status == 200)

        # ---- 多平台：启动守卫 / 访问令牌 / 数据目录 ----
        # 这三块只有「开到局域网」或「程序放进只读目录」时才走到，上面那个主实例
        # （127.0.0.1 + --data）一条都碰不到。不测它们，README 的「多平台运行」就只是文档承诺。
        multi = TMP / f"multi-{int(time.time())}-{id(object()) % 1000}"
        multi.mkdir(parents=True, exist_ok=True)
        clean_env = {k: v for k, v in os.environ.items()
                     if k not in ("INFISHEET_TOKEN", "INFISHEET_DATA")}
        clean_env["INFISHEET_MCP_HOME"] = str(mcp_home)

        def free_port() -> int:
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                return s.getsockname()[1]

        def spawn(port_no: int, extra: list[str], env_extra: dict, quiet: bool = True):
            e = dict(clean_env)
            e.update(env_extra)
            return subprocess.Popen(
                [sys.executable, "-X", "utf8", "server.py", "--port", str(port_no), "--no-browser", *extra],
                cwd=str(ROOT),
                stdout=subprocess.DEVNULL if quiet else subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=e,
            )

        def stop(p) -> str:
            p.terminate()
            try:
                out, _ = p.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                out, _ = p.communicate()
            return out or ""

        # ① 监听 0.0.0.0 又没给令牌：必须拒绝启动，而不是「警告一句然后裸奔」
        guard = subprocess.run(
            [sys.executable, "-X", "utf8", "server.py", "--host", "0.0.0.0",
             "--port", str(free_port()), "--data", str(multi / "guard"), "--no-browser"],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
            timeout=30, env=clean_env,
        )
        check("没有令牌 + 监听 0.0.0.0 → 拒绝启动（退出码 2，不是警告后裸奔）",
              guard.returncode == 2 and "拒绝启动" in (guard.stdout or ""),
              f"exit={guard.returncode}")

        # ② 令牌 + 数据目录：一个实例同时验「环境变量里的令牌」和「INFISHEET_DATA」
        tok = "smoke-secret"
        env_data = multi / "env-data"
        tport = free_port()
        tproc = spawn(tport, ["--host", "0.0.0.0"],
                      {"INFISHEET_TOKEN": tok, "INFISHEET_DATA": str(env_data)})
        tbase = f"http://127.0.0.1:{tport}/"
        try:
            check("只给 INFISHEET_TOKEN 就能监听 0.0.0.0（不必再加 --yes-i-know）", wait_health(tbase))

            status, _ = request(tbase, "/api/projects")
            check("回环来源不带令牌也放行（127.0.0.1 豁免，stdio 桥靠它）", status == 200, f"HTTP {status}")

            status, raw = request(tbase, "/api/projects", "POST", {"name": "env 数据目录"})
            made = json.loads(raw or b"{}")
            check("INFISHEET_DATA 生效：项目落进环境变量指的目录",
                  status == 200 and (env_data / "projects" / f"{made.get('id')}.json").is_file(),
                  str(made.get("id")))

            # 非回环来源：真从本机的局域网地址连回来。127.0.0.1 永远被豁免，本地测不出门禁。
            lan, probe, why = None, None, "没有可用的非回环地址"
            for ip in local_ipv4():
                try:
                    probe = http_call(ip, tport, "/api/projects")
                except Exception as exc:  # noqa: BLE001 —— 连不上就换下一个地址
                    why = f"{ip}: {type(exc).__name__}"
                    continue
                lan = ip
                break

            names = [
                "非本机来源不带令牌 → 401（不是把画布直接给出去）",
                "错误的令牌同样 401",
                "?t=令牌 → 302 种 cookie，并跳回不带令牌的干净地址",
                "X-InfiSheet-Token 头 → 200",
                "cookie（infisheet_token）→ 200",
                "页面不带令牌 → 401 + 只要粘贴令牌的表单（不是白屏 403）",
            ]
            if not lan:
                for name in names:
                    skip(name, why)
            else:
                st, hs, body = probe
                check(names[0], st == 401 and b'"ok": false' in body, f"{lan} HTTP {st}")

                st, _, _ = http_call(lan, tport, "/api/projects?t=wrong")
                check(names[1], st == 401, f"HTTP {st}")

                st, hs, _ = http_call(lan, tport, "/api/projects?t=" + tok)
                check(names[2],
                      st == 302 and hs.get("Location") == "/api/projects"
                      and f"infisheet_token={tok}" in (hs.get("Set-Cookie") or ""),
                      f"HTTP {st} → {hs.get('Location')}")

                st, _, _ = http_call(lan, tport, "/api/projects", {"X-InfiSheet-Token": tok})
                check(names[3], st == 200, f"HTTP {st}")

                st, _, _ = http_call(lan, tport, "/api/projects", {"Cookie": f"infisheet_token={tok}"})
                check(names[4], st == 200, f"HTTP {st}")

                st, _, page = http_call(lan, tport, "/")
                text = page.decode("utf-8", "replace")
                check(names[5], st == 401 and "需要访问令牌" in text and "name='t'" in text, f"HTTP {st}")
        finally:
            stop(tproc)

        # ③ --data 优先于 INFISHEET_DATA；顺带验 --yes-i-know 这条「我知道会暴露」的逃生门
        dport = free_port()
        flag_data = multi / "flag-data"
        dproc = spawn(dport, ["--host", "0.0.0.0", "--yes-i-know", "--data", str(flag_data)],
                      {"INFISHEET_DATA": str(env_data)}, quiet=False)
        dbase = f"http://127.0.0.1:{dport}/"
        try:
            check("--yes-i-know：没令牌也允许监听 0.0.0.0（自担风险那条路）", wait_health(dbase))
            status, raw = request(dbase, "/api/projects", "POST", {"name": "flag 数据目录"})
            made = json.loads(raw or b"{}")
            check("--data 优先于 INFISHEET_DATA（项目只落一个目录）",
                  status == 200 and (flag_data / "projects" / f"{made.get('id')}.json").is_file()
                  and not (env_data / "projects" / f"{made.get('id')}.json").exists(),
                  str(made.get("id")))
        finally:
            banner = stop(dproc)
        warn = next((ln for ln in banner.splitlines() if "没有访问令牌" in ln), "")
        check("没令牌时启动横幅里写明「同网段都能访问」", bool(warn), warn.strip() or "无输出")

        # ④ 老版本的 canvas.json 只迁一次。
        #    以前每次列项目都问「projects/ 是不是空的」，于是最后一个项目删掉后，
        #    下一次列表又从 canvas.json 变出一个 legacy 来——用户看到的就是「这个项目删不掉」。
        ldata = multi / "legacy-data"
        (ldata / "projects").mkdir(parents=True, exist_ok=True)
        (ldata / "canvas.json").write_text(json.dumps(
            {"version": 2, "name": "老画布", "nodes": [], "links": []}, ensure_ascii=False), encoding="utf-8")
        lport = free_port()
        lproc = spawn(lport, ["--data", str(ldata)], {})
        lbase = f"http://127.0.0.1:{lport}/"
        try:
            check("老数据目录（只有 canvas.json）能起来", wait_health(lbase))
            _, raw = request(lbase, "/api/projects")
            ids = [it.get("id") for it in (json.loads(raw or b"{}").get("items") or [])]
            check("第一次列项目：canvas.json 变成 legacy 项目", ids == ["legacy"], str(ids))
            status, _ = request(lbase, "/api/projects/legacy", "DELETE")
            _, raw = request(lbase, "/api/projects")
            ids = [it.get("id") for it in (json.loads(raw or b"{}").get("items") or [])]
            check("删掉最后一个项目后不会从 canvas.json 复活（否则就是「删不掉」）",
                  status == 200 and ids == [], f"HTTP {status} · 还剩 {ids}")
        finally:
            stop(lproc)

        if not keep:
            import shutil as _sh

            _sh.rmtree(multi, ignore_errors=True)

        # ---- ComfyUI 地址：界面里能改，改完要存住 ----
        # 这是「换一台电脑就认不出 ComfyUI」的正面解：地址不该只藏在启动参数里。
        status, raw = request(base, "/api/comfy")
        info = json.loads(raw or b"{}")
        check("ComfyUI 连接状态：给当前地址 + 能不能连上",
              status == 200 and info.get("ok") is True and bool(info.get("url")) and "reachable" in info,
              f"{info.get('url')} reachable={info.get('reachable')}")

        status, raw = request(base, "/api/comfy", "POST", {"url": "ftp://127.0.0.1:8188"})
        check("非 http(s) 地址直接 400（不写进配置）", status == 400,
              json.loads(raw or b"{}").get("error", ""))

        status, raw = request(base, "/api/comfy", "POST", {"url": "127.0.0.1:8189"})
        saved = json.loads(raw or b"{}")
        check("手输 host:port 自动补 http://，连不上也照存（先配地址、再去开 ComfyUI）",
              status == 200 and saved.get("url") == "http://127.0.0.1:8189"
              and saved.get("saved") is True and saved.get("reachable") is False,
              str(saved.get("error", ""))[:60])
        try:
            on_disk = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            on_disk = {}
        check("地址落进 data/settings.json（不是只放在内存里）",
              on_disk.get("comfy_url") == "http://127.0.0.1:8189", str(on_disk))

        # 换个进程读同一个数据目录：证明是「存住了」，不是「这个进程还记得」
        rport = free_port()
        rproc = spawn(rport, ["--data", str(data_dir)], {})
        rbase = f"http://127.0.0.1:{rport}/"
        try:
            check("重启一个实例（同一数据目录）能起来", wait_health(rbase))
            status, raw = request(rbase, "/api/comfy")
            again = json.loads(raw or b"{}")
            check("重启后读到的还是上次保存的地址",
                  again.get("url") == "http://127.0.0.1:8189" and again.get("source") == "设置里保存的",
                  f"{again.get('url')} · {again.get('source')}")
        finally:
            stop(rproc)

        status, raw = request(base, "/api/comfy", "POST", {"url": ""})
        back = json.loads(raw or b"{}")
        fallback = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
        check("清空地址 = 回到启动时那一份（不会把服务卡在空地址上）",
              status == 200 and back.get("url") == fallback and back.get("saved") is False,
              back.get("url", ""))

        # ---- 代抓网页图片（/api/fetch-image）----
        # 网页上「复制图片」时剪贴板里只有一段 <img src>，画布读不到跨域像素，
        # 只能由服务端代抓一次。起一个本机小服务当「那个网页」。
        import http.server
        import threading

        class _Img(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 —— 基类规定的方法名
                blob = _png(4, 4) if self.path.startswith("/a.png") else b"not an image"
                ctype = "image/png" if self.path.startswith("/a.png") else "text/plain"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)

            def log_message(self, *args):   # 访问日志别刷进测试输出
                pass

        img_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Img)
        threading.Thread(target=img_srv.serve_forever, daemon=True).start()
        img_base = f"http://127.0.0.1:{img_srv.server_address[1]}"
        try:
            status, raw = request(base, "/api/fetch-image", "POST", {"url": img_base + "/a.png"})
            check("代抓图片：抓回来的是原样字节（不是 JSON 套 base64）",
                  status == 200 and raw == _png(4, 4), f"HTTP {status} · {len(raw or b'')} 字节")
            status, raw = request(base, "/api/fetch-image", "POST", {"url": img_base + "/note.txt"})
            err = json.loads(raw or b"{}").get("error", "")
            check("代抓图片：地址返回的不是图就拒掉", status == 400 and "不是图片" in err,
                  f"HTTP {status} · {err}")
            status, raw = request(base, "/api/fetch-image", "POST", {"url": "file:///etc/passwd"})
            err = json.loads(raw or b"{}").get("error", "")
            check("代抓图片：非 http(s) 直接拒（不让本机任意文件被读进画布）",
                  status == 400 and "http" in err, f"HTTP {status} · {err}")
        finally:
            img_srv.shutdown()

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
            shutil.rmtree(data_dir, ignore_errors=True)
        else:
            print(f"保留临时目录：{data_dir}")

    total = PASS + FAIL + SKIP
    print("-" * 60)
    print(f"共 {total} 项：通过 {PASS} · 跳过 {SKIP} · 失败 {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
