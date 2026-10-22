# Suno 音乐接入 · 交接文档

> 写给下一个对话窗口。Suno 的协议和现有的视频渠道都不同，别按 new-api 的
> `/suno/submit/music` 去改——词元流墟用的是自己的队列接口。

## 实际协议（2026-10-21 实测）

Base URL：`https://api.tiantoken.com`

### 1. 提交

`POST /api/queue/makeAiMusic`

**灵感模式**（`mode=inspiration`）：

```json
{
  "gpt_description_prompt": "轻快的民谣，关于雨后的城市，温暖的人声",
  "mv": "chirp-v3-5",
  "make_instrumental": false
}
```

**自定义歌词**（`mode=custom`）：

```json
{
  "prompt": "歌词……",
  "tags": "独立民谣, 温暖原声, 中速",
  "negative_tags": "重金属, 说唱",
  "mv": "chirp-v3-5",
  "title": "雨后的城",
  "make_instrumental": false
}
```

限制：`gpt_description_prompt` 500 字；`prompt` 5000 字；`tags` / `negative_tags` 1000 字；`title` 80 字。

响应：

```json
{ "code": 200, "data": [148787578, 148787581], "success": true, "message": "请求成功" }
```

`data` 是**两个任务 id**（一次固定出两首）。本地只持久化第一个作为主任务，
轮询它的 `extend` 就能拿到两首。

`mv` 可选值：`chirp-v2-xxl-alpha` / `chirp-v3-0` / `chirp-v3-5` / `chirp-v4` /
`chirp-auk-turbo` / `chirp-auk` / `chirp-bluejay` / `chirp-crow` / `chirp-fenix`。
界面默认 `chirp-v3-5`。

### 2. 轮询

`GET /api/midjourney/drawInfo4?id={taskId}`（路径在 midjourney 下，但确实是音乐任务）

关键字段：

| 字段 | 含义 |
|---|---|
| `data.status` | `1` 排队 / `2` 生成中 / `3` 成功 / `4` 失败 |
| `data.progress` | 0–100 |
| `data.errormsg` | 失败原因 |
| `data.fileInfo` | 主歌曲：`mp3Url`（实际可能是 `.m4a`）、`bigUrl` 封面、`duration` |
| `data.extend` | **JSON 字符串**，数组，一次两首；每首有 `status`、`title`、`audio_url`、`image_url`、`metadata.duration`、`metadata.prompt`（歌词） |

生成中时 `extend[].audio_url` 会返回 `https://studio-api.prod.suno.com/api/forbidden`，
**不能当成品**；只有 `status === "complete"` 的 track 才算强候选。

成功后的真实样例（脱敏）：

```json
{
  "status": 3,
  "progress": 100,
  "fileInfo": {
    "mp3Url": "http://cn2.m4a.bmnmny.cn/{id}.m4a",
    "bigUrl": "https://cdn2.suno.ai/image_{id}.jpeg",
    "duration": 183.52
  },
  "extend": "[{\"title\":\"...\",\"status\":\"complete\",\"audio_url\":\"...\",\"image_url\":\"...\",\"metadata\":{\"duration\":183.52}}, ...]"
}
```

### 3. 下载

- 音频：`audio/x-m4a`，保存为 `.m4a`
- 封面：`image/jpeg`，但 CDN **对没有 User-Agent 的请求回 403**；
  `tasks.ts` 的 `assetDownloadHeaders` 统一补了 `User-Agent: Mozilla/5.0`
- 远端 URL 会过期，成功后必须立刻下载；不要只存链接

## 落盘规则

- 两首音频各存一条 `assets`，`mime_type` 取响应头，`duration` 取 `metadata.duration`，
  `title` 取 track 标题，`lyrics` 取 `metadata.prompt`（灵感模式是系统生成歌词，
  自定义模式是用户歌词；纯音乐会是 `[Instrumental]`，不保存）。
  `assets.title` / `assets.lyrics` 都是本轮新增的列，老行默认空串。
- 封面不复用成第二条 asset：下载后走 `writeThumbnail()`，写进音频行的 `thumb_path`。
  这样历史里不会多出一张「用户没要的图」，缩略图接口又能正常返回封面
- 任何一首下载失败都不影响另一首；封面失败只丢缩略图，不影响听歌

## 代码位置

| 文件 | 作用 |
|---|---|
| `src/server/adapters.ts` | `suno-music` 分支，构造灵感/自定义请求体 |
| `src/server/async-providers.ts` | `sunoStatus` / `sunoResults` / 轮询路径 |
| `src/server/tasks.ts` | `saveAudios`、`fetchAssetBytes`、音频扩展名 |
| `src/shared/provider-presets.ts` | 「词元流墟-音乐」预设，独立环境变量 `TIANTOKEN_SUNO_API_KEY` |
| `src/client/MusicGenerateView.tsx` | 音乐工作台 |
| `src/client/MusicGenerateView.tsx` + `task-ui.tsx` | 播放器、封面、共享状态组件 |
| `src/server/agent-tools.ts` | `generate_music` |
| `src/server/agent.ts` | 音乐确认文案、完成事件摘要、系统提示词 |
| `src/client/chat/ToolCard.tsx` | 对话里的双音频卡片 |
| `src/client/ChatView.tsx` | 音乐灯箱、默认音乐模型 |

## 测试

- `tests/suno-music.test.ts`：工作台链路，提交 → 轮询 → 两首音频 + 封面落盘 → 按 music 范围清空
- `tests/agent-music.test.ts`：对话 `generate_music`，确认策略、异步完成、两首 assetIds
- `tests/async-providers.test.ts`：任务 id / 状态 / 强候选
- `npm test` 当前 20 个文件、257 个用例全过

真实 API 只做过一次灵感模式冒烟（约 3 分钟出两首），没有再重复消耗额度。
联调时如果要再测，优先用 `chirp-v3-5` 和短描述，一次就是两首的费用。

## 其余模式（已实现）

所有模式都走 `POST /api/queue/makeAiMusic`，提交后还是轮询 `drawInfo4`，结果形状一致。

| 模式 | `musicMode` | 关键字段 |
|---|---|---|
| 灵感 | `inspiration` | `gpt_description_prompt` |
| 自定义歌词 | `custom` | `prompt` + `tags` + `title` |
| 翻唱 | `cover` | `task=cover`、`cover_clip_id`（源曲 `extend[].id`） |
| 混音 | `mashup` | `task=mashup_condition`、`mashup_clip_ids` 两首 |
| 音效 | `sound` | `task=sound`、`metadata.sound_configs`（BPM/调性/循环） |
| 歌单风格 | `playlist` | `task=playlist_condition` |
| 取样 | `sample` | `task=chop_sample_condition`（文档标记开发中） |

翻唱/混音的源曲必须是**本账号生成的歌**：提交响应里的两个任务 id 不是 `custom_id`，
真正的 `custom_id` 在轮询结果的 `extend[].id`。现在每条音频 asset 都存了
`remote_clip_id`，旧歌可以从诊断记录回填；工作台会列出这些歌供选择。

真实 cover 冒烟：用《机圈擂台》的 `custom_id` + `chirp-v3-5-tau` 提交成功，
返回两个新任务 id，确认字段可用。歌词生成接口文档 404，本轮不接。

## 已知限制

- 只持久化两个任务 id 中的第一个；如果第一个任务失败而第二个成功，当前会判整体失败。
  实测两首同步完成，暂不处理。
- 封面 CDN 403 的兜底没有覆盖所有网络环境；失败时历史显示通用音乐图标。
- 音乐任务不进画布，也不能作为图片参考（预期行为）。
- 音乐默认确认策略沿用 `auto_only`：用户明确要歌直接提交，自动续跑时先问。
