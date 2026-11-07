/** 跨轮消息序列：要求只提一次，后续「开始 / 换风格 / 修改」都要继承。 */
export const CONVERSATION = [
  { messageId: "m1", text: "把这份 18 章文档整理成 10 页 PPT，含封面，必须保留三个案例，先不生成", phase: "prepare" },
  { messageId: "m2", text: "开始", phase: "start" },
  { messageId: "m3", text: "换成杂志风", phase: "style" },
  { messageId: "m4", text: "把第 3 页改成对比结构", phase: "edit" },
  { messageId: "m5", text: "改成 12 页", phase: "revision" },
  { messageId: "m6", text: "另做一份", phase: "fork" },
  { messageId: "m7", text: "继续 PPT", phase: "resume" },
] as const;

/** 普通聊天不应意外创建任务契约。 */
export const NEUTRAL_MESSAGES = [
  "帮我总结一下这段话",
  "今天天气不错",
  "这个数字是什么意思",
] as const;
