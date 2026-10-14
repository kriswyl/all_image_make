# 益达工作台开发交接背景

## 项目目标

这是一个 Windows 桌面图片 / 视频生成客户端（当前版本 `2.1.0`）。前端提供渠道、模型和生成参数配置，后端通过中转站 API 调用不同模型。用户使用的是中转站 API Key，不需要官方模型账号登录。

## 当前架构

- React + Vite：桌面窗口内的界面。
- Express + TypeScript：本地 API 服务。
- Tauri 2：Windows 桌面壳和窗口管理。
- Node.js sidecar：release 版本内置 Node.js，启动本地 Express 服务。
- SQLite：保存渠道、任务、历史和诊断记录。
- 生产桌面 API：`http://127.0.0.1:17892`。
- 普通 Web 开发 API：`http://127.0.0.1:17891`；前端开发服务 `http://127.0.0.1:5173`。

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
- 产品显示名为“益达工作台”，桌面图标和界面 Logo 来自 `src-tauri/icons/` 与 `src/client/public/app-logo.png`。

### 视频生成

- 三种视频渠道（通义万相 `wan-video`、Grok `grok-video`、豆包 Seedance `seedance-video`），协议细节见 [`VIDEO_HANDOFF.md`](VIDEO_HANDOFF.md)。
- 异步任务提交 → 持久化上游 task id → 轮询 → 下载落盘。**服务重启后，已拿到上游 task id 的视频任务会接着轮询**，不再一律判失败。
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

- `src/client/App.tsx`：主界面和表单、生图工作台、生成历史、清空确认与目录设置弹窗。
- `src/client/VideoGenerateView.tsx`：视频工作台和模式选择器。
- `src/client/useFileDrop.ts`：参考图上传区的拖放交互（图片页与视频页共用）。
- `src/client/api.ts`：前端 API 客户端和桌面 API 地址切换。
- `src/server/app.ts`：Express 路由和请求校验。
- `src/server/adapters.ts`：各渠道请求适配。
- `src/server/tasks.ts`：任务执行、视频轮询与重启恢复、产物落盘。
- `src/server/db.ts`：SQLite 表结构、迁移与查询（含产物目录设置）。
- `src/server/key-store.ts`：渠道 API Key 的本地持久化。
- `src/shared/provider-presets.ts`：添加渠道向导的站点与模型组预设。
- `src/client/channels/`：渠道列表、编辑弹窗和添加渠道向导。
- `src/server/index.ts`：本地 API 入口。
- `src/shared/types.ts`：前后端共享类型。
- `src-tauri/tauri.conf.json`：Tauri 窗口、资源、sidecar 和 CSP 配置。
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

输出位于 `artifacts/益达工作台-v2.1.0-portable-win-x64/` 和 `artifacts/益达工作台-v2.1.0-portable-win-x64.zip`（目录名和版本号由 `scripts/package-portable.mjs` 从 `package.json` 读取，升级版本号后自动变化）。

生成用于换电脑继续开发的源码包：

```powershell
npm run tauri:package:source
```

输出为 `artifacts/益达工作台-v2.1.0-source-with-handoff.zip`，其中不包含 API Key、用户数据、依赖缓存和编译产物。

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
继续开发益达工作台。项目是 React/Vite + Express/TypeScript + Tauri 2，Windows release 通过 Node.js sidecar 启动本地 API。请先阅读 DEVELOPMENT_HANDOFF.md、README.md、VIDEO_HANDOFF.md 和 src-tauri 配置，再修改代码。不要把中转站 API Key 写进代码或提交到 Git。当前重点是保持已有多渠道、官方参数透传、历史记录、视频轮询与重启恢复、Tauri sidecar 能力。
```
