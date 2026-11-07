/**
 * 固定评测语料：全部为虚构培训资料，不含任何真实文档。
 * 章节数与事实清单由开发者独立编写，expected 不得从模型输出反推。
 */
export const SOURCE_TITLE = "虚构运营培训资料";
export const CHAPTER_COUNT = 18;

export const CHAPTERS = Array.from({ length: CHAPTER_COUNT }, (_, index) => {
  const number = index + 1;
  return {
    id: `c${String(number).padStart(2, "0")}`,
    title: `模块${number}：虚构运营环节`,
    fact: `培训样例指标 F${String(number).padStart(2, "0")}：示例订单量为 ${100 + (number - 1) * 13}，仅为虚构演示数据。`,
    condition: `该模块由岗位 ${number} 负责，统计周期以自然周为准。`,
  };
});

export const SOURCE_MARKDOWN = [
  `# ${SOURCE_TITLE}`,
  "备注：全部数值与岗位均为虚构验收资料，不代表真实经营数据。",
  ...CHAPTERS.flatMap(chapter => [`## ${chapter.title}`, `- ${chapter.fact}`, `- ${chapter.condition}`]),
].join("\n");

/** 用户明确要求必须保留的三个案例，压缩到 10 页时仍需出现在正文。 */
export const REQUIRED_CASES = [
  "案例 A：账户异常登录的处置流程",
  "案例 B：退货率异常的商品复核",
  "案例 C：履约成本超阈值的复盘",
];

/** 虚构的 1×1 PNG，用于验证「指定图片必须真正落位到页面」。 */
export const FIXTURE_ASSET_ID = "asset-cover-01";
export const FIXTURE_IMAGE = {
  title: "虚构封面图",
  data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=",
};

/** 确定性事实：精确数值与单位，备注里出现不算覆盖。 */
export const REQUIRED_FACTS = [
  "示例订单量为 100",
  "示例订单量为 126",
  "示例订单量为 217",
];
