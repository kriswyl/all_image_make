# ChatCanvas（语布）项目框架

当前源码版本 **2.3.5**。这份文档描述「代码现在长什么样、一次请求怎么走、哪些不变量不能破」，用于接手开发和排查问题。
发布流程见 [PACKAGING.md](../PACKAGING.md)，变更历史见 [CHANGELOG.md](../CHANGELOG.md)，PPT 改造细节见 [document-reliability-development.md](document-reliability-development.md)。

## 1. 技术栈与运行形态

| 层 | 技术 | 说明 |
|---|---|---|
| 界面 | React 19 + Vite 7 | 单页应用，全部本地渲染 |
| 本地 API | Express 5 + TypeScript | 由 Node 直接运行（开发）或由 Tauri sidecar 托管（桌面） |
| 桌面壳 | Tauri 2 + Rust | 自绘标题栏（`decorations:false`），负责窗口、sidecar 生命周期、自动更新 |
| 存储 | SQLite（`node:sqlite`） | 单文件数据库，`db-schema.ts` 顺序建表 + 58 条兼容迁移 |
| 模型访问 | 自研适配器 | 渠道 = Base URL + 适配器 + 模型列表 + 密钥，不预置任何渠道 |

三个端口：

| 端口 | 用途 |
|---|---|
| `5173` | Vite 开发服务（只在 `npm run dev` / `tauri:dev` 时存在） |
| `17891` | Web 模式的本地 API（`npm run dev` / `npm start`） |
| `17892` | 桌面模式的本地 API（Tauri sidecar 固定端口） |
| `58890` | WPS 加载项回连端口（视觉检查用，仅在 WPS 渲染时出现） |

数据目录：`%APPDATA%/com.imagerelay.studio/data`（SQLite、密钥、生成产物），日志在 `%LOCALAPPDATA%/com.imagerelay.studio/logs`。

## 2. 目录地图

```text
src/
  client/            界面
    App.tsx          外壳、侧栏、页面切换
    chat/            对话页：消息流、工具卡、文档卡片、PPT 报告面板
    views/           生图 / 历史 / 设置
    video/           视频工作台：一体化创作框、参数浮层、结果面板、媒体构造
    board/           无限画布与分镜
    channels/        渠道列表、编辑、添加向导
    dialogs/         设置与诊断
    ui/ hooks/       通用组件与状态
  server/            本地 API
    app.ts           120 条路由与请求校验
    index.ts         进程入口
    db.ts            数据库连接与会话/任务查询
    db-schema.ts     建表与迁移
    db-board.ts      画布仓储
    adapters.ts      渠道协议适配
    tasks.ts         任务执行、异步轮询、重启恢复
    video-mode-guard.ts  模式 / 素材 / 参数的服务端复核（与前端同一张表）
    async-providers.ts  异步厂商描述表（视频/音乐共用）
    key-store.ts     渠道密钥本地持久化
    agent*.ts        对话循环、规划、确认、上下文、批量
    chat-tools/      原生工具实现（文档、图片、视频、音频、模板、能力检索）
    presentation-*.ts  PPT 全套管线（见第 5 节），含图表内嵌工作簿同步
    chat-tools/word|spreadsheet|pdf-document.ts  各格式读写
  shared/            前后端共享：类型、schema、契约、主题、报告、状态投影
                     视频相关：video-modes.ts（模式矩阵）、video-draft.ts（草稿与参数收敛）、
                     video-snapshot.ts（任务参数快照的脱敏与复用）、video-capabilities.ts
src-tauri/            Rust 壳、sidecar、图标、打包配置
scripts/             开发、打包、评测脚本
tests/               vitest 用例（119 文件 / 904 项）
docs/                设计与交接文档
```

## 3. 一次对话请求怎么走

```text
输入框
  → POST /api/conversations/:id/messages
  → agent-brain.ts       选模型、装工具定义、判断能力
  → agent-tools.ts       执行原生 function call
      → chat-tools/*     文档/媒体工具
      → presentation-*   PPT 生成与修改
      → tasks.ts         异步媒体任务（图片/视频/音乐/配音）
  → 流式回传 SSE         文本增量 + 工具卡状态
  → 产物落盘 + 数据库记录 + 版本报告
```

四个关键约定：

1. **工具定义按需加载**：`registry.ts` 组合描述、执行、去重策略；工具组按意图预加载，其余通过 `capability_search` 开放。
2. **副作用有操作 ID**：同一 `operationId` 重放返回磁盘上的最终结果，不重复写文件。
3. **断点只存安全位置**：一批工具全部结束、准备再次请求模型时保存；执行中的调用不重放。
4. **执行状态 ≠ 文件可用状态**：对话完成不代表文档可交付，见 `shared/presentation-status.ts` 的三维投影（文件 / 视觉 / 契约）。

## 4. 数据模型（SQLite）

38 张表，按职责分组：

| 组 | 表 | 说明 |
|---|---|---|
| 渠道与任务 | `channels` `tasks` `assets` `diagnostics` `settings` `style_presets` | 渠道配置、生成任务、产物、脱敏诊断 |
| 会话 | `conversations` `messages` `brain_calls` | 对话与模型调用记录 |
| 附件与工作区 | `conversation_documents` `conversation_document_files` `conversation_document_plans` `conversation_document_outputs` `workspace_documents` | 附件、解析结果、会话工作区文件 |
| PPT 版本 | `presentation_versions` `presentation_batch_cache` `presentation_resumes` `presentation_validations` | 每个文件版本的报告、批次缓存、断点、校验结果 |
| 任务契约 | `presentation_specs` `presentation_spec_revisions` `presentation_family_refs` | 不可变 revision、活跃引用保护 |
| 发布 | `document_publish_log` | 候选→发布的唯一入口记录 |
| 工具执行 | `native_tool_calls` `native_turn_checkpoints` `native_image_confirmations` `agent_confirmation_decisions` | 工具卡恢复、断点、确认决策 |
| 画布与分镜 | `boards` `board_history` `board_assets` `board_tasks` `canvas_templates` `storyboard_projects` `storyboard_template_assets` `conversation_shots/characters/scenes/graph_positions` | 画布文档、历史版本、分镜 |

`workspace_documents` 既存文件路径也存状态（候选 / 已发布），候选默认不出现在文件列表，终止且无引用 24 小时后可清理。

## 5. PPT 管线（最复杂的一条链路）

### 5.1 生成

| 阶段 | 模块 | 产出 |
|---|---|---|
| 契约 | `presentation-spec-store.ts` + `chat-tools/presentation-spec-tool.ts` | 页数、必需内容、风格的不可变 revision |
| 规划 | `presentation-workflow.ts` / `presentation-execution.ts` | 分批阅读 → 页面目录 → 逐页内容 → 审校 |
| 渲染 | `presentation-templates.ts` + `presentation-elements.ts` + `presentation-theme.ts` | 10 种版式的确定性坐标 |
| 容量 | `shared/presentation-capacity.ts` | 缩字号（有下限）→ 行高按需 → 分句压缩 → 截断并记证 |
| 打包 | `presentation-project.ts` | OOXML + 内嵌 `chatcanvas/presentation.json`（plan + 图片引用 + 指纹） |
| 校验 | `presentation-check.ts` / `presentation-contract-check.ts` | 页数、边界、可见正文、结构要求 |
| 发布 | `document-publish.ts` | 候选与成品分开，发布是唯一状态转换 |

### 5.2 修改（两条通道）

1. **整页声明式**（`doc_edit.pages[].content`）：只给版式与文字，坐标由渲染器按**这份文件报告里的主题**算；渲染器生成的页不允许被整页元素覆盖。
2. **对象级原位补丁**（`doc_edit.objects[]`）：不重新渲染整稿，只改目标部件。

```text
objects[] → presentation-object-map.ts   按 cNvPr 名称定位（同名/缺子对象/外部改动即拒绝）
          → presentation-object-patch.ts 文字/字号/颜色/位置/换图/图表数据/表格单元格
          → 部件哈希对比                  只允许预计算的部件变化
          → plan 同步 + 重新打包          指纹重算，仍可继续按页编辑
```

| 能改 | 写法 | 边界 |
|---|---|---|
| 文本框文字 | `text`（`\n` 分段） | 不改同段内局部富文本 |
| 字号 / 颜色 / 位置尺寸 | `fontSize` / `color` / `rect` | 只替换已有属性，不插入新节点 |
| 图片 | `imageAssetId` | 新增媒体 + 该页 rels；不改裁剪/填充方式 |
| 图表数据 | `chart.categories` / `chart.series` | 显示缓存与内嵌工作簿同步（单元格 / 字符串池 / 表列名）；同步失败才警告 |
| 表格单元格 | `table.cells[{row,col,text}]` | 只换文字；样式不动 |
| 表格结构 | `insertRows` / `deleteRows` / `insertCols` / `deleteCols` | 总高度/总宽度均分，外框不变；含合并单元格的表格拒绝 |

### 5.3 报告与门禁

`shared/presentation-report.ts` 是唯一的报告结构，写入 `presentation_versions`：

- `readiness` / `visibleCoverage`：能否作为成品、必需内容覆盖情况；
- `overflowPages` / `capacity.{truncatedPages,reflowedPages}`：内容去了备注 / 被截断 / 放宽行高；
- `freeformPages`：还有几页走整页元素（目标为 0）；
- `deckPlan.{roleDistribution,repeatedRuns}`：职责分布与连续同版式提示；
- `theme` / `specRef` / `checkSets`：皮肤、契约版本、实际检查了哪几页；
- `documentStatus`（工具结果）：文件已产出 / 草稿可下载 / 任务已完成三态，一律以保存后的最终报告为准。

### 5.4 入口一致性（2026-11-09 收尾）

| 环节 | 唯一入口 | 约束 |
|---|---|---|
| 契约解析 | `presentation-contract-resolution.ts` 的 `resolveContractSpec()` | 显式绑定失效必须拒绝；仅真无绑定的旧文件走 active 兼容路径 |
| 证据核验 | `presentation-contract-check.ts` | 素材含身份与哈希；案例需正文 + 来源；语义结论绑定哈希 / revision / 要求 ID |
| 视觉等待 | `document-publish.ts` 的 `markPendingPublish()` / `completePendingVisualCheck()` | 复用 `visual_check` 家族引用 + WPS 检查队列；等待记 paused、重启可续、只发布一次 |
| 状态回传 | `chat-tools/documents.ts` 的 `finalDocumentResult()` | 生成 / 整页编辑 / 对象修改 / 补做 / legacy 统一以 `saved.report` 为准 |

跨入口链路（生成 → 修改 → 切换任务 → 补做 → 检查 → 发布）由 `tests/presentation-cross-entry.test.ts` H01–H10 钉住。

## 6. 不能破的不变量

1. **非目标部件逐字节一致**。补丁后逐部件比哈希，允许列表按操作预先计算，运行失败不得扩大豁免。
2. **主题继承**。改一页不许换掉整稿皮肤；渲染器页不许被整页元素覆盖。
3. **容量不静默**。可以缩字号到下限、放宽行高、按分句压缩，但每一次都要能核对。
4. **映射必须唯一命中**。同名多份、子对象缺失、文件被外部改过，一律拒绝，不按相似度猜。
5. **plan 必须同步**。无法同步的页（`box` / `lines`）不允许声称旧 plan 仍有效。
6. **契约 revision 不可变**。改要求只能追加 revision，文件版本不允许事后换绑。
7. **候选默认不可见**。只有发布能把它变成成品；等待视觉检查的候选受 `visual_check` 引用保护，不被 TTL 清掉。
8. **未检查 ≠ 已通过**。视觉或契约没跑完时，界面显示「未校验 / 未完成」，不冒充通过。
9. **规划标签不是完成证据**。`role: "case"`、案例编号、模型自报通过都不能替代正文 + 来源的可核验结果。
10. **显式绑定不能静默降级**。文件绑定的契约失效时拒绝发布，绝不退回「无契约」。
11. **文件产出 ≠ 任务完成**。草稿可下载，但工具结果与 UI 必须标明任务未完成及原因。
12. **生成方式不能只做界面切换**。模式只在渠道/模型真正支持时出现，必需素材与参数由服务端按同一张表复核；上游没有的语义（Seedance 的编辑/延长）不画假按钮。

## 7. 测试与评测

| 入口 | 用途 |
|---|---|
| `npm test` | 119 文件 / 904 项单元与集成测试（`node ./node_modules/vitest/vitest.mjs run` 更稳） |
| `npm run eval:contract` | 离线 10 项契约跨轮评测（不调用模型） |
| `npm run eval:contract:real` | 真实渠道 6 轮（计费，需 `--real --i-authorize-billing`） |
| `npm run eval:declarative` | 真实生成 8 页后改第 3 页，验 freeform=0 与主题继承 |
| `npm run eval:diversity` | 量版式分布与几何多样性 |
| `npm run eval:wps` | 用本机 WPS 打开并导出，验证补丁后文件可读 |
| `npm run eval:word` | Word 样式与表格的真实渲染验收：源文件与补丁文件各导出一次 PDF，比对文字、颜色、字体、文本坐标与表格位移 |
| `npm run eval:xlsx` | Excel 带图表工作簿的真实验收：COM 建带柱状图的文件 → 改数 + 批量标色 → 再交 Excel 打开，读单元格值、图表系列值与字体颜色 |
| `npm run eval:edit` | 原生改图链路（画布/图片） |

跑真实渠道脚本时**不要同时改 `src/server`**：`tsx watch` 会重启后端，等待中的请求直接 `ECONNREFUSED`。

`eval:word` 依赖本机 WPS 注册的 `Word.Application` COM：脚本生成虚构 docx、用项目代码加样式、导出 PDF，再用 pdfjs 校验文字、颜色与字体三项。它只支持 Windows，且不影响单元测试（单元测试不碰 COM）。

## 8. 扩展点

| 要做的事 | 改哪里 |
|---|---|
| 新增版式 | `shared/presentation-roles.ts` 的 `SLIDE_LAYOUTS` + `presentation-templates.ts` 渲染分支 + 容量预期 |
| 新增主题 | `shared/presentation-theme.ts` 增加令牌集，自动进入 `getTheme` |
| 新增可补丁对象 | `presentation-object-map.ts` 的命名规则 + `presentation-object-patch.ts` 的写回 + 允许部件 |
| 新增渠道 | 适配器 + `shared/provider-presets.ts`（向导预设），不在代码里放密钥 |
| 新增异步厂商 | `async-providers.ts` 描述表，复用 `TaskRunner.pollAsyncTask()` |
| 新增视频模式 | `shared/video-modes.ts` 的模式表 + 适配器分支 + `server/video-mode-guard.ts` 的素材/参数规则 |
| 新增文档格式 | `chat-tools/` 下独立模块 + `registry.ts` 注册 + `doc_read/doc_edit` 分支 |
| 新增工具 | `chat-tools/` 实现 + `registry.ts` 声明 + 预算与去重策略 |

## 9. 视频工作台（模式 / 素材 / 快照）

视频页是一条独立链路，与图片页共用渠道、任务与播放器，但模式与素材规则单独成型。

| 关注点 | 落点 | 规则 |
|---|---|---|
| 模式矩阵 | `shared/video-modes.ts` | 万相 7 种、Seedance 4 种、可灵按模型（omni 才有参考图，运动控制只有 kling-3.0）；只渲染支持的模式，`resolutionOptionsFor` 按模式给档位 |
| 草稿 | `shared/video-draft.ts` + `client/hooks/useMediaBuckets.ts` | 草稿按 `adapter:mode` 分键：提示词/参数进 localStorage，图片/视频/音频在内存分桶；切模式只是换键，谁都不清空 |
| 素材入口 | 只在创作框里上传本地文件 | 页面没有任何「粘贴公网地址」的输入框；需要参考视频的模式只在渠道配了 `uploadEndpoint` 时出现，否则不画入口 |
| @ 引用 | `client/video/VideoMentionPanel.tsx` | 创作框右上角的 @ 弹出「全部/视频/图片/音频」素材列表，选中把 `@图片1` 这类记号插到光标处；记号顺序与提交时素材数组一致 |
| 参数收敛 | `reconcileVideoDraft()` | 换渠道/模型/模式后夹时长、换分辨率档、锁比例（2.5 首尾帧自适应），并回传改动原因给界面提示 |
| 参数入口 | `client/video/VideoParamsPanel.tsx` | 从创作框底部胶囊弹出（portal）；「格式 MP4/MOV」「生成数量 1–4」可见但锁定——上游没有 format 与 n 字段，不做无效控件 |
| 服务端守卫 | `server/video-mode-guard.ts` | `tasks.create` 前校验模式是否属于该模型、素材是否齐/超、分辨率与时长是否在档；`MODE_UNSUPPORTED` / `MODE_MEDIA_REQUIRED` / `MODE_MEDIA_LIMIT` / `MODE_PARAM_UNSUPPORTED` |
| 参数快照 | `shared/video-snapshot.ts` + `tasks.input_json` | 提交即落库，`taskView` 输出脱敏快照（内联素材只留字节数）；结果区展示「本次参数」，可复用提示词与数值，素材一律提示重新上传；`retry` 重放 `input_json`，不读当前表单 |
| 适配器 | `adapters.ts` | 万相 video-edit 不发 `duration`；可灵运动控制端点与参数按模式表；Seedance 的 content 按 role 组装 |

## 10. 已知边界

**共用的是「可扩展的共同底座」**：文件管理、候选发布与版本管理对各格式一致；任务契约（PresentationSpec）、可信检查结果与质量报告（TemplateReport）仍主要围绕 PPT。Word / Excel 复用候选发布与版本管理，不宣称具备 PPT 同等完整的契约核验能力。

- **Word** 支持正文段落内文本替换、字符样式（加粗 / 斜体 / 下划线 / 颜色 / 字号，落到包含该文字的 run）与段落样式（对齐 / 行距 / 段前后 / 缩进 / 首行缩进，落到命中段落的 `pPr`），以及表格（按特征文字定位，改单元格文字或增删行列；增删列时总宽度守恒，含合并单元格/嵌套表的表格拒绝）；不支持页眉页脚、合并单元格与图片。
- **Excel** 支持单元格读写、批量标色与标记；含图表/透视表/绘图的工作簿改走外科式 XML 写入（`xlsx-surgical.ts`），只动目标单元格与样式、并同步图表缓存，其余部件逐字节保留。不支持改图表类型/增删系列、编辑数据透视表。
- **PDF** 只读，扫描件需要先 OCR。
- **PPT** 支持本应用生成文件的整页改与对象级补丁；外部 PPT 仅作风格参考。图表数据会同步内嵌工作簿，但同步失败会明确提示；表格可增删行列，但不支持合并单元格与列宽调整；图标、连线不支持原位补丁。
- **整页依赖闭包**（整页替换、母版/版式关系迁移）未实现，不承诺外部 PPT 原位保真编辑。
- **视觉检查**依赖本机 WPS 与看图模型；没有渲染器时明确报告未验证。
- 不引入 Python、LibreOffice、Pandoc 或任意代码执行。
