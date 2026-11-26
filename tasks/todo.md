# InfiSheet 1.8.2 后续任务清单（待执行）

方案：[plan.md](plan.md)。每项完成需同时更新相关文档；文件名为预计范围，实施时可按实际边界微调。

## R1 数据可信

- [x] **T1 稳定内容快照与保存队列**。依赖：无。预计：`static/app.js`、`tests/e2e/run.mjs`（M）。验收：无内容变化不新增撤销记录/服务端 rev；连续编辑最多一条保存请求在途，最后一次内容必定落盘；失败后状态不显示“已保存”。验证：新增 4 条浏览器回归通过；全量跑到第 299 项，原有 4 条失败已在干净 `main` 复现。双标签页与旧画布人工检查留在检查点 1。
- [x] **T2 修复 smoke 的环境依赖并核对保存冲突回归**。依赖：T1。实际：`tests/smoke.py`（S）。验收：Windows 本机 145 项全绿；用空闲临时端口验证离线地址，子进程启动告警不受输出缓冲影响；现有 MCP 回归确认旧 rev 被拒绝。验证：`npm test` 连跑两次均 145/145，`npm run test:mcp` 58 通过、1 项因 ComfyUI 离线跳过。
- [ ] **检查点 1**：`npm run lint && npm run check && npm test && npm run test:mcp` 全绿；用备份的旧画布打开、编辑、关闭、重开，内容与版本正确。
- [x] **T3 统一媒体落盘与内联引用迁移**。依赖：T1。实际：`static/app.js`、`server.py`、`tests/media.py`、`tests/e2e/media.mjs`（M）。验收：保存前迁移 PNG/JPEG/WebP/GIF 内联图片；旧画布保存并重开后仍可读取；落盘失败不新增项目版本，也不显示已保存。验证：`npm run test:media`、`npm test`、lint/check。

  进展（`56748c8`）：内联图片在保存前落到 `data/edits/`，失败时保存状态显示失败；旧 PNG 地址继续可读。隔离浏览器回归已覆盖旧画布重开及坏图片拒绝保存。项目包所需的跨源媒体引用核对放在 T8 实现。

## R2 易维护

- [ ] **T4 让 e2e 按功能真正过滤并建立 ComfyUI 替身**。依赖：T2。预计：`tests/e2e/run.mjs`、`tests/e2e/lib/server.mjs`、`tests/fake_comfy.py`、`.github/workflows/ci.yml`（M）。验收：选择 `GROUP=gen` 不运行其他组；替身覆盖提交/轮询/失败/取消/媒体，CI 可验证生成 API 契约；真实 ComfyUI 测试仍可选。验证：过滤组及全量 e2e、CI 同等命令。
- [ ] **T5 抽出生成纯逻辑并移除 `pickFn` 测试依赖**。依赖：T4。预计：`static/app.js`、`static/lib/gen-graph.js`、`static/index.html`、`tests/e2e/run.mjs`（M）。验收：生成图、尺寸、提示词、引用绑定的输出与旧版样本一致；相关测试直接 import 生产模块。验证：`npm run check`、生成组 e2e、`npm run test:api`（有 ComfyUI 时）。
- [ ] **T6 按职责拆前端一块高变更区域**。依赖：T5。预计：`static/app.js`、`static/lib/assets.js`、`static/index.html`、`tests/e2e/run.mjs`（M）。验收：资产库事件、筛选、拖入、缩略图和错误提示行为一致；主入口不再承载这一块的内部状态；不按行数造空模块。验证：资产组 e2e、`npm run shots`。
- [ ] **检查点 2**：全量 lint/check/smoke/MCP/e2e 通过，既有 API 与截图基线无意外变化。
- [ ] **T7 分离后端持久化/ComfyUI 边界**。依赖：T4。预计：`server.py`、`store.py`、`comfy_client.py`、`tests/smoke.py`、`tests/mcp.py`（M）。验收：`python server.py`、HTTP 与 stdio MCP 的对外协议不变；项目原子写、版本锁及 ComfyUI 错误翻译仍一致。验证：`npm test`、`npm run test:mcp`、替身契约测试。

## R3 可迁移项目

- [ ] **T8 项目包清单和导出端点**。依赖：T3、T7。预计：`server.py`、`store.py`、`tests/smoke.py`、`README.md`（M）。验收：ZIP 包含画布、实际引用媒体、所用工作流与缺失清单；相同内容只一份；外部模型依赖清楚标注。验证：隔离项目导出后检查 manifest、哈希和每个引用。
- [ ] **T9 项目包导入与安全校验**。依赖：T8。预计：`server.py`、`store.py`、`tests/smoke.py`、`tests/pack.py`（M）。验收：预览不改数据；默认新项目；冲突工作流改名；错误路径、超限、损坏包被拒且不留半成品；导入后 URL 指向本机资源。验证：两隔离数据目录往返测试、恶意包与中途失败测试。
- [ ] **T10 项目包界面入口**。依赖：T9。预计：`static/app.js`、`static/index.html`、`static/style.css`、`tests/e2e/run.mjs`（M）。验收：首页/设置可导入导出；导入前显示大小和缺失/冲突，用户确认后完成；旧 JSON 功能保留并标明仅画布。验证：浏览器往返 e2e、截图走查。
- [ ] **检查点 3**：从数据目录 A 导出，到完全隔离的 B 导入；停掉 A 后，B 的可打包图片/视频/工作流仍能打开，损坏包不改 B。

## R4 易排错与结果选用

- [ ] **T11 工作流预检服务与提交保护**。依赖：T4、T7。预计：`server.py`、`comfy_client.py`、`tests/smoke.py`、`tests/fake_comfy.py`（M）。验收：缺节点、必填参考图和输出类型问题定位到节点；ComfyUI 离线返回“无法验证”；预检和实际提交共享同一图分析规则。验证：替身契约与真实坏工作流样本。
- [ ] **T12 工作流预检界面**。依赖：T11。预计：`static/app.js`、`static/style.css`、`tests/e2e/run.mjs`（M）。验收：导入后和生成前展示结果；硬错误阻止提交、警告可继续；定位信息能读懂且可操作。验证：浏览器好/坏/离线三态 e2e、截图检查。
- [ ] **T13 历史结果并排对比与选用**。依赖：T1。预计：`static/app.js`、`static/style.css`、`tests/e2e/run.mjs`、`README.md`（M）。验收：2～4 张图片结果同屏并排、参数可见；选用创建新节点并保留来源，旧结果不变；缺失文件提示明确。验证：多次生成记录夹具 e2e，刷新后来源仍可追溯。
- [ ] **检查点 4**：全量质量门禁、真实 ComfyUI 出图、跨平台打包/更新测试和关键界面截图通过；更新 README、ARCHITECTURE、CHANGELOG，复核所有新增功能的离线和错误状态。
