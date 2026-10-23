# Midjourney 接入说明

> 结论来自 2026-10-23 对 `https://api.tiantoken.com` 的真实调用。

## 端点

| 动作 | 方法/路径 | 请求体 |
|---|---|---|
| 文生图 | `POST /mj/submit/imagine` | `{ prompt }` |
| 图生图 | `POST /mj/submit/edits` | `{ prompt, image }` |
| 后续动作 | `POST /mj/submit/action` | `{ taskId, customId }` |
| 查询任务 | `GET /mj/task/{id}/fetch` | — |
| 取图片 | `GET /mj/image/{id}` | 需要同样的 Bearer Key |

提交成功响应：

```json
{ "code": 1, "description": "Submit Success", "result": "1792734148592979" }
```

`result` 才是任务 id；查询返回 `status`（`NOT_START` / `SUBMITTED` / `IN_PROGRESS` / `SUCCESS` / `FAILURE`）、`progress`（如 `"15%"`）、`imageUrl`、`buttons`。

## 实测坑

1. **后续动作走 `/mj/submit/action`，不是 `/v1/chat/completions`。**
   用 `mj_reroll` / `mj_variation` / `mj_upscale` 作为 chat completions 的 model 实测返回 404；
   把按钮的 `customId` 提交到 `/mj/submit/action` 才能成功拿到新任务 id。
2. **`mj_edits` 的图片字段是 `image`，不是 `base64Array`。**
   传 `base64Array` 会返回 `image is required`；传 `"image": "data:image/png;base64,..."` 才能提交成功。
3. **`result` 里的按钮是唯一可信的动作来源。**
   `customId` 形如：
   - `MJ::JOB::upsample::1::uuid`
   - `MJ::JOB::variation::1::uuid`
   - `MJ::JOB::reroll::0::uuid::SOLO`
   服务端只接受父任务 `buttons` 里真实出现过的 `customId`。
4. **图片 URL 需要带鉴权。** `/mj/image/{id}` 和渠道同 host，下载时会自动带 Bearer Key；
   如果上游返回 CDN 地址，则不重放密钥。
5. **一次 imagine 返回四宫格一张图**，U1-U4 放大后才是单张；当前按“一张产物”落盘。
6. **MJ 的宽高比、版本、排除词都写在 prompt 里**：`--ar 16:9`、`--v 7`、`--no text`。
   工作台会把宽高比/负面词追加到 prompt，若 prompt 里已经写了则不重复。
7. **图生图只取第 1 张参考图**（实测 `image` 单字段）；多张参考留到后续。

## 按钮显示规则

上游的 `buttons` 可能包含大量 v7 动作（Subtle/Creative Upscale、Vary Region、Zoom、Animate 等）。
工作台**只显示当前能直接经 `/mj/submit/action` 执行的动作**：

- 放大 U1-U4、放大（细腻/创意）→ 中文按钮
- 变体 V1-V4、变体（细微/强烈）→ 中文按钮
- 重绘（reroll）→ 中文按钮

区域变体、Custom Zoom、Zoom Out、Animate、未知“操作”按钮会隐藏，避免点了才报错。
服务端也会拒绝父任务里不存在的 `customId`，并拒绝需要额外 modal 参数的动作。

## 参数框

MJ 参数面板提供：

- 画面比例 → `--ar`
- 模型版本（默认 / 8.2 / 7 / 6.1 / 6）→ `--v`
- 排除内容 → `--no`

如果提示词里已经手写了同名参数，不重复追加。实测提交
`... --ar 16:9 --v 7 --no text, watermark` 后，查询返回的 `promptEn` 原样保留；
不写版本时网关会补 `--v 8.2`。

## 代码落点

- 适配器与请求：[`src/server/adapters.ts`](src/server/adapters.ts) 的 `midjourney` 分支
- 轮询与按钮：[`src/server/async-providers.ts`](src/server/async-providers.ts) 的 `midjourney` spec
- 任务元数据：`tasks.remote_meta`，`Task.remoteMeta.midjourney.buttons`
- 动作接口：`POST /api/generations/:id/action`
- 工作台：`GenerateView` 的 MJ 提示、结果动作条
- 模型/按钮工具：[`src/shared/midjourney.ts`](src/shared/midjourney.ts)
- 测试：`tests/midjourney.test.ts`、`tests/midjourney-e2e.test.ts`

## 真实联调记录

- `mj_imagine`：`a cute orange cat ... --ar 1:1`，约 1 分 35 秒 SUCCESS，四宫格 8.2MB PNG
- `mj_edits`：把四宫格缩到 512×512 后提交 `image`，SUCCESS，返回 9 个按钮
- `mj_upscale`：`/mj/submit/action` + U1 的 customId，返回新任务 id
- 初次用 chat completions 调 `mj_reroll`：HTTP 404 `Resource not found`，已改用 action 端点
- 初次用 `base64Array` 调 edits：HTTP 500 `image is required`，已改用 `image`
- 参数验证：提交 `a small red fox ... --ar 16:9 --v 7 --no text, watermark`，查询回来的 `promptEn` 原样保留三个参数；输出图 2048×1146（16:9），说明参数不是只存在本地、确实到了上游
- 默认不写 `--v` 时，网关会自动补 `--v 8.2`；所以版本框选“默认”就是让上游决定，选 7 才会显式锁到 7
