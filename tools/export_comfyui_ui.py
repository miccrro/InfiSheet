#!/usr/bin/env python3
"""把 data/library 里的 API 格式工作流还原成 ComfyUI 网页端可以直接「打开」的界面格式。

为什么需要它：ComfyUI 的「打开 / Load」只认 {nodes, links, widgets_values} 这套界面格式；
API 格式（{id: {class_type, inputs}}）只能贴进 /prompt，网页端打不开。库里存的是 API 图，
所以分享出去之前要转一份。

难点都在「控件怎么序列化」，下面几条是对着本机 ComfyUI 真实导出的工作流核对过的：
  · 每个控件都同时出现在 node.inputs（带 widget 标记）和 widgets_values 里；
  · seed / noise_seed 后面多一格 control_after_generate；
  · COMFY_DYNAMICCOMBO_V3（SaveImageAdvanced 的 format、TextGenerate 的 sampling_mode）
    会把子控件按 `format.bit_depth` 这种名字摊在同一层，值也按顺序摊进 widgets_values；
  · COMFY_AUTOGROW_V3（Qwen 的参考图组、BatchImagesNode）展开成 images.image_1..N 的插座；
  · 自定义节点把 object_info 里没有声明的控件值（ShowText 的 text_0、rgthree 的
    rgthree_comparer）也塞在 widgets_values 末尾；hidden 段的输入跟在控件值之后；
  · 插座输入排在控件输入前面（新版前端的排法）。

用法：
    python tools/export_comfyui_ui.py                     # 默认读 data/library，写到 exports/comfyui
    python tools/export_comfyui_ui.py --comfy http://127.0.0.1:8188 --out 某目录
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_LIB = os.path.join(ROOT, "data", "library")
DEFAULT_OUT = os.path.join(ROOT, "exports", "comfyui")
DEFAULT_COMFY = "http://127.0.0.1:8188"
DEFAULT_WF = r"E:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\user\default\workflows"

WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
SEED_CONTROL = {"fixed", "increment", "decrement", "randomize"}
SKIP_INPUTS = {"filename_prefix"}     # 与 server.py 的转换口径保持一致：这个输入它不参与往返
DYNAMIC = "COMFY_DYNAMICCOMBO_V3"
AUTOGROW = "COMFY_AUTOGROW_V3"

TYPE_WIDTH = {
    "SaveImage": 360,
    "SaveImageAdvanced": 380,
    "PreviewImage": 340,
    "CLIPTextEncode": 400,
    "LoadImage": 320,
    "LoadImageMask": 320,
    "VAEDecode": 220,
    "VAEEncode": 220,
    "EmptyLatentImage": 300,
    "KSampler": 320,
    "KSamplerAdvanced": 340,
    "UNETLoader": 320,
    "CLIPLoader": 320,
    "VAELoader": 320,
    "LoraLoaderModelOnly": 320,
    "LoraLoader": 320,
    "CheckpointLoaderSimple": 320,
    "TextGenerate": 420,
}


def natural_key(value):
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", str(value))]


def get_json(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "InfiSheet-export/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class ObjectInfo:
    """按节点类型懒加载 /object_info，带缓存；取不到就明确报错（不猜）。"""

    def __init__(self, comfy_url: str):
        self.comfy_url = comfy_url.rstrip("/")
        self.cache = {}

    def get(self, node_type: str):
        if node_type in self.cache:
            return self.cache[node_type]
        quoted = urllib.parse.quote(node_type, safe="")
        try:
            data = get_json(f"{self.comfy_url}/object_info/{quoted}")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"读不到节点定义 {node_type}（{exc}）") from exc
        entry = data.get(node_type)
        if not entry:
            raise RuntimeError(f"ComfyUI 不认识节点类型：{node_type}")
        self.cache[node_type] = entry
        return entry


def declared_inputs(entry: dict) -> list[tuple[str, list, str]]:
    """按 ComfyUI 的控件生成顺序返回 [(名字, 声明, section)]。

    顺序必须是 required → optional；hidden 段的输入单独拿出来（它们只进
    widgets_values，不建节点输入口）。
    """
    spec = entry.get("input") or {}
    order = entry.get("input_order") or {}
    out: list[tuple[str, list, str]] = []
    for section in ("required", "optional"):
        names = order.get(section)
        if not isinstance(names, list):
            names = list((spec.get(section) or {}).keys())
        for name in names:
            decl = (spec.get(section) or {}).get(name)
            if isinstance(decl, list) and decl:
                out.append((name, decl, section))
    hidden = order.get("hidden")
    if not isinstance(hidden, list):
        hidden = list((spec.get("hidden") or {}).keys())
    for name in hidden:
        decl = (spec.get("hidden") or {}).get(name)
        if isinstance(decl, list) and decl:
            out.append((name, decl, "hidden"))
        elif isinstance(decl, str):
            out.append((name, [decl], "hidden"))
    return out


def is_link(value) -> bool:
    return (isinstance(value, list) and len(value) == 2
            and isinstance(value[0], (str, int)) and isinstance(value[1], int))


def is_widget_decl(name: str, decl: list, value) -> bool:
    """这个输入在前端是不是一个控件（而不是连线插座）。

    不能只看类型白名单：GHCOLOR / IMAGEUPLOAD 这类自定义控件不在里面，
    但它们确实是控件。可靠的判据是「API 图里存的是标量值」。
    """
    opts = decl[1] if len(decl) > 1 and isinstance(decl[1], dict) else {}
    if opts.get("forceInput") is True:
        return False
    t = decl[0]
    if isinstance(t, list) or (isinstance(t, str) and t in WIDGET_TYPES):
        return True
    if "default" in opts:
        return True
    return bool(value is not None and not is_link(value))


def type_name(decl: list) -> str:
    t = decl[0]
    if isinstance(t, list):
        return "COMBO"
    return str(t)


def widget_default(decl: list):
    opts = decl[1] if len(decl) > 1 and isinstance(decl[1], dict) else {}
    if "default" in opts:
        return opts["default"]
    t = decl[0]
    if isinstance(t, list):
        return t[0] if t else ""
    if t == "COMBO":
        options = opts.get("options") or []
        return options[0] if options else ""
    if t == "INT":
        return 0
    if t == "FLOAT":
        return 0.0
    if t == "BOOLEAN":
        return False
    return ""


def node_size(node_type: str, widgets: int, sockets: int) -> list[int]:
    w = TYPE_WIDTH.get(node_type, 320)
    h = max(80, 30 + widgets * 26 + sockets * 22)
    if node_type in ("CLIPTextEncode", "Note", "MarkdownNote"):
        h = max(h, 160)
    if node_type == "TextGenerate":
        h = max(h, 260)
    return [w, h]


def convert(graph: dict, oi: ObjectInfo, extra_map: dict[str, list[str]]) -> tuple[dict, dict, list[str]]:
    """API 图 → ComfyUI 界面格式。返回 (workflow, id_map, warnings)。"""
    api_ids = sorted([str(k) for k in graph], key=natural_key)
    id_map = {api_id: i + 1 for i, api_id in enumerate(api_ids)}
    nodes = []
    links = []
    link_id = 0
    warnings: list[str] = []
    by_api = {}

    for api_id in api_ids:
        node = graph[api_id]
        ntype = str(node.get("class_type") or "")
        if not ntype:
            raise RuntimeError(f"节点 {api_id} 没有 class_type")
        entry = oi.get(ntype)
        api_inputs = node.get("inputs") or {}
        meta = node.get("_meta") or {}
        title_text = str(meta.get("title") or ntype)

        sockets: list[dict] = []
        widgets: list[dict] = []          # 控件输入口（按控件顺序）
        values: list = []                 # widgets_values（与 widgets 一一对应，另含 hidden / 扩展位）
        hidden_values: list = []
        consumed = set()
        widget_count = 0

        for name, decl, section in declared_inputs(entry):
            if section == "hidden":
                if name in api_inputs and not is_link(api_inputs[name]):
                    hidden_values.append(api_inputs[name])
                    consumed.add(name)
                continue

            t = type_name(decl)
            value = api_inputs.get(name)

            # 参考图组：展开成 images.image_1..N 的插座
            if t == AUTOGROW:
                keys = [k for k in api_inputs if k == name or k.startswith(name + ".")]
                if not keys:
                    keys = [name + ".image_1"]
                for k in keys:
                    v = api_inputs.get(k)
                    consumed.add(k)
                    sockets.append({"name": k, "type": "IMAGE", "link": None})
                continue

            # 动态组合：基础控件 + 子控件摊平
            if t == DYNAMIC:
                keys = [name] + [k for k in api_inputs if k.startswith(name + ".")]
                for idx, k in enumerate(keys):
                    v = api_inputs.get(k)
                    consumed.add(k)
                    if is_link(v):
                        widgets.append({"name": k, "type": t if idx == 0 else "COMBO",
                                        "widget": {"name": k}, "link": None})
                        values.append(widget_default(decl) if idx == 0 else "")
                    else:
                        widgets.append({"name": k, "type": t if idx == 0 else "COMBO",
                                        "widget": {"name": k}, "link": None})
                        values.append(v if k in api_inputs else (widget_default(decl) if idx == 0 else ""))
                widget_count += len(keys)
                continue

            if is_widget_decl(name, decl, value):
                widgets.append({"name": name, "type": t, "widget": {"name": name}, "link": None})
                if is_link(value):
                    consumed.add(name)
                    values.append(widget_default(decl))
                else:
                    consumed.add(name)
                    values.append(value if name in api_inputs else widget_default(decl))
                widget_count += 1
                opts = decl[1] if len(decl) > 1 and isinstance(decl[1], dict) else {}
                if opts.get("control_after_generate") and str(name).lower() in ("seed", "noise_seed"):
                    values.append("randomize")
            else:
                sockets.append({"name": name, "type": t, "link": None})
                if is_link(value):
                    consumed.add(name)

        # 前端扩展控件（object_info 里没有、但真实工作流里一定有）：LoadImage 的 upload
        img_decl = (entry.get("input", {}).get("required", {}) or {}).get("image")
        upload_value = "image" if (isinstance(img_decl, list) and len(img_decl) > 1
                                   and isinstance(img_decl[1], dict)
                                   and img_decl[1].get("image_upload")) else None
        for extra in extra_map.get(ntype, []):
            widgets.append({"name": extra,
                            "type": "IMAGEUPLOAD" if extra == "upload" else "COMBO",
                            "widget": {"name": extra}, "link": None})
            widget_count += 1
            if extra == "upload" and upload_value is not None:
                values.append(upload_value)

        # 剩下没被声明的输入：自定义节点在 widgets_values 末尾追加的扩展控件
        # （ShowText 的 text_0、rgthree 的 rgthree_comparer…）
        for key, value in api_inputs.items():
            if key in consumed:
                continue
            if is_link(value):
                warnings.append(f"{api_id}({ntype}).{key} 是未声明的连线，按插座补上")
                sockets.append({"name": key, "type": "IMAGE", "link": None})
                consumed.add(key)
            elif not widgets:
                # 只有「这个节点本来就没有标准控件」时才追加：这类值就是前端扩展控件的
                # 唯一存放处（ShowText 显示的文字、rgthree 的对比图）。已经有一堆标准控件时
                # 再来一格会把序号顶歪（Goohai 的 ghs_dom 就是这种纯 UI 计算值）。
                values.append(value)
                consumed.add(key)
            else:
                warnings.append(f"{api_id}({ntype}).{key} 是 object_info 未声明的控件值，未写入 widgets_values")

        values.extend(hidden_values)

        outputs = []
        out_types = entry.get("output") or []
        out_names = entry.get("output_name") or []
        for i, otype in enumerate(out_types):
            outputs.append({
                "name": str(out_names[i] if i < len(out_names) else otype),
                "type": str(otype),
                "links": [],
                "slot_index": i,
            })

        inputs = sockets + widgets
        ui_node = {
            "id": id_map[api_id],
            "type": ntype,
            "title": title_text,
            "pos": [0, 0],
            "size": node_size(ntype, widget_count, len(sockets)),
            "flags": {},
            "order": 0,
            "mode": 0,
            "inputs": inputs,
            "outputs": outputs,
            "properties": {"Node name for S&R": ntype},
            "widgets_values": values,
        }
        if meta.get("cnr_id"):
            ui_node["properties"]["cnr_id"] = meta["cnr_id"]
        if meta.get("ver"):
            ui_node["properties"]["ver"] = meta["ver"]
        nodes.append(ui_node)
        by_api[api_id] = ui_node

    # 连线：按输入口名字回填 link id / 目标槽位
    for api_id in api_ids:
        node = graph[api_id]
        ui_node = by_api[api_id]
        for slot_idx, inp in enumerate(ui_node["inputs"]):
            value = (node.get("inputs") or {}).get(inp["name"])
            if not is_link(value):
                continue
            src_api = str(value[0])
            src_slot = int(value[1])
            if src_api not in id_map:
                raise RuntimeError(f"{api_id}.{inp['name']} 指向不存在的节点 {src_api}")
            src_node = by_api[src_api]
            if src_slot >= len(src_node["outputs"]):
                raise RuntimeError(f"{src_api} 没有第 {src_slot} 个输出，{api_id}.{inp['name']} 接不上")
            out = src_node["outputs"][src_slot]
            link_id += 1
            links.append([link_id, id_map[src_api], src_slot, id_map[api_id], slot_idx, out["type"]])
            inp["link"] = link_id
            out["links"].append(link_id)

    # 布局：按拓扑深度分列（深度 = 从源头到它的最长路径），列内竖排
    deps = {}
    for api_id in api_ids:
        deps[api_id] = [str(v[0]) for v in (graph[api_id].get("inputs") or {}).values()
                        if is_link(v) and str(v[0]) in id_map]

    depth = {api_id: 0 for api_id in api_ids}
    for _ in range(len(api_ids) + 1):
        changed = False
        for api_id in api_ids:
            d = max([depth[s] + 1 for s in deps[api_id]] or [0])
            if d > depth[api_id]:
                depth[api_id] = d
                changed = True
        if not changed:
            break

    columns = {}
    for api_id in api_ids:
        columns.setdefault(depth[api_id], []).append(api_id)

    order = 0
    for col, items in sorted(columns.items()):
        items.sort(key=lambda k: min([depth[s] for s in deps[k]] or [0]))
        y = 0
        for api_id in items:
            ui_node = by_api[api_id]
            ui_node["pos"] = [col * 380, y]
            ui_node["order"] = order
            order += 1
            y += ui_node["size"][1] + 90

    workflow = {
        "last_node_id": max(id_map.values()) if id_map else 0,
        "last_link_id": link_id,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "config": {},
        "extra": {},
        "version": 0.4,
    }
    return workflow, id_map, warnings


def collect_templates(wf_dir: str) -> dict[str, set[tuple[str, ...]]]:
    """从本机真实导出的工作流里收集「同类节点的控件名序列」。

    这是最可靠的对照物：它们都是 ComfyUI 前端自己 save 出来的，
    widgets_values 的排序就是前端认的排序。
    """
    templates: dict[str, set[tuple[str, ...]]] = {}
    if not wf_dir:
        return templates
    if not os.path.isdir(wf_dir):
        print(f"模板目录不存在，跳过模板比对：{wf_dir}")
        return templates
    for dirpath, _dirs, files in os.walk(wf_dir):
        for fn in files:
            if not fn.lower().endswith(".json"):
                continue
            try:
                with open(os.path.join(dirpath, fn), encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
                continue
            for node in data["nodes"]:
                ntype = node.get("type")
                if not ntype:
                    continue
                names = tuple(i.get("name") for i in (node.get("inputs") or [])
                              if isinstance(i, dict) and i.get("widget"))
                templates.setdefault(ntype, set()).add(names)
    return templates


def template_extra_widgets(templates: dict[str, set[tuple[str, ...]]], oi: ObjectInfo) -> dict[str, list[str]]:
    """从真实工作流里找出 object_info 没声明、但前端一定会建出来的控件。

    典型就是 LoadImage / LoadImageGoohai 的 upload 按钮：它不是 object_info 的输入，
    但每个真实导出的节点里都有一格。不补上的话，widgets_values 会少一格，
    节点打开后「上传」按钮的位置就是空的。
    """
    extras: dict[str, list[str]] = {}
    for ntype, shapes in templates.items():
        if not shapes:
            continue
        try:
            entry = oi.get(ntype)
        except RuntimeError:
            continue
        declared = []
        dynamic = False
        for name, decl, section in declared_inputs(entry):
            if section == "hidden":
                continue
            if type_name(decl) in (AUTOGROW, DYNAMIC):
                dynamic = True
                break
            if is_widget_decl(name, decl, None):
                declared.append(name)
        if dynamic:
            continue
        for shape in shapes:
            if len(shape) > len(declared) and list(shape[:len(declared)]) == declared:
                extras[ntype] = list(shape[len(declared):])
                break
    return extras


def read_widget_values(ui_node: dict, entry: dict) -> tuple[dict, list]:
    """按 ComfyUI 前端的下标规则把 widgets_values 读回控件值。

    关键：已连线的控件**仍然占一格**（原版工作流就是这么存的），
    hidden 段与扩展控件跟在后面。返回 ({控件名: 值}, 多余的尾部值)。
    """
    values = ui_node.get("widgets_values") or []
    ui_names = [i.get("name") for i in (ui_node.get("inputs") or [])
                if isinstance(i, dict) and i.get("widget")]
    out: dict = {}
    vi = 0

    def take():
        nonlocal vi
        v = values[vi] if vi < len(values) else None
        vi += 1
        return v

    for name, decl, section in declared_inputs(entry):
        if section == "hidden":
            continue
        t = type_name(decl)
        if t == AUTOGROW:
            continue
        if t == DYNAMIC:
            keys = [name] + [n for n in ui_names if isinstance(n, str) and n.startswith(name + ".")]
            for k in keys:
                out[k] = take()
            continue
        if is_widget_decl(name, decl, None) or name in ui_names:
            out[name] = take()
            opts = decl[1] if len(decl) > 1 and isinstance(decl[1], dict) else {}
            if (opts.get("control_after_generate") and str(name).lower() in ("seed", "noise_seed")
                    and vi < len(values) and values[vi] in SEED_CONTROL):
                vi += 1
    return out, values[vi:]


def validate(ui: dict, graph: dict, id_map: dict,
             templates: dict[str, set[tuple[str, ...]]], oi: ObjectInfo) -> tuple[list[str], list[str]]:
    """返回 (问题, 提示)。问题 = 结构或数值对不上；提示 = 只影响 UI 的细节。"""
    problems: list[str] = []
    notes: list[str] = []
    rev = {v: k for k, v in id_map.items()}
    ui_by_id = {n["id"]: n for n in ui["nodes"]}

    # 1) 结构完整性：连线两端都在、目标槽位存在、输入口回指同一条线
    for link in ui["links"]:
        lid, src, src_slot, dst, dst_slot, ltype = link
        if src not in ui_by_id or dst not in ui_by_id:
            problems.append(f"连线 {lid} 指向不存在的节点（{src}→{dst}）")
            continue
        if src_slot >= len(ui_by_id[src]["outputs"]):
            problems.append(f"连线 {lid} 的源槽位 {src_slot} 越界")
            continue
        if dst_slot >= len(ui_by_id[dst]["inputs"]):
            problems.append(f"连线 {lid} 的目标槽位 {dst_slot} 越界")
            continue
        if ui_by_id[dst]["inputs"][dst_slot]["link"] != lid:
            problems.append(f"连线 {lid} 与目标输入口的 link 记录不一致")
        if lid not in ui_by_id[src]["outputs"][src_slot]["links"]:
            problems.append(f"连线 {lid} 没有登记在源输出的 links 里")

    # 2) 同类节点模板比对：控件名序列必须是本机真实导出里出现过的形状
    for node in ui["nodes"]:
        ntype = node["type"]
        names = tuple(i.get("name") for i in (node.get("inputs") or [])
                      if isinstance(i, dict) and i.get("widget"))
        known = templates.get(ntype)
        if not known or () in known:
            continue
        if names not in known:
            problems.append(f"节点 {node['id']}（{ntype}）控件序列与真实工作流不一致：{names}")

    # 3) 数值覆盖：API 图里的每个输入都要在 UI 里找得到
    for ui_id, api_id in rev.items():
        api_node = graph[api_id]
        ui_node = ui_by_id[ui_id]
        entry = oi.get(api_node.get("class_type") or "")
        inputs = api_node.get("inputs") or {}
        widgets, leftover = read_widget_values(ui_node, entry)
        for key, value in inputs.items():
            if key in SKIP_INPUTS:
                continue
            if is_link(value):
                hit = next((i for i in ui_node["inputs"] if i.get("name") == key), None)
                if hit is None:
                    problems.append(f"节点 {ui_id} 的连线输入 {key} 在 UI 里缺失")
                elif hit.get("link") is None:
                    problems.append(f"节点 {ui_id} 的输入 {key} 在 UI 里没有链接")
                else:
                    link = next((lnk for lnk in ui["links"] if lnk[0] == hit["link"]), None)
                    if link and (link[1] != id_map[str(value[0])] or link[2] != value[1]):
                        problems.append(f"节点 {ui_id} 的输入 {key} 接到了错误的源")
                continue
            if key in widgets:
                if widgets[key] != value:
                    problems.append(f"节点 {ui_id}.{key} 控件值变了：{value!r} → {widgets[key]!r}")
            elif leftover:
                # 未声明控件（ShowText 的 text / rgthree 的对比图）落在尾部
                continue
            else:
                problems.append(f"节点 {ui_id}.{key} 在 UI 里没有对应控件值")

        # 模板存在但控件值为空，通常只是这个节点没有控件
        if leftover:
            notes.append(f"节点 {ui_id}（{ui_node['type']}）尾部有 {len(leftover)} 个扩展值")

    return problems, notes


def load_library(path: str):
    items = []
    for name in sorted(os.listdir(path), key=natural_key):
        if not name.lower().endswith(".json"):
            continue
        full = os.path.join(path, name)
        with open(full, encoding="utf-8") as fh:
            data = json.load(fh)
        graph = data.get("graph") if isinstance(data, dict) else None
        if not isinstance(graph, dict) or not graph:
            print(f"跳过 {name}：没有 graph")
            continue
        items.append({
            "file": name,
            "title": data.get("title") or os.path.splitext(name)[0],
            "graph": graph,
            "source": data,
        })
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description="把库里的 API 工作流转成 ComfyUI 界面格式")
    ap.add_argument("--lib", default=DEFAULT_LIB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--comfy", default=os.environ.get("COMFY_URL", DEFAULT_COMFY))
    ap.add_argument("--wf", default=DEFAULT_WF, help="ComfyUI 的真实工作流目录，用来做同类节点模板比对")
    args = ap.parse_args()

    items = load_library(args.lib)
    if not items:
        print("库里没有可转换的工作流")
        return 1
    os.makedirs(args.out, exist_ok=True)
    oi = ObjectInfo(args.comfy)
    templates = collect_templates(args.wf)
    extra_map = template_extra_widgets(templates, oi)

    manifest = []
    failures = 0
    for item in items:
        name = os.path.splitext(item["file"])[0]
        print(f"[{name}] 转换中…")
        try:
            ui, id_map, warnings = convert(item["graph"], oi, extra_map)
        except Exception as exc:  # noqa: BLE001
            print(f"  失败：{exc}")
            manifest.append({"file": item["file"], "ok": False, "error": str(exc)})
            failures += 1
            continue

        out_name = f"{name}.json"
        out_path = os.path.join(args.out, out_name)
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(ui, fh, ensure_ascii=False, indent=1)
            fh.write("\n")

        problems, notes = validate(ui, item["graph"], id_map, templates, oi)
        if problems:
            print(f"  写出 {out_name}，但校验有问题：")
            for p in problems:
                print(f"    · {p}")
            failures += 1
        else:
            print(f"  写出 {out_name}（{len(ui['nodes'])} 节点 / {len(ui['links'])} 连线）校验通过")
        for w in warnings:
            print(f"  注意：{w}")
        for n in notes:
            print(f"  提示：{n}")

        manifest.append({
            "file": out_name,
            "title": item["title"],
            "nodes": len(ui["nodes"]),
            "links": len(ui["links"]),
            "ok": not problems,
            "problems": problems,
            "warnings": warnings,
            "notes": notes,
        })

    with open(os.path.join(args.out, "_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    print(f"\n完成：{len(items) - failures}/{len(items)} 份通过，输出目录 {args.out}")
    return 0 if failures == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
