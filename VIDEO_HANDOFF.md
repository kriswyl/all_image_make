# 视频生成功能 · 交接文档

> 写给下一个对话窗口的自己。读完这份就能接上，不需要翻历史。

**工程根目录**：`D:\codexuse\shengtu\all_image_make`（不是 git 仓库）

## 当前状态

| 项目 | 状态 |
|---|---|
| TypeScript | `npx tsc --noEmit` 零错误 |
| 单元测试 | `npm test` → 48 passed（3 个文件） |
| 开发服务 | 前端 `127.0.0.1:5174`，API `127.0.0.1:17891` |
| 真实 API 联调 | Seedance **已跑通**（见下）；万相 / Grok 仍只测到 mock 上游 |

前端原本占 5173，被别的进程占了，vite 自动退到 5174。`.claude/launch.json` 里写的还是 5173，如果要用 preview 工具得先改。

## 已完成的功能

### 三种视频渠道

| 适配器 | 渠道预设 | 模型 |
|---|---|---|
| `wan-video` | 词元流墟-万相视频 | wan3.0-video |
| `grok-video` | 词元流墟-grok视频 | grok-imagine-video / -1.5-preview / -1.5 |
| `seedance-video` | 词元流墟-seedance视频 | sd-2.5 / sd-2.0 / sd-2.0-fast / sd-2.0-mini |

`provider-presets.ts` 里一共 9 个预设，全部按「模型系列」平铺成独立模板，不按站点合并：向量引擎 3 个（gpt / gpt-c / gemini），词元流墟 6 个（gpt / gpt-c / gemini / 万相 / grok / seedance）。

### 请求体格式（三家都不同，改代码时注意）

**Grok** — 参数平铺，图片走 `reference_images`：
```json
{ "model": "...", "prompt": "...", "duration": 8, "resolution": "720p",
  "aspect_ratio": "16:9", "reference_images": [{ "url": "data:..." }] }
```

**万相** — `input.media[]` 带 `type`，另有 `X-DashScope-Async: enable` 头：
```json
{ "model": "...", "input": { "prompt": "...", "media": [{ "type": "first_frame", "url": "..." }] },
  "parameters": { "resolution": "720P", "ratio": "adaptive", "duration": 5,
                  "audio": true, "prompt_extend": true, "seed": 1, "watermark": false } }
```
media 里出现 `file` 或 `link` 时，`prompt_extend` 被强制改成 `true`（官方要求）。

**Seedance** — `content[]` 数组，role 决定素材语义：
```json
{ "model": "sd-2.5", "content": [
    { "type": "text", "text": "..." },
    { "type": "image_url", "image_url": { "url": "..." }, "role": "first_frame" } ],
  "resolution": "720p", "ratio": "16:9", "duration": 5,
  "generate_audio": false, "seed": 1, "watermark": false }
```

### 端点与轮询

| 适配器 | 提交端点 | 轮询端点 |
|---|---|---|
| wan-video | `/api/v1/services/aigc/video-generation/video-synthesis` | `/api/v1/tasks/{id}` |
| grok-video | `/v1/videos/generations` | `/v1/videos/{id}` |
| seedance-video | `/api/v3/contents/generations/tasks` | `/api/v3/contents/generations/tasks/{id}` |

这三处路径在两个文件里各写了一遍，改动时要同步：`src/server/adapters.ts` 的 `defaultEndpoint()` 和 `src/shared/provider-presets.ts` 的 `adapterDefaultEndpoint()`，轮询路径在 `src/server/tasks.ts` 的 `pollVideoTask()`。

### 前端模式选择器

`VideoGenerateView.tsx` 里两套模式表，结构同构（都是 `WanModeSpec`）：

- `WAN_MODES` — 7 种：文生视频 / 首帧 / 首尾帧 / 参考 / 视频编辑 / 视频延长 / 参考文件
- `SEEDANCE_MODE_SPECS` — 4 种：文生视频 / 首帧 / 首尾帧 / 参考图

Grok 没有模式概念，只按「有没有参考图」区分文案。

每套模式声明的 `imageSlots` 决定上传几张图、每张标什么 role；`urlSlots` 决定要填几个公网地址（万相的视频/音频/文档只收 URL，不支持上传）。切换模式会清空已传图片。

### 关键约束（已实现，别改坏）

- Seedance 首帧/首尾帧模式下宽高比锁死 `adaptive`（官方 2.5 要求），选择器禁用
- 万相 `file` 与 `link` 互斥，同时填会被前端拦下
- 首尾帧模式必须正好 2 张图，数量不对提交前报错
- 图片素材一律转 base64 data URI 发送
- `generate_audio` 默认 `false`（官方默认是 `true`，这里刻意跟其他渠道保持一致）

## 踩过的坑（都已修）

1. **Grok 返回了 URL 却报「没找到视频」** —— `extractVideoCandidates()` 要求字段名匹配 `url|video|output|result`，但遍历从根节点开始时 `parentKey` 是空串，**响应顶层的链接一律提取不到**。现在带 `.mp4`/`.webm`/`.mov` 扩展名的链接直接收，不看字段名。

2. **`wanVideoMedia[].url` 被 zod 卡在 5000 字符** —— base64 图片的 data URI 是几十万字符，请求在进适配器前就被拒，前端只看到「输入数据无效」。上限放到 28M 字符。

3. **express body 上限 16mb 装不下两张图** —— 万相允许 10 张 20MB 图，base64 后约 266MB。已提到 300mb。

4. **万相 `task_id` 藏在 `output` 里** —— 原来的 `extractAsyncTaskId()` 只读顶层，补了 `output.task_id` / `output.id`。

5. **视频时长提取不到** —— Seedance 把 `duration` 放在 `content` 的兄弟节点，URL 在 `content.video_url` 里。改成向下继承父级 `duration`。

6. **状态识别太窄** —— 原来只认顶层 `status`，且只认 `succeeded`/`done`/`completed`。补了 `task_status`、`output.task_status`，失败态补了 `canceled`/`unknown`（这些以前会被当成「还在跑」一直轮询到超时）。

7. **Toast 挡住右下角点击** —— 提示条 `z-index: 80` 压住「最近」缩略图条，加了 `pointer-events: none`。

8. **Seedance 报 `fetch failed` / 502，看起来像鉴权或路径错，其实是请求体太大** —— 这个坑很会骗人，诊断记录在 `diagnostics` 表里，但连接层失败（`fetch failed`）**根本不会写诊断**，所以一开始什么线索都没有。

   **中转站（api.tiantoken.com）对请求体的实际上限在 1~2MB 之间**，实测：

   | 请求体 | 结果 |
   |---|---|
   | 0.2MB | 通过，12.7s |
   | 1MB | 通过，**77.6s** |
   | 2MB | 网关拦截，返回「请求内容格式错误」 |
   | 4MB | 超时 |
   | 9.41MB | 网关拦截，69.5s |

   超限时不会返回有用的错误，只有含糊的 502 HTML 或 `fetch failed`，任务白等 5 分钟才失败。

   根因是前端 `fileToDataUrl()` 直接 `readAsDataURL` 原样发送：一张 7.4MB 的 PNG 编码后是 9.4MB，远超上限。现在客户端压到长边 1280 的 JPEG（`fileToVideoDataUrl()` / `downscaleToJpeg()`，在 `VideoGenerateView.tsx`），单张约 150~250KB；服务端另加 1.4M 字符预算兜底（`tasks.ts` 的 `MAX_INLINE_MEDIA_CHARS` + `inlineMediaSize()`），直接调 API 传大图时会立刻报明确错误，而不是干等。

   注意只有 `data:` 开头的内联 base64 才算进这个预算，公网 / `oss://` 地址不占请求体。

## 未验证的部分

- **万相 / Grok 还是没打过真实 API**，只测到 mock 上游。不过第 8 条那个体积上限是**中转站层面的**，三个视频渠道共用 `api.tiantoken.com`，所以万相 / Grok 同样受 1~2MB 限制 —— 现在客户端压缩对两者一起生效。
- 需求 2（Grok 链接可见性）的修复是基于代码推断，没有用户的真实失败响应样本，无法确认命中的是哪条路径。
- 需求 3（Toast 遮挡）只改了 CSS，没在浏览器实测点击穿透。
- **浏览器里没实测压缩后的实际体积**。1280 长边 / q0.85 的 JPEG 按经验在 150~250KB，但没有真机跑过。真实验证用的是另一条路径（见下），不是这条前端逻辑。

## Seedance 真实验证记录（2026-10-12）

用 `词元流墟-seedance视频` 渠道（`996611d8-…`）跑通了一次完整链路：

- `/v1/models` 返回 180 个模型，`sd-2.5` / `sd-2.0` / `sd-2.0-fast` / `sd-2.0-mini` **都在**，短名可用
- 提交端点 `/api/v3/contents/generations/tasks` 确认正确，上游是**火山方舟本体**（错误信息形如 `InvalidParameter: ... Request id:[req_…]`）
- 提交：请求体 139KB，**http 200 / 14.3s**，返回 `{"id":"cgt-…"}`
- 轮询：14 次 `running` 后 `succeeded`，**全程约 175s**
- 响应里视频在 `content.video_url`，`extractVideoCandidates()` 能正确提取 url 和继承的 `duration`（已用真实响应核对过）

**踩到的一个意外**：拿真人照片当首帧会被方舟风控拦下 —— `PrivacyInformation: the input image 'content[1]' may contain real person`。这不是 bug，是上游策略，用户选图时要知道。

## 可以问用户的开放问题

1. 万相的 `reference_video` / `reference_audio` 是否也支持 base64？用户说过「图片都支持 base64」，视频音频当时没答。若支持，可以把 `video-edit` / `video-extend` / 参考视频那几个槽从「只填 URL」改成支持上传。注意要同步调大体积上限。
2. 需求 1 的截图只显示了向量引擎，词元流墟没截图，现有 6 个预设是按向量引擎的同样模式推的，没逐字核对。
3. `grok-imagine-video-1.5` 在渠道模型列表里，但**中转站的 `/v1/models` 里没有**（只有 `grok-imagine-video` 和 `grok-imagine-video-1.5-preview`）。还没试过提交，不确定是真不支持还是只是没列出来。

## 测试怎么跑

```bash
cd all_image_make
npm test          # 48 个测试
npx tsc --noEmit  # 类型检查
npm run dev       # 起服务
```

测试里 `vitest.config.ts` 设了 `VIDEO_POLL_INTERVAL_MS=20`，把视频轮询从 8 秒压到 20ms，否则端到端测试跑不完。生产默认仍是 8 秒（`tasks.ts` 的 `VIDEO_POLL_DELAY_MS`）。

端到端测试的模板在 `tests/app.test.ts` 的「runs a Seedance task end to end」，mock 了提交 → 轮询两次 → 下载落盘的完整链路，加新视频渠道时照着改。

## 主要文件职责

```
src/shared/types.ts             适配器类型、生成参数、三种视频模式定义
src/shared/provider-presets.ts  渠道预设（9 个），改动要和 adapters 的 defaultEndpoint 同步
src/server/adapters.ts          各渠道请求体构造、视频链接提取
src/server/tasks.ts             异步任务轮询、视频下载落盘、内联素材体积预算
src/server/app.ts               zod 校验（新参数记得加进 generationSchema）
src/client/VideoGenerateView.tsx 视频工作台、模式选择器
src/client/App.tsx              图片/视频渠道与任务的状态分离
```
