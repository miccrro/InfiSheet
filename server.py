#!/usr/bin/env python3
"""Comfy 无限画布 · 本地服务

零依赖（Python 标准库）的本地服务，把浏览器画布接到本机 ComfyUI：
  * 静态页面 / 静态资源
  * ComfyUI 反向代理（绕开浏览器 CORS，前端同源调用）
  * API 图结构分析：自动识别文本 / 种子 / 数值 / 枚举 / 图片 插槽
  * 提交任务、轮询任务、取消任务、取回产物
  * 工作流库与画布文件的本地持久化

用法：
    python server.py                 # 默认 127.0.0.1:8788，自动打开浏览器
    python server.py --port 9000
    python server.py --comfy http://127.0.0.1:8188
    python server.py --data /tmp/canvas-data   # 换运行时数据目录（画布快照 + 工作流库）
    python selftest.py               # 回归自测：起临时实例、逐项断言、跑完即删

环境变量：COMFY_URL 覆盖 ComfyUI 地址。
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PRESETS = ROOT / "presets"
DATA = ROOT / "data"
LIBRARY = DATA / "library"

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")

# 输出类节点：从 /history 里取产物时用得上的节点类型
OUTPUT_TYPES = {
    "SaveImage", "PreviewImage", "SaveImageAdvanced", "SaveVideo", "PreviewVideo", "CreateVideo",
    "VHS_VideoCombine", "SaveAudio", "PreviewAudio", "SaveAnimatedWEBP",
}

_oi_cache: dict[str, dict] = {}
_oi_lock = threading.Lock()

# --------------------------------------------------------------------------- #
# 进度：后端订阅 ComfyUI 的 websocket（浏览器直连会被 ComfyUI 的 Origin 校验挡掉）
# --------------------------------------------------------------------------- #
PROGRESS: dict[str, int] = {}
PROGRESS_LOCK = threading.Lock()
_ws_started = False


def _ws_recv(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("websocket closed")
        buf += chunk
    return buf


def _ws_read_frame(sock: socket.socket) -> tuple[int, bytes]:
    b1, b2 = _ws_recv(sock, 2)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _ws_recv(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _ws_recv(sock, 8))[0]
    mask = _ws_recv(sock, 4) if masked else b""
    payload = _ws_recv(sock, length) if length else b""
    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return opcode, payload


def _ws_send(sock: socket.socket, opcode: int, data: bytes = b"") -> None:
    mask = os.urandom(4)
    header = bytes([0x80 | opcode])
    if len(data) < 126:
        header += bytes([0x80 | len(data)])
    elif len(data) < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", len(data))
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", len(data))
    sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def _ws_loop() -> None:
    while True:
        sock = None
        try:
            parsed = urllib.parse.urlparse(COMFY_URL)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or 80
            sock = socket.create_connection((host, port), timeout=10)
            key = base64.b64encode(os.urandom(16)).decode()
            sock.sendall(
                (f"GET /ws?clientId=canvas-progress HTTP/1.1\r\nHost: {host}:{port}\r\n"
                 "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                 f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode()
            )
            head = b""
            while b"\r\n\r\n" not in head:
                head += sock.recv(4096)
            if b" 101 " not in head.split(b"\r\n", 1)[0]:
                raise ConnectionError("websocket handshake failed")
            sock.settimeout(None)
            while True:
                opcode, data = _ws_read_frame(sock)
                if opcode == 8:
                    break
                if opcode == 9:
                    _ws_send(sock, 10, data)
                    continue
                if opcode != 1:
                    continue
                try:
                    msg = json.loads(data.decode("utf-8"))
                except Exception:
                    continue
                if msg.get("type") != "progress":
                    continue
                d = msg.get("data") or {}
                pid, value, total = d.get("prompt_id"), d.get("value"), d.get("max")
                if not pid or not isinstance(value, (int, float)) or not total:
                    continue
                pct = max(0, min(100, round(value / total * 100)))
                with PROGRESS_LOCK:
                    if len(PROGRESS) > 500:
                        PROGRESS.clear()
                    PROGRESS[pid] = pct
        except Exception:
            time.sleep(3)
        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
            time.sleep(1)


def start_progress_ws() -> None:
    global _ws_started
    if _ws_started:
        return
    _ws_started = True
    threading.Thread(target=_ws_loop, daemon=True).start()



# --------------------------------------------------------------------------- #
# ComfyUI 通信
# --------------------------------------------------------------------------- #
def comfy_request(method: str, path: str, body: bytes | None = None,
                  content_type: str = "application/json", timeout: float = 30.0,
                  headers: dict | None = None):
    """请求 ComfyUI，返回 (status, headers, bytes)。headers 用于透传 Range 等请求头。"""
    url = COMFY_URL + path
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", content_type)
    for key, val in (headers or {}).items():
        req.add_header(key, val)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()
    except Exception as exc:  # 网络层失败
        raise ConnectionError(f"无法连接 ComfyUI({COMFY_URL})：{exc}") from exc


def comfy_json(path: str, timeout: float = 30.0):
    status, _, raw = comfy_request("GET", path, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"ComfyUI {path} 返回 {status}")
    return json.loads(raw.decode("utf-8"))


def object_info(node_type: str):
    """按节点类型取 object_info。

    返回 {} 表示 ComfyUI 明确不认识这个节点；返回 None 表示这次没取到
    （ComfyUI 不可达/超时）——**失败不进缓存**，否则一次启动顺序不对就会
    把「读不到」永久记成「不认识」，之后所有工作流都报「含无法识别的节点」。
    """
    with _oi_lock:
        if node_type in _oi_cache:
            return _oi_cache[node_type]
    quoted = urllib.parse.quote(node_type, safe="")
    try:
        info = comfy_json(f"/object_info/{quoted}", timeout=60)
    except Exception:  # noqa: BLE001
        return None
    spec = info if node_type in info else {}
    with _oi_lock:
        _oi_cache[node_type] = spec
    return spec


def node_spec(node_type: str):
    """把 object_info 摊平成 {输入名: 规范}；None = 这次没取到（不是「没有输入」）。"""
    info = object_info(node_type)
    if info is None:
        return None
    if not info:
        return {}
    entry = next(iter(info.values()))
    spec: dict[str, list] = {}
    for section in ("required", "optional"):
        for name, decl in (entry.get("input", {}).get(section) or {}).items():
            if isinstance(decl, list) and decl:
                spec[name] = decl
    return spec


def is_link(value) -> bool:
    """API 图里 [源节点id, 输出槽位] 表示连线。"""
    return (isinstance(value, list) and len(value) == 2
            and isinstance(value[0], (str, int)) and isinstance(value[1], int))


# --------------------------------------------------------------------------- #
# ComfyUI 界面格式（nodes / links / widgets_values）→ API 图
# --------------------------------------------------------------------------- #
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
UI_SKIP_TYPES = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode"}
SEED_CONTROL = {"fixed", "increment", "decrement", "randomize"}


def _ui_links(workflow: dict) -> dict:
    out = {}
    for link in (workflow.get("links") or []):
        if isinstance(link, list) and len(link) >= 5:
            out[link[0]] = {"from": str(link[1]), "slot": int(link[2]),
                            "to": str(link[3]), "to_slot": int(link[4]),
                            "type": link[5] if len(link) > 5 else None}
        elif isinstance(link, dict) and link.get("id") is not None:
            out[link["id"]] = {"from": str(link.get("origin_id")), "slot": int(link.get("origin_slot") or 0),
                               "to": str(link.get("target_id")), "to_slot": int(link.get("target_slot") or 0),
                               "type": link.get("type")}
    return out


def _ui_source(links: dict, by_id: dict, link_id, depth: int = 0):
    """沿一条 link 找到真正的来源：可以是 [节点, 槽位]，也可以是直接值（PrimitiveNode）。"""
    if depth > 24:
        return None
    link = links.get(link_id)
    if not link:
        return None
    src = by_id.get(link["from"])
    if not src:
        return None
    stype = src.get("type") or ""
    if stype == "PrimitiveNode":
        vals = src.get("widgets_values") or []
        return {"value": vals[0]} if vals else None
    if stype == "Reroute":
        nxt = next((i for i in (src.get("inputs") or []) if isinstance(i, dict) and i.get("link") is not None), None)
        return _ui_source(links, by_id, nxt["link"], depth + 1) if nxt else None
    mode = src.get("mode") or 0
    if mode == 2:                      # Never：静音节点等于断开
        return None
    if mode == 4:                      # Bypass：同类型输入透传
        outs = src.get("outputs") or []
        out_type = outs[link["slot"]].get("type") if link["slot"] < len(outs) else link.get("type")
        for inp in (src.get("inputs") or []):
            if isinstance(inp, dict) and inp.get("link") is not None and inp.get("type") == out_type:
                return _ui_source(links, by_id, inp["link"], depth + 1)
        return None
    return {"id": link["from"], "slot": link["slot"]}


def _is_widget(decl) -> bool:
    if not decl:
        return False
    t = decl[0]
    return isinstance(t, list) or (isinstance(t, str) and t in WIDGET_TYPES)


def _ui_subdefs(workflow: dict) -> dict:
    return {str(s.get("id")): s for s in ((workflow.get("definitions") or {}).get("subgraphs") or [])
            if isinstance(s, dict)}


def flatten_ui(workflow: dict) -> dict:
    """Expand ComfyUI subgraphs into flat nodes/links (no subgraph instance nodes)."""
    subdefs = _ui_subdefs(workflow)
    if not subdefs:
        return workflow

    def norm(seq):
        out = []
        for item in seq or []:
            if isinstance(item, list) and len(item) >= 5:
                out.append({"id": item[0], "origin_id": item[1], "origin_slot": item[2],
                            "target_id": item[3], "target_slot": item[4],
                            "type": item[5] if len(item) > 5 else None})
            elif isinstance(item, dict):
                out.append(item)
        return out

    workflow = dict(workflow)
    workflow["links"] = norm(workflow.get("links"))
    subdefs = {k: dict(v) for k, v in subdefs.items()}
    for sub in subdefs.values():
        sub["links"] = norm(sub.get("links"))

    flat_nodes = []
    flat_links = []
    by_gid = {}
    counter = {"n": 0}

    def next_link_id():
        counter["n"] += 1
        return 900000 + counter["n"]

    def find_node(nodes, nid):
        for n in nodes:
            if str(n.get("id")) == str(nid):
                return n
        return None

    def resolve(nodes, links, ctx, prefix, origin_id, origin_slot):
        if str(origin_id) == "-10":
            return ctx.get(int(origin_slot or 0))
        node = find_node(nodes, origin_id)
        if node is None:
            return None
        if str(node.get("type")) in subdefs:
            return instance_output(nodes, links, ctx, prefix, node, int(origin_slot or 0))
        return (prefix + str(origin_id), int(origin_slot or 0))

    def instance_ctx(nodes, links, ctx, prefix, inst):
        out = {}
        for l in links:
            if str(l.get("target_id")) != str(inst.get("id")):
                continue
            ep = resolve(nodes, links, ctx, prefix, l.get("origin_id"), l.get("origin_slot"))
            if ep:
                out[int(l.get("target_slot") or 0)] = ep
        return out

    def instance_output(nodes, links, ctx, prefix, inst, slot):
        sub = subdefs.get(str(inst.get("type")))
        if not sub:
            return None
        gid = prefix + str(inst.get("id"))
        ictx = instance_ctx(nodes, links, ctx, prefix, inst)
        for l in sub.get("links") or []:
            if str(l.get("target_id")) == "-20" and int(l.get("target_slot") or 0) == slot:
                return resolve(sub.get("nodes") or [], sub.get("links") or [], ictx, gid + "/",
                               l.get("origin_id"), l.get("origin_slot"))
        return None

    def emit(nodes, links, ctx, prefix):
        for node in nodes:
            stype = str(node.get("type") or "")
            if not stype:
                continue
            if stype in subdefs:
                gid = prefix + str(node.get("id"))
                sub = subdefs[stype]
                emit(sub.get("nodes") or [], sub.get("links") or [],
                     instance_ctx(nodes, links, ctx, prefix, node), gid + "/")
                continue
            copy = dict(node)
            copy["id"] = prefix + str(node.get("id"))
            copy["inputs"] = [dict(i) for i in (node.get("inputs") or [])]
            flat_nodes.append(copy)
            by_gid[copy["id"]] = copy
        for l in links:
            if str(l.get("target_id")) == "-20":
                continue
            target = find_node(nodes, l.get("target_id"))
            if target is not None and str(target.get("type")) in subdefs:
                continue
            src = resolve(nodes, links, ctx, prefix, l.get("origin_id"), l.get("origin_slot"))
            if not src:
                continue
            lid = next_link_id()
            flat_links.append({"id": lid, "origin_id": src[0], "origin_slot": src[1],
                               "target_id": prefix + str(l.get("target_id")),
                               "target_slot": int(l.get("target_slot") or 0), "type": l.get("type")})
            tnode = by_gid.get(prefix + str(l.get("target_id")))
            if tnode:
                for inp in tnode.get("inputs") or []:
                    if inp.get("link") == l.get("id"):
                        inp["link"] = lid
                        break

    emit(workflow.get("nodes") or [], workflow.get("links") or [], {}, "")
    out = dict(workflow)
    out["nodes"] = flat_nodes
    out["links"] = flat_links
    out.pop("definitions", None)
    return out

def ui_to_api(workflow: dict) -> dict:
    if _ui_subdefs(workflow):
        workflow = flatten_ui(workflow)
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("不是 ComfyUI 界面格式（缺少 nodes 数组）")
    by_id = {}
    for n in nodes:
        if isinstance(n, dict) and n.get("id") is not None:
            by_id[str(n["id"])] = n
    links = _ui_links(workflow)
    graph: dict = {}

    for nid, node in by_id.items():
        ntype = node.get("type") or ""
        if not ntype or ntype in UI_SKIP_TYPES:
            continue
        mode = node.get("mode") or 0
        if mode in (2, 4):
            continue
        spec = node_spec(ntype)
        if spec is None:
            raise ValueError(f"连不上 ComfyUI，读不到节点定义：{ntype}")
        inputs: dict = {}
        linked = set()
        for inp in (node.get("inputs") or []):
            if not isinstance(inp, dict) or inp.get("link") is None:
                continue
            name = inp.get("name") or ""
            if not name:
                continue
            src = _ui_source(links, by_id, inp["link"])
            if src is None:
                continue
            linked.add(name)
            inputs[name] = src["value"] if "value" in src else [src["id"], src["slot"]]
        values = list(node.get("widgets_values") or [])
        vi = 0
        for name, decl in (spec or {}).items():
            if name in linked or name in SKIP_INPUTS or not _is_widget(decl):
                continue
            if vi >= len(values):
                break
            inputs[name] = values[vi]
            vi += 1
            # seed / noise_seed 后面跟着 control_after_generate（fixed / randomize ...），不是节点输入
            if decl[0] == "INT" and str(name).lower() in ("seed", "noise_seed"):
                if vi < len(values) and isinstance(values[vi], str) and values[vi] in SEED_CONTROL:
                    vi += 1
        meta = {"title": node.get("title") or ntype}
        graph[nid] = {"class_type": ntype, "inputs": inputs, "_meta": meta}
    if not graph:
        raise ValueError("这个工作流里没有可执行的节点")
    return graph


# --------------------------------------------------------------------------- #
# API 图分析：识别可编辑插槽与输出节点
# --------------------------------------------------------------------------- #
SKIP_INPUTS = {"filename_prefix"}

KIND_ORDER = {"image": 0, "text": 1, "seed": 2, "number": 3, "bool": 4, "select": 5}


def slot_sort_key(s: dict) -> tuple:
    """插槽排序：先按类型，再按节点，最后按输入名。

    两个坑：
    1) 节点 id 是字符串，"100" 会排在 "99" 前面——按数值比；
    2) 同一个编码器常同时有 prompt 与 negative_prompt，字母序前者在后，
       前端若无脑取 texts[0] 当正向提示词，用户的文案就被写进了负面提示词
       （Qwen-image-2.1 编辑流就是这种结构）。所以负面词的排位永远垫底。
    """
    node = s["node"]
    node_key = (0, int(node)) if str(node).isdigit() else (1, str(node))
    name = str(s["input"]).lower()
    neg = 1 if s["kind"] == "text" and ("negative" in name or name.startswith("neg")) else 0
    return (KIND_ORDER.get(s["kind"], 9), node_key, neg, s["input"])


def analyze_graph(graph: dict) -> dict:
    """分析 API 格式工作流，返回插槽与输出节点。"""
    slots: list[dict] = []
    outputs: list[dict] = []
    unknown_types: list[str] = []
    resolved = 0          # 成功拿到 object_info 的节点数
    unresolved = 0        # 这次没取到的节点数（ComfyUI 不可达）

    for node_id, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        inputs = node.get("inputs") or {}
        meta = node.get("_meta") or {}
        title = meta.get("title") or ct

        if ct in OUTPUT_TYPES:
            outputs.append({"node": node_id, "class_type": ct,
                            "title": title,
                            "prefix": str(inputs.get("filename_prefix") or "")})

        spec = node_spec(ct)
        if spec is None:
            unresolved += 1
            spec = {}
        else:
            resolved += 1
            if not spec and not ct.startswith(("Note", "MarkdownNote", "Reroute")):
                unknown_types.append(f"{node_id}:{ct}")

        for name, value in inputs.items():
            if is_link(value) or name in SKIP_INPUTS:
                continue
            decl = spec.get(name)
            if not decl:
                continue
            vtype = decl[0]
            slot = {
                "key": f"{node_id}.{name}",
                "node": node_id,
                "input": name,
                "class_type": ct,
                "node_title": title,
                "value": value,
            }
            # LoadImage.image 的枚举值其实就是可选图片文件名
            if ct == "LoadImage" and name == "image":
                slot["kind"] = "image"
            elif isinstance(vtype, list):
                slot["kind"] = "select"
                slot["options"] = [str(x) for x in vtype]
            elif vtype == "STRING":
                slot["kind"] = "text"
                if "text" in name.lower() or "prompt" in name.lower():
                    slot["multiline"] = True
            elif vtype == "INT":
                slot["kind"] = "seed" if "seed" in name.lower() else "number"
                slot["integer"] = True
            elif vtype == "FLOAT":
                slot["kind"] = "number"
            elif vtype == "BOOLEAN":
                slot["kind"] = "bool"
            else:
                continue  # 其余类型只能连线，不作为可编辑插槽

            cfg = decl[1] if len(decl) > 1 and isinstance(decl[1], dict) else {}
            for key in ("min", "max", "step"):
                if key in cfg:
                    slot[key] = cfg[key]
            if slot["kind"] in ("number", "seed"):
                if "min" not in slot and slot.get("integer"):
                    slot["min"] = 0
                if "max" not in slot:
                    slot["max"] = 4294967295 if slot.get("integer") else 1e9
            slots.append(slot)

    # 一个节点定义都没读到 → 不是「工作流有问题」，是 ComfyUI 没连上；
    # 这种情况直接报清楚，别让前端提示「含无法识别的节点」把人带到错的方向。
    if resolved == 0 and unresolved:
        raise ConnectionError("无法读取 ComfyUI 的节点定义（/object_info 请求失败）——确认 ComfyUI 正在运行后重试")

    slots.sort(key=slot_sort_key)
    return {
        "slots": slots,
        "outputs": outputs,
        "node_count": len(graph),
        "unknown_types": sorted(set(unknown_types)),
        "unresolved_nodes": unresolved,
    }


def collect_artifacts(entry: dict) -> list[dict]:
    """从 /history 条目里抽出产物文件列表。"""
    found: list[dict] = []
    for node_id, out in (entry.get("outputs") or {}).items():
        for key in ("images", "gifs", "videos", "audio", "files"):
            for item in out.get(key) or []:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                name = item["filename"]
                lower = name.lower()
                if lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp")):
                    kind = "image"
                elif lower.endswith((".mp4", ".webm", ".mkv", ".mov")):
                    kind = "video"
                elif lower.endswith((".wav", ".mp3", ".flac", ".ogg")):
                    kind = "audio"
                else:
                    kind = "file"
                item = dict(item)
                item.update({"kind": kind, "node": node_id, "source_key": key})
                found.append(item)
    return found


def history_summary(limit: int = 20) -> list[dict]:
    hist = comfy_json("/history", timeout=30)
    rows = []
    for prompt_id, entry in hist.items():
        prompt = entry.get("prompt")
        graph = None
        if isinstance(prompt, list) and len(prompt) > 2 and isinstance(prompt[2], dict):
            graph = prompt[2]
        rows.append({
            "prompt_id": prompt_id,
            "artifacts": collect_artifacts(entry),
            "status": (entry.get("status") or {}).get("status_str"),
            "has_graph": bool(graph),
            "node_count": len(graph) if graph else 0,
            "graph": graph,
        })
    rows.reverse()
    return rows[:limit]


# --------------------------------------------------------------------------- #
# 资产索引：不复制文件，只把 ComfyUI 里「已经产出过的」和「上传过的」图列出来
# --------------------------------------------------------------------------- #
ASSET_CACHE: dict = {"at": 0.0, "limit": 0, "items": [], "comfy": True, "error": None}
ASSET_TTL = 5.0          # 秒：连点刷新不该把 /history 打爆，5 秒内复用
ASSET_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")


def list_assets(limit: int = 400, force: bool = False) -> dict:
    """聚合 ComfyUI 历史里的产物 + LoadImage 引用过的上传图。

    为什么不扫目录：ComfyUI 不提供列目录的接口，而本项目的输出目录位置各人不同。
    /history 里恰好两种都有——outputs 是产物，prompt 图里 LoadImage.inputs.image 是上传素材。
    """
    global ASSET_CACHE
    now = time.time()
    if (not force) and ASSET_CACHE["items"] and now - ASSET_CACHE["at"] < ASSET_TTL \
            and ASSET_CACHE["limit"] >= limit:
        return {"ok": True, "items": ASSET_CACHE["items"][:limit], "comfy": ASSET_CACHE["comfy"],
                "cached": True, "error": ASSET_CACHE["error"]}
    try:
        hist = comfy_json(f"/history?max_items={max(limit, 100)}", timeout=30)
    except Exception as exc:  # noqa: BLE001
        ASSET_CACHE = {"at": now, "limit": limit, "items": [], "comfy": False, "error": str(exc)}
        return {"ok": True, "items": [], "comfy": False, "cached": False, "error": str(exc)}

    if not isinstance(hist, dict):
        hist = {}
    items: list[dict] = []
    seen: set = set()

    def push(entry: dict, *, source: str, filename: str, subfolder: str, atype: str) -> None:
        name = str(filename or "")
        if not name or not name.lower().endswith(ASSET_IMAGE_EXT):
            return
        key = (subfolder, name)
        if key in seen:
            return
        seen.add(key)
        items.append({
            "filename": name,
            "subfolder": subfolder,
            "type": atype,
            "source": source,                       # output=生成结果 / input=上传素材
            "url": "/api/view?" + urllib.parse.urlencode(
                {"filename": name, "subfolder": subfolder, "type": atype}),
        })

    # history 的条目顺序就是执行顺序（旧→新）。倒过来遍历，资产列表最前面就是最新那张。
    entries = list(hist.items())
    entries.reverse()
    for prompt_id, entry in entries:
        if not isinstance(entry, dict):
            continue
        for art in collect_artifacts(entry):
            if art.get("kind") != "image":
                continue
            push(entry, source="output", filename=art.get("filename"),
                 subfolder=art.get("subfolder") or "", atype=art.get("type") or "output")
        prompt = entry.get("prompt")
        graph = prompt[2] if isinstance(prompt, list) and len(prompt) > 2 and isinstance(prompt[2], dict) else None
        for node in (graph or {}).values():
            if not isinstance(node, dict) or node.get("class_type") != "LoadImage":
                continue
            name = (node.get("inputs") or {}).get("image")
            if isinstance(name, str):
                push(entry, source="input", filename=name, subfolder="", atype="input")

    ASSET_CACHE = {"at": now, "limit": limit, "items": items, "comfy": True, "error": None}
    return {"ok": True, "items": items[:limit], "comfy": True, "cached": False, "error": None}


# --------------------------------------------------------------------------- #
# HTTP 处理
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "ComfyCanvas/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- 基础输出 ----------
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, val in (extra or {}).items():
            self.send_header(key, val)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json_out(self, payload, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def fail(self, message: str, status: int = 400, extra: dict | None = None):
        payload = {"ok": False, "error": message}
        if extra:
            payload.update(extra)
        self.json_out(payload, status)

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self._body_read = True
        return raw

    def drain_body(self) -> None:
        """没读完的请求体必须丢掉：否则 keep-alive 的下一个请求会被 http.server 当成
        「body + 请求行」，直接 400 Bad request syntax（新增预设时控制台里那种报错）。"""
        if getattr(self, "_body_read", False):
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        if length > 0:
            try:
                self.rfile.read(min(length, 64 * 1024 * 1024))
            except Exception:
                pass
        self._body_read = True

    def read_json(self, limit: int = 64 * 1024 * 1024):
        raw = self.read_body()
        if not raw:
            return None
        if len(raw) > limit:
            raise ValueError("请求体过大")
        return json.loads(raw.decode("utf-8"))

    def log_message(self, fmt, *args):  # 安静一点
        if os.environ.get("CANVAS_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- 路由 ----------
    def do_GET(self):
        self._body_read = False
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                return self.api_get(path, query)
            return self.serve_static(path)
        except ConnectionError as exc:
            return self.fail(str(exc), 502)
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)

    def do_POST(self):
        self._body_read = False
        parsed = urllib.parse.urlparse(self.path)
        try:
            return self.api_post(parsed.path)
        except ConnectionError as exc:
            return self.fail(str(exc), 502)
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)

    def do_PUT(self):
        self._body_read = False
        try:
            return self.api_put(urllib.parse.urlparse(self.path).path)
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)

    def do_DELETE(self):
        self._body_read = False
        try:
            return self.api_delete(urllib.parse.urlparse(self.path).path)
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)

    # ---------- 静态文件 ----------
    def serve_static(self, path: str):
        if path.startswith("/presets/"):
            name = urllib.parse.unquote(path[len("/presets/"):])
            target = (PRESETS / name).resolve()
            if PRESETS not in target.parents or not target.is_file():
                return self.fail("预设不存在", 404)
            self._send(200, target.read_bytes(), "application/json; charset=utf-8")
            return
        rel = path.lstrip("/") or "index.html"
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents and target != STATIC:
            return self.fail("路径非法", 403)
        if target.is_dir():
            target = target / "index.html"
        if not target.exists():
            return self.fail("页面不存在", 404)
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ---------- GET 接口 ----------
    def api_get(self, path: str, query: dict):
        if path == "/api/health":
            out = {"ok": True, "comfy_url": COMFY_URL,
                   "features": ["presets", "projects", "canvas_history", "ui_import"]}
            try:
                stats = comfy_json("/system_stats", timeout=10)
                queue = comfy_json("/queue", timeout=10)
                sysinfo = stats.get("system") or {}
                out.update({
                    "comfy": True,
                    "version": sysinfo.get("comfyui_version"),
                    "os": sysinfo.get("os"),
                    "ram_total": sysinfo.get("ram_total"),
                    "ram_free": sysinfo.get("ram_free"),
                    "running": len(queue.get("queue_running") or []),
                    "pending": len(queue.get("queue_pending") or []),
                    "devices": stats.get("devices"),
                })
            except Exception as exc:  # noqa: BLE001
                out.update({"comfy": False, "error": str(exc)})
            return self.json_out(out)

        if path.startswith("/api/models/"):
            folder = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[a-z0-9_]+", folder):
                return self.fail("目录名非法", 400)
            return self.json_out({"ok": True, "folder": folder,
                                  "files": comfy_json(f"/models/{folder}", timeout=20)})

        if path == "/api/history":
            try:
                limit = max(1, min(200, int((query.get("limit") or ["20"])[0])))
            except (TypeError, ValueError):
                limit = 20                      # 传个 ?limit=abc 不该让整页 500
            return self.json_out({"ok": True, "entries": history_summary(limit)})

        if path == "/api/library":
            LIBRARY.mkdir(parents=True, exist_ok=True)
            items = []
            for f in sorted(LIBRARY.glob("*.json")):
                try:
                    g = json.loads(f.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    continue
                items.append({"name": f.stem, "nodes": len(g.get("graph") or {}),
                              "saved_at": g.get("saved_at"),
                              "kinds": graph_kinds(g.get("graph") or {})})
            return self.json_out({"ok": True, "items": items, "presets": list_presets()})

        if path.startswith("/api/library/"):
            name = urllib.parse.unquote(path.split("/api/library/", 1)[1])
            f = safe_library_path(name)
            if not f or not f.exists():
                return self.fail("工作流不存在", 404)
            return self.json_out(json.loads(f.read_text(encoding="utf-8")))

        if path == "/api/canvas":
            f = DATA / "canvas.json"
            if not f.exists():
                return self.json_out({"ok": True, "canvas": None})
            return self.json_out({"ok": True, "canvas": json.loads(f.read_text(encoding="utf-8-sig"))})

        if path == "/api/projects":
            return self.json_out({"ok": True, "items": list_projects()})

        if path.startswith("/api/projects/"):
            pid = urllib.parse.unquote(path.split("/api/projects/", 1)[1])
            if not PROJECT_ID_RE.fullmatch(pid):
                return self.fail("项目 id 非法", 400)
            f = DATA / "projects" / f"{pid}.json"
            if not f.exists():
                return self.fail("项目不存在", 404)
            return self.json_out({"ok": True, "id": pid, "canvas": json.loads(f.read_text(encoding="utf-8-sig"))})
        if path == "/api/canvas/history":
            return self.json_out({"ok": True, "items": list_canvas_history()})

        if path.startswith("/api/canvas/history/"):
            name = urllib.parse.unquote(path.split("/api/canvas/history/", 1)[1])
            f = safe_history_path(name)
            if not f or not f.exists():
                return self.fail("快照不存在", 404)
            return self.json_out({"ok": True, "canvas": json.loads(f.read_text(encoding="utf-8-sig"))})

        if path == "/api/job":
            pid = (query.get("pid") or [""])[0]
            if not pid:
                return self.fail("缺少 pid", 400)
            out = job_status(pid)
            with PROGRESS_LOCK:
                out["progress"] = PROGRESS.get(pid)
            return self.json_out(out)

        if path == "/api/assets":
            try:
                limit = int((query.get("limit") or ["400"])[0] or 400)
            except ValueError:
                limit = 400
            limit = max(1, min(limit, 2000))
            force = (query.get("refresh") or [""])[0] in ("1", "true", "yes")
            return self.json_out(list_assets(limit, force))

        if path == "/api/view":
            qs = urllib.parse.urlencode({k: v[0] for k, v in query.items()})
            # 透传 Range：视频节点靠它才能拖动进度条（ComfyUI 的 /view 支持 206）
            up_headers = {}
            if self.headers.get("Range"):
                up_headers["Range"] = self.headers["Range"]
            status, headers, raw = comfy_request("GET", f"/view?{qs}", timeout=120,
                                                 headers=up_headers)
            if status not in (200, 206):
                return self.fail(f"取回产物失败 {status}", status)
            ctype = headers.get("Content-Type") or "application/octet-stream"
            extra = {"Accept-Ranges": "bytes"}
            if headers.get("Content-Range"):
                extra["Content-Range"] = headers["Content-Range"]
            return self._send(status, raw, ctype, extra)

        self.drain_body()
        return self.fail("接口不存在", 404)

    # ---------- POST 接口 ----------
    def api_post(self, path: str):
        if path == "/api/presets":
            payload = self.read_json() or {}
            graph = payload.get("graph")
            if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
                try:
                    graph = ui_to_api(graph)
                except ValueError as exc:
                    return self.fail(str(exc), 400)
            if not isinstance(graph, dict) or not graph:
                return self.fail("缺少 API 图（graph）", 400)
            title = str(payload.get("title") or payload.get("name") or "新预设").strip()[:40] or "新预设"
            stem = re.sub(r"[^\w\u4e00-\u9fa5.-]+", "-", title).strip("-.") or "preset"
            PRESETS.mkdir(parents=True, exist_ok=True)
            f = PRESETS / f"{stem}.api.json"
            n = 2
            while f.exists():
                f = PRESETS / f"{stem}-{n}.api.json"
                n += 1
            data = {"title": title, "note": str(payload.get("note") or ""), "graph": graph}
            f.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.json_out({"ok": True, "file": f.name, "title": title})

        if path == "/api/analyze":
            payload = self.read_json() or {}
            graph = payload.get("graph") or {}
            # 从 ComfyUI 界面导出的 JSON 也能直接贴/拖进来：在这里转成 API 图
            if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
                try:
                    graph = ui_to_api(graph)
                except ValueError as exc:
                    return self.fail(str(exc), 400)
            if not isinstance(graph, dict) or not graph:
                return self.fail("缺少 API 图（graph）", 400)
            result = analyze_graph(graph)
            # 把转换后的 API 图一起回给前端：界面格式导入时，前端手里那份还是
            # {nodes:[...], links:[...], widgets_values:[...]}，既不能当图提交，
            # 又会把导出者的整份 UI 数据（含残留的 widget 值）写进存档——数据残留的头号来路。
            result["graph"] = graph
            result["ok"] = True
            return self.json_out(result)

        if path == "/api/run":
            payload = self.read_json() or {}
            graph = payload.get("graph") or {}
            # 兜底：直接贴界面格式进来也能跑（否则 ComfyUI 只会回一句 node_errors）
            if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
                try:
                    graph = ui_to_api(graph)
                except ValueError as exc:
                    return self.fail(str(exc), 400)
            if not isinstance(graph, dict) or not graph:
                return self.fail("缺少 API 图（graph）", 400)
            client_id = payload.get("client_id") or str(uuid.uuid4())
            body = json.dumps({"prompt": graph, "client_id": client_id}).encode("utf-8")
            status, _, raw = comfy_request("POST", "/prompt", body)
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:  # noqa: BLE001
                data = {"raw": raw.decode("utf-8", "replace")}
            if status != 200:
                return self.json_out({"ok": False, "status": status, "error": data}, 200)
            return self.json_out({"ok": True, "prompt_id": data.get("prompt_id"),
                                  "number": data.get("number"), "node_errors": data.get("node_errors")})

        if path == "/api/cancel":
            payload = self.read_json() or {}
            pid = payload.get("pid")
            body = json.dumps({"delete": [pid]} if pid else {}).encode("utf-8")
            comfy_request("POST", "/queue", body)
            if payload.get("interrupt"):
                comfy_request("POST", "/interrupt", b"{}")
            return self.json_out({"ok": True})

        if path == "/api/upload":
            raw = self.read_body()
            ctype = self.headers.get("Content-Type") or "multipart/form-data"
            status, _, resp = comfy_request("POST", "/upload/image", raw, content_type=ctype,
                                            timeout=120)
            if status != 200:
                return self.fail(f"上传失败 {status}: {resp[:200].decode('utf-8', 'replace')}", 400)
            data = json.loads(resp.decode("utf-8"))
            # 把 subfolder/type 一并回给前端：它据此把节点图片换成 /api/view?type=input，
            # 快照里就不用塞 base64（否则 localStorage 几张图就超配额）
            return self.json_out({"ok": True, "image": data.get("name"),
                                  "subfolder": data.get("subfolder") or "",
                                  "type": data.get("type") or "input", "raw": data})

        if path == "/api/projects":
            payload = self.read_json() or {}
            name = str(payload.get("name") or "未命名画布")[:40]
            pid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
            canvas = {"version": 2, "name": name, "nodes": [], "links": [], "groups": [],
                      "view": {"x": 140, "y": 120, "k": 0.85}, "savedAt": int(time.time() * 1000)}
            projects_dir()
            (DATA / "projects" / f"{pid}.json").write_text(
                json.dumps(canvas, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.json_out({"ok": True, "id": pid, "canvas": canvas})

        if path.startswith("/api/projects/"):
            pid = urllib.parse.unquote(path.split("/api/projects/", 1)[1])
            if not PROJECT_ID_RE.fullmatch(pid):
                return self.fail("项目 id 非法", 400)
            payload = self.read_json() or {}
            canvas = payload.get("canvas")
            if not isinstance(canvas, dict):
                return self.fail("canvas 必须是对象", 400)
            canvas["savedAt"] = int(time.time() * 1000)
            projects_dir()
            (DATA / "projects" / f"{pid}.json").write_text(
                json.dumps(canvas, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.json_out({"ok": True, "id": pid})
        if path == "/api/canvas":
            payload = self.read_json() or {}
            canvas = payload.get("canvas")
            # 空 body / 非对象不能把存档覆盖成 null —— 那等于无声删掉用户画布
            if not isinstance(canvas, dict):
                return self.fail("canvas 必须是对象", 400)
            DATA.mkdir(parents=True, exist_ok=True)
            target = DATA / "canvas.json"
            # 写保护：更早启动的会话不允许覆盖更新的存档（旧标签页退出时会带着旧状态回来）
            if isinstance(canvas, dict) and target.exists():
                try:
                    current = json.loads(target.read_text(encoding="utf-8-sig"))
                except Exception:
                    current = None
                if isinstance(current, dict):
                    incoming_boot = canvas.get("bootAt") or 0
                    last_boot = current.get("lastBootAt") or 0
                    if incoming_boot and last_boot and incoming_boot < last_boot:
                        return self.json_out({"ok": True, "stale": True})
            if isinstance(canvas, dict):
                canvas["lastBootAt"] = max(canvas.get("bootAt") or 0,
                                            canvas.get("lastBootAt") or 0)
            if target.exists():
                archive_canvas(target)
            target.write_text(json.dumps(canvas, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.json_out({"ok": True})

        self.drain_body()
        return self.fail("接口不存在", 404)

    # ---------- PUT / DELETE：工作流库 ----------
    def api_put(self, path: str):
        if not path.startswith("/api/library/"):
            self.drain_body()
            return self.fail("接口不存在", 404)
        name = urllib.parse.unquote(path.split("/api/library/", 1)[1])
        f = safe_library_path(name)
        if not f:
            return self.fail("名称非法", 400)
        payload = self.read_json() or {}
        graph = payload.get("graph")
        if not isinstance(graph, dict) or not graph:
            return self.fail("缺少 API 图", 400)
        LIBRARY.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"name": name, "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                                 "graph": graph}, ensure_ascii=False, indent=1), encoding="utf-8")
        return self.json_out({"ok": True, "name": name})

    def api_delete(self, path: str):
        if path.startswith("/api/presets/"):
            name = urllib.parse.unquote(path.split("/api/presets/", 1)[1])
            if not re.fullmatch(r"[\w\u4e00-\u9fa5 .\-]{1,120}\.json", name):
                return self.fail("预设名非法", 400)
            f = (PRESETS / name).resolve()
            if PRESETS.resolve() not in f.parents:
                return self.fail("路径非法", 403)
            if not f.is_file():
                return self.fail("预设不存在", 404)
            f.unlink()
            return self.json_out({"ok": True, "deleted": True})
        if path.startswith("/api/projects/"):
            pid = urllib.parse.unquote(path.split("/api/projects/", 1)[1])
            if not PROJECT_ID_RE.fullmatch(pid):
                return self.fail("项目 id 非法", 400)
            f = DATA / "projects" / f"{pid}.json"
            if f.exists():
                f.unlink()
            return self.json_out({"ok": True, "deleted": True})
        if path == "/api/canvas":
            f = DATA / "canvas.json"
            if f.exists():
                f.unlink()
            return self.json_out({"ok": True, "deleted": True})
        if not path.startswith("/api/library/"):
            self.drain_body()
            return self.fail("接口不存在", 404)
        name = urllib.parse.unquote(path.split("/api/library/", 1)[1])
        f = safe_library_path(name)
        if not f or not f.exists():
            return self.fail("工作流不存在", 404)
        f.unlink()
        return self.json_out({"ok": True})


HISTORY_LIMIT = 30          # 最多保留多少份画布快照
HISTORY_MIN_GAP = 60        # 两次归档至少间隔多少秒，避免每敲一个字就存一份


def history_dir() -> Path:
    d = DATA / "history"
    d.mkdir(parents=True, exist_ok=True)
    return d


def archive_canvas(target: Path) -> None:
    """覆盖 canvas.json 前，把旧版本归档一份（内容相同或离上次归档太近则跳过）。"""
    try:
        raw = target.read_bytes()
    except Exception:
        return
    try:
        json.loads(raw.decode("utf-8-sig"))
    except Exception:
        return
    hd = history_dir()
    files = sorted(hd.glob("*.json"))
    if files:
        try:
            if time.time() - files[-1].stat().st_mtime < HISTORY_MIN_GAP:
                return
        except Exception:
            pass
        # 和最近一份内容一致就不重复归档
        try:
            if files[-1].read_bytes() == raw:
                return
        except Exception:
            pass
    name = time.strftime("%Y%m%d-%H%M%S") + ".json"
    (hd / name).write_bytes(raw)
    files = sorted(hd.glob("*.json"))
    for old in files[:-HISTORY_LIMIT]:
        try:
            old.unlink()
        except Exception:
            pass


def list_canvas_history() -> list[dict]:
    hd = DATA / "history"
    out = []
    if not hd.exists():
        return out
    for f in sorted(hd.glob("*.json"), reverse=True):
        try:
            d = json.loads(f.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        out.append({
            "file": f.name,
            "name": d.get("name") or "未命名画布",
            "savedAt": d.get("savedAt") or 0,
            "nodes": len(d.get("nodes") or []),
            "links": len(d.get("links") or []),
            "mtime": int(f.stat().st_mtime),
        })
        if len(out) >= 60:
            break
    return out


def safe_history_path(name: str):
    if not name or not re.fullmatch(r"[0-9A-Za-z._-]{1,64}\.json", name):
        return None
    return (DATA / "history") / name

PROJECT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


def projects_dir() -> Path:
    d = DATA / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_legacy_project() -> None:
    """老版本只有一个 canvas.json：第一次列项目时把它变成 legacy 项目。"""
    pd = projects_dir()
    if any(pd.glob("*.json")):
        return
    legacy = DATA / "canvas.json"
    if not legacy.exists():
        return
    try:
        data = json.loads(legacy.read_text(encoding="utf-8-sig"))
    except Exception:
        return
    (pd / "legacy.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def list_projects() -> list[dict]:
    ensure_legacy_project()
    pd = DATA / "projects"
    out = []
    if not pd.exists():
        return out
    files = sorted(pd.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        out.append({
            "id": f.stem,
            "name": d.get("name") or "未命名画布",
            "nodes": len(d.get("nodes") or []),
            "links": len(d.get("links") or []),
            "savedAt": d.get("savedAt") or 0,
            "mtime": int(f.stat().st_mtime),
        })
        if len(out) >= 30:
            break
    return out

def safe_library_path(name: str):
    name = (name or "").strip()
    if not name or not re.fullmatch(r"[\w\u4e00-\u9fa5 .\-]{1,80}", name):
        return None
    return LIBRARY / f"{name}.json"


def graph_kinds(graph: dict) -> list[str]:
    """从 API 图推断该工作流能产出哪些媒体类型。"""
    kinds: set[str] = set()
    for node in (graph or {}).values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        if ct in {"SaveImage", "PreviewImage", "SaveImageAdvanced"}:
            kinds.add("image")
        elif ct in {"SaveVideo", "PreviewVideo", "CreateVideo", "VHS_VideoCombine", "SaveAnimatedWEBP"}:
            kinds.add("video")
        elif ct in {"SaveAudio", "PreviewAudio"}:
            kinds.add("audio")
    return sorted(kinds)


def list_presets() -> list[dict]:
    PRESETS.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(PRESETS.glob("*.json")):
        try:
            g = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        out.append({"name": f.stem, "title": g.get("title") or f.stem,
                    "file": f.name, "nodes": len(g.get("graph") or {}),
                    "kinds": graph_kinds(g.get("graph") or {})})
    return out


def job_status(pid: str) -> dict:
    """合并 /history 与 /queue 判断任务状态。"""
    hist = comfy_json(f"/history/{urllib.parse.quote(pid)}", timeout=20)
    entry = hist.get(pid)
    if entry:
        status = (entry.get("status") or {})
        completed = bool(status.get("completed"))
        artifacts = collect_artifacts(entry)
        messages = status.get("messages") or []
        error = None
        for msg in messages:
            if not isinstance(msg, list) or not msg:
                continue
            if msg[0] == "execution_error":
                detail = msg[1] if len(msg) > 1 else {}
                error = f"{detail.get('node_type')}：{detail.get('exception_message')}"
                break
            if msg[0] == "execution_interrupted":
                error = "任务已中断"
                break
        # 历史条目可能先落库、产物稍后才补齐：未经 completed 确认的一律按执行中处理。
        # 但 status_str=error 是明确的终止信号（中断/异常），继续报 running 会让前端永远转圈。
        if error is None and not completed:
            if (status.get("status_str") or "").lower() == "error":
                return {"ok": True, "status": "error", "completed": False,
                        "artifacts": artifacts, "error": "执行失败（ComfyUI 未给出详细原因）"}
            return {"ok": True, "status": "running", "artifacts": artifacts}
        return {"ok": True, "status": "success" if completed else (status.get("status_str") or "done"),
                "completed": completed, "artifacts": artifacts, "error": error}
    queue = comfy_json("/queue", timeout=15)
    running = [item[1] for item in queue.get("queue_running") or [] if len(item) > 1]
    pending = [item[1] for item in queue.get("queue_pending") or [] if len(item) > 1]
    if pid in running:
        return {"ok": True, "status": "running", "artifacts": []}
    if pid in pending:
        return {"ok": True, "status": "queued", "artifacts": []}
    return {"ok": True, "status": "unknown", "artifacts": []}


def main():
    parser = argparse.ArgumentParser(description="Comfy 无限画布本地服务")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--comfy", default=None, help="ComfyUI 地址，如 http://127.0.0.1:8188")
    parser.add_argument("--presets", default=None,
                        help="内置预设目录（默认 ./presets）；自测时指向临时目录，别污染真预设")
    parser.add_argument("--data", default=None,
                        help="运行时数据目录（默认 ./data）：画布快照与工作流库都放这里，便于多实例与自测")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    global COMFY_URL, DATA, LIBRARY, PRESETS
    if args.comfy:
        COMFY_URL = args.comfy.rstrip("/")
    if args.presets:
        PRESETS = Path(args.presets).expanduser().resolve()
    if args.data:
        DATA = Path(args.data).expanduser().resolve()
        LIBRARY = DATA / "library"
    DATA.mkdir(parents=True, exist_ok=True)
    LIBRARY.mkdir(parents=True, exist_ok=True)
    start_progress_ws()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Comfy 无限画布: {url}")
    print(f"ComfyUI:       {COMFY_URL}")
    print("Ctrl+C 退出")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
        httpd.server_close()


if __name__ == "__main__":
    main()
