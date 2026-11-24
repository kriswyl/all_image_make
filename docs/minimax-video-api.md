# MiniMax H3（MiniMax-H3）视频接入 API

> - 模型 ID：`MiniMax-H3`
> - 适配器：`minimax-video`
> - 内置渠道：`tiantoken-minimax-video`「词元流墟-MiniMax视频」
> - Base URL：`https://api.tiantoken.com`
> - 鉴权：`Authorization: Bearer <key>`（env `TIANTOKEN_MINIMAX_VIDEO_API_KEY`）

---

## 1. 接口一览

| 步骤       | 方法     | 路径                                              | 说明                                       |
| -------- | ------ | ----------------------------------------------- | ---------------------------------------- |
| 提交任务     | `POST` | `/v1/video/generations`（**单数 video**）           | 不要求异步头                                   |
| 轮询任务     | `GET`  | `/v1/videos/{task_id}`（**复数 videos**）           | 结果在 `metadata.url`                       |
| 上传素材（可选） | `POST` | `https://imageproxy.zhongzhuan.chat/api/upload` | 本地视频换公网 URL，头 `New-Api-User: 1`；**拒收音频** |

> ⚠️ **两个路径的单复数最容易写反**：提交是 `/v1/video/generations`，轮询是 `/v1/videos/{id}`。
> 写反的结果都是 404：提交 404 等于根本没建单，轮询 404 等于永远取不到结果。

所有 URL 都相对渠道 Base URL，用 `joinEndpoint(baseUrl, endpoint)` 拼接。提交路径在
`src/shared/adapter-endpoints.ts:21`；请求体可叠加渠道里配置的**高级 JSON `raw`**。

### 1.1 和官方接口不是一套

官方是 `POST https://api.minimax.io/v2/video_generation`，请求体是 `content[]` 数组
（`type: text / image_url / video_url / audio_url` + `role`），轮询
`GET /v2/query/video_generation/{task_id}`，结果在 `task.content.url`。

本中转把它**拍平成了 v1 风格**：`prompt + images/videos/audios + metadata`。
字段名完全不通用 —— 照着官方文档写一定会失败，只能按本文这套发。

---

## 2. 提交任务

### 2.1 请求头

| 头               | 值                  | 说明                   |
| --------------- | ------------------ | -------------------- |
| `Authorization` | `Bearer <key>`     | 渠道密钥                 |
| `Accept`        | `application/json` | —                    |
| `Content-Type`  | `application/json` | —                    |
| `New-Api-User`  | `1`                | 可带可不带（带了没坏处）；上传素材时必带 |

**没有** `X-DashScope-Async` —— 那是万相的，MiniMax 不需要也不会看。

### 2.2 请求体结构

```jsonc
{
  "model": "MiniMax-H3",
  "prompt": "一只猫走过街道",         // ≤7000 字符，空字符串会被 compact 去掉
  "duration": 5,                     // 整数 4–15，默认 5；实际出片会略长 0.4–0.5 秒
  "images": ["data:image/jpeg;base64,..."],   // 仅参考模式用；无则整个字段去掉
  "metadata": {
    "resolution": "768P",            // 768P / 2K，别写 720P / 1080P
    "ratio": "16:9",                 // 文生必填；首帧/首尾帧不传
    "videos":  ["https://.../clip.mp4"],       // 参考视频，公网 URL
    "audios":  ["data:audio/wav;base64,..."], // 参考音频，内联或公网 URL
    "first_frame": "data:image/jpeg;base64,...",  // 单值，不是数组
    "last_frame":  "data:image/jpeg;base64,...",  // 单值，必须与 first_frame 同时出现
    "aigc_watermark": false
  }
}
```

> `images` / `videos` / `audios` / `first_frame` / `last_frame` 都经过 `compact()`：
> 用不到的字段整个不出现，不要发 `null` 或空数组。
> 源码：`src/server/adapters.ts:371-395`。

### 2.3 字段说明

| 字段                        | 类型      | 取值 / 默认                                | 备注                                                   |
| ------------------------- | ------- | -------------------------------------- | ---------------------------------------------------- |
| `model`                   | string  | `MiniMax-H3`                           | 只有这一个；`MiniMax-H3-...` 之类不在列表里                       |
| `prompt`                  | string  | ≤ 7000 字符                              | 应用侧路由上限 20000，能力上限 7000，取严的那个                        |
| `duration`                | number  | 整数 `4`–`15`，默认 `5`                     | **必须是整数**；实测 4 → 实际 4.46 秒，每档都略长                     |
| `images[]`                | string  | base64 data URI 或公网 URL                | 仅 `reference` 模式；上限 9 张                              |
| `metadata.resolution`     | string  | `768P`（默认）/ `2K`                       | **只有这两档**；传 `1080P` 会被拒（报错还伪装成 `get_channel_failed`） |
| `metadata.ratio`          | string  | `21:9` `16:9` `4:3` `1:1` `3:4` `9:16` | 文生**必填且不能 `adaptive`**；首帧/首尾帧由图片决定，不传                |
| `metadata.videos[]`       | string  | 公网 URL                                 | ≤3 段，单段 ≤50 MB、2–15 秒，总时长 ≤15 秒                      |
| `metadata.audios[]`       | string  | 内联 base64 或公网 URL                      | ≤3 段，单段 ≤15 MB、2–15 秒，总时长 ≤15 秒；**必须配图或视频**          |
| `metadata.first_frame`    | string  | 图片 data URI                            | 单值；与 `last_frame` 成对，与参考素材**互斥**                     |
| `metadata.last_frame`     | string  | 图片 data URI                            | 单值；必须同时给 `first_frame`                               |
| `metadata.aigc_watermark` | boolean | 可选                                     | 不传时画面无可见水印（`output_aigc.mp4` 只是文件名）                  |

### 2.4 不要发的字段

| 字段                                     | 真相                             |
| -------------------------------------- | ------------------------------ |
| `generate_audio`                       | 官方**没有这个参数**；中转传了也静默忽略，输出照样有音轨 |
| `seed` / `watermark` / `prompt_extend` | 中转不认，传了被丢                      |
| `adaptive`（文生时的 `ratio`）               | 文生不支持自适应，必须给具体比例               |

### 2.5 硬限制

| 项             | 上限                                                            |
| ------------- | ------------------------------------------------------------- |
| `prompt`      | 7000 字符                                                       |
| 参考图 `images`  | 9 张                                                           |
| 参考视频 `videos` | 3 段；单段 2–15 秒、≤50 MB，总时长 ≤15 秒                                |
| 参考音频 `audios` | 3 段；单段 2–15 秒、≤15 MB（**MP3 / WAV**），总时长 ≤15 秒；必须搭配图或视频        |
| 素材合计          | ≤ 12 份                                                        |
| 官方请求体         | ≤ 64 MB                                                       |
| 本应用内联预算       | `MAX_INLINE_MEDIA_CHARS` = 40 MiB 字符（见 `src/shared/types.ts`） |

> 网关实测硬顶是 **50 MiB**（50 MiB 过、51 MiB 起 413），远大于旧的「1~2 MB」记录。
> 

---

## 3. 素材与模式

### 3.1 素材落点

| 内部 `type`         | 出网位置                   | 走法                            |
| ----------------- | ---------------------- | ----------------------------- |
| `first_frame`     | `metadata.first_frame` | 图片，内联 base64                  |
| `last_frame`      | `metadata.last_frame`  | 图片，内联 base64                  |
| `reference_image` | `images[]`             | 图片，内联 base64（过大时服务端改走图床换 URL） |
| `video`           | `metadata.videos[]`    | 本地 MP4 先经图床换公网 URL            |
| `audio`           | `metadata.audios[]`    | **只能内联 base64，不要上传图床**        |

- **图床拒收音频**（实测返回「只支持图片或视频文件」）。参考音频一旦走
  `uploadReferenceMedia(..., "audio")` 必然 502。
- 图片默认内联；请求体接近预算时，服务端会先上传图床换成 URL。这条只对**验证过该协议**的
  渠道开放：`seedance-video` 与 `minimax-video`（模型名必须正好是 `MiniMax-H3`）＋
  Base URL 必须是 `https://api.tiantoken.com`（`src/shared/video-reference-image-policy.ts:18-30`）。
- 图片缩放策略：`minEdge 256` / `maxEdge 5760` / 宽高比 ≤2.5 / 单文件 ≤30 MB / 输出不透明
  （`src/shared/video-reference-image-policy.ts:6-8`）。

### 3.2 四种生成模式

| 模式 ID              | 名称     | 需要的素材                             | 发出去的字段                                                   |
| ------------------ | ------ | --------------------------------- | -------------------------------------------------------- |
| `text-to-video`    | 文生视频   | 无（仅 prompt）                       | `prompt` + `duration` + `metadata.resolution/ratio`      |
| `first-frame`      | 首帧生视频  | 1 张 `first_frame`                 | ＋ `metadata.first_frame`；**不发 `ratio`**                  |
| `first-last-frame` | 首尾帧生视频 | `first_frame` + `last_frame`      | ＋ 两者都发；**不发 `ratio`**                                    |
| `reference`        | 参考生视频  | 最多 9 张参考图 + 3 段视频 + 3 段音频（合计 ≤12） | ＋ `images[]` / `metadata.videos[]` / `metadata.audios[]` |

- 首尾帧与参考素材**互斥**（官方口径）；界面上是两个入口，服务端也会拦。
- 模式由素材推断：有 `last_frame` → 首尾帧；有 `first_frame` → 首帧；有任意素材 → 参考；
  都没有 → 文生（`src/shared/video-modes.ts:498-502`）。
- MiniMax 没有「视频编辑 / 视频延长 / 运动控制」语义，模式表里也就不列这四个。

模式清单真相在 `src/shared/video-modes.ts` 的 `MINIMAX_MODE_SPECS`（:201-206，复用 Seedance
的四条槽位定义，只改提示文案）与 `src/shared/types.ts` 的 `MinimaxVideoMode`。

### 3.3 各模式请求体示例

文生视频（`ratio` 必须具体）：

```json
{
  "model": "MiniMax-H3",
  "prompt": "一只猫走过街道",
  "duration": 5,
  "metadata": { "resolution": "768P", "ratio": "16:9" }
}
```

首帧生视频（**没有 `ratio`**）：

```json
{
  "model": "MiniMax-H3",
  "prompt": "让画面动起来",
  "duration": 5,
  "metadata": {
    "resolution": "768P",
    "first_frame": "data:image/jpeg;base64,..."
  }
}
```

首尾帧生视频：

```json
{
  "model": "MiniMax-H3",
  "prompt": "从白天过渡到夜晚",
  "duration": 5,
  "metadata": {
    "resolution": "768P",
    "first_frame": "data:image/jpeg;base64,...",
    "last_frame": "data:image/jpeg;base64,..."
  }
}
```

参考生视频（图 + 视频 + 音频）：

```json
{
  "model": "MiniMax-H3",
  "prompt": "用图片1里的人物，按视频1的动作走一遍，说话音色参考音频1",
  "duration": 5,
  "images": ["data:image/jpeg;base64,..."],
  "metadata": {
    "resolution": "768P",
    "ratio": "9:16",
    "videos": ["https://imageproxy.zhongzhuan.chat/api/proxy/image/xxx.mp4"],
    "audios": ["data:audio/wav;base64,..."]
  }
}
```

### 3.4 `ratio` 的三条规则

| 模式       | 规则                                                                |
| -------- | ----------------------------------------------------------------- |
| 文生       | 必填；`adaptive` 或留空时**适配器兜底成 `16:9`**（`adapters.ts:376-378`）        |
| 首帧 / 首尾帧 | 不传 `ratio`，画面比例由图片决定（实测：720×1280 竖图 → 768×1344；768×768 → 768×768） |
| 参考       | 按传入比例；不传则上游自适应                                                    |

---

## 4. 异步轮询

### 4.1 提交响应

```json
{
  "id": "task_xxxxxxxx",
  "task_id": "task_xxxxxxxx",
  "object": "video",
  "model": "MiniMax-H3",
  "status": "queued",
  "progress": 0,
  "created_at": 1795000000
}
```

`id` 与 `task_id` **同值**，都形如 `task_xxx`。取哪个都行；不要取 `request_id`（那不是任务 id）。

### 4.2 轮询请求

```
GET /v1/videos/{encodeURIComponent(task_id)}
Authorization: Bearer <key>
```

### 4.3 状态、进度与结果

| 项              | 规则                                                  |
| -------------- | --------------------------------------------------- |
| 状态词            | `queued` → `in_progress` → `completed`（失败态实测未观察到）   |
| 进度             | 只有 **0 / 10 / 50 / 100** 四档，`in_progress` 期间长期停在 50 |
| 结果 URL         | **只取 `metadata.url`**，其它位置都不认                       |
| 出片时长           | `duration` 字段（秒，数值型），缺失时由下载后的文件判定                   |
| `completed_at` | **不可信**：任务还在跑时就已经有值，而且每轮都在变，实际是「最后更新时间」             |

### 4.4 出片域名不统一

768P 的结果通常落在阿里云 OSS（`…/output_aigc.mp4`），2K 和部分 768P 落在火山
（`…/kz-cgt-…output.mp4`）。结构一致、失败与成功都可能是这两种域名，
**不要按域名判断成败**，会误判。

### 4.5 节奏与超时

- 轮询节奏：初始 `20s` → 运行中 `15s` → 接近完成 `6s`；窗口 **20 分钟**
  （`src/server/async-providers.ts:57`，可用 `VIDEO_POLL_INTERVAL_MS` 覆盖间隔）。
- 出片耗时：4 秒视频约 **86–150 秒**。
- 本地任务超时：视频工作台默认 **600 秒**（`src/shared/video-draft.ts:52`）→ 15 秒的长片
  建议调到 900–1200 秒；无限画布视频节点默认 800 秒，可在节点上按
  `timeoutSeconds`（10–1800）覆盖。

---

## 5. 完整调用流程（curl 示意）

```bash
BASE=https://api.tiantoken.com
KEY=<YOUR_API_KEY>

# 1) 提交（注意 video 是单数）
curl -s -X POST "$BASE/v1/video/generations" \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "New-Api-User: 1" \
  -d '{
    "model": "MiniMax-H3",
    "prompt": "一只猫走过街道",
    "duration": 4,
    "metadata": { "resolution": "768P", "ratio": "16:9" }
  }'
# → { "id": "task_xxx", "task_id": "task_xxx", "status": "queued" }

# 2) 轮询（videos 是复数）
curl -s "$BASE/v1/videos/task_xxx" \
  -H "Authorization: Bearer $KEY" \
  -H "New-Api-User: 1"
# → { "status": "completed", "metadata": { "url": "https://.../output_aigc.mp4" } }
```

---

## 6. 请求与出片对不上 / 常见错误

| 症状                                    | 真正原因                                                                       | 修法                                     |
| ------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| 报「分组 … 下模型 MiniMax-H3 的可用渠道不存在」       | `get_channel_failed` 是**万能错误**：通道暂时不可用、或参数不被支持都会报它（实测 `1080P` 被拒就是这条）      | 先拿一个已知能跑的最小请求复测；能跑通就说明是参数问题，不是通道问题     |
| 整段时间内所有请求都 `get_channel_failed`       | H3 的通道会整体消失一段时间（同一份请求 10 分钟前成功、之后全挂，而同一 Key 的文本模型正常）                       | 等 10–30 分钟重试，别改代码                      |
| 选 1080P / 720P 失败                     | H3 只有 `768P` / `2K` 两档                                                     | 改 `768P`；`1080P` 属 Hailuo 02 / 2.3 的档位 |
| 出片比请求长 0.4–0.5 秒                      | 编码器的 GOP / 音频对齐，正常现象                                                       | 不用管；4 → 4.46 秒是实测值                     |
| 要静音，但传了 `generate_audio: false` 还是有声音 | 官方没有这个参数，音频是模型原生输出的一部分，**关不掉**                                             | 只能拿到 mp4 后抽音轨；本项目没有 ffmpeg，不建议做        |
| 2K 特别慢、特别贵                            | `2K` 不是「更清晰的 768P」，而是 **H3-Regenerate-2K 二次重生成**（`task_type=regeneration`） | 除非明确要 2K，一律显式传 `768P`                  |
| 文生报错 / 画面比例奇怪                         | 文生不允许 `adaptive`，必须具体比例                                                    | 传 `16:9` / `9:16` 等；代码里已兜底成 `16:9`     |
| 单独传参考音频失败                             | 官方口径：音频必须配图片或视频                                                            | 再加一张参考图或一段参考视频                         |
| 参考音频 502                              | 音频被送去图床了                                                                   | 音频只能内联 base64 / 公网 URL                 |
| `413 Request Entity Too Large`        | 请求体超网关 50 MiB（按 `Content-Length` 预判，770 ms 就返回）                            | 减小素材或改走 URL                            |

**实测分辨率对照**

| 请求                      | 出片               |
| ----------------------- | ---------------- |
| `768P` + `ratio=16:9`   | 1344×768         |
| `768P` + 首帧 720×1280 竖图 | 768×1344         |
| `768P` + 首帧 768×768 方图  | 768×768          |
| `2K` + `ratio=16:9`     | 2560×1440，24 FPS |

---

## 7. 限额与注意事项

- 参考图 **9** 张；参考视频 **3** 段（≤50 MB/段）、参考音频 **3** 段（≤15 MB/段）；
  视频与音频各自总时长 **≤15 秒**、单段 **2–15 秒**；素材合计 **≤12** 份。
- 时长 **4–15 秒整数**；分辨率只有 **768P / 2K**；提示词 **≤7000** 字符。
- **原生音轨恒定存在**，关不掉（`supportsAudio: false` 只是让界面不显示开关，
  文案要写清「H3 自带环境音」，否则用户以为关掉了）。
- 音频不走上传；本地视频必须上传换公网 URL；图片可内联也可换 URL。
- 失败先说通道：`get_channel_failed` 九成不是请求体的问题，**先复测最小请求**。

---

## 
