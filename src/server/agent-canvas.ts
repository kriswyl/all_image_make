import { IMAGE_PRODUCING_TOOLS, type AgentToolName } from "../shared/agent-types.js";

/**
 * §10.1 规则 1：**只有**产出图片的工具会换掉画布。
 *
 * 视频/音乐不进画布——把画布换成一段视频，下一句「把这张的手改一下」就没有图可改了。
 * 产出图片时画布是**整组被替换成刚产出的那一张**（而不是追加）。
 */
export function canvasAfterProducing(
  current: string[],
  tool: AgentToolName,
  producedAssetId: string | undefined,
): string[] {
  if (!producedAssetId) return current;
  return IMAGE_PRODUCING_TOOLS.includes(tool) ? [producedAssetId] : current;
}

/** 两个画布是不是一模一样（决定要不要写库，别为了没变的东西碰一次数据库） */
export function sameCanvasIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
