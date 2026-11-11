# 视频生成功能 · 交接文档

> 写给下一个对话窗口的自己。读完这份就能接上，不需要翻历史。

**工程根目录**：`D:\codexuse\shengtu\all_image_make`（git 仓库，主分支 `main`）

## 当前状态

| 项目 | 状态 |
|---|---|
| TypeScript | `npx tsc --noEmit` 零错误 |
| 单元测试 | `npm test` → 124 文件 / 961 项全通过（含视频相关 72 项） |
| 开发服务 | 前端 `127.0.0.1:5173`，API `127.0.0.1:17891` |
| 真实 API 联调 | Seedance **已跑通**（见下）；万相 / Grok 仍只测到 mock 上游 |

前端端口由 `package.json` 的 `dev:web`（`vite --host 127.0.0.1 --port 5173`）固定，`.claude/launch.json` 与之一致，可以直接用 preview 工具起服务。若 5173 被别的进程占用，vite 会自己退到 5174，这时预览要改成实际端口。

## 已完成的功能

### 四种视频渠道

| 适配器 | 渠道预设 | 模型 |
|---|---|---|
| `wan-video` | 词元流墟-万相视频 | wan3.0-video |
| `grok-video` | 词元流墟-grok视频 | grok-imagine-video / -1.5-preview / -1.5 |
| `seedance-video` | 词元流墟-seedance视频 | sd-2.5 / sd-2.0 / sd-2.0-fast / sd-2.0-mini |
| `kling-video` | 词元流墟-可灵视频 | kling-3.0 / kling-3.0-turbo / kling-3.0-omni |

`provider-presets.ts` 里一共 11 个预设，全部按「模型系列」平铺成独立模板，不按站点合并：向量引擎 3 个（gpt / gpt-c / gemini），词元流墟 8 个（gpt / gpt-c / gemini / 万相 / grok / seedance / 可灵 / suno）。

### 可灵（Kling）

可灵走的是**原生格式**，不是 `/v1/video/generations`：

| 模式 | 提交路径 | 请求体 |
|---|---|---|
| 文生视频 | `POST /text-to-video/{model}` | `{ prompt, settings, options }` |
| 图生视频（首帧） | `POST /image-to-video/{model}` | `{ contents: [{type:"prompt",text},{type:"first_frame",url}], settings, options }` |
| Omni | `POST /omni-video/kling-3.0-omni` | `contents` 可含 `prompt/first_frame/last_frame/refer_image/...` |
| 运动控制 | `POST /motion-control/kling-3.0` | `contents` 含 `prompt/image/video`，`settings.character_orientation` 必填 |
| 查询 | `GET /tasks?task_ids={id}` | 返回 `data[].status` 和 `data[].outputs[].url` |

- **body 不带 `model`**，模型固定在路径里
- **模式按模型开放**：`kling-3.0` 有文生/首帧/首尾帧/运动控制；`turbo` 有文生/首帧/首尾帧；`omni` 有文生/首帧/首尾帧/参考图
- 文生/图生/Omni 的 `resolution` 支持 `720p` / `1080p` / `4k`；运动控制只到 `1080p`
- 音频档位：文生/图生/Omni 是 `off` / `native`；运动控制是 `off` / `original`
- 文生/Omni 有 `aspect_ratio`（16:9 / 9:16 / 1:1）；图生视频和运动控制**没有**这个字段
- `duration` 3–15 秒；运动控制没有 `duration`，时长由参考视频决定（朝向选图片 ≤10 秒、选视频 ≤30 秒）
- `multi_shot` 默认 true；运动控制没有这个字段
- 查询状态是 `submitted / processing / succeeded / failed`，不是统一接口的 status 形状；已在 `async-providers.ts` 单独适配
- **不要完全相信文档的「尾帧暂未开放」**：2026-10-22 实测 `kling-3.0` 与 `kling-3.0-turbo` 的 `/image-to-video` 都接受 `first_frame + last_frame`，3 秒 720p 任务成功；抽最后一帧与输入尾帧一致。所以非 Omni 也开放首尾帧
- 参考图实测仍只属于 Omni：普通 `/image-to-video` 只传 `refer_image` 时返回 400 `content item of type 'first_frame' is required`
- Omni 的参考图走 `refer_image`
- 运动控制参考视频通过渠道配置的图床上传本地 MP4/MOV（页面不再提供粘贴公网地址的输入）；上传结果可通过公网访问。
- Omni 文档里的 `element` / `voice` / `feature_video` / `base_video` 需要可灵素材库或额外视频输入，工作台暂未开放；参考图走 `refer_image`
- `kling-3.0-turbo` 走同样的原生路径；默认打开音频，避免只配置了 `audio` 计费档时被拒
- **Key 必须属于 `kling专属` 分组**。模型列表里能看到 Kling 不代表当前 Key 能调用；不在该分组时会报 `get_channel_failed ... 可用渠道不存在`
- **提交响应里的 `request_id` 不是任务 id**：任务 id 在 `data.id`（形如 `task_...`）。通用 `extractAsyncTaskId` 会先抓到 `request_id`，所以 Kling 必须用 spec 里的 `extractTaskId` 覆盖
- 用错 id 去查 `/tasks?task_ids=` 会持续返回 HTTP 400，任务会一直显示 running 直到超时
- 真实联调已完成：`kling-3.0`、5 秒、720p、无声，约 2.5 分钟完成；app 内落盘为 `video/mp4`、5.041 秒、约 5.6MB
- 首尾帧联调：`kling-3.0` 与 `kling-3.0-turbo` 各提交一条 3 秒 720p 首尾帧任务，均 `succeeded`；首条约 30 秒出片
- Omni 参考图联调：`kling-3.0-omni` + 2 张 `refer_image`，3 秒 720p、无声、16:9，约 4 分 23 秒完成
- 运动控制联调：`kling-3.0` + 角色图 + 10 秒舞蹈视频，720p、无声，约 10 分 49 秒完成；输出 10.0 秒、约 11.8MB，人物来自角色图、动作跟随参考视频
- 运动控制提交后前 8 分钟一直是 `submitted`，之后才转 `processing`；轮询上限（10 秒 × 120 次）足够，但不要再缩短
- 真实 cover/任务 id 关系见 `SUNO_HANDOFF.md`；这里只记 Kling

### 请求体格式（几家都不同，改代码时注意）

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
| kling-video | `/text-to-video/{model}` / `/image-to-video/{model}` / `/omni-video/{model}` | `/tasks?task_ids={id}` |

提交路径统一在 `src/shared/adapter-endpoints.ts`；轮询路径集中在 `src/server/async-providers.ts` 的 `AsyncProviderSpec`。新增渠道不要再往 `tasks.ts` 里写 switch。

提交与轮询都必须走 `security.ts` 的 `joinEndpoint()` 拼 URL。曾经轮询是直接 `channel.baseUrl + path` 拼的，Base URL 填成 `https://api.x.com/`（带尾斜杠）时会「提交成功、轮询 404」，而 404 的响应体既可能被当成「还在跑」而一路轮询到超时，也可能是 HTML 解析失败报成内部错误——两种情况都不指向真正的原因。现在 404 直接判 `REMOTE_TASK_NOT_FOUND`。测试用带尾斜杠的 Base URL 专门盯这条。

### 前端模式选择器

`VideoGenerateView.tsx` 里两套模式表，结构同构（都是 `WanModeSpec`）：

- `WAN_MODES` — 7 种：文生视频 / 首帧 / 首尾帧 / 参考 / 视频编辑 / 视频延长 / 参考文件
- `SEEDANCE_MODE_SPECS` — 4 种：文生视频 / 首帧 / 首尾帧 / 参考图

Grok 没有模式概念，只按「有没有参考图」区分文案。

每套模式声明的 `imageSlots` 决定上传几张图、每张标什么 role；`acceptsReferenceVideo` / `needsReferenceVideo` / `acceptsReferenceAudio` 决定素材槽，素材一律本地文件上传（页面没有粘贴地址的入口）。切模式不销毁素材，按 `adapter:mode` 分桶各存一份。

### 关键约束（已实现，别改坏）

- Seedance **2.5** 首帧/首尾帧模式下宽高比锁死 `adaptive`（官方 2.5 要求），2.0 不锁；选择器按模型版本判断
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

   客户端继续将大图压到长边 1280 的 JPEG（`fileToVideoDataUrl()` / `downscaleToJpeg()`）；服务端对所有内联素材合计设置 15 MiB 字符预算，base64 大约放大三分之一。

### 本地视频和音频素材

- 万相参考视频和可灵运动控制支持本地 MP4/MOV 经渠道图床上传（页面只保留这条路径）；图床链接是公开的。渠道上传地址和附加请求头可在渠道设置中配置。
- 万相参考音频支持本地 MP3/M4A/AAC/WAV，最多 15 秒、15 MB，转成 data URI 后计入 15 MiB 字符总预算；上传音频优先于手动地址。

   注意只有 `data:` 开头的内联 base64 才算进这个预算，公网 / `oss://` 地址不占请求体。

9. **桌面版拖不进图片，浏览器里却是好的** —— Tauri 窗口默认 `dragDropEnabled: true`，系统级的拖放处理器把文件拦在 webview 前面，前端根本收不到 `drop` 事件（tauri 自己的文档写着：Disabling it is required to use HTML5 drag and drop on the frontend on Windows）。`src-tauri/tauri.conf.json` 的窗口里显式写了 `"dragDropEnabled": false` 才正常。**前端代码一直是对的，改这个必须重新构建桌面版才生效**——Web 开发模式下永远看不出这个毛病，所以以前「浏览器里验过」并不能说明桌面版能用。

## 重启恢复与诊断体积（最近一轮改动）

### 重启不再丢掉正在生成的视频

以前服务一重启，进行中的任务一律标成 `SERVICE_RESTARTED`，用户白等一场。现在：

- 提交成功后立刻把上游 task id 写进 `tasks.remote_task_id`（这一列和索引本来就有，之前从没写过值）
- `TaskRunner.resume()` 对「有 `remote_task_id` 且渠道仍是视频适配器」的任务**重新进入轮询**（`resumePolling()`，第一轮不再等 8 秒），其余的才标记失败
- 恢复轮询和正常轮询共用 `pollVideoTask()`，所以状态判断、失败原因、诊断记录的逻辑只有一份

万相 / Grok / Seedance 的上游任务通常活得比进程久，重启后接着等是有意义的；反过来渠道被删了就没有密钥可用了，只能判失败。

### 诊断表不再无限增长

一个视频任务最多轮询 100 次，每次写完整响应能堆到几 MB（用户库里的 `app.db` 就是这么涨到 31MB 的）。现在改成**首尾完整 + 中间精简**：

| 记录 | 内容 |
|---|---|
| 提交请求 | 完整请求体 + 完整响应 |
| 第 1 … N-1 次轮询 | `request: null`，`response: { poll, status, progress }`，一行不到 100 字符 |
| 第 N 次轮询（无论成功 / 失败 / 超时） | 完整响应 |

实现方式是一个 `pending` 缓冲：拿到新一次轮询结果时，才把上一次降级写库；外层 `try/finally` 里的 `flushPending()` 保证最后一次**一定是完整的**——超时或失败时没有「成功的那一次」，最后一条就是最有用的那条。

注意 `diagnostics.created_at` 只到毫秒，「上一条精简行 + 本次完整行」会在同一毫秒写入，所以 `listDiagnostics()` 用 `ORDER BY created_at DESC, rowid DESC` 兜底，否则前端诊断列表的顺序会随机颠倒。

## 未验证的部分

- **万相 / Grok 还是没打过真实 API**，只测到 mock 上游。不过第 8 条那个体积上限是**中转站层面的**，三个视频渠道共用 `api.tiantoken.com`，所以万相 / Grok 同样受 1~2MB 限制 —— 现在客户端压缩对两者一起生效。
- 需求 2（Grok 链接可见性）的修复是基于代码推断，没有用户的真实失败响应样本，无法确认命中的是哪条路径。
- 需求 3（Toast 遮挡）只改了 CSS，没在浏览器实测点击穿透。
- **浏览器里没实测压缩后的实际体积**。1280 长边 / q0.85 的 JPEG 按经验在 150~250KB，但没有真机跑过。真实验证用的是另一条路径（见下），不是这条前端逻辑。

### 已经在浏览器里验过的（本轮）

用 `preview_start` 起 `npm run dev`（真实数据目录），在生图页、视频页和历史页各走了一遍：

- **拖放参考图**：合成 `DragEvent` + `DataTransfer`，生图页和视频页（首帧生视频模式）都确认 `dragenter` 加高亮、移到子元素不移除高亮、移出容器才清除、`drop` 后图片真的进了列表。截图留档。
- **清空历史确认框**：两个单选项、默认选中「同时删除本地文件」、选中态跟随、确认按钮是 danger 样式。**没有点确认**，只验证渲染和取消。
- **素材目录弹窗**：路径、按钮禁用态（Web 模式「更改目录」「恢复默认」禁用 + 说明文案）都正确。
- **诊断精简行**：库里现有任务都是本轮改动之前生成的，没有真正的精简行，所以是用注入的合成响应（1 条提交 + 3 条精简 + 1 条完整收尾）渲染验证的，输出形如「第 12 次轮询 · running · 60%」。真实数据下的表现还没见过。

顺带发现并修掉一个 CSS 问题：全局 `input { width: 100% }` 会把单选钮撑成整行，把选项文字挤成竖排——`.confirm-option input` 现在显式写成 15×15。

### 历史页勾选批量删除（2026-10-13）

同样在浏览器里走了一遍：表头全选/取消、单选两行后头部出现「已选 2 条」、表头半选态、切筛选清空勾选、视频筛选下全选只勾中 9 条、三种弹窗文案（`删除选中的记录` / `删除 2 条`、`删除记录` / `删除`、`清空历史` / `清空 18 条`）。**没有点确认删除**，用户库里 6 个渠道 / 18 条记录原样未动。

顺带又发现一个同源的 CSS 坑并修掉：`input, select { padding: 0 11px }` 这条全局规则在 `border-box` 下会把固定宽度的复选框**硬撑成 25px 宽**（`.unit-head` 想要 15px、`.checkbox-label` 想要 17px，实际都是 25px 宽的扁方框）。现在全局 `input[type="checkbox"]` 显式 `padding: 0`；`.unit-head` / `.group-toggle` 那条 15px 规则和全局同权重又更早，高度会被全局的 18px 盖掉，所以补了一道更具体的规则。

历史页头部控件（筛选 + 批量条 + 清空 + 素材目录 + 目录设置）在窄窗口下会挤成竖排的单字，`.header-actions` 现在允许换行、按钮 `flex: 0 0 auto` + `white-space: nowrap`。

## Seedance 真实验证记录（2026-10-12）

用 `词元流墟-seedance视频` 渠道（`996611d8-…`）跑通了一次完整链路：

- `/v1/models` 返回 180 个模型，`sd-2.5` / `sd-2.0` / `sd-2.0-fast` / `sd-2.0-mini` **都在**，短名可用
- 提交端点 `/api/v3/contents/generations/tasks` 确认正确，上游是**火山方舟本体**（错误信息形如 `InvalidParameter: ... Request id:[req_…]`）
- 提交：请求体 139KB，**http 200 / 14.3s**，返回 `{"id":"cgt-…"}`
- 轮询：14 次 `running` 后 `succeeded`，**全程约 175s**
- 响应里视频在 `content.video_url`，`extractVideoCandidates()` 能正确提取 url 和继承的 `duration`（已用真实响应核对过）

**踩到的一个意外**：拿真人照片当首帧会被方舟风控拦下 —— `PrivacyInformation: the input image 'content[1]' may contain real person`。这不是 bug，是上游策略，用户选图时要知道。

## Seedance 参考多模态（2026-11-09）

按需求补齐「参考图 + 参考视频 + 参考音频」三类素材，并按版本区分上限：

| 版本 | 参考图 | 参考视频 | 参考音频 | 合计 |
|---|---|---|---|---|
| Seedance 2.0（含 Fast / Mini） | 9 | 3 | 3 | 15 |
| Seedance 2.5 | 30 | 10 | 10 | 50 |

- 上限来自 `src/shared/seedance-capabilities.ts`，`seedanceVersion()` 按模型 ID 判版本，`validateSeedanceMedia()` 在前端 `buildSeedanceMedia()` 与服务端 `buildGenerationRequest()` 各跑一次。
- UI 在「参考生视频」模式下提供参考视频 / 音频两个槽位：**只接受本地文件**（视频提交时上传图床；音频默认内联 base64，渠道配了上传地址时可切回上传），粘贴公网 URL 的输入框已删除。视频不接受 base64。
- 本地视频的上传实现在 `src/server/reference-video.ts` 的 `uploadReferenceMedia()`：任务执行时才上传，换回公网地址后写进 `content`。视频 / 音频会先落到 `inputs/` 下，重试时重新上传（图床链接可能过期）。接口是 `POST /api/generations/reference-media`（`video` / `audio` 两个 multipart 字段）。
- `adapters.ts` 的 seedance `content` 数组现在组装 `image_url` / `video_url` / `audio_url` 三种 part 及对应 role；以前只处理 `image_url`，视频音频被静默丢弃。
- 修掉三处上限打架：视频页 UI 写 10、共用 `useReferenceImages` 按 8 拦、zod 又是 20。现在图片页仍 8 张、视频页单独一份状态（30 张）、multer 与 zod 都是 30 / 50。
- 对话与画布侧仍只把画布图片映射成 `image_url`（那里没有视频 / 音频素材槽），多模态入口在视频生成页。

**渠道已配上图床（2026-11-09）**：`词元流墟-seedance视频` 预设补上了与万相、可灵同一座图床（`https://imageproxy.zhongzhuan.chat/api/upload` + `New-Api-User: 1`），参考生视频模式的「参考视频」槽位从「暂不支持上传」变成可点。`db-schema.ts` 有幂等回填：启动时把 tiantoken 站上 `upload_endpoint` 为空的 seedance 渠道自动补上，老渠道不用删除重建。

**待联调**：词元流墟中转是否接受 `video_url` 与 `reference_video` role 仍未实测（音频已测，见下）；本地视频上传链路（选文件 → 任务执行时传图床 → `video_url` 进请求体）代码与测试就绪，等一次真实提交验证。

### 音频 base64 实测（2026-11-09，词元流墟 / sd-2.0-mini / 480p / 4s）

用的是真实渠道（`api.tiantoken.com`），直接发 `POST /api/v3/contents/generations/tasks`，共三次探针：

| 请求内容 | 结果 | 结论 |
|---|---|---|
| 只有 `text` + `audio_url`（base64 WAV） | 400 `reference_audio cannot be the only reference input` | 字段被解析，但音频不能是唯一参考素材 |
| 再加 `image_url`（256×256 PNG base64） | 400 `expected the width to be at least 300px` | 参考图有最小尺寸要求（≥300px） |
| 512×512 图 + 1 秒音频 | 400 `audio duration ... must be greater than or equal to 1.8 ... in r2v` | 音频时长下限 1.8 秒 |
| 512×512 图 + 2 秒音频 | **200**，返回 `id: cgt-…`，状态 `queued` | **base64 音频被接受** |

- 结论：Seedance 的 `audio_url` 接受 `data:audio/wav;base64,…`，不必先上传图床；前提是 r2v 至少要有一份其它参考素材（图或视频），音频 ≥1.8 秒。
- 因此视频页在渠道没有 `uploadEndpoint` 时，本地音频会自动走内联 base64；有上传地址时仍默认上传，可手动切到内联。
- 音频下限写进了前端选择时的校验（`selectAudio`，≥1.8 秒），避免提交后才被上游拒绝。
- 尚未验证：`video_url` 用公网地址与 `reference_video` role 是否被接受；本地视频上传（需 `uploadEndpoint`）。

## 视频页第十七、十八轮（2026-11-10，去小圆 +、文本框尺寸恒定、翻页不再自动折叠）

两条反馈：①「去掉这个+号；添加图片会改变文本框大小……需要不上传素材和上传素材文本框不改变文本框大小，首尾帧也有这种情况」；②「多张参考素材时，点下一页，素材会自动折叠影响操作」。

### 第十七轮

- **去小圆 `+`**：删 `.vstudio-stack-add` 的 JSX / `Plus` 导入 / CSS / 测试断言，折叠态固定用大虚线「参考内容」格。
- **文本框尺寸恒定**：`notice` 与模式提示合并进 `.vstudio-hints`（`height:20px` 恒占位，有无提示都不改框高）；`.vstudio-input` 改 `height:172px; overflow-y:auto` 写死——上传素材、长提示词、折叠展开框都不长高，创作记录不再被截断。

### 第十八轮（点「下一页」自动折叠，根因较隐蔽，务必记住）

- **根因链（CDP MutationObserver 实测）**：点「下一页」翻到末页 → 按钮变 `disabled` → 浏览器主动让已聚焦按钮失焦（`focusout`，`relatedTarget=null`）→ `onBlurCapture` 误判「焦点离开素材排」→ `setAssetsExpanded(false)` 折叠 → 折叠渲染卸载入口格，无 key 的 children 按 index 位移错配（button→div 复用、焦点按钮被销毁）→ 层变窄指针落进正文又触发 `mouseleave`。**翻页动作本身触发了折叠**，与指针移动无关。
- **修复三件套**：
  1. `onBlurCapture`：`relatedTarget=null` 但指针仍压在素材排上（`assetsRef.current?.matches(':hover')`，try/catch 包住兼容 jsdom）时不折叠；
  2. 素材层四个子节点加 `key="add|prev|strip|next"`，折叠/展开的 reconcile 不再错配销毁节点；
  3. CSS `.vstudio-body:not(.is-folded) > .vstudio-assets.has-pages { width: calc(100% - 12px) }`——多页展开层宽度钉死，翻页键不随每页格数挪位，连点翻页按钮始终在指针底下。
- 测试：`video-studio-ui` 29→31 项（第十七轮 +「上传素材不改变创作框结构」、第十八轮 +「多页翻页不打断操作」，后者在 jsdom 里把 `clientWidth` 撑到 900 走真实分页路径）。全量 **124 文件 / 961 项通过**，tsc 零错误。
- CDP 实测：悬停展开 → 点「下一页」到末页（7→3 张）素材排保持展开、层宽恒 834px、点击点仍是翻页键；回点「上一页」不折叠；鼠标移进正文照常折叠、悬停摞照常展开。

## 视频页第十六轮（2026-11-10，文本位置恒定、展开改覆盖层、首尾帧静态化）

两条反馈：①「不改动文本布局，文本固定在右侧，素材展开后覆盖在文本就行；素材折叠占地窄一点」；②附首尾帧设计图，「固定成这种格式，不要动画」。第十五轮的 `float + flow-root` 会让展开时把文字推到素材排下面，所以这一轮整个骨架又 simplify 了一次。

- **文本恒定、素材覆盖**：`.vstudio-body { position:relative; display:block; min-height:176px; --asset-gutter:148px }`（首尾帧 190px，行内 `style` 按 `fixedSlotsMode` 给），`.vstudio-prompt { padding-left:var(--asset-gutter) }`、`.vstudio-input { min-height:172px }`；`.vstudio-assets` 从 float 改成 `position:absolute; top:6px; left:6px; z-index:2; width:max-content; max-width:calc(100% - 12px)`。展开时就地横向铺开（实测 802px）盖在文字上，`.vstudio-body:not(.is-folded) > .vstudio-assets` 给 `background:var(--surface)` 实底，免得文字从格子缝隙里透出来。**正文不再有 `display` 切换**，折叠/展开的 prompt/input/textX 逐项相同。
- **折叠摞收窄**：`margin-left` 从 `-64px` 收到 `-74px`（露 18px），整摞 172px → 120px；`.vstudio-stack-add` 改 `position:absolute; left:calc(100% - 18px)` 半叠在摞右边缘，既不占摞宽也不压正文第一个字。gutter 132 → 148px 给 `+` 留空隙。
- **首尾帧静态化**：之前 `stacked = tiles.length > 1 && !assetsExpanded` 把首尾帧的两格也当成「多张素材」叠成一摞（带角标、旋转、`vtile-in` 入场），完全不是设计图。现在 `fixedSlotsMode = Boolean(fixedSlots)`：`stacked` 排除它、`.vstudio-asset-stack` 的 `onMouseEnter` 和 `.vstudio-assets` 的 `onFocusCapture` 都短路、小圆 `+` 不渲染；CSS `.is-fixed-slots > * { animation:none !important; transition:none !important; margin-left:0 !important; transform:none !important }`。两格做成 72×72 浅灰实线圆角方块（`.vstudio-slot-pair .vstudio-slot`）、中间 `⇌`、标签从「尾帧（可选）」简化成「尾帧」（可选性由底部模式提示说明）。
- **专注态**：去掉第十五轮那套 `flow-root` 高优先级覆盖，改成 `.vstudio-page.is-focus .vstudio-body > .vstudio-prompt { display:flex; flex-direction:column; height:100% }` + `.vstudio-input { flex:1 1 auto; height:auto; min-height:190px }`，输入区从 190px 恢复到撑满 577px。
- 测试：`video-studio-ui` 27→29 项（新增「折叠/展开只换素材层、gutter 与输入框尺寸不变」「首尾帧固定两格、无动画类、悬停不动」）；全量 **124 文件 / 959 项通过**，tsc（含 server）+ vite build 通过。
- CDP：折叠/展开的 `prompt [391,163,859,187]`、`input [539,163,711,187]`、`textX 543` 完全相同，展开态 `assetsOverlapsText=true` + 实底；折叠摞 120px / 角标 9；首尾帧 `animationName=none`、`transform=none`、hover 后 `pairs=2` 且 `is-folded=true`；专注态输入 577px；各态 `docOverflowX=0`。

## 视频页第十五轮（2026-11-10，按截图改成「折叠在左、展开在上」）

第十四轮末尾问用户要不要改成设计图的左侧环绕版面，用户回了两张界面截图 +「按照这种样式啊」。这一轮把骨架改过去（**第十六轮又按「文本固定、展开覆盖」的要求把 float 换成了绝对定位覆盖层，见上一节**）。

- **默认态 = 素材浮在左、文字成列在右**：`.vstudio-body.is-folded { display:block; min-height:176px }`，`.vstudio-assets { float:left; width:max-content; margin:6px 12px 4px 6px }`，`.vstudio-prompt { display:flow-root; min-height:176px }`。用 `flow-root` 建 BFC 让整个提示词块缩到浮动块右侧，浏览器自己算宽度——空态一个虚线格、首尾帧两格 + 连接符、一摞三张都自动适配，不用 JS 量宽度写 `padding-left`。
- **展开态 = 上排 + 下文**：悬停那一摞后去掉 `is-folded`，回到原来的 flex column。两态 body 都是 176px：展开 = 68 素材排 + 4 gap + 104 输入框；折叠把 `.vstudio-input` 的 `min-height` 提到 172px 补上那 68px。实测创作框高度都是 265px，悬停不跳。
- **专注态别被顶掉**：`.vstudio-page.is-focus .vstudio-prompt` 有 `display:flex`（3 个类），会盖掉 `.vstudio-body.is-folded > .vstudio-prompt`（也是 3 个类、位置更靠前）。补了 `.vstudio-page.is-focus .vstudio-body.is-folded > .vstudio-prompt { display:flow-root; flex:none; ... }`（4 个类）和配套的 `.vstudio-input { height:46vh }`。
- **分页宽度要量父级**：新增 `bodyRef`，`measureStrip()` 从 `assetsRef.clientWidth` 改成 `bodyRef.clientWidth`。折叠时素材排只有 172px 宽，拿它算 `assetPageCapacity()` 会得到一页 1 格，展开后整排全乱。
- **入口格按状态切**：`folded = showSlots && !assetsExpanded`、`showBigAddSlot = !folded || tiles.length <= 1`。折叠且 ≥2 张时隐藏大虚线格、显示 `.vstudio-stack-add`（24px 圆 +，走同一个 `openAssetPicker()`）；展开/空态/单张恢复大格。折叠态箭头 `display:none`（不占浮动块宽度），展开态第一页只给上一页键加 `is-first { visibility:hidden }`，位置留着不跳。
- **细节**：`.vstudio-media-tag` 从黑色小胶囊改成贯穿底部的半透明深色条；浮动块加 6px 上/左留白，不再贴卡片圆角。
- 测试：`video-studio-ui` 仍 27 项，折叠用例补「大格隐藏 / 圆 + 出现 / is-folded 真 / 展开后大格回来且 is-folded 假」，空态用例标题改成「左侧虚线格 + 正文让位」并断言 `is-folded`。全量 **124 文件 / 957 项通过**，tsc（含 server）+ vite build 通过。
- CDP 五态实测：空态虚线格 x397、正文 x501；9 张折叠只露 3 格 + 角标 9、正文 x581、无大格有圆 +；展开一排 7 格 + 左虚线格 + 右圆箭头、正文 y235；首尾帧两格 + 连接符在左、正文 x539；专注态折叠仍成立（输入框 414px）。五态 `docOverflowX=0`，折叠/展开 body 与创作框高度完全一致。

## 视频页第十四轮（2026-11-10，折叠摞收口、悬停范围、Grok 上传入口）

四张设计图 + 一句「grok 缺少上传入口」。本轮先按「参考素材组件在各状态下的样子」对齐，**版面当时仍沿用第十二/十三轮的上方一排；第十五轮用户补了两张截图后已改成左侧环绕**，改动见上一节。

- **默认只叠 3 张 + 总数角标**：`shownTiles = stacked ? tiles.slice(-3) : pageTiles`，最近 3 张、`--tile-i` 从 0 到 2；旋转改 `calc((var(--tile-i) - 1) * 6deg)`（原来 ±1.5° 太弱），错开 `margin-left:-64px`（露 28px），`z-index: calc(10 + var(--tile-i))` 让最新的压最上面。角标用 `.vstudio-asset-stack.is-collapsed::after { content: attr(data-count) }` + `data-count={tiles.length}`：伪元素不算 DOM 子节点，`nth-child` 的入场延迟、`:not(:first-child)` 的负 margin 都不会被多出来的元素打乱。
- **悬停范围收紧**：`onMouseEnter` 从 `.vstudio-assets` 移到 `.vstudio-asset-stack`。设计图明确写「只在折叠素材上面生效」，原来悬停入口格 / 排内空白 / 翻页键都会展开。`onMouseLeave` 留在整条 `.vstudio-assets`：展开后从摞移到箭头的路上不收回，翻页键点得到。
- **Grok 根因**：`allVideoModes()` / `videoModesFor()` 对 `grok-video` 都返回 `[]`（注释写着「Grok 没有模式概念」），于是 `spec=null`：`showSlots` 不成立 → 参考内容入口不渲染；`resolveStudioMode()` 也返回 null → `generate()` 第一行就弹「当前模型没有可用的生成方式」。所以「缺少上传入口」只是表象，**这个渠道在视频页根本提交不了**。
- **不塞进模式表**：新增 `studioAssetSpec(adapter, model)`，仅当 `isVideoAdapterType(adapter) && videoModesFor(...).length === 0` 时返回 `composePromptSpec()`（Grok：7 张参考图、不收视频音频）。`videoModesFor` 仍为空 → 不画模式胶囊，服务端 `assertVideoModeRequest` 的 `!modes.length` 兜底（只查参考图上限）原样保留。`maxImagesForMode()` 先取 `studioModeSpec ?? studioAssetSpec`，然后按 `VIDEO_CAPABILITIES[adapter].maxReferenceImages` 给额度；`resolveStudioMode()` 在 `!modeId || modeId === "prompt"` 时直接认这份规格；`VideoGenerateView` 的 `spec` 也用它兜底。
- **图片别被丢掉**：原来 `api.generate(input, spec ? [] : bucket.images.map(...))` 是按「有没有 spec」决定要不要带通用 `referenceImages`。Grok 现在有 spec 了，若不动这行，图会被静默丢掉。改成 `genericImages = adapterType === "grok-video" || !spec ? bucket.images.map(...) : []`，Grok 的图继续走 `reference_images`。
- 测试：`video-modes` 的 Grok 用例改写（无模式表但有素材规格、额度 7、`resolveStudioMode` 能解析）；`video-studio-ui` 25→27 项，新增 Grok 入口用例和 Grok 提交用例（`vi.spyOn(window,"confirm")` + mock `api.generate`，断言 `referenceFiles` 长度为 1 且 toast 是「视频任务已提交」），折叠用例改成「3 张 + 总数角标 + 悬停空白不展开 / 悬停摞才展开」。全量 **124 文件 / 957 项通过**，tsc（含 server）+ vite build 通过。
- CDP 实测 Grok-视频 / grok-imagine-video：空态 `hasAdd=true`、`hasModeChip=false`；4 张图折叠只露图片2/3/4、`data-count="4"`、角标伪元素内容 `"4"`、±6° 旋转；悬停排内空白 `stacked` 仍 true，悬停摞才摊成 4 格一排。

## 视频页第十三轮（2026-11-10，参考内容恢复折叠、翻页上移、每页条数随窗口变）

三条需求 + 两张位置截图。**注意：这一轮把第十一轮的「网格/列表切换」彻底删掉了，把第十二轮的「素材常年铺成一排」改回默认折叠。**

- **默认折叠、悬停展开**：`.vstudio-asset-stack` 包住所有素材格，`.is-collapsed` 下用 `margin-left:-70px` 让每张往右只露一条，`transform: rotate(calc((var(--tile-i) - 1.5) * 1.5deg))` + `z-index: calc(20 - var(--tile-i))` 做不规则叠放；`onMouseEnter/onMouseLeave/onFocusCapture/onBlurCapture` 挂在 `.vstudio-assets`（不是 `.vstudio-asset-stack`，否则移到翻页箭头的路上就会收回去，点不到）。过渡 380ms，入场动画 420ms + 45ms 递增，输入框高度全程不变。
- **折叠的是全部素材**：`shownTiles = stacked ? tiles : pageTiles`——折叠时把所有素材都叠进去，展开后才按页切片。否则翻到末页时一摞只有 2 张，看着像素材丢了。相应地，「刚加素材自动翻到末页」加了 `&& !stacked`，只在展开态跳页；折叠态保持第 1 页，悬停看到的是最完整的一排。
- **翻页上移**：`pager` 从 `.record-scroll` 里挪到 `.record-controls`（筛选页签那一行的右侧，即截图红框位置）。CSS `.record-pager { margin-left:auto; padding:0; white-space:nowrap }`，`.record-tabs` 的 `margin` 移到父级 `.record-controls`。只有一页时整条不出现。
- **每页条数随窗口变**：新增 `client/video/record-paging.ts` 的 `recordPageLayout(width, height)`：列数 = `floor((width+16)/(240+16))`，上限 5；卡片宽封顶 320px（不封顶的话窗口拉宽 20px 会把 16:9 缩略图撑高、行数反而掉一格，出现「4 条变 2 条」的跳变）；行数按 `floor((height+20)/(cardHeight+20))`，上限 3；窗口特别矮时多加一列让卡片变窄变矮，保证至少一行放得下。`ResizeObserver` 观察 `.record-scroll`，jsdom / 首帧量不到就退回 3 条。网格列数与 `maxWidth` 走内联样式，CSS 不再写死三列。
- **宽度真的能变**：`.vstudio-inner` 原来写死 `max-width:880px`，所以记录区在任何大窗口下都是 880 宽、宽度维度根本不起作用。改成 `min(100%, clamp(880px, 62vw, 1120px))`：1440 基本不变，1680 到 1042，窄窗口由 100% 兜底不撑出横向滚动。
- **不滚动**：`.record-scroll` 从 `overflow-y:auto` 改成 `overflow:hidden`，删掉 `savedScroll` / `scrollTop` 恢复那一套和 `onScroll` 回调；列表视角、`RecordRow` 组件、`.record-list` / `.record-row` 样式以及 `LayoutGrid` / `List` 图标一起删除。
- **测试**：新增 `video-record-paging`（5 项）与 `video-asset-paging`（5 项，验证「一页 N 格 + 入口 + 两侧箭头」不越界、N+1 格一定越界）；`video-studio-ui` 25 项里「素材都在同一排」改写成「默认叠成一摞、悬停摊开、移开收回、输入框尺寸不动」；`video-records-ui` 12 项里翻页用例改查 `pager` 在 `.record-controls` 内且不在 `.record-scroll` 内，「切到列表视图」改成「只有网格一种视角」。全量 **124 文件 / 955 项通过**；`tsc`、`vite build` 通过。
- **CDP 实测**：1440×900 折叠态 9 张叠成 260px 一摞（相邻 `margin-left:-70px`、各带旋转矩阵），悬停摊成 7 格一排、`margin-left:0`、`transform:none`；箭头 x=489 / 1219，素材格 x=521..1157，无重叠。1440 / 1680 / 1180 / 980 四种尺寸下 `docOverflowX=0`、记录区 `scrollHeight==clientHeight`；1680 下 4 列 5 张、翻页条消失；翻页条 `right` 与 `.record-controls` 的 `right` 一致。

## 视频页第十二轮（2026-11-10，多段参考素材、筛选修复、排序自绘、m4a、素材排分页）

四条需求 + 两条补充反馈（「有的是支持参考多条视频的」「别把翻页按钮挡到了，我做翻页目的就是为了不滑动」）。

- **扩展名优先认素材**：新增 `shared/reference-media.ts`（`referenceMediaType()` 先按扩展名、认不出再退回 MIME）与 `client/media-files.ts`（`withReferenceMediaType()` 给空 MIME 的 `.m4a` / `.mp4` 补规范类型）。两个 multer 的 `fileFilter` 改用 `referenceMediaKindOf()` 复用同一套规则，Windows 上小写 `.m4a` 不再被拒收。
- **单段 → 多段**：`MediaBucket` 从 `video`/`audio` 单对象改成 `videos`/`audios` 数组（条目带 `id`）；`referenceMediaLimits()` 按模型给额度（Seedance 2.0 3/3、2.5 10/10，万相与可灵 1/1），额度 >1 时文件输入框 `multiple`、拖拽也收多个，单额度渠道「再选即替换」不弹确认。`useMediaBuckets` 加 `bucketsRef` 镜像：同一次回调里连着 `addVideo` 三次时，`buckets` 状态还是旧值，超额判断与 id 都会错——所有读写先落到 ref，state 只负责触发重渲染。
- **服务端同步**：`fields([{name:"video",maxCount:10},{name:"audio",maxCount:10}])`，`UploadFlags` 改成 `referenceVideoUploads` / `referenceAudioUploads` 数量并复核段数（超限 `MODE_MEDIA_LIMIT`），落盘 `${id}-reference-N.mp4` / `-reference-audio-N.ext`，`input_json` 写 `referenceVideos` / `referenceAudios`，`run()` / `retry()` 把旧单段字段折算成数组，删任务时一并回收。
- **筛选失效**：`VideoResultPanel` 的 effect 把 `filter` 也放进了依赖，选中任务与新筛选不符就立刻 `setFilter("all")`。改成 `previousTaskId` ref，只在选中任务真的换了时才重置。
- **排序自绘**：原生 `select` 展开是系统灰底、无圆角，换成 `button.record-sort` + portal `.record-sort-menu`（`role="menuitemradio"` + `aria-checked` + 勾图标）。
- **素材排分页**：`asset-paging.ts` 的 `assetPageCapacity()` 先把「入口格 + 两侧箭头」的位置扣掉再算一页几格，箭头是 `.vstudio-assets` 里的普通兄弟节点（不再绝对定位浮在末尾），`overflow:hidden`、不横向滚动；入场动画 420ms + 45ms 递增延迟。**坑**：宽度没量出来时容量是 `Infinity`，`currentPage * perPage` 会得到 `0 × Infinity = NaN`，切片变空数组——素材明明在桶里却一张不显示，必须先退回有限值。
- **踩坑**：删 CSS 旧块时漏了一个顶层 `}`，整份 `video-studio.css` 解析失败，Vite 又把坏结果缓存住，页面渲染成完全无样式。删掉多余括号并**重启 dev server** 后恢复。改 CSS 后页面「全裸」时先查括号配平，别急着回退代码。
- 验证：全量 123 文件 / 950 项，其中 1 项 `library-scroll-ui` 为偶发失败（单跑通过）；`tsc`（含 server）、`vite build` 通过。

## 视频页第十一轮（2026-11-10，参考内容可加视频/音频、记录菜单加删除、网格改翻页）

- **「参考内容」入口不再只能传图片**：`VideoComposer.assetTiles()` 里那一格的 `onClick` 原来写死 `imageInputRef.current?.click()`，带参考视频 / 音频槽位的模式（提示词生视频）等于没有入口。现在新增 `addableKinds`（`uploads` 去掉「首尾帧 / 视频编辑那类已有专属槽位」的重复项）与 `openAssetPicker()`：能收多种就先弹 `.vstudio-asset-add` 浮层（复用 `useAnchoredPanelStyle`，锚在点下去那一格的矩形上），每行「添加图片 / 添加视频 / 添加音频」带格式与上限，`disabled` 的写原因；只收一种就直接开系统选择框。收缩态加号（`.vstudio-stack-add`）与空态虚线加号格走同一个函数。
- **入口不重复**：首尾帧有「首帧 / 尾帧」两格、视频编辑 / 延长有专属「参考视频」格，这几处不再多一个「参考内容」（`addableKinds` 里按 `repeatable` 与 `requiredVideoSlot` 过滤）。图片满了但参考视频 / 音频空着时入口仍在——以前图片到上限这一格就整个消失，只能去 `@` 面板传视频。
- **记录菜单加「删除历史」**：`VideoResultPanel` 的 `⋯` 菜单末尾加一条 `is-danger` 的「删除历史」，回调 `onDelete` 一路传到 `App.requestDeleteTask`——和生图页、历史页同一条链路，弹「本地文件删不删」的确认框（`ClearHistoryDialog`，mode `task`）。`VideoGenerateView` 新增必填入参 `onDelete`。
- **网格翻页**：`GRID_PAGE_SIZE = 3`，`page` 状态 + `pageCount` / `currentPage`（越界夹到最后一页）。网格下方 `pager` 紧贴卡片（不钉在记录区底部，否则一页三条会和卡片拉开一大片空白）：左侧「第 x–y 条 / 共 N 条」，右侧上一页 / `n / N` / 下一页。换筛选、排序、视图 `setPage(0)`；`task?.id` 变化时按它在 `visible` 里的下标翻到对应页。列表视角仍是全量 + 滚动，不出翻页条。
- **CSS**：`.record-grid` 从 `auto-fill minmax(232px,1fr)` 改成 `repeat(3, minmax(0,1fr))`（一页三条正好一行；≤860px 退回 auto-fill 200px、≤620px 单列）；新增 `.record-pager` 与 `.vstudio-asset-add`（后者把 `.vstudio-mention-upload` 的虚线边改成实线）。
- **测试**：`video-studio-ui` 26 项（新增「参考内容能加图片/视频/音频，多种时先问加哪种，不能传的写明原因」，用 `vi.spyOn(videoInput, "click")` 证明走的是视频输入框）；`video-records-ui` 11 项（网格条数 4→3、新增翻页用例与「删除历史交给上层」用例，菜单项断言补上「删除历史」）。
- 验证：全量 120 文件 / 934 项；`tsc`（含 server）、`vite build`。CDP：1440×900 下网格三列 282px、「第 1–3 条 / 共 5 条 · 1 / 2」、下一页「第 4–5 条」、列表 5 行无翻页条、参考内容菜单三项说明各一行、点面板外与 Esc 都收起、首尾帧只剩「首帧 / 尾帧（可选）」、视频编辑只剩「参考视频」、深色主题下文字与边框可读。

## 视频页第十轮（2026-11-10，提示词换 contenteditable：@ 记号一直是带缩略图的胶囊）

第九轮的方案是「textarea 的字透明 + 上面盖一层展示层」。编辑中只能给记号上底色，因为展示层的胶囊宽度和文字宽度不同，一换胶囊光标、选区、点击定位就全错位。这一轮干脆把 textarea 换掉。

- **`src/client/video/PromptEditor.tsx`**（新增，约 400 行）：contenteditable 的 `div.vstudio-input`，正文和胶囊在同一棵 DOM。`htmlOf()` 把文本渲染成「文本节点 + `.vstudio-chip`」；胶囊是 `contenteditable=false` 的原子节点，`data-token` 存 `@图片1`，缩略图按类型内联（图片 `<img>`、视频 `<video preload=metadata>`、音频内联音符 SVG——这里是拼 HTML 字符串，不是 React 树，所以图标只能内联）。
- **文本 ↔ DOM 的一致性**：`readPromptText()` 走一遍 childNodes 读回纯文本（胶囊读 `data-token`，`<br>` 与块级边界算 `\n`，空编辑器里的占位 `<br>` 当作空串）。`sync()` 在每次输入后调用：文本超长、被删空、出现浏览器塞的块级元素（粘贴多行）、或者「该出现胶囊的位置 ≠ DOM 里实际的胶囊」（`sameChips()` 比对 `caretOffset`）时才 `paint()` 重建并按字符偏移 `placeCaret()`；否则**一个字都不动**，撤销栈和输入法都不受影响。
- **输入法**：`composingRef` 在 `compositionstart`/`compositionend` 之间挡住重建；`onKeyDown` 的回车要判 `nativeEvent.isComposing`，否则选词的回车被当成换行。
- **回车 / 粘贴**：回车 `preventDefault` + `insertPlainText("\n")`（优先 `execCommand('insertText')`，没有就 Range 兜底），配 CSS `white-space: pre-wrap` 出真换行；粘贴只取 `text/plain`，多行由 `hasBlocks()` 检测后拍平回「文本 + `\n`」，不再留 `<div>`。
- **光标坐标**：删掉 `useCaretRect.ts`（镜像 div 量 textarea 那套）。contenteditable 有原生选区，`promptCaretRect()` 用 `Range.getBoundingClientRect()`；jsdom 里 Range 缺这俩方法，`typeof` 判一下再回退到整框，否则测试里会抛 `getBoundingClientRect is not a function`。
- **insertMention 的顺序**：先读选区再 `focus()`。对 contenteditable 调 `focus()` 会把光标拨回内容开头（jsdom 与 Chromium 都这样），先 focus 会把 `@图片1` 插到最前面。
- **样式**：`.vstudio-input` 从 textarea 改成块级 div（`white-space: pre-wrap`、`overflow-y: auto`、`max-height: 320px`）；占位改用 `.vstudio-input:empty::before { content: attr(data-placeholder) }`（空态创作框 `VideoComposerPlaceholder` 仍是 textarea，走 `::placeholder`）；`.vstudio-token` / `.vstudio-mention-layer` / `.vstudio-mention-chip` 全部删除，统一成 `.vstudio-chip`。
- **测试**：`video-studio-ui` 的 `textarea()` 助手换成 `promptBox()` + `promptText()`（胶囊读 `data-token`，和提交给后端的一致），`typePrompt()` 改成「写 textContent + 把选区放到末尾 + 发 input」。新增/改写两条：胶囊编辑中也在、继续打字不解体；素材移除或 `@图片9` 这种不存在时退回普通文字。
- 验证：全量 120 文件 / 931 项；`tsc`（含 server）、`vite build`。CDP：插入后 `chip 75×22` 且带 `img`、`caretInEditor` 为真；退格一次 `chips: 0`；`Input.imeSetComposition` 组字 `jing`→`镜头` 期间胶囊不动；回车后 `textContent` 带 `\n` 且 `divs: 0`；多行粘贴后 `divs: 0`；点击胶囊开详情；深色主题 `color: rgb(156,196,255)` / `background: rgba(96,165,250,.22)`；`docScroll` 恒为 0，展开态仍 666px / 记录 `hidden`。

## 视频页第九轮（2026-11-10，拖拽分派 / @ 记号即时上色 / 素材摞不规则叠放）

- **拖拽按类型分派**：`useFileDrop` 的落点回调原来直接把 `dataTransfer.files` 交给 `addImages`，所以拖视频、拖音频都会撞上「仅支持 PNG、JPEG 或 WebP 参考图」。现在 `VideoGenerateView.handleDrop` 按 MIME（并兜底扩展名）拆成三份：图片 → `addImages`，MP4/MOV → `selectVideo`，MP3/M4A/AAC/WAV → `selectAudio`；当前模式不收的类型（首尾帧拖视频、文生拖音频）和未知类型各给一句话。落点的启用条件从「还有图片额度」改成「有渠道且不在提交中／读取中」——`video-edit`、`video-extend` 这种没有图片槽位的模式，原来整块拖拽都是失效的。
- **@ 记号即时上色**：`MentionLayer` 从「只在失焦时出现」改成「一直在」。`.vstudio-prompt.is-editing .vstudio-input` 把字设成透明、`caret-color` 保留，正文全部由展示层画。编辑中记号走 `.vstudio-token`：只改 `background` / `color`，左右各 3px 用 `box-shadow` 撑出来（不占宽度），所以光标位置和字形完全对得上；失焦后仍是带缩略图的 `.vstudio-mention-chip`（此时没有光标，宽度变了无所谓）。匹配不到素材的 `@图片9` 保持普通文字——「生效」这件事得看得见。
- **输入法**：组字期间（`compositionstart` → `compositionend`）`is-composing` 让展示层 `display:none`，textarea 的字恢复成 `var(--ink)`，否则拼音是透明的。
- **占位**：空提示词的占位由展示层画，`.vstudio-prompt .vstudio-input::placeholder` 设为透明，避免两份叠在一起；不带展示层的 `VideoComposerPlaceholder` 不受影响。
- **素材摞**：折叠态 `.vstudio-stack-card` 最多 3 张，`left/top: 50%` + 负 margin 居中，各自 `translate + rotate`（−2° / −13° / +12°），`z-index` 递减，最近加的（`mediaEntries.slice(-3).reverse()[0]`）在最上面；音频那张底部加 `.vstudio-stack-caption` 写「音频N」。悬停展开时 `.vstudio-assets.is-open > *` 跑 `vtile-in`（0.26s，逐张 30ms 延迟），收回时 `vstack-in` 错峰落回。
- 验证：全量 120 文件 / 931 项；`tsc`（含 server）、`vite build`。CDP 实测：编辑中 `@图片1` 计算色 `rgb(29,78,216)` + 10% 蓝底、textarea `color: rgba(0,0,0,0)`、展示层 `pointer-events: none`；拖 wav 得到「音频1」，拖 mp4 走视频校验（假文件报「无法读取素材」），拖 txt 报「不支持『notes.txt』」；折叠 3 张卡片的 `matrix` 带旋转，悬停 60ms 时 `vtile-in` 正在跑（opacity 0.41）；多行换行与深色主题字位一致。

## 视频页第八轮（2026-11-10，专注展开 / 提示词入口可放素材 / 去掉双层焦点框）

上一轮（第七轮）把版面收成一页：素材在左一列、悬停只认那一列、底部参数合成一个点击模块。这一轮按新需求再调三处。

- **展开 = 专注编辑**：展开状态提到 `VideoGenerateView`（`editingFocus`），页面打 `.vstudio-page.is-focus`：创作框吃掉工作区（1440×900 下 textarea 598px、整卡 666px），创作记录整块 `hidden`；收起恢复默认高度（整卡 172px）并重新显示记录。两个区域不再争同一块高度。
- **记录区滚动位置**：`display:none` 之后读 `scrollTop` 只会读到 0，所以在 `onScroll` 里把位置记进 `savedScroll`，重新出现后 `requestAnimationFrame` 里落回。收起期间那次补发的 `scrollTop=0` 事件要按 `hidden` 跳过。
- **默认高度**：输入区 78→104px，整卡落在需求表的 160–190px。
- **提示词生视频也有素材入口**：`showSlots` 增加 `optionalAssets`（`imageRepeatable || acceptsReferenceVideo || acceptsReferenceAudio`）——`prompt` 入口空着时左侧留一个 40px 虚线加号格，悬停展开成「参考内容」格；只有文生的组合（可灵 3.0 这类 `imageRepeatable=false`）不摆入口。
- **双层焦点框**：全局 `input:focus / textarea:focus` 的 3px 环叠在外层卡片上就是「外层卡片 + 内层输入框」两圈。`.vstudio-composer .vstudio-input` 统一 `border:0; box-shadow:none; outline:none`，靠父级选择器压过 `html[data-theme="dark"] textarea:focus`（0,2,2），不用 `!important`。焦点交给卡片：鼠标点进来只变边框色，键盘 Tab 才加 `.is-kb-focus`（边框转深 + 3px 光晕）；`textarea:focus-visible` 鼠标点击也成立，所以用 `keydown Tab` / `pointerdown` 自己记最近一次输入方式。
- 验证：全量 120 文件 / 928 项；`tsc`（含 server）、`vite build`；无头 Edge + CDP 核对默认/悬停/点击/键盘/展开/收起/深色/820×700 窄屏，`docScroll` 均为 0，滚动位置 260 → 收起 → 260。

## 视频页第六轮（2026-11-10，一页式）

- **一页到底**：标题 → 创作框 → 创作记录。默认与展开是同一页：展开只把提示词框升到 280px，下方正中给一个圆形收起键；编辑器始终是同一个 textarea。
- **空态不摆槽位**：没有素材时创作框只有一个输入框（右上角 @ 与展开键）。素材入口在 @ 面板底部：上传图片 / 视频 / 音频，带格式与上限说明；渠道没配 `uploadEndpoint` 时按钮禁用并写明原因。必填槽位（首尾帧、视频编辑/延长的参考视频）仍直接画在框里。
- **创作记录**：总条数与状态筛选（全部/进行中/已完成/失败）、网格/列表切换、最近在前/最早在前；卡片含缩略图、播放角标、时长、标题、状态点/模型/时长/分辨率，`⋯` 菜单含播放、下载、重生成、复用参数、诊断、取消。点卡片打开播放器浮层（参数快照 + 多结果切换），不再常驻大舞台。
- **轮询**：`App.tsx` 改为轮询最新一条未完成的视频任务，刷新页面后卡片也能继续推进。

## 视频页第五轮（2026-11-10）

- **合并生成方式**：界面只留「提示词生视频」（无素材=文生、有素材=参考生）与「首尾帧生视频」（1 张=首帧、2 张=首尾帧），万相的编辑/延长、可灵的运动控制仍单列。提交前 `resolveStudioMode()` 落成具体模式，历史任务的模式由 `studioModeForConcrete()` 折回入口。
- **@ 面板跟随光标**：`useCaretRect.ts` 用镜像 div 量 textarea 光标坐标，面板贴着 @ 展开，下方不够就上翻。
- **参考内容折叠**：默认一摞缩略图（数量角标），悬停展开成素材格、点击看详情；刚加完素材展开 2.4 秒后自动收回。素材格带「图片1 / 图片2」标签，与 @ 记号一致。
- **文本内 @ 胶囊**：失焦时把 `@图片1` 渲染成带缩略图的胶囊并支持点开详情；编辑态仍是纯 textarea（不用富文本编辑器，避免输入法问题）。

## 视频工作台改版（2026-11-09）

- **界面**：左侧导航与顶部模型/渠道保留；中央一体化创作框（素材槽 → 提示词 → 底部参数胶囊 → 发送），参数与模式都是挂在 body 上的浮层，右侧不再有固定参数面板；下方是「本次结果」大舞台 + 「最近」缩略记录。
- **模式**：只渲染渠道/模型真正支持的模式（万相 7 / Seedance 4 / 可灵按模型）；Seedance 没有编辑、延长时间线语义，所以不出现这些入口。
- **草稿**：`adapter:mode` 为键，提示词/参数/URL 进 localStorage，文件在内存分桶；切模式/切模型/切渠道都不清空，刷新页面图片需重选。
- **重校验**：换模型后当前模式不成立会自动回退并提示；时长/分辨率/比例按新能力收敛，改动原因显示在创作框下方。
- **快照**：提交即落 `input_json`，`GET /api/generations/:id` 带回脱敏的 `inputParameters`；结果区展示「本次参数」，可复用提示词/数值/URL，图片会提示重选。重试仍重放落库快照。
- **服务端守卫**：`tasks.create` 前校验模式是否属于该模型、素材是否齐/超、分辨率与时长是否在档；万相「视频编辑」不再发送 `duration`。
- **仍未接后端**：`format`（MP4/MOV）与 `n`（一次多条）——面板里可见但锁定，说明写在提示里，不做能点却无效的控件。

## 可以问用户的开放问题

1. 万相的 `reference_video` / `reference_audio` 是否也支持 base64？用户说过「图片都支持 base64」，视频音频当时没答。若支持，可以把 `video-edit` / `video-extend` / 参考视频那几个槽从「只填 URL」改成支持上传。注意要同步调大体积上限。
2. 需求 1 的截图只显示了向量引擎，词元流墟没截图，现有 6 个预设是按向量引擎的同样模式推的，没逐字核对。
3. `grok-imagine-video-1.5` 在渠道模型列表里，但**中转站的 `/v1/models` 里没有**（只有 `grok-imagine-video` 和 `grok-imagine-video-1.5-preview`）。还没试过提交，不确定是真不支持还是只是没列出来。

## 测试怎么跑

```bash
cd all_image_make
npm test          # 124 个测试文件 / 959 项（第十六轮结束时）
npx tsc --noEmit  # 类型检查
npm run dev       # 起服务
```

测试里 `vitest.config.ts` 设了 `VIDEO_POLL_INTERVAL_MS=20`，把视频轮询从 8 秒压到 20ms，否则端到端测试跑不完。生产默认仍是 8 秒（`tasks.ts` 的 `VIDEO_POLL_DELAY_MS`）。

端到端测试的模板在 `tests/app.test.ts` 的「runs a Seedance task end to end」，mock 了提交 → 轮询两次 → 下载落盘的完整链路，加新视频渠道时照着改。

和这轮改动对应的几条：

- 「keeps the submit request and the last poll full while compacting the middle polls」——诊断首尾完整、中间精简
- 「resumes polling a video task after a restart…」——直接往库里插一条带 `remote_task_id` 的任务，`db.close()` 后再 `createApp()`，调 `runner.resume()` 验证接着轮询；顺带用带尾斜杠的 Base URL 盯 `joinEndpoint`
- 「clears history in bulk…」「writes new assets into a custom directory…」——清空历史与素材目录（在 `history cleanup, custom asset directory and restart recovery` 这个 describe 里）
- 「deletes only the checked tasks when ids are given, and lets ids win over scope」——历史页勾选批量删除：只删点名的那些、文件跟着走、`ids` 压过 `scope`、混进不存在的 id 也不整批失败

## 主要文件职责

```
src/shared/types.ts             适配器类型、生成参数、三种视频模式定义
src/shared/provider-presets.ts  渠道预设（9 个），改动要和 adapters 的 defaultEndpoint 同步
src/server/adapters.ts          各渠道请求体构造、视频链接提取
src/server/tasks.ts             异步任务轮询、视频下载落盘、内联素材体积预算
src/server/app.ts               zod 校验（新参数记得加进 generationSchema）
src/shared/video-modes.ts       模式矩阵：哪家渠道有哪些模式、素材槽、参数档位（前后端共用）
src/shared/video-draft.ts       草稿结构、默认值、参数收敛、快照复用
src/shared/video-snapshot.ts    任务参数快照的脱敏与摘要
src/server/video-mode-guard.ts  提交前的模式/素材/参数复核
src/client/video/               创作框、参数浮层、结果面板、@ 素材面板、光标定位、素材数组构造
src/client/hooks/useMediaBuckets.ts  按「渠道:模式」分桶的图片/视频/音频
src/client/VideoGenerateView.tsx 视频页编排：渠道/模型 → 模式 → 草稿 → 提交
src/client/App.tsx              图片/视频渠道与任务的状态分离
src/client/useFileDrop.ts       参考图上传区的拖放交互（图片页/视频页共用）
```
