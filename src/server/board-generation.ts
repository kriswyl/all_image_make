/** 画布生成入口与任务控制。 */
import type { AppDatabase } from "./db.js";
import { BOARD_LIMITS, composeConfigPrompt, type AudioBoardNode, type ConfigBoardNode, type ImageBoardNode, type VideoBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { TaskRunner } from "./tasks.js";
import type { Task } from "../shared/types.js";
import type { KeyStore } from "./key-store.js";
import { requireBoard } from "./board-core.js";
import type { BoardGenerateOverrides, BoardGenerateResult } from "./board-generation-shared.js";
import { generateBoardImage } from "./board-generation-image.js";
import { generateBoardVideo } from "./board-generation-video.js";
import { generateBoardAudio } from "./board-generation-audio.js";
import { generateBoardText } from "./board-generation-text.js";
import { generateBoardMediaNode } from "./board-generation-media-node.js";

/** 确认任务确实是这块板发起的；不允许凭 taskId 操作别的板的任务 */
function requireBoardTask(db: AppDatabase, boardId: string, taskId: string) {
  const rows = db.listBoardTasksByTask(taskId).filter((row) => row.boardId === boardId);
  if (!rows.length) throw new AppError("BOARD_TASK_NOT_FOUND", "这个任务不属于当前无限画布", 404);
  return rows;
}

export function cancelBoardTask(db: AppDatabase, runner: TaskRunner, boardId: string, taskId: string): Task {
  requireBoardTask(db, boardId, taskId);
  return runner.cancel(taskId);
}

export async function retryBoardTask(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  taskId: string;
}): Promise<{ task: Task; resultNodeIds: string[]; configNodeId: string }> {
  const rows = requireBoardTask(input.db, input.boardId, input.taskId);
  const resultNodeIds = rows.map((row) => row.resultNodeId);
  const task = await input.runner.retry(input.taskId);
  if (task.id !== input.taskId) {
    input.db.addBoardTaskRows({
      taskId: task.id,
      boardId: input.boardId,
      configNodeId: rows[0]!.configNodeId,
      resultNodeIds,
      kind: rows[0]!.kind,
    });
  }
  return { task, resultNodeIds, configNodeId: rows[0]!.configNodeId };
}

export async function generateBoardConfig(input: {
  db: AppDatabase;
  runner: TaskRunner;
  keys: KeyStore;
  boardId: string;
  nodeId: string;
  overrides?: BoardGenerateOverrides;
}): Promise<BoardGenerateResult> {
  const { db, runner } = input;
  const board = requireBoard(db, input.boardId);
  const media = board.doc.nodes.find(
    (node): node is ImageBoardNode | VideoBoardNode | AudioBoardNode =>
      node.id === input.nodeId && (node.type === "image" || node.type === "video" || node.type === "audio"),
  );
  if (media) {
    return generateBoardMediaNode({
      db,
      runner,
      keys: input.keys,
      boardId: input.boardId,
      board,
      node: media,
      ...(input.overrides ? { overrides: input.overrides } : {}),
    });
  }
  const config = board.doc.nodes.find(
    (node): node is ConfigBoardNode => node.id === input.nodeId && node.type === "config",
  );
  if (!config) throw new AppError("BOARD_CONFIG_NOT_FOUND", "配置节点不存在", 404);

  const prompt = composeConfigPrompt(board.doc, {
    id: config.id,
    prompt: input.overrides?.prompt ?? config.prompt,
    useUpstreamText: config.useUpstreamText,
  }).trim();
  if (!prompt) {
    throw new AppError("BOARD_PROMPT_EMPTY", "提示词是空的：在配置节点里写一句，或把文本节点连到左边", 400);
  }
  if (prompt.length > BOARD_LIMITS.maxTextChars) {
    throw new AppError("BOARD_PROMPT_TOO_LONG", `提示词超过 ${BOARD_LIMITS.maxTextChars} 字，请删减后再试`, 400);
  }

  if (config.mode === "video") {
    return generateBoardVideo({
      db, runner,
      boardId: input.boardId,
      board,
      config,
      prompt,
      ...(input.overrides ? {
        overrides: {
          ...(input.overrides.model ? { model: input.overrides.model } : {}),
          ...(input.overrides.videoMode ? { videoMode: input.overrides.videoMode } : {}),
          ...(input.overrides.durationSeconds ? { durationSeconds: input.overrides.durationSeconds } : {}),
          ...(input.overrides.resolution ? { resolution: input.overrides.resolution } : {}),
          ...(input.overrides.audio === undefined ? {} : { audio: input.overrides.audio }),
          ...(input.overrides.seed === undefined ? {} : { seed: input.overrides.seed }),
          ...(input.overrides.aspectRatio ? { aspectRatio: input.overrides.aspectRatio } : {}),
          ...(input.overrides.promptExtend === undefined ? {} : { promptExtend: input.overrides.promptExtend }),
          ...(input.overrides.watermark === undefined ? {} : { watermark: input.overrides.watermark }),
        },
      } : {}),
    });
  }

  if (config.mode === "text") {
    return generateBoardText({
      db,
      keys: input.keys,
      boardId: input.boardId,
      board,
      config,
      prompt,
    });
  }

  if (config.mode === "audio") {
    return generateBoardAudio({
      db,
      runner,
      boardId: input.boardId,
      board,
      config,
      prompt,
      ...(input.overrides ? {
        overrides: {
          ...(input.overrides.model ? { model: input.overrides.model } : {}),
          ...(input.overrides.audioKind ? { audioKind: input.overrides.audioKind } : {}),
          ...(input.overrides.voice ? { voice: input.overrides.voice } : {}),
          ...(input.overrides.ttsStyle ? { ttsStyle: input.overrides.ttsStyle } : {}),
          ...(input.overrides.instrumental === undefined ? {} : { instrumental: input.overrides.instrumental }),
          ...(input.overrides.musicTitle ? { musicTitle: input.overrides.musicTitle } : {}),
          ...(input.overrides.musicTags ? { musicTags: input.overrides.musicTags } : {}),
          ...(input.overrides.musicNegativeTags ? { musicNegativeTags: input.overrides.musicNegativeTags } : {}),
        },
      } : {}),
    });
  }

  return generateBoardImage({ db, runner, boardId: input.boardId, board, config, prompt, overrides: input.overrides });
}
