import multer from "multer";
import { referenceMediaKindOf } from "../reference-video.js";
import { AppError } from "../tasks.js";

export const referenceImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;

export const referenceVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 + 1, fieldSize: 16 * 1024 * 1024, files: 1, fields: 1 },
  fileFilter: (_req, file, callback) => referenceMediaKindOf(file) === "video"
    ? callback(null, true) : callback(new AppError("REFERENCE_VIDEO_INVALID", "仅支持 MP4 / MOV 视频", 400)),
});
