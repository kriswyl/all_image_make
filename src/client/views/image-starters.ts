/**
 * 图片工作台空态的「作品示例」。
 *
 * 五张图覆盖五种常见出图方向（人像 / 产品 / 运动 / 美食 / 版画），点击任意一张
 * 会把对应提示词填进下方输入框——它不是装饰墙，而是一个「起点」：
 * 用户不用从零想提示词，改两个字就能开跑。
 *
 * 图片放在 `public/starter/`，均已裁成 3:4、宽 360px，单张 12–64KB。
 * 05 的浮世绘来自大都会博物馆开放获取（CC0）；其余四张来自 Unsplash（免费商用）。
 */
export type ImageStarter = {
  id: string;
  src: string;
  /** 无正脸 / 无商标的简短说明，读屏和 tooltip 都会用到 */
  label: string;
  prompt: string;
};

export const IMAGE_STARTERS: ImageStarter[] = [
  {
    id: "portrait",
    src: "/starter/01-portrait.jpg",
    label: "人像摄影",
    prompt: "商务人像摄影，浅灰背景，男士半身正面，柔和顶侧光，85mm 镜头浅景深，皮肤质感真实，自然表情",
  },
  {
    id: "product",
    src: "/starter/02-product.jpg",
    label: "产品静物",
    prompt: "极简产品静物摄影，纯白背景，智能手表平铺，柔和阴影，45 度俯拍，商业广告质感，大面积留白",
  },
  {
    id: "action",
    src: "/starter/03-action.jpg",
    label: "动感运动",
    prompt: "田径跑道起跑特写，低机位，运动鞋与小腿，胶片颗粒感，强烈逆光，速度感定格",
  },
  {
    id: "food",
    src: "/starter/04-food.jpg",
    label: "美食氛围",
    prompt: "中式火锅俯拍，木桌与深色桌布，蒸汽与暖光，食材细节丰富，暖色调，美食杂志风格",
  },
  {
    id: "ukiyoe",
    src: "/starter/05-ukiyoe.jpg",
    label: "浮世绘版画",
    prompt: "浮世绘木版画风格，巨浪与远山，靛蓝与米白配色，粗黑轮廓线，和纸纹理，日式古典构图",
  },
];
