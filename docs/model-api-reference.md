# 模型请求接口参考（Model API Reference）

> 本文描述 ChatCanvas **调用上游中转站 / 官方 API** 时实际发出的 HTTP 请求：接口路径、请求头、请求体格式、异步轮询协议。
> 全部内容从源码逐字段提取（行号标注在关键处），而非从文档推断。版本对应 **v2.4.3**。
>
> 配套文档：想按**具体模型名**直接查某个模型怎么调，见 [按模型名速查](model-api-by-model.md)；能力边界与实测坑见各 `*_HANDOFF.md`；应用自身对外接口见 `docs/architecture.md`。

---

## 0. 先读这一节：通用约定

所有上游请求都经过统一骨架，理解这几个函数就能读懂后面所有渠道。

### 0.1 URL 拼接与 endpoint

- 完整 URL = `joinEndpoint(channel.baseUrl, endpoint)`，即去掉 baseUrl 尾部斜杠 + 保证 endpoint 以 `/` 开头后拼接（`src/server/security.ts:47-51`）。
- endpoint 取值：`channel.endpoint || defaultEndpoint(adapterType)`（`src/server/adapters.ts:275`）。渠道可自定义覆盖；`{model}` 占位符用 `encodeURIComponent(model)` 替换（`:288`）。
- `assertEndpoint()` 校验：必须以 `/` 开头，禁止 `\` 和 `..`（`security.ts:19-24`）。
- 默认提交路径唯一真相：`src/shared/adapter-endpoints.ts:10-26`。

### 0.2 通用请求头

| 头 | 值 | 出处 |
|---|---|---|
| `Accept` | `application/json`（对话大脑为 `text/event-stream`） | adapters.ts:290 / brain.ts:120 |
| `Content-Type` | 有 JSON body 时 `application/json`；multipart 分支不设置（由 fetch 自动带 boundary） | adapters.ts:756 |
| `Authorization` | 见 0.3 | adapters.ts:198-210 |

所有生成请求方法固定为 **POST**（`adapters.ts:780`）。

### 0.3 鉴权 `applyAuth()`（adapters.ts:198-210）

| authType | 实际行为 |
|---|---|
| `bearer` | `Authorization: Bearer <key>` |
| `x-api-key` | `<authHeaderName 或 x-api-key>: <key>` |
| `custom-header` | 同上，默认头名 `x-api-key` |
| `query` | URL 追加 `?<authHeaderName 或 key>=<key>` |
| `none` | 不加鉴权 |

- Key 读取优先级：`sessionKeys.get(channel.id)`（界面填的，落盘 `channel-keys.json`，权限 0600）→ `process.env[channel.secretEnv]`（`src/server/routes/channel-config.ts:22-27`）。
- 无 key 且 authType≠none → 抛「该渠道没有可用的 API Key」。
- 预设渠道全部为 `bearer`。

### 0.4 安全：SSRF 防护（`security.ts:26-64`）

- 只放行 `http:` / `https:`；默认拒绝本地与内网地址，`allowPrivateNetwork: true` 的渠道才跳过检查。
- 内网判定：IPv4 `10/8`、`127/8`、`172.16-31`、`192.168/16`、`0/8`；IPv6 `::1`、`::`、`fc00::/7`、`fe80:`。
- 对 hostname 做 `dns.lookup(all:true)`，任一解析结果命中内网即拒绝（防 DNS 重绑定）。
- 重定向手动跟随，最多 3 跳，每跳重新校验；默认超时 180s。

### 0.5 一个关键设计：`raw` 高级 JSON 透传

几乎每个请求体末尾都会展开 `...raw`（用户在渠道里填的高级 JSON），**优先级高于内置字段**，可覆盖 `model`、`prompt` 等任何字段。程序不判断渠道是否支持，只把它合并进最终请求体（`adapters.ts:752`、README「渠道配置」）。诊断里会列出「设了但渠道不认」的字段，但不拦截。

### 0.6 适配器总览

`AdapterType` 共 13 种（`src/shared/types.ts:33-46`）：

| adapter | 用途 | 默认提交 endpoint | 模式 |
|---|---|---|---|
| `openai-images` | 文生图 / 图生图 | `/v1/images/generations`（有参考图切 `/v1/images/edits`） | 同步 |
| `openai-chat-image` | chat 出图 | `/v1/chat/completions` | 同步 |
| `gemini-content` | Gemini 出图 | `/v1beta/models/{model}:generateContent` | 同步 |
| `generic-json` | 通用 JSON 出图 | `/v1/images/generations`（default 分支） | 同步 |
| `midjourney` | Midjourney | `/mj/submit/imagine` | **异步** |
| `wan-video` | 通义万相视频 | `/api/v1/services/aigc/video-generation/video-synthesis` | **异步** |
| `grok-video` | Grok 视频 | `/v1/videos/generations` | **异步** |
| `minimax-video` | MiniMax H3 视频 | `/v1/video/generations`（单数） | **异步** |
| `seedance-video` | 豆包 Seedance 视频 | `/api/v3/contents/generations/tasks` | **异步** |
| `kling-video` | 可灵视频 | 由 `klingEndpoint()` 动态决定 | **异步** |
| `suno-music` | Suno 音乐 | `/api/queue/makeAiMusic` | **异步（双任务）** |
| `gemini-tts` | Gemini 语音 | `/v1beta/models/{model}:generateContent` | 同步 |
| `openai-chat` | 对话大脑 | `/v1/chat/completions`（SSE） | 流式 |

> 代码中**不存在** `openai-content` 这个 adapter；README 里的「OpenAI Chat Image」对应 `openai-chat-image`。
> 连接测试：gemini-* 走 GET `/v1beta/models`，openai-* 走 GET `/v1/models`，其余 GET `/`（adapters.ts:797-803）。

---

## 1. 生图适配器

### 1.0 公共参数工厂 `openAiImageParameters()`（adapters.ts:74-88）

`openai-images` / `openai-chat-image` / `generic-json` 共用这组参数，经 `compact()` 去掉空值：

| 字段 | 类型 | 说明 |
|---|---|---|
| `negative_prompt` | string | **仅** `!/^gpt-image-/i.test(model)` 时出现（channel-fields.ts:79-81） |
| `size` | string | 尺寸 |
| `n` | number | 数量 |
| `quality` | string | 质量 |
| `output_format` | enum | `png/jpeg/webp/gif/svg` |
| `frame_count` | number | 仅 gif 时生成，默认 9 |
| `frame_duration_ms` | number | 仅 gif 时生成，默认 200 |
| `background` | enum | `auto/opaque/transparent` |
| `moderation` | enum | `auto/low` |
| `style` | enum | `auto/vivid/natural` |
| `response_format` | enum | `auto/url/b64_json` |
| `stream` | boolean | — |

### 1.1 openai-images（OpenAI Images）

**接口**：`POST /v1/images/generations`；有参考图且 endpoint 为默认值（或用户设的值恰好等于默认值）时自动切换到 `POST /v1/images/edits`（adapters.ts:275-279）。

**请求头**：`Accept: application/json` + `Authorization: Bearer <key>`；
无参考图（JSON）加 `Content-Type: application/json`；有参考图（multipart）**不设置** Content-Type（adapters.ts:756）。

**请求体 · 无参考图（JSON）**（adapters.ts:745-754）：

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "size": "1024x1024",
  "n": 1,
  "quality": "auto",
  "background": "auto",
  "moderation": "auto",
  "response_format": "url",
  "...": "<raw 高级 JSON 最后展开，可覆盖任意字段>"
}
```

**请求体 · 有参考图（multipart/form-data）**（adapters.ts:599-650）：

| form field | 编码 |
|---|---|
| `model` / `prompt` / 1.0 各参数 / `...raw` | 字符串：string/number/boolean → `String(v)`；对象/数组 → `JSON.stringify(v)` |
| `image`（1 张）或 `image[]`（多张，重复 append） | **二进制文件 part**：`Blob(bytes, {type: 原始 MIME})` + 原始文件名，不是 base64 |
| `mask`（显式蒙版，仅 1 张参考图时生效） | `Blob(bytes, {type:"image/png"})`，文件名强制 `.png` |

- 带蒙版时 prompt 自动追加固定后缀：`" 只修改蒙版标记的区域；…"`（adapters.ts:69-71、:612）。
- 逃生口：若 raw 里已有 `image` / `image[]` / `mask`，按文本字段原样发送，不再生成文件 part（:620-637）。
- 诊断记录把二进制替换为 `[IMAGE_DATA n bytes]`，不泄漏 base64（:640-650）。

**参考图额度**：默认 8 张；gpt-image-2 / 2.5 / 2.6 系列 16 张；蒙版操作 1 张（`src/shared/image-reference-limits.ts`）。单张上限 20 MiB，进入适配器前按 `{maxEdge:2048, maxBytes:20MiB, quality:92}` 处理（`vision.ts:51-52`）。

**响应解析**：递归遍历 JSON（深度≤8）收集候选：`b64_json`、`url`、`image_url.url`、data URI、父键匹配 `/url|image|output|result/i` 的 http(s) 字符串、Markdown `![](url)`（`adapters.ts:899-936`）。响应 `Content-Type: image/*` 时整包当图（:833）。

**其它**：图片默认超时 5 分钟（可配 10s–30min，types.ts:233）；GIF sprite sheet 超 2304×2304 直接拒（adapters.ts:263-268）。

---

### 1.2 openai-chat-image（OpenAI Chat Image）

**接口**：`POST /v1/chat/completions`（adapter-endpoints.ts:13）。请求头同上（JSON）。

**请求体**（adapters.ts:651-660）：

```json
{
  "model": "...",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "<prompt>" },
      { "type": "image_url", "image_url": { "url": "data:<mime>;base64,<...>" } }
    ]
  }],
  "<1.0 公共参数>": "...",
  "...raw": {}
}
```

- 无参考图时 `content` 为纯字符串；有参考图时为数组，参考图在前。
- 参考图 = base64 **data URI**，额度默认 8 张，不支持 mask。
- 响应解析同 1.1，Markdown 图片链接解析对 chat 返回尤其重要。

---

### 1.3 gemini-content（Gemini Content）

**接口**：`POST /v1beta/models/{model}:generateContent`（`{model}` 经 URL 编码）。

**请求头**：`Accept` + `Content-Type: application/json` + 鉴权。预设为 bearer；也支持 `x-api-key` + `authHeaderName: "x-goog-api-key"`。

**请求体**（adapters.ts:661-671）：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "inlineData": { "mimeType": "image/png", "data": "<裸 base64>" } },
      { "text": "<prompt>" }
    ]
  }],
  "generationConfig": {
    "candidateCount": 1,
    "temperature": 0.7,
    "topP": 0.9,
    "topK": 40,
    "maxOutputTokens": 8192,
    "responseModalities": ["IMAGE"],
    "seed": 123,
    "imageConfig": { "aspectRatio": "16:9", "imageSize": "2K" }
  },
  "...raw（去掉 generationConfig 后）": {}
}
```

- `inlineData` 在前、`text` 在后；裸 base64（无 `data:` 前缀）。
- 有 `negativePrompt` 时拼进 text：`"<prompt>\n\nNegative prompt: <...>"`（:662）。
- `generationConfig` 构造见 :157-179；`imageSize` 缺省由 TaskRunner 补 `"2K"`（tasks.ts:66-74），缺失会触发上游 400 `Unsupported resolution`。
- 参数矩阵只认 `imageSize`/`aspectRatio`，负面词会被记入 `ignoredFields` 诊断但仍拼进 text。
- **参考图额度**：gemini-3.1-flash-image / -lite-image / 3-pro-image / nano-banana-2.1 为 14 张，其它 8 张（`-preview` 后缀归一化匹配）。
- 响应：`inlineData.data` 裸 base64 由父键 `data` 识别；落盘时按字节头二次校正真实 MIME（inlineData 常把 JPEG 误标成 PNG）。

---

### 1.4 generic-json（Generic JSON）

无专属分支，落在 `buildGenerationRequest` 的公共 else（adapters.ts:745-754）。

**接口**：`POST /v1/images/generations`，JSON。

**请求体**：

```json
{
  "model": "...",
  "prompt": "...",
  "<1.0 公共参数>": "...",
  "image": "data:<mime>;base64,<...>",
  "images": ["data:<mime>;base64,<...>"],
  "...raw": {}
}
```

- 参考图：**顶层** data URI；1 张 → `image`，多张 → `images` 数组；0 张 → 不出现（:746、:751）。
- 额度默认 8 张、单张 20 MiB；不支持 mask。响应解析同 1.1。

---

### 1.5 midjourney（Midjourney）

**接口**（adapters.ts:283-287）：

| 场景 | 提交 endpoint |
|---|---|
| 有 `midjourneyAction`（放大/变体/重绘） | `POST /mj/submit/action` |
| 有参考图 | `POST /mj/submit/edits` |
| 纯文生图 | `POST /mj/submit/imagine` |

**请求头**：JSON 三件套 + bearer。

**请求体**（adapters.ts:725-744）：

```json
// 纯文生图
{ "prompt": "a cat --ar 16:9 --v 6 --no blurry", "...raw": {} }
// 图生图（只取第 1 张参考图）
{ "prompt": "a cat --ar 16:9", "image": "data:<mime>;base64,<...>", "...raw": {} }
// 后续动作
{ "taskId": "<父任务id>", "customId": "<按钮 customId>", "...raw": {} }
```

- **没有 `model` 字段**，也没有 OpenAI 那套参数；画幅/版本/排除词全部写进 prompt：`--ar`（aspectRatio≠auto 且 prompt 未写时追加）、`--v`（版本）、`--no`（negativePrompt）（:239-252）。
- 不写 `--v` 时网关自动补 `--v 8.2`（实测，MIDJOURNEY_HANDOFF.md）。
- 参考图只能 1 张，`base64Array` 会被上游当成没传图（实测坑）。
- 提交响应：`{ code:1, description, result:"<任务id>" }`——**任务 id 在 `result`，不在 `data`**。
- 轮询：`GET /mj/task/{id}/fetch`（见第 6 节）；取图：`GET /mj/image/{id}`（需同样 Bearer，CDN 地址不重放）。
- `customId` 必须出现在父任务 `buttons` 里才允许执行动作；需要 modal 参数的按钮（region/zoom/pan/animate）被隐藏。

---

## 2. 视频适配器

### 2.0 能力矩阵速查（`src/shared/video-capabilities.ts`）

| adapter | 模型 | 时长(默认) | 分辨率 | 参考图上限 | 音频 | 画幅字段 |
|---|---|---|---|---|---|---|
| wan-video | wan3.0-video | 2–30s (5) | 480P/720P/1080P | 10 | ✓ | `ratio` |
| grok-video | grok-imagine-video 等 3 | 1–15s (8) | 480p/720p/1080p | 7 | — | `aspect_ratio` |
| seedance-video | sd-2.5 / 2.0 等 4 | 4–30s (5) | 480p/720p/1080p | 30(2.5)/9(2.0) | ✓ | `ratio` |
| kling-video | kling-3.0 / turbo / omni | 3–15s (5) | 720p/1080p/4k | 4 | ✓ | `aspect_ratio` |
| minimax-video | MiniMax-H3 | 4–15s (5) | **768P/2K** | 9(+3视频+3音频) | 原生 | `ratio` |

所有视频渠道预设 baseUrl = `https://api.tiantoken.com`，`authType: bearer`。

---

### 2.1 wan-video（通义万相）

**提交**：`POST /api/v1/services/aigc/video-generation/video-synthesis`
**请求头**： bearer + `Accept` + `Content-Type` + **独有 `X-DashScope-Async: enable`**（adapters.ts:298）。

**请求体**（adapters.ts:296-321）：

```json
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "...",
    "media": [
      { "type": "first_frame", "url": "data:image/png;base64,..." },
      { "type": "reference_image", "url": "https://..." },
      { "type": "reference_video", "url": "https://..." }
    ]
  },
  "parameters": {
    "resolution": "720P",
    "ratio": "16:9",
    "duration": "5",
    "audio": true,
    "prompt_extend": true,
    "seed": 123,
    "watermark": false
  }
}
```

- `input.media[].type` 合法值：`first_frame` / `last_frame` / `reference_image` / `reference_video` / `reference_audio` / `file` / `link`（`file` 与 `link` 互斥）。media 为空时整个字段被去掉。
- **video-edit 模式不发 `duration`**（:314）；`file`/`link` 存在时**强制 `prompt_extend: true`**（:301-302）。
- 本地参考视频/音频经图床换成公网 URL 后填入；图片可用 data URI。
- 轮询：`GET /api/v1/tasks/{id}`，任务 id 可能在 `output.task_id` / `output.id`。状态取 `status` / `output.task_status` 等；失败原因 `output.code + output.message`；结果在 `output.video_url` 等。

---

### 2.2 grok-video（Grok Imagine）

**提交**：`POST /v1/videos/generations`，标准 JSON + bearer。

**请求体**（adapters.ts:322-335）：

```json
{
  "model": "grok-imagine-video-1.5",
  "prompt": "...",
  "duration": 8,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "reference_images": [{ "url": "data:image/png;base64,..." }]
}
```

- `duration` 默认 8；**无模式字段**，靠有无 `reference_images` 区分文生/图生。
- 参考图 7 张，data URI，不收参考视频/音频；不发送 seed/watermark/audio。
- 轮询：`GET /v1/videos/{id}`，任务 id 取提交响应的 `request_id`；结果用通用递归提取 `.mp4/.webm/.mov` 链接。

---

### 2.3 seedance-video（豆包 Seedance）

**提交**：`POST /api/v3/contents/generations/tasks`，标准 JSON + bearer。

**请求体**（adapters.ts:336-366）：

```json
{
  "model": "sd-2.5",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "first_frame" },
    { "type": "video_url", "video_url": { "url": "https://..." }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "data:audio/mp3;base64,..." }, "role": "reference_audio" }
  ],
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 5,
  "generate_audio": false,
  "seed": 123,
  "watermark": false
}
```

- `content[]` 三种 part：`image_url` / `video_url` / `audio_url`，各带可选 `role`（`first_frame`/`last_frame`/`reference_image`/`reference_video`/`reference_audio`）。
- `generate_audio` 默认 `false`（官方默认 true，项目刻意改掉）。
- 额度：2.0 = 图9/视频3/音频3/合计15；2.5 = 图30/视频10/音频10/合计50。
- **视频不允许内联 base64，必须公网 URL**；音频可内联 `data:audio/...`（需 ≥1.8s），参考图宽高 ≥300px。
- 图床：`https://imageproxy.zhongzhuan.chat/api/upload`，头 `New-Api-User: 1`。
- 轮询：`GET /api/v3/contents/generations/tasks/{id}`，任务 id 形如 `cgt-...`；结果在 `content.video_url`，duration 由继承逻辑补齐。

---

### 2.4 kling-video（可灵）

**提交 endpoint 由模型+模式决定**（`klingEndpoint()`，adapters.ts:224-237）：

| 场景 | endpoint |
|---|---|
| motion-control（且模型非 omni/turbo） | `/motion-control/{model}` |
| omni 模型 | `/omni-video/{model}` |
| first-frame / first-last-frame | `/image-to-video/{model}` |
| 其余 | `/text-to-video/{model}` |

- **原生格式：body 不带 `model`**，模型编码在 URL 路径里。motion-control + 4k 会抛错（最高 1080p）。

**请求体**（adapters.ts:392-459）：

```json
{
  "prompt": "...",
  "contents": [
    { "type": "image", "url": "https://..." },
    { "type": "video", "url": "https://..." }
  ],
  "settings": {
    "resolution": "720p",
    "duration": 5,
    "aspect_ratio": "16:9",
    "audio": "off",
    "multi_shot": true
  },
  "options": { "watermark_info": { "enabled": false } }
}
```

- `settings.audio`：motion-control → `"original"`/`"off"`；其余 → `"native"`/`"off"`。
- `settings.duration` motion-control 时省略；`aspect_ratio` motion-control 或非文生模式省略。
- `contents[].type`：`prompt` / `image` / `video` / `first_frame` / `last_frame` / `refer_image`（内部 `reference_image` 出网改名）。普通图生视频不接受参考图。
- 轮询：`GET /tasks?task_ids={id}`；**任务 id 必须取 `data.id`（`task_...`），不能用 `request_id`**；状态只有 `succeeded` / `failed` 为终态，结果在 `data[0].outputs[].url`。

---

### 2.5 minimax-video（MiniMax H3）

**提交**：`POST /v1/video/generations`（**单数 video**）
**请求头**：标准 JSON + bearer（`New-Api-User: 1` 可带可不带）。

**请求体**（adapters.ts:367-391）：

```json
{
  "model": "MiniMax-H3",
  "prompt": "...",
  "duration": 5,
  "images": ["<base64 或 URL>"],
  "metadata": {
    "resolution": "768P",
    "ratio": "16:9",
    "videos": ["https://..."],
    "audios": ["data:audio/mp3;base64,..."],
    "first_frame": "data:image/jpeg;base64,...",
    "last_frame": "data:image/jpeg;base64,..."
  }
}
```

- 模式由媒体推断：有尾帧 → first-last-frame；有首帧 → first-frame；有任意媒体 → reference；否则 text-to-video。
- 素材落点：参考图→顶层 `images[]`；参考视频→`metadata.videos[]`（公网 URL）；参考音频→`metadata.audios[]`（公网 URL 或 `data:audio/(mpeg|mp3|wav|x-wav|wave);base64,`）；首/尾帧→`metadata.first_frame` / `last_frame`（单值）。
- 额度：图 9 / 视频 3 / 音频 3 / 合计 12；音频必须搭配图或视频；音频 MP3/WAV、≤15MB、2–15s。音频**绝不上传图床**（图床拒收）。
- 非 reference 模式 `images/videos/audios` 为空被 compact 去掉；first-frame/first-last-frame 的 `ratio` 为 `undefined`（由图片决定），text-to-video 强制 `16:9`。
- **不发送** `generate_audio` / `seed` / `watermark` / `prompt_extend`——原生音频随画面同一次生成，`generate_audio` 不是官方参数（中转静默忽略）。
- `resolution` 默认且推荐显式 `768P`：`2K` 是 `H3-Regenerate-2K` 二次重生成，更慢更贵。
- 轮询：`GET /v1/videos/{encodeURIComponent(id)}`（**复数 videos**）；结果**只取 `metadata.url`**；状态 `queued → in_progress → completed`；进度 0/10/50/100；`completed_at` 不可信。

---

## 3. 音乐：suno-music（Suno）

### 3.1 接口与请求头

**提交**：`POST /api/queue/makeAiMusic`
**请求头**：`Accept: application/json` + `Content-Type: application/json` + `Authorization: Bearer <key>` + **`New-Api-User: 1`**（adapters.ts:460-462）。

**模型 ID**：只有一个 `suno_damobi_music`。`mv` 是请求体字段（模型版本），damobi 专用 v6 版本：`chirp-hawk`（默认）、`chirp-hawk-wild`、`chirp-goose`；老版本 `chirp-v3-5`、`chirp-crow` 等。

### 3.2 请求体（按 `musicMode` 分支，adapters.ts:463-598）

| musicMode | 关键字段 |
|---|---|
| `inspiration`（默认） | `gpt_description_prompt`、`mv`、`make_instrumental` |
| `custom`（自定义歌词） | `prompt`、`tags`、`negative_tags`、`mv`、`title`、`make_instrumental`、`metadata` |
| `cover`（翻唱） | `task:"cover"`、`prompt`、`mv`、`cover_clip_id`、`metadata` |
| `mashup`（混音） | `task:"mashup_condition"`、`generation_type:"TEXT"`、`title`、`mv`、`prompt`、`make_instrumental`、`mashup_clip_ids` |
| `sound`（音效） | `task:"sound"`、`tags`、`negative_tags`、`prompt:""`、`make_instrumental:true`、`metadata.sound_configs:{user_tempo,user_key,user_loop}` |
| `playlist`（歌单） | `task:"playlist_condition"`、`generation_type:"TEXT"`、`mv`、`prompt`、`metadata` |
| `sample`（取样） | `task:"chop_sample_condition"`、`generation_type:"TEXT"`、`mv`、`prompt`、`metadata` |

- 公共：`mode = musicMode ?? "inspiration"`；damobi 会合并 `metadata.create_mode:"custom"`，custom 模式给 `styleWeight/weirdness` 时写 `metadata.control_sliders`；给目标时长时 `duration` 放 body 顶层（只允许 45 或 60）。
- `sound_configs` 默认 `user_tempo:99`、`user_key:"C"`、`user_loop:false`。
- 长度：描述 ≤500、歌词 ≤5000、tags ≤1000、title ≤80。
- 提交前校验：custom 缺 tags、cover 缺 clip id、mashup 需两个不同 clip id → 报错。
- 所有 body 经 `compact()` 去空值并展开 `...raw`。

### 3.3 异步轮询（一次拿两首）

- 提交响应：`{ "code":200, "data":[148787578, 148787581], "success":true }`——**`data` 是两个任务 id**，本地只持久化第一个，两个都存进 `remoteMeta.suno.remoteIds`。
- 轮询：`GET /api/midjourney/drawInfo4?id={taskId}`（**路径在 midjourney 下但确实是音乐任务**，SUNO_HANDOFF.md:54）；请求头多带 `New-Api-User: 1`。
- 状态映射：`data.status` `1`=queued / `2`=running / `3`=success / `4`=fail；`data.progress` clamp 0–99；`data.errormsg` 为失败原因。
- 批量轮询器 `pollSunoBatch()` 逐个查两个 id，`expected=2`，收满即提前结束。
- 结果在 `data.extend`（**JSON 字符串**，解析为数组），只认 `track.status === "complete"` 且 URL 不以 `https://studio-api.prod.suno.com/api/forbidden` 开头（未完成的曲目 URL 就是这个，不能当成品）。
- 字段映射：`audio_url`→url、`title`、`metadata.duration`、`image_url ?? image_large_url`→封面、`metadata.prompt`→歌词、`metadata.tags`、`track.id`→clip id。
- 产物：m4a/mp3（非 WAV，不补头），上限 100MB；封面下载补 `User-Agent: Mozilla/5.0` 绕 CDN 403；远端 URL 会过期，成功即下载。

---

## 4. 语音：gemini-tts（Gemini TTS）

### 4.1 接口与请求头

**提交**：`POST /v1beta/models/{model}:generateContent`（同步，**无异步轮询**）
**请求头**：`Accept` + `Content-Type: application/json` + `Authorization: Bearer <key>`

**模型 ID**：`gemini-3.8-flash-tts`、`gemini-3.8-flash-lite-tts`、`gemini-3.1-flash-tts-preview`。

### 4.2 请求体（adapters.ts:672-724）

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "你好，世界。", "speechMetadata": { "style": "温柔" } }
    ]
  }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {
      "languageCode": "zh-CN",
      "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } }
    }
  }
}
```

**双人对话**：必须正好 2 个音色，正文按 `A：` / `B：` 切成多段：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "欢迎收听。", "speechMetadata": { "speaker": "A", "style": "轻快" } },
      { "text": "谢谢，我们开始吧。", "speechMetadata": { "speaker": "B" } }
    ]
  }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {
      "languageCode": "zh-CN",
      "multiSpeakerVoiceConfig": {
        "speakerVoiceConfigs": [
          { "speaker": "A", "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } } },
          { "speaker": "B", "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Fenrir" } } }
        ]
      }
    }
  }
}
```

- **注意字段名**：代码与测试实际输出驼峰 **`speechMetadata: { speaker, style }`**（adapters.ts:695/700、tests/tts.test.ts:39），`TTS_HANDOFF.md` 里写的 `annotations:[{type:"speech_metadata",...}]` 是旧示例，以代码为准。
- `languageCode` 为 BCP-47，`""`=自动；30 个预置音色，默认 `Kore`；无音色克隆、自定义音色、SSML、变速。
- **明确不发送** `maxOutputTokens`（会截断音频）、`speed`、`candidateCount`；不支持参考图。

### 4.3 响应与音频规格

- 结果路径：`candidates[].content.parts[].inlineData{mimeType, data}`（**base64 内联**，非 URL；兼容蛇形 `inline_data`/`mime_type`），转成 `data:audio/...;base64,...`（adapters.ts:966-1025）。
- 一次返回**一个**音频。
- 固定规格：24kHz / 16bit / 单声道。
- `gemini-3.8-*` 返回 `audio/wav`（带 WAV 头）；`gemini-3.1-flash-tts-preview` 返回 `audio/l16; rate=24000; channels=1` **裸 PCM**，代码补 44 字节 WAV 头（`pcmToWav()`，adapters.ts:938-956，小端 PCM 已实测）。
- 时长由 WAV 头 `byteRate` 与 data 块大小反算，落盘为 `.wav`。

---

## 5. 对话大脑：openai-chat（SSE 流式）

与生成渠道不同，这条是「裸的 chat completions 请求」，不走 TaskRunner（`src/server/brain.ts:6-13`）。

**接口**：`POST /v1/chat/completions`
**请求头**：`Accept: text/event-stream` + `Content-Type: application/json` + 鉴权（brain.ts:120-121）。

**请求体**（brain.ts:97-106）：

```json
{
  "model": "gpt-6.1-sol",
  "messages": [
    { "role": "system", "content": "<系统提示>" },
    { "role": "user", "content": [{ "type": "text", "text": "..." }, { "type": "image_url", "image_url": { "url": "..." } }] },
    { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "generate_image", "arguments": "{}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "成功：..." }
  ],
  "stream": true,
  "max_tokens": 16384,
  "temperature": 0.7,
  "tools": [{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { "...": "JSON Schema" } } }],
  "tool_choice": "auto"
}
```

- `stream` 恒 `true`；`max_tokens` 默认 16384（超长重试档 32768）；`temperature` 默认**不发送**（推理模型风险），显式给了才带。
- `tools` / `tool_choice` 仅在有工具时发送；`tool_choice` 默认 `"auto"`，也支持 `none` 和 `{type:"function",...}` 强制。
- **不发** top_p / n / stop / user 等其它字段。
- 工具 schema 发送前递归删除 `$schema`、`default` 装饰键（`tool-protocol.ts:30-35`）。

**SSE 解析**（brain.ts:218-294）：

- 按 `\n\n` 切块，取 `data:` 行，`[DONE]` 结束；单个事件解析失败只跳过该事件。
- 正文 `choices[0].delta.content`；推理 `delta.reasoning_content`（DeepSeek）或 `delta.reasoning`（中转别名）。
- 工具调用按 `index` 累积到 Map：`id` 写入、`name` 智能拼接（整串只给一次时替换）、`arguments` 逐片累加；`finish_reason:"tool_calls"`。
- 非 SSE 响应降级：`choices[0].message` + `parseFullToolCalls()`。
- `finish_reason:"length"` → `truncated:true`。

**工具协议降级**：400/422 且错误含 `tool_choice` → 记录不支持并不带该字段重发；含 `tools/function.call` → 不带 tools 重试并追加「本轮工具不可用」系统消息（`agent-native-turn.ts:161-171`）。部分中转把工具信封塞进 content，由 DSML 文本协议兜底解析（`provider-tool-text.ts`）。

**能力检测（虚构协议请求）**：`POST /api/channels/:id/tool-protocol`，最多 3 次请求，工具 `protocol_echo` / `protocol_nested` 为合成数据、返回的调用永不执行，用于探测 `tools` / 并行调用 / `tool_choice` / 嵌套 schema / 流式支持（`tool-protocol.ts:37-71`）。

---

## 6. 异步轮询与图床（公共链路）

### 6.1 异步轮询统一实现（tasks.ts / async-providers.ts）

| 渠道 | 轮询接口 | 任务 id 来源 | 状态成功 | 状态失败 |
|---|---|---|---|---|
| midjourney | `GET /mj/task/{id}/fetch` | 提交 `result` | `success` | `failure` |
| wan-video | `GET /api/v1/tasks/{id}` | `task_id` / `output.task_id` | 通用 | 通用 |
| grok-video | `GET /v1/videos/{id}` | `request_id` | 通用 | 通用 |
| seedance-video | `GET /api/v3/contents/generations/tasks/{id}` | `id`（`cgt-...`） | 通用 | 通用 |
| kling-video | `GET /tasks?task_ids={id}` | **`data.id`** | `succeeded` | `failed` |
| minimax-video | `GET /v1/videos/{id}` | `id` | 通用（`completed`） | 通用 |
| suno-music | `GET /api/midjourney/drawInfo4?id={id}` | `data[0]` | `success`（status 3） | `fail`（status 4） |

- 通用成功词：`succeeded, success, done, completed, complete, finished, ok`；失败词：`failed, failure, fail, error, canceled, cancelled, expired, rejected, timeout`（**不含 unknown**）。
- 状态字段优先级：`status` → `task_status` → `output.*` → `data.*` → `result.*`，统一转小写；进度取 `progress` clamp 0–99。
- 节奏：视频 `initial 20s / running 15s / near-done 6s`，窗口 20 min；MJ 默认 4s / 15 min；Suno 15s/12s/6s / 20 min。可用 `VIDEO_POLL_INTERVAL_MS` 覆盖。
- 404 → `REMOTE_TASK_NOT_FOUND`；429/408/≥500 读 `retry-after` 退避；超时 → `VIDEO_TIMEOUT` 504（可 `continue-query` 续查）。
- 服务重启后带 `remoteTaskId` 的视频任务会自动恢复轮询。
- 结果提取通用递归（adapters.ts:1031-1076）：带视频扩展名或父键匹配 `/video|url|output|result|media|download/` 的字符串，强候选（`strong`）优先。

### 6.2 图床上传（本地视频/音频换公网 URL）

**上游接口**：`POST <channel.uploadEndpoint>`，预设为 `https://imageproxy.zhongzhuan.chat/api/upload`

| 项 | 值 |
|---|---|
| 请求头 | `Authorization: Bearer <key>` + `channel.uploadHeaders`（如 `New-Api-User: 1`，禁覆盖 authorization/cookie/host/content-type） |
| form field | `file` = `Blob(buffer, {type:mimetype})` + 安全文件名 |
| 超时 / 重定向 | 180s / manual |
| 返回 URL | 响应 JSON 顶层 `url`（校验 `https?://`） |

- 视频 ≤100MB 且需 ftyp box；音频 MP3/M4A/AAC/WAV、magic bytes 校验、≤15MB。
- 落点：wan→`wanVideoMedia`（type `reference_video`）；kling→`klingVideoMedia`（type `video`）；minimax→`minimaxVideoMedia`（type `video`，音频不走图床）；seedance→`seedanceVideoMedia`（type `video_url`）。
- 应用本地入口：`POST /api/generations/reference-video`（字段 `file`）、`POST /api/generations/reference-media`（字段 `video`/`audio`）。

### 6.3 公共预算与校验

- 视频内联素材总预算 `MAX_INLINE_MEDIA_CHARS = 40 MiB 字符`（≈30MB 二进制），只对 `data:` 开头的 url 计数；单条 URL 上限 = 总预算 + 4MiB（留余量让超预算走到中文报错而非 zod 提前拦截）。**该预算只管视频素材数组，生图参考图按张计（20MiB/张）。**
- 网关实测：`client_max_body_size ≈ 50 MiB`（50MiB 通过、51MiB 起 413）。
- 提示词上限 20000（路由 zod）；MiniMax 能力上限 7000。
- 画幅归一：按渠道 `ratioField` 在 `aspectRatio`/`ratio` 间互转，`adaptive` 传给不认的渠道时丢弃。
- 诊断脱敏：base64 缩略为 `[IMAGE_DATA n bytes]`；URL 的 key/api_key/token 与头里的 authorization/api-key/token/secret 打码为 `[REDACTED]`。

---

## 7. 预设渠道与密钥变量（v2.4.3）

`src/shared/provider-presets.ts:98-325`，全部 `baseUrl: https://api.tiantoken.com`、`authType: bearer`：

| id | 名称 | adapterType | secretEnv |
|---|---|---|---|
| tiantoken-gpt | 词元流墟-gpt生图 | openai-images | TIANTOKEN_GPT_API_KEY |
| tiantoken-gpt-c | 词元流墟-gpt-c生图 | openai-images | TIANTOKEN_GPT_C_API_KEY |
| tiantoken-gemini | 词元流墟-gemini生图 | gemini-content | TIANTOKEN_GEMINI_API_KEY |
| tiantoken-midjourney | 词元流墟-Midjourney | midjourney | TIANTOKEN_MIDJOURNEY_API_KEY |
| tiantoken-wan-video | 词元流墟-万相视频 | wan-video | TIANTOKEN_WAN_VIDEO_API_KEY |
| tiantoken-grok-video | 词元流墟-grok视频 | grok-video | TIANTOKEN_GROK_VIDEO_API_KEY |
| tiantoken-seedance | 词元流墟-seedance视频 | seedance-video | TIANTOKEN_SEEDANCE_VIDEO_API_KEY |
| tiantoken-kling-video | 词元流墟-可灵视频 | kling-video | TIANTOKEN_KLING_VIDEO_API_KEY |
| tiantoken-minimax-video | 词元流墟-MiniMax视频 | minimax-video | TIANTOKEN_MINIMAX_VIDEO_API_KEY |
| tiantoken-suno | 词元流墟-音乐 | suno-music | TIANTOKEN_SUNO_API_KEY |
| tiantoken-gemini-tts | 词元流墟-语音 | gemini-tts | TIANTOKEN_GEMINI_TTS_API_KEY |
| tiantoken-chat | 词元流墟-对话模型 | openai-chat | TIANTOKEN_CHAT_API_KEY |

- 其中 #5/#7/#8/#9 带 `uploadEndpoint` 与 `uploadHeaders: {New-Api-User: 1}`。
- 另有向量引擎 `api.vectorengine.cn` 的 gpt / gpt-c / gemini 生图预设。
- **一 Key 模式**（`ONE_KEY_PRESET`）：`singleKey: true`、`sharedSecretEnv: TIANTOKEN_API_KEY`，把上述 12 个单元全部用同一个 Key 建渠道；该预设刻意不放进 `PROVIDER_PRESETS`，避免站点卡片重复。

---

## 8. 容易踩的「名实不符」清单

1. **Suno 轮询路径**字面是 `/api/midjourney/drawInfo4`，实际是音乐任务接口。
2. **TTS 风格字段**：代码用驼峰 `speechMetadata`，交接文档的 `annotations:[{type:"speech_metadata"}]` 是旧示例。
3. **`openai-content` 不存在**：README 的「OpenAI Chat Image」= `openai-chat-image`。
4. **可灵 body 不带 `model`**：模型编码在 URL 路径中，且提交与轮询端点完全不同。
5. **MiniMax 提交 `/v1/video/generations`（单数）、轮询 `/v1/videos/{id}`（复数）**，别写混。
6. **Midjourney 任务 id 在 `result` 字段**，不是 `data`；提交响应无 `model` 字段。
7. **Suno 提交的两个 id 不是 `custom_id`**，真正的 `custom_id` 在轮询结果 `extend[].id`。
8. **预设数量源码为 12 个**（含 `tiantoken-chat`），README 写的「11 个站点预设」未计入对话渠道。
9. **`temperature` 在对话请求默认不发送**；`max_tokens` 默认发送 16384。

---

*本文档由源码提取生成（v2.4.3）。上游中转站可能对字段做静默忽略或改造，最终以任务诊断里的真实请求/响应为准。*
