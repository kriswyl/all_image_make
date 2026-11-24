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
    "resolution": "480P",             // 480P / 720P / 1080P，默认 1080P（不是 720P）
    "ratio": "16:9",                  // 画幅，字段名叫 ratio，默认 adaptive
    "duration": 5,                    // ⚠️ 数字，不是字符串！整数 2–30，默认 5；video-edit 模式不发
    "audio": true,                    // 是否生成音频
    "prompt_extend": true,            // 智能扩写；file/link 模式强制 true
    "seed": 123,                      // 随机种子
    "watermark": false                // 是否打水印
  }
}
```

> ⚠️ **`duration` 必须是 JSON 数字（`12`），写成字符串（`"12"`）会被上游当非法值静默丢弃。**  
> 更坑的是：参数校验失败时上游**不报错**，而是把整个 `parameters` 当没传，`duration` 回落默认 5、  
> `resolution` 回落默认 1080P、`ratio` 回落自适应。表现就是「请求 12 秒 480P，出片 5 秒 1080×1920」。  
> 详见第 6 节「请求与出片对不上」。

> `input` 与 `parameters` 都经过 `compact()`：值为 `undefined` / `""` 的字段被剔除，  
> 所以空 prompt 不会发出、无素材不会带空的 `media`。

### 2.3 parameters 字段说明

| 字段              | 类型         | 取值 / 默认                                               | 备注                                                                                              |
| --------------- | ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `resolution`    | string     | `480P` / `720P` / `1080P`，**默认 `1080P`**              | 大小写敏感，大写 P。默认档是 1080P，不是 720P —— 漏传/传错就直接按最贵那档出片                                                |
| `ratio`         | string     | `adaptive`（默认）、`21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16` | 画幅字段名是 `ratio`，不是 `aspect_ratio`；`adaptive` 会跟随参考素材的比例                                          |
| `duration`      | **number** | 整数 `2`–`30`，**默认 `5`**；传 `-1` 为智能时长                   | **必须是数字**。字符串 `"12"` 会让整个 `parameters` 被判非法并回落默认。**video-edit 模式不带此字段**；有参考视频时受「输入+输出 ≤ 30 秒」约束 |
| `audio`         | boolean    | 默认 `true`                                             | 是否生成音频                                                                                          |
| `prompt_extend` | boolean    | 可选                                                    | 智能扩写提示词；传 `file` / `link` 素材时**强制 `true`**                                                      |
| `seed`          | number     | 可选                                                    | 随机种子，便于复现                                                                                       |
| `watermark`     | boolean    | 可选                                                    | 是否加水印                                                                                           |

### 2.4 参考素材与提示词的硬限制

| 项                 | 上限                                                        |
| ----------------- | --------------------------------------------------------- |
| `prompt`          | ≤ 5000 字                                                  |
| `reference_image` | ≤ 10 张；单张 ≤ 20 MB，单边 240–8000 px，宽高比 ≤ 8:1                |
| `reference_video` | ≤ 5 段；**单段 1–15 s，总时长 ≤ 15 s**；单段 ≤ 100 MB，单边 240–4096 px |
| `reference_audio` | ≤ 5 段；**单段 1–15 s，总时长 ≤ 15 s**；单段 ≤ 15 MB（wav / mp3）      |
| `file` / `link`   | 各 1 个，二者互斥；文件 ≤ 100 MB、≤ 50 页                             |
| 时长                | 无视频输入：2–30 s；**有参考视频：输入总时长 + 输出时长 ≤ 30 s**                |



> 「输入+输出 ≤ 30」这条最容易被忽略：参考视频 20 s 时最多只能要 10 s，参考视频 15 s（单段上限）  
> 时最多 15 s。超出去的请求不会明确报错，出片会落到默认 5 s 附近 —— 与「参数被判非法、整块回落」  
> 从结果上分不开，所以**带参考视频时先把这条算清楚**，否则 12 s 永远要不回来。

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

| 模式 ID              | 名称      | 需要的素材                                | duration 可调   | 特殊规则                                      |
| ------------------ | ------- | ------------------------------------ | ------------- | ----------------------------------------- |
| `text-to-video`    | 文生视频    | 无（仅 prompt）                          | 是             | —                                         |
| `first-frame`      | 首帧生视频   | 1 张 `first_frame`                    | 是             | —                                         |
| `first-last-frame` | 首尾帧生视频  | `first_frame` + `last_frame`         | 是             | 第 1 张首帧、第 2 张尾帧                           |
| `reference`        | 参考生视频   | 最多 10 张 `reference_image`，可搭配参考视频/音频 | 是（受 30s 规则约束） | 提示词里用 `@` 引用素材；**带参考视频时输出时长 ≤ 30 − 输入时长** |
| `video-edit`       | 视频编辑    | 1 段 `reference_video`                | **否**         | 不发 `duration`                             |
| `video-extend`     | 视频延长    | 1 段 `reference_video`                | 是             | 输入+输出总时长 ≤30s                             |
| `file-to-video`    | 参考文件生视频 | 1 个 `file` / `link`                  | 是             | `prompt_extend` 强制 `true`                 |

模式清单真相在 `src/shared/video-modes.ts` 的 `WAN_MODE_SPECS` 与  
`src/shared/types.ts` 的 `WanVideoMode`（:150-157）。前端按素材实际组合把「提示词 / 帧」两个合并入口  
解析成这七种具体模式；服务端在任务创建时按同一张表校验，防止绕过界面提交。

**各模式请求体示例：**

文生视频：

```json
{
  "model": "wan3.0-video",
  "input": { "prompt": "一只猫走过街道" },
  "parameters": { "resolution": "720P", "ratio": "16:9", "duration": 5 }
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
  "parameters": { "resolution": "720P", "ratio": "16:9", "duration": 5 }
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
    "parameters": { "resolution": "720P", "ratio": "16:9", "duration": 5, "audio": true }
  }'
# → { "output": { "task_id": "xxxx-...." } }

# 2) 轮询
curl -s "$BASE/api/v1/tasks/xxxx-...." \
  -H "Authorization: Bearer $KEY"
# → { "output": { "task_status": "SUCCEEDED", "video_url": "https://.../result.mp4" } }
```


```

---

## 6. 请求与出片对不上时怎么排查

万相这类接口最坑的地方：**参数不合法不报错，静默回落默认值**。所以「任务 success、片子在、
就是参数不对」几乎都是请求侧的问题，不是模型抽风。先按症状查这张表：

| 症状                            | 真正原因                                                        | 修法                                              |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| 要 12 s，出 5.0–5.1 s           | ① `duration` 写成了字符串 `"12"` → 整个 `parameters` 被判非法，回落默认 **5**<br>② 带参考视频且「输入+输出 > 30 s」→ 被压到 5<br>③ 没传 `duration` | `duration` 用**数字**；带参考视频时先算 `30 − 输入时长`；不确定就传 `-1` 交给智能时长 |
| 要 480P，出 1080×1920           | `resolution` 没生效（同上，跟着 `parameters` 一起被丢），回落**官方默认 1080P** | 显式传 `"resolution": "480P"`（大写 P），并保证同请求里没有非法字段 |
| 要 16:9，出 9:16               | 没传 `ratio` 或传了非法值，回落 `adaptive`，跟随参考视频/参考图的比例            | 显式传 `"ratio": "9:16"` 这类档位值                      |
| 出片时长 = 参考音频时长               | 素材组合被上游走成了「音频驱动/口型同步」分支，时长由音轨决定                        | 只把音频当**音色参考**时，音频压到 3–8 s 并明确写「只参考音色，不驱动口型」；或先不带音频跑通时长 |
| 请求 400 / 任务 FAILED           | 素材超限（视频/音频单段 >15 s、总时长 >15 s、图片 >10 张、prompt >5000 字）    | 见 §2.4 硬限制表                                     |

**本次实测案例（2026-11-23 13:47，`task_epfXK4RPtrWkAZxsDBCU8zmRGLeDCM8k`）**

```
请求：duration "12"（字符串）、resolution "480P"、ratio "9:16"
      media = reference_image + reference_video + reference_audio
出片：5.04 s、1080×1920、seconds:"5"
```

三个数字同时指向「`parameters` 整体没生效」：

| 字段           | 请求值     | 出片值        | 解释                                     |
| ------------ | ------- | ---------- | -------------------------------------- |
| `duration`   | `"12"`  | 5.04 s ≈ 5 | 回落默认 `5`                               |
| `resolution` | `"480P"` | 1080×1920  | 回落默认 `1080P`（若真按 480P 应是 480×854） |
| `ratio`      | `"9:16"` | 9:16       | 与参考视频比例相同，`adaptive` 也是这个结果，**不能**当作 ratio 生效的证据 |

对照组（同一渠道 · 同一模型 · 同样带参考视频）：`2026-11-21` 那次 `duration: 2`（数字）+ `480P`
→ 出片 **2.00 s、480×854**，参数全部生效。两次请求唯一的差别就是 `duration` 的类型。

顺带一提：`seconds` 字段是**输出时长**，不是耗时（该任务 `created_at` → `completed_at` 实际
802 秒）。别把它当排队时间看。

---

## 7. 限额与注意事项

- 参考图上限 **10** 张；`reference_video` / `reference_audio` 各 ≤5 段、**单段 1–15 s、总时长 ≤15 s**。
- 时长 **2–30 秒整数**（默认 5）；**有参考视频时「输入 + 输出 ≤ 30 秒」**；`-1` 为智能时长。
- 分辨率 480P / 720P / 1080P，**默认 1080P**；`ratio` 默认 `adaptive`；`prompt` ≤ 5000 字。
- **`duration` 是数字不是字符串**；任何字段写错，上游不报错，而是整个 `parameters` 回落默认。
- 视频编辑模式不发 `duration`。
- 本地视频/音频必须先上传换公网 URL，不能直接塞进 `media`。



---
