#!/usr/bin/env python3
"""MCP 接口回归：协议握手、工具清单、画布读写、rev 乐观锁、stdio 桥。

起一个隔离实例（随机端口 + tests/.tmp 下的临时 data），**不需要浏览器**。
需要 ComfyUI 的用例（真实出图）在 ComfyUI 不可达时跳过——不让 CI 因为
本地没开 ComfyUI 就红一片。

    python tests/mcp.py [--keep]
"""
from __future__ import annotations

import json
import os
import random
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "tests" / ".tmp"
sys.path.insert(0, str(ROOT))

PASS = 0
FAIL = 0
SKIP = 0

# 本机若配了 HTTP_PROXY（不少开发机都有），urllib 连 127.0.0.1 也会走代理，
# 代理一转手就变成 502 —— 这里的请求必须直连。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}" + (f"   [{detail}]" if detail else ""))
    else:
        FAIL += 1
        print(f"FAIL  {name}" + (f"   [{detail}]" if detail else ""))


def skip(name: str, why: str) -> None:
    global SKIP
    SKIP += 1
    print(f"SKIP  {name}   [{why}]")


def raw_post(url: str, body, headers: dict | None = None, timeout: float = 30.0):
    data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with OPENER.open(req, timeout=timeout) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()


def get_json(url: str, timeout: float = 20.0):
    try:
        with OPENER.open(url, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


class Client:
    def __init__(self, base: str):
        self.url = base.rstrip("/") + "/mcp"
        self.session = ""
        self.rid = 0

    def send(self, method, params=None, notify=False):
        self.rid += 1
        msg = {"jsonrpc": "2.0", "method": method}
        if not notify:
            msg["id"] = self.rid
        if params is not None:
            msg["params"] = params
        status, headers, raw = raw_post(self.url, msg, {"Mcp-Session-Id": self.session} if self.session else None)
        sid = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
        if sid:
            self.session = sid
        return status, headers, (json.loads(raw.decode("utf-8")) if raw.strip() else None)

    def call(self, method, params=None):
        _status, _h, body = self.send(method, params)
        return body or {}

    def tool(self, name, args=None):
        body = self.call("tools/call", {"name": name, "arguments": args or {}})
        res = body.get("result") or {}
        if "error" in body:
            return {"text": body["error"].get("message", ""), "isError": True}, {}
        txt = ""
        for part in res.get("content") or []:
            if part.get("type") == "text":
                txt += part.get("text") or ""
        return {"text": txt, "isError": bool(res.get("isError"))}, (res.get("structuredContent") or {})


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if get_json(url, timeout=1.5) is not None:
            return True
        time.sleep(0.15)
    return False


def comfy_online() -> bool:
    try:
        with OPENER.open("http://127.0.0.1:8188/system_stats", timeout=3) as res:
            return res.status == 200
    except Exception:  # noqa: BLE001
        return False


def check_placement() -> None:
    """新节点落在哪：纯函数，不需要服务。"""
    import mcp_server  # noqa: PLC0415 — 只为测 auto_pos，不 configure()

    # 空画布 + 用户把视图平移到了别处：新节点必须落在视口里，而不是跑到看不见的 (0,0)
    got = mcp_server.auto_pos({"nodes": [], "view": {"k": 1.2, "x": -154.8, "y": -1104.4}})
    check("空画布：新节点落在视口左上角附近（不是看不见的 0,0）", got == (189, 980), f"{got}")
    # 从没存过视图（全新画布）：视口当成从 (0,0) 开始，同样往里 60px
    got = mcp_server.auto_pos({"nodes": []})
    check("没有 view 时落在 (60,60)", got == (60, 60), f"{got}")
    # 有节点：还是往后排
    got = mcp_server.auto_pos({"nodes": [{"x": 100, "y": 40}, {"x": 600, "y": 20}]})
    check("有节点时排到最右边", got == (1040, 20), f"{got}")


def check_client_name() -> None:
    """「哪个应用接的」怎么定：纯函数，不需要服务。

    真实踩到的坑：WorkBuddy 传的 clientInfo 是 {"name": "infisheet", "version": "1.0.0"}——
    那是 mcp.json 里的**服务器别名**加一个占位版本，不是它自己。照抄就会在顶栏灯上
    写「MCP 已连接 · infisheet」，用户看到的其实是镜子里的我们。
    """
    import mcp_server  # noqa: PLC0415 — 只为测名字解析，不 configure()

    def reset(host=""):
        mcp_server._CONN.update({
            "connected": False, "live": False, "client": "", "clientVersion": "",
            "host": host, "clientSource": "", "protocol": "", "session": "",
            "at": 0.0, "last": 0.0, "calls": 0,
        })

    # ① 自报的名字就是我们自己 → 不采信，用宿主名
    reset("WorkBuddy")
    mcp_server._mark_connected({"name": "infisheet", "version": "1.0.0"}, "2025-06-18")
    check("客户端自报成服务器别名时不采信，改用拉起桥的应用名",
          mcp_server._CONN["client"] == "WorkBuddy"
          and mcp_server._CONN["clientSource"] == "host"
          and mcp_server._CONN["clientVersion"] == "",
          f"{mcp_server._CONN['client']} / {mcp_server._CONN['clientSource']}")

    # ② 自报的是真名字 → 尊重它，宿主名不该盖掉更具体的信息
    reset("WorkBuddy")
    mcp_server._mark_connected({"name": "Claude Code", "version": "1.2.3"}, "2025-06-18")
    check("客户端自报的是真应用名时，以它为准（宿主名不覆盖）",
          mcp_server._CONN["client"] == "Claude Code"
          and mcp_server._CONN["clientVersion"] == "1.2.3",
          f"{mcp_server._CONN['client']} {mcp_server._CONN['clientVersion']}")

    # ③ 只有头、没有握手（服务重启后的续接）：两个头分别单独生效
    reset()
    mcp_server.note_client("infisheet/1.0.0", "WorkBuddy")
    check("X-MCP-Host 能在自报名字不可用时顶上去",
          mcp_server._CONN["client"] == "WorkBuddy", mcp_server._CONN["client"])

    # ④ 连头都不全，只有一次 tools/call：也该说出是哪个应用，而不是「MCP 客户端」
    reset("WorkBuddy")
    mcp_server._touch()
    check("重启续接只剩一次工具调用时，也不会退化成「MCP 客户端」",
          mcp_server._CONN["connected"] and mcp_server._CONN["client"] == "WorkBuddy",
          mcp_server._CONN["client"])

    # ⑤ 拿不到宿主名、自报又不可用：宁可说「未命名」，也不能把我们自己当客户名
    reset()
    mcp_server._mark_connected({"name": "infisheet", "version": "1.0.0"}, "2025-06-18")
    check("拿不到宿主名时也不会把服务器名当成客户名",
          mcp_server._CONN["client"] == "未命名客户端", mcp_server._CONN["client"])

    # ⑥ 宿主名先占位、随后真名到达 → 升级更新
    reset()
    mcp_server.note_client("", "WorkBuddy")
    mcp_server.note_client("Claude Code/2.0")
    check("宿主名只是退路：之后拿到真名要换上去",
          mcp_server._CONN["client"] == "Claude Code", mcp_server._CONN["client"])

    reset()  # 别把测试状态漏给后面的用例


def check_lease() -> None:
    """租约的判定逻辑：纯函数，不需要服务。

    「断开」是个**没有事件**的状态——桥死了不会发告别消息，只能靠心跳停止来推。
    三条边界必须钉住：桥接入看租约、直连不误判、lease=0 能关掉这套判定。
    """
    import mcp_server  # noqa: PLC0415 — 只为测 status()，不 configure()

    now = time.time()
    mcp_server._CONN.update({
        "connected": True, "bridge": True, "lease": 30.0,
        "beat": now - 5, "at": now - 600, "last": now - 5,
        "client": "Probe", "host": "", "clientSource": "bridge",
    })
    s = mcp_server.status()
    check("桥接入：心跳在租约内 → alive", s["alive"] is True and s["stale"] == 0,
          f"alive={s['alive']} stale={s['stale']}")

    mcp_server._CONN["beat"] = now - 31
    s = mcp_server.status()
    check("桥接入：超过租约 → alive=False，但 connected 保留（连过是事实）",
          s["alive"] is False and s["connected"] is True and s["stale"] >= 30,
          f"alive={s['alive']} connected={s['connected']} stale={s['stale']}")

    mcp_server._CONN.update({"bridge": False, "beat": 0.0})
    check("直连（没有心跳通道）不按租约判死",
          mcp_server.status()["alive"] is True)

    mcp_server._CONN.update({"bridge": True, "lease": 0.0, "beat": now - 9999})
    check("lease=0 关闭租约：灯永不熄灭（老行为，出问题时的退路）",
          mcp_server.status()["alive"] is True)


def main() -> int:
    keep = "--keep" in sys.argv
    check_placement()
    check_client_name()
    check_lease()
    TMP.mkdir(parents=True, exist_ok=True)
    data_dir = TMP / f"mcp-{int(time.time())}-{id(object()) % 1000}"
    (data_dir / "projects").mkdir(parents=True, exist_ok=True)
    port = free_port()
    env = dict(os.environ)
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["no_proxy"] = "127.0.0.1,localhost"
    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", "server.py", "--port", str(port), "--data", str(data_dir),
         "--no-browser", "--mcp-lease", "2"],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        if not wait_http(base + "/api/projects"):
            print("FAIL  服务没起来（端口 %s）" % port)
            return 1

        c = Client(base)

        # ---------- 桥替客户端报名（顶栏要显示「哪个应用」） ----------
        # 只有 X-MCP-Host（自报名字完全没有）：宿主名必须能独立顶上。
        # 实测 WorkBuddy 的自报名是服务器别名 infisheet，这条头才是真正的应用名。
        raw_post(base + "/mcp",
                 {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                 {"X-MCP-Host": "WorkBuddy"})
        health_host = ((json.loads(OPENER.open(base + "/api/health", timeout=10).read().decode("utf-8"))
                        or {}).get("mcp") or {})
        check("X-MCP-Host 单独生效（客户端自报不可用时靠它）",
              health_host.get("client") == "WorkBuddy" and health_host.get("clientSource") == "host",
              f"{health_host.get('client')} / {health_host.get('clientSource')}")

        # stdio 桥把自己的 initialize clientInfo 记下来，之后每条转发都带 X-MCP-Client。
        # 服务重启后客户端不会重新握手，这条头是唯一的身份来源——所以它必须能独立生效。
        st, _h, _b = raw_post(base + "/mcp",
                              {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                              {"X-MCP-Client": "ProbeApp/9"})
        health0 = ((json.loads(OPENER.open(base + "/api/health", timeout=10).read().decode("utf-8"))
                    or {}).get("mcp") or {})
        check("X-MCP-Client 能当客户端名（重启后续接时唯一线索）",
              health0.get("client") == "ProbeApp", str(health0.get("client")))
        check("X-MCP-Client 里的版本也记下", health0.get("clientVersion") == "9",
              str(health0.get("clientVersion")))
        check("真名到达后把兜底的宿主名换掉", health0.get("clientSource") == "bridge",
              str(health0.get("clientSource")))

        # ---------- 协议 ----------
        st, headers, body = c.send("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "tests", "version": "0"},
        })
        res = (body or {}).get("result") or {}
        check("initialize 回显协议版本", res.get("protocolVersion") == "2025-06-18",
              str(res.get("protocolVersion")))
        check("initialize 发 Mcp-Session-Id", bool(headers.get("Mcp-Session-Id")),
              (headers.get("Mcp-Session-Id") or "")[:8])
        check("serverInfo 是本项目", (res.get("serverInfo") or {}).get("name") == "infisheet",
              str((res.get("serverInfo") or {}).get("name")))
        check("声明 tools 能力", "tools" in (res.get("capabilities") or {}))

        st, _h, payload = c.send("notifications/initialized", notify=True)
        check("通知（没有 id）回 202 且没有 body", st == 202 and not payload, f"HTTP {st}")

        # 顶栏那盏「MCP 已连接」小灯的数据源：health 必须把「谁接进来了」带出来。
        # 灯亮不亮只看这条，所以它错了等于指示灯在说谎。
        try:
            health = json.loads(OPENER.open(base + "/api/health", timeout=10).read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            health = {"error": str(exc)}
        mcp = health.get("mcp") or {}
        check("health 报告 MCP 已接入", mcp.get("connected") is True,
              json.dumps(mcp, ensure_ascii=False)[:120])
        check("health 带客户端名（顶栏提示要说清是谁）", mcp.get("client") == "tests",
              str(mcp.get("client")))
        check("health 带调用计数与连上时间", isinstance(mcp.get("calls"), int) and bool(mcp.get("at")),
              f"calls={mcp.get('calls')} at={mcp.get('at')}")
        check("health 的会话号与 initialize 那次一致（同一个客户端）",
              mcp.get("session") == headers.get("Mcp-Session-Id"),
              f"{str(mcp.get('session'))[:8]} / {str(headers.get('Mcp-Session-Id'))[:8]}")

        body = c.call("tools/list")
        tools = (body.get("result") or {}).get("tools") or []
        names = {t.get("name") for t in tools}
        check("tools/list 至少 20 个工具", len(tools) >= 20, f"{len(tools)} 个")
        need = {"infisheet_status", "get_canvas", "add_image_node", "set_generation",
                "connect_nodes", "run_node", "list_runs", "search_styles", "list_workflows"}
        check("关键工具都在", need <= names, "缺 " + "、".join(sorted(need - names)) if not need <= names else "")
        check("每个工具都有 object 型 inputSchema",
              all((t.get("inputSchema") or {}).get("type") == "object" and t.get("description")
                  for t in tools))

        body = c.call("no/such/method")
        check("未知方法回 -32601", (body.get("error") or {}).get("code") == -32601,
              str((body.get("error") or {}).get("code")))

        st, _h, raw = raw_post(c.url, b"{not json")
        err = json.loads(raw.decode("utf-8"))
        check("坏 JSON 回 -32700（不是 500 页面）", err.get("error", {}).get("code") == -32700,
              f"HTTP {st} · {err.get('error', {}).get('code')}")

        st, _h, _raw = raw_post(base + "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"})
        check("ping 正常返回", st == 200, f"HTTP {st}")

        # ---------- 心跳与断开（租约） ----------
        # 「断开」没法靠一次请求测出来：桥死了是**没有事件**。所以判据是租约——
        # 桥每 lease/3 秒敲一次 /api/mcp/heartbeat，停了就过期。这里把租约调到 2 秒，
        # 不用真等 30 秒。
        def mcp_health() -> dict:
            return (get_json(base + "/api/health") or {}).get("mcp") or {}

        hb = base + "/api/mcp/heartbeat"
        st, _h, raw = raw_post(hb, {}, {"X-MCP-Host": "ProbeHost"})
        beat0 = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        check("心跳接口回 200 并告知租约（桥据此算间隔）",
              st == 200 and beat0.get("lease") == 2, f"HTTP {st} · lease={beat0.get('lease')}")

        h1 = mcp_health()
        check("心跳之后 alive=True，并标记为「桥接入」（只有它判得了离线）",
              h1.get("alive") is True and h1.get("bridge") is True,
              f"alive={h1.get('alive')} bridge={h1.get('bridge')}")

        time.sleep(2.5)
        h2 = mcp_health()
        check("心跳停了超过租约：alive 变 False，但 connected 仍是 True（连过是事实）",
              h2.get("alive") is False and h2.get("connected") is True,
              f"alive={h2.get('alive')} connected={h2.get('connected')} stale={h2.get('stale')}")
        check("过期时长如实报出来（前端要写「心跳停了 Ns」）",
              float(h2.get("stale") or 0) >= 2, f"stale={h2.get('stale')}")

        raw_post(hb, {}, {"X-MCP-Host": "ProbeHost"})
        h3 = mcp_health()
        check("再来一次心跳就复活，不用重新握手", h3.get("alive") is True,
              f"alive={h3.get('alive')}")

        # ---------- 读：状态 / 工作流 / 风格 ----------
        out, data = c.tool("infisheet_status")
        check("status 报告 ComfyUI 状态", "ComfyUI" in out["text"] and not out["isError"],
              out["text"].splitlines()[-1])

        out, data = c.tool("list_workflows")
        presets = data.get("presets") or []
        check("工作流清单带 takes_image（遮罩功能已删，不该再有 takes_mask）",
              all("takes_image" in p for p in presets) and len(presets) >= 5
              and not any("takes_mask" in p for p in presets), f"{len(presets)} 个预设")

        out, data = c.tool("search_styles", {"query": "动漫", "limit": 5})
        items = data.get("items") or []
        check("风格检索能搜到「动漫」", bool(items) and all("name_cn" in i for i in items),
              (items[0]["name_cn"] if items else "空"))

        # ---------- 写：项目 / 节点 / 连线 ----------
        out, data = c.tool("create_project", {"name": "MCP 回归"})
        pid = data.get("id") or ""
        check("create_project 返回项目 id", bool(pid), pid)

        out, data = c.tool("add_text_node", {"text": "窗台上的猫，午后阳光"})
        tid = (data.get("node") or {}).get("id") or ""
        check("add_text_node 自动分配 id 与位置", tid.startswith("t") and isinstance(
            (data.get("node") or {}).get("x"), int), f"{tid} @ {data.get('node', {}).get('x')}")

        out, data = c.tool("add_image_node", {"prompt": "窗台上的猫", "aspect": "16:9", "size": "1k"})
        iid = (data.get("node") or {}).get("id") or ""
        wf = data.get("workflow") or ""
        node = data.get("node") or {}
        check("add_image_node 选了一个能吃图/能吃遮罩之外的工作流",
              iid.startswith("i") and bool(wf), f"{iid} · {wf}")
        check("图片节点默认参数齐全",
              all(k in (node.get("gen") or {}) for k in ("prompt", "wf", "aspect", "size", "batch", "runs")),
              json.dumps({k: node.get("gen", {}).get(k) for k in ("aspect", "size", "batch")},
                         ensure_ascii=False))

        out, data = c.tool("connect_nodes", {"from": tid, "to": iid})
        check("connect_nodes 连上文本→图片", not out["isError"], out["text"])

        out, data = c.tool("get_canvas")
        links = data.get("links") or []
        check("get_canvas 读回这条连线", len(links) == 1 and links[0].get("toKey") == "in",
              f"{len(links)} 条 · {links[0].get('from')}→{links[0].get('to')}" if links else "0 条")

        out, data = c.tool("set_generation", {
            "node": iid, "width": 96, "height": 48, "size": "custom",
            "batch": 2, "seed": 12345, "seed_mode": "fixed",
        })
        g = (data.get("node") or {}).get("gen") or {}
        check("set_generation 写入自定义尺寸 / 固定种子",
              g.get("size") == "custom" and (g.get("custom") or {}).get("w") == 96
              and g.get("seedMode") == "fixed" and g.get("batch") == 2,
              f"{g.get('size')} {g.get('custom')} · {g.get('seedMode')} · {g.get('batch')} 张")

        out, data = c.tool("add_image_node", {"prompt": "x", "size": "custom"})
        check("size=custom 缺宽高时如实报错", out["isError"] and "width" in out["text"], out["text"][:60])

        out, data = c.tool("run_node", {"node": tid})
        check("run_node 拒绝文本节点", out["isError"] and "图片节点" in out["text"], out["text"][:60])

        out, data = c.tool("get_node", {"node": "i999"})
        check("不存在的节点给可读错误", out["isError"] and "没有节点" in out["text"], out["text"][:40])

        # ---------- rev 乐观锁 ----------
        meta = get_json(base + f"/api/projects/{pid}?meta=1") or {}
        current = int(meta.get("rev") or 0)
        check("meta 接口给出 rev", current >= 4 and meta.get("lastWriter") == "mcp",
              f"rev {current} · by {meta.get('lastWriter')}")

        canvas = (get_json(base + f"/api/projects/{pid}") or {}).get("canvas") or {}
        st, _h, raw = raw_post(base + f"/api/projects/{pid}",
                              {"canvas": canvas, "baseRev": max(0, current - 1)})
        conflict = json.loads(raw.decode("utf-8"))
        check("旧 baseRev 保存被挡住（不覆盖 MCP 的改动）",
              conflict.get("stale") is True and conflict.get("rev") == current,
              f"stale={conflict.get('stale')} rev={conflict.get('rev')}")

        st, _h, raw = raw_post(base + f"/api/projects/{pid}", {"canvas": canvas, "baseRev": current})
        saved = json.loads(raw.decode("utf-8"))
        check("正确 baseRev 保存成功且 rev+1",
              saved.get("ok") and int(saved.get("rev") or 0) == current + 1,
              f"rev {saved.get('rev')}")

        meta2 = get_json(base + f"/api/projects/{pid}?meta=1") or {}
        check("浏览器保存后 lastWriter 记为 canvas", meta2.get("lastWriter") == "canvas",
              str(meta2.get("lastWriter")))

        out, data = c.tool("list_projects")
        check("list_projects 能看到这个项目",
              any(p.get("id") == pid for p in (data.get("items") or [])), out["text"].splitlines()[0])

        # ---------- stdio 桥 ----------
        lines = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "stdio", "version": "0"}}}, ensure_ascii=False)
        line2 = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, ensure_ascii=False)
        p = subprocess.Popen(
            [sys.executable, "-X", "utf8", "mcp_server.py", "--port", str(port), "--no-autostart"],
            cwd=str(ROOT), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", env=env,
        )
        out_txt, err_txt = p.communicate(lines + "\n" + line2 + "\n", timeout=90)
        rows = [json.loads(x) for x in out_txt.splitlines() if x.strip()]
        check("stdio 桥转发 initialize", len(rows) >= 1
              and (rows[0].get("result") or {}).get("serverInfo", {}).get("name") == "infisheet",
              f"{len(rows)} 行响应")
        check("stdio 桥带会话转发 tools/list", len(rows) >= 2
              and len((rows[1].get("result") or {}).get("tools") or []) >= 20,
              f"{len(rows)} 行")

        # ---------- 需要 ComfyUI：真实出图 ----------
        if comfy_online():
            out, data = c.tool("add_image_node", {
                "prompt": "a single red circle on white paper, top view",
                "workflow": "krea2-txt2img.api.json", "width": 96, "height": 48, "size": "custom",
            })
            rid = (data.get("node") or {}).get("id") or ""
            out, data = c.tool("run_node", {"node": rid, "wait": True, "timeout_s": 240})
            images = data.get("images") or []
            check("run_node 真的出图并写回节点",
                  (not out["isError"]) and bool(images) and images[0]["url"].startswith("/api/view?"),
                  (out["text"].splitlines() or [""])[0])

            out2, data2 = c.tool("get_canvas")
            row = next((n for n in (data2.get("nodes") or []) if n.get("id") == rid), {})
            check("画布上这个节点已经有图（浏览器打开就能看到）",
                  (row.get("gen") or {}).get("images", 0) >= 1 and str(row.get("dataURL") or "").startswith("/api/view"),
                  f"{row.get('gen', {}).get('images')} 张")

            out3, data3 = c.tool("list_runs", {"node": rid})
            runs = data3.get("runs") or []
            check("生成历史留下一条（含种子 / 尺寸 / 产物）",
                  bool(runs) and runs[0].get("w") == 96 and runs[0].get("seed") is not None
                  and len(runs[0].get("items") or []) >= 1,
                  f"{runs[0].get('w')}×{runs[0].get('h')} seed={runs[0].get('seed')}" if runs else "空")

        else:
            skip("run_node 真出图", "ComfyUI 未连接")

        print("-" * 60)
        print(f"共 {PASS + FAIL + SKIP} 项：通过 {PASS} · 跳过 {SKIP} · 失败 {FAIL}")
        return 0 if FAIL == 0 else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            proc.kill()
        if not keep:
            import shutil
            shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
