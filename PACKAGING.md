# ChatCanvas（语布）打包文档

> 从 2.2.1 起 `productName` 是 `ChatCanvas`，安装包和快捷方式都显示这个名字。数据目录由 identifier（`com.imagerelay.studio`）决定，不受改名影响。
>
> **一次性迁移**：2.2.0 及更早版本以 `ezcanvas` 安装（安装目录可能被用户改到别处）。升级到 2.2.1 时 NSIS 会按新名字装到新的默认目录，旧 `ezcanvas` 那份不会被自动删除——安装新版后手动卸载旧的 `ezcanvas` 即可，用户数据不会丢。

当前发布版本为 `2.2.4`。发布包不包含真实 API Key；新建的数据目录不预置任何渠道，首次启动后需要用“添加渠道”向导创建渠道并填入自己的密钥，或在启动前设置对应的环境变量（如 `VECTORENGINE_API_KEY`）。

## 环境准备

在 Windows 开发机安装：

- Node.js 24
- Rust stable 和 Visual Studio C++ Build Tools
- WebView2
- Tauri 所需的 Windows SDK

首次构建在项目根目录执行：

```powershell
npm ci
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

## 生成便携版

这是最容易分发的版本，生成一个目录和一个 ZIP：

```powershell
npm run release:portable
```

命令会依次运行测试、前端和 Node 服务端构建、Tauri sidecar 准备以及压缩。输出位置：

```text
artifacts/chatcanvas-v2.2.4-portable-win-x64/
artifacts/chatcanvas-v2.2.4-portable-win-x64.zip
```

目录名里的版本号由 `scripts/package-portable.mjs` 从 `package.json` 读取，改版本号后自动跟着变。

便携目录中的 `image_relay_studio.exe`、`node.exe` 和 `resources/` 必须保持同级关系，直接运行 `image_relay_studio.exe` 即可。

## 生成安装包

生成 NSIS 安装程序：

```powershell
npm run release:installer
```

便于分发的安装程序输出为：

```text
artifacts/chatcanvas-v2.2.4-win-x64-setup.exe
```

Tauri 的原始安装包同时保留在 `src-tauri/target/release/bundle/nsis/`。

当前项目未配置 Windows 代码签名证书，未签名安装包首次运行时可能出现 SmartScreen 提示。正式公开分发前应配置有效的代码签名证书。

如果 Tauri 下载 NSIS 工具失败，先使用便携版命令完成发布；网络恢复后再次运行安装包命令即可。

## 自动更新与发布

### 签名密钥（只有一对，丢了不可恢复）

Tauri 的更新包用 minisign 签名，公钥钉死在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 里。**私钥一旦丢失，已经装出去的用户就再也收不到更新**——不是重新生成一对能解决的。

- 私钥位置：`%USERPROFILE%\.tauri\chatcanvas-updater.key`（无密码，2026-10-17 生成）
- 公钥备份：同目录的 `.key.pub`
- 私钥**不进仓库、不进 `.env`、不写进任何交接文档**。请另外备份到密码管理器或 U 盘
- GitHub Actions 需要一个 secret：`TAURI_SIGNING_PRIVATE_KEY` = `chatcanvas-updater.key` 的完整内容。放在 **repository secrets**（Settings → Secrets and variables → Actions → Repository secrets）或 **`image_key` 环境的 secrets** 都可以——`release.yml` 的 `build-windows` 已声明 `environment: image_key`，两种来源都能读到。
- **不要创建 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**：GitHub 不允许空值 secret，而这个私钥生成时没有密码。工作流里缺失的 secret 会解析成空字符串，正好对应“无密码”。

`npm run tauri:build`（安装包）会自动从上面的固定位置读取私钥；找不到会直接报错并给出生成命令。`npm run tauri:build:exe`（便携版，`--no-bundle`）不需要私钥。

### 发版流程

推送 `vX.Y.Z` tag 会触发 `.github/workflows/release.yml`：

1. `build-macos`：构建 dmg 并冒烟测试（macOS 这版不参与自动更新）
2. `build-windows`：构建 NSIS 安装包并签名（Tauri 2 把安装器 exe 本身作为更新包，产出 `setup.exe` + `setup.exe.sig`）
3. `publish`：等两边产物齐了再建 Release、上传全部附件，生成 `latest.json`，再更新到固定的 `updater` tag

更新检查地址是固定的：

```text
https://github.com/kriswyl/all_image_make/releases/download/updater/latest.json
```

不要改成 `releases/latest/download/`：只要最新那个 Release 恰好缺 Windows 资产，全体用户的检查更新就会一起 404。

```powershell
npm run version:set -- 2.2.5
npm test
git add -A
git commit -m "Release 2.2.4: ..."
git push
git tag v2.2.4
git push origin v2.2.4
```

### 客户端行为

- **Windows 安装版**：启动 5 秒后静默检查；有新版时侧栏版本号旁出现圆点。用户点「下载并安装」后才下载，下载完成再停掉内置后端、安装并自动重启。下载失败不影响当前使用。
- **Windows 便携版**：目录里有 `.portable` 标记，更新面板只提示 + 打开下载页，不会自动装成安装版。
- **macOS / 网页版**：只提示，不自动安装。

首次接入自动更新后，已经装了 2.1.x 的用户不会自动升级（那个版本里没有更新器），需要手动装一次 2.2.1 及以后版本；之后的版本就能自动更新了。

## 更新版本号

不要只改一个文件。使用版本脚本会同步 `package.json`、`package-lock.json`、Tauri 配置、Cargo 配置和共享版本常量：

```powershell
npm run version:set -- 2.2.4
```

然后重新运行测试和对应的发布命令。发布前检查：

```powershell
npm test
git diff --check
git status --short
```

## 渠道和密钥

新建数据目录不预置渠道，首次启动后用“添加渠道”向导创建。向导为每个模型组生成独立渠道并使用独立的环境变量名（`VECTORENGINE_API_KEY`、`VECTORENGINE_GPT_C_API_KEY`、`VECTORENGINE_GEMINI_API_KEY` 等）；界面中的 `{向量引擎key}` 只是待填写提示，不是可用密钥。

在界面填写的 API Key 以明文保存在数据目录的 `channel-keys.json` 中，重启应用后自动载入。打包和分发前确认该文件没有被复制进发布产物，也不会写入 Git。

Tauri 用户数据目录：

```text
%APPDATA%\com.imagerelay.studio\data
```

日志目录：

```text
%LOCALAPPDATA%\com.imagerelay.studio\logs
```

升级时请保留上述 `data` 目录，以继续使用原有渠道、历史任务和图片。生成产物的目录如果被用户改到了别处（历史页的「目录设置」），要连同那个目录一起保留。
