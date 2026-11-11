export function historyReasonLabel(reason: string): string {
  if (!reason || reason === "manual" || reason === "update") return reason === "update" ? "编辑节点" : "手动保存";
  if (reason === "import") return "导入";
  if (reason === "auto-layout") return "自动排版";
  if (reason === "delete") return "删除节点";
  if (reason === "duplicate") return "复制节点";
  if (reason === "move") return "移动节点";
  if (reason === "connect") return "新增连线";
  if (reason === "disconnect") return "删除连线";
  if (reason === "generate:result") return "生成结果回填";
  if (reason === "generate:retry") return "重试生成";
  if (reason === "generate:cancel") return "停止生成";
  if (reason.startsWith("add:")) return "添加节点";
  if (reason.startsWith("generate:")) return `生成 ${reason.slice("generate:".length)}`;
  if (reason.startsWith("agent:")) return "无限画布助手修改";
  if (reason.startsWith("restore:")) return `恢复自版本 ${reason.slice("restore:".length)}`;
  if (reason.startsWith("asset:")) return "移除素材";
  if (reason.startsWith("edge:")) return "修改连线角色";
  if (reason.startsWith("group:")) return "分组调整";
  return reason.slice(0, 40);
}

export function historyTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
