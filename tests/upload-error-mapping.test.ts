import multer from "multer";
import { describe, expect, it } from "vitest";

import { multerErrorResponse } from "../src/server/app";

describe("multer 上传错误映射", () => {
  it("payload 字段超长给 413 与「提交内容过大」，不再误报「参考图最多 8 张」", () => {
    const mapped = multerErrorResponse(
      new multer.MulterError("LIMIT_FIELD_VALUE", "payload"),
      "/api/generations/reference-media",
    );
    expect(mapped.status).toBe(413);
    expect(mapped.code).toBe("PAYLOAD_TOO_LARGE");
    expect(mapped.message).toContain("提交内容过大");
    expect(mapped.message).not.toContain("最多上传");
  });

  it("文件超限仍按路由给出各自的上限文案", () => {
    expect(multerErrorResponse(new multer.MulterError("LIMIT_FILE_SIZE", "video"), "/api/generations/reference-media").message)
      .toBe("素材文件不能超过 100 MB");
    expect(multerErrorResponse(new multer.MulterError("LIMIT_FILE_SIZE", "referenceImages"), "/api/generations").message)
      .toBe("单张参考图不能超过 20 MB");
    expect(multerErrorResponse(new multer.MulterError("LIMIT_FILE_SIZE", "mask"), "/api/generations").message)
      .toBe("蒙版不能超过 20 MB");
  });

  it("张数超限、蒙版多余、未知错误都有确定的归宿", () => {
    expect(multerErrorResponse(new multer.MulterError("LIMIT_FILE_COUNT"), "/api/generations").message)
      .toBe("上传的图片数量超出限制");
    expect(multerErrorResponse(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "mask"), "/api/generations").code)
      .toBe("INVALID_MASK");
    const fallback = multerErrorResponse(new multer.MulterError("LIMIT_PART_COUNT"), "/api/generations");
    expect(fallback.status).toBe(400);
    expect(fallback.code).toBe("INVALID_REFERENCE_IMAGES");
  });
});
