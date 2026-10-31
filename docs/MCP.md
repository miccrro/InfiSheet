# MCP：让 AI 直接操作画布

InfiSheet 内置一个 **MCP Server**。接上之后，AI 客户端（Claude Desktop / WorkBuddy / Cursor / 任何支持
MCP 的工具）可以自己读画布、建节点、连线、改参数、跑生成、取结果——**不需要打开浏览器**。
浏览器开着的话，AI 做的事会在 4 秒内长到画面上。

零依赖：MCP 的 JSON-RPC 是手写的（`mcp_server.py`，只用 Python 标准库），没有装任何 SDK 或 npm 包。

```
AI 客户端 ──stdio──> mcp_server.py ──HTTP──> server.py ──HTTP/WS──> ComfyUI
     │                  （薄转发）              │
     └──────────HTTP /mcp ───────────────────┘
```

两种接入方式共用同一份实现：`server.py` 提供 `POST /mcp`，`mcp_server.py` 的 stdio 模式只做转发。
所以不存在「stdio 能用、HTTP 行为不一样」这种事。

---

## 一、30 秒接入

### 方式 0：直接点顶栏那盏灯（最省事）

画布顶栏的 **MCP 待接入 / 已连接** 那盏灯是个按钮，点开就是「接入面板」：

- 当前状态（谁接进来了 / 已断开 / 还没人接）
- **HTTP 端点**，一键复制
- 三个客户端（WorkBuddy / CodeBuddy、Claude Desktop、Cursor）的**配置文件路径 + 能直接抄的 JSON**
- **「写入这个文件」**：替你合并进配置（先备份、解析不了就不动、原子写），回显路径与备份名

写入后：WorkBuddy / CodeBuddy 到连接器管理右上角「自定义连接器」点 **Trust**（新条目不会自动生效）；
Claude Desktop 重启客户端。接上之后灯自己变绿，不用刷新页面。

> 接口就是 `GET /api/mcp/setup`（返回端点 / python / 脚本路径 / 三个客户端的片段）和
> `POST /api/mcp/install {"client":"workbuddy|claude|cursor"}`（合并写入）。
> 写的是**白名单里的三个已知路径**，不接受任意路径；测试用 `INFISHEET_MCP_HOME` 隔离到临时目录。

### 方式 A：stdio（客户端自己拉起，最省事）

`mcp_server.py` 发现本地服务没跑时会**自动拉起 `server.py`**（后台常驻，桥退出也不影响），
所以配置里只要一行命令。

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "infisheet": {
      "command": "python",
      "args": ["E:\\InfiSheet\\mcp_server.py"]
    }
  }
}
```

**WorkBuddy / CodeBuddy**（`~/.workbuddy/mcp.json`）：

```json
{
  "mcpServers": {
    "infisheet": {
      "type": "stdio",
      "command": "python",
      "args": ["E:\\InfiSheet\\mcp_server.py"]
    }
  }
}
```

端口不是 8788 就加 `--port 9000`；不想让它自动起服务就加 `--no-autostart`。
`python` 换成绝对路径更稳（Windows 上可以是 `E:\\python-3.13.11\\python.exe`）。

### 方式 B：HTTP（自己先开服务）

```bash
python server.py            # 或双击 启动.bat
```

客户端里填 `http://127.0.0.1:8788/mcp`（Streamable HTTP）。适合已经有服务在跑、
或者想多个客户端共用一个画布进程的情况。

协议细节：`POST /mcp` 收发 JSON-RPC 2.0；`initialize` 会回一个 `Mcp-Session-Id`（之后带上即可，
我们无状态，不带也收）；通知（没有 `id` 的消息）回 `202` 空 body；`GET /mcp` 回 `405`
（本项目没有服务端主动推送，按规范回 405 而不是 404）。

---

## 二、它有哪些工具

21 个，按用途分四组。工具描述里写了「什么时候该用我」，模型自己会挑。

| 组 | 工具 | 干什么 |
|---|---|---|
| 读 | `infisheet_status` | ComfyUI 在不在线、当前项目、项目总数。**不确定能不能生成时先问它** |
| 读 | `list_projects` | 列出所有画布（节点数 / 连线数 / rev） |
| 读 | `get_canvas` | 画布内容：节点清单 + 连线。默认 brief，省 token |
| 读 | `get_node` | 单个节点的完整内容（插槽、生成历史、参考图） |
| 读 | `list_workflows` | 预设 + 工作流库，标明**吃不吃图** |
| 读 | `search_styles` | 397 个 Krea2 风格里检索，名字可直接传给生成工具 |
| 项目 | `create_project` / `use_project` | 建新画布 / 切换 MCP 的当前项目（不影响浏览器开着的那个） |
| 写 | `add_text_node` | 加提示词节点，可顺带连到某个图片节点 |
| 写 | `add_image_node` | 加图片节点（提示词 / 工作流 / 画幅 / 尺寸 / 张数 / 种子 / 风格 / 参考图） |
| 写 | `add_workflow_node` | 把整张 API 图摆到画布上，插槽可调 |
| 写 | `update_node` | 改标题 / 文本 / 位置 |
| 写 | `set_generation` | 只改传进来的生成参数，其它不动 |
| 写 | `delete_nodes` | 删节点（连带连线） |
| 写 | `connect_nodes` / `disconnect_nodes` | 连线 / 断线（带类型校验） |
| 写 | `upload_image` | 本地图片上传进 ComfyUI 并建成节点（当参考图用） |
| 跑 | `run_node` | 构建提交图 → 提交 → （默认）等出图 → 把结果写回节点 |
| 跑 | `job_status` / `cancel_job` | 查任务 / 取消任务 |
| 跑 | `list_runs` | 某个图片节点的生成历史（种子、尺寸、产物） |

---

## 三、典型用法

**一句话出图：**

```text
add_image_node(prompt="一只橘猫坐在窗台上，午后阳光，胶片颗粒", aspect="16:9", size="2k")
→ i2
run_node(node="i2")
→ 生成完成 · 19s · 2048×1152 · 种子 3019839714 · 1 张
```

**在已有画布上改一版，不动原图：**

```text
get_canvas()                       # 找到那个图片节点，比如 i7
list_runs(node="i7")               # 拿到上一版满意的种子
set_generation(node="i7", seed=1234567, seed_mode="fixed", prompt="…改一改…")
run_node(node="i7")                # 结果进节点，同时留一条生成历史
```

**带参考图：**

```text
upload_image(path="D:\\ref\\room.png")     → i9
add_image_node(prompt="把 @[room] 的光线改成黄昏", refs=["i9"])
run_node(...)                              # @[room] 提交时改写成「图1」，和送进去的顺序对得上
```

**风格：**

```text
search_styles(query="胶片")     → 找到中文名
add_image_node(prompt="海边灯塔", style="胶片摄影")
```

---

## 四、几个必须知道的口径

**1. MCP 的「当前项目」和浏览器的是两套。**
浏览器记在 `localStorage`，MCP 记在 `data/mcp.json`。没指定过就用最近修改的那个项目；
一个项目都没有时，第一次写入会自动建一个「MCP 画布」。想让两边对齐就 `use_project`。

**2. 选工作流看能力，不看名字。**
`list_workflows` 里的 `takes_image` / `takes_mask` 是扫 API 图得出的（有没有 `LoadImage` /
`LoadImageMask`）。`Moss_图像编辑` 名字带「编辑」，其实是纯文生图——按名字猜能力是上一轮修掉的 bug，
MCP 沿用同一套判断。

**3. 提示词落点由服务端算，和浏览器同一套规则。**
沿 `KSampler.positive` 往上找「离采样器最远的内容型文本」，跳过拼接器的 `separator` / `input`
这类填充位。所以 MCP 写进去的那句话，和你在面板里手打的那句话，落到同一个节点上。
`run_node` 的返回里如果出现「提示词→节点482」，说明落点和「第一个文本插槽」不一致——那是正常的纠正。

**4. 种子每次都是新的。**
`seed_mode` 默认 `random`，同一段提示词不会出同一张图。想复现就 `seed_mode="fixed"` + `seed=…`，
数从 `list_runs` 里拿。

**5. 遮罩/局部重绘已经不在了。**
2026-10-31 把遮罩功能整套删掉（涂抹编辑器、局部重绘/消除/扩图、`krea2-inpaint` 预设），
所以 `run_node` 不会遇到 `LoadImageMask`；自己导入带它的工作流，那个输入也不会被当成插槽暴露。

**6. `run_node` 只跑图片节点。**
工作流节点请用 `add_workflow_node` 摆上去，在浏览器里调插槽后运行。

---

## 五、和浏览器并用

两边都能写画布，所以存档带了一个 `rev`（版本号，只由服务端递增）：

- 浏览器保存时带 `baseRev`。落后就**拒绝写入**并回 `stale`，不会把 AI 刚做的改动静默抹掉；
- 浏览器每 4 秒对一次版本号，发现变了就拉最新那版重画——**AI 建节点、出图，你能看着它长出来**；
- 同步前会把本地那份压进**撤销栈**：`Ctrl+Z` 能回到自己那一版（撤销快照不带 rev，回来照样能存）；
- 另一个标签页/旧会话的改动只提示、不抢。

`beforeunload` 那一发 `keepalive` 保存也带 `baseRev`，否则「关标签页」就是一次绕过版本检查的强制覆盖。

---

## 六、顶栏那盏「MCP 已连接」灯

画布顶栏状态条上多了个指示器，用来回答一个只有用户关心、日志里却看不出来的问题：**现在到底有没有 AI 接着？**

| 显示 | 含义 |
|---|---|
| ● MCP 已连接 · WorkBuddy（绿） | 有客户端在跟这个服务说话，后面那个是**接进来的应用名** |
| ● MCP 已连接（绿） | 同上，但拿不到应用名（既没自报，也读不到宿主进程） |
| ● MCP 已断开 · WorkBuddy（灰） | 连过，但**心跳停了超过租约**：桥没了（客户端关窗 / 崩溃 / 被任务管理器杀掉） |
| ● MCP 待接入（灰） | 端点已就绪，但还没有客户端接进来（或者这个进程从没接过） |

- **名字从哪来**（两条路，一条自报、一条实测）：
  1. `initialize` 的 `clientInfo.name`（+ 版本放 tooltip）。stdio 桥会把这一对记下来，
     **之后每条转发都带 `X-MCP-Client: 名字/版本`**——服务重启后客户端不会重新握手，这是唯一的身份来源。
  2. 桥还会带 `X-MCP-Host: 宿主应用名`：**拉起这个桥的进程**的父进程名（跳过 cmd / bash / python 这类外壳）。
     客户端没法伪造它，也不需要配合。

  两条路的分工：自报的名字**优先**，但它有可能是垃圾——实测 WorkBuddy 传的是
  `{"name": "infisheet", "version": "1.0.0"}`，那是 mcp.json 里的**服务器别名**加一个占位版本，
  照抄的结果就是灯上写着「MCP 已连接 · infisheet」，用户看到的是镜子里的我们。
  所以自报值等于本服务名（`SERVER_INFO.name`）或占位词（`MCP 客户端` / `未命名客户端` / `unknown`）时一律不采信，
  改用 `X-MCP-Host` 的宿主名。名字太长会省略号收尾（只收名字，「MCP 已连接」永远完整）。
- **什么时候亮**：客户端（含 stdio 桥转发过来的）发出 `initialize` 的瞬间，或者**成功调用任何工具**的时候。
  前端下一次健康检查（≤10s）就会亮，**不用刷新页面**，并弹一条 `MCP 已连接：<应用名> 现在可以直接操作这块画布`。
- **为什么工具调用也算**：服务重启（改代码、换端口）之后，客户端**不会重新握手**——它手里那条会话照用，
  工具请求直接打过来。只认 `initialize` 的话，这种情况灯会一直灰着，明明能用。
  这时名字靠桥的 `X-MCP-Client` 头补上；连头都没有就只显示「MCP 已连接」，title 里点明是重启后续接的会话。
- **鼠标悬停**能看到详情：应用名与版本、连上时间、已调用工具次数、协议版本、会话号前 8 位、端点地址；
  名字是用宿主名顶上的话，会多一行说明「这个名字取自拉起 MCP 桥的应用——客户端自报的是服务器别名，没有采用」。
- **什么时候灭（断开）**：stdio 桥活着的时候，每 `lease/3` 秒（默认 10s）敲一次
  `POST /api/mcp/heartbeat` 续租；超过租约（`--mcp-lease`，默认 30s）没心跳，这条接入就判离线，
  灯变成「MCP 已断开 · 应用名」。**桥是客户端拉起来的**，客户端关窗、崩溃、被任务管理器杀掉，
  桥都没了，心跳自然停——这是唯一可靠的断开信号（客户端不会发告别消息）。
  租约调到 0 可以关掉这套判定（灯永不熄灭，老行为）。
- **HTTP 直连不判死活**：没有心跳通道，说它断了等于瞎猜，所以 `alive` 跟 `connected` 走。
- **进程重启仍然归零**：`python server.py` 一重启这份状态就清空，桥的下一拍心跳（≤10s）会把灯重新点亮，
  不用等客户端重新握手——宁可短暂显示灰色，也不留一个可能是假的绿灯。
- **灯亮 ≠ 正在干活**：心跳只证明「客户端还在」，不代表此刻正在跑任务。
- 数据流：`mcp_server._CONN` → `GET /api/health` 的 `mcp` 字段 → `updateMcpChip()`。老服务端没有 `mcp` 字段时
  指示器仍显示「待接入」，但 title 会直说「重启 python server.py 后这里显示真实状态」。

---

## 七、边界与排错

| 现象 | 原因 / 怎么办 |
|---|---|
| `连不上 InfiSheet 服务（127.0.0.1:8788）` | 服务没跑且自动拉起失败。手动 `python server.py` 看报错；端口被占就 `--port` 换一个 |
| 工具报 `连不上 ComfyUI` | `127.0.0.1:8188` 没开，或模型没加载。先 `infisheet_status` |
| `ComfyUI 拒收了这张图（400）` | 工作流要的模型/文件不在本机，或节点参数非法。报错里带 ComfyUI 的原始 error |
| `画布正在被另一个会话反复修改` | 浏览器一直在写（比如正在拖节点）。停一下再试 |
| 客户端里看不到工具 | 看客户端的 MCP 日志；stdio 桥的日志走 stderr，不污染 JSON-RPC |

安全：和主服务一样**只绑 `127.0.0.1`、没有鉴权**，默认就是「本机单用户」。不要把端口暴露到局域网，
`--host 0.0.0.0` 目前不支持也不建议。

---

## 八、测试

```bash
python tests/mcp.py      # 62 项：协议 / 工具 / rev 锁 / health 灯数据 / 心跳与租约 / stdio 桥（+ ComfyUI 在线时真出图）
npm run test:mcp
```

不需要浏览器。ComfyUI 没开时，真出图那几条会标 `SKIP`，其余照跑。
租约那几条用 `--mcp-lease 2` 起隔离实例，不用真等 30 秒。

浏览器那一侧由 `npm run test:e2e` 覆盖四条：外部改画布后自动同步、顶栏那盏灯握手后点亮、
心跳停掉后自己变「已断开」、重新心跳后又变绿。
