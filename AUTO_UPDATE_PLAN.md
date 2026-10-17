# 益达工作台 · 自动更新实现方案

面向 Tauri 2 + 本项目的具体落地设计。结论先给，后面才是细节。

## 结论前置

| 平台 | 能不能做 | 这一版做什么 |
|---|---|---|
| Windows 安装版 | **能做，路径成熟** | 全自动：检查 → 下载 → 校验签名 → 安装 → 重启 |
| Windows 便携版 | 能做但不该自动装 | 只提示「有新版本」+ 跳下载页（Tauri 的更新器装的是 NSIS 包，装上就变成安装版了） |
| macOS | **这版做不了可靠的自动更新** | 只提示 + 跳下载页 |

macOS 为什么不行：`tauri.conf.json` 现在是 `macOS.signingIdentity: "-"`，也就是**ad-hoc 签名**。更新器替换 `.app` 之后 Gatekeeper 会把它当成被篡改的包拦下，而自动更新最容易失败在「更新完打不开」上——那比不更新更糟。等哪天真配了 Apple Developer ID 并做了公证，再把 macOS 的自动安装打开，代码基本不用改（`latest.json` 加一个 `darwin-aarch64` 键即可）。

---

## 一、现状与约束（已核实，不是推测）

| 事实 | 出处 | 对方案的影响 |
|---|---|---|
| **Release 里从来没有 Windows 产物**，v2.1.1 的 Release 只有 `_2.1.1_aarch64.dmg` | GitHub API | **这是先决条件**。更新器要从一个固定 URL 下载 Windows 包，而现在 Windows 包是本地手工打的、发不出去 |
| 只有 macOS 一个 CI job，Windows 一直是本机 `npm run release:installer` | `.github/workflows/build-macos.yml` | 要新增 Windows 构建 job，并且**让建 Release 这一步等两个 job 都好了再跑**（下面的"顺序"一节） |
| `tauri.conf.json` 里**根本没有 `plugins` 段** | `src-tauri/tauri.conf.json:1-50` | 更新器相关配置全部是新增 |
| `Cargo.toml` 里没有 updater，只有 log/shell/dialog/fs | `src-tauri/Cargo.toml:20-28` | 要加依赖 |
| `bundle.targets` 只有 `["nsis"]` | `src-tauri/tauri.conf.json:32` | Windows 更新包就是 NSIS 产物，不用改 target |
| 后端是 sidecar，带 `EXIT_WITH_PARENT=1`；启动时还会 `reclaim_backend_port()` 主动杀掉残留的旧后端 | `src-tauri/src/lib.rs:255,119-153` | **这是本方案能成立的关键**：更新时后端会跟着桌面端退出，且就算没退干净，新版启动也会清掉。但安装那一刻仍要显式确认它已退出（见"三、客户端"） |
| 版本号由 `scripts/set-version.mjs` 同步到 6 个文件 | `scripts/set-version.mjs` | 更新器比的是 manifest 的 `version` 和 app 编译进去的 `version`，两者必须来自同一处 |
| 用户数据在 `%APPDATA%\com.imagerelay.studio\data`，**不在安装目录里**；素材目录还可能被用户改到别处 | `PACKAGING.md:82-94` | NSIS 覆盖安装天然不动它。但"升级后数据还在"必须当成一条硬验收 |
| 前端已有 `isTauriRuntime()`，web 模式下所有 Tauri 能力都优雅降级 | `src/client/api.ts:16-20` | 更新能力照这个模式包一层，web 开发模式不能炸 |
| 顶栏已经在显示版本号 | `src/client/App.tsx:395` | 更新的入口就挂在这里，不用新造页面 |

## 二、签名密钥（先做这个，它是不可逆的）

Tauri 的更新包用 **minisign** 签名，公钥硬编码在 app 里。语义是：

> **私钥丢了，就再也无法给已经装出去的用户推送更新**——不是"重新生成一对"能解决的，那些用户的 app 里钉的是旧公钥。

所以：

```bash
npx tauri signer generate -w ~/.tauri/ir-updater.key
```

- **公钥**（一串 base64）写进 `tauri.conf.json`，可以进仓库。
- **私钥 + 密码**只存在两处：GitHub Actions 的 secret（`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），以及本机仓库**外**的一个文件（建议 `%USERPROFILE%\.tauri\ir-updater.key`）。
- **不能进 `.env`、不能进仓库、不能进交接文档**——沿用 `PACKAGING.md:80` 已经立下的那条纪律。
- 私钥文件要单独备份（U 盘 / 密码管理器）。这条建议写进 `DEVELOPMENT_HANDOFF.md`。

## 三、打包侧改动

### 依赖与插件注册

```toml
# src-tauri/Cargo.toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"   # 提供重启
```

```jsonc
// src-tauri/capabilities/default.json 的 permissions 追加
"updater:default",
"process:allow-restart"
```

```rust
// src-tauri/src/lib.rs，与现有 .plugin(...) 并列
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

### tauri.conf.json

```jsonc
{
  "bundle": {
    "createUpdaterArtifacts": true   // ← 关键：产出 .nsis.zip + .sig
  },
  "plugins": {
    "updater": {
      // base64 公钥，必须写内容、不能写文件路径
      "pubkey": "<signer generate 输出的公钥>",
      "endpoints": [
        "https://github.com/kriswyl/all_image_make/releases/download/updater/latest.json"
      ],
      "windows": { "installMode": "passive" }   // 小进度条，用户能看到在装
    }
  }
}
```

`createUpdaterArtifacts: true` 会让**每次构建都要求签名私钥**，本地 `npm run release:installer` 也一样。所以 `scripts/tauri-build.mjs` 开头加一段：从 `%USERPROFILE%\.tauri\ir-updater.key` 读取并注入 `TAURI_SIGNING_PRIVATE_KEY`；读不到就**明确报错**并给出生成命令——不要让构建挂在 Tauri 内部一句含糊的签名失败上。

产物会多出四个文件：

```
src-tauri/target/release/bundle/nsis/
  益达工作台_2.1.2_x64-setup.exe          ← 给人手动装的（不变）
  益达工作台_2.1.2_x64-setup.exe.sig
  益达工作台_2.1.2_x64-setup.nsis.zip     ← 给更新器用的
  益达工作台_2.1.2_x64-setup.nsis.zip.sig ← 这个文件的内容要进 latest.json
```

### endpoint 为什么不用 `/releases/latest/download/`

`.../releases/latest/download/latest.json` 看着最省事，但它是「最新那个 Release 里必须有这个资产」。一旦出现「Release 建好了但 Windows job 失败/没跑」，这个地址就 404，**所有用户的更新检查一起失效**。

改成**一个固定的 `updater` tag**（一个长期存在的 Release，每次发版只更新它里面的 `latest.json` 一个资产）。地址恒定，与"最新 Release 恰好缺文件"解耦。

## 四、发布侧（CI）

### 顺序问题

现在的 macOS job 自己调 `softprops/action-gh-release` 建 Release。加 Windows 之后必须改结构：

```
jobs:
  build-macos   →  产出 dmg
  build-windows →  产出 setup.exe / nsis.zip / *.sig
  publish       →  needs: [build-macos, build-windows]
                   建 Release、传全部产物、生成并上传 latest.json
```

理由：更新器拿到的 `latest.json` 里 URL 必须指向**同一个 Release 里已经存在的资产**。先建 Release 再补资产，中间那段时间用户检查更新会拿到一个下载 404 的地址。

### `latest.json` 的形状

```json
{
  "version": "2.1.2",
  "notes": "（从 CHANGELOG.md 对应小节自动截取）",
  "pub_date": "2026-10-16T02:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/kriswyl/all_image_make/releases/download/v2.1.2/益达工作台_2.1.2_x64-setup.nsis.zip",
      "signature": "（.nsis.zip.sig 文件的内容，不是路径）"
    }
  }
}
```

只写 `windows-x86_64` 一个键——macOS 这版不参与自动更新。

新增 `scripts/write-latest-json.mjs`，核心做成**纯函数** `buildLatestJson({version, notes, pubDate, baseUrl, fileName, signature})`，再由薄薄一层 CLI 读文件、拼 URL、写盘。理由：这是整套流程里唯一能真正跑单测、也最容易写错（键名、URL 拼法、`.sig` 内容 vs 路径）的地方。配 `tests/latest-json.test.ts`。

`notes` 从 `CHANGELOG.md` 里按版本号截取那个 `## vX.Y.Z` 小节——CHANGELOG 已经是事实来源，不要再手写第二份。

## 五、客户端

### 前端封装（`src/client/api.ts`）

照现有 `isTauriRuntime()` 的模式加一组薄封装，**非 Tauri 运行时一律返回 null**：

```ts
export async function checkForUpdate(): Promise<{version: string; notes: string} | null> {
  if (!isTauriRuntime()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  return update ? { version: update.version, notes: update.notes ?? "" } : null;
}
```

下载与安装是**两段**，中间要能报进度、要能失败后继续用旧版本：

```ts
update.onProgress(({chunkLength, contentLength}) => …)   // 顶栏进度条
await update.downloadAndInstall()                        // 下载 + 校验签名 + 装
await relaunch()                                         // 重启
```

### UI 入口

顶栏 `v{APP_VERSION}`（`App.tsx:395`）改成按钮：

- 无更新 → 「已是最新版本 v2.1.1」
- 有更新 → 新版本号 + `notes` + 「下载并安装」/「稍后」
- 安装中 → 进度条
- Web 模式下按钮不出现（或置灰并说明"网页版不支持自动更新"）

启动时**静默检查一次**，但延迟几秒、且失败完全静默（不能因为 GitHub 抽风就在启动时弹错）。

### ⚠️ 安装前必须先停掉后端

这是整个方案里最容易翻车的一点，必须单独做：

`node.exe` 和 `resources/server/**` 是**被正在运行的后端进程占着**的。`EXIT_WITH_PARENT` 是在父进程死后才生效，而 NSIS 安装的那一刻父进程（桌面端）还在跑，文件是锁的。

所以走一条自己的路径，而不是直接 `downloadAndInstall()`：

1. Rust 侧暴露一个 command：`prepare_for_update()` —— 杀掉 sidecar、**等到 17892 端口真的释放**，失败就返回错误让前端提示「请关闭应用后手动安装新版本」。
2. 前端：`prepare_for_update()` 成功 → 才开始下载安装。
3. 复用 `lib.rs` 里现成的 `port_open()` 轮询（`reclaim_backend_port` 里已经有等待端口释放的写法）。

失败兜底：任何一步失败都必须让用户**能继续用旧版本**，界面上给出明确原因和「手动下载」链接。

### 便携版

`package-portable.mjs` 已经在往便携目录写 `README-PORTABLE.txt`，再写一个空的 `.portable` 标记文件。Rust 侧 `current_exe()` 旁边有这个标记 → 判定为便携版 → 更新面板只显示「有新版本 v2.1.2」+「去下载」，不给「自动安装」。

不这么做的后果：便携版用户点了更新，NSIS 把应用装进 `%LOCALAPPDATA%`，他原来的便携目录还在、还在被点开，于是**同一台机器上出现两个版本，数据目录却是同一个**（`%APPDATA%\com.imagerelay.studio`）——比不更新更难排查。

## 六、验证

**能自动化的**（进 `npm test`）：
- `buildLatestJson` 纯函数：键名是 `windows-x86_64`、URL 拼接、`signature` 取的是文件内容而非路径、`notes` 从 CHANGELOG 正确截取、版本号格式。
- `prepare_for_update` 相关的端口等待逻辑（如果抽成纯函数）。

**必须手测、且没法省的一步**：装**旧版本**（比如 2.1.1）→ 发布 2.1.2 → 点更新 → 重启。升级路径在开发模式下永远复现不出来（这正是 v2.1.1 那个 jimp 崩溃的教训）。

手测清单：
1. 更新后 `/api/health` 报的是新版本号。
2. `%APPDATA%\com.imagerelay.studio\data` 里渠道、历史、会话、画布**全在**。
3. 把素材目录改到别处（历史页「目录设置」）后更新，旧产物仍然能打开。
4. 故意断网 → 检查更新失败但应用正常可用。
5. 便携版：只提示、不自动装。
6. Mac：只提示 + 跳下载。

## 七、分期落地

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0** | Windows 构建上 CI + Release 结构改成 `needs` 三 job + 每次发版都带 `latest.json` | 没有这个，更新器没有东西可下，后面全是空转。而且它本身就有价值：以后不用在本地手工打包上传 |
| **P1** | 生成密钥对 + 插件接入 + `createUpdaterArtifacts` + 顶栏更新面板 + 手动「检查更新」 | 能跑通完整链路 |
| **P2** | 启动静默检查、`prepare_for_update` 的端口等待、便携版判定、macOS 的「只提示」 | 把这些边角收干净，避免出现"更新完打不开" |
| **P3** | Windows 代码签名证书（消掉 SmartScreen）；macOS Developer ID + 公证 → 打开 macOS 自动安装 | 都要花钱/走流程，不影响功能本身 |

P0 和 P1 里，**P0 可以独立先做**，它不依赖密钥也不依赖插件。

## 八、需要拍板的四件事

1. **minisign 私钥谁备份、放哪。** 丢了就再也推不了更新——这是本方案唯一的不可逆项。
2. **便携版用户更新后变成安装版，接受吗？** 接受的话可以省掉 `.portable` 判定那一整块。
3. **macOS 这版只做「提示 + 跳下载」**，不做自动安装，可以吗？
4. **自动更新的交互**：静默下载好、下次启动时装？还是检测到就问、下载完再问一次重启？前者体验顺但用户会觉得"它自己动了"。

---

参考：[Tauri Updater 插件文档](https://tauri.app/plugin/updater/)、[Tauri v2 Updater & Distribution 参考](https://github.com/nodnarbnitram/claude-code-extensions/blob/main/.claude/skills/tauri-v2/references/updater-distribution-reference.md)
