# Image Relay Studio

## Tauri 桌面版

桌面版保留现有 React 界面，并由 Tauri 启动内置 Node.js sidecar 提供本地 API。开发模式：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri:dev
```

构建可直接运行的 release 版本：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri:build:exe
```

主程序位于 `src-tauri/target/release/image_relay_studio.exe`。直接分发时必须同时保留同目录的 `node.exe` 与 `resources/`；正常分发建议使用 `npm run tauri:build` 生成 NSIS 安装包。第一次构建需要 Rust、Visual Studio C++ Build Tools 和 WebView2；NSIS 首次打包还需要能够访问 GitHub 下载 Tauri 官方工具。

将当前 release 产物整理为便携目录和 ZIP：

```powershell
npm run tauri:package:portable
```

输出位于 `artifacts/Image-Relay-Studio-portable-win-x64.zip`。

桌面版 API 固定监听 `127.0.0.1:17892`。SQLite、参考图与生成图片默认保存在 `%APPDATA%/com.imagerelay.studio/data`，运行日志保存在 `%LOCALAPPDATA%/com.imagerelay.studio/logs`。

一个面向图片生成中转 API 的本地最简客户端。前端负责渠道配置、参数输入、结果和历史查看；后端统一处理鉴权、协议适配、异步轮询、图片落盘与脱敏诊断。

## 当前功能

- 多渠道、多模型 ID 配置
- OpenAI Images、OpenAI Chat Image、Gemini Content、Midjourney Task 和 Generic JSON 适配器
- 文生图与单张参考图图生图，支持 PNG、JPEG、WebP（最大 10 MB）
- 文生图官方风格参数与高级 JSON 参数
- Midjourney 异步任务轮询、取消和失败重试
- URL/Base64 结果下载并保存到本地
- SQLite 历史记录和脱敏请求诊断
- API Key 仅从环境变量读取或保存在当前服务内存中
- 默认阻止本地和内网目标地址，可按渠道显式放开

当前版本支持文生图和单张参考图图生图。蒙版编辑、多参考图、模型能力识别和参数是否实际生效的判断仍不在当前范围内。

## 运行要求

- Node.js 24 或更高版本
- npm

## 本地开发

```powershell
npm install
npm run dev
```

开发界面默认位于 `http://127.0.0.1:5173`，API 服务位于 `http://127.0.0.1:17891`。

## 生产运行

```powershell
npm run build
npm start
```

完成构建后，应用位于 `http://127.0.0.1:17891`。

## 密钥配置

推荐在项目目录的 `.env` 中配置渠道密钥：

```dotenv
PORT=17891
RELAY_API_KEY=replace-me
```

添加渠道时，将“环境变量”填写为 `RELAY_API_KEY`。也可以直接在渠道弹窗输入 API Key，但它只存在于当前 Node.js 进程内存中，服务重启后需要重新输入。密钥不会写入 SQLite，也不会显示在诊断记录中。

服务也会读取项目上一级目录的 `.env`。可用 `DATA_DIR` 环境变量修改 SQLite、参考图与生成图片目录，默认使用项目内的 `data/`。

## 渠道配置

1. 填写渠道名称、Base URL 和适配器类型。
2. 确认生成路径；Midjourney 还需填写状态查询路径，其中可使用 `{taskId}`。
3. 选择鉴权方式并配置环境变量名或临时 API Key。
4. 每行填写一个中转站实际使用的模型 ID。
5. 保存后可在渠道页执行连接测试，再到生成页提交任务。

基础表单参数会由所选适配器映射到目标协议。高级 JSON 会合并到最终请求体；程序不判断某个渠道是否支持或实际执行了这些参数。最终发送内容和响应可在任务诊断中查看。

选择参考图后，OpenAI Images 默认从 `/v1/images/generations` 自动切换到 `/v1/images/edits` 并发送 multipart；OpenAI Chat Image、Gemini Content、Midjourney Task 和 Generic JSON 分别使用各自常见的图片输入结构。渠道使用自定义生成路径时会保留该路径，高级 JSON 仍拥有最高优先级。

## 参数范围

生成页会按适配器显示对应参数，不会维护渠道能力矩阵：

- OpenAI Images：常用尺寸与自定义宽高、质量、背景、输出格式、数量、内容审核、风格、响应格式、流式输出
- Gemini Content：宽高比、输出尺寸（1K/2K/4K）、候选数量、温度、Top P、Top K、最大输出 Token、响应模态、Seed
- Midjourney Task：宽高比、版本、处理模式、风格化、混乱度、奇异度、Seed
- 高级 JSON：透传协议或中转站专属字段，优先级高于可见控件

OpenAI 的 `style`、`response_format`、`stream` 等字段会按接口原名发送；Gemini 的生成控制会合并到 `generationConfig`，宽高比和尺寸会合并到 `imageConfig`。某个中转渠道是否接受或实际执行参数，仍以该渠道响应为准。

## 验证

```powershell
npm test
npm run build
```

更完整的设计和接口说明见上一级目录的 `IMAGE_GENERATION_RELAY_APP_DEVELOPMENT.md`。
