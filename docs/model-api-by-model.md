# 模型请求接口 · 按模型名速查

> 本文按**模型名（model ID）**逐个列出 ChatCanvas 调用上游时的接口、请求头和请求体格式。
> 与 [按适配器组织的协议详解](model-api-reference.md) 互补：那份讲协议原理和公共链路，这份按模型名直接查某个具体模型怎么调。
> 模型名单来自 `src/shared/provider-presets.ts`（v2.4.3，共 41 个预设模型 + 1 个隐藏模型）。所有请求都是 `POST`，baseURL 相对用户配置的渠道地址，鉴权默认 `Authorization: Bearer <key>`。

---

## 通用请求头与鉴权（每个模型都适用）

| 头 | 值 |
|---|---|
| `Accept` | `application/json`（对话模型为 `text/event-stream`） |
| `Content-Type` | JSON 请求体为 `application/json`；multipart 分支不手动设置（由 fetch 自动带 boundary） |
| `Authorization` | `Bearer <key>`（内置预设全部为 bearer；自定义渠道可改 x-api-key / query 等） |

- URL = `joinEndpoint(baseUrl, endpoint)`；`{model}` 占位符用 `encodeURIComponent(model)` 替换。
- 每个请求体末尾都可展开渠道里配置的**高级 JSON `raw`**，优先级高于内置字段，可覆盖任何字段（含 `model`、`prompt`）。
- 内置模型均由**词元流墟**（`https://api.tiantoken.com`）预设提供；向量引擎（`api.vectorengine.cn`）等站点通过「自定义 Base URL」配置，模型名自由填写，请求格式由所选适配器决定，与下表同协议族一致。

---

## 模型名总览

| 用途 | 模型名 | 适配器 | 提交接口 | 模态 |
|---|---|---|---|---|
| 生图 | `gpt-image-2`、`-2.5-sunburst`、`-2.5-flare`、`-2.6-flare`、`-2.6-sunburst` | openai-images | `/v1/images/generations` | 同步 |
| 生图 | `gpt-image-2-c`、`-2.5-sunburst-c`、`-2.5-flare-c`、`-2.6-flare-c`、`-2.6-sunburst-c` | openai-images | 同上 | 同步 |
| 生图 | `gemini-3.1-flash-image`、`-preview`、`-lite-image`、`gemini-3-pro-image`、`-preview`、`gemini-nano-banana-2.1`、`-preview` | gemini-content | `/v1beta/models/{model}:generateContent` | 同步 |
| 生图 | `mj_imagine`（+ 隐藏 `mj_edits`） | midjourney | `/mj/submit/imagine` | 异步 |
| 生图 | `mj_upscale`、`mj_variation`、`mj_reroll` | midjourney | `/mj/submit/action` | 异步 |
| 视频 | `wan3.0-video` | wan-video | `/api/v1/services/aigc/video-generation/video-synthesis` | 异步 |
| 视频 | `grok-imagine-video`、`-1.5-preview`、`-1.5` | grok-video | `/v1/videos/generations` | 异步 |
| 视频 | `sd-2.5`、`sd-2.0`、`sd-2.0-fast`、`sd-2.0-mini` | seedance-video | `/api/v3/contents/generations/tasks` | 异步 |
| 视频 | `kling-3.0`、`kling-3.0-turbo`、`kling-3.0-omni` | kling-video | 按模型/模式动态（见下） | 异步 |
| 视频 | `MiniMax-H3` | minimax-video | `/v1/video/generations` | 异步 |
| 音乐 | `suno_damobi_music` | suno-music | `/api/queue/makeAiMusic` | 异步（双任务） |
| 语音 | `gemini-3.8-flash-tts`、`gemini-3.8-flash-lite-tts`、`gemini-3.1-flash-tts-preview` | gemini-tts | `/v1beta/models/{model}:generateContent` | 同步 |
| 对话 | `deepseek-v4.1-flash-1017`、`gemini-3.8-flash`、`gpt-6.1-sol`、`claude-sonnet-5-5` | openai-chat | `/v1/chat/completions` | SSE 流式 |

---

# 一、生图模型

## gpt-image-2

- **适配器**：`openai-images` ｜ **提交**：`POST /v1/images/generations`（无参考图）/ `POST /v1/images/edits`（有参考图）
- **请求头**：`Accept` + `Content-Type: application/json`（有参考图时不设）+ `Authorization: Bearer <key>`
- **无参考图请求体**（JSON）：

```json
{
  "model": "gpt-image-2",
  "prompt": "一只坐在月球上的猫",
  "size": "1024x1024",
  "n": 1,
  "quality": "auto",
  "output_format": "png",
  "background": "auto",
  "moderation": "auto",
  "response_format": "url",
  "style": "auto",
  "stream": false
}
```

- **有参考图请求体**（`multipart/form-data`，自动切 `/v1/images/edits`）：

| form field | 编码 |
|---|---|
| `model` / `prompt` / 上述各参数 / `...raw` | 字符串：数值布尔 `String(v)`、对象数组 `JSON.stringify(v)` |
| `image`（1 张）/ `image[]`（多张，重复 append） | **二进制文件 part**：`Blob(bytes,{type:mime})` + 原始文件名（非 base64） |
| `mask` | `Blob(bytes,{type:"image/png"})`，文件名强制 `.png`，仅 1 张参考图时生效 |

- **参考图额度**：16 张（gpt-image-2 / 2.5 / 2.6 全系列），单张 ≤20 MiB。
- **特殊**：`negative_prompt` 对 `gpt-image-*` 模型不发送（模型不支持）。
- **响应**：递归提取 `b64_json` / `url` / `image_url.url` / data URI / Markdown 图片链接；GIF sprite 超 2304×2304 直接拒。

## gpt-image-2.5-sunburst

同 `gpt-image-2`，仅 `model` 值为 `"gpt-image-2.5-sunburst"`。接口、请求头、请求体字段、16 张参考图额度完全一致。

## gpt-image-2.5-flare

同 `gpt-image-2`，仅 `model` 值为 `"gpt-image-2.5-flare"`。

## gpt-image-2.6-flare

同 `gpt-image-2`，仅 `model` 值为 `"gpt-image-2.6-flare"`。`edits` 请求支持 `output_format:"gif"`，保存/下载保留 `.gif`；gif 时额外发 `frame_count`（默认 9）与 `frame_duration_ms`（默认 200）。

## gpt-image-2.6-sunburst

同 `gpt-image-2.6-flare`，`model` 为 `"gpt-image-2.6-sunburst"`。

## gpt-image-2-c 系列（5 个）

- `gpt-image-2-c`、`gpt-image-2.5-sunburst-c`、`gpt-image-2.5-flare-c`、`gpt-image-2.6-flare-c`、`gpt-image-2.6-sunburst-c`
- **适配器**：`openai-images`，请求格式与上面标准 gpt 系列**完全相同**（含 16 张参考图、gift 帧参数），仅 `model` 名带 `-c` 后缀。
- **区别在渠道层**：`-c` 系列是独立计费、独立密钥的渠道，不与标准 gpt 渠道混用。

## gemini-3.1-flash-image

- **适配器**：`gemini-content` ｜ **提交**：`POST /v1beta/models/gemini-3.1-flash-image:generateContent`
- **请求头**：`Accept` + `Content-Type: application/json` + `Authorization: Bearer <key>`（也可用 `x-goog-api-key`）
- **请求体**：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "inlineData": { "mimeType": "image/png", "data": "<裸 base64，无 data: 前缀>" } },
      { "text": "把背景换成星空" }
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
  }
}
```

- `inlineData` 在前、`text` 在后；有 `negativePrompt` 时拼进 text：`"<prompt>\n\nNegative prompt: <...>"`。
- `imageSize` 缺失时服务端补默认 `"2K"`（缺失会触发上游 400 `Unsupported resolution`）。
- **参考图额度**：14 张，单张 ≤20 MiB。
- **响应**：`candidates[].content.parts[].inlineData.data`（裸 base64），落盘时按字节头二次校正 MIME。

## gemini-3.1-flash-image-preview / gemini-3.1-flash-lite-image / gemini-3-pro-image / gemini-3-pro-image-preview / gemini-nano-banana-2.1 / gemini-nano-banana-2.1-preview

- 同 `gemini-3.1-flash-image`，仅 URL 路径和请求体中的 `model` 名不同（`-preview` 后缀模型在参考图额度匹配时会归一化）。请求体字段、参考图编码（裸 base64 inlineData）、响应解析完全一致。

## mj_imagine

- **适配器**：`midjourney` ｜ **提交**：`POST /mj/submit/imagine`（有参考图自动切 `/mj/submit/edits`）
- **请求头**：`Accept` + `Content-Type: application/json` + `Authorization: Bearer <key>`
- **请求体**（JSON，**没有 `model` 字段**，画幅/版本/排除词写进 prompt）：

```json
{
  "prompt": "一只戴墨镜的猫 --ar 16:9 --v 6 --no blurry",
  "image": "data:image/png;base64,..."
}
```

  - `--ar` ← `aspectRatio`（≠auto 且 prompt 未写时追加）；`--v` ← `midjourneyVersion`；`--no` ← `negativePrompt`。不写 `--v` 时网关自动补 `--v 8.2`。
  - 有参考图时 `image` 为**单张** data URI（`base64Array` 会被上游当成没传图）；额度 1 张。
- **提交响应**：`{ "code":1, "result":"<任务id>" }`——任务 id 在 `result` 字段。
- **轮询**：`GET /mj/task/{id}/fetch`，状态 `success`/`failure`，结果 `imageUrl`；取图 `GET /mj/image/{id}`（同 host 重放 Bearer）。

## mj_edits（隐藏模型）

- 图生图模型，**界面不展示**。模型名为 `mj_edits`，有参考图时由 midjourney 适配器内部使用；无参考图会报错。提交路径 `/mj/submit/edits`，body 为 `{prompt, image, ...raw}`。

## mj_upscale / mj_variation / mj_reroll

- **动作模型**，走 `POST /mj/submit/action`，不是文生图。
- **请求体**：`{ "taskId": "<父任务id>", "customId": "<按钮customId>", "...raw": {} }`
- `customId` 必须来自父任务轮询返回的 `buttons` 字段；服务端按 `midjourneyModelForCustomId()` 映射为具体动作模型。历史坑：用 chat completions 调 `mj_reroll` 返回 404，必须用 action 端点。

---

# 二、视频模型

## wan3.0-video

- **适配器**：`wan-video` ｜ **提交**：`POST /api/v1/services/aigc/video-generation/video-synthesis`
- **请求头**：`Authorization: Bearer <key>` + `Accept` + `Content-Type: application/json` + **`X-DashScope-Async: enable`**
- **请求体**：

```json
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "一只猫走过街道",
    "media": [
      { "type": "first_frame", "url": "data:image/png;base64,..." },
      { "type": "reference_image", "url": "https://..." },
      { "type": "reference_video", "url": "https://..." }
    ]
  },
  "parameters": {
    "resolution": "720P", "ratio": "16:9", "duration": "5",
    "audio": true, "prompt_extend": true, "seed": 123, "watermark": false
  }
}
```

- `media[].type`：`first_frame`/`last_frame`/`reference_image`/`reference_video`/`reference_audio`/`file`/`link`（`file` 与 `link` 互斥）；media 为空则整个字段去掉。
- video-edit 模式**不发 `duration`**；`file`/`link` 模式强制 `prompt_extend:true`。七种生成模式共用这套结构。
- **额度**：参考图 ≤10；时长 2–30s（默认 5）；分辨率 480P/720P/1080P。
- **轮询**：`GET /api/v1/tasks/{id}`，任务 id 可能在 `output.task_id`；结果 `output.video_url`。

## grok-imagine-video

- **适配器**：`grok-video` ｜ **提交**：`POST /v1/videos/generations`
- **请求头**：标准三件套（`Accept` + `Content-Type` + Bearer）
- **请求体**：

```json
{
  "model": "grok-imagine-video",
  "prompt": "海浪拍打岩石",
  "duration": 8,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "reference_images": [{ "url": "data:image/png;base64,..." }]
}
```

- `duration` 默认 8；**无模式字段**，靠有无 `reference_images` 区分文生/图生。参考图 7 张，不收参考视频/音频；不发 seed/watermark/audio。
- **轮询**：`GET /v1/videos/{id}`，任务 id 取提交响应的 `request_id`。

## grok-imagine-video-1.5-preview / grok-imagine-video-1.5

同 `grok-imagine-video`，仅 `model` 名不同，请求格式一致。

## sd-2.5

- **适配器**：`seedance-video` ｜ **提交**：`POST /api/v3/contents/generations/tasks`
- **请求头**：标准三件套
- **请求体**：

```json
{
  "model": "sd-2.5",
  "content": [
    { "type": "text", "text": "一只猫奔跑" },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "first_frame" },
    { "type": "video_url", "video_url": { "url": "https://..." }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "data:audio/mp3;base64,..." }, "role": "reference_audio" }
  ],
  "resolution": "720p", "ratio": "16:9", "duration": 5,
  "generate_audio": false, "seed": 123, "watermark": false
}
```

- `content[]` 三种 part：`image_url`/`video_url`/`audio_url`，各带可选 `role`（`first_frame`/`last_frame`/`reference_image`/`reference_video`/`reference_audio`）。
- `generate_audio` 默认 `false`（官方默认 true，本项目刻意改掉）。
- **额度**：2.5 = 图30/视频10/音频10/合计50；视频**不允许内联 base64（必须公网 URL）**，音频可内联 `data:audio/...`；首尾帧模式 ratio 锁 `adaptive`。
- **轮询**：`GET /api/v3/contents/generations/tasks/{id}`，任务 id 形如 `cgt-...`，结果 `content.video_url`。

## sd-2.0 / sd-2.0-fast / sd-2.0-mini

同 `sd-2.5`，仅 `model` 名不同。**额度不同**：2.0 系列 = 图9/视频3/音频3/合计15。

## kling-3.0

- **适配器**：`kling-video` ｜ **提交路径按模式动态**（model 经 URL 编码，**body 不带 `model`**）：

| 场景 | 提交 endpoint |
|---|---|
| text-to-video | `/text-to-video/{model}` |
| first-frame / first-last-frame | `/image-to-video/{model}` |
| omni 模型 | `/omni-video/{model}` |
| motion-control | `/motion-control/{model}` |

- **请求头**：标准三件套
- **请求体**：

```json
{
  "prompt": "一只猫走进城市",
  "contents": [
    { "type": "image", "url": "https://..." },
    { "type": "video", "url": "https://..." }
  ],
  "settings": {
    "resolution": "720p", "duration": 5, "aspect_ratio": "16:9",
    "audio": "off", "multi_shot": true
  },
  "options": { "watermark_info": { "enabled": false } }
}
```

- `contents[].type`：`prompt`/`image`/`video`/`first_frame`/`last_frame`/`refer_image`；普通图生视频不接受参考图。
- `settings.audio`：普通模式 `"native"`/`"off"`，运动控制 `"original"`/`"off"`；运动控制+4k 会报错（最高 1080p）。
- **额度**：参考图 ≤4；时长 3–15s；分辨率 720p/1080p/4k。
- **轮询**：`GET /tasks?task_ids={id}`，任务 id **必须取 `data.id`**（不是 `request_id`），结果 `data[0].outputs[].url`。

## kling-3.0-turbo

- 同 `kling-3.0`，`model` 为 `kling-3.0-turbo`。开放文生/首帧/首尾帧（无参考、无运动控制）。

## kling-3.0-omni

- 同 `kling-3.0`，`model` 为 `kling-3.0-omni`。走 `/omni-video/{model}` 端点，支持参考图（≤4）。

## MiniMax-H3

- **适配器**：`minimax-video` ｜ **提交**：`POST /v1/video/generations`（**单数 video**）
- **请求头**：标准三件套（`New-Api-User: 1` 可带可不带）
- **请求体**：

```json
{
  "model": "MiniMax-H3",
  "prompt": "一只猫在雨中",
  "duration": 5,
  "images": ["<base64 或 URL>"],
  "metadata": {
    "resolution": "768P", "ratio": "16:9",
    "videos": ["https://..."],
    "audios": ["data:audio/mp3;base64,..."],
    "first_frame": "data:image/jpeg;base64,...",
    "last_frame": "data:image/jpeg;base64,..."
  }
}
```

- 模式由媒体推断：有尾帧→首尾帧、有首帧→首帧、有媒体→参考、否则文生。参考图→顶层 `images[]`；参考视频→`metadata.videos[]`（公网）；参考音频→`metadata.audios[]`（公网或 `data:audio/...`）；首/尾帧→`metadata.first_frame`/`last_frame`。
- **额度**：图9/视频3/音频3/合计12；音频必须搭配图或视频、≤15MB、2–15s，且**不走图床**。
- `resolution` 默认 768P；**不发送** `generate_audio`/`seed`/`watermark`/`prompt_extend`（原生音频随画面同生成，`generate_audio` 非官方参数）。
- **轮询**：`GET /v1/videos/{id}`（**复数 videos**），结果**只取 `metadata.url`**，状态 `queued→in_progress→completed`。

---

# 三、音乐模型

## suno_damobi_music

- **适配器**：`suno-music` ｜ **提交**：`POST /api/queue/makeAiMusic`
- **请求头**：`Accept` + `Content-Type: application/json` + `Authorization: Bearer <key>` + **`New-Api-User: 1`**
- **请求体按 `musicMode` 分支**（公共开关：`mode = musicMode ?? "inspiration"`，damobi 合并 `metadata.create_mode:"custom"`）：

| musicMode | 关键字段 |
|---|---|
| `inspiration`（默认） | `gpt_description_prompt`、`mv`、`make_instrumental` |
| `custom` | `prompt`、`tags`、`negative_tags`、`mv`、`title`、`make_instrumental` |
| `cover` | `task:"cover"`、`prompt`、`mv`、`cover_clip_id`、`metadata` |
| `mashup` | `task:"mashup_condition"`、`generation_type:"TEXT"`、`title`、`mv`、`prompt`、`make_instrumental`、`mashup_clip_ids` |
| `sound` | `task:"sound"`、`tags`、`prompt:""`、`make_instrumental:true`、`metadata.sound_configs:{user_tempo,user_key,user_loop}` |
| `playlist` | `task:"playlist_condition"`、`generation_type:"TEXT"`、`mv`、`prompt`、`metadata` |
| `sample` | `task:"chop_sample_condition"`、`generation_type:"TEXT"`、`mv`、`prompt`、`metadata` |

- `mv` 是模型版本（不是 model ID）：damobi v6 用 `chirp-hawk`（默认）/`chirp-hawk-wild`/`chirp-goose`；老版本 `chirp-v3-5`/`chirp-crow` 等。damobi 可在 body 顶层带 `duration`（仅 45 或 60）。
- 长度：描述 ≤500、歌词 ≤5000、tags ≤1000、title ≤80。
- **提交响应**：`{ "code":200, "data":[<任务id1>, <任务id2>] }`——一次两首。
- **轮询**：`GET /api/midjourney/drawInfo4?id={id}`（路径在 midjourney 下但确是音乐），状态 1=排队/2=生成/3=成功/4=失败；结果在 `data.extend`（JSON 字符串），只认 `status==="complete"` 的 track，字段 `audio_url`/`title`/`image_url`/`metadata.prompt`/`metadata.tags`。产物为 m4a/mp3（非 WAV）。

---

# 四、语音模型

## gemini-3.8-flash-tts

- **适配器**：`gemini-tts` ｜ **提交**：`POST /v1beta/models/gemini-3.8-flash-tts:generateContent`（**同步，无轮询**）
- **请求头**：`Accept` + `Content-Type: application/json` + `Authorization: Bearer <key>`
- **请求体（单人）**：

```json
{
  "contents": [{
    "role": "user",
    "parts": [{ "text": "欢迎收听本期节目。", "speechMetadata": { "style": "温柔" } }]
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

- **请求体（双人）**：`parts` 按 `A：`/`B：` 切成多段，每段带 `speechMetadata:{speaker,style}`；`speechConfig` 改用 `multiSpeakerVoiceConfig.speakerVoiceConfigs`（两个音色）。
- **注意**：风格/speaker 字段是驼峰 **`speechMetadata`**（HANDOFF 里的 `annotations` 是旧示例，以代码为准）。不发 `maxOutputTokens`（截断音频）、`speed`、`candidateCount`；不支持参考图。
- **响应**：`candidates[].content.parts[].inlineData.data`（base64），一次一个音频。
- **输出**：24kHz/16bit/单声道 WAV；3.8 系列直接返回 `audio/wav`（已带头）。

## gemini-3.8-flash-lite-tts

同 `gemini-3.8-flash-tts`，仅 `model` 名不同（URL 路径与生成无关，请求体不含 model 字段）。

## gemini-3.1-flash-tts-preview

同 `gemini-3.8-flash-tts`，仅模型名不同。**差异**：非流式返回 `audio/l16; rate=24000; channels=1` 裸 PCM，服务端补 44 字节 WAV 头（`pcmToWav`）。

---

# 五、对话模型

## deepseek-v4.1-flash-1017

- **适配器**：`openai-chat`（对话大脑，不走 TaskRunner）｜ **提交**：`POST /v1/chat/completions`
- **请求头**：`Accept: text/event-stream` + `Content-Type: application/json` + `Authorization: Bearer <key>`
- **请求体**：

```json
{
  "model": "deepseek-v4.1-flash-1017",
  "messages": [
    { "role": "system", "content": "<系统提示>" },
    { "role": "user", "content": [{ "type": "text", "text": "..." }] },
    { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_1", "type": "function", "function": { "name": "generate_image", "arguments": "{}" } }
    ] },
    { "role": "tool", "tool_call_id": "call_1", "content": "成功：..." }
  ],
  "stream": true,
  "max_tokens": 16384,
  "tools": [{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {} } }],
  "tool_choice": "auto"
}
```

- `stream` 恒 true；`max_tokens` 默认 16384（超长重试 32768）；`temperature` 默认**不发送**（推理模型风险）；`tools`/`tool_choice` 仅有工具时发。
- **SSE 解析**：`data:` 行、`[DONE]` 结束；正文 `delta.content`，推理 `delta.reasoning_content`（或别名 `delta.reasoning`）；工具调用按 `index` 累积 `id`/`name`/`arguments`。
- 工具协议降级：400/422 且错误含 `tool_choice` → 去掉该字段重发；含 `tools` → 不带 tools 重试。

## gemini-3.8-flash / gpt-6.1-sol / claude-sonnet-5-5

同 `deepseek-v4.1-flash-1017`，仅 `model` 名不同。请求体字段、SSE 流式解析、工具调用协议完全一致。**实际可用性以所配渠道和密钥分组为准**（预设仅给出模板）。

---

## 附：能力检测（虚构请求，非模型调用）

`POST /api/channels/:id/tool-protocol` 会用合成工具 `protocol_echo` / `protocol_nested` 发最多 3 次请求，返回的调用永不执行，用于探测该渠道模型的 `tools` / 并行调用 / `tool_choice` / 嵌套 schema / 流式支持。仅发送虚构数据，按渠道计费。

---

*本文档按模型名整理自源码（v2.4.3）。同族模型已标明复用关系；上游中转站可能静默忽略或改造字段，最终以任务诊断里的真实请求/响应为准。协议原理与公共链路见 [按适配器组织的详解](model-api-reference.md)。*
