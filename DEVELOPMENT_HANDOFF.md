# ChatCanvas（语布）开发交接背景

## 项目目标

这是一个 Windows 桌面 AI 客户端（当前源码版本 `2.3.7`）：在同一个对话里聊天、处理文档与 PPT、生成图片 / 视频 / 音乐 / 配音，另有无限画布与分镜。前端提供渠道、模型和参数配置，后端通过中转站 API 调用不同模型。用户使用自己的中转站 API Key，不需要官方账号登录。代码结构见 `docs/architecture.md`。

## 当前架构

- React + Vite：桌面窗口内的界面。
- Express + TypeScript：本地 API 服务。
- Tauri 2：Windows 桌面壳和窗口管理。
- Node.js sidecar：release 版本内置 Node.js，启动本地 Express 服务。
- SQLite：保存渠道、任务、历史和诊断记录。
- 生产桌面 API：`http://127.0.0.1:17892`。
- 普通 Web 开发 API：`http://127.0.0.1:17891`；前端开发服务 `http://127.0.0.1:5173`。

### 窗口布局的已知陷阱（2026-11-09 修）

`tauri.conf.json` 的窗口尺寸是逻辑单位，WebView 的 CSS 视口会受系统缩放影响，侧栏宽度（190–420）又单独存 localStorage。三者没有换算层时，125%/150% 缩放或拖宽侧栏会误命中 `styles.css` 的视口断点，把生图页两栏压成单列，加上写死的 `min-height:580px` 就出现「大片空白 + 需要滚动」。现在：

- 两栏 / 单列由 `.workspace` 的**容器查询**（主区实际宽度）决定，不再看视口；
- 去掉 580 / 540px 的硬高度，面板按内容自适应；
- `src/client/layout.ts` 的 `clampSidebarWidth()` 保证主区至少留 620px，窗口变窄时把已保存的宽侧栏收回。

改布局时不要把这些断点改回 `@media (max-width:…)`，也不要重新引入固定 `min-height`。

## 已实现能力

- 多渠道和多模型 ID。
- 新建数据目录不预置任何渠道，全部由“添加渠道”向导创建。
- 添加渠道向导：三步（选站点 → 模型组与密钥 → 确认保存），每个模型组生成独立渠道并使用独立密钥。
- OpenAI Images、OpenAI Chat Image、Gemini Content、Generic JSON 适配器。
- 最多 8 张参考图图生图；上传支持 PNG、JPEG、WebP，单张最大 10 MB。
- 参考图可以直接把图片文件拖进上传区（`src/client/useFileDrop.ts`），图片页和视频页共用同一个拖放交互。桌面版依赖 `tauri.conf.json` 窗口里的 `"dragDropEnabled": false`——Tauri 默认开着系统级拖放，会把文件拦在 webview 前面，前端收不到 `drop` 事件；Web 开发模式看不出这个问题，改完要重新构建桌面版。
- 文生图基础参数、高级 JSON 参数透传。
- OpenAI 和 Gemini 的常用官方参数。
- 可调的生成超时等待时长（10 秒到 30 分钟，默认 3 分钟），在生成页参数区设置。
- URL/Base64 图片保存、本地历史记录（含结果缩略图）、脱敏诊断。
- SSRF 防护；API Key 支持环境变量，也会持久化到数据目录的 `channel-keys.json`。
- 高级 JSON 对同名基础字段拥有最高优先级，不维护渠道能力矩阵。
- 参考图保存在数据目录的 `inputs/`，任务 JSON 和诊断记录不会保存上传 Base64；OpenAI Images 默认使用 `/v1/images/edits` multipart 请求。
- 生成表单会在本机自动保存提示词、渠道、模型和全部参数，页面切换或应用重启后继续保留。
- 结果图支持双击放大；桌面版下载使用原生保存对话框，可选择目录和文件名。
- **自动更新（仅 Windows 安装版）**：启动后静默检查 `updater` tag 上的 `latest.json`，侧栏版本号旁出现圆点时点开即可下载安装。安装前会先停掉内置后端（`prepare_for_update`），下载失败不影响当前版本继续使用。便携版只提示并跳下载页，macOS 只提示。签名私钥在 `%USERPROFILE%\.tauri\chatcanvas-updater.key`，**丢了就再也无法给已装用户推送更新**，详见 `PACKAGING.md`。
- 品牌为 **ChatCanvas**，中文名「语布」，slogan「马中赤兔，创中语布」。界面、窗口标题、安装包、快捷方式和系统提示词里都用这个名字。`productName` 从 2.2.1 起改为 `ChatCanvas`；数据目录由 identifier（`com.imagerelay.studio`）决定，不受影响。2.2.0 及更早的 `ezcanvas` 安装会与新版本并存一次，安装新版后手动卸载旧的即可。
- 图标母版在 `design/chatcanvas-icon-1024.png`，用 `npx tauri icon` 生成 `src-tauri/icons/*`；界面里的裸 mark 是 `src/client/public/brand-mark.png`（由 `src/client/BrandMark.tsx` 使用），站点图标是 `src/client/public/app-icon.png`。
- **自绘标题栏的窗口动作必须显式授权**：`decorations: false` 后，拖拽、最小化、最大化、关闭分别走 `core:window:allow-start-dragging` / `allow-minimize` / `allow-toggle-maximize` / `allow-close`。`core:default` **不包含**这四个权限，漏掉时前端拿到的是静默失败的 Promise，表现为“拖不动、按钮没反应”（v2.2.1 修过一次）。

### 文档与 PPT

- 支持的格式与能力边界见 README 的「文档与 PPT」表；实现集中在 `src/server/chat-tools/` 与 `src/server/presentation-*.ts`。
- **PPT 生成**：契约（页数/必需内容/风格，`presentation-spec-store.ts`）→ 分批阅读与规划 → 10 种版式渲染（`presentation-templates.ts`）→ 容量诊断（`shared/presentation-capacity.ts`）→ 校验门禁（`presentation-check.ts` / `presentation-contract-check.ts`）→ 候选发布（`document-publish.ts`）。
- **PPT 修改有两条通道**：`doc_edit.pages[].content` 只给版式与文字、坐标由渲染器算；`doc_edit.objects[]` 走对象级原位补丁（`presentation-object-map.ts` 定位 + `presentation-object-patch.ts` 写回），支持文字、字号颜色位置、换图、图表数据（同时同步内嵌工作簿）、表格单元格与增删行列。补丁后逐部件比哈希，只允许预计算的部件变化。
- **不能破的约定**：改一页不换整稿主题；渲染器页不被整页元素覆盖；容量降级必须留证；对象定位同名或缺失即拒绝；`box`/`lines` 页不假装 plan 仍有效。
- Word 支持正文段落内文本替换、字符样式（加粗/斜体/下划线/颜色/字号）与段落样式（对齐/行距/段前后/缩进/首行缩进），表格支持按特征文字定位后改单元格文字或增删行列（含合并单元格的表格拒绝），不支持页眉页脚与合并单元格；Excel 支持单元格读写与批量标色/标记，含图表的工作簿改单元格或批量标色时走外科式 XML 写入（`xlsx-surgical.ts`）并同步图表缓存，部件不丢；批量标色会新增 font 与 cellXfs 条目，不改已有字体；PDF 只读。Excel 那条链路有真实验收：`npm run eval:xlsx`（COM 建图 → 改数 → 再打开读图表系列值）。Word 样式有真实渲染验收：`npm run eval:word`（源文件与补丁文件各导出一次 PDF，比对颜色、字体、文本坐标与表格位移）。详见 README 与 `docs/architecture.md` 第 9 节。

### 音乐生成

- 一种音乐渠道：词元流墟 Suno（`suno-music`，模型 `suno_damobi_music`），协议细节见 [`SUNO_HANDOFF.md`](SUNO_HANDOFF.md)。
- 一次固定返回 2 首；支持灵感描述 / 自定义歌词 / 纯音乐，音频与封面一起落盘。
- 独立「音乐」工作台、历史筛选、播放器；对话工具 `generate_music` 同样一次返回两首。
- 异步任务统一走 `src/server/async-providers.ts` 的 `AsyncProviderSpec`；
  视频和音乐共用 `TaskRunner.pollAsyncTask()`，新增异步渠道只填描述表。
- 品类判断统一走 `src/shared/kinds.ts` 的 `ChannelKind / TaskKind`，不再用「不是视频就是图片」的排除法。

### 视频生成

- 四种视频渠道（通义万相 `wan-video`、Grok `grok-video`、豆包 Seedance `seedance-video`、可灵 `kling-video`），协议细节见 [`VIDEO_HANDOFF.md`](VIDEO_HANDOFF.md)。
- 异步任务提交 → 持久化上游 task id → 轮询 → 下载落盘。**服务重启后，已拿到上游 task id 的视频任务会接着轮询**，不再一律判失败。
- 视频页是**一页式**：标题 → 一体化创作框（提示词固定在右侧、左边留一列恒定的空白；默认参考素材折叠成窄窄一摞钉在左上角，悬停摊开时**就地横向盖在文字上**，不改动文本布局、不把文字推下去）→ 创作记录。素材层是绝对定位的覆盖层，折叠/展开两态正文的 x/y/宽/高与输入框尺寸完全一致。没有右侧参数面板，也没有常驻的「本次结果」大舞台；生成中的任务在卡片上显示进度，点卡片才打开播放器浮层。默认态输入区恒为 172px（折叠/展开都不变）、记录区整块显示且**不滚动**（多出来的靠右上角翻页）；手动展开 = 专注编辑，创作框占满工作区、记录区整块隐藏，收起后恢复并用 `ResizeObserver` 重算每页条数。
- 界面上的生成方式收成合并入口：**提示词生视频**（无素材=文生、有素材=参考生）与**首尾帧生视频**（1 张=首帧、2 张=首尾帧），视频编辑/延长与运动控制语义独立才单列；提交前 `resolveStudioMode()` 落成上游真实模式，服务端 `video-mode-guard.ts` 按具体模式复核。**Grok 例外**：上游只有一个端点、靠 `reference_images` 区分文生/图生，没有模式表也不画模式胶囊，但 `studioAssetSpec()` 给创作框一份界面用的素材规格（最多 7 张参考图），服务端守卫只按参考图上限兜底。草稿按 `adapter:mode` 分键，切模式/切模型不丢素材；提交即落参数快照，结果区可复用提示词与数值（素材需重新上传）。
- 素材只走本地上传：创作框里没有粘贴公网地址的输入框。能放可选素材的模式（提示词生视频）空着时最左留一个虚线「参考内容」格；点它按当前模式能收的素材列类型（图片 / 视频 / 音频），收多种先弹一层「添加图片 / 添加视频 / 添加音频」，只收一种就直接开系统选择框，不能传的写明原因。首尾帧（两格）与视频编辑/延长（专属参考视频格）不再额外挂这个入口。其余入口在 `@` 面板底部。素材是一层绝对定位的覆盖物钉在左上角（`--asset-gutter` 固定文字左边界：普通 148px、首尾帧 190px），空态是一个虚线「参考内容」格，多张素材只露最近 3 张、叠成一摞（错开间距已收窄到整摞 120px，轻微旋转 + 角标写总数），摞右边缘半叠一个小圆 `+`；**只有悬停在这一摞本身**才就地横向摊开盖在文字上（带实色底），移出整条素材排才收回；展开后一页放满靠两侧箭头翻页（不横向滚动、箭头不压格），点击格子看详情；首尾帧是固定的「首帧 / 尾帧」两个浅灰圆角方块 + 连接符，**并排、不折叠、不展开、无任何动画**。提示词里敲 `@` 或点右上角 @ 都会弹素材列表，面板跟着光标走，选中插入 `@图片1` / `@视频2` / `@音频1`——输入框是 contenteditable，记号从插进去那一刻起就是带缩略图的胶囊，编辑中和失焦后长得一样。参考视频/音频可多段：Seedance 2.0 三段、2.5 十段，万相/可灵各一段，额度 >1 时一次可选多个。
- 创作记录：总条数 + 状态筛选（全部/进行中/已完成/失败）+ **右上角的翻页条**（与筛选页签同一行）+ 排序；网格/列表切换已移除，只有网格一种看法，**记录区不滚动**。一页放几张按记录区宽高算（列数看宽、行数看高，见 `client/video/record-paging.ts`），窗口越大放得越多；只有一页时翻页条不出现。卡片带缩略图、时长、状态点与模型/时长/分辨率，`⋯` 菜单给播放、下载、重生成、复用参数、诊断、取消，以及红色的「删除历史」（走 `App.requestDeleteTask` → `ClearHistoryDialog`）。
- 视频任务的诊断记录采用「首尾完整 + 中间精简」：提交请求和最后一次轮询保留完整响应，中间的轮询只存一行状态摘要。

### 历史与素材目录

- 历史列表每行带勾选框，表头可全选当前筛选；勾中后头部出现「已选 N 条」批量条（删除选中 / 取消选择）。切换筛选会清空勾选，避免删掉看不见的行。
- 清空历史（图片 / 视频 / 全部）会先弹确认框，并让用户选择是否同时删除磁盘上的产物：
  - 同时删除本地文件（默认）
  - 仅删除记录，保留本地文件
- 单条删除、批量删除、按类型清空共用 `ClearHistoryDialog`，用 `mode` 区分标题与按钮文案；删除接口只有两个：`DELETE /api/generations/:id`（单条）和 `DELETE /api/generations`（`ids=a,b,c` 删勾选的，`scope=image|video|all` 按类型全清，**ids 优先**）。
- 生成产物的保存目录可以在历史页的「目录设置」里改成任意绝对路径（桌面版走原生文件夹选择器；Web 开发模式没有原生对话框，按钮会提示不可用），也可以恢复默认。
- **切换目录不迁移已有文件**：`assets` 表为每条产物记录 `base_dir`，历史缩略图始终指向它自己所在的目录，所以换目录后旧历史依然能看、能下载。自定义目录不允许放在应用数据目录内部。

## API Key 规则

渠道的 Base URL、适配器、模型和 API Key 在应用中配置。中转站通常按模型系列分别售卖密钥，所以向导给每个模型组分配独立的环境变量名，例如 `VECTORENGINE_API_KEY`、`VECTORENGINE_GPT_C_API_KEY`、`VECTORENGINE_GEMINI_API_KEY`。

密钥优先读取渠道指定的环境变量；在界面直接填写的 API Key 会以明文 JSON 写入数据目录的 `channel-keys.json`（权限 0600），重启后自动载入，删除渠道时一并清除。该文件是明文的，不要提交到 GitHub，也不要写入交接文档。

换电脑后需要重新配置密钥：

```dotenv
RELAY_API_KEY=替换为中转站密钥
```

如果使用 `.env`，请在新电脑单独创建，不要从 Git 仓库公开提交。

## 重要目录和文件

- `src/client/App.tsx`：应用外壳、侧栏、渠道/任务状态和页面切换。
- `src/client/views/GenerateView.tsx`：生图工作台和结果面板。
- `src/client/views/HistoryView.tsx`：历史列表、预览和清空确认。
- `src/client/dialogs/`：设置与诊断弹窗。
- `src/client/hooks/useReferenceImages.ts`、`hooks/usePolling.ts`：参考图/蒙版与任务轮询。
- `src/client/VideoGenerateView.tsx`：视频页编排（渠道/模型 → 模式 → 草稿 → 提交）。
- `src/client/video/`：一体化创作框 `VideoComposer`、提示词输入 `PromptEditor.tsx`（contenteditable，`@` 记号是带缩略图的原子胶囊）、参数浮层 `VideoParamsPanel`、创作记录 `VideoResultPanel`（网格/列表 + 播放器浮层）、媒体构造 `media-builders.ts`、`@` 素材面板 `VideoMentionPanel.tsx`。
- `src/shared/video-modes.ts` / `video-draft.ts` / `video-snapshot.ts`：模式矩阵、草稿与参数收敛、任务参数快照（前后端共用）。
- `src/server/video-mode-guard.ts`：提交前的模式/素材/参数复核。
- `src/client/MusicGenerateView.tsx`：音乐工作台、全部模式、源歌曲选择、播放器与歌词。
- `src/client/chat/ModelPanel.tsx`、`chat/ConversationSidebar.tsx`、`chat/AssetLightbox.tsx`：对话页拆出的组件。
- `src/client/task-ui.tsx`：图片 / 视频 / 音乐共用的状态徽标、格式化与表单持久化。
- `src/shared/kinds.ts`：渠道 / 任务品类的唯一真相（图片 / 视频 / 音乐 / 对话）。
- `src/server/async-providers.ts`：异步厂商（视频 / 音乐）的轮询、状态与结果提取。
- `src/server/presentation-*.ts`：PPT 全链路（spec 存储、工作流、执行、渲染、容量、检查、项目打包、发布、修改、对象映射与补丁、视觉审阅）。
- `src/server/chat-tools/`：原生工具实现，`documents.ts` 是文档与 PPT 的工具入口，其余按格式/媒体拆分。
- `src/shared/presentation-*.ts`：契约、报告、主题、版式职责、状态投影、容量诊断（前后端共用）。
- `docs/architecture.md`：项目框架总览（进程、目录、请求链路、数据模型、不变量、扩展点）。
- `docs/document-reliability-development.md`：PPT 可靠性与增量改造的决策与实现记录（A–D2、M1/M2）。
- `src/server/agent-plan.ts` / `agent-confirm.ts` / `agent-batch.ts` / `agent-vision.ts` / `agent-task-events.ts` / `agent-brain.ts` / `agent-prompt.ts`：从 `agent.ts` 拆出的职责模块。
- `src/client/useFileDrop.ts`：参考图上传区的拖放交互（图片页与视频页共用）。
- `src/client/api.ts`：前端 API 客户端和桌面 API 地址切换。
- `src/client/updater.ts`、`src/client/UpdateStatus.tsx`：自动更新的前端封装和侧栏底部面板。
- `scripts/write-latest-json.ts`：生成 Tauri 更新清单（`latest.json`），纯函数部分有单测。
- `.github/workflows/release.yml`：macOS + Windows 构建、建 Release、维护 `updater` tag。
- `src/server/app.ts`：Express 路由和请求校验。
- `src/server/adapters.ts`：各渠道请求适配。
- `src/server/tasks.ts`：任务执行、视频轮询与重启恢复、产物落盘。
- `src/server/db.ts`：数据库连接、任务 / 会话查询与产物目录设置，画布存储委托给独立仓储。
- `src/server/db-schema.ts`：数据库建表和兼容迁移；启动时由 `AppDatabase` 顺序调用。
- `src/server/db-board.ts`：画布文档、历史版本、素材链接和任务关联的数据库仓储，与 `AppDatabase` 共用 SQLite 连接。
- `src/server/board-core.ts` / `board-assets.ts` / `board-video-selection.ts`：画布基础视图、素材操作和视频输入解析；`board.ts` 继续兼容原有导出。
- `src/client/board/BoardMaterialDialog.tsx`、`BoardMinimap.tsx`、`useBoardMinimap.ts`、`board-geometry.ts`：画布素材弹窗、小地图和几何计算。
- `src/server/key-store.ts`：渠道 API Key 的本地持久化。
- `src/shared/provider-presets.ts`：添加渠道向导的站点与模型组预设。
- `src/client/channels/`：渠道列表、编辑弹窗和添加渠道向导。
- `src/server/index.ts`：本地 API 入口。
- `src/shared/types.ts`：前后端共享类型。
- `src-tauri/tauri.conf.json`：Tauri 窗口、资源、sidecar 和 CSP 配置。窗口是 `decorations:false` + `transparent:true` + `shadow:false`，前端在 `html.tauri-window` 下画 18px 圆角外壳；最大化时自动去掉透明边。
- `src/client/notifications.ts`：对话完成时的任务栏提示与 overlay 角标；需要 `requestUserAttention` / `setOverlayIcon` 权限。
- `src-tauri/src/lib.rs`：启动和关闭 Node sidecar 的 Rust 代码。
- `scripts/prepare-tauri.mjs`：复制服务端资源、生产依赖和 Node sidecar。
- `README.md`：日常运行和构建说明。
- `CHANGELOG.md`：各版本改动记录（按版本倒序），发版时往顶部加一段。这里写历史，所以 `set-version.mjs` **不**改它的版本号。

## 新电脑开发步骤

需要安装 Node.js 24、Rust、Visual Studio C++ Build Tools 和 WebView2。然后在项目目录执行：

```powershell
npm install
npm test
npm run tauri:dev
```

只调试 Web 版本时：

```powershell
npm run dev
```

## Windows release 构建

首个发布版本和版本号同步流程见 `PACKAGING.md`。

先关闭正在运行的 Tauri 程序，再执行：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri:build:exe
```

可运行文件位于：

```text
src-tauri/target/release/image_relay_studio.exe
```

生成便携目录和 ZIP 压缩包：

```powershell
npm run tauri:package:portable
```

输出位于 `artifacts/chatcanvas-v2.3.7-portable-win-x64/` 和 `artifacts/chatcanvas-v2.3.7-portable-win-x64.zip`（目录名和版本号由 `scripts/package-portable.mjs` 从 `package.json` 读取，升级版本号后自动变化）。

生成用于换电脑继续开发的源码包：

```powershell
npm run tauri:package:source
```

输出为 `artifacts/chatcanvas-v2.3.7-source-with-handoff.zip`，其中不包含 API Key、用户数据、依赖缓存和编译产物。

直接分发时必须保留同目录的 `node.exe` 和 `resources/`。标准安装包命令是：

```powershell
npm run tauri:build
```

该命令需要从 GitHub 下载官方 NSIS 工具；如果网络无法访问 GitHub，可以先使用 `tauri:build:exe` 的便携目录版本。

## 数据位置

Tauri 版本默认使用：

- SQLite、参考图、生成图片和 `channel-keys.json`：`%APPDATA%/com.imagerelay.studio/data`
- 日志：`%LOCALAPPDATA%/com.imagerelay.studio/logs`

生成产物（图片、视频）的目录可以单独设置，存在同一个数据库的 `settings` 表里；改动只影响之后生成的文件，每条产物自己记住所在目录。迁移历史图片和记录时，如果用户改过素材目录，要连同自定义目录一起复制。

## 给下一次 Codex 对话的提示词

```text
继续开发 ChatCanvas（语布）。项目是 React/Vite + Express/TypeScript + Tauri 2，Windows release 通过 Node.js sidecar 启动本地 API。请先阅读 docs/architecture.md、DEVELOPMENT_HANDOFF.md、README.md、VIDEO_HANDOFF.md、PACKAGING.md 和 src-tauri 配置，再修改代码。涉及 PPT 时再读 docs/document-reliability-development.md，那里记录了不能破的不变量。不要把中转站 API Key 或更新签名私钥写进代码或提交到 Git。当前重点是保持已有多渠道、官方参数透传、历史记录、视频轮询与重启恢复、Tauri sidecar 能力，以及 Windows 自动更新链路（updater tag 上的 latest.json）。
```
