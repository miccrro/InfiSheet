#!/usr/bin/env python3
"""InfiSheet · 无限画布 · 本地服务

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
import types
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import mcp_server

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PRESETS = ROOT / "presets"


def default_data_dir() -> Path:
    """运行时数据目录（画布快照 + 工作流库）。

    优先级：INFISHEET_DATA > 程序目录下的 ./data（老用户原地不动）> 平台标准目录。
    为什么要离开 ./data：程序被放进只读位置（/opt、Program Files、.app 包内）时，
    往自己目录里写会直接失败；macOS / Linux 上装到 Applications 或 /usr/local 很常见。
    """
    env = os.environ.get("INFISHEET_DATA")
    if env:
        return Path(env).expanduser()
    legacy = ROOT / "data"
    if legacy.is_dir():                      # 已经在用旧目录：沿用，不搬数据（搬了老用户的画布就"消失"了）
        return legacy
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "InfiSheet"


DATA = default_data_dir()
LIBRARY = DATA / "library"

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")

# 地址是从哪来的：默认 / 环境变量 / 设置里保存的 / 命令行。界面上要如实说一句，
# 否则「我改了怎么又回去了」会变成玄学（多半是环境变量或 --comfy 又把它盖回去了）。
COMFY_SOURCE = "环境变量 COMFY_URL" if os.environ.get("COMFY_URL") else "默认"

DEFAULT_COMFY_URL = "http://127.0.0.1:8188"


def settings_file() -> Path:
    return DATA / "settings.json"


def load_settings() -> dict:
    """运行期可改的设置（目前只有 ComfyUI 地址）。读坏了就当没有，不让一个坏文件挡住启动。"""
    try:
        data = json.loads(settings_file().read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def save_settings(patch: dict) -> None:
    """先写 .tmp 再 replace：写到一半断电，不会留下半个 JSON 把下次启动卡住。"""
    data = load_settings()
    data.update(patch)
    target = settings_file()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(target)


def normalize_comfy_url(raw) -> str:
    """把用户手输的地址收成 http(s)://host[:port][/前缀]。

    常见写法都要认：「<局域网IP>:8188」「127.0.0.1:8188/」「http://host:8188/」。
    端口写错在这里就拦住，别等到连接超时才给一句「无法连接」。
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("地址不能为空")
    if any(ch in text for ch in (" ", "\t", "\r", "\n")):
        raise ValueError("地址里不能有空格")
    if "://" not in text:
        text = "http://" + text          # 光写 host:port 是最常见的手输形式
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("只支持 http:// 或 https://")
    if not parsed.hostname:
        raise ValueError("缺少主机名（例如 127.0.0.1:8188）")
    try:
        port = parsed.port
    except ValueError as exc:
        # urlsplit 在「端口不是数字」和「端口超出 0~65535」时都会抛，措辞要能同时覆盖
        raise ValueError("端口不对（要 1~65535 的数字，例如 8188）") from exc
    if port is not None and not (1 <= port <= 65535):
        raise ValueError("端口要在 1~65535 之间")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


def set_comfy_url(url: str, source: str) -> None:
    """换地址时要一起清掉「跟地址绑定」的东西，否则换了机器还在用旧机器的缓存。"""
    global COMFY_URL, COMFY_SOURCE, ASSET_CACHE
    COMFY_URL = url
    COMFY_SOURCE = source
    with _oi_lock:
        _oi_cache.clear()                       # 节点定义（object_info）是按 ComfyUI 缓存
    ASSET_CACHE = {"at": 0.0, "limit": 0, "items": [], "comfy": True, "error": None}
    _drop_progress_ws()                         # 进度 ws 连着旧地址：断开，让它在下一拍连新的


def comfy_error_hint(exc) -> str:
    """把 urllib 的英文异常翻成「下一步该查什么」。

    换一台电脑连不上 ComfyUI 时，原始报错是 `<urlopen error [Errno 61] Connection refused>`
    —— 用户看不出是「ComfyUI 没开」「端口不对」还是「防火墙」。这里按常见几类给一句话。
    """
    text = str(exc)
    low = text.lower()
    if "connection refused" in low or "errno 61" in low or "errno 111" in low:
        return f"{COMFY_URL} 端口没有服务（ComfyUI 没启动，或者端口不对）"
    if "timed out" in low or "timeout" in low:
        return f"{COMFY_URL} 连接超时（IP / 防火墙不对，或 ComfyUI 只监听了 127.0.0.1）"
    if any(k in low for k in ("name or service not known", "nodename nor servname",
                              "getaddrinfo", "temporary failure in name resolution")):
        return f"{COMFY_URL} 解析不了这个主机名（写错了？换成 IP 试试）"
    if "certificate" in low or "ssl" in low:
        return f"{COMFY_URL} HTTPS 握手失败（证书 / 协议不对；本机 ComfyUI 一般用 http://）"
    return text


def comfy_state(probe: bool = True) -> dict:
    """当前 ComfyUI 连接状态。probe=True 时顺手问一次 /system_stats（设置面板要显示能不能连上）。"""
    out = {"ok": True, "url": COMFY_URL, "source": COMFY_SOURCE, "reachable": False}
    if not probe:
        return out
    t0 = time.time()
    try:
        stats = comfy_json("/system_stats", timeout=5)
        sysinfo = stats.get("system") or {}
        out.update({
            "reachable": True,
            "version": sysinfo.get("comfyui_version"),
            "devices": stats.get("devices") or [],
            "ms": int((time.time() - t0) * 1000),
        })
    except Exception as exc:  # noqa: BLE001
        out["error"] = comfy_error_hint(exc)
    return out


# 局域网访问令牌（--token / INFISHEET_TOKEN）。空 = 不校验，只接受本机访问（默认行为）。
# 只对非回环来源生效：MCP 的 stdio 桥和本机浏览器始终走 127.0.0.1，不该被令牌挡住。
TOKEN = os.environ.get("INFISHEET_TOKEN", "").strip()

# mimetypes 依赖系统 mime 表：极简 Linux 容器里没有 /etc/mime.types 时，
# .webp / .woff2 会被猜成 application/octet-stream，浏览器直接不认。
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"),
                    (".css", "text/css"), (".json", "application/json"),
                    (".webp", "image/webp"), (".woff2", "font/woff2"),
                    (".avif", "image/avif"), (".svg", "image/svg+xml")):
    mimetypes.add_type(_type, _ext)

# 实际监听的端口（main() 里回填）。MCP 的安装面板要把「客户端该连哪个端口」写进配置，
# 而它可能不是默认的 8788。
PORT = 8788

# serve_forever 的那个实例（main() 里回填）。「关闭服务」按钮要能把循环停掉——
# 没有它就只能 os.kill 自己，端口释放和连接收尾都得靠运气。
SERVER = None

# 输出类节点：从 /history 里取产物时用得上的节点类型
OUTPUT_TYPES = {
    "SaveImage", "PreviewImage", "SaveImageAdvanced", "SaveVideo", "PreviewVideo", "CreateVideo",
    "VHS_VideoCombine", "SaveAudio", "PreviewAudio", "SaveAnimatedWEBP",
}

_oi_cache: dict[str, dict] = {}
_oi_lock = threading.Lock()

# --------------------------------------------------------------------------- #
# 进度：后端订阅 ComfyUI 的 websocket（浏览器直连会被 ComfyUI 的 Origin 校验挡掉）
#
# 关键：ComfyUI 的 progress / progress_state 事件是**指名发给提交任务的那个 client_id**
# 的（server.py: send_json 里 `elif sid in self.sockets`）。所以监听用的 clientId 和
# /prompt 里带的 client_id 必须是同一个字符串，否则一条都收不到——之前两边一个写死
# 「canvas-progress」、一个随机 uuid，于是画布上永远只有「生成中…」没有百分比。
# （所以下面这个常量是唯一出处：别的文件里再写一遍这个字符串，进度就又哑了）
# --------------------------------------------------------------------------- #
PROGRESS_CLIENT = "canvas-progress"
PROGRESS: dict[str, int] = {}
PROGRESS_NODES: dict[str, dict[str, tuple[float, float]]] = {}
PROGRESS_LOCK = threading.Lock()
_ws_started = False
_ws_sock = None
_ws_lock = threading.Lock()


def _progress_update(pid, node_id, value, total) -> None:
    """把「某个节点跑到第几步」累加成整条任务的百分比。

    两种消息都往同一张表里记，按节点 id 去重：
    - progress_state：一条消息带所有节点的 value/max（新版 ComfyUI，5.x 起）；
    - progress：一次一个节点（老版本）。两种是同时发的，写的是同一组数字。

    两条硬规则，都是实测踩出来的：

    1. **只算「有步数」的节点**（max > 1）。progress_state 会把 VAEDecode / SaveImage /
       CLIPTextEncode / EmptyLatentImage 这些一次性节点也列进来，它们的 max 恒为 1 ——
       一进分母，百分比当场往回跳。Krea2 实测：采样跑满 99%，开始解码那一下变成 94%
       （14/14 → 14/15），用户看到的就是「进度倒退」。
    2. **不做全局「只许往前」**（试过）：多采样器工作流里，第二个采样器开工时和「解码挤进
       分母」长得很像，一刀切禁掉会让第二个采样器的整段过程都显示 99%。真正该挡的是第 1 条，
       剩下的往后退都是真的（比如同一节点被重跑）。

    分子 = 各采样器已跑步数之和，分母 = 各采样器步数之和。只按「当前那个节点」算会在
    多采样器工作流里从 100% 跳回 0%（Qwen 的 refiner 链就是），看着像重来了。
    """
    if not pid or not total or not isinstance(value, (int, float)):
        return
    key = str(node_id if node_id is not None else "")
    with PROGRESS_LOCK:
        if len(PROGRESS_NODES) > 300:      # 任务表不清理，长跑一天也就这么多
            PROGRESS_NODES.clear()
            PROGRESS.clear()
        nodes = PROGRESS_NODES.setdefault(str(pid), {})
        # 同一节点重跑（自动重试/重采样）时 value 会退回 0，直接覆盖，不要把进度钉死
        nodes[key] = (float(value), float(total))
        # 只有 max > 1（真按步跑）的节点才算数。**不能**「一个都没有时退回全部节点」：
        # 采样器开工前那一瞬间表里只有 EmptyLatentImage(1/1)、CLIPTextEncode(0/1) 这些，
        # 退回全部就会算出 50% → 67% → 7% 这种先跳高再掉下来的假数字（实测抓到过）。
        # 采样器还没报数时干脆不写，前端照旧显示「生成中…」。
        pool = [v for v in nodes.values() if v[1] > 1]
        steps = sum(m for _, m in pool)
        if steps <= 0:
            return
        done = sum(v for v, _ in pool)
        # 99 封顶：采样器跑满时解码还没完，写 100 会「卡在 100% 等很久」
        PROGRESS[str(pid)] = max(0, min(99, int(round(done / steps * 100))))


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
    global _ws_sock
    while True:
        sock = None
        try:
            parsed = urllib.parse.urlparse(COMFY_URL)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or 80
            sock = socket.create_connection((host, port), timeout=10)
            with _ws_lock:
                _ws_sock = sock            # 换地址时要能从这里把它掐断（见 _drop_progress_ws）
            key = base64.b64encode(os.urandom(16)).decode()
            sock.sendall(
                (f"GET /ws?clientId={PROGRESS_CLIENT} HTTP/1.1\r\nHost: {host}:{port}\r\n"
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
                if msg.get("type") not in ("progress", "progress_state"):
                    continue
                d = msg.get("data") or {}
                if msg.get("type") == "progress":
                    _progress_update(d.get("prompt_id"), d.get("node"), d.get("value"), d.get("max"))
                else:
                    pid = d.get("prompt_id")
                    for node_id, st in (d.get("nodes") or {}).items():
                        if isinstance(st, dict):
                            _progress_update(pid, node_id, st.get("value"), st.get("max"))
        except Exception:
            time.sleep(3)
        finally:
            with _ws_lock:
                if _ws_sock is sock:
                    _ws_sock = None
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
            time.sleep(1)


def _drop_progress_ws() -> None:
    """掐断当前进度连接，让 _ws_loop 用新地址重连。

    不掐的话：换了 ComfyUI 地址，旧连接还挂在那台机器上，进度条会一直是 0——
    而且看起来像「新地址没生效」，最难查。
    """
    with _ws_lock:
        sock = _ws_sock
    if not sock:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except Exception:  # noqa: BLE001
        pass
    try:
        sock.close()
    except Exception:  # noqa: BLE001
        pass


def start_progress_ws() -> None:
    global _ws_started
    if _ws_started:
        return
    _ws_started = True
    threading.Thread(target=_ws_loop, daemon=True).start()


# --------------------------------------------------------------------------- #
# 进度兜底：读 ComfyUI 控制台日志里的 tqdm 行
#
# websocket 那条链路有时会整段哑掉——ComfyUI 刚重启、client_id 撞车、局域网抖一下，
# 表现都是「跑到一半数字没了」或者「一直只有『生成中…』」。而 ComfyUI 自己把 tqdm 的
# 进度行（` 42%|███  | 10/25 [00:12<00:18]`）也写进了控制台日志，`GET /internal/logs/raw`
# 就能拿到——那是它亲口说的数字，做兜底最稳。
#
# 两条硬规则：
#   1. **只认「这一单提交之后」的行**。日志是最近 300 条的环形缓冲，里面永远躺着上一单
#      的 `100%|25/25`；不按时间过滤的话，新任务刚提交就会顶着 100% 一动不动。
#   2. **单独存 PROGRESS_LOG，不并进 PROGRESS**。并进去就成了「日志 + 真节点」两个来源
#      一起算，百分比会翻倍；兜底就是兜底，只在 websocket 一个数都没有时才拿出来用。
# --------------------------------------------------------------------------- #
PROGRESS_LOG: dict[str, int] = {}
PROMPT_START: dict[str, float] = {}
_LOG_TQDM = re.compile(r"(\d{1,3})%\|.*?(\d+)/(\d+)")
_LOG_TS = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?")
_log_cache: dict = {"at": 0.0, "entries": []}
_log_lock = threading.Lock()


def _log_entries() -> list:
    """ComfyUI 控制台日志条目（1 秒缓存）。

    多个节点同时轮询时只打一次接口；老版本 ComfyUI 没有这个路由，读不到就当没有，
    绝不让它影响主链路（进度本来就有 websocket 那份）。
    """
    now = time.time()
    with _log_lock:
        if now - _log_cache["at"] < 1.0:
            return _log_cache["entries"]
    try:
        data = comfy_json("/internal/logs/raw", timeout=4)
        entries = data.get("entries") if isinstance(data, dict) else data
        if not isinstance(entries, list):
            entries = []
    except Exception:  # noqa: BLE001
        entries = []
    with _log_lock:
        _log_cache["at"] = now
        _log_cache["entries"] = entries
    return entries


def _log_stamp(text) -> float | None:
    """把日志条目的 `t`（本地时间字符串）换成 epoch 秒；认不出来就 None。"""
    m = _LOG_TS.match(str(text or ""))
    if not m:
        return None
    y, mo, d, hh, mm, ss, frac = m.groups()
    try:
        stamp = time.mktime((int(y), int(mo), int(d), int(hh), int(mm), int(ss), 0, 0, -1))
    except (ValueError, OverflowError):
        return None
    return stamp + (float("0." + frac) if frac else 0.0)


def _log_progress(pid) -> int | None:
    """从控制台日志里捞这一单的百分比（0~99）；捞不到就 None。

    取**最后一条** tqdm 行：多采样器工作流里日志是一行行覆盖的，最新那行就是当前
    正在跑的那个节点。100% 压成 99——采样器跑满时解码/保存还没完，写 100 会卡着不动。
    """
    key = str(pid or "")
    started = PROMPT_START.get(key)
    if not started:
        return None
    pct = None
    for ent in _log_entries():
        if not isinstance(ent, dict):
            continue
        m = _LOG_TQDM.search(ent.get("m") or "")
        if not m:
            continue
        stamp = _log_stamp(ent.get("t"))
        # 留 3 秒余量：/prompt 落地到第一行 tqdm 之间，两边时钟可能差那么一点
        if stamp is not None and stamp < started - 3:
            continue
        pct = int(m.group(1))
    if pct is None:
        return None
    pct = max(0, min(99, pct))
    PROGRESS_LOG[key] = pct
    return pct


# --------------------------------------------------------------------------- #
# ComfyUI 通信
# --------------------------------------------------------------------------- #
# 直连，不走环境变量里的 HTTP_PROXY / HTTPS_PROXY。
# 为什么必须显式关掉：urllib 默认读 http_proxy，而 ComfyUI 是本机 / 局域网服务——
# 开着 Clash、公司代理、VPN 的机器上，请求会被代理接走，返回一个 502，
# 于是「ComfyUI 没开」和「代理把它吃了」在界面上长得一模一样（实测本机就是这样：
# 127.0.0.1:8188 明明没开，报的却是「/system_stats 返回 502」）。
# 代理是给外网用的，本地服务直连永远是对的。
_COMFY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
        with _COMFY_OPENER.open(req, timeout=timeout) as resp:
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
            # 遮罩入口（LoadImageMask）不再暴露：遮罩功能已移除。留着它只会退化成
            # 一个「文件名下拉」，用户选了也不生效——比没有更糟。
            if ct == "LoadImageMask" and name == "image":
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
        return _assets_with_lib(ASSET_CACHE["items"], limit, cached=True,
                                comfy=ASSET_CACHE["comfy"], error=ASSET_CACHE["error"])
    try:
        hist = comfy_json(f"/history?max_items={max(limit, 100)}", timeout=30)
    except Exception as exc:  # noqa: BLE001
        ASSET_CACHE = {"at": now, "limit": limit, "items": [], "comfy": False, "error": str(exc)}
        return _assets_with_lib([], limit, cached=False, comfy=False, error=str(exc))

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
    return _assets_with_lib(items, limit, cached=False, comfy=True, error=None)


# --------------------------------------------------------------------------- #
# 资产库：分组、归属、移除——这三样 ComfyUI 一概不知道，是本项目自己的用户数据
#
# 存 DATA/asset-lib.json，结构就两个字典：
#   {"groups": [{"id": "g1", "name": "人像"}],
#    "items":  {"output:/a.png": {"group": "g1", "hidden": true}}}
#
# 为什么不并进 workflow_categories.json：那是「工作流的分类」，删一个分类得先把工作流
# 挪到「其他」；资产分组是纯标签，两者生命周期不同，混一个文件迟早互相牵连。
#
# 键（key）怎么来：asset_key() 生成。远端图是 "source:subfolder/filename"（source 取
# output / input），画布上的图由前端按同一套规则拼 "canvas:项目:节点:序号"。
# 为什么用键而不是文件名：ComfyUI 的 output/ 和 input/ 里可以有同名文件，只按文件名
# 会把两张完全不同的图认成一张，删一张连另一张一起消失。
# 这个规则一改，所有人攒的分组就全丢——前端 assetKeyOf() 那边有一份对应的实现，别只改一边。
# --------------------------------------------------------------------------- #
ASSET_LIB_MAX_GROUPS = 40
ASSET_LIB_MAX_KEYS = 500          # 一次最多改 500 张：防手滑传个几十万条的数组


def asset_lib_file() -> Path:
    return DATA / "asset-lib.json"


def asset_key(source: str, subfolder: str, filename: str) -> str:
    """一张图在资产库里的唯一键。规则见上面那段注释，改了等于清空所有人的分组。"""
    return f"{source}:{subfolder or ''}/{filename or ''}"


def _clean_asset_lib(raw) -> dict:
    """把读进来 / 传进来的东西洗成能用的样子。某一条不合法就丢那一条，不整份作废。"""
    if not isinstance(raw, dict):
        return {"groups": [], "items": {}}
    groups, seen = [], set()
    for it in raw.get("groups") or []:
        if not isinstance(it, dict):
            continue
        gid = str(it.get("id") or "").strip()
        name = str(it.get("name") or "").strip()[:20]
        if not gid or not name or not CAT_ID_RE.match(gid) or gid in seen:
            continue
        seen.add(gid)
        groups.append({"id": gid, "name": name})
        if len(groups) >= ASSET_LIB_MAX_GROUPS:
            break
    items: dict = {}
    for k, v in (raw.get("items") or {}).items() if isinstance(raw.get("items"), dict) else []:
        key = str(k or "")[:300]
        if not key or not isinstance(v, dict):
            continue
        gid = str(v.get("group") or "")
        if gid not in seen:
            gid = ""                  # 分组被删了：回「未分组」，不留指向空分组的孤儿
        hidden = bool(v.get("hidden"))
        if gid or hidden:             # 既没分组也没隐藏的条目没有信息量，不占文件
            items[key] = {"group": gid, "hidden": hidden}
    return {"groups": groups, "items": items}


def load_asset_lib() -> dict:
    """读资产库。文件坏了**不覆盖**：先改名留档（.bad-时间戳），再从空库开始。

    直接覆盖等于把用户攒的分组一次抹掉，而这个文件手改不回来。留个坏文件在那儿，
    至少还能从里面抄回几个名字。
    """
    f = asset_lib_file()
    try:
        raw = json.loads(f.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {"groups": [], "items": {}}
    except Exception:  # noqa: BLE001
        try:
            f.replace(f.with_name(f"{f.name}.bad-{int(time.time())}"))
            print(f"[warn] {f.name} 读不出来，已留档为 {f.name}.bad-*，这次从空库开始")
        except OSError:
            pass
        return {"groups": [], "items": {}}
    return _clean_asset_lib(raw)


def save_asset_lib(data: dict) -> dict:
    """原子写：临时文件 + os.replace。写到一半断电也不会留下半个 JSON。"""
    clean = _clean_asset_lib(data)
    DATA.mkdir(parents=True, exist_ok=True)
    f = asset_lib_file()
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, f)
    return clean


def _assets_with_lib(items: list[dict], limit: int, *, cached: bool,
                     comfy: bool, error) -> dict:
    """把 ComfyUI 那边的结果和本地资产库贴在一起返回。

    分组 / 隐藏是本地文件，随时会被改，所以每次请求都重新贴一遍，不进 ASSET_CACHE
    ——缓存里存的应该只是 ComfyUI 的历史，不是用户的分组。
    画布上的图由前端合并，它拿不到服务端贴的字段，所以额外把整张 meta 表一起返回。
    """
    lib = load_asset_lib()
    out = []
    for it in items[:limit]:
        key = asset_key(it.get("source", ""), it.get("subfolder", ""), it.get("filename", ""))
        meta = lib["items"].get(key) or {}
        out.append({**it, "key": key, "group": meta.get("group") or "",
                    "hidden": bool(meta.get("hidden"))})
    return {"ok": True, "items": out, "groups": lib["groups"], "meta": lib["items"],
            "comfy": comfy, "cached": cached, "error": error}


def asset_lib_apply(payload: dict) -> dict:
    """资产库的写操作。全部走一个入口，op 决定动作：

        group-add    {name}           → 新建分组，返回新 id
        group-rename {id, name}       → 分组改名
        group-remove {id}             → 删分组，组内资产回「未分组」（资产本身不动）
        assign       {keys, group}    → 批量移动，group 空串 = 未分组
        hide         {keys, hidden}   → 批量从资产库移除 / 恢复

    「移除」只写 hidden 标记，不删磁盘上的文件——资产是 ComfyUI 的产物，删文件是不可逆的，
    而用户点「删除」时想的多半只是「别在这儿烦我」。
    """
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是对象")
    op = str(payload.get("op") or "")
    lib = load_asset_lib()
    groups, items = lib["groups"], lib["items"]

    def keys_of() -> list[str]:
        raw = payload.get("keys")
        if not isinstance(raw, list):
            raise ValueError("keys 必须是数组")
        out = []
        for k in raw:
            s = str(k or "")[:300]
            if s and s not in out:
                out.append(s)
        if not out:
            raise ValueError("没有选中任何资产")
        if len(out) > ASSET_LIB_MAX_KEYS:
            raise ValueError(f"一次最多改 {ASSET_LIB_MAX_KEYS} 张")
        return out

    def done(extra: dict | None = None) -> dict:
        saved = save_asset_lib({"groups": groups, "items": items})
        return {"ok": True, "groups": saved["groups"], "meta": saved["items"], **(extra or {})}

    if op == "group-add":
        name = str(payload.get("name") or "").strip()[:20]
        if not name:
            raise ValueError("分组名不能为空")
        if any(g["name"] == name for g in groups):
            raise ValueError("已经有同名分组了")
        if len(groups) >= ASSET_LIB_MAX_GROUPS:
            raise ValueError(f"最多 {ASSET_LIB_MAX_GROUPS} 个分组")
        gid = "g" + format(int(time.time() * 1000), "x")
        while any(g["id"] == gid for g in groups):      # 同一毫秒连点两次
            gid += "x"
        groups.append({"id": gid, "name": name})
        return done({"id": gid, "name": name})

    if op == "group-rename":
        gid = str(payload.get("id") or "").strip()
        name = str(payload.get("name") or "").strip()[:20]
        target = next((g for g in groups if g["id"] == gid), None)
        if not target:
            raise ValueError("分组不存在")
        if not name:
            raise ValueError("分组名不能为空")
        if any(g["name"] == name and g["id"] != gid for g in groups):
            raise ValueError("已经有同名分组了")
        target["name"] = name
        return done()

    if op == "group-remove":
        gid = str(payload.get("id") or "").strip()
        if not any(g["id"] == gid for g in groups):
            raise ValueError("分组不存在")
        groups = [g for g in groups if g["id"] != gid]
        for key, meta in list(items.items()):
            if meta.get("group") == gid:
                meta["group"] = ""
                if not meta.get("hidden"):
                    items.pop(key)          # 回未分组、也没隐藏 → 这条没信息量了
        return done()

    if op == "assign":
        gid = str(payload.get("group") or "").strip()
        if gid and not any(g["id"] == gid for g in groups):
            raise ValueError("分组不存在")
        keys = keys_of()
        for key in keys:
            meta = items.setdefault(key, {"group": "", "hidden": False})
            meta["group"] = gid
            if not gid and not meta.get("hidden"):
                items.pop(key)
        name = next((g["name"] for g in groups if g["id"] == gid), "")
        return done({"moved": len(keys), "group": gid, "name": name})

    if op == "hide":
        hidden = bool(payload.get("hidden"))
        keys = keys_of()
        for key in keys:
            meta = items.setdefault(key, {"group": "", "hidden": False})
            meta["hidden"] = hidden
            if not hidden and not meta.get("group"):
                items.pop(key)
        return done({"changed": len(keys), "hidden": hidden})

    raise ValueError(f"不认识的操作：{op or '（空）'}")


# --------------------------------------------------------------------------- #
# MCP 安装：把「客户端该怎么配」算出来，必要时替他写进配置文件
#
# 为什么要在应用里做这件事：MCP 的门槛全在第一步——用户得知道有这么个端点、要写 stdio 命令、
# 路径还不能写错。顶栏那盏「MCP 待接入」的灯就是最好的入口：点它，配置直接给你抄。
#
# 写配置是**侵入性操作**（改的是用户全局的 mcp.json），所以三条底线：
#   ① 只写白名单里的三个已知路径，不接受任意路径；
#   ② 写之前先解析现有 JSON，解析不了就原样留着并如实报错，绝不覆盖；
#   ③ 覆盖前一定备份（<文件名>.bak-时间戳），写用临时文件 + os.replace（半截文件不会留下）。
# --------------------------------------------------------------------------- #
MCP_CLIENTS = (
    ("workbuddy", "WorkBuddy / CodeBuddy"),
    ("claude", "Claude Desktop"),
    ("cursor", "Cursor"),
)


def mcp_home() -> Path:
    """客户端配置的根目录。测试用 INFISHEET_MCP_HOME 指到临时目录，别碰真配置。"""
    raw = os.environ.get("INFISHEET_MCP_HOME")
    return Path(raw) if raw else Path.home()


def mcp_config_path(cid: str) -> Path:
    home = mcp_home()
    if cid == "workbuddy":
        return home / ".workbuddy" / "mcp.json"
    if cid == "cursor":
        return home / ".cursor" / "mcp.json"
    if cid == "claude":
        if os.name == "nt":
            appdata = os.environ.get("APPDATA") or str(home / "AppData" / "Roaming")
            return Path(appdata) / "Claude" / "claude_desktop_config.json"
        if sys.platform == "darwin":
            return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
        return home / ".config" / "Claude" / "claude_desktop_config.json"
    raise KeyError(cid)


def mcp_python_cmd() -> str:
    """写进用户配置的 python 解释器。

    不能直接用 sys.executable：这个服务可能是被某个应用自带的运行时拉起来的
    （实测 WorkBuddy 走的是 `...\\.workbuddy-ai\\binaries\\python\\...\\python.exe`），
    那条路径会随应用升级 / 卸载消失，用户照着抄完，过几天 MCP 就起不来了。
    所以：自带的运行时一律不用，优先 PATH 里的 python；再不行就留一个裸 "python" 让客户端自己找。
    """
    def bundled(path: str) -> bool:
        return "workbuddy" in path.lower()

    exe = sys.executable or ""
    if exe and not bundled(exe):
        return exe
    # PATH 里第一个 python 往往就是应用自带的那个，得往后翻一个真正属于系统的
    names = ("python.exe", "python") if os.name == "nt" else ("python3", "python")
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        if not folder or bundled(folder):
            continue
        for name in names:
            cand = Path(folder) / name
            if cand.is_file():
                return str(cand)
    hit = shutil.which("python") or shutil.which("python3") or ""
    return hit if hit and not bundled(hit) else "python"


def mcp_entry(cid: str) -> dict:
    """给某个客户端用的完整配置片段（顶层就是 mcpServers，直接抄/直接合都行）。"""
    args = [str(ROOT / "mcp_server.py")]
    if PORT != 8788:
        args += ["--port", str(PORT)]
    server = {"command": mcp_python_cmd(), "args": args}
    if cid != "claude":          # Claude Desktop 的 stdio 条目没有 type 字段
        server = {"type": "stdio", **server}
    return {"mcpServers": {"infisheet": server}}


def mcp_setup_payload() -> dict:
    clients = []
    for cid, label in MCP_CLIENTS:
        path = mcp_config_path(cid)
        clients.append({
            "id": cid, "label": label, "path": str(path),
            "exists": path.is_file(), "config": mcp_entry(cid),
        })
    return {
        "ok": True,
        "port": PORT,
        "endpoint": f"http://127.0.0.1:{PORT}/mcp",
        "python": mcp_python_cmd(),
        "script": str(ROOT / "mcp_server.py"),
        "clients": clients,
    }


def mcp_install(cid: str) -> dict:
    """把 infisheet 这一条合并进客户端的配置文件。失败就抛 ValueError（调用方回 400）。"""
    try:
        path = mcp_config_path(cid)
    except KeyError:
        raise ValueError(f"不认识的客户端：{cid}")

    data: dict = {}
    backup = None
    if path.is_file():
        raw = path.read_text(encoding="utf-8-sig").strip()
        if raw:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"现有配置不是合法 JSON（第 {exc.lineno} 行），没有动它：{path}")
            if not isinstance(data, dict):
                raise ValueError(f"现有配置的顶层不是对象，没有动它：{path}")
            backup = path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
            shutil.copy2(path, backup)

    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
        data["mcpServers"] = servers
    servers["infisheet"] = mcp_entry(cid)["mcpServers"]["infisheet"]

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return {
        "ok": True, "path": str(path),
        "backup": str(backup) if backup else None,
        "entry": servers["infisheet"],
    }


def _shutdown_soon(delay: float = 0.4) -> None:
    """先让响应发出去，再停掉 serve_forever。

    顺序不能反：shutdown() 会让 serve_forever 立刻返回、main() 收尾关 socket，
    这时还没发完的响应会被掐断，前端只看到「请求失败」，用户会以为按钮没生效。
    """
    time.sleep(delay)
    srv = SERVER
    try:
        if srv is not None:
            srv.shutdown()
            srv.server_close()
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass
        # 还有 ComfyUI 进度 ws 之类的后台线程，正常退出可能被它们拖着；
        # 这是「用户明确要求关掉」的场景，直接结束进程，别留半开的端口。
        os._exit(0)


# --------------------------------------------------------------------------- #
# HTTP 处理
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "InfiSheet/1.2"
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

    # ---------- 访问令牌（只在 --host 非回环 + 设了 --token 时生效） ----------
    def _client_is_local(self) -> bool:
        host = (self.client_address[0] or "").split("%")[0]
        return host in ("127.0.0.1", "::1", "localhost")

    def _token_ok(self, query: dict | None = None) -> bool:
        if not TOKEN or self._client_is_local():
            return True
        if self.headers.get("X-InfiSheet-Token") == TOKEN:
            return True
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, val = part.strip().partition("=")
            if name == "infisheet_token" and urllib.parse.unquote(val) == TOKEN:
                return True
        q = query if query is not None else urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query)
        return (q.get("t") or [""])[0] == TOKEN

    def _deny(self, path: str):
        """没带令牌：接口回 401；页面回一个只要粘贴令牌的极简表单。"""
        if path.startswith("/api/") or path.startswith("/mcp"):
            return self.fail("需要访问令牌（启动时用 --token 设置）", 401)
        form = (
            "<!doctype html><meta charset='utf-8'><title>InfiSheet</title>"
            "<body style='font:15px/1.6 system-ui;margin:64px auto;max-width:360px'>"
            "<h3 style='margin:0 0 6px'>需要访问令牌</h3>"
            "<p style='color:#666;margin:0 0 16px'>这台服务开在局域网里，启动时设了 --token。</p>"
            f"<form method='get' action='{urllib.parse.quote(path)}'>"
            "<input name='t' type='password' placeholder='访问令牌' autofocus "
            "style='width:100%;padding:9px;box-sizing:border-box'>"
            "<button style='margin-top:12px;padding:9px 18px'>进入</button></form>"
        )
        self._send(401, form.encode("utf-8"), "text/html; charset=utf-8")

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

    # ---------- MCP（Streamable HTTP + JSON-RPC 2.0） ----------
    def mcp_post(self):
        """MCP 的唯一入口。协议细节全在 mcp_server.py，这里只管 HTTP 外壳：

        * 请求体不是 JSON → -32700（JSON-RPC 的 parse error），不是 400 页面
        * 通知（没有 id）→ 202 + 空 body
        * initialize 发一个 Mcp-Session-Id，客户端之后会带着它回来（我们无状态，照收）
        """
        raw = self.read_body()
        if not raw:
            return self._send(400, b"", "text/plain; charset=utf-8")
        payload = None
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            resp = mcp_server.error_response(-32700, "JSON 解析失败")
        else:
            # 桥替客户端报个名（见 mcp_server.note_client）：必须在 handle 之前，
            # 否则 tools/call 里 _touch() 会先把身份填成泛称「MCP 客户端」。
            # 两个头一起给：X-MCP-Client 是客户端自报的（可能把我们自己当成它），
            # X-MCP-Host 是拉起这个桥的应用，自报不可用时顶上去。
            try:
                mcp_server.note_client(self.headers.get("X-MCP-Client") or "",
                                       self.headers.get("X-MCP-Host") or "")
            except Exception:  # noqa: BLE001
                pass
            try:
                resp = mcp_server.handle(payload)
            except Exception as exc:  # noqa: BLE001
                resp = mcp_server.error_response(-32603, f"{type(exc).__name__}: {exc}")
        sid = self.headers.get("Mcp-Session-Id") or ""
        if isinstance(payload, dict) and payload.get("method") == "initialize" and not sid:
            sid = uuid.uuid4().hex
            mcp_server.note_session(sid)
        extra = {"Mcp-Session-Id": sid} if sid else {}
        if resp is None:
            return self._send(202, b"", "text/plain; charset=utf-8", extra)
        body = json.dumps(resp, ensure_ascii=False).encode("utf-8")
        self._send(200, body, "application/json; charset=utf-8", extra)

    def api_shutdown(self):
        """关闭本地服务（设置面板里的「关闭服务」）。

        本地服务没有鉴权，所以这里做一次同源校验：浏览器跨站发 POST 会带 Origin，
        挡掉「随便一个网页顺手把别人画布服务关掉」这种事。非浏览器客户端不带 Origin，
        照常放行（它们本来就跑在同一台机器上）。
        """
        origin = self.headers.get("Origin") or ""
        host = self.headers.get("Host") or ""
        if origin and urllib.parse.urlsplit(origin).netloc != host:
            self.drain_body()
            return self.fail("跨站请求被拒绝", 403)
        self.drain_body()
        self.json_out({"ok": True, "stopping": True})
        threading.Thread(target=_shutdown_soon, daemon=True).start()

    def api_set_comfy(self):
        """改 ComfyUI 地址：校验 → 试连 → 存盘 → 立即生效。

        连不上也存：很多人是「先把地址配好，再去启动 ComfyUI」，逼他们连上才能保存
        只会让人以为入口坏了。但返回值里如实给 reachable=false + 原因，界面照实显示。
        """
        payload = self.read_json() or {}
        raw = str(payload.get("url") or "").strip()
        if not raw:
            # 空 = 清掉自定义，回到「启动时的那一份」（环境变量 / 默认）
            save_settings({"comfy_url": ""})
            fallback = os.environ.get("COMFY_URL", DEFAULT_COMFY_URL).rstrip("/")
            set_comfy_url(fallback, "环境变量 COMFY_URL" if os.environ.get("COMFY_URL") else "默认")
            out = comfy_state()
            out["saved"] = False
            return self.json_out(out)
        try:
            url = normalize_comfy_url(raw)
        except ValueError as exc:
            return self.fail(str(exc), 400)
        set_comfy_url(url, "设置")
        save_settings({"comfy_url": url})
        out = comfy_state()
        out["saved"] = True
        return self.json_out(out)

    def mcp_heartbeat(self):
        """stdio 桥的保活：每隔 lease/3 秒来一次，顺便问一下租约多长。

        这是「断开」唯一的判据：桥是客户端拉起来的，客户端关窗 / 崩溃 / 被强杀之后
        桥跟着没了，就没人再敲这个门，租约一过 /api/health 里的 alive 变 false，
        顶栏那盏灯自己变灰（不用刷新页面）。HTTP 直连没有这条通道，也就不判它死活。
        """
        self.drain_body()
        try:
            mcp_server.note_heartbeat(self.headers.get("X-MCP-Client") or "",
                                      self.headers.get("X-MCP-Host") or "")
            lease = mcp_server.lease()
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)
        return self.json_out({"ok": True, "lease": lease})

    # ---------- 路由 ----------
    def do_GET(self):
        self._body_read = False
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if not self._token_ok(query):
                return self._deny(path)
            if TOKEN and (query.get("t") or [""])[0] == TOKEN and not self._client_is_local():
                # 令牌写在 URL 里：种成 cookie 后跳回干净地址，之后所有同源请求自动带上，
                # 不用改前端的任何一个 fetch。
                rest = {k: v for k, v in query.items() if k != "t"}
                clean = path + (("?" + urllib.parse.urlencode(rest, doseq=True)) if rest else "")
                return self._send(302, b"", "text/plain; charset=utf-8", {
                    "Location": clean,
                    "Set-Cookie": (f"infisheet_token={urllib.parse.quote(TOKEN, safe='')}; "
                                   "Path=/; SameSite=Lax; Max-Age=2592000"),
                })
            if path == "/mcp":
                # Streamable HTTP 的 GET 用来开 SSE 服务端推送。本项目没有「服务端主动推」，
                # 按规范回 405 而不是 404 —— 客户端据此知道这个端点存在、只是不支持流。
                return self._send(405, b"", "text/plain; charset=utf-8",
                                  {"Allow": "POST, DELETE"})
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
            if not self._token_ok():
                return self._deny(parsed.path)
            return self.api_post(parsed.path)
        except ConnectionError as exc:
            return self.fail(str(exc), 502)
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)

    def do_PUT(self):
        self._body_read = False
        try:
            if not self._token_ok():
                return self._deny(urllib.parse.urlparse(self.path).path)
            return self.api_put(urllib.parse.urlparse(self.path).path)
        except Exception as exc:  # noqa: BLE001
            return self.fail(f"{type(exc).__name__}: {exc}", 500)

    def do_DELETE(self):
        self._body_read = False
        try:
            if not self._token_ok():
                return self._deny(urllib.parse.urlparse(self.path).path)
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
            out = {"ok": True, "comfy_url": COMFY_URL, "comfy_source": COMFY_SOURCE,
                   "features": ["presets", "projects", "canvas_history", "ui_import", "mcp",
                                "comfy_config", "wf_categories", "wf_meta", "progress_log"]}
            # 顶栏的「MCP 已连接」小灯读这个：谁接进来了、什么时候、调了几次工具。
            # 单独兜一层异常——MCP 状态取不到不该让整个 health 变 500（那只影响一个指示器）。
            try:
                out["mcp"] = mcp_server.status()
            except Exception:  # noqa: BLE001
                out["mcp"] = {"connected": False}
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
                # 顶栏直接显示这句话：别把 `<urlopen error [Errno 61]>` 丢给用户
                out.update({"comfy": False, "error": comfy_error_hint(exc)})
            return self.json_out(out)

        if path == "/api/comfy":
            # 当前连的是哪台 ComfyUI、能不能连上。设置面板打开时先读这个。
            return self.json_out(comfy_state())

        if path == "/api/mcp/setup":
            # 「怎么把 AI 接进来」全在这里：端点、stdio 命令、三个客户端的配置文件路径与片段
            try:
                return self.json_out(mcp_setup_payload())
            except Exception as exc:  # noqa: BLE001
                return self.fail(f"{type(exc).__name__}: {exc}", 500)

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
            return self.json_out({"ok": True, "items": list_library(),
                                  "presets": list_presets(),
                                  "categories": load_categories()})

        if path == "/api/wf/categories":
            return self.json_out({"ok": True, "categories": load_categories()})

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
            canvas = json.loads(f.read_text(encoding="utf-8-sig"))
            # ?meta=1：只回版本号。前端每几秒探一次「画布被别的会话（MCP）改了吗」，
            # 全量读一遍画布再比字符串太重了。
            if (query.get("meta") or [""])[0] in ("1", "true"):
                return self.json_out({
                    "ok": True, "id": pid, "rev": int(canvas.get("rev") or 0),
                    "savedAt": canvas.get("savedAt") or 0,
                    "lastWriter": canvas.get("lastWriter") or "",
                    "nodes": len(canvas.get("nodes") or []),
                })
            return self.json_out({"ok": True, "id": pid, "canvas": canvas})
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
                pct = PROGRESS.get(pid)
            # websocket 一个数都没报（或者整条链路哑了）时，去 ComfyUI 控制台日志里读
            # tqdm 的百分比兜底——这是用户提的那条路：它亲口打印的数字，最不容易漏。
            # 只在跑着/排着的时候读：已经结束的任务读出来也没有意义，还白花一次请求。
            if pct is None and out.get("status") in ("running", "queued"):
                pct = _log_progress(pid)
            out["progress"] = pct
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
        if path == "/mcp":
            return self.mcp_post()

        if path == "/api/comfy":
            return self.api_set_comfy()

        if path == "/api/mcp/heartbeat":
            return self.mcp_heartbeat()

        if path == "/api/shutdown":
            return self.api_shutdown()

        # 资产库的分组 / 归属 / 移除。一个入口靠 op 分发，见 asset_lib_apply()
        if path == "/api/assets/lib":
            payload = self.read_json() or {}
            try:
                return self.json_out(asset_lib_apply(payload))
            except ValueError as exc:
                return self.fail(str(exc), 400)
            except Exception as exc:  # noqa: BLE001
                return self.fail(f"{type(exc).__name__}: {exc}", 500)

        if path == "/api/mcp/install":
            # 替用户把配置写进客户端文件。白名单客户端 + 备份 + 原子写，见 mcp_install()
            payload = self.read_json() or {}
            try:
                return self.json_out(mcp_install(str(payload.get("client") or "")))
            except ValueError as exc:
                return self.fail(str(exc), 400)
            except Exception as exc:  # noqa: BLE001
                return self.fail(f"{type(exc).__name__}: {exc}", 500)

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
            group = normalize_group(payload.get("group"))
            if group:
                data["group"] = group          # 导入时选好分类就别让它掉回「按能力猜」
            f.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.json_out({"ok": True, "file": f.name, "title": title, "group": group})

        # 工作流的「标题 / 分类」——分类是用户自己的组织方式，随时可改，不用重新导入
        if path == "/api/wf/meta":
            payload = self.read_json() or {}
            patch = {}
            if "title" in payload:
                patch["title"] = payload.get("title")
            if "group" in payload:
                patch["group"] = payload.get("group")
            if not patch:
                return self.fail("没有要改的字段", 400)
            meta, err = update_wf_meta(payload.get("id"), patch)
            if err:
                return self.fail(err, 400 if "非法" in err else 404)
            return self.json_out({"ok": True, **meta})

        # 分类表整体替换：改名 / 新增 / 删除 / 排序都在前端做，服务端只负责清洗和落盘
        if path == "/api/wf/categories":
            payload = self.read_json() or {}
            items = payload.get("categories")
            if not isinstance(items, list):
                return self.fail("categories 必须是数组", 400)
            return self.json_out({"ok": True, "categories": save_categories(items)})

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

        if path == "/api/queue/cancel":
            # 取消**一个**任务（队列面板逐条取消用）。
            # 只发 /queue {"delete": [pid]} 对「正在跑」的那条无效——它不在 pending 里，
            # 已经在执行了；那种情况必须 /interrupt。反过来，/interrupt 掐的是**当前正在执行的那个**，
            # 所以必须先查队列确认 pid 真的在 running 里，否则取消一条排队任务会把别人的任务杀掉。
            payload = self.read_json() or {}
            pid = str(payload.get("prompt_id") or "").strip()
            if not pid:
                return self.fail("缺少 prompt_id", 400)
            try:
                queue = comfy_json("/queue", timeout=15)
            except Exception as exc:  # noqa: BLE001
                return self.fail(f"连不上 ComfyUI：{exc}", 502)
            running = [item[1] for item in queue.get("queue_running") or [] if len(item) > 1]
            pending = [item[1] for item in queue.get("queue_pending") or [] if len(item) > 1]
            if pid not in running and pid not in pending:
                # 已经跑完 / 刚被取消 / ComfyUI 重启后记录丢了：不是错误，面板只需要知道「它不在了」
                return self.json_out({"ok": True, "prompt_id": pid, "removed": False,
                                      "interrupted": False, "reason": "任务已结束或不在队列里"})
            comfy_request("POST", "/queue", json.dumps({"delete": [pid]}).encode("utf-8"))
            interrupted = False
            if pid in running:
                comfy_request("POST", "/interrupt", b"{}")
                interrupted = True
            return self.json_out({"ok": True, "prompt_id": pid, "removed": True,
                                  "interrupted": interrupted,
                                  "was": "running" if interrupted else "pending"})

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
            client_id = payload.get("client_id") or PROGRESS_CLIENT
            body = json.dumps({"prompt": graph, "client_id": client_id}).encode("utf-8")
            status, _, raw = comfy_request("POST", "/prompt", body)
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:  # noqa: BLE001
                data = {"raw": raw.decode("utf-8", "replace")}
            if status != 200:
                return self.json_out({"ok": False, "status": status, "error": data}, 200)
            pid = data.get("prompt_id")
            if pid:
                # 记下提交时刻：日志兜底要靠它把「上一单的 100%」筛掉（见 _log_progress）
                PROMPT_START[str(pid)] = time.time()
                PROGRESS_LOG.pop(str(pid), None)
                if len(PROMPT_START) > 400:
                    # 只清一小时前的：整表 clear 会把**正在跑**的那单的起点一起抹掉，
                    # 那条链路的兜底就当场哑了
                    cutoff = time.time() - 3600
                    for old in [k for k, v in PROMPT_START.items() if v < cutoff]:
                        PROMPT_START.pop(old, None)
            return self.json_out({"ok": True, "prompt_id": pid,
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
                      "view": {"x": 140, "y": 120, "k": 0.85}, "seq": 1,
                      "rev": 0, "lastWriter": "canvas",
                      "savedAt": int(time.time() * 1000)}
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
            path = DATA / "projects" / f"{pid}.json"
            prev = {}
            if path.exists():
                try:
                    prev = json.loads(path.read_text(encoding="utf-8-sig"))
                except Exception:  # noqa: BLE001
                    prev = {}
            prev_rev = int((prev or {}).get("rev") or 0)
            base = payload.get("baseRev")
            try:
                base = int(base) if base is not None else None
            except (TypeError, ValueError):
                base = None
            # 版本对不上就别盖：画布刚被别的会话（MCP 桥 / 另一个标签页）改过。
            # 前端拿到 stale 会去读最新一版，而不是把自己手里那份旧状态写回去。
            if base is not None and base < prev_rev:
                return self.json_out({"ok": True, "stale": True, "rev": prev_rev,
                                      "lastWriter": (prev or {}).get("lastWriter") or ""})
            canvas["rev"] = prev_rev + 1
            canvas["lastWriter"] = "canvas"
            canvas["savedAt"] = int(time.time() * 1000)
            projects_dir()
            path.write_text(json.dumps(canvas, ensure_ascii=False, indent=1), encoding="utf-8")
            return self.json_out({"ok": True, "id": pid, "rev": canvas["rev"]})
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
        # 覆盖已有条目时保住它的标题 / 分类：从画布「存入工作流库」只带 graph 过来，
        # 要是整份重写，用户好不容易归好的类就被打回「按能力猜」了。
        old = {}
        if f.is_file():
            try:
                old = json.loads(f.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                old = {}
        data = {**old, "name": name, "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"), "graph": graph}
        title = str(payload.get("title") or "").strip()[:40]
        if title:
            data["title"] = title
        group = normalize_group(payload.get("group"))
        if group:
            data["group"] = group
        f.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        return self.json_out({"ok": True, "name": name, "title": data.get("title") or name,
                              "group": data.get("group") or ""})

    def api_delete(self, path: str):
        if path == "/mcp":
            # 客户端主动结束会话。我们无状态，删掉的只是一句「好的」。
            self.drain_body()
            return self._send(204, b"", "text/plain; charset=utf-8")
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


def graph_takes(graph: dict) -> dict:
    """这个工作流**吃不吃**外部喂进去的图 / 吃不吃遮罩。

    前端靠这面旗子挑工作流：高清必须挑真有 LoadImage 的，纯文生图流程会把参考图默默丢掉。
    按名字猜（"图像编辑"四个字）迟早猜错——Moss_图像编辑 就是纯文生图。

    `takes_alpha_mask` 是遮罩重构后的唯一口径：不看有没有 LoadImageMask 节点，而是看
    **有没有人在消费 LoadImage 的 MASK 输出**（输出索引 1，就是 alpha 通道）。
    遮罩不需要单独一个文件，烘进原图 alpha 即可，图和遮罩天然配对。

    故意**不**再报 takes_mask：analyze_graph 把 LoadImageMask 的输入跳过了（它只会退化成
    一个「选了也不生效」的文件名下拉），所以那种工作流在这套画布上根本跑不了遮罩。
    报一个 true 出去等于空承诺，前端会以为能用。
    """
    takes_image = False
    load_ids = set()
    for nid, node in (graph or {}).items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        if ct in ("LoadImage", "LoadImageMask"):
            takes_image = True
        if ct == "LoadImage":
            load_ids.add(str(nid))
    # 谁把 LoadImage 的 MASK 输出接到了自己身上
    alpha_mask = False
    for node in (graph or {}).values():
        if not isinstance(node, dict):
            continue
        for v in (node.get("inputs") or {}).values():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) in load_ids and v[1] == 1:
                alpha_mask = True
                break
        if alpha_mask:
            break
    return {"takes_image": takes_image, "takes_alpha_mask": alpha_mask}


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


# --------------------------------------------------------------------------- #
# 工作流分类：每个入口只该看到自己用得上的那一类
#
# 分类是「按能力推断 + 允许预设自己声明」：预设 JSON 顶层写 category 就听它的
# （导入的工作流通常最清楚自己是干什么的），没写才扫图推断。
# 顺序有讲究——先看产物（视频/音频最不容易误判），再看吃不吃图，最后才看放大节点。
# --------------------------------------------------------------------------- #
CATEGORY_LABELS = {
    "txt2img": "文生图",
    "img2img": "图生图 / 编辑",
    "upscale": "高清放大",
    "video": "视频",
    "audio": "音频",
    "other": "其他",
}
CATEGORY_ORDER = ["txt2img", "img2img", "upscale", "video", "audio", "other"]

# 出现这些节点基本就是「把图放大」：高清按钮要挑到这类，挑成普通图生图只会重画一张
UPSCALE_HINTS = ("upscale", "vosr", "imagescale", "esrgan", "ultimatesd", "swinir")


def graph_category(graph: dict, meta: dict | None = None) -> str:
    declared = str((meta or {}).get("category") or "").strip().lower()
    if declared in CATEGORY_LABELS:
        return declared
    kinds = graph_kinds(graph)
    if "video" in kinds:
        return "video"
    if "audio" in kinds:
        return "audio"
    if graph_takes(graph).get("takes_image"):
        for node in (graph or {}).values():
            if not isinstance(node, dict):
                continue
            ct = str(node.get("class_type") or "").lower()
            if any(h in ct for h in UPSCALE_HINTS):
                return "upscale"
        return "img2img"
    return "txt2img"


# --------------------------------------------------------------------------- #
# 工作流分类：**用户自己的分类**，和上面那套「能力推断」是两回事
#
# CATEGORY_LABELS 是「这个工作流是干什么的」——它决定高清按钮能不能挑到它、
# 扩图会不会挑到纯文生图，所以**不能**让用户随手改。
# 分类表是「我想怎么归类」——纯组织层，用户想怎么分就怎么分（改名 / 新增 / 删除 / 排序）。
# 两者用一个 group 字段连起来：group 缺省就等于 category，用户改过就听 group 的。
# --------------------------------------------------------------------------- #
DEFAULT_CATEGORIES = [
    {"id": "txt2img", "name": "文生图"},
    {"id": "img2img", "name": "图生图 / 编辑"},
    {"id": "upscale", "name": "高清放大"},
    {"id": "video", "name": "视频"},
    {"id": "audio", "name": "音频"},
    {"id": "other", "name": "其他"},
]
CAT_ID_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40}$")


def categories_file() -> Path:
    return DATA / "workflow_categories.json"


def load_categories() -> list[dict]:
    """分类表。读不到 / 读坏了都回默认 6 类——一个坏文件不该让工作流全都消失。"""
    try:
        raw = json.loads(categories_file().read_text(encoding="utf-8"))
        items = raw.get("categories") if isinstance(raw, dict) else raw
        out = []
        seen = set()
        for it in items or []:
            if not isinstance(it, dict):
                continue
            cid = str(it.get("id") or "").strip()
            name = str(it.get("name") or "").strip()[:20]
            if not cid or not name or not CAT_ID_RE.match(cid) or cid in seen:
                continue
            seen.add(cid)
            out.append({"id": cid, "name": name})
        if out:
            return out
    except Exception:  # noqa: BLE001
        pass
    return [dict(c) for c in DEFAULT_CATEGORIES]


def save_categories(items) -> list[dict]:
    """清洗后落盘：id 唯一、名字非空、最多 24 类。返回真正存下去的那一份。"""
    out, seen = [], set()
    for it in items or []:
        if not isinstance(it, dict):
            continue
        cid = str(it.get("id") or "").strip()
        name = str(it.get("name") or "").strip()[:20]
        if not cid or not name or not CAT_ID_RE.match(cid) or cid in seen:
            continue
        seen.add(cid)
        out.append({"id": cid, "name": name})
        if len(out) >= 24:
            break
    if not out:
        out = [dict(c) for c in DEFAULT_CATEGORIES]
    DATA.mkdir(parents=True, exist_ok=True)
    categories_file().write_text(
        json.dumps({"categories": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def normalize_group(value: str) -> str:
    """group 只允许当 id 用；不合法就当没设（前端会回落到能力分类）。"""
    v = str(value or "").strip()
    return v if v and CAT_ID_RE.match(v) else ""


def wf_meta_of(g: dict, cat: str) -> dict:
    """从工作流 JSON 顶层读「用户自定义的那部分」（标题 / 分类 / 备注）。"""
    return {
        "title": str(g.get("title") or "").strip(),
        "group": normalize_group(g.get("group")) or cat,
        "note": str(g.get("note") or ""),
    }


def list_presets() -> list[dict]:
    PRESETS.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(PRESETS.glob("*.json")):
        try:
            g = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        cat = graph_category(g.get("graph") or {}, g)
        meta = wf_meta_of(g, cat)
        out.append({"name": f.stem, "title": meta["title"] or f.stem,
                    "file": f.name, "nodes": len(g.get("graph") or {}),
                    "kinds": graph_kinds(g.get("graph") or {}),
                    "category": cat, "category_label": CATEGORY_LABELS.get(cat, "其他"),
                    "group": meta["group"],
                    **graph_takes(g.get("graph") or {})})
    return out


def list_library() -> list[dict]:
    """工作流库（用户自己存的）。和预设**同一套字段**——前端才能把它们摆进同一个列表。"""
    LIBRARY.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(LIBRARY.glob("*.json")):
        try:
            g = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        cat = graph_category(g.get("graph") or {}, g)
        meta = wf_meta_of(g, cat)
        out.append({"name": f.stem, "title": meta["title"] or f.stem,
                    "file": f.name, "nodes": len(g.get("graph") or {}),
                    "saved_at": g.get("saved_at"),
                    "kinds": graph_kinds(g.get("graph") or {}),
                    "category": cat, "category_label": CATEGORY_LABELS.get(cat, "其他"),
                    "group": meta["group"],
                    **graph_takes(g.get("graph") or {})})
    return out


def update_wf_meta(wf_id: str, patch: dict) -> tuple[dict | None, str]:
    """改一个工作流的「标题 / 分类」。id 形如 preset:xxx.json 或 lib:名字。"""
    wf_id = str(wf_id or "").strip()
    kind, _, name = wf_id.partition(":")
    name = urllib.parse.unquote(name)
    if kind == "preset":
        if not re.fullmatch(r"[\w\u4e00-\u9fa5 .\-]{1,120}\.json", name):
            return None, "预设名非法"
        f = (PRESETS / name).resolve()
        if PRESETS.resolve() not in f.parents or not f.is_file():
            return None, "预设不存在"
    elif kind == "lib":
        f = safe_library_path(name)
        if not f or not f.is_file():
            return None, "工作流不存在"
    else:
        return None, "id 非法"
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None, "工作流文件读不出来"
    if not isinstance(data, dict):
        return None, "工作流文件格式不对"
    if "title" in patch:
        title = str(patch.get("title") or "").strip()[:40]
        if title:
            data["title"] = title
    if "group" in patch:
        group = normalize_group(patch.get("group"))
        if group:
            data["group"] = group
        else:
            data.pop("group", None)      # 清空 = 回到能力分类
    f.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"id": wf_id, "title": data.get("title") or f.stem, "group": data.get("group") or ""}, ""


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
    parser = argparse.ArgumentParser(description="InfiSheet · 无限画布本地服务")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--comfy", default=None, help="ComfyUI 地址，如 http://127.0.0.1:8188")
    parser.add_argument("--presets", default=None,
                        help="内置预设目录（默认 ./presets）；自测时指向临时目录，别污染真预设")
    parser.add_argument("--data", default=None,
                        help="运行时数据目录（默认 ./data）：画布快照与工作流库都放这里，便于多实例与自测")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--token", default=None,
                        help="局域网访问令牌（也可用 INFISHEET_TOKEN）。设了之后非本机来源"
                             "必须带 ?t=令牌 或 X-InfiSheet-Token 头；本机 127.0.0.1 不受限")
    parser.add_argument("--yes-i-know", action="store_true",
                        help="监听非回环地址又没设令牌时，确认「知道这台机器会暴露到网络上」")
    parser.add_argument("--mcp-lease", type=float, default=30.0,
                        help="MCP 心跳租约（秒）：stdio 桥超过这么久没心跳就判离线，顶栏灯变灰；"
                             "0 = 不做租约（灯永不熄灭）")
    args = parser.parse_args()

    global COMFY_URL, COMFY_SOURCE, DATA, LIBRARY, PRESETS, TOKEN
    if args.token is not None:
        TOKEN = args.token.strip()
    if args.presets:
        PRESETS = Path(args.presets).expanduser().resolve()
    if args.data:
        DATA = Path(args.data).expanduser().resolve()
        LIBRARY = DATA / "library"
    DATA.mkdir(parents=True, exist_ok=True)
    LIBRARY.mkdir(parents=True, exist_ok=True)

    # ComfyUI 地址从哪来：--comfy（这一次运行）> 设置里保存的 > COMFY_URL 环境变量 > 默认。
    # 保存的排在被环境变量前面：容器里 compose 永远带着 COMFY_URL，如果它每次都盖回去，
    # 用户在界面里改的地址就永远存不住（而容器里的 /data 是挂卷，本来就是为了持久化）。
    if args.comfy:
        try:
            COMFY_URL = normalize_comfy_url(args.comfy)
            COMFY_SOURCE = "命令行 --comfy"
        except ValueError as exc:
            print(f"[警告] --comfy {args.comfy} 不是合法地址（{exc}），改用 {COMFY_URL}")
    else:
        saved_url = str(load_settings().get("comfy_url") or "").strip()
        if saved_url:
            try:
                COMFY_URL = normalize_comfy_url(saved_url)
                COMFY_SOURCE = "设置里保存的"
            except ValueError:
                print(f"[警告] 设置里的 ComfyUI 地址不合法（{saved_url}），已忽略")

    # 暴露到网络上却没有令牌 = 把显卡和画布交给同网段的任何人（ComfyUI 本身没有鉴权）。
    # 这里不替用户做决定，但要他明确说一句：加 --token，或者加 --yes-i-know。
    exposed = args.host not in ("127.0.0.1", "localhost", "::1")
    if exposed and not TOKEN and not args.yes_i_know:
        print(f"[拒绝启动] --host {args.host} 会把服务暴露到网络，而当前没有访问令牌。")
        print("  加令牌：  python server.py --host 0.0.0.0 --token 你的口令")
        print("  或自担风险：python server.py --host 0.0.0.0 --yes-i-know")
        return 2
    if exposed and not TOKEN:
        print("[警告] 没有访问令牌：同网段任何设备都能打开并操作这台机器的画布和 ComfyUI。")

    start_progress_ws()

    # MCP 工具需要的东西一次性注入：数据目录 + ComfyUI 代理 + 工作流/图分析。
    # 用注入而不是 import server，是为了让 mcp_server 能脱离服务单独跑协议测试。
    mcp_server.configure(types.SimpleNamespace(
        root=ROOT, static=STATIC, presets=PRESETS, data=DATA, library=LIBRARY,
        comfy_json=comfy_json, comfy_request=comfy_request,
        analyze_graph=analyze_graph, list_presets=list_presets, job_status=job_status,
        client_id=PROGRESS_CLIENT, mcp_lease=args.mcp_lease,
    ))

    global PORT, SERVER
    PORT = args.port
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    SERVER = httpd
    # 0.0.0.0 不是能打开的地址：浏览器要的是回环地址，对外地址由下面那行提示用户自己拼
    open_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host
    url = f"http://{open_host}:{args.port}/"
    print(f"InfiSheet · 无限画布: {url}")
    print(f"ComfyUI:       {COMFY_URL}  ({COMFY_SOURCE})")
    print(f"数据目录:      {DATA}")
    if exposed:
        tail = f"?t={TOKEN}" if TOKEN else "（无令牌，同网段可直接访问）"
        print(f"局域网访问:    http://<本机IP>:{args.port}/{tail}")
    print("Ctrl+C 退出")
    sys.stdout.flush()          # 重定向到日志文件时也立刻可见：启动告警不能被缓冲吞掉
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
        httpd.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
