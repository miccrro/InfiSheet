#!/usr/bin/env python3
"""图片链路实测：对**正在跑的那个服务**（默认 8788）走一遍真实出图。

和别的测试不一样，它不自己起服务、也不隔离 data——测的就是你眼前这个环境：
真实 ComfyUI、真实项目目录。为了不碰你正在编辑的画布，它会**新建一个「图片测试」项目**
再动手（测完那个项目留着，想看就打开，想删就删）。

    python tests/images.py                 # 1k / 1 张
    python tests/images.py --size 2k --batch 2
    python tests/images.py --port 9000

验的是图片这条链路的每一环：
    add_image_node → run_node（真出图）→ /api/view 取字节 → 解出真实像素
    → 写回画布存档 → 生成历史 → （batch>1 时）多图不是同一张
尺寸不读面板上的值，从 PNG/JPEG 头里解——工作流可能不按面板尺寸出图。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 本机不走代理
BASE = "http://127.0.0.1:8788"
SID = {"v": ""}
RID = {"v": 0}
FAIL = []
TOTAL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global TOTAL
    TOTAL += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"   [{detail}]" if detail else ""))
    if not ok:
        FAIL.append(name)


def post(url: str, body, headers=None, timeout=900):
    data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with OPENER.open(req, timeout=timeout) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()


def get(url: str, timeout=30):
    try:
        with OPENER.open(url, timeout=timeout) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()


def rpc(method, params=None):
    RID["v"] += 1
    msg = {"jsonrpc": "2.0", "id": RID["v"], "method": method}
    if params is not None:
        msg["params"] = params
    st, h, raw = post(BASE + "/mcp", msg, {"Mcp-Session-Id": SID["v"]} if SID["v"] else None)
    sid = h.get("Mcp-Session-Id") or h.get("mcp-session-id")
    if sid:
        SID["v"] = sid
    return json.loads(raw.decode("utf-8")) if raw.strip() else {}


def tool(name, args=None):
    body = rpc("tools/call", {"name": name, "arguments": args or {}})
    res = body.get("result") or {}
    txt = "".join(p.get("text") or "" for p in (res.get("content") or []) if p.get("type") == "text")
    return txt, (res.get("structuredContent") or {}), bool(res.get("isError"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--size", default="1k")
    ap.add_argument("--batch", type=int, default=1)
    a = ap.parse_args()
    global BASE
    BASE = f"http://127.0.0.1:{a.port}"

    # ---------- 0. 服务与 ComfyUI ----------
    st, _h, raw = get(BASE + "/api/health")
    health = json.loads(raw.decode("utf-8"))
    check("服务在线", st == 200 and health.get("ok") is True, f"HTTP {st}")
    check("ComfyUI 在线（出图的前提）", health.get("comfy") is True,
          f"{health.get('version')} · 队列 {health.get('running')}/{health.get('pending')}")
    if not health.get("comfy"):
        print("\nComfyUI 没开，图片链路测不了。")
        return 1

    # ---------- 1. 握手 + 建测试项目 ----------
    rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "image-check", "version": "0"}})
    name = f"图片测试 {time.strftime('%H:%M:%S')}"
    txt, data, err = tool("create_project", {"name": name})
    pid = data.get("id") or ""
    check("建了独立测试项目（不碰你正在编辑的画布）", bool(pid) and not err, f"{pid} · {name}")

    # ---------- 2. 建图片节点 ----------
    prompt = "一只橘猫坐在窗台上，午后斜阳，胶片颗粒，浅景深"
    txt, data, err = tool("add_image_node", {
        "prompt": prompt, "aspect": "16:9", "size": a.size, "batch": a.batch,
    })
    node = data.get("node") or {}
    nid = node.get("id") or ""
    gen = node.get("gen") or {}
    check("图片节点建好，参数齐全", bool(nid) and not err,
          f"{nid} · {gen.get('aspect')} · {gen.get('size')} · {gen.get('batch')} 张 · {gen.get('wf')}")

    # ---------- 3. 真出图 ----------
    t0 = time.time()
    txt, data, err = tool("run_node", {"node": nid, "wait": True, "timeout_s": 300})
    cost = time.time() - t0
    images = data.get("images") or []
    first = images[0] if images else {}
    check("run_node 出图成功", (not err) and bool(images), (txt.splitlines() or [""])[0][:100])
    check("产物是 ComfyUI 的 /api/view 地址（不是 base64 塞进存档）",
          str(first.get("url") or "").startswith("/api/view?"), str(first.get("url"))[:80])
    if not images:
        return 1

    # ---------- 4. 图真的能取回来 ----------
    st, h, blob = get(BASE + first["url"])
    ctype = (h.get("Content-Type") or "").split(";")[0]
    check("取图 200 且是图片字节", st == 200 and ctype.startswith("image/") and len(blob) > 2000,
          f"HTTP {st} · {ctype} · {len(blob) // 1024} KB")

    # 从 PNG/JPEG 头里读真实像素，别信面板上填的值
    w = hgt = 0
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        w, hgt = int.from_bytes(blob[16:20], "big"), int.from_bytes(blob[20:24], "big")
    else:
        i = 2
        while i < len(blob) - 9:
            if blob[i] != 0xFF:
                i += 1
                continue
            marker = blob[i + 1]
            seg = int.from_bytes(blob[i + 2:i + 4], "big")
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                hgt = int.from_bytes(blob[i + 5:i + 7], "big")
                w = int.from_bytes(blob[i + 7:i + 9], "big")
                break
            i += 2 + seg
    check("图片能解码出真实像素", w > 0 and hgt > 0, f"{w} × {hgt}")
    check("16:9 的比例对得上（长边 1024/2048）", abs((w / hgt) - 16 / 9) < 0.02,
          f"{w}×{hgt} = {w / hgt:.3f}")
    check("长边等于所选清晰度的像素（1k=1024 / 2k=2048 / 4k=4096）",
          max(w, hgt) == {"1k": 1024, "2k": 2048, "4k": 4096}.get(a.size, max(w, hgt)),
          f"{a.size} → {max(w, hgt)}")

    # ---------- 5. 写回画布 / 生成历史 ----------
    st, _h, raw = get(BASE + f"/api/projects/{pid}")
    canvas = (json.loads(raw.decode("utf-8")) or {}).get("canvas") or {}
    row = next((n for n in (canvas.get("nodes") or []) if n.get("id") == nid), {})
    check("画布存档里这个节点已经有图（浏览器打开就能看到）",
          str(row.get("dataURL") or "").startswith("/api/view?"), str(row.get("dataURL"))[:60])

    txt, data, err = tool("list_runs", {"node": nid})
    runs = data.get("runs") or []
    check("生成历史留下一条（时间 / 种子 / 尺寸 / 产物）",
          bool(runs) and runs[0].get("seed") is not None and len(runs[0].get("items") or []) >= 1,
          f"{runs[0].get('w')}×{runs[0].get('h')} · seed={runs[0].get('seed')}" if runs else "空")

    # ---------- 6. 多图（batch）----------
    if a.batch > 1:
        check(f"batch={a.batch} 真的出了 {a.batch} 张", len(images) == a.batch,
              f"{len(images)} 张")
        urls = {i.get("url") for i in images}
        check("多张不是同一张（url 各不相同）", len(urls) == len(images), f"{len(urls)} 个不同地址")

    print("-" * 60)
    print(f"耗时 {cost:.1f}s · {w}×{hgt} · {len(images)} 张 · 项目 {pid}")
    print(f"共 {TOTAL} 项：通过 {TOTAL - len(FAIL)} · 失败 {len(FAIL)}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
