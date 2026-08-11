# Image Relay Studio 开发交接背景

## 项目目标

这是一个 Windows 桌面图片生成客户端。前端提供渠道、模型和生图参数配置，后端通过中转站 API 调用不同图片模型。用户使用的是中转站 API Key，不需要官方模型账号登录。

## 当前架构

- React + Vite：桌面窗口内的界面。
- Express + TypeScript：本地 API 服务。
- Tauri 2：Windows 桌面壳和窗口管理。
- Node.js sidecar：release 版本内置 Node.js，启动本地 Express 服务。
- SQLite：保存渠道、任务、历史和诊断记录。
- 生产桌面 API：`http://127.0.0.1:17892`。
- 普通 Web 开发 API：`http://127.0.0.1:17891`。

## 已实现能力

- 多渠道和多模型 ID。
- OpenAI Images、OpenAI Chat Image、Gemini Content、Midjourney Task、Generic JSON 适配器。
- 单张参考图图生图；上传支持 PNG、JPEG、WebP，最大 10 MB。
- 文生图基础参数、高级 JSON 参数透传。
- OpenAI、Gemini、Midjourney 的常用官方参数。
- Midjourney 异步轮询、取消和失败重试。
- URL/Base64 图片保存、本地历史记录、脱敏诊断。
- SSRF 防护和 API Key 环境变量支持。
- 高级 JSON 对同名基础字段拥有最高优先级，不维护渠道能力矩阵。
- 参考图保存在数据目录的 `inputs/`，任务 JSON 和诊断记录不会保存上传 Base64；OpenAI Images 默认使用 `/v1/images/edits` multipart 请求。

## API Key 规则

渠道的 Base URL、适配器、模型和 API Key 在应用中配置。API Key 可以通过环境变量 `RELAY_API_KEY` 提供，也可以在渠道界面临时输入。临时输入的密钥只在当前 Node 进程内存中使用，不要提交到 GitHub，也不要写入交接文档。

换电脑后需要重新配置密钥：

```dotenv
RELAY_API_KEY=替换为中转站密钥
```

如果使用 `.env`，请在新电脑单独创建，不要从 Git 仓库公开提交。

## 重要目录和文件

- `src/client/App.tsx`：主界面和表单。
- `src/client/api.ts`：前端 API 客户端和桌面 API 地址切换。
- `src/server/app.ts`：Express 路由和请求校验。
- `src/server/adapters.ts`：各渠道请求适配。
- `src/server/index.ts`：本地 API 入口。
- `src/shared/types.ts`：前后端共享类型。
- `src-tauri/tauri.conf.json`：Tauri 窗口、资源、sidecar 和 CSP 配置。
- `src-tauri/src/lib.rs`：启动和关闭 Node sidecar 的 Rust 代码。
- `scripts/prepare-tauri.mjs`：复制服务端资源、生产依赖和 Node sidecar。
- `README.md`：日常运行和构建说明。

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

输出位于 `artifacts/Image-Relay-Studio-portable-win-x64/` 和 `artifacts/Image-Relay-Studio-portable-win-x64.zip`。

生成用于换电脑继续开发的源码包：

```powershell
npm run tauri:package:source
```

输出为 `artifacts/Image-Relay-Studio-source-with-handoff.zip`，其中不包含 API Key、用户数据、依赖缓存和编译产物。

直接分发时必须保留同目录的 `node.exe` 和 `resources/`。标准安装包命令是：

```powershell
npm run tauri:build
```

该命令需要从 GitHub 下载官方 NSIS 工具；如果网络无法访问 GitHub，可以先使用 `tauri:build:exe` 的便携目录版本。

## 数据位置

Tauri 版本默认使用：

- SQLite、参考图和生成图片：`%APPDATA%/com.imagerelay.studio/data`
- 日志：`%LOCALAPPDATA%/com.imagerelay.studio/logs`

迁移历史图片和记录时，需要单独复制旧电脑对应的 `data` 目录。

## 给下一次 Codex 对话的提示词

```text
继续开发 Image Relay Studio。项目是 React/Vite + Express/TypeScript + Tauri 2，Windows release 通过 Node.js sidecar 启动本地 API。请先阅读 DEVELOPMENT_HANDOFF.md、README.md 和 src-tauri 配置，再修改代码。不要把中转站 API Key 写进代码或提交到 Git。当前重点是保持已有多渠道、官方参数透传、历史记录和 Tauri sidecar 能力。
```
