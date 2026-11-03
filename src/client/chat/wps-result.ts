/** The WPS relay can return status 0 even when the add-in reports an error. */
export function assertWpsPreviewResult(result: { status: number; message?: string; msg?: string; response?: unknown }, first: number, last: number): void {
  if (result.status !== 0) throw new Error(result.message || result.msg || "WPS 没有完成预览，请检查加载项是否已启用");
  let value: unknown = result.response;
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  if (value && typeof value === "object" && "data" in value && !("ok" in value)) value = (value as { data: unknown }).data;
  if (value && typeof value === "object" && "ok" in value) {
    const outcome = value as { ok?: unknown; first?: unknown; last?: unknown; stage?: unknown; message?: unknown };
    if (outcome.ok === true && outcome.first === first && outcome.last === last) return;
    const stage = typeof outcome.stage === "string" ? outcome.stage.slice(0, 80) : "执行预览";
    const message = typeof outcome.message === "string" ? outcome.message.replace(/[a-f0-9]{64}/gi, "[已隐藏]").slice(0, 300) : "加载项没有确认成功";
    throw new Error(`WPS ${stage}失败：${message}`);
  }
  const detail = typeof value === "string" ? value.replace(/[a-f0-9]{64}/gi, "[已隐藏]").slice(0, 200) : "没有返回加载项结果";
  throw new Error(`WPS 已响应，但未确认逐页导出：${detail}`);
}
