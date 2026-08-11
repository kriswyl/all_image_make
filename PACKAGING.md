# 向量生图打包文档

当前发布版本为 `1.0.2`。发布包不包含真实 API Key；首次启动后，在默认向量引擎渠道的“API Key”输入框填入自己的密钥，或在启动前设置 `VECTORENGINE_API_KEY` 环境变量。

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
artifacts/向量生图-v1.0.2-portable-win-x64/
artifacts/向量生图-v1.0.2-portable-win-x64.zip
```

便携目录中的 `image_relay_studio.exe`、`node.exe` 和 `resources/` 必须保持同级关系，直接运行 `image_relay_studio.exe` 即可。

## 生成安装包

生成 NSIS 安装程序：

```powershell
npm run release:installer
```

便于分发的安装程序输出为：

```text
artifacts/向量生图-v1.0.2-win-x64-setup.exe
```

Tauri 的原始安装包同时保留在 `src-tauri/target/release/bundle/nsis/`。

当前项目未配置 Windows 代码签名证书，未签名安装包首次运行时可能出现 SmartScreen 提示。正式公开分发前应配置有效的代码签名证书。

如果 Tauri 下载 NSIS 工具失败，先使用便携版命令完成发布；网络恢复后再次运行安装包命令即可。

## 更新版本号

不要只改一个文件。使用版本脚本会同步 `package.json`、`package-lock.json`、Tauri 配置、Cargo 配置和共享版本常量：

```powershell
npm run version:set -- 1.0.3
```

然后重新运行测试和对应的发布命令。发布前检查：

```powershell
npm test
git diff --check
git status --short
```

## 默认渠道和密钥

新建数据目录时，程序会自动创建 4 个向量引擎默认渠道。已有数据目录不会被覆盖，也不会删除已有渠道和历史任务。默认渠道共用环境变量 `VECTORENGINE_API_KEY`；界面中的 `{向量引擎key}` 只是待填写提示，不是可用密钥，也不会写入 Git。

Tauri 用户数据目录：

```text
%APPDATA%\com.imagerelay.studio\data
```

日志目录：

```text
%LOCALAPPDATA%\com.imagerelay.studio\logs
```

升级时请保留上述 `data` 目录，以继续使用原有渠道、历史任务和图片。
