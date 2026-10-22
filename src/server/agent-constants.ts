import { MAX_CANVAS_IMAGES } from "../shared/types.js";

/** 一轮用户消息里最多让大脑思考几次。6 次够覆盖「优化→生图→改图→生成视频」这种长链 */
export const MAX_ROUNDS = 6;
/** 一个会话连续自动续跑的上限，防止「视频好了→大脑又要生成→视频好了」无限烧钱 */
export const MAX_AUTO_CONTINUE = 3;
/** 单个会话的任务软上限（§16）。到这个数以后每次生成都要用户点头 */
export const MAX_SESSION_TASKS = 20;
/** JSON 解析失败时的重试次数 */
export const MAX_PARSE_RETRY = 1;
/**
 * 一轮里大脑最多主动「看一眼」几次。
 * 看图本身不花钱，但每次都是一趟完整的大脑请求；给 3 次足够覆盖
 * 「先看画布 → 选图 → 发现看漏了再看一张」。
 */
export const MAX_VISION_READS_PER_ROUND = 3;
/** 一次 view_images 最多附几张缩略图。和画布上限一致 */
export const MAX_VISION_IMAGES = MAX_CANVAS_IMAGES;
