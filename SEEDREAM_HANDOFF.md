# Seedream 5.5 / 5.0 Pro 生图 · 实测记录

> 2026-11-20 用真实令牌（`api.tiantoken.com`）实测两个豆包生图模型。
> 共消耗 **11 张图**（含 1 张探参数时"意外"出图、1 张验证 edits 端点、3 张补测 Ark 原生格式）。
> 失败请求（400 / 502 / 504）不计费——本文有多条结论就是靠这类报错免费换来的。

## 一、可用性与端点

| 项 | doubao-seedream-5-5 | doubao-seedream-5-0-pro-260628 |
|---|---|---|
| 端点 | `POST /v1/images/generations`（**也可用 Ark 的 `/api/v3/images/generations`，行为一致**） | 同 |
| 文生图 | ✅ | ✅ |
| 参考图（`image`） | ✅ URL 与 base64 都行；**支持数组（多参考图）** | ✅ 同 |
| 实测耗时 | 16–68 秒 | 21–121 秒（`1K` 预设那次最慢） |
| 回执里的真实后端 | 映射为 `doubao-seedream-5-5-261028` | 原样 `doubao-seedream-5-0-pro-260628` |
| 计费口径 | `usage.generated_images` / `output_tokens`（3600–4096，随尺寸变） | 同 |

响应是标准 OpenAI Images 形状：`{ created, data: [{ url | b64_json }], usage: { input_images, generated_images, output_tokens, total_tokens } }`，
另有顶层 `model` 回执。

## 二、参数实测矩阵

| 参数 | 结论 | 证据 |
|---|---|---|
| `size` | **任意 `WxH` 原样生效**，但**面积必须 ≥ 921,600 像素**（约 960×960） | `999x999` 真出 999×999 PNG；`512x512` → 400 `image area must be at least 921600 pixels`，`param: "size"` |
| `image`（参考图） | URL ✅、base64 data URI ✅ | 两种都返回 `usage.input_images: 1` |
| `response_format` | `url` ✅、`b64_json` ✅ | b64 那次响应 1.89MB，解码得 1387KB PNG |
| `watermark` | **默认 true**（图上有「AI生成」角标）；`false` 生效。**两个模型都实测过默认带标** | 默认图右下角有清晰角标；传 `false` 后画面干净 |
| `n` | 未测（按张计费） | — |
| `seed` / `quality` | 未测 | — |

**尺寸不是白名单而是面积下限**：做参数面板时按面积校验，不能只给固定档位。
`1024x1024`、`960x960` 都安全，`800x800`（640,000）会被拒。

## 三、豆包原生（Ark）格式（2026-11-20 补测）

结论先行：**`/api/v3/images/generations` 能吃，但它和 `/v1/images/generations` 行为完全一样**，
没有额外能力。接入时继续用 `/v1` 即可（与现有 `openai-images` 适配器一致）。

| 项 | 结果 | 证据 |
|---|---|---|
| `POST /api/v3/images/generations` | ✅ 可路由（与 `/v1` 同一套渠道逻辑） | 用不存在的模型打这个路径，返回与 `/v1` **完全相同**的 `model_not_found`；真模型也正常出图 |
| `POST /v1/images/generation`（单数）、`/api/v3/images/generation` | ❌ | 前者 404 `Invalid URL`，后者 504 |
| `size: "1K"`（Ark 预设字符串） | ✅ 生效，但**不是方图** | `1K` → 实际输出 **1248×832**（比例由提示词/默认决定） |
| `image` 数组（多参考图） | ✅ **两条路径都支持** | `/api/v3` 与 `/v1` 各发 2 张 URL，都返回 `input_images: 2` |
| `sequential_image_generation` | ❌ **两个模型都不支持** | 5.0-pro 与 5-5 都返回 400 `not supported by the current model`，`param: "sequential_image_generation"` |

### 这条对设计的影响

- **"一次调用出多图"用不了**。Ark 的 `sequential_image_generation` + `max_images` 在这两个模型上
  都被明确拒绝，所以多图只能靠多次调用，或试 OpenAI 形态的 `n`（`n > 1` 仍未测）。
- **不需要为多参考图专门做 Ark 适配器**：`/v1` 的 `image` 数组已经可用，`input_images` 会如实反映张数。
- `size` 支持**预设字符串**（`1K`/`2K`/`4K`）与**显式 `WxH`** 两种写法；预设不等于正方形，
  `1K` 给的是 1248×832。做参数面板时如果给"档位"按钮，要预期输出比例随提示词变化。

## 四、两个必须知道的坑

### 1. `/v1/images/edits` 会**静默丢弃参考图**

实测：`POST /v1/images/edits`（multipart，`image` 字段传 4KB PNG）→ **HTTP 200 并出图，但
`usage.input_images: 0`**，画面是凭空生成的山水水彩，与上传的纯色图毫无关系。

结论：这条模型只认 `/v1/images/generations` 里的 `image` 字段。edits 端点**不报错、不提示，
直接当文生图跑**——最难排查的一类失败。（附带观察：edits 出的那张反而**没有**「AI生成」角标，
说明它走的是另一条生成路径，与 generations 不是同一套后处理。）

> **对现有 `openai-images` 适配器的影响（重要）**：
> `buildGenerationRequest()` 在「有参考图 + `openai-images` + 渠道 endpoint 是默认值」时
> 会自动切到 `/v1/images/edits`（`src/server/adapters.ts` 附近）。所以如果直接把这两个模型
> 加到 openai-images 渠道里，**任何带参考图的请求都会悄悄丢掉参考图**，用户只会觉得"图生图不好用"。
> 要么新增 seedream 适配器/开关走 generations+`image`，要么在这条切换上加模型白名单。

### 2. 返回的 URL 后缀不可信

5.0-pro 的 `url` 以 `.png` 结尾，实际字节是 **JPEG**。落盘必须按文件头判断扩展名，
否则会出现"PNG 打不开"。

另外中途遇到过一次 **502**（base64 参考图 + `response_format: b64_json` 组合，61 秒后 nginx 网关页），
把两个变量分开各测都成功 → 判断为瞬时故障。**遇到 502 先原样重试一次，再下"不支持"的结论。**

## 五、接入要点（若要接进本项目）

| 项 | 建议 |
|---|---|
| 适配器 | 首选新增 `seedream`（或 `openai-images` 加「参考图内联」开关），因为 edits 那条路不可用 |
| 端点 | `/v1/images/generations`。**不必**为原生格式换 `/api/v3`——两条路径实测等价，`/v1` 也能吃 `image` 数组 |
| 参考图 | 进 `image` 字段（单张传字符串、多张传数组）；小图 base64 直传（4KB 量级实测可用），大图建议先压缩或走图床 URL |
| `size` | 支持 `WxH` 与预设 `1K`/`2K`/`4K`；用 `WxH` 时面板按**面积 ≥ 921,600** 校验。注意预设**不等于方图**（`1K` → 1248×832） |
| `watermark` | **默认关**（请求里显式传 `false`）。这是产品级差异：不传就烧「AI生成」进图 |
| `response_format` | 用 `url`（b64 响应可达 1.9MB，落库/传输都更重） |
| 多图 | 一次调用只能出 1 张（`sequential_image_generation` 两个模型都不支持），`n > 1` 待验 |
| 渠道预设 | baseUrl `https://api.tiantoken.com`，模型名照抄 `doubao-seedream-5-5` / `doubao-seedream-5-0-pro-260628` |

## 六、未验证

- `n > 1`（OpenAI 形态一次多图）——这是目前唯一可能实现"一次出多张"的入口，因为
  Ark 的 `sequential_image_generation` 已被证实不支持
- `seed` 固定是否生效
- 5-5 与 5.0-pro 在**参考图保真度**上的差异（只验了"图被吃了"，没做同参对比）
- `stream: true`（Ark 的流式返回）在中转上是否透传
- 并发与限流表现（实测都是单发）

## 七、复现脚本（`artifacts/`，未进 git）

| 脚本 | 用途 |
|---|---|
| `probe-seedream.mjs` | 文生图 / 图生图，支持 `--size` `--n` `--format=url\|b64_json` `--watermark` `--ref=<文件或URL>` |
| `probe-seedream-edits.mjs` | 专测 `/v1/images/edits`（multipart），可切 `--field=image\|image[]` |

```bash
export MMX_KEY=sk-...
node artifacts/probe-seedream.mjs --model=doubao-seedream-5-5 --size=1024x1024 --watermark=false
node artifacts/probe-seedream.mjs --model=doubao-seedream-5-5 --ref=path/to.png --prompt="改成水彩"
node artifacts/probe-seedream-edits.mjs --model=doubao-seedream-5-0-pro-260628

# Ark 原生路径 / 原生参数（注意 Git Bash 会把 /api/... 当路径转换，必须关掉）
export MSYS2_ARG_CONV_EXCL='*'
node artifacts/probe-seedream.mjs --path=/api/v3/images/generations \
  --model=doubao-seedream-5-0-pro-260628 --size=1K --n=0 --watermark=false \
  --extra='{"sequential_image_generation":"disabled"}'
```

> 小坑：在 Git Bash 里传 `--path=/api/...` 会被 MSYS 转成 `D:/...\api\...` 导致 `fetch failed`，
> 加 `MSYS2_ARG_CONV_EXCL='*'` 即可。PowerShell / cmd 不受影响。
