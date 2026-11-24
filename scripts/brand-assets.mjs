import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Jimp } from "jimp";
import { readBrand } from "./brand.mjs";

/**
 * 从一张原图派生品牌素材。
 *
 *   node scripts/brand-assets.mjs --brand hangtianai --source <原图.png>
 *   node scripts/brand-assets.mjs --brand hangtianai --source <原图.png> --mark <剪影.png>
 *
 * 产出（路径全部由 brand.json 决定，脚本里不写死品牌）：
 *   · <web 资源目录>/app-icon.png    512×512 彩色，站点图标与 favicon 共用
 *   · <web 资源目录>/brand-mark.png  256×256 单色剪影，侧栏用 CSS mask 上色
 *   · src-tauri/<icons 目录>/        32/128/128@2x + icns + ico，交给 tauri icon 生成
 *
 * 原图要求：正方形最好；非正方形会居中裁切，不会拉伸变形。
 */

const root = fileURLToPath(new URL("../", import.meta.url));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * 品牌 Web 素材目录。
 *
 * 必须落在 `brands/<id>/public/`：vite 构建时把它整目录复制到 `dist/client/branding`，
 * 所以每个品牌的包里只会带自己那份图，不会互相夹带对方的 logo。
 */
function brandPublicDir(brandId) {
  return path.join(root, "brands", brandId, "public");
}

/** brand.json 里的 Web 素材必须用 `/branding/` 前缀，否则构建产物里会 404。 */
function assertBrandingPath(assetPath) {
  if (!assetPath.startsWith("/branding/")) {
    throw new Error(`品牌 Web 素材应使用 /branding/ 前缀，当前是 ${assetPath}（见 vite.config.ts 的 brandAssets）`);
  }
}

/** 按比例裁出正方形区域。`--crop 0.09,0.02,0.76` 表示左上角 9%/2%、边长 76%。 */
function cropSquare(image, crop) {
  const [rx, ry, ratio] = crop;
  if (rx < 0 || ry < 0 || ratio <= 0 || rx + ratio > 1.001 || ry + ratio > 1.001) {
    throw new Error(`--crop 超出图片范围：${crop.join(",")}（三个值都在 0–1 之间，且 x+w、y+w 不超过 1）`);
  }
  const { width, height } = image.bitmap;
  const side = Math.round(Math.min(width, height) * ratio);
  image.crop({ x: Math.round(rx * width), y: Math.round(ry * height), w: side, h: side });
  return image;
}

/** 圆形遮罩，边缘留一像素做抗锯齿，浅色侧栏里不会出现方形深底。 */
function applyRoundMask(image) {
  const { data, width, height } = image.bitmap;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = Math.min(width, height) / 2 - 1;
  image.scan((x, y, idx) => {
    const distance = Math.hypot(x - cx, y - cy);
    const edge = Math.max(0, Math.min(1, radius + 1 - distance));
    data[idx + 3] = Math.round(data[idx + 3] * edge);
  });
  return image;
}

/**
 * 生成单色剪影。
 *
 * 两种情况分开处理，因为结果差别很大：
 * - 原图本身带透明背景（设计稿导出）：直接把 alpha 当形状，RGB 归零；
 * - 原图是不透明方图（照片、AI 生图）：按亮度切阈值。默认把暗部当主体，
 *   白底黑标的图直接可用；主体比背景亮时加 `--invert`。
 *
 * 带星空、光效的插画**不适合**这条路：背景噪点会被当成形状，头盔内的暗面还会被挖空。
 * 这种图应该用 `--crop` 取头部后直接显示彩色标记（brand.json 里 monochromeMark=false）。
 */
async function writeMonochromeMark(sourceFile, targetFile, invert) {
  const image = await Jimp.read(sourceFile);
  image.cover({ w: 256, h: 256 });

  const { data } = image.bitmap;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent += 1;
  const hasAlpha = transparent / (data.length / 4) > 0.05;

  const threshold = 128;
  image.scan((_x, _y, idx) => {
    const luminance = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    const opaque = hasAlpha ? data[idx + 3] >= 128 : invert ? luminance >= threshold : luminance < threshold;
    data[idx] = 0;
    data[idx + 1] = 0;
    data[idx + 2] = 0;
    data[idx + 3] = opaque ? 255 : 0;
  });

  await image.write(targetFile);
  return hasAlpha ? "透明通道" : `亮度阈值 ${invert ? "亮部" : "暗部"}为主`;
}

async function main() {
  const brandId = option("--brand") ?? process.env.CHATCANVAS_BRAND ?? "chatcanvas";
  const brand = readBrand(brandId);
  const assetsDir = path.join(root, "brands", brandId, "assets");
  const source = path.resolve(option("--source") ?? path.join(assetsDir, "logo.png"));
  const markOverride = option("--mark");
  const invert = process.argv.includes("--invert");
  const round = process.argv.includes("--round");
  const cropArg = option("--crop");
  const crop = cropArg ? cropArg.split(",").map(Number) : null;
  if (crop && (crop.length !== 3 || crop.some((value) => !Number.isFinite(value)))) {
    throw new Error(`--crop 需要三个数字：x,y,边长（比例，0–1），例如 --crop 0.09,0.02,0.76`);
  }

  if (!fs.existsSync(source)) {
    throw new Error(
      [
        `找不到原图：${source}`,
        "",
        `请把 1024×1024 的成品图放到 brands/${brandId}/assets/logo.png，或用 --source 指定路径。`,
        "原图只作为派生源，不会被复制进安装包。",
      ].join("\n"),
    );
  }

  const webDir = brandPublicDir(brandId);
  assertBrandingPath(brand.web.favicon);
  assertBrandingPath(brand.web.mark);
  const iconsRel = brand.desktop.icons[0];
  const iconsDir = path.join(root, "src-tauri", path.dirname(iconsRel));
  fs.mkdirSync(webDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });

  // 1) 彩色方图：cover 而不是 resize，避免非正方形原图被拉伸。
  //    给了 --crop 就只取那块（例如从整张插画里取头盔），小尺寸下更认得出。
  const appIcon = await Jimp.read(source);
  if (crop) cropSquare(appIcon, crop);
  appIcon.cover({ w: 512, h: 512 });
  const appIconFile = path.join(webDir, path.basename(brand.web.favicon));
  await appIcon.write(appIconFile);
  console.log(`app-icon  → ${path.relative(root, appIconFile)} (512×512${crop ? "，已裁切" : ""})`);

  // 2) 侧栏标记：--mark 优先（作者已精修），其次 --crop 裁彩色版，最后才走单色剪影。
  const markFile = path.join(webDir, path.basename(brand.web.mark));
  if (markOverride) {
    const markImage = await Jimp.read(path.resolve(markOverride));
    markImage.cover({ w: 256, h: 256 });
    if (round) applyRoundMask(markImage);
    await markImage.write(markFile);
    console.log(`brand-mark → ${path.relative(root, markFile)} (来自 --mark)`);
  } else if (crop) {
    const markImage = await Jimp.read(source);
    cropSquare(markImage, crop);
    markImage.cover({ w: 256, h: 256 });
    if (round) applyRoundMask(markImage);
    await markImage.write(markFile);
    console.log(`brand-mark → ${path.relative(root, markFile)} (256×256，裁切彩色${round ? " + 圆形" : ""})`);
  } else {
    const how = await writeMonochromeMark(source, markFile, invert);
    console.log(`brand-mark → ${path.relative(root, markFile)} (256×256，${how})`);
  }

  // 3) 安装图标：交给官方 CLI，icns/ico 各尺寸都由它负责，不自己拼。
  const tauriCli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const result = spawnSync(process.execPath, [tauriCli, "icon", appIconFile, "-o", iconsDir], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tauri icon 失败（exit ${result.status}）`);

  // 这是桌面应用，mobile 目录既用不到又要占 1 MB 左右，生成完就清掉。
  for (const mobile of ["android", "ios"]) {
    fs.rmSync(path.join(iconsDir, mobile), { recursive: true, force: true });
  }

  const missing = brand.desktop.icons.filter((icon) => !fs.existsSync(path.join(root, "src-tauri", icon)));
  if (missing.length) throw new Error(`以下图标没有生成出来：${missing.join("、")}`);
  console.log(`安装图标 → ${path.relative(root, iconsDir)}（${brand.desktop.icons.length} 个已确认）`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
