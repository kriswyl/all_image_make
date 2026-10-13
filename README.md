# 益达工作台

当前发布版本为 `2.0.1`。完整打包步骤、版本更新和发布文件说明见 [`PACKAGING.md`](PACKAGING.md)。

一个面向**图片 / 视频生成中转 API** 的本地客户端，附带 Tauri 桌面版。前端负责渠道配置、参数输入、结果与历史查看；后端统一处理鉴权、协议适配、异步轮询、素材落盘与脱敏诊断。

## 功能

### 生图

- OpenAI Images、OpenAI Chat Image、Gemini Content 和 Generic JSON 四种适配器
- 文生图与最多 8 张参考图图生图，支持 PNG、JPEG、WebP（单张最大 10 MB）
- 参考图可以点击选择，也可以直接把图片文件拖到上传区
- 选中参考图后，OpenAI Images 自动从 `/v1/images/generations` 切换到 `/v1/images/edits` 并改发 multipart
- 官方风格参数与高级 JSON 参数透传
- URL / Base64 结果下载并保存到本地

### 视频

三种视频渠道，各自按官方协议构造请求体：

| 渠道 | 适配器 | 模型 | 时长 | 分辨率 | 参考图 | 音频 |
|---|---|---|---|---|---|---|
| 通义万相 | `wan-video` | `wan3.0-video` | 2–30 秒 | 480P / 720P / 1080P | ≤ 10 张 | ✓ |
| Grok Imagine | `grok-video` | `grok-imagine-video`、`-1.5-preview`、`-1.5` | 1–15 秒 | 480p / 720p / 1080p | ≤ 7 张 | — |
| 豆包 Seedance | `seedance-video` | `sd-2.5`、`sd-2.0`、`sd-2.0-fast`、`sd-2.0-mini` | 4–30 秒 | 480p / 720p / 1080p | ≤ 10 张 | ✓ |

生成模式按渠道给出，切换模式会清空已传图片：

- **万相 7 种**：文生视频、首帧生视频、首尾帧生视频、参考生视频、视频编辑、视频延长、参考文件生视频
- **Seedance 4 种**：文生视频、首帧生视频、首尾帧生视频、参考生视频
- **Grok** 没有模式概念，只按「有没有参考图」区分

万相的参考视频 / 音频 / 文档只接受公网 URL，不支持上传；图片一律转为内联 data URI 发送。提交后进入异步轮询，完成后自动下载视频落盘，支持双击放大与历史回看。

视频任务提交后会记下上游的任务 ID。**应用重启时，已经提交出去、还在生成的视频会接着轮询**，而不是被判定为失败。

参考图同样支持拖放上传，交互与生图工作台一致。

### 通用

- 多渠道、多模型 ID 配置，一个渠道一个密钥
- **添加渠道向导**：内置 9 个站点预设，按模型系列分别创建渠道，每个单元使用独立密钥，并在卡片上显示站点品牌图标
- SQLite 历史记录、结果缩略图与脱敏请求诊断
- API Key 从环境变量读取，或保存在数据目录的本地文件中供下次启动使用
- 可调生成超时（10 秒到 30 分钟，默认 3 分钟）
- 默认阻止本地和内网目标地址，可按渠道显式放开

### 历史与素材目录

- **清空历史**前会弹确认框，可以选择「同时删除本地文件」（默认）或「仅删除记录，保留本地文件」，并按图片 / 视频 / 全部筛选
- 生成产物的保存目录可以改成任意位置（历史页的「目录设置」，桌面版使用原生文件夹选择器），也可以一键恢复默认
- 换目录**不会迁移已有文件**：每条产物记录着自己所在的目录，旧历史缩略图、播放和下载都不受影响
- 视频任务的诊断记录采用「首尾完整 + 中间精简」——提交请求和最后一次轮询保留完整响应，中间的轮询只存一行状态摘要，避免一个任务把数据库撑到几 MB

### 内置站点预设

| 站点 | 预设单元 |
|---|---|
| 向量引擎 `api.vectorengine.cn` | gpt 生图、gpt-c 生图、gemini 生图 |
| 词元流墟 `api.tiantoken.com` | gpt 生图、gpt-c 生图、gemini 生图、万相视频、grok 视频、seedance 视频 |

中转站通常按模型系列分别售卖密钥，因此这些单元互不共用 Key。也可以选择「自定义配置」手动填写任意 Base URL。

## 界面

四个工作区：**生图工作台**、**视频工作台**、**渠道配置**、**生成历史**。两个工作台共用顶部的渠道 / 模型选择器和参数面板，右侧为结果区；渠道配置页管理渠道并执行连接测试；生成历史页汇总全部任务与产物，并能按类型清空历史、更改产物保存目录。

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

输出位于 `artifacts/益达工作台-v2.0.1-portable-win-x64.zip`。

桌面版 API 固定监听 `127.0.0.1:17892`。SQLite、参考图与生成产物默认保存在 `%APPDATA%/com.imagerelay.studio/data`，运行日志保存在 `%LOCALAPPDATA%/com.imagerelay.studio/logs`。生成产物（图片和视频）的目录可以在历史页改成任意位置，改完只影响之后生成的文件。

## 密钥配置

推荐在项目目录的 `.env` 中配置渠道密钥：

```dotenv
PORT=17891
RELAY_API_KEY=replace-me
VECTORENGINE_API_KEY=replace-me
```

添加渠道时，将「环境变量」填写为 `RELAY_API_KEY`。也可以直接在渠道界面输入 API Key，它会以明文 JSON 保存在数据目录的 `channel-keys.json` 中（文件权限 0600），服务重启后自动载入，不需要二次配置。删除渠道会同时删除该渠道的密钥。密钥不会写入 SQLite，也不会显示在诊断记录或接口响应中。

明文保存意味着任何能读取该文件的程序都可以取得密钥。数据目录已在 `.gitignore` 中，请不要提交或随意分享它。

向导预设为每个模型组分配独立的环境变量名，例如向量引擎的 gpt 使用 `VECTORENGINE_API_KEY`、gpt-c 使用 `VECTORENGINE_GPT_C_API_KEY`、gemini 使用 `VECTORENGINE_GEMINI_API_KEY`。

服务也会读取项目上一级目录的 `.env`。可用 `DATA_DIR` 环境变量修改 SQLite、参考图与生成产物目录，默认使用项目内的 `data/`。

## 渠道配置

1. 填写渠道名称、Base URL 和适配器类型。
2. 确认生成路径，留空则使用所选适配器的默认路径。
3. 选择鉴权方式并配置环境变量名或 API Key。
4. 每行填写一个中转站实际使用的模型 ID。
5. 保存后可在渠道页执行连接测试，再到对应工作台提交任务。

基础表单参数会由所选适配器映射到目标协议。高级 JSON 会合并到最终请求体；程序不判断某个渠道是否支持或实际执行了这些参数。最终发送内容和响应可在任务诊断中查看。

## 参数范围

生成页会按适配器显示对应参数，不会维护渠道能力矩阵：

- **OpenAI Images**：常用尺寸与自定义宽高、质量、背景、输出格式、数量、内容审核、风格、响应格式、流式输出
- **Gemini Content**：宽高比、输出尺寸（1K/2K/4K）、候选数量、温度、Top P、Top K、最大输出 Token、响应模态、Seed
- **视频**：生成模式、时长、分辨率、宽高比、参考图、Seed、水印、音频；万相另有提示词智能改写
- **生成超时**：所有适配器通用，10 秒到 30 分钟，默认 3 分钟，保存在本机
- **高级 JSON**：透传协议或中转站专属字段，优先级高于可见控件

OpenAI 的 `style`、`response_format`、`stream` 等字段会按接口原名发送；Gemini 的生成控制会合并到 `generationConfig`，宽高比和尺寸会合并到 `imageConfig`。某个中转渠道是否接受或实际执行参数，仍以该渠道响应为准。

### 内联素材体积上限

视频素材以 base64 data URI 内联发送。部分中转站对请求体有硬上限（实测约在 1–2 MB 之间），超限时只会返回含糊的 502 或连接层失败。客户端会把上传的图片压到长边 1280 的 JPEG 后再发送；服务端也会提前拦截超限的内联素材并给出明确报错，而不是让任务空等。公网 / `oss://` 地址不占请求体。

## 验证

```powershell
npm test
npm run build
```

## 已知限制

- 蒙版编辑、模型能力自动识别、参数是否实际生效的判断不在当前范围内
- 部分中转站的视频模型可用性可能与其模型列表不一致，以实际提交结果为准
- 视频渠道的真实联调覆盖有限，详见 [`VIDEO_HANDOFF.md`](VIDEO_HANDOFF.md)

更完整的设计和接口说明见上一级目录的 `IMAGE_GENERATION_RELAY_APP_DEVELOPMENT.md`。
