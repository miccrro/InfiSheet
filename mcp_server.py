#!/usr/bin/env python3
"""InfiSheet · MCP 服务（零依赖）

把画布能力暴露给 AI 客户端（Claude Desktop / WorkBuddy / Cursor …）：读画布、建节点、
连线、改参数、跑生成、取结果——**不需要打开浏览器**。

两种接入方式：

  * HTTP   —— server.py 挂在 `POST /mcp`（Streamable HTTP + JSON-RPC 2.0）
  * stdio  —— `python mcp_server.py`，把每行 JSON 转发给本地 HTTP 端点；
              服务没起来时会自动拉起（客户端配置里只要一行命令）

两条约定（写画布时必须守住）：

  1. **和浏览器同一条持久化通路**：改的都是 `data/projects/<id>.json`，
     并且每次写都带 rev 乐观锁。浏览器保存时如果 rev 落后，会被拦下来而不是静默覆盖；
     反过来 MCP 写之前也会重读，冲突就重试。
  2. **生成不要求浏览器**：`promptPlan` / `dimsTarget` / `bindRefImages` / `buildGenGraph`
     这几个「参数到底落在哪个节点」的逻辑在下面有一份 Python 移植，规则与
     `static/app.js` 一一对应——两边算出来的提交图必须一致，否则「浏览器里出的图」
     和「AI 跑出来的图」会不一样。

用法：
    python mcp_server.py                      # stdio 桥（给 MCP 客户端拉起来用）
    python mcp_server.py --port 9000
    python mcp_server.py --no-autostart       # 只转发，不自动起服务

客户端配置见 docs/MCP.md。
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "infisheet", "title": "InfiSheet 画布", "version": "1.1.0"}
SERVER_VERSION = SERVER_INFO["version"]

RUN_CAP = 30                     # 和前端一致：每个图片节点最多留 30 次生成记录
SIZE_PX = {"1k": 1024, "2k": 2048, "4k": 4096}
ASPECTS = ["1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "9:21"]
PROJECT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


class ToolError(Exception):
    """工具层的「可预期失败」：把这句话原样交给模型，别裹成 500。"""


# --------------------------------------------------------------------------- #
# 接入状态：顶栏那个「MCP 已连接」小灯的数据源
#
# 服务端本身是无状态的，但「有没有 AI 接进来」这件事只有收到 initialize 的这一侧知道，
# 所以记在进程里。只记昵称、时间和调用次数，不碰任何画布内容；进程重启就归零——
# 客户端会自己重连，灯自然会再亮（比留一个可能是假的状态更诚实）。
# --------------------------------------------------------------------------- #
_CONN = {
    "connected": False,   # 收到过 initialize（握手成功）
    "live": False,        # 收到过 notifications/initialized：客户端的流程确实走完了
    "client": "",
    "clientVersion": "",
    "host": "",           # 拉起 stdio 桥的那个应用（父进程），客户端自报的名字不可用时顶上
    "clientSource": "",   # 这个名字是哪来的：handshake / bridge / host / touch
    "protocol": "",
    "session": "",        # server.py 拿到 Mcp-Session-Id 后回填
    "at": 0.0,            # 第一次连上的时间戳
    "last": 0.0,          # 最后一次说话的时间戳
    "calls": 0,           # tools/call 次数
    # 下面三个是「断开」用的。HTTP 直连没有心跳通道，判不了死活；stdio 桥有：
    # 桥活着就每 lease/3 秒敲一次 /api/mcp/heartbeat，桥一死（客户端关窗、崩溃、
    # 被任务管理器杀掉）心跳就停，过了租约这条接入就算离线——灯自己变灰。
    "bridge": False,      # 这次接入带过心跳（说明是 stdio 桥，判得了离线）
    "beat": 0.0,          # 最后一次心跳
    "lease": 30.0,        # 租约秒数（configure 注入；0 = 不做租约，永远算在线）
}



def note_session(session: str = "") -> None:
    """server.py 分配 Mcp-Session-Id 时回填一下，前端能认出「是同一个客户端」。"""
    if session:
        _CONN["session"] = session


def status() -> dict:
    """给 /api/health 用：浅拷贝 + 几个派生字段（前端不用自己算时间差）。

    `alive` 和 `connected` 是两件事：
    - `connected` 是**历史**：这个进程里有没有人接过（握手 / 调过工具 / 敲过心跳）；
    - `alive` 是**现在**：带心跳的接入（stdio 桥）看租约，超时就算离线；
      不带心跳的（HTTP 直连）没有判活通道，只能沿用 `connected`——说它断了等于瞎猜。
    前端拿 `connected && !alive` 显示「已断开」，`!connected` 显示「待接入」。
    """
    now = time.time()
    out = dict(_CONN)
    out["age"] = round(now - _CONN["at"], 1) if _CONN["at"] else None
    out["idle"] = round(now - _CONN["last"], 1) if _CONN["last"] else None
    lease = float(_CONN.get("lease") or 0)
    if _CONN["connected"] and _CONN["bridge"] and lease and _CONN["beat"]:
        silent = now - _CONN["beat"]
        out["alive"] = silent < lease
        out["stale"] = round(silent, 1) if not out["alive"] else 0
    else:
        out["alive"] = bool(_CONN["connected"])
        out["stale"] = 0
    return out


def lease() -> float:
    """当前租约秒数。桥拿它算心跳间隔（lease/3），所以改租约不用同时改桥。"""
    return float(_CONN.get("lease") or 0)


def set_lease(seconds) -> None:
    try:
        _CONN["lease"] = max(0.0, float(seconds or 0))
    except (TypeError, ValueError):
        _CONN["lease"] = 30.0



# 客户端自报的名字不能照抄。实测 WorkBuddy 传的 clientInfo 是
#   {"name": "infisheet", "version": "1.0.0"}
# —— 那是 mcp.json 里的**服务器别名**，不是它自己；版本也是占位的 1.0.0。
# 照抄的结果就是顶栏灯上写着「MCP 已连接 · infisheet」：镜子里映的是我们自己。
# 所以：自报值只当线索，明显是「我们」或占位词时一律不认，改用进程树里的宿主应用名。
_SELF_NAME = (SERVER_INFO.get("name") or "").strip().lower()
_PLACEHOLDERS = {"", "mcp 客户端", "mcp client", "未命名客户端", "未命名", "unknown", "null"}


def _usable(name) -> bool:
    n = str(name or "").strip().lower()
    return bool(n) and n not in _PLACEHOLDERS and n != _SELF_NAME


# 外壳进程：往上找宿主应用时跳过它们。跳过的是「只是壳」的东西，
# 不是「应用」——留着它们会得到 cmd.exe / python.exe 这种毫无信息量的答案。
_SHELLS = {
    "cmd.exe", "conhost.exe", "powershell.exe", "pwsh.exe", "bash.exe", "sh.exe",
    "zsh.exe", "fish.exe", "python.exe", "pythonw.exe", "node.exe", "wt.exe",
    "windowsterminal.exe", "openconsole.exe",
}
_HOST = {"name": "", "probed": False, "chain": []}


def _proc_table():
    """pid -> (ppid, exe)。Windows 走 Toolhelp，POSIX 走 /proc。都不依赖第三方包。"""
    table = {}
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class _PE32W(ctypes.Structure):
                _fields_ = [
                    ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", wintypes.WCHAR * 260),
                ]

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
            k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
            k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PE32W)]
            k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PE32W)]
            snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
            if not snap or snap == ctypes.c_void_p(-1).value:
                return table
            try:
                ent = _PE32W()
                ent.dwSize = ctypes.sizeof(_PE32W)
                if not k32.Process32FirstW(snap, ctypes.byref(ent)):
                    return table
                while True:
                    table[int(ent.th32ProcessID)] = (int(ent.th32ParentProcessID), str(ent.szExeFile))
                    if not k32.Process32NextW(snap, ctypes.byref(ent)):
                        break
            finally:
                k32.CloseHandle(snap)
        else:
            for d in os.listdir("/proc"):
                if not d.isdigit():
                    continue
                try:
                    stat = Path("/proc", d, "stat").read_text(errors="replace")
                    comm = Path("/proc", d, "comm").read_text(errors="replace").strip()
                    ppid = int(stat.rsplit(")", 1)[1].split()[1])
                except Exception:  # noqa: BLE001
                    continue
                table[int(d)] = (ppid, comm)
    except Exception:  # noqa: BLE001
        # 拿不到进程树不是错误路径：退回到「没有宿主名」，灯上就只说「MCP 已连接」
        return table
    return table


def host_app() -> str:
    """拉起本进程的那个应用名（去扩展名），拿不到就返回空串。

    为什么需要它：客户端自报的 clientInfo 可能是我们自己的名字（见 _SELF_NAME），
    而 stdio 桥是被宿主应用**直接拉起来**的——进程树里父进程是这件事里唯一
    不需要客户端配合的证据。往上找，跳过 shell / 解释器，取第一个像应用的名字。
    """
    if _HOST["probed"]:
        return _HOST["name"]
    _HOST["probed"] = True
    table = _proc_table()
    pid, chain = os.getpid(), []
    for _ in range(6):
        ppid, exe = table.get(pid, (0, ""))
        if not exe:
            break
        chain.append(exe)
        # 父进程是外壳就继续往上；cmd → python → WorkBuddy 这种链子很常见
        if exe.strip().lower() not in _SHELLS:
            stem = os.path.splitext(exe)[0].strip()
            _HOST["name"] = stem[:48]
            break
        if not ppid or ppid == pid:
            break
        pid = ppid
    _HOST["chain"] = chain
    return _HOST["name"]


def _adopt(name: str, ver: str = "", source: str = "bridge") -> None:
    _CONN["client"] = name[:48]
    _CONN["clientVersion"] = (ver or "")[:24]
    _CONN["clientSource"] = source


def _mark_connected(info, protocol: str) -> None:
    now = time.time()
    info = info if isinstance(info, dict) else {}
    name = str(info.get("name") or "").strip()[:48]
    ver = str(info.get("version") or "")[:24]
    _CONN["connected"] = True
    _CONN["protocol"] = protocol
    if _usable(name):
        _adopt(name, ver, "handshake")
    elif _CONN["host"]:
        # 自报的名字不可用（是我们自己 / 占位词）：宿主应用名比「未命名客户端」有意义
        _adopt(_CONN["host"], "", "host")
    elif not _CONN["client"] or not _usable(_CONN["client"]):
        _CONN["client"] = "未命名客户端"
        _CONN["clientSource"] = "handshake"
    if not _CONN["at"]:
        _CONN["at"] = now
    _CONN["last"] = now


def _touch() -> None:
    """一次真实的工具调用也算「有 AI 连着」。

    为什么不能只认 initialize：客户端连上之后服务重启（改代码、换端口），
    客户端不会重新握手——它手里那条会话照用，工具调用直接打过来。
    只认 initialize 的话，这种情况灯会一直灰着，明明能用。代价是这种情况下
    没有客户端名（显示「MCP 客户端」），前端会在 title 里说明是重启后续接的。
    """
    now = time.time()
    if not _CONN["connected"]:
        _CONN["connected"] = True
        if not _CONN["client"] or not _usable(_CONN["client"]):
            if _CONN["host"]:
                _adopt(_CONN["host"], "", "host")
            else:
                _CONN["client"] = "MCP 客户端"
                _CONN["clientSource"] = "touch"
        _CONN["at"] = now
    _CONN["last"] = now
    # 桥转发的请求本身就是「桥还活着」的证据；刷新心跳，别让正在干活的接入被判成离线
    if _CONN["bridge"]:
        _CONN["beat"] = now


def note_client(spec: str = "", host: str = "") -> None:
    """stdio 桥每条请求都带 `X-MCP-Client: 名字/版本` 和 `X-MCP-Host: 宿主应用名`。

    两件事分开看：
    - `spec` 是桥转述的 clientInfo，只在还没有身份时才采用——真正的 initialize 更权威；
    - `host` 是桥所在进程的父进程名，用来兜住「自报名字是我们自己 / 占位词」的情况。
      它是客户端**无法伪造也无需配合**的信息，所以哪怕 spec 完全空着也该记下来。
    """
    host = (host or "").strip()[:48]
    if host and not _CONN["host"]:
        # 兜底名永远先落库：后面真需要它的时候（没有握手、名字不可用）它得在
        _CONN["host"] = host
    spec = (spec or "").strip()
    if host or spec:
        # 这两个头只可能来自 stdio 桥（客户端自己不会发）。它出现 = 桥在，
        # 于是这次接入有了判活通道：心跳一停就是桥没了（客户端关窗 / 崩溃 / 被强杀）。
        _CONN["bridge"] = True
        _CONN["beat"] = time.time()
    name, _, ver = spec.partition("/")
    name, ver = name.strip()[:48], ver.strip()[:24]
    cur = _CONN["client"]
    if not _usable(name):
        # 自报名不可用：空位就交给宿主名，别留「MCP 客户端」这种泛称
        if (not cur or not _usable(cur)) and _CONN["host"]:
            _adopt(_CONN["host"], "", "host")
        return
    # 宿主名是「退而求其次」的答案：一旦有客户端自报的可用名字，就该被覆盖
    if not _usable(cur) or _CONN["clientSource"] == "host":
        _adopt(name, ver, "bridge")


def note_heartbeat(spec: str = "", host: str = "") -> None:
    """stdio 桥的保活信号（`POST /api/mcp/heartbeat`）。

    为什么单开一条通道，而不是让桥每隔几秒发一次 `ping`：
    - `ping` 是一条 JSON-RPC 往返，桥还得把响应吃掉（不然会漏进客户端的 stdout）；
    - 心跳不是协议的一部分，走 `/api/` 更干净，也不会污染 `calls` 计数。

    心跳同时算「接上了」：桥是客户端拉起来的，桥活着就说明客户端那边有进程。
    这条还顺手修了一个老问题——服务重启后客户端不会重新握手，以前要等它调用一次
    工具灯才亮；现在桥一起来就亮。
    """
    now = time.time()
    note_client(spec, host)          # 顺带把身份带上（桥每 10s 都会报一次）
    _CONN["bridge"] = True
    _CONN["beat"] = now
    _CONN["last"] = now
    if not _CONN["connected"]:
        _CONN["connected"] = True
        if not _usable(_CONN["client"]):
            if _CONN["host"]:
                _adopt(_CONN["host"], "", "host")
            else:
                _CONN["client"] = "MCP 客户端"
                _CONN["clientSource"] = "touch"
        _CONN["at"] = now



# --------------------------------------------------------------------------- #
# 环境注入：server.py 启动时把数据目录和 ComfyUI 代理函数交进来，
# 这样 MCP 不用 import server（避免循环依赖），也方便单独跑协议测试。
# --------------------------------------------------------------------------- #
_ENV = None


def configure(env) -> None:
    global _ENV
    _ENV = env
    # 租约由 server.py 的 --mcp-lease 决定（测试里会调到 2 秒，不用真等 30 秒）
    set_lease(getattr(env, "mcp_lease", 30.0))


def E():
    if _ENV is None:
        raise RuntimeError("mcp_server 还没 configure()：应由 server.py 启动时注入")
    return _ENV


def data_dir() -> Path:
    return Path(E().data)


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# 项目存档
# --------------------------------------------------------------------------- #
def projects_dir() -> Path:
    d = data_dir() / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_project_rows() -> list:
    rows = []
    for f in sorted(projects_dir().glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        d = _read_json(f) or {}
        rows.append({
            "id": f.stem,
            "name": d.get("name") or "未命名画布",
            "nodes": len(d.get("nodes") or []),
            "links": len(d.get("links") or []),
            "savedAt": d.get("savedAt") or 0,
            "rev": int(d.get("rev") or 0),
            "lastWriter": d.get("lastWriter") or "",
        })
    return rows


def load_canvas(pid: str) -> dict:
    if not PROJECT_ID_RE.fullmatch(pid or ""):
        raise ToolError(f"项目 id 不合法：{pid}")
    f = projects_dir() / f"{pid}.json"
    if not f.exists():
        raise ToolError(f"项目不存在：{pid}")
    data = _read_json(f)
    if not isinstance(data, dict):
        raise ToolError(f"项目文件读不出来（不是合法 JSON）：{pid}")
    if not isinstance(data.get("nodes"), list):
        data["nodes"] = []
    if not isinstance(data.get("links"), list):
        data["links"] = []
    return data


def save_canvas(pid: str, canvas: dict, base_rev=None, writer: str = "mcp") -> dict:
    """带 rev 乐观锁的保存。

    rev 只由服务端递增，客户端只上报「我是从哪一版改的」。base_rev 落后就拒绝，
    这样浏览器和 MCP 同时开着时不会互相静默覆盖——这是能「看着 AI 改画布」的前提。
    """
    path = projects_dir() / f"{pid}.json"
    prev = _read_json(path) or {}
    prev_rev = int(prev.get("rev") or 0)
    if base_rev is not None and int(base_rev) < prev_rev:
        return {"ok": False, "conflict": True, "rev": prev_rev,
                "lastWriter": prev.get("lastWriter") or ""}
    canvas["rev"] = prev_rev + 1
    canvas["lastWriter"] = writer
    canvas["savedAt"] = int(time.time() * 1000)
    path.write_text(json.dumps(canvas, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"ok": True, "conflict": False, "rev": canvas["rev"]}


def mutate(pid: str, fn, writer: str = "mcp", retries: int = 3):
    """读-改-写。冲突（浏览器刚好存了一次）就重读重来，最多 3 次。"""
    last = None
    for _ in range(retries):
        canvas = load_canvas(pid)
        rev = int(canvas.get("rev") or 0)
        out = fn(canvas)
        res = save_canvas(pid, canvas, base_rev=rev, writer=writer)
        last = res
        if not res.get("conflict"):
            return out, canvas
    raise ToolError(f"画布正在被另一个会话反复修改（rev={last.get('rev') if last else '?'}），稍后重试")


def create_project(name: str):
    pid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    canvas = {
        "version": 2, "name": (name or "未命名画布")[:40], "nodes": [], "links": [], "groups": [],
        "view": {"x": 140, "y": 120, "k": 0.85}, "seq": 1, "rev": 0,
        "savedAt": int(time.time() * 1000),
    }
    save_canvas(pid, canvas, base_rev=0)
    return pid, canvas


def _mcp_state_path() -> Path:
    return data_dir() / "mcp.json"


def active_project_id() -> str:
    st = _read_json(_mcp_state_path()) or {}
    pid = str(st.get("project") or "")
    if pid and (projects_dir() / f"{pid}.json").exists():
        return pid
    rows = list_project_rows()
    return rows[0]["id"] if rows else ""


def set_active_project(pid: str) -> None:
    _mcp_state_path().parent.mkdir(parents=True, exist_ok=True)
    _mcp_state_path().write_text(
        json.dumps({"project": pid, "updatedAt": int(time.time() * 1000)}, ensure_ascii=False),
        encoding="utf-8")


def ensure_project():
    """MCP 自己的「当前项目」：先看 mcp.json，再看最近改过的项目，都没有就建一个。

    注意它和浏览器 localStorage 里那个「上次打开的项目」是两套：MCP 不该偷偷改用户的
    默认画布，所以单独记一份。
    """
    pid = active_project_id()
    if pid:
        return pid, load_canvas(pid)
    pid, canvas = create_project("MCP 画布")
    set_active_project(pid)
    return pid, canvas


def resolve_project(args, create: bool = False) -> tuple:
    """定位要操作的项目。create=False 时**不会**顺手建一个空画布——
    读画布（get_canvas）把画布建出来是反直觉的；写入类工具走 ensure_project 才自动建。"""
    pid = str(args.get("project") or "").strip()
    if pid:
        rows = list_project_rows()
        if not any(r["id"] == pid for r in rows):
            hit = next((r for r in rows if pid and pid in (r["name"] or "")), None)
            if not hit:
                raise ToolError(f"没有这个项目：{pid}（先 list_projects 看有哪些）")
            pid = hit["id"]
        return pid, load_canvas(pid)
    active = active_project_id()
    if active:
        return active, load_canvas(active)
    if create:
        return ensure_project()
    raise ToolError("还没有任何画布：用 create_project 建一个，"
                    "或者直接 add_image_node（会建一个「MCP 画布」）")


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #
def find_node(canvas: dict, nid: str):
    for n in canvas.get("nodes") or []:
        if n.get("id") == nid:
            return n
    return None


def next_id(canvas: dict, prefix: str) -> str:
    """和前端 uid() 同一个口径（t1 / i2 / w3 / l4），顺带把 seq 往前推。"""
    seq = int(canvas.get("seq") or 1)
    used = {n.get("id") for n in canvas.get("nodes") or []}
    while True:
        nid = f"{prefix}{seq}"
        seq += 1
        if nid not in used:
            break
    canvas["seq"] = seq
    return nid


def auto_pos(canvas: dict) -> tuple:
    """新节点落在哪。

    空画布不再固定 (0,0)：存档里带着 view（平移 + 缩放），(0,0) 很可能在用户视线之外——
    AI 建完图，人刷新页面看到一片空白，只会以为「没生成」。所以空画布时放到
    「当前视口左上角往里 60px」的位置，也就是他正看着的地方。
    """
    nodes = canvas.get("nodes") or []
    if not nodes:
        view = canvas.get("view") or {}
        try:
            k = float(view.get("k") or 1) or 1.0
            vx = -float(view.get("x") or 0) / k
            vy = -float(view.get("y") or 0) / k
        except (TypeError, ValueError):
            return 0, 0
        return int(vx) + 60, int(vy) + 60
    right = max((n.get("x") or 0) for n in nodes)
    top = min((n.get("y") or 0) for n in nodes)
    return int(right) + 440, int(top)


def _default_workflow() -> dict:
    presets = E().list_presets()
    if not presets:
        raise ToolError("presets/ 里一个工作流都没有，先往目录里放一个 API 图")
    return presets[0]


def load_workflow(spec: str) -> dict:
    """按 id / 文件名 / 标题找预设；不传就用第一个。

    挑工作流只能看能力（takes_image），不能看名字——「Moss_图像编辑」其实是纯文生图，
    拿它当图生图只会重画一张。
    """
    presets = E().list_presets()
    lib = list_library()
    spec = (spec or "").strip()
    if not spec:
        p = _default_workflow()
        return {"id": "preset:" + p["file"], "label": p["title"], "file": p["file"],
                "graph": _preset_graph(p["file"]), **{k: p.get(k) for k in ("takes_image",)}}
    if spec.startswith("preset:"):
        spec_file = spec.split(":", 1)[1]
        hit = next((p for p in presets if p["file"] == spec_file or p["name"] == spec_file), None)
        if not hit:
            raise ToolError(f"预设不存在：{spec_file}")
        return {"id": "preset:" + hit["file"], "label": hit["title"], "file": hit["file"],
                "graph": _preset_graph(hit["file"]), **{k: hit.get(k) for k in ("takes_image",)}}
    if spec.startswith("lib:"):
        name = spec.split(":", 1)[1]
        hit = next((x for x in lib if x["name"] == name), None)
        if not hit:
            raise ToolError(f"工作流库里没有：{name}")
        data = _read_json(data_dir() / "library" / f"{name}.json") or {}
        graph = data.get("graph") or {}
        return {"id": "lib:" + name, "label": "库 · " + name, "graph": graph,
                "takes_image": _takes(graph)["takes_image"]}
    low = spec.lower()
    hit = next((p for p in presets if low in (p["file"].lower(), p["title"].lower(), p["name"].lower())), None)
    if not hit:
        hit = next((p for p in presets if low in p["title"].lower() or low in p["file"].lower()), None)
    if hit:
        return {"id": "preset:" + hit["file"], "label": hit["title"], "file": hit["file"],
                "graph": _preset_graph(hit["file"]), **{k: hit.get(k) for k in ("takes_image",)}}
    hitlib = next((x for x in lib if low in x["name"].lower()), None)
    if hitlib:
        return load_workflow("lib:" + hitlib["name"])
    raise ToolError(f"找不到工作流「{spec}」：先 list_workflows 看可用项")


MEDIA_TYPES = {
    "image": {"SaveImage", "PreviewImage", "SaveImageAdvanced"},
    "video": {"SaveVideo", "PreviewVideo", "CreateVideo", "VHS_VideoCombine", "SaveAnimatedWEBP"},
    "audio": {"SaveAudio", "PreviewAudio"},
}


def _kinds(graph: dict) -> list:
    out = set()
    for node in (graph or {}).values():
        ct = (node or {}).get("class_type") if isinstance(node, dict) else ""
        for kind, types in MEDIA_TYPES.items():
            if ct in types:
                out.add(kind)
    return sorted(out)


def list_library() -> list:
    d = data_dir() / "library"
    out = []
    if not d.exists():
        return out
    for f in sorted(d.glob("*.json")):
        data = _read_json(f) or {}
        graph = data.get("graph") or {}
        out.append({"name": f.stem, "nodes": len(graph), "kinds": _kinds(graph),
                    "saved_at": data.get("saved_at")})
    return out


def _preset_graph(file: str) -> dict:
    data = _read_json(Path(E().presets) / file) or {}
    graph = data.get("graph") or data
    if not isinstance(graph, dict):
        raise ToolError(f"预设 {file} 里没有 API 图")
    return graph


def _takes(graph: dict) -> dict:
    """这个工作流吃不吃外部图片（有没有 LoadImage / LoadImageMask 入口）。

    遮罩功能已经删掉，所以这里只剩「吃不吃图」——别再按名字猜能力，
    「Moss_图像编辑」就是纯文生图。
    """
    img = False
    for node in (graph or {}).values():
        if not isinstance(node, dict):
            continue
        if (node.get("class_type") or "") in ("LoadImage", "LoadImageMask"):
            img = True
    return {"takes_image": img}


# --------------------------------------------------------------------------- #
# 图构建：static/app.js 的 Python 版（规则一一对应，别单独「优化」）
# --------------------------------------------------------------------------- #
def _is_link(v) -> bool:
    return (isinstance(v, list) and len(v) == 2
            and isinstance(v[1], (int, float)) and not isinstance(v[1], bool))


def snap_dim(v) -> int:
    n = int(round(float(v or 0) / 16.0)) * 16
    return min(8192, max(64, n or 64))


def calc_dims(aspect: str = "1:1", size: str = "1k", custom=None) -> dict:
    if size == "custom" and custom and custom.get("w") and custom.get("h"):
        return {"width": snap_dim(custom["w"]), "height": snap_dim(custom["h"])}
    long_side_px = SIZE_PX.get(size, 1024)
    try:
        a, b = [float(x) for x in str(aspect).split(":")]
    except Exception:  # noqa: BLE001
        a, b = 1.0, 1.0
    if a <= 0 or b <= 0:
        a = b = 1.0
    long_side = int(round(long_side_px / 16.0)) * 16
    short_side = int(round(long_side_px * min(a, b) / max(a, b) / 16.0)) * 16
    return ({"width": long_side, "height": short_side} if a >= b
            else {"width": short_side, "height": long_side})


def dims_target(g: dict):
    """尺寸该写到哪个节点：KSampler.latent_image 往上第一个同时有 width/height 的节点。

    只按插槽名找 width 对图生图/风格流不成立——那边的宽高是连线（EmptyLatentImage.width
    ← ResolutionSelector），连线值在 analyze 里被跳过，于是面板上选的尺寸一个像素都没写进去。
    """
    ks = next(((nid, nd) for nid, nd in g.items()
               if isinstance(nd, dict) and isinstance(nd.get("class_type"), str)
               and re.search(r"KSampler", nd["class_type"] or "", re.I)
               and isinstance((nd.get("inputs") or {}).get("latent_image"), list)), None)
    if not ks:
        return None
    seen, queue = set(), [str(ks[1]["inputs"]["latent_image"][0])]
    while queue:
        nid = queue.pop(0)
        if nid in seen:
            continue
        seen.add(nid)
        nd = g.get(nid)
        if not isinstance(nd, dict):
            continue
        ins = nd.get("inputs") or {}
        if "width" in ins and "height" in ins:
            return nid
        for v in ins.values():
            if _is_link(v):
                queue.append(str(v[0]))
    return None


JOIN_PARAM = re.compile(r"^(input|inputs|separator|delimiter|sep|prefix|suffix|filter_\w+|\w+_sep)$", re.I)
SYSTEMISH = re.compile(
    r"(you are an?[^.]{0,60}(expert|assistant|model|engineer)|your task is|follow these rules|think step by step)",
    re.I)


def prompt_plan(g: dict, slots: list) -> dict:
    """提示词落点：沿 KSampler.positive 往上，取「离采样器最远的内容型字面量文本」。

    不能取 texts[0]：拼接器（MultiStringJoin / StringConcatenate）的 input / separator
    也是 STRING，节点 id 又更小，排在前面，提示词会被写进一个空转的填充位。
    """
    def is_neg(s):
        n = str(s.get("input") or "").lower()
        return "negative" in n or n.startswith("neg")

    texts = [s for s in (slots or []) if s.get("kind") == "text"]
    depth = {}
    ks = next(((nid, nd) for nid, nd in (g or {}).items()
               if isinstance(nd, dict) and isinstance(nd.get("class_type"), str)
               and re.search(r"KSampler", nd["class_type"] or "", re.I)
               and isinstance((nd.get("inputs") or {}).get("positive"), list)), None)
    if ks:
        stack = [(str(ks[1]["inputs"]["positive"][0]), 0)]
        while stack:
            nid, d = stack.pop()
            if nid in depth and depth[nid] <= d:
                continue
            depth[nid] = d
            nd = g.get(nid) or {}
            for v in (nd.get("inputs") or {}).values():
                if _is_link(v):
                    stack.append((str(v[0]), d + 1))

    cands = [s for s in texts if not is_neg(s) and str(s.get("node")) in depth
             and not JOIN_PARAM.match(str(s.get("input") or ""))]
    content = [s for s in cands if not SYSTEMISH.search(str(s.get("value") or ""))]
    pool = (content if content else cands)
    pool = sorted(pool, key=lambda s: -depth.get(str(s.get("node")), 0))
    target = pool[0] if pool else None
    fallback = next((s for s in texts if not is_neg(s) and not JOIN_PARAM.match(str(s.get("input") or ""))), None)
    if fallback is None and texts:
        fallback = texts[0]
    old_pick = texts[0] if texts else None
    corrected = bool(target and old_pick and target.get("key") != old_pick.get("key"))
    if target is None:
        target = fallback
    negative = next((s for s in texts if is_neg(s)), None)
    return {"target": target, "oldPick": old_pick, "corrected": corrected,
            "negative": negative, "onChain": len(cands)}


def bind_ref_images(g: dict, slots: list, images: list) -> dict:
    """绑参考图 + 摘掉工作流自带的残留图。

    多图编辑器（Qwen 编辑流）是 images.image_1..N 一组；按 N 升序填，提示词里的
    「图1」才对得上。填不满的槽位断线，没人再引用的 LoadImage 连节点一起删——
    ComfyUI 会校验提交图里的每个节点，孤儿 LoadImage 指向不存在的文件会整体 400。
    """
    imgs = [x for x in (images or []) if x]
    img_slots = [s for s in (slots or []) if s.get("kind") == "image"]
    if not img_slots or not imgs:
        return {"bound": [], "pruned": []}

    def set_slot(key, value):
        nid, _, inp = str(key).rpartition(".")
        if nid in g and isinstance(g[nid].get("inputs"), dict):
            g[nid]["inputs"][inp] = value

    consumers = {}
    for nid, nd in g.items():
        for name, v in ((nd or {}).get("inputs") or {}).items():
            if _is_link(v):
                consumers.setdefault(str(v[0]), []).append((nid, name))
    groups = {}
    for s in img_slots:
        for c in consumers.get(str(s.get("node")), []):
            gk = c[0] + "::" + re.sub(r"\d+$", "", c[1])
            groups.setdefault(gk, []).append({"slot": s, "nid": c[0], "name": c[1]})
    main = None
    for items in groups.values():
        if main is None and any(it["slot"].get("key") == img_slots[0].get("key") for it in items):
            main = items
    pruned = []
    if not main or len(main) < 2:
        set_slot(img_slots[0]["key"], imgs[0])
        return {"bound": [img_slots[0]["key"]], "pruned": pruned}

    def order_of(it):
        m = re.search(r"(\d+)$", it["name"])
        return int(m.group(1)) if m else 0

    srt = sorted(main, key=order_of)
    orphans = set()
    for i, it in enumerate(srt):
        if i < len(imgs):
            set_slot(it["slot"]["key"], imgs[i])
            continue
        nd = g.get(it["nid"])
        if not nd or not isinstance(nd.get("inputs"), dict) or it["name"] not in nd["inputs"]:
            continue
        del nd["inputs"][it["name"]]
        orphans.add(str(it["slot"].get("node")))
        if it["slot"].get("value"):
            pruned.append(str(it["slot"]["value"]))
    for oid in orphans:
        nd = g.get(oid)
        if not nd or nd.get("class_type") != "LoadImage":
            continue
        still = any(nid != oid and any(_is_link(v) and str(v[0]) == oid
                                       for v in ((other or {}).get("inputs") or {}).values())
                    for nid, other in g.items())
        if not still:
            g.pop(oid, None)
    return {"bound": [it["slot"]["key"] for it in srt[:min(len(imgs), len(srt))]], "pruned": pruned}


def plan_seed(seed_mode: str = "random", seed=None) -> dict:
    if seed_mode == "fixed":
        try:
            v = int(seed)
        except (TypeError, ValueError):
            v = 0
        return {"value": max(0, v), "fixed": True}
    return {"value": int.from_bytes(os.urandom(4), "big"), "fixed": False}


def build_gen_graph(graph: dict, slots: list, dims: dict, batch: int, prompt: str,
                    ref_images: list, seed_mode: str = "random", seed=None) -> dict:
    out = json.loads(json.dumps(graph))

    def set_val(key, value):
        nid, _, inp = str(key).rpartition(".")
        if nid in out and isinstance(out[nid].get("inputs"), dict):
            out[nid]["inputs"][inp] = value

    plan = prompt_plan(out, slots)
    if plan["target"]:
        set_val(plan["target"]["key"], prompt)
    sd = plan_seed(seed_mode, seed)
    seed_keys = [s for s in (slots or []) if s.get("kind") == "seed"]
    for s in seed_keys:
        set_val(s["key"], sd["value"])
    refs = bind_ref_images(out, slots, ref_images)

    sized = batched = False
    target = dims_target(out)
    if target:
        ins = out[target]["inputs"]
        dropped = [str(v[0]) for v in (ins.get("width"), ins.get("height")) if _is_link(v)]
        ins["width"] = dims["width"]
        ins["height"] = dims["height"]
        if "batch_size" in ins:
            ins["batch_size"] = batch
            batched = True
        sized = True
        for did in dropped:
            if did not in out or did == target:
                continue
            still = any(nid != did and any(_is_link(v) and str(v[0]) == did
                                           for v in ((nd or {}).get("inputs") or {}).values())
                        for nid, nd in out.items())
            if not still:
                out.pop(did, None)
    for s in (slots or []):
        if s.get("kind") != "number":
            continue
        name = str(s.get("input") or "").lower()
        if "width" in name:
            if not sized:
                set_val(s["key"], dims["width"])
        elif "height" in name:
            if not sized:
                set_val(s["key"], dims["height"])
        elif "batch" in name:
            if not (sized and target == str(s.get("node"))):
                set_val(s["key"], batch)
                batched = True
    return {
        "graph": out, "sized": sized, "pruned": refs["pruned"],
        "batch": {"value": batch, "applied": batched},
        "refs": {"count": len(refs["bound"]), "keys": refs["bound"]},
        "seed": ({"value": sd["value"], "fixed": sd["fixed"], "keys": [s["key"] for s in seed_keys]}
                 if seed_keys else None),
        "prompt": ({"key": plan["target"]["key"], "node": plan["target"].get("node"),
                    "input": plan["target"].get("input"),
                    "title": plan["target"].get("node_title") or plan["target"].get("class_type"),
                    "corrected": plan["corrected"]} if plan["target"] else None),
    }


def ref_marks(text: str, labels: list) -> str:
    """`@[图名]` → `图N`（N 是送进工作流的顺序）。

    不能直接删：删完会得到「把 的人物放进 的场景」，模型无从下手；
    而「图1」与 images.image_1 一一对应，模型才知道哪张是哪张。
    """
    idx = {}
    for i, lab in enumerate(labels):
        if lab and lab not in idx:
            idx[lab] = i + 1
        base = str(lab or "").split(" #")[0]
        if base and base not in idx:
            idx[base] = i + 1

    def repl(m):
        name = m.group(1)
        return f"图{idx[name]}" if name in idx else ""

    out = re.sub(r"@\[([^\]\n]{0,40})\]", repl, str(text or ""))
    return re.sub(r"[ \t]{2,}", " ", out).strip()


def ref_labels(refs: list) -> list:
    """同名图补 #1 #2——否则 `nodeByTitle` 永远返回第一张，胶囊会指错图。"""
    titles = [(r["node"].get("title") or "图片") for r in refs]
    total = {}
    for t in titles:
        total[t] = total.get(t, 0) + 1
    seen, labels = {}, []
    for t in titles:
        if total[t] > 1:
            seen[t] = seen.get(t, 0) + 1
            labels.append(f"{t} #{seen[t]}")
        else:
            labels.append(t)
    return labels


def collect_refs(canvas: dict, node: dict) -> list:
    """参考图三种来源：连线 → 经文本节点 → @ 引用（gen.extras），和前端 refsOf 一致。"""
    out, seen = [], set()

    def push(n, via):
        if not n or n.get("type") != "image" or n.get("id") == node.get("id") or n.get("id") in seen:
            return
        if not n.get("dataURL"):
            return
        seen.add(n.get("id"))
        out.append({"node": n, "via": via})

    links = canvas.get("links") or []
    into = [find_node(canvas, l.get("from")) for l in links
            if l.get("to") == node.get("id") and l.get("toKey") == "in"]
    for n in into:
        if n and n.get("type") == "image":
            push(n, "link")
    for t in [n for n in into if n and n.get("type") == "text"]:
        for l in links:
            if l.get("to") == t.get("id") and l.get("toKey") == "in":
                push(find_node(canvas, l.get("from")), "text")
    for nid in ((node.get("gen") or {}).get("extras") or []):
        push(find_node(canvas, nid), "at")
    return out


# --------------------------------------------------------------------------- #
# 风格库（397 个 Krea2 预设，只存指针 {cat,i,cn}）
# --------------------------------------------------------------------------- #
_STYLE_CACHE: dict = {}


def style_index() -> list:
    return _read_json(Path(E().static) / "styles" / "index.json") or []


def style_pack(cat: str) -> list:
    if cat not in _STYLE_CACHE:
        _STYLE_CACHE[cat] = _read_json(Path(E().static) / "styles" / f"{cat}.json") or []
    return _STYLE_CACHE[cat]


def resolve_style(spec):
    if spec in (None, "", "none", "无"):
        return None
    if isinstance(spec, dict):
        cat = str(spec.get("cat") or "")
        i = int(spec.get("i") or 0)
        items = style_pack(cat)
        if not items or i < 0 or i >= len(items):
            raise ToolError(f"风格指针无效：{cat}#{i}")
        e = items[i]
        return {"cat": cat, "i": i, "cn": e.get("name_cn") or e.get("name"), "entry": e}
    q = str(spec).strip().lower()
    for ci in style_index():
        for i, e in enumerate(style_pack(ci["id"])):
            if q in (str(e.get("name_cn") or "").lower(), str(e.get("name") or "").lower()):
                return {"cat": ci["id"], "i": i, "cn": e.get("name_cn") or e.get("name"), "entry": e}
    for ci in style_index():
        for i, e in enumerate(style_pack(ci["id"])):
            hay = f"{e.get('name_cn') or ''} {e.get('name') or ''}".lower()
            if q and q in hay:
                return {"cat": ci["id"], "i": i, "cn": e.get("name_cn") or e.get("name"), "entry": e}
    raise ToolError(f"没找到风格「{spec}」：先 search_styles 查一下")


def apply_style_prompt(text: str, entry: dict) -> str:
    tpl = str((entry or {}).get("prompt") or "").strip()
    subject = str(text or "").strip()
    if not tpl:
        return subject
    if "{prompt}" not in tpl:
        return f"{tpl} {subject}".strip()
    if not subject:
        cleaned = re.sub(r"[,，;；:]?\s*Subject\s*:\s*\{prompt\}", "", tpl, flags=re.I)
        cleaned = cleaned.replace("{prompt}", "")
        return re.sub(r"[\s,，]+$", "", cleaned).strip()
    return tpl.replace("{prompt}", subject).strip()


# --------------------------------------------------------------------------- #
# 图片上传 / 取回（走 server.py 同一个 ComfyUI 代理）
# --------------------------------------------------------------------------- #
def view_url(filename: str, subfolder: str = "", atype: str = "output") -> str:
    qs = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder or "",
                                 "type": atype or "output"})
    return "/api/view?" + qs


def _safe_filename(name: str) -> str:
    stem = Path(str(name or "image")).name
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "image"
    if "." not in stem:
        stem += ".png"
    return stem[:80]


def upload_bytes(data: bytes, filename: str) -> dict:
    boundary = "----infisheet" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
            f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode("utf-8")
    tail = (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\n"
            f"true\r\n--{boundary}--\r\n").encode("utf-8")
    status, _, raw = E().comfy_request(
        "POST", "/upload/image", head + data + tail,
        content_type=f"multipart/form-data; boundary={boundary}", timeout=120)
    if status != 200:
        raise ToolError(f"上传到 ComfyUI 失败（{status}）：{raw[:200].decode('utf-8', 'replace')}")
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        raise ToolError("ComfyUI 上传接口返回的不是 JSON")


def image_bytes(node: dict) -> bytes:
    u = str(node.get("dataURL") or "")
    if not u:
        raise ToolError(f"图片节点 {node.get('id')} 还没有图片")
    if u.startswith("data:"):
        head, _, payload = u.partition(",")
        if ";base64" in head:
            return base64.b64decode(payload)
        return urllib.parse.unquote_to_bytes(payload)
    if "/api/view" in u or u.startswith("/view?"):
        qs = u.split("?", 1)[1] if "?" in u else ""
        status, _, raw = E().comfy_request("GET", "/view?" + qs, timeout=120)
        if status != 200:
            raise ToolError(f"取回图片失败（{status}）：{u[:80]}")
        return raw
    if re.match(r"^https?://", u):
        with urllib.request.urlopen(u, timeout=60) as res:
            return res.read()
    p = Path(u)
    if p.exists():
        return p.read_bytes()
    raise ToolError(f"认不出这个图片地址：{u[:80]}")


def ensure_uploaded(node: dict) -> str:
    if node.get("uploaded"):
        return node["uploaded"]
    data = image_bytes(node)
    name = _safe_filename(f"{node.get('id') or 'img'}-{int(time.time() * 1000)}.png")
    res = upload_bytes(data, name)
    node["uploaded"] = res.get("name") or name
    node["subfolder"] = res.get("subfolder") or ""
    node["dataURL"] = view_url(node["uploaded"], node["subfolder"], res.get("type") or "input")
    return node["uploaded"]


# --------------------------------------------------------------------------- #
# 工具表
# --------------------------------------------------------------------------- #
TOOLS: dict = {}


def tool(name, description, props=None, required=None):
    def deco(fn):
        TOOLS[name] = {
            "name": name,
            "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, "required": required or []},
            "handler": fn,
        }
        return fn
    return deco


def _node_field(desc="节点 id（如 i2、t1）"):
    return {"type": "string", "description": desc}


def _pos_props():
    return {
        "x": {"type": "number", "description": "画布坐标 x，可不填（自动排在右侧）"},
        "y": {"type": "number", "description": "画布坐标 y，可不填"},
    }


@tool("infisheet_status",
      "看当前状态：ComfyUI 在不在线、当前项目是哪一个、有几个项目。不确定能不能生成时先调这个。")
def _t_status(_args):
    comfy = {"online": False}
    try:
        stats = E().comfy_json("/system_stats", timeout=8)
        sysinfo = stats.get("system") or {}
        comfy = {"online": True, "version": sysinfo.get("comfyui_version"), "os": sysinfo.get("os")}
        try:
            q = E().comfy_json("/queue", timeout=8)
            comfy["running"] = len(q.get("queue_running") or [])
            comfy["pending"] = len(q.get("queue_pending") or [])
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        comfy = {"online": False, "error": str(exc)[:160]}
    rows = list_project_rows()
    pid = active_project_id()
    cur = next((r for r in rows if r["id"] == pid), None)
    lines = [f"InfiSheet {SERVER_VERSION} · MCP 已连接"]
    if comfy.get("online"):
        q = f" · 队列 {comfy.get('running', 0)}/{comfy.get('pending', 0)}" if "running" in comfy else ""
        lines.append(f"ComfyUI：在线（{comfy.get('version') or '版本未知'}{q}）")
    else:
        lines.append(f"ComfyUI：未连接（{comfy.get('error') or '未知原因'}）")
    if cur:
        lines.append(f"当前项目：{cur['id']}「{cur['name']}」· {cur['nodes']} 节点 · rev {cur['rev']}")
    else:
        lines.append("当前项目：还没有（写入第一个节点时会自动新建）")
    lines.append(f"项目总数：{len(rows)}")
    return {"text": "\n".join(lines),
            "data": {"server": SERVER_INFO, "comfy": comfy, "project": cur, "projects": len(rows)}}


@tool("list_projects", "列出所有画布项目（按最近修改排序），含节点数与 rev。")
def _t_list_projects(_args):
    rows = list_project_rows()
    pid = active_project_id()
    if not rows:
        return {"text": "还没有项目。用 create_project 建一个。", "data": {"items": []}}
    lines = []
    for r in rows:
        mark = " ← 当前" if r["id"] == pid else ""
        lines.append(f"- {r['id']}「{r['name']}」· {r['nodes']} 节点 / {r['links']} 连线 · rev {r['rev']}{mark}")
    return {"text": "\n".join(lines), "data": {"items": rows, "active": pid}}


@tool("use_project", "把某个项目设为 MCP 的当前项目（不影响浏览器里打开的那个）。",
      {"project": {"type": "string", "description": "项目 id，或名字里的片段"}}, ["project"])
def _t_use_project(args):
    pid, canvas = resolve_project(args)
    set_active_project(pid)
    return {"text": f"当前项目 → {pid}「{canvas.get('name')}」（{len(canvas.get('nodes') or [])} 节点）",
            "data": {"id": pid, "name": canvas.get("name"), "rev": int(canvas.get("rev") or 0)}}


@tool("create_project", "新建一个空白画布，并设为 MCP 的当前项目。",
      {"name": {"type": "string", "description": "画布名字"},
       "use": {"type": "boolean", "description": "是否设为当前项目，默认 true"}}, [])
def _t_create_project(args):
    pid, canvas = create_project(str(args.get("name") or "MCP 画布"))
    if args.get("use", True) is not False:
        set_active_project(pid)
    return {"text": f"已新建项目 {pid}「{canvas['name']}」",
            "data": {"id": pid, "name": canvas["name"], "rev": canvas.get("rev")}}


@tool("get_canvas",
      "读画布：节点清单（类型/标题/位置/提示词/工作流/张数）+ 连线。想知道画布上有什么、"
      "某个节点的 id 时用。默认 brief（省 token）；排查问题用 full。",
      {"project": {"type": "string", "description": "项目 id，默认当前项目"},
       "full": {"type": "boolean", "description": "true 时返回完整节点对象（含 graph / slots）"},
       "include_graph": {"type": "boolean", "description": "是否附带每个工作流节点的 API 图（很大，慎用）"}}, [])
def _t_get_canvas(args):
    pid, canvas = resolve_project(args)
    nodes = canvas.get("nodes") or []
    links = canvas.get("links") or []
    full = bool(args.get("full")) or bool(args.get("include_graph"))
    with_graph = bool(args.get("include_graph"))
    lines = [f"{pid}「{canvas.get('name')}」· {len(nodes)} 节点 / {len(links)} 连线 · rev {canvas.get('rev') or 0}"]
    out_nodes = []
    for n in nodes:
        t = n.get("type")
        if t == "text":
            val = str(n.get("value") or "").replace("\n", " ")
            lines.append(f"- {n['id']} 文本「{n.get('title')}」：{val[:60]}{'…' if len(val) > 60 else ''}")
        elif t == "image":
            g = n.get("gen") or {}
            gal = g.get("gallery") or []
            bits = [g.get("wf") or "未选工作流", g.get("aspect") or "1:1", g.get("size") or "1k"]
            if int(g.get("batch") or 1) > 1:
                bits.append(f"{g.get('batch')} 张")
            if g.get("style"):
                bits.append("风格 " + str((g.get("style") or {}).get("cn") or ""))
            lines.append(f"- {n['id']} 图片「{n.get('title')}」· {' / '.join(b for b in bits if b)}"
                         f" · {len(gal)} 张图" + (f" · 提示词：{str(g.get('prompt') or '')[:40]}" if g.get("prompt") else ""))
        elif t == "wf":
            lines.append(f"- {n['id']} 工作流「{n.get('title')}」· {n.get('nodeCount') or '?'} 节点"
                         f" · {len(n.get('artifacts') or [])} 个产物")
        elif t == "out":
            lines.append(f"- {n['id']} 输出「{n.get('title')}」")
        else:
            lines.append(f"- {n['id']} {t}")
        item = {k: n.get(k) for k in ("id", "type", "title", "x", "y", "value", "dataURL", "uploaded")}
        if t == "image" and n.get("gen"):
            g = n["gen"]
            item["gen"] = {k: g.get(k) for k in ("prompt", "wf", "aspect", "size", "custom", "batch",
                                                 "seedMode", "seed", "style", "extras", "idx") if g.get(k) is not None}
            item["gen"]["images"] = len(g.get("gallery") or [])
            item["gen"]["runs"] = len(g.get("runs") or [])
        if full:
            item = json.loads(json.dumps(n, ensure_ascii=False))
            if not with_graph and "graph" in item:
                item["graph"] = f"<{len(item['graph'] or {})} 节点，用 include_graph 取>"
        out_nodes.append(item)
    if links:
        lines.append("连线：")
        for l in links:
            lines.append(f"- {l.get('from')} → {l.get('to')} ({l.get('toKey') or 'in'})")
    return {"text": "\n".join(lines),
            "data": {"id": pid, "name": canvas.get("name"), "rev": int(canvas.get("rev") or 0),
                     "nodes": out_nodes, "links": links, "groups": canvas.get("groups") or []}}


@tool("get_node", "读单个节点的完整内容（含工作流插槽、生成历史、参考图）。",
      {"node": _node_field(), "project": {"type": "string", "description": "项目 id，默认当前项目"}},
      ["node"])
def _t_get_node(args):
    pid, canvas = resolve_project(args)
    n = find_node(canvas, str(args["node"]))
    if not n:
        raise ToolError(f"没有节点 {args['node']}（先 get_canvas 看有哪些）")
    refs = collect_refs(canvas, n) if n.get("type") == "image" else []
    lines = [f"{n['id']} {n.get('type')}「{n.get('title')}」 @ ({n.get('x')}, {n.get('y')})"]
    if n.get("type") == "text":
        lines.append("文本：" + str(n.get("value") or ""))
    if n.get("type") == "image":
        g = n.get("gen") or {}
        lines.append(f"工作流：{g.get('wf')} · {g.get('aspect')} · {g.get('size')} · 张数 {g.get('batch')}")
        lines.append(f"提示词：{g.get('prompt') or '（空）'}")
        lines.append(f"种子：{g.get('seed')}（{g.get('seedMode') or 'random'}）· 历史 {len(g.get('runs') or [])} 次")
        for i, r in enumerate(refs):
            lines.append(f"参考图{i + 1}：{r['node']['id']}「{r['node'].get('title')}」（{r['via']}）")
    if n.get("type") == "wf":
        ks = [f"{s.get('key')} {s.get('kind')}" for s in (n.get("slots") or [])][:12]
        lines.append("插槽：" + "、".join(ks))
    return {"text": "\n".join(lines), "data": {"id": pid, "node": n,
                                               "refs": [r["node"]["id"] for r in refs]}}


@tool("list_workflows", "列出可用工作流（内置预设 + 工作流库），标明「吃不吃图」。选错工作流是出图不对的第一大原因。")
def _t_list_workflows(_args):
    presets = E().list_presets()
    lib = list_library()
    lines = ["内置预设："]
    for p in presets:
        caps = []
        if p.get("takes_image"):
            caps.append("吃图")
        lines.append(f"- preset:{p['file']}「{p['title']}」· {p['nodes']} 节点 · {('、'.join(caps) or '纯文生图')}")
    lines.append("工作流库：")
    if lib:
        for x in lib:
            lines.append(f"- lib:{x['name']} · {x['nodes']} 节点 · {('、'.join(x.get('kinds') or []) or '未知产物')}")
    else:
        lines.append("- （空）")
    return {"text": "\n".join(lines), "data": {"presets": presets, "library": lib}}


@tool("search_styles", "在 397 个 Krea2 风格预设里检索。返回的风格名可以直接传给 add_image_node / set_generation 的 style 参数。",
      {"query": {"type": "string", "description": "中英文关键词，如 动漫 / 胶片 / 油画"},
       "limit": {"type": "integer", "description": "最多返回几条，默认 12"}}, [])
def _t_search_styles(args):
    q = str(args.get("query") or "").strip().lower()
    limit = max(1, min(50, int(args.get("limit") or 12)))
    hits = []
    for ci in style_index():
        for i, e in enumerate(style_pack(ci["id"])):
            hay = f"{e.get('name_cn') or ''} {e.get('name') or ''}".lower()
            if not q or q in hay:
                hits.append({"cat": ci["id"], "cat_label": ci.get("label"), "i": i,
                             "name": e.get("name"), "name_cn": e.get("name_cn")})
                if len(hits) >= limit:
                    break
        if len(hits) >= limit:
            break
    if not hits:
        return {"text": f"没找到和「{q}」相关的风格", "data": {"items": []}}
    lines = [f"{h['name_cn']}（{h['name']}）· {h['cat_label']} · {h['cat']}#{h['i']}" for h in hits]
    return {"text": "\n".join(lines), "data": {"items": hits}}


@tool("add_text_node", "加一个文本节点（提示词）。connect_to 可以直接连到某个图片节点的输入口。",
      {"text": {"type": "string", "description": "节点里的文字"},
       "title": {"type": "string", "description": "标题，默认「提示词」"},
       "connect_to": _node_field("要连到的节点 id（通常是图片节点），可不填"),
       **_pos_props()}, ["text"])
def _t_add_text_node(args):
    pid, canvas = ensure_project()
    x, y = args.get("x"), args.get("y")

    def apply(c):
        ax, ay = auto_pos(c) if x is None or y is None else (x, y)
        n = {"id": next_id(c, "t"), "type": "text", "title": str(args.get("title") or "提示词"),
             "x": int(ax), "y": int(ay), "value": str(args.get("text") or "")}
        c["nodes"].append(n)
        note = ""
        if args.get("connect_to"):
            to = find_node(c, str(args["connect_to"]))
            if not to:
                raise ToolError(f"connect_to 指向的节点不存在：{args['connect_to']}")
            if to.get("type") not in ("image", "text"):
                raise ToolError("文本节点只能连到图片节点或另一个文本节点")
            c["links"].append({"id": next_id(c, "l"), "from": n["id"], "to": to["id"], "toKey": "in"})
            note = f"，已连到 {to['id']}"
        return n, note

    (n, note), _ = mutate(pid, apply)
    return {"text": f"已加文本节点 {n['id']}「{n['title']}」{note}", "data": {"project": pid, "node": n}}


@tool("add_image_node",
      "加一个图片节点（生成器）。参数会写进节点，随后用 run_node 出图。"
      "workflow 用 list_workflows 里的 id；style 用 search_styles 里的中文名；refs 是参考图节点 id 列表。",
      {"prompt": {"type": "string", "description": "提示词（可含 @[图名] 引用参考图）"},
       "workflow": {"type": "string", "description": "preset:xxx.json 或 lib:名字，默认用第一个预设"},
       "aspect": {"type": "string", "enum": ASPECTS, "description": "画幅，默认 1:1"},
       "size": {"type": "string", "enum": ["1k", "2k", "4k", "custom"], "description": "清晰度（长边像素），默认 1k"},
       "width": {"type": "integer", "description": "自定义宽（size=custom 时用）"},
       "height": {"type": "integer", "description": "自定义高（size=custom 时用）"},
       "batch": {"type": "integer", "description": "张数，默认 1"},
       "seed": {"type": "integer", "description": "种子（seed_mode=fixed 时生效）"},
       "seed_mode": {"type": "string", "enum": ["random", "fixed"], "description": "默认 random"},
       "style": {"type": "string", "description": "风格名，如「动漫风格」"},
       "refs": {"type": "array", "items": {"type": "string"}, "description": "参考图节点 id 列表"},
       "title": {"type": "string", "description": "节点标题，默认「图片」"},
       **_pos_props()}, [])
def _t_add_image_node(args):
    pid, canvas = ensure_project()
    wf = load_workflow(args.get("workflow"))
    style = resolve_style(args.get("style")) if args.get("style") else None
    size = str(args.get("size") or "1k")
    custom = None
    if size == "custom":
        if not (args.get("width") and args.get("height")):
            raise ToolError("size=custom 时必须同时给 width 和 height")
        custom = {"w": int(args["width"]), "h": int(args["height"])}
    x, y = args.get("x"), args.get("y")
    refs = [str(r) for r in (args.get("refs") or [])]

    def apply(c):
        for rid in refs:
            if not find_node(c, rid):
                raise ToolError(f"refs 里的节点不存在：{rid}")
        ax, ay = auto_pos(c) if x is None or y is None else (x, y)
        n = {
            "id": next_id(c, "i"), "type": "image", "title": str(args.get("title") or "图片"),
            "x": int(ax), "y": int(ay), "dataURL": None, "uploaded": None,
            "gen": {
                "prompt": str(args.get("prompt") or ""), "wf": wf["id"],
                "aspect": str(args.get("aspect") or "1:1"), "size": size, "custom": custom,
                "batch": max(1, int(args.get("batch") or 1)),
                "seedMode": str(args.get("seed_mode") or "random"),
                "seed": int(args["seed"]) if args.get("seed") is not None else None,
                "gallery": [], "idx": 0, "runs": [], "extras": refs,
                "style": {"cat": style["cat"], "i": style["i"], "cn": style["cn"]} if style else None,
                "status": "",
            },
        }
        c["nodes"].append(n)
        return n

    n, _ = mutate(pid, apply)
    return {"text": f"已加图片节点 {n['id']}「{n['title']}」· 工作流 {wf['label']}"
                    f" · {n['gen']['aspect']} {n['gen']['size']}"
                    + (f" · 风格 {style['cn']}" if style else "")
                    + (f" · 参考图 {len(refs)} 张" if refs else ""),
            "data": {"project": pid, "node": n, "workflow": wf["id"]}}


@tool("add_workflow_node", "加一个工作流节点（把整张 API 图摆到画布上，可调插槽后运行）。",
      {"workflow": {"type": "string", "description": "preset:xxx.json 或 lib:名字"},
       "title": {"type": "string", "description": "标题，默认用工作流标题"},
       **_pos_props()}, ["workflow"])
def _t_add_workflow_node(args):
    pid, canvas = ensure_project()
    wf = load_workflow(args.get("workflow"))
    info = E().analyze_graph(wf["graph"])
    x, y = args.get("x"), args.get("y")

    def apply(c):
        ax, ay = auto_pos(c) if x is None or y is None else (int(x), int(y))
        n = {"id": next_id(c, "w"), "type": "wf", "title": str(args.get("title") or wf["label"]),
             "x": int(ax), "y": int(ay), "graph": wf["graph"],
             "slots": info.get("slots") or [], "outputs": info.get("outputs") or [], "values": {},
             "nodeCount": info.get("node_count") or len(wf["graph"]),
             "unknownTypes": info.get("unknown_types") or [], "artifacts": [],
             "status": "idle", "statusText": f"共 {info.get('node_count') or len(wf['graph'])} 个节点"}
        for s in n["slots"]:
            n["values"][s["key"]] = s.get("value")
        c["nodes"].append(n)
        return n

    n, _ = mutate(pid, apply)
    return {"text": f"已加工作流节点 {n['id']}「{n['title']}」· {n['nodeCount']} 个节点 · {len(n['slots'])} 个可调插槽",
            "data": {"project": pid, "node": n}}


@tool("update_node", "改节点的标题 / 文本内容 / 位置。改提示词请用 set_generation（那个会校验工作流参数）。",
      {"node": _node_field(),
       "title": {"type": "string", "description": "新标题"},
       "text": {"type": "string", "description": "文本节点的新内容"},
       "x": {"type": "number"}, "y": {"type": "number"},
       "project": {"type": "string", "description": "项目 id，默认当前项目"}}, ["node"])
def _t_update_node(args):
    pid, _ = resolve_project(args)

    def apply(c):
        n = find_node(c, str(args["node"]))
        if not n:
            raise ToolError(f"没有节点 {args['node']}")
        if args.get("title") is not None:
            n["title"] = str(args["title"])
        if args.get("text") is not None:
            if n.get("type") != "text":
                raise ToolError("只有文本节点有 text；图片节点的提示词用 set_generation")
            n["value"] = str(args["text"])
        if args.get("x") is not None:
            n["x"] = int(args["x"])
        if args.get("y") is not None:
            n["y"] = int(args["y"])
        return n

    n, _ = mutate(pid, apply)
    return {"text": f"已更新 {n['id']}「{n.get('title')}」", "data": {"project": pid, "node": n}}


@tool("set_generation",
      "改图片节点的生成参数（提示词 / 工作流 / 画幅 / 尺寸 / 张数 / 种子 / 风格 / 参考图）。"
      "只改传进来的字段，其它不动。",
      {"node": _node_field(),
       "prompt": {"type": "string"},
       "workflow": {"type": "string", "description": "preset:xxx.json 或 lib:名字"},
       "aspect": {"type": "string", "enum": ASPECTS},
       "size": {"type": "string", "enum": ["1k", "2k", "4k", "custom"]},
       "width": {"type": "integer"}, "height": {"type": "integer"},
       "batch": {"type": "integer"},
       "seed": {"type": "integer"}, "seed_mode": {"type": "string", "enum": ["random", "fixed"]},
       "style": {"type": "string", "description": "风格名；传空字符串表示取消风格"},
       "refs": {"type": "array", "items": {"type": "string"}, "description": "参考图节点 id 列表（替换）"},
       "project": {"type": "string"}}, ["node"])
def _t_set_generation(args):
    pid, _ = resolve_project(args)
    wf = load_workflow(args["workflow"]) if args.get("workflow") else None
    style = None
    if "style" in args:
        style = resolve_style(args["style"]) if args.get("style") else None
    custom = None
    if args.get("size") == "custom" or (args.get("width") and args.get("height")):
        if not (args.get("width") and args.get("height")):
            raise ToolError("设自定义尺寸要同时给 width 和 height")
        custom = {"w": int(args["width"]), "h": int(args["height"])}

    def apply(c):
        n = find_node(c, str(args["node"]))
        if not n or n.get("type") != "image":
            raise ToolError(f"{args['node']} 不是图片节点")
        g = n.setdefault("gen", {})
        if args.get("prompt") is not None:
            g["prompt"] = str(args["prompt"])
        if wf:
            g["wf"] = wf["id"]
        if args.get("aspect") is not None:
            g["aspect"] = str(args["aspect"])
        if args.get("size") is not None:
            g["size"] = str(args["size"])
        if custom:
            g["custom"] = custom
            g["size"] = "custom"
        if args.get("batch") is not None:
            g["batch"] = max(1, int(args["batch"]))
        if args.get("seed") is not None:
            g["seed"] = int(args["seed"])
        if args.get("seed_mode") is not None:
            g["seedMode"] = str(args["seed_mode"])
        if "style" in args:
            g["style"] = {"cat": style["cat"], "i": style["i"], "cn": style["cn"]} if style else None
        if args.get("refs") is not None:
            for rid in args["refs"]:
                if not find_node(c, str(rid)):
                    raise ToolError(f"refs 里的节点不存在：{rid}")
            g["extras"] = [str(r) for r in args["refs"]]
        return n

    n, _ = mutate(pid, apply)
    g = n["gen"]
    return {"text": f"已更新 {n['id']}：{g.get('aspect')} · {g.get('size')} · {g.get('batch')} 张"
                    f" · 种子 {g.get('seedMode')}"
                    f"{' · 风格 ' + str((g.get('style') or {}).get('cn')) if g.get('style') else ''}",
            "data": {"project": pid, "node": n}}


@tool("delete_nodes", "删除节点（连同挂在它们身上的连线）。",
      {"nodes": {"type": "array", "items": {"type": "string"}, "description": "要删的节点 id 列表"},
       "project": {"type": "string"}}, ["nodes"])
def _t_delete_nodes(args):
    pid, _ = resolve_project(args)
    ids = [str(x) for x in (args.get("nodes") or [])]
    if not ids:
        raise ToolError("nodes 是空的")

    def apply(c):
        before = len(c["nodes"])
        c["nodes"] = [n for n in c["nodes"] if n.get("id") not in ids]
        c["links"] = [l for l in c["links"] if l.get("from") not in ids and l.get("to") not in ids]
        for g in c.get("groups") or []:
            g["nodeIds"] = [x for x in (g.get("nodeIds") or []) if x not in ids]
        return before - len(c["nodes"])

    removed, _ = mutate(pid, apply)
    return {"text": f"已删除 {removed} 个节点", "data": {"project": pid, "removed": removed}}


@tool("connect_nodes", "连线。文本/图片节点之间连到图片的 in 口；连工作流节点要给 to_key（插槽 key）。",
      {"from": _node_field("源节点 id"), "to": _node_field("目标节点 id"),
       "to_key": {"type": "string", "description": "目标插槽 key，默认 in"},
       "project": {"type": "string"}}, ["from", "to"])
def _t_connect_nodes(args):
    pid, _ = resolve_project(args)
    to_key = str(args.get("to_key") or "in")

    def apply(c):
        a, b = find_node(c, str(args["from"])), find_node(c, str(args["to"]))
        if not a or not b:
            raise ToolError("from / to 里有节点不存在")
        if a["id"] == b["id"]:
            raise ToolError("不能连自己")
        key = to_key
        if b.get("type") in ("text", "image"):
            if key not in ("in", ""):
                raise ToolError(f"{b['id']} 只有一个输入口（in）")
            if a.get("type") not in ("text", "image"):
                raise ToolError("只有文本/图片节点能连到输入口")
            key = "in"
        elif b.get("type") == "wf":
            slot = next((s for s in (b.get("slots") or []) if s.get("key") == key), None)
            if not slot:
                raise ToolError(f"{b['id']} 没有插槽 {key}（用 get_node 看 slots）")
            if slot.get("kind") == "text" and a.get("type") != "text":
                raise ToolError("这个插槽要文本节点")
            if slot.get("kind") == "image" and a.get("type") != "image":
                raise ToolError("这个插槽要图片节点")
        elif b.get("type") == "out":
            if a.get("type") != "wf":
                raise ToolError("输出节点只能接工作流节点")
        dup = next((l for l in c["links"] if l.get("from") == a["id"] and l.get("to") == b["id"]
                    and l.get("toKey") == key), None)
        if dup:
            return dup
        link = {"id": next_id(c, "l"), "from": a["id"], "to": b["id"], "toKey": key}
        c["links"].append(link)
        return link

    link, _ = mutate(pid, apply)
    return {"text": f"已连线 {link['from']} → {link['to']} ({link['toKey']})",
            "data": {"project": pid, "link": link}}


@tool("disconnect_nodes", "断开两个节点之间的连线（给 from/to 就只删这一条）。",
      {"from": _node_field("源节点 id"), "to": _node_field("目标节点 id"),
       "project": {"type": "string"}}, ["from", "to"])
def _t_disconnect_nodes(args):
    pid, _ = resolve_project(args)

    def apply(c):
        keep = [l for l in c["links"]
                if not (l.get("from") == args["from"] and l.get("to") == args["to"])]
        removed = len(c["links"]) - len(keep)
        c["links"] = keep
        return removed

    removed, _ = mutate(pid, apply)
    return {"text": f"已断开 {removed} 条连线", "data": {"project": pid, "removed": removed}}


@tool("run_node",
      "跑一个图片节点：构建提交图 → 提交 ComfyUI → （默认）等到出图 → 把结果写回节点。"
      "run_node 之后节点上就有图了，浏览器打开也能看到。",
      {"node": _node_field("图片节点 id"),
       "prompt": {"type": "string", "description": "临时覆盖提示词（也会写回节点）"},
       "wait": {"type": "boolean", "description": "是否等出图，默认 true"},
       "timeout_s": {"type": "number", "description": "最多等多少秒，默认 180"},
       "project": {"type": "string"}}, ["node"])
def _t_run_node(args):
    pid, canvas = resolve_project(args)
    node = find_node(canvas, str(args["node"]))
    if not node:
        raise ToolError(f"没有节点 {args['node']}")
    if node.get("type") != "image":
        raise ToolError(f"{args['node']} 是 {node.get('type')} 节点；run_node 只跑图片节点"
                        f"（工作流节点请在浏览器里调参数后运行）")
    gen = node.setdefault("gen", {})
    if args.get("prompt") is not None:
        gen["prompt"] = str(args["prompt"])
    wf = load_workflow(gen.get("wf"))
    info = E().analyze_graph(wf["graph"])
    slots = info.get("slots") or []
    dims = calc_dims(gen.get("aspect") or "1:1", gen.get("size") or "1k", gen.get("custom"))
    batch = max(1, int(gen.get("batch") or 1))

    refs = collect_refs(canvas, node)
    cap = len([s for s in slots if s.get("kind") == "image"])
    use = refs[:cap] if cap else []
    labels = ref_labels(use)
    images = []
    for r in use:
        images.append(ensure_uploaded(r["node"]))
    prompt = ref_marks(gen.get("prompt") or "", labels)
    style = resolve_style(gen.get("style")) if gen.get("style") else None
    if style:
        prompt = apply_style_prompt(prompt, style["entry"])
    if not prompt.strip():
        raise ToolError("提示词是空的：先给这个节点写 prompt")

    built = build_gen_graph(wf["graph"], slots, dims, batch, prompt, images,
                            gen.get("seedMode") or "random", gen.get("seed"))
    body = json.dumps({"prompt": built["graph"],
                       "client_id": getattr(E(), "client_id", "canvas-progress")}).encode("utf-8")
    status, _, raw = E().comfy_request("POST", "/prompt", body, timeout=60)
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        data = {}
    if status != 200:
        detail = json.dumps(data.get("error") or data, ensure_ascii=False)[:300]
        raise ToolError(f"ComfyUI 拒收了这张图（{status}）：{detail}")
    prompt_id = data.get("prompt_id")
    seed = built["seed"]["value"] if built["seed"] else None

    def stamp(c):
        n = find_node(c, str(args["node"]))
        if not n:
            return None
        g = n.setdefault("gen", {})
        g["pid"] = prompt_id
        if seed is not None:
            g["seed"] = seed
        g["status"] = f"排队中 · {dims['width']}×{dims['height']}"
        # 参考图上传后的文件名也存回去：下次生成不用再传一遍（前端 ensureUploaded 同样口径）
        for r in use:
            rn = find_node(c, r["node"]["id"])
            if rn and r["node"].get("uploaded"):
                rn["uploaded"] = r["node"]["uploaded"]
                rn["subfolder"] = r["node"].get("subfolder") or ""
                rn["dataURL"] = r["node"].get("dataURL") or rn.get("dataURL")
        return None

    try:
        mutate(pid, stamp)
    except ToolError:
        pass

    wait = args.get("wait", True) is not False
    timeout = float(args.get("timeout_s") or 180)
    if not wait:
        return {"text": f"已提交（prompt_id={prompt_id}）· {dims['width']}×{dims['height']} · 种子 {seed}。"
                        f"之后用 job_status 查询。",
                "data": {"project": pid, "node": args["node"], "prompt_id": prompt_id,
                         "seed": seed, **dims}}

    started = time.time()
    state = {"status": "unknown", "artifacts": []}
    while time.time() - started < timeout:
        state = E().job_status(prompt_id) or {}
        if state.get("status") in ("success", "error"):
            break
        time.sleep(1.2)
    secs = int(round(time.time() - started))
    if state.get("status") not in ("success", "error"):
        raise ToolError(f"等了 {secs}s 还没跑完（prompt_id={prompt_id}）。用 job_status 继续查，或在浏览器队列里看进度")

    if state.get("status") == "error":
        msg = str(state.get("error") or "执行失败")[:300]
        try:
            mutate(pid, lambda c: find_node(c, str(args["node"])).setdefault("gen", {}).update(
                {"status": "失败：" + msg}))
        except Exception:  # noqa: BLE001
            pass
        raise ToolError("生成失败：" + msg)

    imgs = [a for a in (state.get("artifacts") or []) if a.get("kind") == "image"]
    gallery = [{"url": view_url(a.get("filename"), a.get("subfolder") or "", a.get("type") or "output"),
                "filename": a.get("filename"), "subfolder": a.get("subfolder") or "",
                "type": a.get("type") or "output"} for a in imgs]
    run = {"at": int(time.time() * 1000), "prompt": gen.get("prompt") or "", "seed": seed,
           "w": dims["width"], "h": dims["height"], "batch": batch, "wf": gen.get("wf") or "",
           "style": dict(gen["style"]) if gen.get("style") else None, "items": gallery}

    def apply(c):
        n = find_node(c, str(args["node"]))
        if not n:
            raise ToolError("画布在生成期间被删掉了，结果没地方放")
        g = n.setdefault("gen", {})
        g["gallery"] = gallery
        g["idx"] = 0
        if gallery:
            n["dataURL"] = gallery[0]["url"]
            n["uploaded"] = None
        g["seed"] = seed
        g["pid"] = prompt_id
        runs = g.setdefault("runs", [])
        runs.insert(0, run)
        del runs[RUN_CAP:]
        g["status"] = f"完成 · {secs}s · {len(gallery)} 张"
        return n

    mutate(pid, apply)
    head = (f"生成完成 · {secs}s · {dims['width']}×{dims['height']} · 种子 {seed} · {len(gallery)} 张")
    if not gallery:
        head = f"任务完成但没有任何图片产物 · {secs}s（检查工作流里有没有 SaveImage）"
    notes = []
    if built["seed"] and built["batch"]["value"] > 1 and not built["batch"]["applied"]:
        notes.append("张数不生效：这张工作流没有批量插槽")
    if not built["sized"]:
        notes.append("尺寸由工作流决定（没有宽高落点）")
    if built["pruned"]:
        notes.append(f"忽略工作流自带图 {len(built['pruned'])} 张")
    text = head + ("\n" + "；".join(notes) if notes else "")
    for gitem in gallery:
        text += f"\n- {gitem['url']}"
    return {"text": text,
            "data": {"project": pid, "node": args["node"], "prompt_id": prompt_id,
                     "seed": seed, **dims, "images": gallery, "notes": notes}}


@tool("job_status", "查一个 ComfyUI 任务的状态（queued / running / success / error）与产物。",
      {"prompt_id": {"type": "string"}}, ["prompt_id"])
def _t_job_status(args):
    st = E().job_status(str(args["prompt_id"]))
    status = st.get("status")
    arts = st.get("artifacts") or []
    line = f"{args['prompt_id']}：{status}"
    if st.get("error"):
        line += f" · {st['error']}"
    if arts:
        line += f" · {len(arts)} 个产物"
    return {"text": line, "data": {"prompt_id": args["prompt_id"], **st}}


@tool("cancel_job", "取消任务：给 prompt_id 从队列里删掉；给 node 则取消该节点当前那次。",
      {"prompt_id": {"type": "string"}, "node": _node_field("图片节点 id"),
       "interrupt": {"type": "boolean", "description": "是否同时打断正在跑的那个"},
       "project": {"type": "string"}}, [])
def _t_cancel_job(args):
    pid = None
    prompt_id = str(args.get("prompt_id") or "")
    if not prompt_id and args.get("node"):
        pid, canvas = resolve_project(args)
        n = find_node(canvas, str(args["node"]))
        prompt_id = str(((n or {}).get("gen") or {}).get("pid") or "")
        if not prompt_id:
            raise ToolError(f"{args['node']} 上没有正在跑的任务")
    if not prompt_id:
        raise ToolError("要么给 prompt_id，要么给 node")
    body = json.dumps({"delete": [prompt_id]}).encode("utf-8")
    E().comfy_request("POST", "/queue", body, timeout=30)
    if args.get("interrupt"):
        E().comfy_request("POST", "/interrupt", b"{}", timeout=30)
    if pid and args.get("node"):
        try:
            mutate(pid, lambda c: find_node(c, str(args["node"])).setdefault("gen", {}).update(
                {"status": "已取消", "pid": None}))
        except Exception:  # noqa: BLE001
            pass
    return {"text": f"已取消 {prompt_id}", "data": {"prompt_id": prompt_id}}


@tool("list_runs", "看一个图片节点的生成历史（每次的时间 / 提示词 / 种子 / 尺寸 / 张数）。想复现某一张时从这里拿种子。",
      {"node": _node_field(), "project": {"type": "string"}}, ["node"])
def _t_list_runs(args):
    pid, canvas = resolve_project(args)
    n = find_node(canvas, str(args["node"]))
    if not n or n.get("type") != "image":
        raise ToolError(f"{args['node']} 不是图片节点")
    runs = (n.get("gen") or {}).get("runs") or []
    if not runs:
        return {"text": f"{args['node']} 还没有生成记录", "data": {"runs": []}}
    lines = [f"{args['node']}「{n.get('title')}」· {len(runs)} 次"]
    for i, r in enumerate(runs):
        t = time.strftime("%m-%d %H:%M", time.localtime((r.get("at") or 0) / 1000))
        lines.append(f"{i + 1}. {t} · {r.get('w')}×{r.get('h')} · 种子 {r.get('seed')} · "
                     f"{len(r.get('items') or [])} 张 · {str(r.get('prompt') or '')[:40]}")
    return {"text": "\n".join(lines), "data": {"node": args["node"], "runs": runs}}


@tool("upload_image", "把本地图片上传到 ComfyUI 并建成一个图片节点（可当参考图/图生图输入）。",
      {"path": {"type": "string", "description": "本地文件绝对路径"},
       "data": {"type": "string", "description": "也可以直接给 data:image/... 的 base64"},
       "title": {"type": "string", "description": "节点标题，默认文件名"},
       **_pos_props()}, [])
def _t_upload_image(args):
    pid, canvas = ensure_project()
    if args.get("path"):
        p = Path(str(args["path"]))
        if not p.exists() or not p.is_file():
            raise ToolError(f"文件不存在：{p}")
        raw = p.read_bytes()
        name = p.name
    elif args.get("data"):
        u = str(args["data"])
        if u.startswith("data:"):
            head, _, payload = u.partition(",")
            raw = base64.b64decode(payload) if ";base64" in head else urllib.parse.unquote_to_bytes(payload)
        else:
            raw = base64.b64decode(u)
        name = "upload.png"
    else:
        raise ToolError("给 path 或 data 其中一个")
    up = upload_bytes(raw, _safe_filename(f"up-{int(time.time() * 1000)}-{name}"))
    fname = up.get("name") or name
    sub = up.get("subfolder") or ""
    atype = up.get("type") or "input"
    url = view_url(fname, sub, atype)
    x, y = args.get("x"), args.get("y")

    def apply(c):
        ax, ay = auto_pos(c) if x is None or y is None else (int(x), int(y))
        n = {"id": next_id(c, "i"), "type": "image", "title": str(args.get("title") or name),
             "x": int(ax), "y": int(ay), "dataURL": url, "uploaded": fname, "subfolder": sub, "gen": None}
        c["nodes"].append(n)
        return n

    n, _ = mutate(pid, apply)
    return {"text": f"已上传并建节点 {n['id']}「{n['title']}」· {fname}", "data": {"project": pid, "node": n}}


# --------------------------------------------------------------------------- #
# JSON-RPC 分发
# --------------------------------------------------------------------------- #
def _rpc_result(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _rpc_error(rid, code, message, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": rid, "error": err}


def error_response(code: int, message: str) -> dict:
    """给 HTTP 外壳用：请求体连 JSON 都不是的时候，也得按 JSON-RPC 的口径回错。"""
    return _rpc_error(None, code, message)


def _tool_payload(out) -> dict:
    if isinstance(out, str):
        return {"content": [{"type": "text", "text": out}]}
    text = str(out.get("text") or "")
    payload = {"content": [{"type": "text", "text": text}]}
    data = out.get("data")
    if isinstance(data, dict):
        payload["structuredContent"] = data
    return payload


def _call_tool(name: str, args: dict) -> dict:
    t = TOOLS.get(name)
    if not t:
        raise ToolError(f"没有这个工具：{name}（tools/list 看有哪些）")
    if not isinstance(args, dict):
        raise ToolError("arguments 必须是对象")
    return t["handler"](args)


def handle(payload):
    """处理一条 JSON-RPC 消息；返回响应 dict，通知返回 None。"""
    if isinstance(payload, list):
        out = [r for r in (handle(x) for x in payload) if r is not None]
        return out or None
    if not isinstance(payload, dict):
        return _rpc_error(None, -32600, "不是合法的 JSON-RPC 请求")
    rid = payload.get("id")
    is_notification = "id" not in payload
    method = payload.get("method")
    params = payload.get("params") or {}
    if not isinstance(method, str):
        return None if is_notification else _rpc_error(rid, -32600, "缺少 method")

    if method == "initialize":
        asked = str((params or {}).get("protocolVersion") or "")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        # 顶栏那盏灯靠这一句点亮：握手成功 = 有 AI 能直接操作这块画布了
        _mark_connected((params or {}).get("clientInfo"), version)
        result = {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": ("InfiSheet 是本地 ComfyUI 的无限画布。典型用法：add_image_node → run_node；"
                             "或 get_canvas 看现有内容后 set_generation 改参数再 run_node。"
                             "工作流能力（吃不吃图）用 list_workflows 查，别按名字猜。"),
        }
        return None if is_notification else _rpc_result(rid, result)
    if method in ("notifications/initialized", "initialized", "notifications/cancelled"):
        if method != "notifications/cancelled" and _CONN["connected"]:
            _CONN["live"] = True
            _CONN["last"] = time.time()
        return None
    if method == "ping":
        return None if is_notification else _rpc_result(rid, {})
    if method == "tools/list":
        tools = [{"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]}
                 for t in TOOLS.values()]
        return None if is_notification else _rpc_result(rid, {"tools": tools})
    if method == "tools/call":
        name = str((params or {}).get("name") or "")
        args = (params or {}).get("arguments") or {}
        _CONN["calls"] += 1
        _touch()
        try:
            out = _call_tool(name, args)
            result = _tool_payload(out)
        except ToolError as exc:
            result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
        except ConnectionError as exc:
            result = {"content": [{"type": "text",
                                   "text": f"连不上 ComfyUI：{exc}。确认 ComfyUI 在 8188 上跑着。"}],
                      "isError": True}
        except Exception as exc:  # noqa: BLE001
            result = {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
                      "isError": True}
        return None if is_notification else _rpc_result(rid, result)
    if method in ("resources/list", "prompts/list", "resources/templates/list"):
        key = {"resources/list": "resources", "prompts/list": "prompts",
               "resources/templates/list": "resourceTemplates"}[method]
        return None if is_notification else _rpc_result(rid, {key: []})
    if is_notification:
        return None
    return _rpc_error(rid, -32601, f"不支持的方法：{method}")


# --------------------------------------------------------------------------- #
# stdio 桥：客户端拉起的这个进程只做转发，真正的实现在 server.py 里。
# 这样 HTTP 与 stdio 只有一份逻辑，不会出现「两边行为不一样」。
# --------------------------------------------------------------------------- #
def _http_post(url: str, payload, session=None, timeout: float = 900.0,
               client: str = "", host: str = ""):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if session:
        req.add_header("Mcp-Session-Id", session)
    # 「是谁在用它」由桥带上：服务重启后客户端不会重新握手，那时服务端只剩下这条线索。
    # 两个头分工不同：X-MCP-Client 是客户端**自报**的（可能不可靠，见 _SELF_NAME），
    # X-MCP-Host 是桥所在进程的父进程名（客户端没法伪造，也不需要配合）。
    if client:
        req.add_header("X-MCP-Client", client)
    if host:
        req.add_header("X-MCP-Host", host)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        sid = res.headers.get("Mcp-Session-Id")
        raw = res.read()
        return (json.loads(raw.decode("utf-8")) if raw.strip() else None), sid


def _wait_server(port: int, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/projects", timeout=1.5) as res:
                if res.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    return False


def _spawn_server(port: int) -> None:
    server_py = Path(__file__).resolve().parent / "server.py"
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008          # DETACHED_PROCESS：桥退出后服务还活着
    subprocess.Popen(
        [sys.executable, "-X", "utf8", str(server_py), "--port", str(port), "--no-browser"],
        cwd=str(server_py.parent), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)


# 本机请求不走代理：开发机上常有 HTTP_PROXY=127.0.0.1:xxxx，代理一转手就 502。
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _heartbeat_loop(port: int, who: dict) -> None:
    """每 lease/3 秒敲一次 /api/mcp/heartbeat，直到进程退出。

    这是「断开」唯一可靠的信号：桥是客户端拉起来的，客户端关窗 / 崩溃 / 被任务管理器
    杀掉，桥跟着没了，心跳也就停了，服务端过了租约就把这条接入判成离线。
    间隔由服务端回的 lease 算（默认 30s → 10s 一次），改租约不用同时改桥；
    第一拍立刻发，这样「服务重启后客户端续接」不用等一个周期灯才亮。
    """
    url = f"http://127.0.0.1:{port}/api/mcp/heartbeat"
    interval = 10.0
    while True:
        try:
            req = urllib.request.Request(url, data=b"{}", method="POST")
            req.add_header("Content-Type", "application/json")
            if who.get("spec"):
                req.add_header("X-MCP-Client", who["spec"])
            if who.get("host"):
                req.add_header("X-MCP-Host", who["host"])
            with _LOCAL.open(req, timeout=3) as res:
                info = json.loads(res.read().decode("utf-8") or "{}")
            secs = float(info.get("lease") or 0)
            if secs:
                interval = max(1.0, secs / 3.0)
        except Exception:  # noqa: BLE001 — 服务没起来 / 正在重启：下一拍再试，别打扰客户端
            pass
        time.sleep(interval)


def stdio_main(port: int = 8788, autostart: bool = True) -> int:
    # Windows 上 stdin/stdout 默认是 cp936：客户端发来的 JSON 是 UTF-8，
    # 中文提示词走到这里会变成乱码或直接 UnicodeDecodeError（协议通道没有乱码的余地）。
    # 这里把三条流都钉成 UTF-8；客户端配置里再加 `-X utf8` 是第二道保险。
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="strict")
        except Exception:  # noqa: BLE001
            pass
    url = f"http://127.0.0.1:{port}/mcp"
    session = {"id": None}
    spawned = {"done": False}
    # 从 initialize 的 clientInfo 里记下「是谁」，之后每一次转发都带上。
    # 客户端换会话之前不会再说一遍，服务端重启后这是唯一的身份来源。
    # host 是「谁把我拉起来的」：客户端自报的名字可能是服务器别名（甚至是占位词），
    # 进程树里的父进程不需要客户端配合，是这条链路上唯一没法被它自说自话的信息。
    who = {"spec": "", "host": host_app()}
    sys.stderr.write(f"[infisheet-mcp] stdio 桥启动 → {url}"
                     f"（宿主 {who['host'] or '未知'}）\n")
    sys.stderr.flush()
    # 保活：桥活着就替这次接入续租。daemon 线程随进程一起消失，不用收尾——
    # 进程没了心跳自然停，正是我们要的信号。
    threading.Thread(target=_heartbeat_loop, args=(port, who), name="mcp-heartbeat",
                     daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            msg = json.loads(line)
            rid = msg.get("id") if isinstance(msg, dict) else None
        except Exception:  # noqa: BLE001
            sys.stdout.write(json.dumps(_rpc_error(None, -32700, "JSON 解析失败"), ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        if isinstance(msg, dict) and msg.get("method") == "initialize":
            info = (msg.get("params") or {}).get("clientInfo") or {}
            name = str(info.get("name") or "").strip()
            if name:
                who["spec"] = f"{name}/{str(info.get('version') or '').strip()}"[:80]
        resp, sid = None, None
        try:
            resp, sid = _http_post(url, msg, session["id"], client=who["spec"], host=who["host"])
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            # 服务没起来：拉一次（只拉一次，别每个请求都开一个新进程）
            if autostart and not spawned["done"]:
                spawned["done"] = True
                sys.stderr.write("[infisheet-mcp] 服务没在跑，自动拉起 server.py…\n")
                sys.stderr.flush()
                _spawn_server(port)
                if _wait_server(port):
                    try:
                        resp, sid = _http_post(url, msg, session["id"], client=who["spec"], host=who["host"])
                    except Exception as exc:  # noqa: BLE001
                        resp = _rpc_error(rid, -32603, f"连不上 InfiSheet 服务：{exc}")
                else:
                    resp = _rpc_error(rid, -32603, "拉起 server.py 超时（25s）；手动跑 python server.py 看看报什么错")
            else:
                resp = _rpc_error(rid, -32603, f"连不上 InfiSheet 服务（127.0.0.1:{port}）")
        except Exception as exc:  # noqa: BLE001
            resp = _rpc_error(rid, -32603, f"转发失败：{exc}")
        if sid:
            session["id"] = sid
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="InfiSheet MCP stdio 桥（HTTP 实现由 server.py 提供）")
    ap.add_argument("--port", type=int, default=int(os.environ.get("INFISHEET_PORT") or 8788),
                    help="server.py 的端口（默认 8788）")
    ap.add_argument("--no-autostart", action="store_true", help="服务没跑时不自动拉起")
    a = ap.parse_args(argv)
    try:
        return stdio_main(a.port, not a.no_autostart)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
