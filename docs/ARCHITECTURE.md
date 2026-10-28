# 架构说明

> 这不是一份「设计文档」，是给接手的人看的现状说明：哪块代码负责什么、数据长什么样、哪些坑已经踩过。

## 一句话

一个零依赖的本地 Web 应用：**单个 Python 文件**同时充当静态服务器和 ComfyUI 代理，**单页原生 JS** 负责画布编辑，
所有状态存成 JSON 落在 `data/` 下。没有构建步骤，没有运行时依赖。

```
浏览器 ──HTTP──> server.py ──HTTP/WS──> ComfyUI (127.0.0.1:8188)
   │                  │
   └── static/*.js ───┘   读写 data/{canvas.json, projects/, history/, library/}
```

## 服务端 `server.py`

单文件（约 1400 行），基于 `http.server.ThreadingHTTPServer`。

| 层 | 说明 |
|---|---|
| 路由 | `do_GET/POST/PUT/DELETE` → `api_get/api_post/api_put/api_delete`，非 `/api/` 路径走 `serve_static` |
| 静态 | `static/` 与 `presets/`（直链 JSON，路径必须 `resolve()` 后仍在目录内，防穿越） |
| ComfyUI 代理 | `/api/analyze`（把 API 图转成节点+插槽，依赖 `/object_info`，失败不缓存）、`/api/run`、`/api/job`、`/api/cancel`、`/api/view`（透传 `Range`，视频可拖进度条） |
| 进度 | 后台线程订阅 ComfyUI 的 `/ws`，把 `progress` 写进内存 `PROGRESS`，`/api/job` 一并返回。**浏览器直连 ComfyUI 的 ws 会被 Origin 校验挡掉**，所以必须后端订阅 |
| 持久化 | `data/canvas.json`（旧版单画布，启动时迁移成 `projects/legacy`）、`data/projects/<id>.json`、`data/history/<stamp>.json`（最多 30 份）、`data/library/<name>.json` |
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

## 前端 `static/`

无构建、无框架，三个文件：

| 文件 | 职责 |
|---|---|
| `index.html` | 静态骨架（顶栏 / 首页 / 舞台 / dock / 弹窗），图标用 `<span data-icon="home">` 占位 |
| `icons.js` | 由 `tools/icons/gen.cjs` 从 IconPark 生成的静态 SVG path；`window.icon(name)` + `hydrateIcons()` |
| `app.js` | 全部逻辑，一个 IIFE（约 5100 行） |
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

### 「资产库」里的运行记录（`/api/history`）

弹窗标题是「资产库」，四个标签页里「ComfyUI 运行记录」用的是宫格：一格 = 一次执行，
封面取第一张产物（多图带 `N 图` 角标），没有产物的记录给一个占位块——它们照样能导入工作流。

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

### 工具条的停靠位置（`state.dockSide`）

`#dockWrap`（工具条 + 圆球）的 `data-dock` 由 `applyDockSide()` 按 `state.dockSide` 设置，
CSS 四条 `[data-dock="…"]` 规则分别定位（底部/左侧/右侧/顶部，左右都是垂直居中）。

- 左右不做「左下/右下」：左下角是 `#viewTools`、右下角是 `#minimap`，放角上必撞。
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

**资产抽屉（`/api/assets`）的取舍：只索引，不复制。**

```
history.outputs[*].images[]            → source=output   （生成结果）
history.prompt[*].inputs.image(LoadImage) → source=input   （上传素材）
前端 canvasAssets()                     → source=canvas   （画布上现有的图，服务端看不到）
```

不扫 `output/` 目录的原因：ComfyUI 没有列目录的接口，而每个人的输出目录位置都不同（便携版 / 秋叶版 /
`--output-directory`），本地猜路径必然错一半；反过来 `/history` 天然只包含**真用过的**图，不会把几百张
陈年缓存倒进来。代价是历史被清空（ComfyUI 重启）后 `output` 那部分就没了——所以画布上的图由前端补，
离线（`comfy=false`）时抽屉也不会是空的。

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

### 测试为什么这么分层

| 层 | 文件 | 依赖 | 能证明什么 |
|---|---|---|---|
| 冒烟 | `tests/smoke.py` | 只要 Python | 服务能起、静态/接口/项目 CRUD/防穿越 |
| 接口回归 | `selftest.py` | **需要 ComfyUI** | 真提交一个 64×64 任务并轮询到 success、Range、502 分支 |
| 浏览器 e2e | `tests/e2e/run.mjs` | Python + Chrome | 真实点击/渲染：图标填充、生成器布局、路由、控制台零报错 |

e2e 里凡涉及 `/api/assets` 的断言都只能写**相对关系**（格子数 ≥ 画布图数、计数文字 ＝ `${n} 项`、
大图计数 ＝ `1 / ${当场格子数}`）：本机 ComfyUI 在线时会多出几十条真实产物，写死数字就变成环境依赖。

浏览器层用 CDP 手写驱动（`tests/e2e/cdp.mjs`），不引 Playwright —— 只需要「开页面、点、读计算样式、截图」。

## 已知边界

- 单机单用户、无鉴权；不要 `--host 0.0.0.0`。
- 不做工作流图编辑（结构改动请回 ComfyUI）；只调参数、连线、运行。
- 图片节点固定 380 宽、高度随图；不支持自由缩放。
- 生成器只认「文本插槽 / width / height / batch_size」这套约定，别的参数在工作流设置弹层里改。
