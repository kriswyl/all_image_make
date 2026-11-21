# 万相 3.0 视频（wan3.0-video）接入 API



> - 模型 ID：`wan3.0-video`
> - 适配器：`wan-video`（通义万相）
> - 内置渠道：`tiantoken-wan-video`「词元流墟-万相视频」
> - Base URL：`https://api.tiantoken.com`
> - 鉴权：`Authorization: Bearer <key>`（env `TIANTOKEN_WAN_VIDEO_API_KEY`）

---

## 1. 接口一览

| 步骤       | 方法     | 路径                                                       | 说明                                 |
| -------- | ------ | -------------------------------------------------------- | ---------------------------------- |
| 提交任务     | `POST` | `/api/v1/services/aigc/video-generation/video-synthesis` | 提交生成，**必须异步头**                     |
| 轮询任务     | `GET`  | `/api/v1/tasks/{task_id}`                                | 查状态、取视频 URL                        |
| 上传素材（可选） | `POST` | `https://imageproxy.zhongzhuan.chat/api/upload`          | 本地视频/音频换公网 URL，头 `New-Api-User: 1` |

所有 URL 都相对渠道 Base URL，用 `joinEndpoint(baseUrl, endpoint)` 拼接。请求体可叠加渠道里配置的
**高级 JSON `raw`**，它优先级最高，能覆盖任何内置字段（含 `model`、`prompt`、`parameters.*`）。

---

## 2. 提交任务

### 2.1 请求头

| 头                   | 值                  | 说明                            |
| ------------------- | ------------------ | ----------------------------- |
| `Authorization`     | `Bearer <key>`     | 渠道密钥                          |
| `Accept`            | `application/json` | —                             |
| `Content-Type`      | `application/json` | —                             |
| `X-DashScope-Async` | `enable`           | **万相独有且必填**。不启用异步，出片慢时上游会直接超时 |

源码：`src/server/adapters.ts` 中 `headers["X-DashScope-Async"] = "enable"`（:299-300）。

### 2.2 请求体结构

```jsonc
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "一只猫走过街道",       // 空字符串会被 compact 去掉
    "media": [                        // 无素材时整个 media 字段去掉
      { "type": "first_frame",       "url": "data:image/png;base64,..." },
      { "type": "reference_image",   "url": "https://example.com/ref.png" },
      { "type": "reference_video",   "url": "https://example.com/clip.mp4" }
    ]
  },
  "parameters": {
    "resolution": "720P",             // 480P / 720P / 1080P
    "ratio": "16:9",                  // 画幅，字段名叫 ratio
    "duration": "5",                  // 秒，2–30，默认 5；video-edit 模式不发
    "audio": true,                    // 是否生成音频
    "prompt_extend": true,            // 智能扩写；file/link 模式强制 true
    "seed": 123,                      // 随机种子
    "watermark": false                // 是否打水印
  }
}
```

> `input` 与 `parameters` 都经过 `compact()`：值为 `undefined` / `""` 的字段被剔除，
> 所以空 prompt 不会发出、无素材不会带空的 `media`。

### 2.3 parameters 字段说明

| 字段              | 类型      | 取值 / 默认                                           | 备注                                         |
| --------------- | ------- | ------------------------------------------------- | ------------------------------------------ |
| `resolution`    | string  | `480P` / `720P` / `1080P`，默认 `720P`               | 大小写敏感，大写 P                                 |
| `ratio`         | string  | `adaptive`、`21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16` | 画幅字段名是 `ratio`，不是 `aspect_ratio`           |
| `duration`      | string  | `2`–`30`，默认 `5`                                   | **video-edit（视频编辑）模式不带此字段**，带了上游当参数错误      |
| `audio`         | boolean | 默认 `true`                                         | 是否生成音频                                     |
| `prompt_extend` | boolean | 可选                                                | 智能扩写提示词；传 `file` / `link` 素材时**强制 `true`** |
| `seed`          | number  | 可选                                                | 随机种子，便于复现                                  |
| `watermark`     | boolean | 可选                                                | 是否加水印                                      |

能力定义来源：`src/shared/video-capabilities.ts` 的 `VIDEO_CAPABILITIES["wan-video"]`：
参考图上限 10、时长 2–30（默认 5）、分辨率 480P/720P/1080P、支持音频/种子/水印/智能扩写/智能时长。

---

## 3. 素材 media 详解

`input.media[]` 每项为 `{ "type": ..., "url": ... }`。`url` 可以是公网 URL、OSS 临时 URL；
图片和音频还可以用 data URI（`data:image/...;base64,...`）。

### 3.1 合法 type

| type              | 含义             | 典型来源                   |
| ----------------- | -------------- | ---------------------- |
| `first_frame`     | 首帧图            | 本地图片上传 / data URI      |
| `last_frame`      | 尾帧图            | 本地图片上传 / data URI      |
| `reference_image` | 参考图（可多张，上限 10） | 本地图片 / 公网 URL          |
| `reference_video` | 参考视频           | 本地视频经图床换公网 URL         |
| `reference_audio` | 参考音频           | 本地音频，data URI / 公网 URL |
| `file`            | 参考文件           | 服务端直连（Agent / 画布 / 脚本） |
| `link`            | 参考链接           | 服务端直连                  |

- `file` 与 `link` **互斥**，不会同时出现。
- media 为空时不发该字段。
- 本地参考视频/音频要先经图床（`https://imageproxy.zhongzhuan.chat/api/upload`）换成公网 URL；
  图片可直接用 data URI。
- `oss://` 开头的 URL 在 `wan-video` 渠道下会被接受。
- 参考图有缩放策略（`videoReferenceImagePolicy("wan-video", model).minEdge`），
  接近内联预算时前端会先压缩再传。

源码：`src/shared/types.ts` 的 `VideoMediaType` / `VideoMediaInput`（:67-80）、
`src/server/adapters.ts` 的 `buildWanMedia`（:114-124）、
`src/client/video/media-builders.ts` 的 `buildWanMedia`（:40-61）。

### 3.2 七种生成模式

| 模式 ID              | 名称      | 需要的素材                                | duration 可调 | 特殊规则                      |
| ------------------ | ------- | ------------------------------------ | ----------- | ------------------------- |
| `text-to-video`    | 文生视频    | 无（仅 prompt）                          | 是           | —                         |
| `first-frame`      | 首帧生视频   | 1 张 `first_frame`                    | 是           | —                         |
| `first-last-frame` | 首尾帧生视频  | `first_frame` + `last_frame`         | 是           | 第 1 张首帧、第 2 张尾帧           |
| `reference`        | 参考生视频   | 最多 10 张 `reference_image`，可搭配参考视频/音频 | 是           | 提示词里用 `@` 引用素材            |
| `video-edit`       | 视频编辑    | 1 段 `reference_video`                | **否**       | 不发 `duration`             |
| `video-extend`     | 视频延长    | 1 段 `reference_video`                | 是           | 输入+输出总时长 ≤30s             |
| `file-to-video`    | 参考文件生视频 | 1 个 `file` / `link`                  | 是           | `prompt_extend` 强制 `true` |

模式清单真相在 `src/shared/video-modes.ts` 的 `WAN_MODE_SPECS` 与
`src/shared/types.ts` 的 `WanVideoMode`（:150-157）。前端按素材实际组合把「提示词 / 帧」两个合并入口
解析成这七种具体模式；服务端在任务创建时按同一张表校验，防止绕过界面提交。

**各模式请求体示例：**

文生视频：

```json
{
  "model": "wan3.0-video",
  "input": { "prompt": "一只猫走过街道" },
  "parameters": { "resolution": "720P", "ratio": "16:9", "duration": "5" }
}
```

首尾帧生视频：

```json
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "让画面动起来",
    "media": [
      { "type": "first_frame", "url": "data:image/png;base64,..." },
      { "type": "last_frame",  "url": "data:image/png;base64,..." }
    ]
  },
  "parameters": { "resolution": "720P", "ratio": "16:9", "duration": "5" }
}
```

视频编辑（注意没有 `duration`）：

```json
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "改成赛博朋克风格",
    "media": [{ "type": "reference_video", "url": "https://example.com/clip.mp4" }]
  },
  "parameters": { "resolution": "720P", "ratio": "16:9" }
}
```

---

## 4. 异步轮询

万相是异步接口。提交成功后拿到任务 id，再轮询到出片。

### 4.1 提交响应与任务 id

提交响应里任务 id 可能在多个位置，按如下优先级提取（`extractRemoteTaskId`）：

```
task_id  →  data (string)  →  data[0]  →  output.task_id  →  output.id  →  data.task_id  →  data.id
```

### 4.2 轮询请求

```
GET /api/v1/tasks/{task_id}
Authorization: Bearer <key>
```

### 4.3 状态与结果解析

| 项        | 规则                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 状态字段优先级  | `status` → `task_status` → `output.task_status` → `output.status`（统一转小写）                                        |
| 成功状态词    | `succeeded`, `success`, `done`, `completed`, `complete`, `finished`, `ok`                                       |
| 失败状态词    | `failed`, `failure`, `fail`, `error`, `canceled`, `cancelled`, `expired`, `rejected`, `timeout`（**不含 unknown**） |
| 进度       | `progress`（顶层或 `output/data/result` 内），clamp 到 0–99                                                             |
| 失败原因     | 万相放在 `output.code` + `output.message`，拼成 `code: message`；也兼容 `error.message` / 顶层 `message`                     |
| 视频结果 URL | `output.video_url` 等候选字段（递归提取）                                                                                  |

典型轮询响应：

```json
{
  "output": {
    "task_status": "SUCCEEDED",
    "video_url": "https://example.com/result.mp4"
  }
}
```

### 4.4 轮询节奏

视频类统一节奏：初始 `20s` → 运行中 `15s` → 接近完成 `6s`；轮询窗口 **20 分钟**，
可用环境变量 `VIDEO_POLL_INTERVAL_MS` 覆盖间隔。解析实现在
`src/server/async-providers.ts`：`extractProviderStatus`（:127-183）、`videoSpec` 的 `extractResults`（:190+）。

---

## 5. 完整调用流程（curl 示意）

```bash
BASE=https://api.tiantoken.com
KEY=<YOUR_API_KEY>

# 1) 提交（注意 X-DashScope-Async 头）
curl -s -X POST "$BASE/api/v1/services/aigc/video-generation/video-synthesis" \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "X-DashScope-Async: enable" \
  -d '{
    "model": "wan3.0-video",
    "input": { "prompt": "一只猫走过街道" },
    "parameters": { "resolution": "720P", "ratio": "16:9", "duration": "5", "audio": true }
  }'
# → { "output": { "task_id": "xxxx-...." } }

# 2) 轮询
curl -s "$BASE/api/v1/tasks/xxxx-...." \
  -H "Authorization: Bearer $KEY"
# → { "output": { "task_status": "SUCCEEDED", "video_url": "https://.../result.mp4" } }
```

---

## 6. 限额与注意事项

- 参考图上限 **10** 张；时长 **2–30 秒**（默认 5）；分辨率仅 480P / 720P / 1080P。
- 视频编辑模式不发 `duration`；输入+输出时长 ≤30 秒。
- 本地视频/音频必须先上传换公网 URL，不能直接塞进 `media`。



---
