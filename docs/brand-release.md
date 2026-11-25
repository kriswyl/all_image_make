# 品牌版本打包与发布手册

这份文档回答四个问题：产物从哪来、发到哪里、密钥怎么放、出问题先看哪里。
换一台机器或换一个人接手时，照着第 1、4 节就能跑通一次完整发版。

---

## 1. 拓扑：谁发到哪里

一套源码、两个品牌、三种产物去向。

| 品牌 | Windows 安装版 | macOS (arm64) | 更新清单 |
|---|---|---|---|
| ChatCanvas（主版） | GitHub Release | GitHub Release | GitHub `updater` 标签 |
| 航天AI | Gitee Release（主分发） | GitHub Release `hangtianai-v*` | Gitee `updater` 标签 |

拆开的原因只有一条：**Gitee 限制单附件 100 MB、附件合计 1 GB**。
Windows 安装包约 58–59 MB，放得下；macOS 的 dmg 是 90–110 MB，
`aarch64.dmg` 长期在 102 MB 左右，**必然超限**，所以只能走 GitHub。
主版 v2.4.6 在 Gitee 上只有 exe 和 `x64.dmg`（92 MB），没有 aarch64，就是这个原因。

源码仓库只有 `kriswyl/all_image_make` 一个。两个发布仓库都只放二进制：

- `cqgsdx_0/chatcanvas-releases`（主版镜像，历史版本 v2.2.x 起）
- `cqgsdx_0/hangtianai-releases`（航天AI）

---

## 2. 品牌是怎么切换的

品牌配置的唯一真相是 `brands/<id>/brand.json`，用环境变量选择：

```bash
CHATCANVAS_BRAND=hangtianai   # 航天AI
# 不设置则为 chatcanvas（主版）
```

所有 npm 脚本都会先跑 `scripts/brand.mjs prepare`，生成两个**不入库**的文件：

- `src/shared/brand.generated.ts` —— 前端与 Node 后端共用
- `src-tauri/tauri.brand.generated.json` —— Tauri 构建时用 `--config` 合并进去

改品牌只需改 `brand.json`，不要直接改生成物。改完必须重新 `prepare`，
因为它是构建前一次性生成的快照。

几个容易踩的约束：

- `apiVersion` 必须匹配脚本要求，否则 `brand.mjs` 直接抛错。
- 独立品牌的 `identifier` 和 `backendPort` **都必须**与主版不同。
  端口相同时，后启动的一方会通过 `reclaim_backend_port` 直接杀掉对方的后端，
  表现为「添加渠道报错」这类说不清的问题。
- Web 素材放 `brands/<id>/public/`，在 `brand.json` 里用 `/branding/<文件名>` 引用。
  Vite 会把整个目录复制到 `dist/client/branding`，所以每个包只带自己的图。
  放到 `src/client/public/` 会让两个品牌互相夹带对方的 logo。
- 安装图标路径相对 `src-tauri`，航天AI 用 `brand-icons/hangtianai/`。

---

## 3. 素材从原图派生

只维护一张原图，其余全部派生：

```bash
# 原图放 brands/<id>/assets/logo.png，然后：
node scripts/brand-assets.mjs --brand hangtianai
```

带头盔/人像的方形插画需要裁切和圆形遮罩：

```bash
node scripts/brand-assets.mjs --brand hangtianai --crop 0.09,0.02,0.76 --round
```

- `--crop x,y,边长` 用比例（0–1），从原图里取一块正方形
- `--round` 给侧栏标记加圆形遮罩，浅色侧栏里不会出现方形深底
- `--mark <文件>` 直接指定已精修好的剪影图，跳过自动生成
- 不带 `--crop` 时走亮度阈值剪影，只适合「白底黑标」这种干净图；
  星空、光效类插画会被背景噪点污染，改用 `--crop` + `monochromeMark: false`

`tauri icon` 会顺带生成 android/ios 目录，脚本会自动删掉（桌面应用用不到）。

---

## 4. 本地打包

```bash
# 0) 先停掉 dev，否则 prepare-tauri 重写 resources 会和它互相干扰
#    （vite 的 5173 和 tsx watch 的 17891）

# 1) 只出可执行文件（快，约 2 分钟，不需要私钥）
CHATCANVAS_BRAND=hangtianai npm run tauri:build:exe

# 2) 完整安装包（含更新包与签名，约 8 分钟，需要私钥）
CHATCANVAS_BRAND=hangtianai npm run tauri:build

# 3) 整理成 ASCII 产物名，收到 artifacts/
CHATCANVAS_BRAND=hangtianai node scripts/package-installer.mjs
```

产物落在 `src-tauri/target/release/bundle/nsis/`，中文品牌名会变成中文文件名
（`航天AI_2.4.7_x64-setup.exe`），第 3 步会改写成
`hangtianai-v2.4.7-win-x64-setup.exe`，这样更新清单里的 URL 可预测。

**改名不影响验签**：minisign 的签名只校验文件内容，不看文件名。

### 路径陷阱

项目目录如果是符号链接（Windows junction，例如从桌面指向 D 盘），
`npm run build` 会报：

```
[vite:build-html] ... received "D:/.../src/client/index.html"
```

这不是配置错误，**换到真实路径执行即可**。同理，`scripts/brand.mjs` 的 CLI
入口用 `fs.realpathSync` 比较自身路径，否则在 junction 下会静默跳过整个命令
（prepare 不执行、构建沿用上一次的生成物）。

---

## 5. 私钥与令牌

### 更新签名密钥

每个品牌一对，**生成一次，丢了就无法给已安装用户推送更新**。

```bash
npx tauri signer generate -w ~/.tauri/hangtianai-updater.key --ci
```

- 私钥：`~/.tauri/hangtianai-updater.key`（348 字符单行，**绝不入库**）
- 公钥：写进 `brands/<id>/brand.json` 的 `desktop.updater.pubkey`

本地打包时 `scripts/tauri-bundle.mjs` 会自动去 `~/.tauri/<signingKeyFile>` 找私钥；
找不到会直接报错并给出版命令，不会让 Tauri 在最后一步抛含糊的签名失败。

自检密钥可用（不产生真实发布）：

```bash
printf 'test' > /tmp/t.txt
node node_modules/@tauri-apps/cli/tauri.js signer sign /tmp/t.txt \
  --private-key-path ~/.tauri/hangtianai-updater.key -p ""
```

### CI 里的存放位置

| 名称 | 值 | 放哪 |
|---|---|---|
| `HANGTIANAI_SIGNING_PRIVATE_KEY` | 私钥全文 | GitHub → Settings → Secrets and variables → Actions → **Secrets** |
| `GITEE_TOKEN` | Gitee 私人令牌（勾 projects） | 同上 |

两个都要。Workflow 里写成 `secrets.X || vars.X`，容忍误配到 Variables 标签页，
但**私钥放 Variables 是明文存储，发现配错了要挪到 Secrets**。

工作流的构建 job 声明了 `environment: image_key`，所以环境级 Secret 也能读到。

---

## 6. 发布流程

### 自动（推荐）

主版和航天AI 都由同一个 tag 触发：

```bash
npm run version:set -- 2.4.8      # 四处版本号 + 文档引用一起改
# 补 CHANGELOG.md 与 CHANGELOG-hangtianai.md 的对应段落
git commit -am "release: v2.4.8 ..."
git tag v2.4.8 && git push && git push --tags
```

推送后两条 workflow 并行：

| Workflow | 触发条件 | 产物 |
|---|---|---|
| `release.yml` | `v*` | 主版：GitHub 的 exe + 两个 dmg + `updater/latest.json` |
| `release-hangtianai.yml` | `v*` | 航天AI：Gitee 的 exe + GitHub 的 arm64 dmg + Gitee 的 `updater/latest.json` |

两条互相独立，Gitee 出问题不会把主版发布拖红。

补发某次构建（不改代码）用 Actions 页面的 **Run workflow**，
`release_tag` 填已有 tag 即可。

### 手动（CI 不可用时兜底）

缺 secret、runner 排队太久、Gitee 抽风时用这条：

```bash
# 1) 本地打包并整理产物（见第 4 节），得到 artifacts/hangtianai-v2.4.7-win-x64-setup.exe(.sig)

# 2) 生成更新清单
npx tsx scripts/write-latest-json.ts \
  --version 2.4.7 \
  --file-name hangtianai-v2.4.7-win-x64-setup.exe \
  --base-url "https://gitee.com/cqgsdx_0/hangtianai-releases/releases/download/v2.4.7" \
  --signature artifacts/hangtianai-v2.4.7-win-x64-setup.exe.sig \
  --changelog CHANGELOG-hangtianai.md \
  --out artifacts/latest.json

# 3) 上传（先附件、后清单）
GITEE_TOKEN=xxx CHATCANVAS_BRAND=hangtianai node scripts/publish-gitee-release.mjs \
  v2.4.7 \
  artifacts/hangtianai-v2.4.7-win-x64-setup.exe \
  artifacts/hangtianai-v2.4.7-win-x64-setup.exe.sig \
  --updater artifacts/latest.json
```

顺序不能反：清单先指过去而附件还没传完，中间那段时间检查更新的用户会拿到 404。

macOS 的 dmg 只能由 macOS 机器产出，Windows 上无法交叉编译，
所以本地兜底只覆盖 Windows；mac 版仍要等 CI 或找一台 Mac。

### 同一条 tag 的安装包不可变

安装包一旦上传就不能覆盖：更新清单里的签名是对那份文件签的，
只换文件不换签名，已安装用户下载后验签必然失败。

`publish-gitee-release.mjs` 会下载线上同名附件**逐字节比对**（不是只比大小，
等长但内容不同的两次构建并不罕见）：

- 内容一致 → 幂等跳过，重跑 CI 是安全的
- 内容不同 → 直接报错，要求把版本号加一

要重新发同一个版本，正确做法只有一个：**改版本号，发新 tag**。

清单是唯一允许替换的附件，而且有三道前置检查，任何一道不过都不会动线上文件：

1. 线上已有清单却读不到 → 放弃（拿不到备份就删，等于所有用户的更新一起中断）
2. 读到了但不是合法 JSON → 放弃
3. 新版本低于线上 → 放弃，除非显式加 `--allow-downgrade`

通过之后才「备份 → 删除 → 上传」，上传失败会用备份把旧清单补回去。

---

## 7. 发布后验收

```bash
# 未登录状态能读到清单，且版本正确
curl -s https://gitee.com/cqgsdx_0/hangtianai-releases/releases/download/updater/latest.json

# 安装包可匿名下载
curl -sI https://gitee.com/cqgsdx_0/hangtianai-releases/releases/download/v2.4.7/hangtianai-v2.4.7-win-x64-setup.exe
```

四条硬指标：

1. 同一个源码能出两个包，品牌、版本、commit 都可追溯
2. 两版能同时安装、同时运行，数据目录互不干扰
3. 功能与主版一致，渠道模板、图床、模型请求正常
4. 能从各自的更新源检测、下载、验签并安装，升级后旧数据仍可读

**首版无法自测自动更新**——更新器只在已安装旧版本时才检查。
要验证完整链路，必须装了 N 版之后发 N+1 版。

---

## 8. 故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `Check signing secret` 失败，长度 0 | Secret 没配 / 配到 Variables / 环境名不对 | 看日志里的长度；Secrets 标签页重新添加 |
| `brand.mjs` 无输出、prepare 像没跑 | 从符号链接路径调用，入口判断失效 | `cd` 到真实路径 |
| `[vite:build-html] received "D:/..."` | 同上，Vite 解析到了真实路径 | 同上 |
| 上传报 `Cannot read properties of null` | Gitee 对不存在的 tag 返回 200 + 空 body，已修 | 更新脚本 |
| 上传报超过 100 MB | dmg 太大 | 改发 GitHub，或分包 |
| 两版后端互相杀掉 | 端口相同，`reclaim_backend_port` | 给独立品牌设不同 `backendPort` |
| 主版包里出现航天AI 的图 | 素材放进了 `src/client/public/` | 移到 `brands/<id>/public/`，用 `/branding/` 引用 |
| 装完更新变成主版 | `identifier` 或 `updater.endpoints` 沿用了主版 | 每个独立品牌必须有自己的两者 |
| `npm test` 挂住十几分钟 | 有遗留的 vite / tsx watch / tauri dev 进程 | 结束 `all_image_make\node_modules` 下的 node 进程 |

---

## 9. 版本号规则

- 与主版**同号**（2.4.7 → 2.4.8），不体现「哪个品牌更新到哪」
- **不要加 prerelease 后缀**（`2.4.8-beta.1`）：Tauri 的更新器会把预发布版判为低于正式版，
  已装用户收不到该更新
- tag 一律 `vX.Y.Z`；航天AI 在 GitHub 上的 Mac 归档用 `hangtianai-vX.Y.Z` 区分

---

## 10. 常用命令速查

```bash
# 品牌
node scripts/brand.mjs prepare              # 生成当前品牌的配置
node scripts/brand.mjs port                 # 当前品牌的端口
CHATCANVAS_BRAND=hangtianai node scripts/brand.mjs port

# 素材
node scripts/brand-assets.mjs --brand hangtianai --crop 0.09,0.02,0.76 --round

# 构建
CHATCANVAS_BRAND=hangtianai npm run tauri:build        # 完整安装包
CHATCANVAS_BRAND=hangtianai npm run tauri:build:exe    # 只要 exe
node scripts/package-installer.mjs                      # 整理产物名

# 版本
npm run version:set -- 2.4.8

# 测试（会自动切到主版配置）
npm test
```
