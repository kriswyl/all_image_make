# 视频/音频本地上传改造（Codex 开发交接）

> 状态：待开发
> 适用范围：万相视频（`wan-video`）、可灵视频（`kling-video`）

---

## 1. 目标

把视频生成里「必须填公网地址」的素材，改成可以在应用内直接选本地文件：

1. **视频素材**：本地选择 MP4 / MOV → 服务端转发到中转站的图床 → 拿回公网 URL → 填进现有 URL 槽位。
   - **保留手动填 URL 的入口**，图床不可用时仍可粘贴地址。
2. **音频素材**：本地选择音频 → 前端转成 `data:audio/...;base64,...` → 直接作为万相 `reference_audio` 发送，不经过图床。
   - 已验证：词元流墟接受 base64 音频，任务能正常完成。
3. **统一内联素材预算为 15MB**，并在代码注释、UI 提示、README / VIDEO_HANDOFF / CHANGELOG 中写清楚。

不做的事：

- 不改变图片素材的本地压缩逻辑（`fileToVideoDataUrl` 继续用 1280px JPEG）。
- 不接第二家图床；只使用渠道自己配置的上传地址。
- 不为可灵增加音频输入（可灵没有音频素材）。

---

## 2. 已验证的事实（2026-10-28 / 10-29 实测）

| 结论                 | 证据                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------- |
| 图床支持图片和视频          | `POST https://imageproxy.zhongzhuan.chat/api/upload`，`image/*`、`video/*` 返回 200         |
| 图床拒绝音频             | `audio/mpeg`、`audio/wav` 返回 400：`只支持图片或视频文件，当前类型: audio/mpeg`                           |
| 图床返回格式             | `{"url":"https://imageproxy.zhongzhuan.chat/api/proxy/image/<hash>.mp4","created":...}` |
| 图床 HEAD 404，GET 正常 | 不要用 HEAD 做可用性校验；客户端和上游都应按 GET 处理                                                        |
| 万相接受 base64 音频     | 1 秒 WAV data URI（约 21K 字符）提交 `reference_audio`，任务 `completed`，输出 mp4 带音频轨               |
| 中转站网关能收大 body      | 无效模型探测：1 / 2 / 3 / 4 / 6 / 8 / 10 / 12 / 16 / 20 MB 都返回正常 JSON，没有 413/502               |
| `1.4MB` 是应用自己的常量   | `tasks.ts:36`，来自 2026-10-12 的旧经验（1MB 过、2MB 掐断），不是官方硬限制                                  |
| 万相官方素材上限           | 图片 20MB、参考音频 15MB、参考视频 100MB                                                            |
| 当前万相渠道可能临时不可用      | 测试期间 `wan3.0-video` 返回 `get_channel_failed`（可用渠道不存在），与 body 大小无关                        |

**因此：**

- 视频走图床 URL（base64 视频体积太大，不现实）。
- 音频走 base64（图床不收音频，但中转站/上游接受 data URI）。
- 15MB 预算只是应用侧的安全阈值，不是上游限制；保留它是为了在超限时给出明确错误，而不是等 502。

---

## 3. 现状与关键文件

| 文件                                 | 作用                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/client/VideoGenerateView.tsx` | 视频工作台；`WAN_MODES` / `SEEDANCE_MODE_SPECS` / `KLING_MODE_CAPABILITIES` 的 UI、`buildWanMedia()`、`buildKlingMedia()`、URL 输入框 |
| `src/client/api.ts`                | 前端 API 封装（`request()`、`api.generate()`）                                                                                  |
| `src/shared/types.ts`              | `Channel`、`ChannelInput`、`VideoMediaInput`、`KlingMediaInput`、`GenerationInput`                                           |
| `src/shared/provider-presets.ts`   | 词元流墟等预设；`ChannelUnitPreset` / `ProviderPreset` / `buildChannelDrafts()`                                                  |
| `src/server/app.ts`                | Express 路由、multer、`channelSchema`、`generationSchema`、`resolveChannelKey()`                                               |
| `src/server/db.ts`                 | `DbChannel`、`saveChannel()`、`channelFromRow()`                                                                           |
| `src/server/db-schema.ts`          | `initializeSchema()` 与所有 ALTER TABLE 迁移                                                                                  |
| `src/server/tasks.ts`              | `MAX_INLINE_MEDIA_CHARS`、`inlineMediaSize()`、`TaskRunner.create()`                                                       |
| `src/server/adapters.ts`           | `buildWanMedia()` 把 `wanVideoMedia` 塞进请求体                                                                                |
| `src/server/key-store.ts`          | 渠道密钥存储；`KeyStore.get(channelId)`                                                                                         |
| `src/server/async-providers.ts`    | 异步任务轮询（本次不改）                                                                                                             |

关键现有逻辑：

- 图片：前端 `fileToVideoDataUrl()` 把本地图片压成 1280px JPEG，再转 data URI。
- 万相：`buildWanMedia()` 把 `urlSlots` 的字符串原样放进 `media[]`，只允许 `http(s)://` 或 `oss://`。
- 可灵运动控制：`klingReferenceVideoUrl` 只允许 `http(s)://`。
- 服务端 `inlineMediaSize()` 已经统计所有 `wanVideoMedia` / `seedanceVideoMedia` / `klingVideoMedia` 中 `data:` 开头的 URL 字符数。
- 服务端 `resolveChannelKey(channel, sessionKeys)` 能从渠道 id 取到密钥；上传接口必须由服务端调用，不能把 key 暴露给前端。

---

## 4. 需求拆解

### 4.1 统一内联预算为 15MB

**改动点**：`src/server/tasks.ts`

```ts
// 15MB 是应用侧安全预算，不是上游硬限制。
// 单位是 data URI 的字符数；base64 约放大 1.33 倍，所以约等于 11.25MB 原始二进制。
// 2026-10-29 实测：中转站网关可接收 ≥20MB 的请求体。
const MAX_INLINE_MEDIA_CHARS = 15 * 1024 * 1024;
```

同时：

- `inlineMediaSize()` 已经统计全部 media，不需要改逻辑；只改常量。
- `TaskRunner.create()` 的报错文案从「内联图片合计约 …」改成「内联素材合计约 …，超出 15MB 预算…」。
- 更新所有提到 `1.4MB` 的注释 / 提示：
  - `src/client/VideoGenerateView.tsx:579`
  - `src/shared/types.ts:123` 附近
  - `src/server/vision.ts` 的注释
  - `VIDEO_HANDOFF.md`
  - `CHANGELOG.md`（新增条目，不要改历史版本）
- `MAX_MEDIA_URL_CHARS = 28_000_000`（`app.ts`）保留；15MB 总预算会先生效。

**注意**：如果产品要求的是「15MB 原始二进制」而不是「15MB 请求体字符」，则应改成 `20 * 1024 * 1024` 字符（15MB × 4/3）。本文按「15MB 请求体字符」实现，代码注释必须写清楚这个区别。

### 4.2 视频：图床上传 + URL 兜底

**新增渠道字段**

`src/shared/types.ts`：

```ts
export interface Channel {
  // ...现有字段
  /** 中转站提供的素材上传地址；为空表示该渠道不支持应用内上传 */
  uploadEndpoint: string;
  /** 调上传地址时额外带的请求头，例如 { "New-Api-User": "1" } */
  uploadHeaders: Record<string, string>;
}
```

`ChannelInput` 继承 `Channel`，会自动带上这两个字段。

`src/server/db.ts` 的 `DbChannel` 增加：

```ts
uploadEndpoint: string;
uploadHeaders: Record<string, string>;
```

`src/server/db-schema.ts`：

1. `CREATE TABLE IF NOT EXISTS channels` 里加两列：

   ```sql
   upload_endpoint TEXT NOT NULL DEFAULT '',
   upload_headers_json TEXT NOT NULL DEFAULT '{}'
   ```
2. 在现有的 `PRAGMA table_info(...)` 迁移区加：

   ```ts
   const channelColumns = db.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
   if (!channelColumns.some((c) => c.name === "upload_endpoint")) {
     db.exec("ALTER TABLE channels ADD COLUMN upload_endpoint TEXT NOT NULL DEFAULT ''");
   }
   if (!channelColumns.some((c) => c.name === "upload_headers_json")) {
     db.exec("ALTER TABLE channels ADD COLUMN upload_headers_json TEXT NOT NULL DEFAULT '{}'");
   }
   // 回填已有的词元流墟渠道
   db.prepare(`
     UPDATE channels
     SET upload_endpoint = 'https://imageproxy.zhongzhuan.chat/api/upload',
         upload_headers_json = '{"New-Api-User":"1"}'
     WHERE base_url = 'https://api.tiantoken.com' AND upload_endpoint = ''
   `).run();
   ```

`src/server/db.ts` 的 `channelFromRow()` / `saveChannel()` 同步读写这两列（`upload_headers_json` 用 `JSON.parse`，非法值时回退 `{}`）。

**预设**

`src/shared/provider-presets.ts`：

```ts
export interface ProviderPreset {
  // ...现有字段
  /** 该站点支持的素材上传地址；没有就留空 */
  uploadEndpoint?: string;
  uploadHeaders?: Record<string, string>;
}
```

给 `tiantoken` 系列预设（至少 `tiantoken-wan-video`、`tiantoken-kling-video`）加：

```ts
uploadEndpoint: "https://imageproxy.zhongzhuan.chat/api/upload",
uploadHeaders: { "New-Api-User": "1" },
```

`buildChannelDrafts()` 里把这两个字段写进 `ChannelInput`。新用户从预设创建渠道时会自动带上；老用户由上面的 SQL 回填。

**channelSchema**

`src/server/app.ts` 的 `channelSchema` 增加：

```ts
uploadEndpoint: z.string().trim().url().or(z.literal("")).default(""),
uploadHeaders: z.record(z.string(), z.string()).default({}),
```

`publicChannel()` 是展开 `DbChannel` 的，所以只要 `DbChannel` 加上这两个字段，前端 `/api/channels` 就会自动返回。

**服务端上传路由**

`src/server/app.ts` 新增：

```ts
const referenceVideoMimeTypes = ["video/mp4", "video/quicktime"] as const;

const referenceVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 1 },
  fileFilter: (_req, file, callback) =>
    referenceVideoMimeTypes.includes(file.mimetype as typeof referenceVideoMimeTypes[number])
      ? callback(null, true)
      : callback(new AppError("REFERENCE_VIDEO_INVALID", "仅支持 MP4 / MOV 视频", 400)),
});

app.post("/api/uploads/reference-video", referenceVideoUpload.single("file"), asyncHandler(async (req, res) => {
  const channelId = String(req.body.channelId ?? "");
  const channel = db.getChannel(channelId);
  if (!channel) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
  if (!channel.uploadEndpoint) throw new AppError("UPLOAD_UNSUPPORTED", "该渠道未配置视频上传服务", 400);
  if (!req.file) throw new AppError("UPLOAD_EMPTY", "没有收到视频文件", 400);

  const key = resolveChannelKey(channel, sessionKeys);
  const form = new FormData();
  form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

  let response: Response;
  try {
    response = await fetch(channel.uploadEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, ...channel.uploadHeaders },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new AppError("UPLOAD_FAILED", `上传视频失败：${error instanceof Error ? error.message : "网络错误"}`, 502);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AppError(
      "UPLOAD_FAILED",
      `上传视频失败：HTTP ${response.status}${text ? ` - ${text.slice(0, 200)}` : ""}`,
      502,
    );
  }

  let payload: unknown;
  try { payload = JSON.parse(text); } catch { /* ignore */ }
  const url = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).url === "string"
    ? String((payload as Record<string, unknown>).url)
    : "";
  if (!/^https?:\/\//i.test(url)) throw new AppError("UPLOAD_FAILED", "上传服务没有返回有效的公网地址", 502);

  res.status(201).json(ok({ url }));
}));
```

注意事项：

- 不要用 `HEAD` 校验返回的 URL；图床 HEAD 是 404。
- 不要把 `key`、文件内容、base64 写进日志或诊断。
- 上传失败必须保留前端的手动 URL 输入。
- 如需校验上传结果，用 `GET` + `Range: bytes=0-0`，失败也不影响主流程（图床可能限制 Range）。
- 这个路由只允许 `video/mp4`、`video/quicktime`；图床虽然收 webm，但万相/可灵文档只保证 mp4/mov。

**前端 API**

`src/client/api.ts`：

```ts
uploadReferenceVideo: (channelId: string, file: File) => {
  const form = new FormData();
  form.append("channelId", channelId);
  form.append("file", file, file.name);
  return request<{ url: string }>("/api/uploads/reference-video", { method: "POST", body: form });
},
```

**前端 UI**

`src/client/VideoGenerateView.tsx`：

1. 万相的 `WAN_MODES` URL 槽位里，`reference_video` 需要上传按钮；`reference_audio` 需要音频上传按钮。
2. 可灵 `klingCap.needsReferenceVideo` 的「参考视频」区域需要上传按钮。
3. 按钮放在 URL 输入框旁边，**URL 输入框保留**：

```
[ 上传视频 ]  [ https://… 或 oss://…            ]
已上传：flower.mp4（1.1 MB）  [清除]
```

4. 上传成功后把返回的 `url` 写进现有状态：
   - 万相：`setUrlInputs({ ...urlInputs, reference_video: url })`
   - 可灵：`setKlingReferenceVideoUrl(url)`
5. 上传中禁用按钮并显示进度/加载态；失败用 `props.onToast("error", message)`。
6. 前端预校验：
   - MIME：`video/mp4`、`video/quicktime`
   - 大小：≤100MB（与上游一致）
   - 时长：万相参考视频 1–15 秒；可灵运动控制 ≥3 秒，角色朝向「图片」≤10 秒、「视频」≤30 秒
   - 时长用 `<video>` 的 `loadedmetadata` 读取，失败时给出明确提示
7. 如果 `channel.uploadEndpoint` 为空：隐藏上传按钮，只显示 URL 输入框，并在提示里说明「该渠道需要手动填写公网地址」。
8. 上传后的文件是公网可访问的，UI 必须提示：「上传后文件可通过公网访问，请勿上传敏感内容」。

**可灵相关**：`buildKlingMedia()` 里仍然只接受 `http(s)://`；上传按钮只是帮用户把 URL 填进去，不需要改 media 结构。

### 4.3 音频：本地 base64

**只针对万相 `reference_audio`。** 图床不收音频，所以不经过上传路由。

**类型注释**（`src/shared/types.ts`）：

- `VideoMediaInput.url` 的注释从「仅图像支持 base64」改成「图片/音频支持 data URI；视频必须公网 URL」。
- `GenerationInput.wanVideoMedia` 的注释同步更新。

**前端**

`VideoGenerateView.tsx`：

1. 新增状态：

   ```ts
   const [audioUpload, setAudioUpload] = useState<{
     type: VideoMediaType; // 目前只有 reference_audio
     fileName: string;
     dataUri: string;
     size: number;
   } | null>(null);
   ```
2. 在 `reference_audio` 槽位加「上传音频」按钮，接受：
   - `audio/mpeg`（mp3）
   - `audio/mp4`（m4a/aac）
   - `audio/aac`
   - `audio/wav`
3. 读取文件：

   ```ts
   const dataUri = await fileToDataUrl(file); // 复用现有 helper
   ```
4. 校验：
   - 时长 ≤15 秒（用 `<audio>` 的 `loadedmetadata` 读）
   - 原始文件 ≤15MB（上游限制）
   - data URI 长度 ≤ `MAX_INLINE_MEDIA_CHARS`（15MB 字符）；考虑其他素材后留 10% 余量
   - 超限提示：「音频过长或过大，请换成 15 秒以内的 MP3 / M4A」
5. `buildWanMedia()` 里，`reference_audio` 优先使用 `audioUpload.dataUri`，其次才用 URL 输入：

   ```ts
   for (const slot of spec.urlSlots) {
     if (slot.type === "reference_audio" && audioUpload) {
       media.push({ type: "reference_audio", url: audioUpload.dataUri });
       continue;
     }
     // 原有 URL 逻辑
   }
   ```
6. 切换模式 / 渠道时清空 `audioUpload`，和现有图片清理逻辑一致。
7. UI 显示文件名、时长、大小和「清除」按钮；不要把一个巨大的 base64 字符串塞进可见的文本框。
8. URL 输入框继续保留，作为手动地址的兜底；两者同时存在时，上传的音频优先，并在 UI 上说明。

**服务端**

- `inlineMediaSize()` 已经统计 `wanVideoMedia` 的 data URI，不需要改逻辑。
- 只需把 `MAX_INLINE_MEDIA_CHARS` 调到 15MB、更新报错文案。
- `generationSchema.wanVideoMedia.url` 的 `max(MAX_MEDIA_URL_CHARS)` 保留（28M），实际由 15MB 总预算兜底。
- `adapters.ts` 的 `buildWanMedia()` 不需要改：它原样转发 `wanVideoMedia` 的 url。
- `app.ts` 里 `wanVideoMedia` 的注释「视频音频走公网」要改。

**为什么可行**：2026-10-29 实测，1 秒 WAV data URI（21K 字符）作为 `reference_audio` 提交后，任务 `completed`，输出 mp4 带音频轨。

### 4.4 文档同步

实现时必须同步更新：

1. `README.md` 的功能说明：
   - 视频：本地 MP4/MOV 可上传到渠道图床，保留公网 URL 手动输入。
   - 音频：本地音频转 base64 直接提交，限 15 秒 / 15MB。
2. `VIDEO_HANDOFF.md`：
   - 把所有「只接受公网地址」「1.4MB」的描述改成新行为。
   - 增加「视频图床上传」「音频 base64」两节。
3. `CHANGELOG.md`：新增 `## 未发布` 或下一个版本条目，写清：
   - 统一 15MB 内联预算
   - 视频本地上传（图床）+ URL 兜底
   - 音频本地 base64 上传
4. `src/shared/types.ts` / `src/server/vision.ts` / `src/client/VideoGenerateView.tsx` 里所有 1.4MB 注释。
5. `MEDIA_UPLOAD_HANDOFF.md`（本文件）保留，作为设计依据。

---

## 5. 实施顺序（建议）

1. **常量与文案**：`tasks.ts` 改 15MB；全局搜索 `1.4MB` / `1_400_000`，更新注释与 UI 提示。
2. **数据模型**：`types.ts` → `db-schema.ts` → `db.ts`；跑一次 `npm test` 确认迁移不影响现有测试。
3. **预设与渠道**：`provider-presets.ts` + `buildChannelDrafts()`；老渠道由迁移 SQL 回填。
4. **服务端上传路由**：`app.ts`（multer + 路由 + channelSchema）。
5. **前端 API**：`client/api.ts`。
6. **视频 UI**：`VideoGenerateView.tsx` 的万相 URL 槽位 + 可灵运动控制；保留 URL 输入。
7. **音频 UI**：`reference_audio` 上传、`buildWanMedia()` 优先级、切换清理。
8. **样式**：`styles.css` 增加上传按钮 / 文件 chip 的样式，沿用现有 token（圆角 10/12、中性灰）。
9. **测试**：见第 6 节。
10. **文档**：见 4.4。

---

## 6. 测试计划

### 6.1 单元 / 集成测试

- `inlineMediaSize()`：
  - 小于 15MB 通过
  - 大于 15MB 报 `INVALID_INPUT`，文案包含「内联素材」「15MB」
- 视频上传路由（用本地 mock HTTP server，不要打真实图床）：
  - 正确转发 `Authorization` 和 `New-Api-User`
  - 解析 `{url}` 并返回 201
  - 上游 401/404/413 映射成可读错误
  - 非 mp4/mov 被 multer 拒绝
- `buildWanMedia()`：
  - `audioUpload` 存在时优先使用 data URI
  - 没有 `audioUpload` 时回退 URL
  - 15MB 边界
- 现有 270+ 测试必须全过。

### 6.2 手动测试

前置：确认 `wan3.0-video` 渠道在词元流墟上可用（测试期间曾出现 `get_channel_failed`）。

1. 万相「参考生视频」：上传一个 3 秒 MP4 → URL 自动填入 → 生成成功。
2. 万相「参考生视频」：上传一个 3 秒 MP3 → 作为 base64 发送 → 生成成功。
3. 万相「视频编辑 / 视频延长」：上传 MP4 → 生成成功。
4. 可灵「运动控制」：上传角色图 + 参考视频 → 生成成功。
5. 图床不可用（把 uploadEndpoint 改成无效地址）：上传报错，URL 输入框仍可用。
6. 音频 20 秒 / 20MB：本地明确拒绝，不发请求。
7. 视频 120MB：本地明确拒绝。
8. 切换模式 / 渠道：上传的音视频被清空，不串到下一个模式。

### 6.3 命令

```bash
npm test
npm run build
# 可选：完整打包
npm run release:installer
```

---

## 7. 验收标准

- [ ] `MAX_INLINE_MEDIA_CHARS = 15 * 1024 * 1024`，注释说明单位与 base64 放大关系。
- [ ] 代码与文档中不再有「1.4MB」作为当前限制的描述（历史 CHANGELOG 条目除外）。
- [ ] 万相 `reference_video` / `video-edit` / `video-extend` 有「上传视频」按钮，成功后自动填 URL。
- [ ] 可灵运动控制有「上传视频」按钮，成功后自动填 URL。
- [ ] URL 输入框始终保留，上传失败时可手动粘贴。
- [ ] 万相 `reference_audio` 有「上传音频」按钮，发送的是 `data:audio/...;base64,...`。
- [ ] 音频/视频上传前有格式、大小、时长校验，错误文案明确。
- [ ] 上传路由不把 key 暴露给前端，不写日志。
- [ ] 15MB 超限时服务端返回明确错误，不发上游请求。
- [ ] `npm test` 与 `npm run build` 全过。
- [ ] README / VIDEO_HANDOFF / CHANGELOG 已同步。

---

## 8. 风险与注意事项

1. **图床是未文档化接口**：`api.tiantoken.com/api/upload` 是 404，真实地址是 `imageproxy.zhongzhuan.chat`。必须做成渠道配置 + URL 兜底，不能硬编码成唯一路径。
2. **HEAD 404**：不要用 HEAD 校验；用 GET。
3. **文件是公开的**：上传后的 URL 任何人可访问。UI 要提示，且不要把用户敏感素材默认上传。是否支持删除由服务商决定，当前未知。
4. **图床保留时间未知**：异步任务可能跑几分钟，必须确认链接在任务期间有效；上线前实测 1 小时 / 24 小时。
5. **格式限制**：图床收 webm，但万相/可灵文档只保证 mp4/mov；前端只放行 mp4/mov。
6. **渠道可用性**：测试期间 `wan3.0-video` 出现 `get_channel_failed`；这是服务商侧问题，不是本次改造引起的。手动 E2E 前先确认渠道可用。
7. **密钥安全**：上传路由在服务端读取 `KeyStore`，不要把 key 传给前端；不要把 base64 / 文件内容写进日志或诊断。
8. **15MB 的单位**：当前常量是字符数。若产品要的是 15MB 原始二进制，应改为 `20 * 1024 * 1024` 字符并同步文档。
9. **不要动现有图片链路**：图片继续走 1280px JPEG data URI；本次只改视频和音频。
10. **测试不要打真实图床**：CI 里用本地 mock server；真实上传只放在手动测试。

---

## 9. 附录

### 9.1 图床上传请求

```bash
curl -X POST "https://imageproxy.zhongzhuan.chat/api/upload" \
  -H "Authorization: Bearer <channel key>" \
  -H "New-Api-User: 1" \
  -F "file=@flower.mp4;type=video/mp4"
```

响应：

```json
{"url":"https://imageproxy.zhongzhuan.chat/api/proxy/image/<hash>.mp4","created":1793253970632}
```

### 9.2 万相 base64 音频请求体（已验证）

```json
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "一只橘猫在草地上慢慢走动",
    "media": [
      { "type": "reference_audio", "url": "data:audio/wav;base64,...." }
    ]
  },
  "parameters": { "resolution": "480P", "duration": 2, "audio": true }
}
```

### 9.3 关键代码位置

- `src/server/tasks.ts:36` — `MAX_INLINE_MEDIA_CHARS`
- `src/server/tasks.ts:200` — 超限报错
- `src/server/tasks.ts:920` — `inlineMediaSize()`
- `src/server/app.ts:47` — multer 与 `MAX_MEDIA_URL_CHARS`
- `src/server/app.ts:276` — `generationSchema`
- `src/server/app.ts:719` — `/api/generations`
- `src/server/app.ts:1332` — `resolveChannelKey()`
- `src/client/VideoGenerateView.tsx:78` — 万相 URL 槽位
- `src/client/VideoGenerateView.tsx:567` — 可灵参考视频输入
- `src/client/VideoGenerateView.tsx:278` — `buildWanMedia()`
- `src/client/VideoGenerateView.tsx:336` — `buildKlingMedia()`
- `src/shared/types.ts:123` — 视频素材类型注释
- `src/server/db-schema.ts:8` — channels 表
- `src/shared/provider-presets.ts:161` — 词元流墟万相预设
