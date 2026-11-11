import { createHash } from "node:crypto";
import type { AgentToolName, ChatVideoFrames } from "../shared/agent-types.js";
import type { ToolContext } from "./agent-tools.js";
import { isVisionBlocked } from "./agent-vision.js";
import { createCapabilitySearchTool } from "./chat-tools/capability-search.js";
import { nativeAudioSpecs, prepareNativeAudio } from "./chat-tools/native-audio.js";
import { nativeImageSpecs, nativeImageViewSpec, prepareNativeImage, viewNativeImages } from "./chat-tools/native-image.js";
import { createNativeTemplateTool } from "./chat-tools/native-templates.js";
import { createNativeUtilityTool } from "./chat-tools/native-utility.js";
import { nativeVideoSpec, prepareNativeVideo } from "./chat-tools/native-video.js";
import { createPlanTool } from "./chat-tools/planning.js";
import { ChatToolRegistry, type ChatTool } from "./chat-tools/registry.js";
import type { AppDatabase } from "./db.js";
import type { PresentationCoordinator } from "./presentation-coordinator.js";

interface NativeToolsHost {
  db: AppDatabase;
  presentations: Pick<PresentationCoordinator, "registerDocumentTools" | "scheduleChecks">;
  defaultAliases(): { image?: string; video?: string };
  toolContext(): ToolContext;
}

type NativeToolsTurn = Parameters<PresentationCoordinator["registerDocumentTools"]>[1] & {
  nativeCreative: boolean;
  turnAttachmentIds: string[];
  turnVideoFrames?: ChatVideoFrames;
};

export function createNativeToolRegistry(
  { db, presentations, defaultAliases, toolContext }: NativeToolsHost,
  turn: NativeToolsTurn,
): ChatToolRegistry {
  const { conversationId, turnConversation, nativeCreative, turnAttachmentIds, turnVideoFrames } = turn;
  const registry = new ChatToolRegistry({
    before: (event, raw) => db.executions.begin(event, createHash("sha256").update(raw).digest("hex")),
    after: (event, result) => {
      const workflow = result.uiData?.workflow as { runId?: string } | undefined;
      db.executions.finish(event.operationId, result.execution?.state ?? (result.paused ? "paused" : result.ok ? "completed" : "failed"), { workflowId: workflow?.runId });
      // 候选等待视觉检查：立刻拉起检查队列，检查完成会发布同一候选。
      if (result.pendingVisualCheck) presentations.scheduleChecks();
    },
  });
  presentations.registerDocumentTools(registry, turn);
  registry.register(createPlanTool());
  registry.register(createCapabilitySearchTool(registry));
  if (nativeCreative) {
    const registerConfirmed = (spec: ChatTool["spec"], name: AgentToolName, prepareConfirmation: NonNullable<ChatTool["prepareConfirmation"]>) => registry.register({
      spec, displayName: name,
      group: name === "generate_video" ? "video" : name === "generate_music" || name === "generate_speech" ? "audio" : "image",
      prepareConfirmation,
      run: async () => ({ ok: false, summary: "此生成调用需要单独处理，请先完成当前批次" }),
    });
    for (const name of ["generate_image", "edit_image"] as const) {
      registerConfirmed(nativeImageSpecs[name], name, raw => prepareNativeImage(db, turnConversation, name, raw, turnAttachmentIds, defaultAliases().image));
    }
    // 看图关闭时不挂 view_images：挂上去只会让模型多调一次、多一条失败卡。
    if (turnConversation.visionEnabled && !isVisionBlocked(db, turnConversation)) {
      registry.register({ spec: nativeImageViewSpec, displayName: "view_images", group: "image", run: raw => viewNativeImages(db, db.getConversation(conversationId) ?? turnConversation, raw) });
    }
    registerConfirmed(nativeVideoSpec, "generate_video", raw => prepareNativeVideo(db, turnConversation, raw, turnAttachmentIds, defaultAliases().video, turnVideoFrames));
    for (const name of ["generate_music", "generate_speech"] as const) {
      registerConfirmed(nativeAudioSpecs[name], name, raw => prepareNativeAudio(toolContext(), name, raw));
    }
    for (const name of ["create_canvas_template", "create_storyboard_template"] as const) {
      registry.register(createNativeTemplateTool(name, toolContext));
    }
    for (const name of ["set_canvas", "optimize_prompt"] as const) {
      registry.register(createNativeUtilityTool(name, toolContext));
    }
  }
  return registry;
}
