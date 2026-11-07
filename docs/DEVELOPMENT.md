# 开发指引

## 需要什么

| 依赖 | 版本 | 用途 |
|---|---|---|
| Python | 3.9+ | 跑 `server.py`、`mcp_server.py`、`selftest.py`、`tests/smoke.py`、`tests/mcp.py`、`tools/pack.py` |
| Node.js | **22+** | 只有测试/图标/打包脚本用；`tests/e2e/cdp.mjs` 依赖全局 `WebSocket` |
| Chrome / Chromium | 任意近期版本 | 只有 e2e 用；找不到时设 `CHROME_PATH=/path/to/chrome` |
| ComfyUI | 0.4+（默认 `127.0.0.1:8188`） | 产品要它才出图；`npm test` 不需要，`npm run test:api` 需要 |

产品本身**零运行时依赖**：没有构建、没有打包器，`python server.py` 就是全部。

## 跑起来

```bash
python server.py                # 打开浏览器到 http://127.0.0.1:8788
python server.py --no-browser   # 不自动开浏览器（开发时常用）
python server.py --port 9000 --data ./tmp-data   # 换端口 / 隔离数据目录（工作流库就在 data/library/）
```

Windows 上双击 `启动.bat` 等价。

### 多平台入口与数据目录

三个平台跑同一份代码（纯标准库），入口脚本只负责「找 Python + cd 到脚本目录 + 版本把关」：
`启动.bat`（Windows）/ `启动.command`（macOS，首次要右键→打开）/ `start.sh`（Linux）。

macOS 那个脚本额外做了三件事，都是为了「双击之后不能只闪一下就没了」：
① 确认 `python3` 真的能跑（没装命令行工具的机器上 `/usr/bin/python3` 只是个壳，
报 `command line tools are required` 而且退出码有时还是 0）；② 拦下 3.9 以下；
③ 服务异常退出时把原因打在窗口里并 `read` 停住，顺带提示端口被占用可以 `--port` 换一个。
执行位在仓库里是 `100755`（`git update-index --chmod=+x`），`tools/pack.py` 打 zip 时也显式写 0755——
但 **GitHub 的 zip 下载不保留执行位**，所以 README 里给了 `chmod +x` / `bash 启动.command` 两条兜底。

数据目录优先级：`--data` > `INFISHEET_DATA` > 程序目录下的 `./data`（存在就沿用，老用户不搬家）>
平台标准目录（Windows `%LOCALAPPDATA%\InfiSheet`、macOS `~/Library/Application Support/InfiSheet`、
Linux `$XDG_DATA_HOME/InfiSheet`）。最后一档是为了程序被放进只读位置（`/opt`、Program Files、`.app` 包内）时还能写。

界面里改过的东西存在 `<数据目录>/settings.json`（目前只有 ComfyUI 地址）。它的优先级是
`--comfy` > `settings.json` > `COMFY_URL` 环境变量 > 默认 `127.0.0.1:8188`——把保存的排在环境变量前面，
是因为容器里 compose 永远带着 `COMFY_URL`，否则界面里改的地址每次重启都会被盖回去。

访问 ComfyUI 的请求**显式绕过 `HTTP_PROXY`**（`_COMFY_OPENER`）：本地/局域网服务走代理只会得到
一个 502，还会把「ComfyUI 没开」伪装成「代理出错」。

```bash
INFISHEET_DATA=~/infisheet-data python server.py          # 环境变量指目录
python server.py --host 0.0.0.0 --token 你的口令          # 局域网访问（非回环来源要令牌）
python server.py --host 0.0.0.0 --yes-i-know             # 明知会暴露、仍然不设令牌
```

没令牌又监听非回环地址时**直接拒绝启动**（退出码 2）—— ComfyUI 自己没有鉴权，一句警告挡不住
「同网段谁都能用你的显卡」。令牌只约束非本机来源：`127.0.0.1` 和 MCP 的 stdio 桥不受影响。

容器：`docker compose up -d`（8788 端口，数据挂 `./data`，ComfyUI 走 `host.docker.internal:8188`）。
容器里的 `127.0.0.1` 是容器自己，所以镜像默认带 `--yes-i-know`；要让同网段访问就在 compose 里打开
`INFISHEET_TOKEN` 那行。

## 常用脚本

```bash
npm install          # 只装开发依赖（prettier），产品不需要
npm run dev          # 8788 + 不自动开浏览器
npm run check        # 所有 js 语法检查 + py_compile（不装 linter 也能跑）
npm test             # 冒烟：静态/接口/项目 CRUD/防穿越 + 启动守卫/访问令牌/数据目录（不需要 ComfyUI）
npm run test:api     # 完整接口回归：会真的往 ComfyUI 丢一个 64×64 任务
npm run test:mcp     # MCP 协议与工具（不用浏览器）
npm run test:e2e     # 浏览器 e2e：headed 用 HEADED=1；容器/沙箱里 Chrome 起不来时加 CHROME_NO_SANDBOX=1
npm run shots        # 截一套图到 tests/.tmp/shots/（改完 UI 看效果用）
npm run pack         # 打 zip 到 dist/（加 -- --with-data 连 data/ 一起）
```

测试产物都在 `tests/.tmp/`（已 gitignore），跑完自动清理；要留现场用 `python tests/smoke.py --keep`。

## 目录

```
server.py              # 全部后端（静态 + ComfyUI 代理 + 持久化）
selftest.py            # 需要 ComfyUI 的接口回归
static/                # 前端三件套 + icons.js（生成物）+ logos/（模型商标，128px 白色透明底 PNG）
tests/fixtures/workflows/  # 工作流样本（真机导出的 API 图），四套测试共用
tests/smoke.py         # 无依赖冒烟
tests/mcp.py           # MCP 协议 / 工具 / rev 锁 / stdio 桥
tests/e2e/             # CDP 驱动的浏览器测试与截图脚本
  cdp.mjs              #   驱动核心（起 Chrome / eval / 点 / 拖 / 截图）
  run.mjs              #   断言式 e2e（npm run test:e2e）
  walkthrough.mjs      #   截图走查（npm run shots）
  probe.mjs            #   任意探针：对已运行实例跑一个 body 模块
  fixtures/            #   测试用的小画布
tools/check.mjs        # 语法自检
tools/pack.py          # 打 zip
tools/logos_white.py   # 把 static/logos/ 的商标统一成白色透明底（换图后跑一次）
docs/                  # 这份文档 + 架构说明
data/                  # 运行时生成，不进版本库（projects/ 画布、library/ 工作流、icons/ 工作流图标、assets/ 资产库）
```

## 改 UI 的节奏

1. `npm run dev`，浏览器打开 `http://127.0.0.1:8788`；
2. 改 `static/style.css` / `app.js`，刷新即可（**没有 HMR**；`static/` 是每次请求现读的，服务端不用重启）；
3. `npm run shots` 一次出一套图（首页 / 画布 / 生成器面板 / 设置 / 工作流弹窗 / dock），
   截图在 `tests/.tmp/shots/`，适合和上一版并排比；
4. 改完跑 `npm run test:e2e`，它会断言图标的填充、生成器布局（提示词 86~168px 无边框、底栏一行六项、
   生成按钮与胶囊同高）、路由 hash、控制台零报错；
5. 视觉/交互规则有变化时，同步 `验收报告.md`（按轮次追加）和 `README.md` 的对应段落。

## 加图标

图标是手绘的一套，没有生成步骤：

1. 在 `static/icons.js` 的 `P` 表里加一条 `短名: "<path d=\"...\"/>"`；
2. 页面里用 `<span data-icon="短名">`（静态 HTML）或 `icon('短名')`（JS 拼字符串）。

规矩：`viewBox="0 0 24 24"`、光学核心区 3.6–20.4、圆头圆角、`fill="none"`。
**不要在 path 上写 `stroke-width`** —— 属性优先级低于任何 CSS 规则，会把 `style.css` 里
`.oi { stroke-width: var(--oi-stroke) }` 的分尺寸光学补偿压死（旧版就是这么失效的）。
实心元素写 `fill="currentColor" stroke="none"`。运行时不联网、不装包，颜色由 CSS `color` 决定。

## 加接口

`server.py` 里按 `api_get / api_post / api_put / api_delete` 分支追加；返回统一用 `self.json_out(...)`，
错误用 `self.fail(msg, status)`。**任何 404 之前都要把请求体读完**（见 `drain_body()`），否则 keep-alive 下会串包。

## 提交前

```bash
npm run check && npm test && npm run test:e2e
```

CI（`.github/workflows/ci.yml`）跑的就是这三步；`npm run test:api` 因为要 ComfyUI，只在本地手动跑。
