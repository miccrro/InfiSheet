# 开发指引

## 需要什么

| 依赖 | 版本 | 用途 |
|---|---|---|
| Python | 3.9+ | 跑 `server.py`、`selftest.py`、`tests/smoke.py`、`tools/pack.py` |
| Node.js | **22+** | 只有测试/图标/打包脚本用；`tests/e2e/cdp.mjs` 依赖全局 `WebSocket` |
| Chrome / Chromium | 任意近期版本 | 只有 e2e 用；找不到时设 `CHROME_PATH=/path/to/chrome` |
| ComfyUI | 0.4+（默认 `127.0.0.1:8188`） | 产品要它才出图；`npm test` 不需要，`npm run test:api` 需要 |

产品本身**零运行时依赖**：没有构建、没有打包器，`python server.py` 就是全部。

## 跑起来

```bash
python server.py                # 打开浏览器到 http://127.0.0.1:8788
python server.py --no-browser   # 不自动开浏览器（开发时常用）
python server.py --port 9000 --data ./tmp-data --presets ./tmp-presets   # 换端口 / 隔离数据
```

Windows 上双击 `启动.bat` 等价。

## 常用脚本

```bash
npm install          # 只装开发依赖（@icon-park/svg、prettier），产品不需要
npm run dev          # 8788 + 不自动开浏览器
npm run check        # 所有 js 语法检查 + py_compile（不装 linter 也能跑）
npm test             # 冒烟：起隔离实例，验静态/接口/项目 CRUD/防穿越（不需要 ComfyUI）
npm run test:api     # 完整接口回归：会真的往 ComfyUI 丢一个 64×64 任务
npm run test:e2e     # 浏览器 e2e：headed 用 HEADED=1
npm run shots        # 截一套图到 tests/.tmp/shots/（改完 UI 看效果用）
npm run icons        # 重新生成 static/icons.js
npm run pack         # 打 zip 到 dist/（加 -- --with-data 连 data/ 一起）
```

测试产物都在 `tests/.tmp/`（已 gitignore），跑完自动清理；要留现场用 `python tests/smoke.py --keep`。

## 目录

```
server.py              # 全部后端（静态 + ComfyUI 代理 + 持久化）
selftest.py            # 需要 ComfyUI 的接口回归
static/                # 前端三件套 + icons.js（生成物）
presets/               # 内置 API 工作流
tests/smoke.py         # 无依赖冒烟
tests/e2e/             # CDP 驱动的浏览器测试与截图脚本
  cdp.mjs              #   驱动核心（起 Chrome / eval / 点 / 拖 / 截图）
  run.mjs              #   断言式 e2e（npm run test:e2e）
  walkthrough.mjs      #   截图走查（npm run shots）
  probe.mjs            #   任意探针：对已运行实例跑一个 body 模块
  fixtures/            #   测试用的小画布
tools/icons/gen.cjs    # IconPark → static/icons.js
tools/check.mjs        # 语法自检
tools/pack.py          # 打 zip
docs/                  # 这份文档 + 架构说明
data/                  # 运行时生成，不进版本库
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

图标全部来自 [IconPark](https://iconpark.oceanengine.com/official)，做法是**离线生成**：

1. 在 `tools/icons/gen.cjs` 的 `MAP` 里加一行 `短名: 'IconPark 组件名'`（要更粗的线宽写 `['Name', 6]`）；
2. 先 `npm install`（只有生成时需要 `@icon-park/svg`），再 `npm run icons`；
3. 页面里用 `<span data-icon="短名">`（静态 HTML）或 `icon('短名')`（JS 拼字符串）。

生成物是 `static/icons.js`（48×48 viewBox、`currentColor`），运行时不联网、不装包。图标颜色由 CSS `color` 决定。

## 加接口

`server.py` 里按 `api_get / api_post / api_put / api_delete` 分支追加；返回统一用 `self.json_out(...)`，
错误用 `self.fail(msg, status)`。**任何 404 之前都要把请求体读完**（见 `drain_body()`），否则 keep-alive 下会串包。

## 提交前

```bash
npm run check && npm test && npm run test:e2e
```

CI（`.github/workflows/ci.yml`）跑的就是这三步；`npm run test:api` 因为要 ComfyUI，只在本地手动跑。
