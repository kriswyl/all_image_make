# MiniMax H3（Hailuo 03）接入 · 实测与方案

> **状态：代码一行未改，全部待实施。** 第一~五节是实测事实，第六节是可执行清单。
>
> 2026-11-17 用真实令牌（`api.tiantoken.com`）探测的结果。中转站文档是从豆包
> 模板复制来的（`operationId: createDoubaoVideoTask`），以下结论**以实测为准**。
> 共消耗 7 条视频（6 条 768P/4 秒 + 1 条 2K/4 秒），未再补测。

## 一、协议（已实测）

| 项 | 结论 |
|---|---|
| 提交 | `POST /v1/video/generations`（不是 `/v1/videos/generations`） |
| 轮询 | `GET /v1/videos/{task_id}` |
| 鉴权 | `Authorization: Bearer <key>`；`New-Api-User: 1` 可带可不带（带了没坏处） |
| 提交响应 | `{ id, task_id, object:"video", model, status:"queued", progress:0, created_at }`，`id` 与 `task_id` 同值，形如 `task_xxx` |
| 状态词 | `queued` → `in_progress` → `completed`（失败态未观测到） |
| 进度 | 0 → 10 → 50 → 100（只有四档，`in_progress` 期间长期停在 50） |
| 结果 | `metadata.url` |
| 耗时 | 4 秒视频约 86–150 秒出片 |
| 时间字段 | `completed_at` **不可信**：任务还在跑时就已经有值，且每轮都在变，实际是「最后更新时间」 |

**上游不止一家**：768P 的结果落在阿里云 OSS（`…/output_aigc.mp4`），2K 和部分
768P 落在火山（`…/kz-cgt-…output.mp4`）。响应结构一致，但出片域名不同，
诊断贴图时不要按域名判断成败。

## 一·五、官方口径（platform.minimax.io/docs/guides/video-generation）

官方接口是 `POST https://api.minimax.io/v2/video_generation`，请求体用
`content[]` 数组（`type: text / image_url / video_url / audio_url` + `role`），
轮询 `GET /v2/query/video_generation/{task_id}`，结果在 `task.content.url`。
本中转把它拍平成了 v1 风格的 `prompt + images/videos/audios + metadata`，
字段名不通用，**只能按实测的这套发**。

**resolution**：官方只有两档 `768P` / `2K`，别的都不认。

| 事实 | 说明 |
|---|---|
| 768P | 短边固定 768；16:9 → 1344×768（实测一致） |
| 2K | 16:9 → 2560×1440（实测一致）；24 FPS |
| 2K 的真相 | 不是"更清晰的 768P"，而是 **H3-Regenerate-2K 二次重生成**：把 768P 结果连同原始 context 再喂回 H3，`task_type=regeneration`。所以更慢更贵 |
| 默认值 | 官方 blog 说 "2K by default"，文档示例全部显式写 `2K`；第三方口径多写默认 768P。**接入时一律显式传，不赌默认** |
| 1080P / 720P | 属于 Hailuo 02 / 2.3 的档位，H3 不支持（实测 1080P 被拒，与官方一致） |
| ratio | 文生必须给具体比例、不能 `adaptive`；图生/首尾帧恒为 adaptive，由图片决定（实测吻合） |

**generate_audio**：官方 **没有这个参数**。

- 音频是模型原生输出的一部分：「Output audio 32 kHz stereo」「generates native
  stereo audio」，与画面同一次生成，11 种语言的对话也在这里面。
- 官方请求体字段里没有任何音频开关，**官方语义下关不掉**。
- `ofox.ai` 之类中转写的 `generate_audio: defaults to true` 是它们自己的扩展，
  不是 MiniMax 协议；本中转传了 `generate_audio: false` 被静默忽略（输出仍有音轨）。
- 实测细节：环境声 RMS ≈ 0.03；纯静止色块那条 RMS = 0 —— 说明是"跟着画面内容
  生成"，不是固定静音轨，也不是后贴的 BGM。
- 要真静音只能拿到 mp4 后抽掉音轨，本项目没有 ffmpeg，不建议做。

**体积**：官方限 请求体 ≤ 64 MB（且建议大素材用 URL）。本中转的网关上限远大于此前的
「1~2 MB」旧记录（见 `MEDIA_UPLOAD_HANDOFF.md`：1/2/…/20 MB 都通），**真正的约束是
应用自己的 40 MiB 字符预算**（`shared/types.ts` 的 `MAX_INLINE_MEDIA_CHARS`，2026-11-17 由 15 MiB 上调；
原因是网关实测硬顶 50 MiB）。本次测到的
3.7 MB 报错是通道故障，不能当成体积证据。

## 二、请求体

```json
{
  "model": "MiniMax-H3",
  "prompt": "……",
  "duration": 4,
  "images":  ["<base64 data URI 或公网 URL>"],
  "videos":  ["<公网 URL>"],
  "audios":  ["<base64 data URI 或公网 URL>"],
  "metadata": {
    "resolution": "768P",
    "ratio": "16:9",
    "first_frame": "<base64 data URI>",
    "last_frame":  "<base64 data URI>",
    "aigc_watermark": false
  }
}
```

- 文生：只发 `prompt` + `duration` + `metadata.resolution/ratio`
- 首帧：`metadata.first_frame`
- 首尾帧：`metadata.first_frame` + `metadata.last_frame`
- 参考（多模态）：`images[]` / `videos[]` / `audios[]`
- 首尾帧与参考素材互斥（官方口径），界面按两个入口分开即可

## 三、参数实测矩阵

| 参数 | 实测 | 证据 |
|---|---|---|
| `metadata.resolution = 768P` | **生效** | 16:9 → **1344×768** |
| `metadata.resolution = 2K` | **生效** | 16:9 → **2560×1440** |
| `metadata.resolution = 1080P` | **被拒** | 紧接着 2K 提交成功，所以不是通道故障；报错是误导性的 `get_channel_failed` |
| `metadata.ratio = 16:9` | **生效** | 1344×768 |
| 不传 `ratio` + 首帧图 | **按图片自适应** | 720×1280 竖图 → **768×1344**；768×768 方图 → **768×768** |
| `duration = 4` | **生效** | 实际 4.46 秒（每档都略长） |
| `metadata.first_frame`（base64） | **生效** | 纯红图 → 首帧中心 `rgb(234,56,38)` |
| `metadata.last_frame`（base64） | **生效** | 纯蓝图 → 末帧中心 `rgb(22,63,197)`，首帧仍是红 |
| `images[]`（base64，参考图） | **生效** | 纯蓝方图 → 整片 768×768 蓝 |
| `audios[]`（base64 WAV 3s） | **提交被接受** | 200 + task_id；音频是否被"听进去"未做听觉验证 |
| `videos[]`（公网 URL） | **生效** | 图床上传的 4 秒 MP4 → 出片成功 |
| `generate_audio: false` | **被忽略** | 输出仍有 AAC 立体声音轨（生成的是场景环境声，RMS 0.03 量级） |
| `aigc_watermark` | 未验证 | 默认（不传）时**画面无可见水印**，`output_aigc.mp4` 只是文件名 |
| 大请求体 | **不受 1~2 MB 约束** | 旧记录（`VIDEO_HANDOFF` 第 8 条）已过期，见 `MEDIA_UPLOAD_HANDOFF.md`：网关硬顶 **50 MiB**（50 MiB 过、51 MiB 起 413）。本次 3.7 MB 报 `get_channel_failed` 与 `wan3.0-video` 当时的现象一致，**是通道故障不是体积**；真正生效的是应用侧 40 MiB 字符预算 |

## 四、两个必须记住的坑

1. **`get_channel_failed` 是万能错误**：同一句 `分组 … 下模型 MiniMax-H3 的可用渠道不存在（retry）`
   既会在**通道暂时不可用**时出现，也会在**参数不被支持**时出现（实测 1080P 被拒就是这条）。
   **但它跟请求体大小无关**——网关超限是 `413 Request Entity Too Large`（51 MiB 起，770ms 就按
   `Content-Length` 预判），应用侧超限是 `INVALID_INPUT`。看到它先拿一个最小请求复测，别去改尺寸相关的代码。
2. **H3 的通道会整体消失一段时间**。同一份请求 10 分钟前成功、之后全部
   `get_channel_failed`，而同一个 Key 的文本模型（MiniMax-M2.5）正常。
   排查时先拿一个已知能跑的最小请求复测，别怀疑自己代码。

## 五、未验证（省钱没做）

- 图片走**公网 URL** 是否被接受（参考视频 URL 已证明可用；图片 URL 测到一半通道挂了）
- `images` 9 张 / `videos` 3 段 / `audios` 3 段 / 合计 12 的上限是否由中转强制
- 参考音频是否真的影响生成结果（只验到「提交被接受」）
- `aigc_watermark: true` 的实际效果
- 参考音频「单独不能提交」（官方口径：音频必须配图片或视频）
- 时长 15 秒上限、21:9 / 4:3 / 3:4 / 9:16 等档位

## 六、接入方案（给实现者的执行清单）

新增第 5 个视频适配器 `minimax-video`，与现有 4 家同构。下面按**依赖顺序**列，漏一条就会有一处功能静默失效。

### 6.1 能力矩阵（`shared/video-capabilities.ts`）

| 字段 | 值 | 依据 |
|---|---|---|
| `label` | `"MiniMax H3"` | — |
| `resolutions` | `["768P", "2K"]` | 官方只有这两档 |
| `durations` | `{ min: 4, max: 15, fixed: null, default: 5 }` | 官方 4–15 整数 |
| `aspectRatios` | `["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"]` | 官方列表 |
| `ratioField` | `"ratio"` | 请求体在 `metadata.ratio` |
| `maxReferenceImages` | `9` | 官方参考图上限 |
| `supportsAudio` | `false` | 音频恒定，不可关；置 false 才能让 `reconcileVideoDraft` 把 draft.audio 收敛掉、界面不出开关 |
| `supportsPromptExtend` / `supportsSeed` / `supportsWatermark` / `supportsSmartDuration` | 全 `false` | 中转不认这几个字段（传了也被忽略） |
| **`defaultResolution`** | `"768P"`（**需新增这个字段**） | 见 6.4 坑 1 |

参考视频 / 音频额度：**视频 3 段、音频 3 段、合计 ≤12 份**（官方），需要在
`referenceMediaLimits()` 里给 minimax 单独分支（目前它只认 Seedance 的上限表）。

### 6.2 文件清单

| # | 文件 | 要加什么 | 漏了会怎样 |
|---|---|---|---|
| 1 | `shared/kinds.ts` | `VIDEO_ADAPTER_TYPES` 加 `"minimax-video"` | 渠道不出现在视频工作台，任务被当图片 |
| 2 | `shared/types.ts` | `AdapterType` 加项；`MinimaxVideoMode`(4 种) / `MinimaxMediaType` / `MinimaxMediaInput`；`GenerationInput` 加 `minimaxVideoMode`、`minimaxVideoMedia`；**`VIDEO_MEDIA_FIELDS` 加 `"minimaxVideoMedia"`** | 最后一个是隐性坑：`inlineMediaSize()` 只遍历这个数组，不加就等于 MiniMax 完全不受内联预算约束 |
| 3 | `shared/adapter-endpoints.ts` | `"/v1/video/generations"` | 提交 404 |
| 4 | `shared/video-capabilities.ts` | `VideoAdapter` union、`VIDEO_CAPABILITIES` 条目、`VIDEO_DEFAULTS` 条目、`defaultResolution` 字段 | 参数面板空白 / 默认 2K |
| 5 | `shared/video-modes.ts` | `VideoStudioMode` 加 4 种；`VideoModeField` 加 `"minimaxVideoMode"`；`MINIMAX_MODE_SPECS`；`isVideoAdapterType` / `allVideoModes` / `videoModesFor` / `videoModeField` / `maxImagesForMode` / `referenceMediaLimits` 五处分支 | 界面显示「当前模型没有可用的生成方式」 |
| 6 | `shared/channel-fields.ts` | `CHANNEL_FIELD_SUPPORT["minimax-video"] = { ratio: "param", duration: "param", resolution: "param" }` | 只填了 ratio 时参数不会互补；**不要给 audio/seed/watermark/promptExtend** |
| 7 | `shared/provider-presets.ts` | 「词元流墟-MiniMax视频」预设：模型 `MiniMax-H3`、`secretEnv: TIANTOKEN_MINIMAX_VIDEO_API_KEY`、`uploadEndpoint` 用同一座图床 + `New-Api-User: 1` | 添加渠道向导里没有这一项 |
| 8 | `shared/video-snapshot.ts` | `summarizeTaskInput()` 的 mode 候选列表加 `minimaxVideoMode`，media 汇总加 `minimaxVideoMedia` | 历史任务的「本次参数」是空的 |
| 9 | `server/adapters.ts` | `buildGenerationRequest()` 加 minimax 分支（见 6.3） | — |
| 10 | `server/async-providers.ts` | `"minimax-video": videoSpec((id) => \`/v1/videos/${id}\`)` | 提交后不轮询，任务永远 running |
| 11 | `server/tasks.ts` | 上传回来的地址按适配器塞进 `minimaxVideoMedia`（`type: "video"`）；**音频不走上传** | 参考视频丢失 / 音频上传报「图床不收音频」 |
| 12 | `server/video-mode-guard.ts` | `field` 与 `media` 的三元表达式各加一支 minimax；补「音频必须配图或视频」校验 | 绕过界面直连 API 时不做任何校验 |
| 13 | `server/routes/generations.ts` | `generationSchema` 加 `minimaxVideoMedia`(zod) 与 `minimaxVideoMode`(enum)；**multipart 路由那行 `inlineMedia` 计数要算上 `minimaxVideoMedia`** | 这条最阴：纯图提交（首帧/首尾帧/只放参考图）multipart 为空，会被判成 `UPLOAD_EMPTY`「没有收到参考素材」。Seedance 踩过一模一样的坑（见 CHANGELOG 未发布条目） |
| 14 | `server/diagnose.ts` | `VIDEO_MAPS` 加一项：`resolution → ["metadata","resolution"]`、`duration → ["duration"]` | 诊断面板显示成 OpenAI 的映射，看不出参数有没有发对 |
| 15 | `client/labels.ts` | `adapterLabels` 加 `"minimax-video": "MiniMax 视频"` | `Record<AdapterType, string>` 会直接编译报错，属于白送的提醒 |
| 16 | `client/video/media-builders.ts` | `buildMinimaxMedia()`：图片 base64（复用 `fileToVideoDataUrl`）、音频 base64（`fileToDataUrl`）、视频留空待上传；首帧/尾帧用 `type: "first_frame"/"last_frame"` | 素材进不了请求体 |
| 17 | `client/VideoGenerateView.tsx` | 按适配器构造 media 的分支；上传策略：视频走 `generateWithReferenceVideo`，音频**不**上传 | 传参考视频时方法走错，素材丢失 |
| 18 | `server/board-generation-video.ts`、`board-generation-shared.ts` | 画布路径：有图按 `mode` 映射到 minimax 的 4 种模式；无图给 `text-to-video` | 画布上生成视频报「不是视频模型」或走错模式 |
| 19 | `server/agent-tools/video.ts` | 对话路径：`generate_video` 的模式映射与 media 组装 | 对话里生成视频失败 |
| 20 | 测试 | `video-modes`（模式表）、`adapters`（请求体快照）、`async-providers`（轮询）、`provider-presets`、`app`（端到端）各补一条 | — |

**不需要改**：`db-schema.ts`（新适配器没有历史渠道要回填）、`kinds.ts` 之外的任务分类逻辑。

### 6.3 请求体契约（`buildGenerationRequest`）

```ts
// 模式 → 字段
text-to-video     : { prompt, duration, metadata: { resolution, ratio } }
first-frame       : + metadata.first_frame = <data URL>
first-last-frame  : + metadata.first_frame / metadata.last_frame
reference         : + images[] / videos[] / audios[]（base64 或 URL 混排）
```

规则：

1. `first_frame` / `last_frame` 进 `metadata`；参考图进 `images[]`；参考视频进 `videos[]`；
   参考音频进 `audios[]`。**首尾帧与参考素材互斥**，界面上已按两个入口分开，服务端也要挡。
2. `resolution` **显式传**（`"768P"` 或 `"2K"`），不依赖默认值。
3. **文生模式必须给具体比例**：官方规定 `ratio` 必填且不能是 `adaptive`。适配器里做兜底——
   `mode === "text-to-video" && (ratio === "adaptive" || !ratio)` 时换成 `"16:9"`（或 draft 里选中的值）。
4. 不发送 `generate_audio`（传了也被忽略，见 §一·五）、不发 `seed` / `watermark` / `prompt_extend`。
5. 一个 `prompt` 上限 7000 字符，比项目现有的 20000 严，可按需截断或报错。

### 6.4 五个必须避开的坑

1. **默认分辨率会落到 2K**。`defaultVideoDraft()` 取的是
   `resolutions[Math.min(1, resolutions.length - 1)]`，对 `["768P","2K"]` 正好取到 `"2K"`——
   而 2K 是**二次重生成**（贵、慢、且走另一条上游）。必须给 `VideoCapability` 加
   `defaultResolution` 字段并让 `defaultVideoDraft` 优先用它，否则用户一进页面默认就是最贵的档。
2. **`inlineMediaSize` 只认 `VIDEO_MEDIA_FIELDS`**。不加 `minimaxVideoMedia`，
   MiniMax 的内联素材就完全不受 40 MiB 预算约束。
3. **multipart 路由的"有没有素材"判断**（`/api/generations/reference-media`）只数
   `seedanceVideoMedia`。MiniMax 纯图提交会拿到 `UPLOAD_EMPTY`，必须一起数。
4. **音频只能 base64**，图床拒收（实测 `只支持图片或视频文件`）。别让音频走
   `uploadReferenceMedia(..., "audio")`，那一定 502。
5. **`supportsAudio: false` 的副作用**：确认卡与参数快照会显示「声音：关」。
   实际是有声音的，文案上要说明「H3 自带环境音」，否则用户以为关掉了。

### 6.5 素材走法（已实测，照抄即可）

| 素材 | 走法 | 理由 |
|---|---|---|
| 图片 | **base64**，复用现有 `fileToVideoDataUrl()`（长边 1280 / q0.85） | 9 张最坏约 2.5–3 MB，在 40 MiB 字符预算内，**不需要**单独写预算分配器 |
| 参考视频 | **图床上传换 URL**（`uploadReferenceMedia(..., "video")`） | 50 MB 的 MP4 base64 后 67 MB，会撞穿 40 MiB 预算 |
| 参考音频 | **base64**（`fileToDataUrl`），**不要**走图床 | 图床明确拒收音频：`只支持图片或视频文件` |

### 6.6 验收标准

- `npx tsc --noEmit` 零错误；`npm test` 全绿（注意：跑之前先清掉遗留的 `vitest` 进程，
  它会让整轮挂死十几分钟）。
- 请求体快照测试覆盖四种模式：文生（带具体 ratio）、首帧、首尾帧、参考（图+音频）。
- 真实冒烟（**会花钱，先跟用户确认**）：
  1 条文生 4 秒 768P → 应得到 `1344×768`、带音轨、`metadata.url` 可下载；
  1 条首帧（竖图）→ 应得到 `768×1344`；再 1 条参考图 + 参考音频。
- 若返回 `get_channel_failed`，**不是代码问题**：先拿一个已知能跑的最小请求复测，
  再确认 Key 分组与额度（本次测试用的 Key 已接近 $50 上限）。

## 七、可直接复用的探测脚本（本机 `artifacts/`，未进 git）

真实冒烟时不用重新写请求构造，这些脚本已经处理了 base64、轮询、下载和"到底有没有出图"的验证：

| 脚本 | 用途 |
|---|---|
| `probe-minimax-cases.mjs` | `t2v` / `frame --first=/--last=` / `ref --images=/--videos=/--audios=`，本地文件自动转 base64，URL 原样发送 |
| `probe-minimax-h3.mjs` | `models`、`poll <id>`、`watch <id>`、`download <id> <out.mp4>` |
| `probe-body-limit.mjs` | 零成本探网关 body 上限（用不存在的模型名，不建任务不计费） |
| `mp4-info.mjs` | 读 MP4 分辨率 / 时长 / 音轨数（本地没有 ffmpeg） |
| `video-frames.mjs` | 用无头 Edge + CDP 解出首帧/末帧并读中心像素，用来证明首尾帧图片真的被消费 |
| `video-audio.mjs` | WebAudio 解音轨并给出每秒 RMS，用来判断"有声"还是"空音轨" |

用法示例：

```bash
export MMX_KEY=sk-...
node artifacts/probe-minimax-cases.mjs t2v --resolution=768P --ratio=16:9 --duration=4
node artifacts/probe-minimax-cases.mjs frame --first=path/to/portrait.png --duration=4
node artifacts/mp4-info.mjs artifacts/probe-assets/xxx.mp4
```
