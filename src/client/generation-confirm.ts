/** 提交前只展示已知信息，价格由渠道决定。 */
export function confirmGeneration(options: { kind: string; model: string; channel?: string; detail?: string; retry?: boolean }): boolean {
  const lines = [
    `即将${options.retry ? "重新提交" : "提交"}${options.kind}任务。`,
    `模型：${options.model || "当前默认模型"}`,
    ...(options.channel ? [`渠道：${options.channel}`] : []),
    ...(options.detail ? [options.detail] : []),
    "请求可能产生费用，实际费用以上游渠道为准。",
    "提交后可在对应工作区查看状态和结果。",
    "",
    "确认提交？",
  ];
  return window.confirm(lines.join("\n"));
}
