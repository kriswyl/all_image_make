# 视频生成功能 · 交接文档

> 写给下一个对话窗口的自己。读完这份就能接上，不需要翻历史。

**工程根目录**：`D:\codexuse\shengtu\all_image_make`（git 仓库，主分支 `main`）

## 当前状态

| 项目 | 状态 |
|---|---|
| TypeScript | `npx tsc --noEmit` 零错误 |
| 单元测试 | `npm test` → 260 passed（20 个文件） |
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
- 运动控制参考视频支持手动填写公网 http(s) 地址，或通过渠道配置的图床上传本地 MP4/MOV；上传结果可通过公网访问。
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

   客户端继续将大图压到长边 1280 的 JPEG（`fileToVideoDataUrl()` / `downscaleToJpeg()`）；服务端对所有内联素材合计设置 15 MiB 字符预算，base64 大约放大三分之一。

### 本地视频和音频素材

- 万相参考视频和可灵运动控制支持本地 MP4/MOV 经渠道图床上传，也可手动输入 URL；图床链接是公开的。渠道上传地址和附加请求头可在渠道设置中配置。
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

## 可以问用户的开放问题

1. 万相的 `reference_video` / `reference_audio` 是否也支持 base64？用户说过「图片都支持 base64」，视频音频当时没答。若支持，可以把 `video-edit` / `video-extend` / 参考视频那几个槽从「只填 URL」改成支持上传。注意要同步调大体积上限。
2. 需求 1 的截图只显示了向量引擎，词元流墟没截图，现有 6 个预设是按向量引擎的同样模式推的，没逐字核对。
3. `grok-imagine-video-1.5` 在渠道模型列表里，但**中转站的 `/v1/models` 里没有**（只有 `grok-imagine-video` 和 `grok-imagine-video-1.5-preview`）。还没试过提交，不确定是真不支持还是只是没列出来。

## 测试怎么跑

```bash
cd all_image_make
npm test          # 58 个测试
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
src/client/VideoGenerateView.tsx 视频工作台、模式选择器
src/client/App.tsx              图片/视频渠道与任务的状态分离
src/client/useFileDrop.ts       参考图上传区的拖放交互（图片页/视频页共用）
```
