# 架构说明

> 这不是一份「设计文档」，是给接手的人看的现状说明：哪块代码负责什么、数据长什么样、哪些坑已经踩过。

## 一句话

一个零依赖的本地 Web 应用：**单个 Python 文件**同时充当静态服务器和 ComfyUI 代理，**单页原生 JS** 负责画布编辑，
所有状态存成 JSON 落在 `data/` 下。没有构建步骤，没有运行时依赖。
MCP 服务（`mcp_server.py`）是同一套 API 的第二个入口：HTTP 挂在 `POST /mcp`，stdio 模式只做转发。

```
浏览器 ──HTTP──> server.py ──HTTP/WS──> ComfyUI (127.0.0.1:8188)
   │                  │                        ↑
   └── static/*.js ───┘   读写 data/{canvas.json, projects/, history/, library/}
                      ↑
AI 客户端 ──stdio──> mcp_server.py ──POST /mcp──┘
```

## 服务端 `server.py`

单文件，基于 `http.server.ThreadingHTTPServer`。

| 层 | 说明 |
|---|---|
| 路由 | `do_GET/POST/PUT/DELETE` → `api_get/api_post/api_put/api_delete`，非 `/api/` 路径走 `serve_static` |
| 静态 | `static/` 与 `presets/`（直链 JSON，路径必须 `resolve()` 后仍在目录内，防穿越） |
| ComfyUI 代理 | `/api/analyze`（把 API 图转成节点+插槽，依赖 `/object_info`，失败不缓存）、`/api/run`、`/api/job`、`/api/cancel`、`/api/view`（透传 `Range`，视频可拖进度条） |
| 进度 | 后台线程订阅 ComfyUI 的 `/ws`，把 `progress` 写进内存 `PROGRESS`，`/api/job` 一并返回。**浏览器直连 ComfyUI 的 ws 会被 Origin 校验挡掉**，所以必须后端订阅。ws 一个数都没有时，`/api/job` 退一步去读 ComfyUI 控制台日志（`/internal/logs/raw`）里 tqdm 的百分比兜底 |
| 持久化 | `data/canvas.json`（旧版单画布，启动时迁移成 `projects/legacy`）、`data/projects/<id>.json`、`data/history/<stamp>.json`（最多 30 份）、`data/library/<name>.json`、`data/workflow_categories.json`（工作流分类表）、`data/asset-lib.json`（资产库的分组 / 归属 / 存放目录）+ `assets/`（资产库的图片本体，默认在程序目录下，可换到别的盘；生成完自动存一份，按时间+序号命名） |
| 并发 | 单用户假设：无锁、无鉴权，只绑 `127.0.0.1`。多标签页靠 `lastBootAt` 写保护拦旧会话 |

几个不显眼但重要的点：

- **`/api/analyze` 认两种格式**：API 格式直接用；界面格式（`nodes/links`）走 `ui_to_api()` 转换，
  转换需要 `/object_info` 提供控件顺序，所以离线时会明确报「连不上 ComfyUI」。
  **响应里会带回转换后的 API 图**（`result.graph`），前端存这份：界面格式导入时前端手里那份是
  `{nodes, links, widgets_values}`，既不能当图提交（ComfyUI 只认 `class_type`），又会把导出者的
  整份控件值（他上次填的提示词、图片名、种子）写进画布存档——数据残留的一大来路。`/api/run` 也做了同样的兜底转换。
- **keep-alive 下的 body 必须 drain**：404 之前不读完请求体会让下一个请求变成 `body+请求行` → `400 Bad request syntax`。
  `_body_read` 标记在每次 `do_*` 开头重置。
- **子图**（`definitions.subgraphs`）直接拒绝，提示先展开/导出 API —— 前端不解析子图。

### 工作流的「能力分类」和「我的分类」

一个工作流身上有两个分类字段，别混：

| 字段 | 谁给的 | 干什么 |
|---|---|---|
| `category` | `graph_category()` 扫 API 图推断（先看产物是不是视频/音频，再看吃不吃图，最后看有没有放大节点）；预设 JSON 顶层写 `category` 也认 | **能力**。高清按钮只挑 `upscale`、扩图只挑吃图的、纯文生图不会被挑去重绘。不能由用户随手改 |
| `group` | 用户在设置里选的，写进工作流 JSON 顶层 `group` | **组织**。设置里那份列表的分类、分类胶囊的计数。缺省等于 `category` |

分类表本身（名字、顺序）存在 `data/workflow_categories.json`，`GET/POST /api/wf/categories`
整体替换（服务端只做清洗：id 唯一、名字非空、最多 24 类）。默认 6 类就是 `CATEGORY_LABELS`
那 6 个，所以「没配过」和「配了默认值」长得一模一样。

- **为什么不让用户改 `category`**：它是功能正确性的一部分。用户把「局部重绘」挪进「文生图」分类，
  只该影响它在哪一组显示，不该让扩图把一张普通图喂给纯文生图流程（那样出图会和原图逐位相同）。
- **`group` 指向不存在的分类**：`catName()` 回落 `CAT_LABEL[id]`，再回落 `other`；设置的下拉里
  专门留一组「其他」收孤儿。删分类时**先把该分类下的工作流挪到 `other` 再删表**——反过来的话
  中途失败会留下一堆指向空分类的孤儿。
- **预设 + 库合成一份列表**（`presetOptions()`）：`preset:xxx.json` 与 `lib:名字` 两种 id，
  `loadGraphById()` 分别走 `/presets/` 和 `/api/library/`。早先只有预设进这个列表，自己存进库的
  工作流永远进不了生成器下拉和节点的选择器——用户的感受就是「工作流被固定死了」。
- **设置里的工作流区是一处，不是六处**：早先是「打开工作流库 / 管理库工作流 / 新增预设 /
  管理预设 / 导入工作流 JSON」六个按钮挤成两组，其中三对是同一件事。现在是一个下拉 + 一份列表
  （`#setWfList`，每行 名字 / 分类 / 默认 / 删除）+ 一排分类胶囊（`#setCats`）。
  `renderSetWorkflows(box)` 负责重绘，改完一处就调 `refreshSetWf()` 局部重绘——不重建整个面板，
  滚动位置不会跳回顶上。

### 进度百分比：两个来源，一条规矩

百分比只有两处能拿到，前端只认「最新已知」这一个值：

| 来源 | 怎么来 | 什么时候用 |
|---|---|---|
| websocket | 后台线程订阅 ComfyUI `/ws`，`progress` / `progress_state` → `_progress_update()` 累加各节点 `value/max` 写进 `PROGRESS`（只算 `max > 1` 的节点，99 封顶） | 主来源 |
| 控制台日志 | `GET /internal/logs/raw` 里 tqdm 行（` 42%\|███ \| 10/25`）→ `_log_progress()` 写进 `PROGRESS_LOG` | 只在 `PROGRESS` 一个数都没有时兜底 |

- **两个来源分开存，不合并算**：并进一张表就成了「日志 + 真节点」两个来源一起进分母，百分比会翻倍。
- **日志必须按提交时刻筛**：`/internal/logs/raw` 是最近 300 条的环形缓冲，上一单跑完的
  `100%|25/25` 会一直躺在里面。`/api/run` 成功时记 `PROMPT_START[pid]`，`_log_progress()`
  只认这之后的行，并留 3 秒余量；否则新任务刚提交就顶着 100% 不动。
- **前端：`progress == null` 只表示「这一拍没拿到新数字」**，不是「没有百分比」。遮罩
  （`genOverlayText`）、面板状态行、队列条目三处都沿用节点上记着的那个数，只有
  `resetProgress`（新一轮）/ `finishProgress`（100%）/ `clearProgress`（出错/取消）才清。
  早先只有遮罩做了沿用，状态行还在用当拍的 `p`，于是同一屏里「图上有 42%、旁边写着生成中 · …」——
  用户看到的仍然是「百分比有几率消失」。
- **节点重画时补一次**：`buildNode` 每次都新建一层 `.gen-overlay`（默认「隐藏 + 生成中…」），
  所以它建完要按 `overlayVisible(n)` / `genOverlayText(n)` 补回当前状态，否则生成到一半
  碰任何会让节点重画的按钮，图上的百分比就没了。

## 前端 `static/`

无构建、无框架，三个文件：

| 文件 | 职责 |
|---|---|
| `index.html` | 静态骨架（顶栏 / 首页 / 舞台 / dock / 弹窗），图标用 `<span data-icon="home">` 占位 |
| `icons.js` | 由 `tools/icons/gen.cjs` 从 IconPark 生成的静态 SVG path；`window.icon(name)` + `hydrateIcons()` |
| `app.js` | 全部逻辑，一个 IIFE（约 7600 行） |
| `style.css` | 全部样式，按「token → 基础组件 → 迭代覆盖层」叠加 |

`app.js` 内部大致分区（按出现顺序）：

1. **state**：`nodes / links / groups / view / selected / workflows / projectId`，`serialize()` 是唯一写盘口径；
2. **撤销**：`undoStack`（**不能叫 `history`**，会遮蔽 `window.history`，路由改写 hash 时会炸）；
3. **节点渲染**：`buildNode` 按类型分派（text / image / wf / out），端口 DOM 用 `Map` 建索引避免线性查找；
4. **连线**：`startLink → markLinkTargets → addLink`，类型校验在 `linkAllows()` 与 `addLink()` 各做一次；
5. **视图**：`#world` 上做 `transform`，`screenToWorld()` 换算；平移/缩放**不重画连线**（连线在同一坐标系里）；
6. **生成器**：图片节点选中时浮出 `.gen-panel`，一条底栏（工作流 / 参数胶囊 / 状态 / 生成）；
   所有浮层（参数弹层、工作流菜单、`@` 菜单）共用 `armPopClose(anchor)`：监听挂在 **document 捕获阶段**
   （`.gen-panel` 与 `#stage` 在冒泡早期 `stopPropagation`，挂冒泡会漏），菜单内部与锚点自己不关，
   点空白画布时 `stopPropagation()` 把这次点击吃掉——一个点击只做一件事，不会顺手把节点取消选中；
   画幅 · 清晰度 · 张数收在 `openGenOpts()` 的分组弹层里（十三种画幅用 `ratioGlyph()` 画成按比例变形的框）。
   清晰度 1K/2K/4K 是**长边像素**（1024/2048/4096），`calcDims()` 由长边反推短边；
   反过来（短边固定）会让 4K 的 21:9 变成 9552×4096（39MP），本地显存先炸。旧档位 preview/standard/hd 由 `OLD_SIZE` 迁到 1K/1K/2K。
   还能填自定义宽高（`gen.custom`，`snapDim()` 对齐 16），比例由 `aspectOf()` 反推、`fitCustom()` 在点画幅时保长边重算。
- **尺寸必须落到「出图节点」上**（`dimsTarget()`）：只有 `krea2-txt2img` 的 `EmptyLatentImage.width/height` 是字面量，
  另外三个预设都是 `width ← ResolutionSelector` 的连线；`analyze_graph` 跳过连线值，于是按插槽名一个也写不进去，
  面板上选的尺寸等于白选。做法是从 `KSampler.latent_image` 往上 BFS，找第一个同时有 `width`/`height` 的节点，
  把连线**换成字面量**（ComfyUI 的输入本来就能二选一）。找不到就 `sized=false`，前端状态栏写「尺寸由工作流决定」。
  被顶掉的那颗源头节点（`ResolutionSelector`）如果之后再没人引用，就从提交图里删掉，不留死节点。
- **张数同理，而且要如实上报**：`batch` 只有两种落点——命中节点的 `batch_size`，或名字带 `batch` 的
  number 插槽。都不满足时（自定义导入的工作流很常见）选 4 张只会出 1 张，所以 `buildGenGraph()`
  多返回一个 `batch: { value, applied }`，`applied=false` 时状态栏写「张数不生效（这张工作流没有批量插槽）」。
  不说清楚的话，「多图生成坏了」这种报障就只能靠猜。
- **`gen.size` 的合法性判断要认 `custom`**：`SIZES` 只有 `1k/2k/4k`，用 `!SIZES.some(...)` 一刀切会把
  `custom` 当成非法值顶回 `1k`——用户填的宽高还在 `gen.custom` 里，但 `calcDims()` 走 `size` 分支，
  于是「设 512×512 出 1024×1024」。`custom` 只有宽高缺失时才回落。
- **提示词落点不能取 `texts[0]`**（`promptPlan()`）：拼接器（`1hew_MultiStringJoin` / `StringConcatenate`）
  的 `input` / `separator` / `delimiter` 也是 `STRING`、节点 id 又更小，会排在前面，提示词被写进一个
  `string_1`/`string_2` 全是连线、根本不参与拼接的**空转填充位**——用户写的字一个都没进模型，
  出图完全由工作流自带的残留文本决定。正确做法是从 `KSampler.positive` 沿连线往上记「跳数」，
  在链上的 `text` 插槽里踢掉负面词、拼接器填充位、系统提示（`You are an expert…` 之类），
  剩下的取**离采样器最远**的那个当落点。「最远」不能换成「最近」：风格类工作流的正向链上挂着 LLM 扩写节点，
  它的系统提示比真正给人写的那句更靠近采样器，按「最近」会顶掉系统提示。
  落点与老逻辑（`texts[0]`）不一致时，状态栏报 `· 提示词→节点482`，否则用户没法自查「我的字去哪了」。
- **种子每次生成都要换**（`planSeed()`）：工作流里的 `seed` 是导出时冻结的字面量，`buildGenGraph` 以前
  完全不碰它，于是同一段提示词怎么点都出同一张。现在 `kind === 'seed'` 的插槽一律写本次种子——
  `seedMode: 'random'` 取 `2^32` 内的随机数，`'fixed'` 用 `gen.seed`（非法值钉在 0，不偷偷随机）。
  同一个工作流里的 `seed` 与 `noise_seed` 必须写**同一个值**，否则画面会被另一处钉死。
  实际用到的种子回写 `gen.seed` 并在状态栏报出来（`· 种子 3340352811`）——复现某一张全靠它。
  注意别往 `n.values` 里写：那是工作流节点的插槽值表，图片节点没有这个字段。
7. **持久化**：`queueSave()` 600ms 防抖 → localStorage 快照 + `/api/projects/<id>`；
8. **快捷键**：集中在两个 `keydown` 监听里（`F` 适配、`N` 新建、`Ctrl+Z/Y` 撤销重做、`Delete` 删除…）。

### 数据模型（画布快照）

```jsonc
{
  "version": 1, "savedAt": 0, "bootAt": 0, "seq": 40,
  "view": { "x": 0, "y": 0, "k": 1 },
  "name": "画布名", "snap": true, "linksHidden": false, "minimapOn": false,
  "groups": [], "links": [{ "id": "l1", "from": "t1", "to": "i2", "toKey": "in" }],
  "nodes": [
    { "id": "t1", "type": "text", "title": "提示词", "x": 0, "y": 0, "value": "..." },
    { "id": "w1", "type": "wf", "x": 0, "y": 0, "graph": { /* ComfyUI API 图 */ },
      "slots": [{ "key": "4.text", "kind": "text", "value": "..." }], "values": {}, "artifacts": [] },
    { "id": "i2", "type": "image", "x": 0, "y": 0,
      "gen": { "prompt": "...", "wf": "preset:krea2-txt2img.api.json", "aspect": "1:1",
               "size": "preview", "batch": 1, "seedMode": "random", "seed": 2718281828,
               "gallery": [], "idx": 0,
               "extras": ["i3"],   // @ 引用来的图（只存节点 id，图还是走 /api/view）
               "runs": [           // 生成历史：新的在前，最多 30 条（RUN_CAP）
                 { "at": 1793000000000, "prompt": "...", "seed": 2718281828,
                   "w": 1024, "h": 1024, "batch": 1, "wf": "preset:...",
                   "items": [] }   // 这一次出的全部产物，结构同 gallery
               ] } }
  ]
}
```

- **一个输入口可以挂多条连线**：`isMultiIn(node, key)` 只为文本/图片节点的 `in` 口返回 true，
  `addLink()` 对这类口是「追加」，其它口（工作流插槽、图片输出口）仍是「替换」——提交图上
  一个插槽只能有一个来源，多来源在这里无法表达。同一来源连两次会被挡掉（两条线会精确重叠）。
- 参考图有三种来源，统一由 `refsOf(node)` 归一：**连线**（连进本节点 `in` 口，可多条）、**经文本节点**
  （挂在左侧文本节点上，随提示词一起送）、**`@` 引用**（存在 `gen.extras`，不画线）。三种来源合起来
  **全部上传**，再按工作流的图片插槽数 `cap` 截断（`picked.slice(0, cap)`）——以前只传第一张，
  用户 `@` 了两张、第二张根本没进模型，这是「`@` 的图识别不准」的一半根因。
- 提示词里的 `@[图名]` 是**给人看的引用标记**，提交时由 `refMarks()` 改写成 `图N`（N ＝ 实际送去模型的
  顺序，从 1 起），**不是删掉**。删掉会得到「把 的画面放进 的排版里」，模型无从下手；而 `图1/图2`
  与 `images.image_1/2` 一一对应后，模型才知道哪张是「图1」。找不到对应图的 token（图被删了）
  才退化成空串。
- **绑定按 `images.image_N` 的 N 升序填**（`bindRefImages()`，在 `buildGenGraph()` 里）。工作流里的
  多图槽位不一定是 `image_1..N` 连续，也不一定按对象键顺序排；按 N 排才能保证「第一个 `@` 引用 → 最先
  那一槽」，与 `refMarks` 的编号对得上。多余的槽位 `delete` 掉并收集孤儿节点，画布图不够时同理。
- **工作流自带的图必须清掉**（`bindRefImages()` 的另一半职责）。工作流里编码器的 `images.image_1..N`
  常钉着导出者本地的图，用户看不见却参与条件编码。判定「一组多图输入」的办法：把每个连线输入归到
  `下游节点::去掉数字后缀的输入名`（`images.image_2` → `images.image_`），同键即同组；组内按序填入画布
  给的图，**填不满的槽位 `delete` 掉，没人再引用的 `LoadImage` 连节点一起删**——ComfyUI 校验提交图的
  每个节点，孤儿 `LoadImage` 指向不存在的文件会整体 400。画布一张图都没给时整组原样返回：这类组在
  `object_info` 里是 required，拆空即报错。
- 插槽排序由 `slot_sort_key()` 决定：`(kind, 节点 id 按数值, 负面词垫底, 输入名)`。负面词必须垫底，
  因为 `negative_prompt` 字母序在 `prompt` 前面（Qwen 系编码器就是这种结构）。**但排序只决定「设置」里的显示顺序，
  不再决定提示词写哪**——落点由 `promptPlan()` 沿正向链算（见上文），拼好的顺序里 `texts[0]` 可能是拼接器的填充位。
- 提示词输入框是 **contenteditable**（不是 textarea）：`@[图名]` 要渲染成内联缩略图胶囊，
  textarea 塞不进图片。胶囊是 `contentEditable=false` 的 `span.gen-chip`（`dataset.token` 存
  `@[图名]`，Backspace 整块删除），对外仍是一段纯文本——`promptText(el)` 把 DOM 走一遍还原
  `@[图名]` / `\n`，`fillPrompt(el, text)` 反过来按 token 切开重建。存档、提交、撤销栈都不用改
  （提交前那一步从「摘掉」改成「改写成图N」，见 `refMarks`）。回车固定 `insertLineBreak`（默认行为会包 `<div>`），粘贴只收
  `text/plain`。焦点守卫统一走 `FIELD_SEL`（含 `[contenteditable="true"]`），否则空格会去拖画布、
  `rerenderNode` 会在打字途中把节点重建掉。
- `@` 菜单的候选分两池（`refPools`）：**已关联**＝`refsOf` 里除 `at` 以外的（连线 / 经文本），
  **画布**＝其余有图的图片节点。菜单默认停在「已关联」，空的时候只给一行「浏览画布全部素材」，
  不主动把画布上的图摊开——没连线的图对当前节点没有关系，列出来像「凭空多了参考图」；
  「全部素材」页才是全局入口。触发正则 **不要求 `@` 前面是空格**（`/@([^\s@\[]{0,20})$/`），
  中文里「文案@」是最自然的打法；排除 `[` 是为了不把胶囊的 `@[名字]` 当成新起的引用。
- 同名的图（生成出来的节点标题都是「图片」）在菜单里补 `#1 #2`（`refLabelFn`，只在候选池里排），
  并把这个带序号的标签一起写进 token（`@[图片 #2]`）——否则 `nodeByTitle` 永远返回第一张同名图，
  胶囊会指错图。

- 图片节点的图**不进快照**：上传/生成后都记 `/api/view?...`，否则 localStorage 5MB 与 `keepalive` 都撑不住；
- 运行态（`busy` / `pid` / `timer` / `progress`）不进快照也不进撤销栈；
- 旧存档的 `toKey` 会在加载时迁移（`in` → `prompt/ref` → 统一 `in`，数值插槽的旧连线丢弃）。

### 多图结果（`gen.gallery`）与资产抽屉

一次出 N 张时结果全在 `gen.gallery`（`[{url, filename, subfolder, type}]`），`gen.idx` 只记「当前显示第几张」，
`node.dataURL` 始终等于 `gallery[idx].url`——所以**下游拿到的永远是用户正在看的那张**。

- `setGallery(n, i)` 取模环回，并且**先比对再落盘**（`k === idx && dataURL === url` 就返回 `false`），
  否则按住 → 键会把 `queueSave` 刷屏；
- 入口有四条，全都落到同一个 `setGallery`：缩略图左下 `n / N` 计数、两侧 `‹ ›`、圆点、键盘 `←/→`
  （键盘分支只在「选中了单个节点」时生效，且**大图开着时优先给大图翻页**）；
- 大图（`#lightbox`）也带翻页：`openLightbox(url, list, idx)` 收一个数组，翻页翻的是**这一组**——
  从资产抽屉点开的，翻的就是抽屉当前筛选结果，不是画布上那个节点的相册。

### 全局设置里的「运行记录」（`/api/history`）

面板是 `#appSettings`，左导航五格（工作流 / 运行记录 / 外观 / 连接 / 高级），
「运行记录」那一格用的是宫格：一格 = 一次执行，
封面取第一张产物（多图带 `N 图` 角标），没有产物的记录给一个占位块——它们照样能导入工作流。

**只有切到那一格才打 `/api/history`**（`setTab('history')` → `renderHistory()`）：离线时那是 502，
在开面板时就撞上只会先在控制台红一条。e2e 有一条断言盯着它：打开设置后 `#set-pane-history` 必须是空的。

### 工作流库 = 设置的第一格（`renderSetWorkflows`）

早先这里是「设置一条长滚动」+「资产库一整个弹窗」（`#modal`，已删除），同一个工作流列表在两处渲染：
弹窗里只能「挑一个加到画布」，设置里只能「改名 / 换分类 / 设默认 / 删除」。
现在只有一份列表（`presetOptions()`），一行五件套：
名字（点一下改名）/ 分类胶囊（点一下换类）/ ☆（设默认）/ 「加到画布」（`useWfItem` → `useGraph`）/ ×（删除）。

- 默认工作流以前是个按分类分组的 `<select>`，和列表列的是同一批东西 → 改成一行读数 `#setWfDefault`；
- 「加到画布」以前只在弹窗的卡片上 → 现在就在行里。`useGraph()` 会先 `closeSettingsSheet()` 再 `showCanvas()`：
  设置可以从首页打开（挑一个不用先进画布），但挑完是要往画布上落节点的；
- 面板尺寸写死 `880×640`（`max-width: 94vw` / `max-height: 90vh`）。
  **`max-height` 必须一起写**——`.sheet` 基类那条是 `78vh`，比这里的 `90vh` 更小，不覆盖就会悄悄把高度压下去；
- 左导航图标是运行时建出来的，`openSettingsSheet()` 末尾要补一次 `hydrateIcons(box)`，
  加载时那一次 hydrate 扫不到。

### 「连接」格里的三块

`#set-pane-conn` 从上到下是 **ComfyUI 地址 / MCP 接入 / 服务**，判断标准是同一条：
「这台机器怎么和外面连」。所以 MCP 不再是单独的整屏面板（`#mcpSetup`，已删除），
顶栏那盏灯只负责 `openSettingsSheet('mcp')` 把人送到这一格并滚到 `#setMcp`。

- 接入信息（`/api/mcp/setup` + `/api/health`）**切到这一格才拉**：`setTab('conn')` → `loadMcpSection(box)`，
  按 `box.dataset.mcpLoaded` 去重（面板每次打开都是新的 box，所以重开自然拿到新数据）；
- 复制 / 写入那几个按钮由 `bindMcpSection(box)` 在面板建好时绑定——DOM 是重建的，
  像以前那样在 `initMcpSetup()` 里绑一次会绑到不存在的节点上；
- `.mcp-json` 不设 `max-height`：外层那一格本来就在滚，再套一层只会让人不知道该滚哪个
  （横向仍可滚，JSON 里有很长的绝对路径）；
- 选中态与主按钮走中性白，和面板其它地方一致（设置面板里不用主题蓝，e2e 会扫）。

详情卡的内容**不是接口给的**：`/history` 只有 API 图和产物，提示词和采样参数得从图里挖
（`historyMeta()`）：

- 提示词：先收集所有 `inputs.text / prompt / string` 的字面量，**踢掉被 `KSampler.negative` 引用的节点**
  （那是负面词），再踢掉 LLM 扩写节点的系统提示（`You are an expert…`），剩下的取最长的那个；
- 参数：找第一个 `KSampler*` 节点取 `steps / cfg / sampler_name / seed|noise_seed`，
  再找第一个同时有 `width/height` 的节点当尺寸；
- 分辨率仍以图片真实像素为准（`naturalWidth`），节点里的 `width/height` 只作兜底。

没有产物的记录点了**直接导入工作流**（没有图可看，弹大图没意义）。

### 分组（`state.groups`）

一个组 = `{ id, name, nodeIds, color }`，随画布一起存（`serialize()` 里整块带走）。

- **颜色**：`GROUP_COLORS` 六色，`renderGroups()` 把 `--gc-line / --gc-fill / --gc-chip`
  三个变量写到组框上，CSS 只用变量——所以换色不用改类名，也不会漏掉某个子元素。
  新组按 `state.groups.length % 6` 依次取色，同一个画布里相邻的组不会撞色。
- **整框可拖**：`#groups` 排在 `#nodes` 前面（DOM 顺序即层级），所以点节点还是操作节点，
  点组框里的空白才落到 `.group` 上——正好是「按住组内任意空处拖整组」。
  以前只有顶部那条 `.group-head` 能拖，而它还挂在框外（`translateY(-100%)`），热区很窄。
- **改名**：双击 `.gname` 进编辑。不换成 `<input>`——换元素的话 `renderGroups()` 找不到
  `.gname` 会重建整个组头，编辑态就丢了。改成给 span 挂 `contenteditable`，编辑时先把文案
  缩成纯名字（不带「· N 节点」），收尾时关掉 contenteditable 再 `renderGroups()` 恢复完整文案。
  **Enter 直接调 `finish(true)`，不要靠 `span.blur()`**：元素没拿到焦点时 `blur()` 不触发 blur 事件，
  名字就白改了（e2e 里就是这么挂的）。
- 代价：组内空白不能再框选（pointerdown 被组框接管）。组内要框选得先解组，这个取舍写在验收报告里。

### 离开画布时把浮层收干净（`leaveCanvasChrome`）

首页 `#home` 是 `position: absolute; inset: 0; z-index: 45`，画布整块被它盖住——但画布那套
**屏幕坐标**浮层全挂在 `document.body` 上、`position: fixed`，`z-index` 还都比 45 高：
图片工具条 46、对齐条 45、连线删除 46、任务队列面板 60、资产抽屉 62。于是 `showHome()`
只把 `#home` 的 `.hidden` 去掉时，这些浮层照旧钉在视口上——用户截图里那条「裁剪 / 旋转 / …
/ 下载」就悬在首页项目卡片的上方，看着像首页自带的工具条。

`showHome()` 现在先调 `leaveCanvasChrome()` 再落盘，收三样东西：

- **清选中**（`state.selected` / `state.linkSel`）——最不容易漏的一条：图片工具条和对齐条本来就是
  `paintSelection()` 的产物（`imgToolNode()` 要求「单选 + 有图」），选中没了它们自己就收，
  连线删除按钮跟着 `linkSel` 走。新增浮层只要也挂在选中/连线上，就自动被这一条覆盖。
- **关资产抽屉与任务队列面板**（`closeAssetSheet()` / `closeQueue()`）——它们打开后一直挂着，
  各自的空值保护让重复调用无害。
- **不改 z-index 去「盖住」它们**：把 `#home` 抬到 46 以上会连带压掉 60/62 的抽屉和队列，
  再往上抬就顶到弹层（70/80/130）了；而且那些浮层在首页上本来就是**不该存在**的，
  藏起来只是掩盖「画布还在后台活着」。

e2e 有一条对着这个：选中图片节点 → 点返回首页 → 工具条 / 对齐条 / 连线删除都收起，
并且**原来那条工具条所在的位置**用 `elementFromPoint` 点下去必须落在 `#home` 里
（只断言 `classList.contains('hidden')` 挡不住「换成 `display:none` 又浮出来」这类回归）。

### 工具条的停靠位置（`state.dockSide`）

`#dockWrap`（工具条 + 圆球）的 `data-dock` 由 `applyDockSide()` 按 `state.dockSide` 设置，
CSS 四条 `[data-dock="…"]` 规则分别定位（底部/左侧/右侧/顶部，左右都是垂直居中）。

- 左右不做「左下/右下」：左下角是 `#viewTools`、右下角是 `#minimap`，放角上必撞。
- **左右停靠时 `#dockWrap` 和 `#bar` 都转成 `flex-direction: column`**：横排 301px 宽会横着
  压掉半个画布，竖排只有 54px。圆球跟着排到工具条下面，`.vsep` 也要从竖线改成横线
  （`width: 20px; height: 1px`），否则分隔线还竖在那儿很怪。
- 和 `panelSide` 一样，偏好是**字符串**，直接读写 `localStorage`（`setGlobalFlag` 只认布尔）。

### 生成器面板的位置（`state.panelSide`）

面板贴节点哪一侧由 `state.panelSide`（bottom / top / left / right）决定，
`buildGenPanel()` 把它写到 `panel.dataset.side`，CSS 四条 `[data-side="…"]` 规则分别定位。
上下方向跟节点同宽（`left/right: 8px`），左右方向固定 430px——两个方向都设 `left/right` 会拉满。

两个坑：

1. **面板挂在 `.node` 上，不是 `.node-card` 上。** 标题行在卡片外面（在 flow 里占高度），
   挂卡片上的话 `bottom: 100%` 只到卡片顶，面板会压住标题（实测差 19px）。
2. **`globalFlag` / `setGlobalFlag` 只认布尔**（存的是 `'1'`/`'0'`），拿它存 `'left'` 会被写成 `'1'`。
   字符串偏好直接读写 `localStorage`。

### 对齐 / 分布（`applyAlign`）

选中 ≥2 个节点时浮出一条**图标工具条**（`#alignBar`，`paintSelection` 里按
`state.selected.size` 切显隐）。位置由 `positionAlignBar()` 算：取选中节点的屏幕包围盒，
浮在其**上方居中**（间距 12px），上方不够就翻到下方，最后夹在视口内。

`#alignBar` 必须是 `<body>` 的直接子节点——它原本挂在 `dockWrap` 里，而 `dockWrap` 带
`backdrop-filter`，**会成为 `position: fixed` 的包含块**，于是 `left/top` 全按 dockWrap 算，
工具条会跑到屏幕外（这个坑只有量了 `getBoundingClientRect` 才看得出来，光看代码是"对的"）。按钮只建一次（`ensureAlignBar` 惰性构建），之后只切 `hidden`——
每次选中都重建会把 hover 和焦点一起弄丢。

图标来自 IconPark：`tools/icons/gen.cjs` 的 MAP 里加 8 个映射（`alignLeft` / `alignHCenter` /
`alignRight` / `alignTop` / `alignVCenter` / `alignBottom` / `distH` / `distV`），跑 `npm run icons`
重新生成 `static/icons.js`（该文件不要手改）。

- 基准是**整体包围盒**，不是"第一个选中的节点"——后者在框选时顺序不确定，用户也看不出规律。
- 宽度用 `nodeWidth()`（卡片宽度是确定的），**高度必须量 DOM**：`n.h` 只有手动拉过才有值，
  没拉过的节点是内容撑高的，用默认值会对不齐。量出来再除以 `state.view.k` 换算回世界坐标。
- 等距分布：两端不动，`gap = (总长 - 总宽) / (n - 1)`；gap 为负时就是贴紧（节点比可用空间还宽）。
- **目标列表在打开菜单时就抓下来**，不要在点菜单项时再读 `state.selected`：那一下 pointerdown
  会先冒泡到画布把选择清掉，等 click 触发时已经一个节点都不剩（菜单能开、点了没反应）。
- 对齐后调 `renderAll()`，而 `renderAll()` 是重建 DOM 的——它现在末尾会补一次 `paintSelection()`，
  否则选中高亮会在对齐后凭空消失（这个 bug 之前一直藏着，因为很少有操作在保持选中时重绘）。

### 生成历史（`gen.runs`）与宫格

`gen.gallery` 只装「当前显示的那一批」，`gen.runs` 是旁路记录：每生成一次压一条
（`at / prompt / seed / w / h / batch / wf / items`，新的在前，`RUN_CAP = 30`）。

- 节点缩略图右下角是 `N 次` 入口，点开是**三列宫格**（`.run-grid`），一格 = 一次生成，
  多图的格子带 `N 张` 角标，当前那格比对 `items` 的 url 数组来标（不能按位置——点过「换回节点」
  之后 gallery 会换成老那一批，位置就指错了）。
- 单击格子 → `openLightbox(url, items, 0, info)`，第四个参数是**右侧详情抽屉**的内容
  （`{ prompt, rows, actions }`）。分辨率取 `img.naturalWidth/Height`，**不取面板上填的值**——
  工作流可能不按面板尺寸出图。
- **四个放大入口共用同一张抽屉**：图片节点缩略图（放大按钮/双击）、资产抽屉的格子、
  工作流/输出节点的产物图、生成历史与运行记录的宫格。前三个各自带一个 `xxxImageInfo()`
  造 `{ prompt, rows }`——能拿到什么给什么，拿不到的行留空（`paintLightboxInfo` 会过滤），
  所以资产里的图没有提示词时不会显示一行空的「提示词」。
- 「这一组 n / N」由 `paintLightboxInfo` 自己按 `lbList` 追加，翻页时跟着变，调用方不用管。
- 抽屉靠 `#lightbox.has-info` 让位：`--lbi-w: min(420px, 92vw)` 同时用在
  `padding-right`（图片在剩下的区域里居中）、`img` 的 `max-width`、`.lb-next` 的 `right`、
  `.lb-count` 的 `left` 上——只改一个变量，四处跟着走。抽屉自己用 `transform: translateX(100%)`
  → `.open` 归零，滑入 240ms。
- 宫格**不能用 `aspect-ratio` 撑正方形**，理由和资产抽屉那节一样（grid 算行高时列宽未定，
  两者互相等对方）；这里用 `height:0 + padding-bottom:100%` + `img` 绝对定位。
- `#lightbox` 挂着「点一下就关」，所以抽屉必须 `stopPropagation`，否则在里面选文字就把图关了。

**资产库：一个真实目录 + 两路只读索引。**

2026-11-02 改版。上一版只有索引：分组是个标签、删除只是藏起来，用户没法真正组织自己的图。
现在资产库落在磁盘上：

```
<程序目录>/assets/             ← 未分组的图（默认；可改，见 asset-lib.json 的 root）
<程序目录>/assets/人像/         ← 分组 = 子文件夹
```

```
assets/**（两层）                      → source=lib     （库内文件，可改名 / 移动 / 删除）
history.outputs[*].images[]            → source=output  （生成结果，只读）
history.prompt[*].inputs.image(LoadImage) → source=input   （上传素材，只读）
前端 canvasAssets()                     → source=canvas  （画布上现有的图，服务端看不到）
```

- **默认目录跟着程序走**（`asset_root_default()`）：图是用户真正在乎的东西，数据目录是平台相关的
  （Windows 在 `%LOCALAPPDATA%`、macOS 在 `Application Support`），换台机器就找不到了；放程序旁边，
  整个文件夹拷走图就跟着走。三条例外都是为了不让人「突然看不到自己的图」：① 老版本已经攒了图的
  （`ROOT/assets` 不存在而旧目录存在）继续用旧目录，不搬；② 程序装在只读位置（Program Files /
  `.app` 包内）退回数据目录；③ 数据目录是**人明确指定的**（`INFISHEET_DATA` / `--data`，
  即 `DATA_EXPLICIT`）就放数据目录——指定数据目录就是「所有东西都在这儿」的意思，测试、多实例、
  容器挂卷都靠这条，否则图会写进程序目录、挂卷里反而看不到。
- **第一次打开问一次「生成的图存哪」**（`GET/POST /api/setup`，前端 `firstRunSetup()`）。默认目录
  在程序旁边，但用户得知道图在哪——哪天清理磁盘、换机器，才不会连攒的图一起丢掉。三条设计约束：
  ① **不阻塞**：卡片是浮层，boot 里 `firstRunSetup()` 不 await，用户不点也能先看画布；
  ② **不打扰**：`settings.json` 的 `setup_done` 或库里已经有图（老用户）就直接跳过；
  ③ **不骗人**：`probe_dir_writable()` 试写一个临时文件再删——目录**能建**不等于**能写**
  （Program Files 要管理员、`.app` 包内只读、只读挂载、断线的网络盘）。写不进去时「用默认」
  按钮禁用并要求换目录，而不是让他以为设好了。引导的两个按钮都复用 `root-set`，不另写一份校验：
  两份校验迟早长歪，引导里能过的路径抽屉里过不了，用户只会觉得「时好时坏」。
- **生成完自动存一份进库**，文件名「时间+序号」（`20261102-203104-01.png`，`import` 的
  `nameMode: "time"`）。触发点有两个：浏览器生成成功的分支（`autoImportAssets`）和 MCP 的
  `_settle_node`（`run_node` / `run_nodes` / `job_status` 写回都走它）。存完把对应的 ComfyUI 键
  标 `hidden`——库里已经有一份，「生成」页签再列一张一模一样的图只会让人以为出了两张。
  整个流程**失败静默**（磁盘满、权限、取图失败不该让一次成功的生成看起来像失败），但 MCP 侧第一次
  失败会往 stderr 报一句：这个功能曾经因为 `E()` 里没注入函数而整个失效，表现却是「什么都没发生」。
- **自动入库必须去重**：同一个 ComfyUI 文件只存一份。`items[key].imported` 记着「已经存成哪个库内
  文件」，下次直接跳过（`saved` 里回 `dup: true`）。不去重的话，MCP 写回、浏览器收尾、`job_status`
  反复查这三路都会触发，攒出一堆时间戳不同、内容完全一样的文件，用户还删不干净。改名 / 移动库内文件
  时要把这条记录跟着改，否则指向一个不存在的路径，去重就失效了。
- **为什么不把 ComfyUI 的产物直接当资产库**：ComfyUI 没有列目录的接口，每个人的输出目录位置都不同
  （便携版 / 秋叶版 / `--output-directory`），本地猜路径必然错一半。`/history` 里恰好两种都有，所以
  仍然只**索引**它；但历史会被清空（ComfyUI 重启、清过 `output/`），想留住就得**收进库**——复制一份
  到自己的目录。复制而不是移动：ComfyUI 那边的文件一个字不碰。
- **分组就是文件夹**，不是标签。这样资源管理器里直接建个「人像」把图拖进去也算分类：扫目录时发现
  没登记过的文件夹，会按目录名算一个稳定 id（`d` + md5 前 12 位）当成隐式分组返回，第一次被
  「移动到」点名时才补一条记录。改名分组 = 改目录名，删分组 = 把文件搬回根目录（文件不删）。
- **删除 = 真删，进系统回收站**。库内文件直接 `SHFileOperationW(FOF_ALLOWUNDO)`（macOS 走 Finder、
  Linux 走 `gio trash`），原位置立刻没有、原地址立刻 404；后悔了在回收站右键还原。**不再自建
  `.trash/` 目录**——那只是换个地方放着，用户翻不到也不会自动清理，用久了就是一份偷偷翻倍的磁盘占用。
  回收站不可用时**宁可报错也不退回 unlink**（不做不可逆的事）。
- **库外的图也能删，但必须先指定 ComfyUI 根目录**（`asset-lib.json` 的 `comfyDir`，抽屉底部第二行）。
  ComfyUI 没有「删文件」的接口，只能按 `<根>/output|input/子目录/文件名` 拼出磁盘路径；没指定就只写
  `hidden` 标记从列表移除，磁盘文件不动——**绝不猜路径**，删错别人的产物是不可逆的。
  删成功也照样写 `hidden`：`/history` 还留着那条记录，不隐藏的话下次刷新它又冒出来。
- **改名只对库内文件开放**：库外的名字来自 `/history`，改了下次读历史又变回去，是个假动作。
- **`/api/assets/file` 必须挡目录穿越**：`lib:相对路径` → `(root / rel).resolve()` 后要落在 `root` 之内，
  `../`、绝对路径、别的盘一律 400。这个接口是唯一一个按用户给的路径读文件的入口；
  `comfy_file_path()` 是第二个，同样要 `resolve()` 后落在 `<根>/output|input` 之内。

**资产库的用户数据（`data/asset-lib.json`）。**

```jsonc
{ "root": "D:/InfiSheet/assets",                       // 空 = 用默认 <程序目录>/assets
  "groups": [{ "id": "g1a19...", "name": "人像", "dir": "人像" }],
  "items":  { "output:/a.png": { "group": "g1a19...", "hidden": true,
                                 "imported": "20261102-203104-01.png" } } }   // 已存成哪个库内文件
```

- **键不是文件名**，是 `asset_key()` 拼的 `source:subfolder/filename`（库内是 `lib:相对路径`）。
  `output/` 和 `input/` 里可以有同名文件，只按文件名归组会把两张完全不同的图认成一张，
  删一张连另一张一起消失。画布上的图服务端看不见，它的键由前端按同一套规则拼
  `canvas:项目:节点:序号`——两边必须一致，改规则等于清空所有人攒的分组。
- `items` 里只存**库外**来源的归属、隐藏与已入库记录；库内文件的归属由它所在的文件夹决定，不重复记。
- 只存有信息量的条目：既没分组、没隐藏、也没有 `imported` 的直接不落盘，否则文件会随着用越攒越大。
- 落盘走临时文件 + `os.replace`；读坏了**不覆盖**——先改名留档 `.bad-时间戳`，再从空库开始，
  直接覆盖等于把用户攒的分组一次抹掉，而这个文件手改不回来。
- 写操作只有一个入口 `POST /api/assets/lib`，靠 `op` 分发（`group-add` / `group-rename` /
  `group-remove` / `assign` / `hide` / `import` / `rename` / `delete` / `root-set` / `comfy-dir`）。
  回包一律带最新的 `groups` + `meta` + `root` + `rootDefault` + `comfyDir`，前端一次往返就能刷完。
- **`root-set` 换目录**：新目录必须是绝对路径、不能是当前目录的上下级（会自己搬自己），
  逐个文件搬（跨盘自动退化成复制 + 删除），`failed` 里如实列出搬不动的。
  `path` 传**空串 = 恢复默认**（`asset_root_default()`）：改过一次自定义路径的人得有路可退，
  否则只能去数据目录里翻 `asset-lib.json` 手改。新目录正好是默认目录时把 `root` 存成空串，
  这样以后跟着默认规则走。
- **`comfyDir`**：ComfyUI 的安装目录（含 `output/` `input/`），只为删除库外文件服务。填 `output/`
  也会自动退到上一层。没配时 `GET /api/assets` 给每项回 `onDisk: false`，前端据此把「真删」和
  「只从列表移除」分开写进确认框——用户点之前就知道会发生什么。
- 前端的多选态是**独立的开关**（`assetPicking`）：开着时单击是勾选而不是开大图，`Shift` 从锚点连选；
  被筛掉的勾选会自动作废——看不见的东西不该被「删除」顺手带走。

### 遮罩（`node.masks`）

2026-11-01 重构。上一版挂在 `gen.mask`（节点级）+ 独立 mask PNG，三个硬伤：切 gallery 时
遮罩还停在第一张图上、重开靠「从导出 PNG 反推蓝色」（羽化/抗锯齿后必然走样）、图和遮罩是两个
文件靠插槽顺序配对。现在：

```jsonc
"masks": { "<图片身份>": { "w": 1024, "h": 1024, "strokes": [
  { "tool": "brush"|"eraser", "size": 48, "pts": [[x,y], ...] },
  { "tool": "rect", "rect": [x, y, w, h] }        // MCP 的 set_mask 用这个
], "cover": 17 } }
```

- **身份键**（`imgKeyOf`）只有一条要求：同一张图在上传前后必须算出同一个键。
  顺序是 gallery 文件名 → 上传文件名 → `node:<id>` 兜底。上传成功时 `migrateMaskKey()`
  把旧键搬过去——早期用 dataURL 兜底，上传把 dataURL 换成 `/api/view` 之后键就变了，
  遮罩当场消失且**没有任何报错**（涂了半天跑出一张原图）。
- **只存笔画不存位图**：10 笔约 2KB，重开是精确重放。
- **提交口径**：`bakeMaskCanvas()` 把笔画烘进原图 alpha（涂过处 alpha=0），一个文件上传。
  ComfyUI 的 `LoadImage` 输出 `mask = 1 - alpha`，即**透明 = 重绘**——和旧实现的「白底黑图」
  正好相反，写反就是整张重绘或整张不动。实测数据见验收报告。
- **预设靠 `takes_alpha_mask`**：`graph_takes()` 扫的是「有没有人在消费 `LoadImage` 的 MASK
  输出（索引 1）」，不看名字、也不看有没有 `LoadImageMask`。所以 `analyze_graph` 仍然跳过
  `LoadImageMask.image`——那种工作流在这套画布上跑不了遮罩，报 `takes_mask=true` 是空承诺。
- **工作流按「有没有遮罩」推导，不按记忆**：`reconcileWorkflow()` 每次生成前对一次，两个方向
  都要对，任一对不上都是「生成成功但图没变」这种最难自查的坏：
  - 有遮罩 + 工作流不吃遮罩 → mask 根本没进图，涂了白涂；
  - 没遮罩 + 工作流吃遮罩 → 普通图 alpha 全不透明 → mask 全 0 → 什么都不改，出图与原图逐位相同。
  自动挑的（`wfAuto`）两边都自己切并 `flash` 说明；用户手选过的不动，只提示并中止这一次。
- **`pickWorkflow()` 不挑吃遮罩的工作流**：`krea2-局部重绘` 的分类是 `img2img`，按文件名排序
  还排在最前，所以「按参考图自动挑」会一路挑到它——那等于每次都跑一次「什么都不改」。
  自动挑选的候选一律先滤掉 `alphaMask`，它只能由遮罩编辑器（`ensureMaskWorkflow`）显式选中。
- **工具条按钮只按机器能力禁用**：`maskCapable()` 只看这台机器上有没有吃遮罩的工作流，
  不看当前选的是哪张。早期按「当前工作流吃不吃」判断，老存档（wf 是文生图）一进来按钮就是
  灰的，用户只会认为功能坏了；现在打开时由 `ensureMaskWorkflow()` 当场切过去并说明换成了什么。
- 编辑器是**全屏浮层**，canvas 内部尺寸 = 原图像素，显示尺寸由 JS 按 contain 算一次写进
  `.me-frame`，落笔只有一处换算 `scale = doc.w / rect.width`——上一版挂在节点缩略图上，
  对位链条是 `--ar → aspect-ratio → object-fit: contain → inset:0`，任一环断就错位。
- **涂过的区域直接叠在节点图上**（`.thumb .mask-ov`，一张和原图同像素尺寸的 canvas）。
  框的比例就是图片比例、图片又铺满框，所以 canvas 直接 `100%×100%` 就对齐，不需要第二套换算。
  图片尺寸和遮罩对不上（这张图被换过内容）时不画预览——拉伸的预览比没有更误导。
- **颜色 / 透明度是显示偏好**，存 `localStorage`（`infisheet-mask-style`），不进存档也不进
  alpha：烘进图里的只有「涂过 / 没涂过」。换台机器看同一块遮罩不必长得一样。
- **遮罩要赶在聚焦提示词之前塞进新节点**：`rerenderNode()` 遇到「焦点在节点里的输入框」会直接
  跳过重建（保护打字焦点），而 `createEditNode()` 结尾刚好把光标放进新节点的提示词框。
  先建节点、搬遮罩、再聚焦——顺序反了，`masks` 数据是对的但 DOM 不刷新，节点上既没药丸也没
  预览，看着就像「没搬过去」。
- **擦除 / 去字的遮罩不回写源节点**：`openMaskEditor(n, { intent })` 走的是同一个编辑器，但
  永远从空白开始、应用后只把笔画带到新节点。这块区域属于「这一次操作」，不属于那张图；
  回写会让源图带着一块已经涂满的遮罩留到下一次，下次开编辑器直接是 100%。

### 图片工具条（十个工具，`IMG_TOOLS`）

分四段，`IMG_TOOL_BREAKS` 标出分隔线位置：**裁剪 / 旋转 / 调色** ｜ **遮罩 / 擦除 / 去字** ｜
**扩图 / 抠图 / 高清** ｜ **下载**。图标 + 文案都显示（只留图标时十个里有五个是「涂抹 / 编辑」类，
猜不出来），整条因此宽到 ~580px。第四段只有「下载」一颗：它不动像素、不跑工作流，混在
「高清 / 抠图」里会让人以为也要排队生成。

**「贴着谁」在扩图时是画布外框，不是节点**：`positionImgTools()` 先看这个节点有没有
`.op-stage`（扩图舞台），有就量它——画布往外长的时候节点只是其中一块，外框才是它真正的外形。
量不出宽（刚挂上、`draw()` 还没跑）才退回节点，别拿一个 0 宽的框去居中。`draw()` 末尾会
调 `scheduleFollowBars()` 重贴一次（和 `scheduleLayout` 分开：拖锚点只改外框，不用重画连线
和小地图）。

宽度带来的位置问题在 `positionImgTools()` 里解决。横向和纵向是分开挑的：

1. **横向**先取「居中于这个节点」；居中会被视口夹住时（节点贴着屏幕左/右边缘），再试
   「和节点左边缘对齐」「和节点右边缘对齐」——让整条朝画布空白的那一侧展开。三个候选都算
   「贴着自己这个节点」，e2e 按 `attached` 断言（居中或贴边，±2px）。
2. **纵向**：贴在节点标题上方（`place=above`）；压到别人的标题就往上抬，抬到那条标题上方为止
   （最多 3 次，可能一次撞一条更高的）。盖住标题不只是难看——那块点下去命中的是工具条
   （实测点标题点出了「旋转」菜单），用户会以为「这个节点点不中」。
3. **抬不动了**（节点本来就贴着屏幕上方，再抬就被 `#topBar` 挡住）：压在自己那张图的上沿
   （`place=over`）。试过翻到节点下方，图片节点下面紧跟着生成面板，会盖住「上传 / 素材库 /
   清空 / 风格」，还是同一类问题；压在自己图上谁也挡不着——这张图本来就是选中的那张。

横向的三个候选位置各跑一遍纵向规则，**取第一个真的不压别人标题的**；都压着就用居中那个
（此时「不挡标题」已经不可能：580px 的条摆在 380px 的节点上，旁边有邻居就一定会碰到）。
工具条本身 `pointer-events: none`、只有按钮吃点击，所以压住的那块画布/标题仍然点得动，
被挡住的只有按钮正下方那一小块。

三种落地方式，别混：

| 方式 | 工具 | 做什么 |
|---|---|---|
| 本地像素 | 旋转、调色 | `loadImageEl` → canvas → `addImageNode`，不碰工作流 |
| 本地撑画布 + 模型补 | 扩图 | 撑大画布（新边留透明）+ 四条边写成 `rect` 笔画 → 局部重绘 |
| 交给模型 | 擦除、去字、抠图、高清 | 新建节点 + 选工作流 + 预填提示词，遮罩走 `carryMask()` |

- **调色的预览和落地必须是同一串 filter**：预览是 `img.style.filter = colorFilter(v)`，落地是
  `ctx.filter = colorFilter(v)`，两处调同一个 `colorFilter()`。各写一份必然「看着调好了、
  应用出来不一样」。色温没有原生滤镜：暖 = `sepia` + `hue-rotate(-8deg)` + 提饱和，冷 = 反向。
- **调色面板是非模态的**：`#imgPanel` 只定位不铺底（`placeImgPanel` 按节点的屏幕坐标算，
  优先右侧、放不下挪左侧、两边都不行才压在图片下方），画布不压暗、不模糊。
  以前它是 `inset: 0` 的模态（62% 黑罩 + 3px 模糊）还居中压在图上——预览等于看不见，
  和「拖的时候画布上就是滤镜预览」自相矛盾。没有遮罩可点，所以出口是 × / 取消 / Esc。
- **扩图的尺寸必须 snap 到 16 的倍数**（`snapSide`）。为什么是 16 不是 8：生成面板的「自定义
  尺寸」走 `snapDim` 也是 16，两边步长不一致时 696 会被面板舍成 688，图上和设置里又对不上。
  比例越准越好，但小图会被台阶吃掉：16×16 扩成 16:9，最近的可行解是 32×16（2:1），这不是 bug。
  所以 e2e 只在小图上验「16 的倍数 + 真的变宽 + 四边透明」，精确比例交给 Node 级用 1024×768 验。
- **扩图的新边留透明**，不是填黑：`LoadImage` 的 `mask = 1 - alpha` 会把透明算成该重绘，
  所以就算矩形笔画丢了，模型也只会画边、不动中间——两层保险。
- **抠图按名字找专用工作流**（`pickWorkflowByHint(CUTOUT_HINTS)`：rembg / birefnet / matting…），
  找不到才退回通用图像编辑；名字命中的会 `wfAuto: false` 钉住，别被「按参考图自动挑」换掉。
- **`runImgTool()` 没有选中节点时要说话**：早期静默 `return`，用户只看到「点了没反应」。

### 裁剪 / 扩图共用一套控件

`.crop-box / .crop-head / .crop-ratios / .crop-ratio / .crop-foot / .crop-size / .crop-btn`
是图片工具的通用控件，`.crop-sel / .ch`（选区 + 八个锚点）两边共用。裁剪是整块浮层
（`#cropMask`）；扩图把「舞台」搬到了节点自己身上，锚点直接复用 `.crop-sel .ch`（形状和光标都一致）。
参数条是唯一的例外：扩图那条并进了生成面板（`.op-bar`，见下面「扩图的参数条并进生成面板」），
比例档藏进了「尺寸」下拉，`.crop-ratio` 现在只有裁剪在用。

### 扩图长在节点上（不是弹层，也不是新节点）

早期是「点扩图 → 全屏浮层拉框 → 点扩出来 → **新建**一个节点」。这套有两个硬伤：

1. 新节点的生成面板还停在默认的 1:1 · 1K，而图是 688×736——点生成按 1024×1024 跑，
   出来的图尺寸当然不对（用户截图里绿框圈的就是这个）；
2. 想微调边框得重新点一次扩图，改的还是**新**节点，越改越乱。

现在：**边框是节点的一个状态**（`gen.outpaint = {l,t,r,b,w,h}`）。点「扩图」就在这张图上
长出八个锚点，拖哪边扩哪边；点生成时才烘成像素（`bakeOutpaint`）。

- **边框只是状态，拖动时不烧像素**：只改 `pad` + 挪几个 div，不编码、不重渲染。
  拖 20 帧不会生成 20 张 PNG，松手也不写盘。
- **尺寸档和边框是同一份数据**：`syncOutpaintDims()` 把 `gen.size` 写成 `custom`、
  `gen.custom` 写成 `{nw, nh}`，面板那颗胶囊（`.go-sum`）读的就是它；拖动时
  `syncGenOpts()` 当场刷新（`buildGenPanel` 把闭包 `syncOpts` 挂在 `panel._syncOpts` 上，
  不重建面板，否则拖动会当场断掉、提示词光标也没了）。**这是那个尺寸 bug 的根因修法**。
- **烘在生成的最前面**：`generateImage()` 第一件事就是 `await bakeOutpaint(n)`——
  撑画布、原有笔画整体平移（扩图只挪位置不缩放，纯平移就是精确的）、四条带子补成 `rect` 笔画，
  然后清掉上传缓存（`n.uploaded = null`，否则 `ensureUploaded` 会把扩图前那个文件当参考图，
  遮罩却按新尺寸烘，两头错位）。之后那条生成流程完全不知道扩图这回事。
- **收起不烘**（再点扩图 / 参数条上的「取消」/ Esc）：清掉 `gen.outpaint`，并把尺寸档还给用户
  （开框前的 `{size, custom, aspect}` 存在 `gen.opBackup` 里）。
- **提示词只在空着时填模板**，并记一个 `gen.opPromptSet`：收起时如果用户一个字没改就还回去，
  别在他的节点上留一段莫名其妙的话。

**缩略图是原图的画框，舞台才是新画布**——两者不是一回事，这是「扩图」看起来像不像扩图的关键：

```
缩略图的 --ar = W / H（整个扩图期间不变，节点大小也就不会跳）
k = tw / W                                  ← **恒定**，原图铺满缩略图，一像素不缩
舞台 left/top = (-ox·k, -oy·k)，尺寸 nw·k × nh·k   ← 比缩略图大的部分真的往外溢出
原图 left/top = (ox·k, oy·k)，尺寸 W·k × H·k       ← 在缩略图里原地不动
四条带子按 % 摆（x/nw, y/nh），不依赖 k
拖动换算：dx / (k × state.view.k)            ← 屏幕像素 → 原图像素，必须带上视图缩放
```

早先是反着来的（`--ar` 改成 `nw/nh`、画布塞满缩略图、原图往里缩），拖右边时看到的只是
「图被压扁、框没变宽」——用户的原话就是「图片大小固定不变」。**画布得长出去，原图得站着不动。**

- **`k` 必须恒定，绝不能掺「画布别出视口」的约束**。掺进去 k 就随 pad 变：
  原图跟着缩小（实测拖到 4 倍时从 339px 掉到 152px），同一段鼠标位移换算出的像素数也变，
  越拖越快，手感直接崩。画布溢出视口就让溢出，用户自己平移/缩放画布即可。
- **拖动换算要乘视图缩放**。`style` 里写的是 CSS 像素，外面还套着 `#nodes { transform: scale }`，
  拿 CSS 比例去除，拖 100px 只扩 89px（视图 89% 时），缩到 50% 就只扩一半。
  注意这个函数里**别把局部变量叫 `state`**：模块级已经有一个 `state`，同名会把它整个遮住，
  `state.view.k` 静默变成 undefined → 1 —— 这个 bug 就是这么藏了两轮才被自检抓出来的。
- 舞台溢出后要压在邻居上面（`.node.op-raised { z-index: 30 }`），否则「长出去」的半边被别的节点挡住；
  反过来 `.node-title` 也要提一层，不然往上扩时画布会盖住标题里的「生成」。
- 锚点层（`.op-sel`）和舞台**同尺寸同位置**（`draw()` 一起设），所以锚点永远贴在画布边上。
  两者都挂在**缩略图**上：舞台要 `overflow: hidden` 才保得住圆角，而锚点故意露在框外 6px
  （和裁剪一样），挂在舞台里会被剪掉一半。缩略图因此要 `overflow: visible`。
- 舞台底色是**棋盘格**：扩出来的像素此刻还不存在，真实产物里也是透明的；纯黑会让人以为填上了。
- 扩图模式下缩略图里原有的 img / 遮罩预览 / 大图 / 翻页 / 历史全部让位（`.thumb.op-mode > *`），
  只留舞台和锚点。

### 扩图的参数条并进生成面板

参数条长这样，两行，是**生成面板里唯一还看得见的东西**（`.gen-panel > .op-bar`）：

```
上行  .of-row.of-prompt   提示词（textarea，按内容长高，6 行封顶）
下行  .of-row.of-params   工作流 ｜ 尺寸 ｜ 分辨率 ｜ 数量 ｜ 读数 …… 取消 ｜ 状态 ｜ 生成
```

顺序是「先看到自己在写什么，再是选项和那颗按钮」：提示词在上、参数在下（用户手绘的草图
就是这个形状——蓝色框在上、红色参数行和青色按钮在下）。**生成按钮必须留在参数行末尾**，
它是这条的终点。

它换过三次位置，每次都对应一个具体的失败：

1. 最初挂在节点里、跟着生成面板走，但画布是**往外长**的——往下拖时节点底边一直往外走，
   按钮被顶出视口，用户找不到出口只能猜 Esc。
2. 改成 `position: fixed`、挂在 `document.body` 上：不会再被顶出去了，但**跟不住节点**——
   节点在画布右边、条却钉在屏幕左下角，用户的原话是「无法跟随」。
3. 现在并回节点里，但**并进生成面板**而不是节点自己：面板本来就是绝对定位 + `--gp-k`
   抵消画布缩放的，跟着节点走是现成的；而面板内部是普通的流式布局，多一行不会打架。

- **面板整个收成这一条**：`.gen-panel.op-on` 藏掉 `.gen-chips`（上传 / 画布素材 / 清空 / 风格）、
  `.gen-prompt`（大提示词框）、`.gen-bar`（工作流胶囊 / 尺寸胶囊 / 状态 / 生成）。扩图时这几样
  要么用不上（图已经定了），要么和参数条上的控件同名同值，两处显示同一个值只会让人猜
  「改哪个才算数」。**e2e 别去查 `.wfsel` 的 `display`** —— 它藏在自己的父级里，自身 computed
  仍是 `flex`；查的是那三个容器被藏 + 面板里可见的孩子只剩 `.op-bar`。
- **`.gen-run` / `.gen-status` 是「搬」不是「复制」**：`buildOutpaintFrame` 把它们从 `.gen-bar`
  挪进 `.of-prompt`。`refreshGenPanel` 靠这两个选择器在面板里找它们，搬家后照样找得到，
  于是生成 / 进度 / 报错那一整套逻辑一行都不用改（复制一份的话两份状态迟早对不上）。
- **输入框改的就是 `n.gen.prompt`**：`generateImage` 取的是 `rawPrompt = g.prompt`，所以不必给
  扩图另开一个字段；顺手 `delete n.gen.opPromptSet`——用户改过，收起时就不该再把模板收回去。
  Enter 生成、Shift+Enter 换行（多行框里这两个键最容易点错，约定写死在 `keydown` 里），
  并且 `stopPropagation`，别让画布的 Delete / 空格平移吃到输入。
- **是多行 `textarea`，不是单行 `input`**：扩图模板本来就两行字，单行输入框把它截成
  「…主体」那种看不全的样子（用户截图里那半句话就是这么来的）。`fitPrompt()` 按
  `scrollHeight` 长高、`132px`（约 6 行）封顶后自己滚。**量到 `scrollHeight === 0` 就直接返回**：
  `buildGenPanel` 是在节点插进 `#nodes` 之前跑的，那时量不到内容高度，写 `height:0` 会把框压成一条线。
- **`resize: none` 的选择器要带 `.node`**：上面 `.node textarea { resize: vertical }` 是 (0,1,1)，
  光写 `.of-input` 的 (0,1,0) 压不住，右下角那颗拖拽手柄会一直露着。
- **宽度放宽到 `min(720px, calc(100vw - 32px))`**：面板原来 364px 装不下「工作流 + 尺寸 +
  分辨率 + 数量 + 读数 + 取消」，硬塞会换行成三条。
- **参数行是 `flex-wrap: nowrap`**：以前是 wrap，工作流名（`Qwen-image-2.1图像编辑`）+
  读数（`1056 × 1216 → 1648 × 1216`）+ 状态（`完成 · 77s · 1 张`）一起变长时，
  生成按钮会被挤到下一行**单独占一行**，看着像面板多长了一条腿。现在放不下就让能截断的
  各自截断：工作流名 `max-width: 200px` + 文字在 `span` 里（flex 容器上 `text-overflow`
  不生效，必须包一层）、读数可收缩并带 `title` 全文、状态 `max-width: 34%`。
  `@media (max-width: 560px)` 退回 wrap——手机 / 分屏下宁可换行，也别把生成按钮切到面板外。
- **没有「完成」**：收起来就是「取消」（不烘、不改图、尺寸档还回去），烘像素只发生在点「生成」时。
- **四个下拉都走 `openPopMenu`**（只能放按钮）；「自定义尺寸…」要塞两个输入框，所以单独拼了
  `.of-dim` 弹层（`.go-num` 的样式原来只在 `.gen-opts` 下面定义，这里自带一份）。
- **`.of-btn` 要写进全局胶囊规则的 `:not()` 链**：`button:not(#newCanvas):not(…)` 里带了 ID，
  特异度比 `.of-btn` 高得多，不豁免的话所有参数按钮都会被做成 999px 胶囊
  （「取消」那个左侧直角的按钮最明显，会变成一个圆环）。
- **尺寸档是反推出来的**：`sizeTag()` 拿当前 `pad` 去比对「每个比例档算出来的 pad」，
  对不上就报「自定义」；四边全 0 报「原图」。所以拖过锚点之后按钮会自己改口，不用额外记状态。
- **「原图（不扩）」是重置项**：拖歪了不用一格一格拖回来。
- **`outpaintFrame` 里一根轴一边都没扩时按原图尺寸算**（不走 `snapSide`）：原图 700 宽会被舍成
  704，明明一格没扩、读数却写着「700 → 704」，看着像白扩了 4px。
- **纯图片节点（`n.plain`）没有生成面板**，参数条就没地方挂：`toggleOutpaint` 会先
  `delete n.plain` 把面板打开（和标题上那颗「生成」药丸一个效果）。
- **工具条的参照物是画布外框（`.op-stage`），不是节点**：扩图时节点只是画布的一块，外框才是
  它真正的外形。贴着节点摆会落在框**里面**、还压着标题；跟着缩略图居中的话，框往右边长出去
  之后整条就偏到左边（用户截图里「悬在框上方偏左」）。`positionImgTools()` 先量 `.op-stage`，
  量不出宽（刚挂上、`draw` 还没跑）才退回节点。
- **外框变了要重贴**：`draw()` 末尾调 `scheduleFollowBars()`（只重贴浮条，不动连线 / 小地图，
  和 `scheduleLayout` 分开）。早先只有「换节点 / 平移画布」会重贴，拖锚点不会——拖完
  `toolsDx` 会差出半个扩出来的宽度。

### 扩图的工作流：吃遮罩 / 整图，两条路

扩图撑大画布之后新边是透明的，能不能补出来取决于用户选的工作流**吃不吃图**：

| 工作流 | `bakeOutpaint` 做什么 | 结果 |
|---|---|---|
| 吃遮罩（`takes_alpha_mask`，局部重绘） | 新边写成矩形遮罩笔画 | 只重绘那几圈，最准 |
| 吃图不吃遮罩（图生图 / 图像编辑 / 高清） | 只撑画布，不写遮罩 | 新边透明 → `LoadImage` 的 IMAGE 变黑边 → 模型整张重画一遍 |
| 完全不吃图（纯文生图） | —— | 喂进去的图会被默默丢掉，出来是一张新图；`ensureOutpaintWorkflow()` 在开扩图时就换掉并说清楚 |

**早先的 bug**：`bakeOutpaint` 无条件把新边写成遮罩，于是 `reconcileWorkflow` 的 `needMask`
分支必然命中——只要用户选的工作流不吃遮罩，点生成就被静默换成 `opts.find(o => o.alphaMask)`。
用户的原话是「虽然可以选择工作流，但一旦点击生成就跳转到默认的工作流」。

三处一起改：

- `bakeOutpaint` 按 `alphaMask` 决定写不写新边笔画（**用户自己涂的笔画照样保留**）；
- `toggleOutpaint` 从 `ensureMaskWorkflow` 换成 `ensureOutpaintWorkflow`——只要求**吃图**，
  只有纯文生图才换；
- 参数条的工作流下拉 `filter(o => o.image)`，前缀标「遮罩 · / 整图 ·」，选谁就是谁。

**扩图 + 用户自己涂了遮罩**：`needMask` 仍是 true（旧笔画还在），这时 `reconcileWorkflow`
会把不吃遮罩的工作流换掉并提示「这张图有遮罩，只能用吃遮罩的工作流」——遮罩必须被消费，
这是唯一允许「换掉用户选择」的情况。

### 面板也贴着画布外框（`--op-pb` / `--op-dx`）

工具条在外框**上方**居中，面板在外框**下方**——同一条规矩的另一半。早先面板钉在节点下沿，
外框往下长多少它就压住多少新扩出来的地方（用户截图里那个黄框整块盖在棋盘格上）。

```
--op-pb = 外框底边超出缩略图的高度（世界像素）  → top: calc(100% + gap + var(--op-pb))
--op-dx = 外框中线相对缩略图中线的偏移（世界像素） → left: calc(50% + var(--op-dx))
```

- 两个值都由 `placePanel()` 按当前 `pad` 算，默认 0 就等于原来的位置，所以只有 `.gen-panel.op-on`
  才吃这条规则。
- **要减掉 `slack`**：`top: 100%` 是**节点盒子**的底，缩略图底下还留着一截边距；不减掉它，
  面板会被白白推开 20px（实测 `frameGap` 从 10 变 29），跟工具条那 8px 的贴边对不上。
- **要夹住视口**：外框比屏幕还高时「贴着外框」就是把面板顶出屏幕，「生成」就点不着了。
  顶到 `innerHeight - 64`（给底部工具条让位）/ 顶栏下方 8px 就停住，宁可压住一点画面。
  和工具条「居中 → 被夹住就贴边」是同一套退让。
- **两类调用方**：`draw()`（pad 变了）和 `applyView()`（平移 / 缩放）。面板本身是世界坐标的，
  但「别顶出屏幕」是屏幕坐标的事，视图一动就得重算——所以 `placePanel` 挂在
  `opSession.place` 上给 `applyView` 用。`fitPrompt()` 里也要调一次：输入框长高，面板就长高。
- **`placePanel` 用函数声明、不用 `const` 箭头**：`fitPrompt()` 在面板还没挂进 DOM 时就会调到它，
  那时 `el` 还没赋值——靠第一行 `panel.isConnected` 提前返回，函数声明提升才不会撞 TDZ。

### 扩图的四边是独立的（`pad` 是唯一真源）

早期扩图只有「选一个比例」或「四周各扩 N%」，两边永远对称。现在八个锚点（四角 + 四边中点）
都能拖，四边可以各扩不一样——用户要的是「左边多留点放标题」这种，对称做不到。

状态只有一个：`pad = {l, t, r, b}`（**原图像素**，不是百分比）。比例档、滑杆、拖锚点都只是
改写它的三种输入方式，谁都不能自己另存一份。

四个纯函数分工（都在 `static/app.js` 里，e2e 用 `pickFn` 抠出来单测）：

| 函数 | 输入 → 输出 | 负责 |
|---|---|---|
| `outpaintPad(w, h, ratio, padPct)` | 图尺寸 + 比例/百分比 → `{l,t,r,b}` | 把「比例」或「四周各扩 N%」翻译成四边像素 |
| `fitPad(a, c, base)` | 一根轴上的两边 → `[A, C]` | 凑成整数，且两边之和正好等于 snap 后的增量 |
| `outpaintFrame(w, h, pad)` | 图尺寸 + `pad` → `{nw,nh,ox,oy}` | snap、夹紧、算出新画布和原图落点 |
| `outpaintBands(w,h,nw,nh,ox,oy)` | 上面两者 → `[[x,y,w,h], …]` | 算出「新长出来的部分」是哪些矩形（遮罩就涂这些） |

- **`fitPad` 的存在是为了让比例档扩出来仍然对称**：`snapSide` 会把总宽取整到 16，
  多退少补的那几像素得有地方去。`fitPad` 按比例把它分回两边，于是 `pad` 已经是整数、
  两边之和正好等于格子宽度，`outpaintFrame` 不用再分零头。
- **`outpaintFrame` 的 `ox/oy` 钉在左/上（`Math.round(l)`），零头全落右/下**。
  早先是「零头两边平分」，结果拖右边时画布一跳档，左边也跟着挪一两像素——明明只动了一条边，
  图却整体位移，手感很怪。手拖出来的不对称 `pad` 走这条路；比例档由 `fitPad` 保证对称。
- **`ox/oy` 必须取整并夹到 `[0, nw-w]`**：不取整会得到 `ox: 204.00000000000006` 这种零头，
  「带子面积 + 原图面积 = 画布面积」这条恒等式永远差一点点，e2e 里看着像遮罩漏了一像素。
- **不要用 `w + 16` 兜底**：那多出来的一格会全落到**没被拖的那一边**（拖左边 5px，右边凭空长 11px）。
  拖得不够一格就是没反应，这是取整的必然，不该用「另一边乱长」去掩盖。
- **`outpaintBands` 四条边各自独立判断**，不能写成「有上下就推两条」：只扩左边时（`oy === 0`）
  那样会一条都不推，遮罩是空的。带子面积加起来必须正好等于 `nw·nh - W·H`，e2e 直接断言这个。
- **锚点用增量算，除以 `k`**：`dx = (clientX - 上次 clientX) / k`。用绝对坐标算，会在拖动中途
  改了 `pad` 之后自己跟自己对不上（画布一变，`k` 可能被视口上限压小，屏幕坐标和原图像素就不是一个比例了）。
- **拖过锚点就退出比例档**：高亮全撤（按「pad 等于哪一档」反推，所以拖完自然全灭），
  读数照实报 `W × H → nw × nh`。
- **`OP_MAX_SIDE = 4096` 只削正在拖的那一边**：整块一起缩会让没拖的边也跟着动，手感很怪。
- **`pad` 在开框时用 `img.naturalWidth/Height` 记下来**（存在 `gen.outpaint.w/h` 里）：
  拖动时不能临时去读图，渲染那一刻它可能还没解码。

### CSS 的三层结构（也是已知债）

`style.css` 是几轮视觉迭代叠出来的，实际生效顺序是：**基础 token → 组件 → 覆盖层**。
最后的「统一设计 token」一节用具体色值覆盖前面的变量和规则，所以：

- 改颜色优先改最后一节的 token；
- 加新组件时注意 `.node xxx` 这类宽松选择器会命中节点卡片里的**生成器面板**（曾经把面板里的输入框压塌过）；
- 胶囊/正圆由最后一节的 `border-radius` 覆盖统一，例外用 `:not()` 显式排除（首页大卡、能力入口、快捷卡）。

**grid 里别用 `aspect-ratio` 撑正方形格子**（资产抽屉连翻两次的地方）。`img { width:100%; aspect-ratio:1/1 }`
放进 `grid-template-columns: repeat(3, 1fr)` 时，算行高的那一趟单元格宽度还没定，百分比和 `aspect-ratio`
互相等对方，Chromium 退化成用非图片内容量高度——实测 `grid-template-rows` 只剩 28.17px（文件名那一行），
而单元格自己按 `aspect-ratio` 拿到 117px，于是每行都把上一行盖住。改用
`height: 0; padding-bottom: 100%`（百分比 padding 相对**栅格区域宽度**算，不依赖自身高度）+ `img` 绝对定位铺满。
配套：格子容器用 `<div role="button" tabIndex="0">` 而不是 `<button>`（button 是表单控件，flow-root，
这类撑高法不可靠），回车/空格键手动补 `onkeydown`。

### MCP 服务（`mcp_server.py`）

给 AI 客户端用的第二个入口。**协议在 mcp_server，HTTP 外壳在 server**：

| 层 | 位置 | 说明 |
|---|---|---|
| HTTP | `server.py` 的 `mcp_post()` | 解析 JSON、发 `Mcp-Session-Id`、通知回 202；协议错误回 JSON-RPC 的 `-32700` 而不是 400 页面 |
| 协议 | `mcp_server.handle()` | `initialize` / `tools/list` / `tools/call` / `ping`；`resources/list`、`prompts/list` 回空表（有些客户端无条件拉） |
| 工具 | `TOOLS` 注册表 | 21 个，装饰器 `@tool(name, desc, props, required)` 登记，schema 和实现写在一起 |
| stdio | `stdio_main()` | 只做转发：每行 JSON → `POST /mcp`。服务没起来时 `_spawn_server()` 拉一次（`DETACHED_PROCESS`，桥退出后服务还在） |

环境用 `configure(SimpleNamespace(...))` 注入（数据目录 + `comfy_request` / `analyze_graph` /
`list_presets` / `job_status`），**不 import server**——避免循环依赖，也让协议与工具能脱离服务单测。

三个必须守住的口径：

1. **生成逻辑有两份实现，规则必须一致。** `prompt_plan` / `dims_target` / `bind_ref_images` /
   `build_gen_graph` / `ref_marks` / `calc_dims` 在 mcp_server 里是 `app.js` 的 Python 移植。
   改了一边不改另一边，就会出现「浏览器出的图和 AI 跑出来的图不一样」——这类 bug 极难查，
   因为两边都「能跑」。改这些函数时对着两份代码一起改。
2. **写画布走同一条持久化通路，带 rev 乐观锁。** `save_canvas(..., base_rev=)`：服务端只递增 rev，
   客户端只上报「我是从哪一版改的」。落后就回 `conflict`，`mutate()` 重读重试；
   浏览器那边的 `baseRev` 落后则回 `stale`，由前端拉最新版（先把本地压进撤销栈）而不是覆盖。
   `beforeunload` 的 keepalive 保存也带 `baseRev`——否则「关标签页」就是一次绕过检查的强制覆盖。
3. **MCP 的「当前项目」是独立的。** 存在 `data/mcp.json`，不碰浏览器 localStorage 那个；
   没有就取最近修改的项目，再没有就自动建「MCP 画布」。`use_project` 才切。
4. **「关闭服务」是先回响应再停进程。** `POST /api/shutdown` 立刻回 `{"ok":true}`，然后由后台线程
   等 0.4s 再 `shutdown()` + `server_close()` + `os._exit(0)`。顺序反了响应会被掐断，前端只看到
   「请求失败」，用户会以为按钮没生效。同源校验挡掉跨站 POST（本地服务没有鉴权）。
   前端拿到 ok 后置 `state.serverDown`，`health()` 与 `pollProjectRev()` 直接短路——否则关闭后
   那两发定时请求会一直往空端口打，控制台刷红。
5. **「断开」靠心跳租约，不靠客户端通知。** 客户端死了不会发告别消息，所以 stdio 桥每 `lease/3` 秒
   `POST /api/mcp/heartbeat` 续租，`alive` 由 `status()` **现算**（不落成状态，避免「谁去把它改回来」）。
   HTTP 直连没有心跳通道，`alive` 就跟 `connected` 走——说它断了等于瞎猜。
   前端 `updateMcpChip()` 因此是三态：已连接（绿）/ 已断开（灰，连过但现在没心跳）/ 待接入（灰，从没连过）。

不做的：工作流节点运行、鉴权。（遮罩 / 局部重绘于 2026-11-01 重构回归：遮罩按图片身份
存矢量笔画，生成时烘进原图 alpha，走 `LoadImage` 的 MASK 输出——不需要 `LoadImageMask`，
图和遮罩天然配对。扩图在 2026-11-02 补上：本地撑画布 + 四条透明边当遮罩，交给局部重绘补画。）

### 测试为什么这么分层

| 层 | 文件 | 依赖 | 能证明什么 |
|---|---|---|---|
| 冒烟 | `tests/smoke.py` | 只要 Python | 服务能起、静态/接口/项目 CRUD/防穿越 |
| 接口回归 | `selftest.py` | **需要 ComfyUI** | 真提交一个 64×64 任务并轮询到 success、Range、502 分支 |
| MCP | `tests/mcp.py` | 只要 Python | 协议握手、21 个工具、rev 乐观锁、stdio 桥（ComfyUI 在线时真出图） |
| 浏览器 e2e | `tests/e2e/run.mjs` | Python + Chrome | 真实点击/渲染：图标填充、生成器布局、路由、MCP 改动自动同步、控制台零报错 |

e2e 里凡涉及 `/api/assets` 的断言都只能写**相对关系**（格子数 ≥ 画布图数、计数文字 ＝ `${n} 项`、
大图计数 ＝ `1 / ${当场格子数}`）：本机 ComfyUI 在线时会多出几十条真实产物，写死数字就变成环境依赖。

浏览器层用 CDP 手写驱动（`tests/e2e/cdp.mjs`），不引 Playwright —— 只需要「开页面、点、读计算样式、截图」。

## 已知边界

- 单机单用户、无鉴权；不要 `--host 0.0.0.0`。
- 不做工作流图编辑（结构改动请回 ComfyUI）；只调参数、连线、运行。
- 图片节点固定 380 宽、高度随图；不支持自由缩放。
- 生成器只认「文本插槽 / width / height / batch_size」这套约定，别的参数在工作流设置弹层里改。
