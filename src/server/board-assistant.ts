import { BOARD_LIMITS, composeConfigPrompt, directInputLinks, type BoardNode } from "../shared/board.js";
import type { AppDatabase, BoardRecord } from "./db.js";
import { unsupportedLabels } from "../shared/channel-fields.js";
import { resolveAlias, type CapabilityAlias } from "./capabilities.js";
import { resolveBoardVideoSelection } from "./board-video-selection.js";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "../shared/video-capabilities.js";

/** 只描述用户当前画布中确实有关联的分镜，不暗示项目会自动同步。 */
export function describeBoardStoryboards(db: AppDatabase, board: BoardRecord, refs?: string[]): string {
  const roots = refs?.length ? board.doc.nodes.filter((node) => refs.includes(node.ref)) : board.selection.length ? board.doc.nodes.filter((node) => board.selection.includes(node.id)) : board.doc.nodes;
  const keys = new Set(roots.flatMap((node) => node.storyboard ? [`${node.storyboard.projectId}\0${node.storyboard.shotId}`] : []));
  if (!keys.size) return "当前范围没有关联的结构化分镜。旧画布可能没有分镜关联信息。";
  const lines = [...keys].slice(0, 30).map((key) => {
    const [projectId, shotId] = key.split("\0");
    const project = db.getStoryboardProject(projectId!);
    const index = project?.data.shots.findIndex((shot) => shot.id === shotId) ?? -1;
    if (!project || index < 0) return `分镜 ${shotId} 的项目或镜头已不存在`;
    const shot = project.data.shots[index]!;
    const nodes = board.doc.nodes.filter((node) => node.storyboard?.projectId === projectId && node.storyboard.shotId === shotId);
    const state = nodes.map((node) => `${node.ref}(${node.storyboard?.role}:${node.type === "text" ? "文本" : node.status})`).join("、");
    const roleVersions = Object.entries(shot.characterVersions).map(([name, id]) => { const version = project.data.characters.find((item) => item.name === name)?.variants.find((item) => item.id === id); return version ? `${name}:${version.name}` : ""; }).filter(Boolean).join("、");
    const propVersions = Object.entries(shot.propVersions).map(([name, id]) => { const version = project.data.props.find((item) => item.name === name)?.variants.find((item) => item.id === id); return version ? `${name}:${version.name}` : ""; }).filter(Boolean).join("、");
    const sceneVersion = project.data.scenes.find((item) => item.name === shot.scene)?.variants.find((item) => item.id === shot.sceneVersionId)?.name;
    return `${project.data.name} 第 ${index + 1} 镜（项目版本 ${project.revision}，画布为导入时快照）：场景 ${shot.scene || "未填"}${sceneVersion ? `/${sceneVersion}` : ""}；角色 ${shot.character || "无"}${roleVersions ? `（${roleVersions}）` : ""}；道具 ${shot.props || "无"}${propVersions ? `（${propVersions}）` : ""}；首帧 ${shot.prompt.slice(0, 200)}；视频 ${shot.videoPrompt.slice(0, 200) || "未填"}；台词 ${shot.dialogue.slice(0, 120) || "无"}；节点 ${state || "无"}`;
  });
  const projectIds = [...new Set([...keys].map((key) => key.split("\0")[0]!))];
  const settings = projectIds.flatMap((id) => { const project = db.getStoryboardProject(id); if (!project) return [];
    const entries = ([ ["角色", project.data.characters], ["场景", project.data.scenes], ["道具", project.data.props] ] as const).flatMap(([kind, items]) => items.map((item) => `${kind} ${item.name}：${item.variants.map((v) => `${v.name}(版本ID=${v.id})`).join("、") || "无其他版本"}`));
    return [`项目 ${project.data.name}（版本 ${project.revision}）的设定：${entries.join("；") || "无"}`]; });
  return `已关联分镜（最多展示 30 镜）：\n${lines.join("\n")}${keys.size > 30 ? "\n还有未展示的镜头，请按节点范围逐批查看。" : ""}\n${settings.join("\n")}\n分镜项目和画布快照独立，修改一方不会自动更新另一方。`;
}

export function inspectBoardGeneration(db: AppDatabase, board: BoardRecord, aliases: CapabilityAlias[], defaults: { image?: string; video?: string; music?: string; speech?: string }, refs: string[], overrides?: Record<string, unknown>) {
  return refs.map((ref) => {
    const original = board.doc.nodes.find((item) => item.ref === ref);
    const node = original && overrides ? { ...original, ...overrides } as BoardNode : original;
    if (!node || node.type === "text") return { ref, errors: ["节点不存在或不是生成节点"], warnings: [], model: "", kind: "" };
    const kind = node.type === "config" ? node.mode : node.type;
    const links = directInputLinks(board.doc, node.id);
    const errors: string[] = []; const warnings: string[] = [];
    const prompt = composeConfigPrompt(board.doc, { id: node.id, prompt: node.prompt ?? "", useUpstreamText: node.useUpstreamText !== false }).trim();
    if (!prompt) errors.push("提示词为空");
    if (node.status === "loading") errors.push("节点正在生成");
    if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId) warnings.push("生成会替换当前节点素材，旧素材保留在历史中");
    const missing = links.filter((link) => (link.node.type === "image" || link.node.type === "video" || link.node.type === "audio") && !link.node.assetId);
    if (missing.length) errors.push(`上游素材未就绪：${missing.map((link) => link.node.ref).join("、")}`);
    const images = links.filter((link) => link.node.type === "image" && link.node.assetId);
    if (images.length > BOARD_LIMITS.maxUpstreamImages) errors.push(`上游图片超过 ${BOARD_LIMITS.maxUpstreamImages} 张`);
    if (kind === "audio" && links.some((link) => link.node.type !== "text")) errors.push("音频生成仅接受文本上游");
    const wanted = kind === "audio" ? node.audioKind === "music" ? "suno-music" : "gemini-tts" : "";
    const candidates = wanted ? aliases.filter((item) => item.adapterType === wanted) : aliases;
    const fallback = kind === "video" ? defaults.video : kind === "audio" ? node.audioKind === "music" ? defaults.music : defaults.speech : defaults.image;
    const resolved = kind === "text" ? null : resolveAlias(candidates, node.model, kind, fallback);
    if (kind !== "text" && !resolved) errors.push("没有可用的对应模型");
    if (kind === "video" && links.some((link) => link.node.type === "video" && link.node.assetId)) warnings.push("参考视频会上传至渠道配置的图床，可能可通过公网访问");
    const channel = resolved ? db.getChannel(resolved.channelId) : null;
    if (kind === "video" && resolved) {
      if (channel) {
        const check = resolveBoardVideoSelection({ doc: board.doc, config: node, adapterType: channel.adapterType, model: resolved.model }); if (check.error) errors.push(check.error);
        const capability = VIDEO_CAPABILITIES[channel.adapterType as VideoAdapter];
        if (capability) {
          if (node.durationSeconds && (node.durationSeconds < capability.durations.min || node.durationSeconds > capability.durations.max || (capability.durations.fixed !== null && node.durationSeconds !== capability.durations.fixed))) errors.push(`视频时长不符合 ${capability.label} 的范围`);
          if (node.resolution && !capability.resolutions.includes(node.resolution)) errors.push(`当前模型不支持分辨率 ${node.resolution}`);
          if (node.audio && !capability.supportsAudio) warnings.push("当前模型不支持生成音频参数");
        }
      }
    }
    // 设了但当前渠道不认的字段：生成前就说清楚，别等出图了才发现「比例没生效」
    if (channel) {
      const ignored = unsupportedLabels(channel.adapterType, {
        negativePrompt: node.negativePrompt,
        aspectRatio: node.aspectRatio,
        ratio: node.ratio,
        duration: node.durationSeconds,
        resolution: node.resolution,
        audio: node.audio,
        seed: node.seed,
        watermark: node.watermark,
        size: node.size,
        imageSize: node.imageSize,
        quality: node.quality,
        style: node.style,
        background: node.background,
        outputFormat: node.outputFormat,
        moderation: node.moderation,
      });
      if (ignored.length) warnings.push(`当前渠道会忽略：${ignored.join("、")}`);
    }
    if (node.storyboard) {
      const project = db.getStoryboardProject(node.storyboard.projectId);
      const shot = project?.data.shots.find((item) => item.id === node.storyboard!.shotId);
      if (shot?.dialogue && !board.doc.nodes.some((item) => item.storyboard?.projectId === node.storyboard!.projectId && item.storyboard.shotId === shot.id && item.storyboard.role === "audio" && item.type === "audio" && item.assetId)) warnings.push("本镜有台词但未发现已生成的配音");
    }
    return { ref, kind, model: resolved?.alias ?? (kind === "text" ? "画布助手对话模型" : "未配置"), inputCount: links.length, errors, warnings };
  });
}
