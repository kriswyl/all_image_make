import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { allocateNodeRef, BOARD_LIMITS, directInputLinks, type BoardDoc, type BoardNode, type ConfigBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import { BRAIN_RETRY_MAX_TOKENS, callBrain } from "./brain.js";
import type { KeyStore } from "./key-store.js";
import { boardView, requireBoard } from "./board-core.js";
import { now, placeResultNode, type BoardGenerateResult } from "./board-generation-shared.js";

export async function generateBoardText(input: {
  db: AppDatabase;
  keys: KeyStore;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
}): Promise<BoardGenerateResult> {
  const { db, board, config } = input;
  if (board.doc.nodes.length + 1 > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }
  const links = directInputLinks(board.doc, config.id);
  if (links.some((link) => link.node.type === "image" || link.node.type === "video")) {
    throw new AppError("BOARD_TEXT_IMAGE_UNSUPPORTED", "生文本只使用文本上游；请断开图片 / 视频连线", 400);
  }
  const conversation = db.getConversation(board.threadId);
  if (!conversation) throw new AppError("BOARD_THREAD_MISSING", "无限画布线程不存在", 500);
  const channel = db.getChannel(conversation.brainChannelId);
  if (!channel || !channel.enabled || channel.adapterType !== "openai-chat") {
    throw new AppError("BOARD_NO_BRAIN", "还没有可用的对话模型，先到「模型配置」添加一个", 400);
  }
  const key = input.keys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
  if (!key && channel.authType !== "none") {
    throw new AppError("BOARD_BRAIN_AUTH", "无限画布助手的对话渠道没有可用密钥", 400);
  }

  let content = "";
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是无限画布里的文本生成助手。根据用户给的提示词和上游文本，写出可以直接使用的内容。",
        "只输出正文，不要解释你的思路，不要包 markdown 代码块，也不要提到自己是模型。",
        "如果提示词要求格式（标题 / 列表 / 台词），严格按要求的格式输出。",
      ].join("\n"),
    },
    { role: "user" as const, content: input.prompt },
  ];
  try {
    let result = await callBrain({
      channel,
      key,
      model: conversation.brainModel,
      messages,
      timeoutMs: 240_000,
    });
    // 推理模型可能把 16K 输出额度全用在思考上；正文为空时再给一次更大额度
    if (!result.content.trim()) {
      result = await callBrain({
        channel,
        key,
        model: conversation.brainModel,
        messages,
        maxTokens: BRAIN_RETRY_MAX_TOKENS,
        timeoutMs: 300_000,
      });
    }
    content = result.content.trim();
  } catch (error) {
    const raw = error instanceof Error ? error.message : "未知错误";
    const timeout = /aborted due to timeout|TimeoutError|ETIMEDOUT|timed out/i.test(raw);
    throw new AppError(
      "BOARD_TEXT_FAILED",
      timeout ? "文本生成超时：可以缩短上游文本或换一个非推理模型" : `文本生成失败：${raw}`,
      502,
    );
  }
  if (!content) {
    throw new AppError("BOARD_TEXT_EMPTY", "模型只输出了思考过程，正文被长度上限截断；已自动加长额度重试过一次。可以再试，或换一个非推理模型", 502);
  }
  if (content.length > BOARD_LIMITS.maxTextChars) {
    throw new AppError("BOARD_TEXT_TOO_LONG", `生成结果超过 ${BOARD_LIMITS.maxTextChars} 字，请缩小提示词范围`, 400);
  }

  const at = now();
  const allocated = allocateNodeRef(board.doc);
  const position = placeResultNode(
    board.doc.nodes,
    { width: Math.max(300, config.width), height: 220 },
    config.x + config.width + 120,
    config.y,
  );
  const resultNode: BoardNode = {
    id: `node-${crypto.randomUUID()}`,
    ref: allocated.ref,
    type: "text",
    x: position.x,
    y: position.y,
    width: Math.max(300, config.width),
    height: 220,
    title: "生成文本",
    text: content,
    createdAt: at,
    updatedAt: at,
  };
  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "succeeded" as const,
        model: conversation.brainModel,
        channelId: channel.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : node),
    resultNode,
  ];
  const edges = [
    ...board.doc.edges,
    {
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: resultNode.id,
      kind: "result" as const,
    },
  ];
  const doc: BoardDoc = { ...board.doc, nextRef: allocated.nextRef, nodes, edges };
  db.saveBoardSnapshot({
    boardId: input.boardId,
    previousDoc: board.doc,
    doc,
    version: board.version + 1,
    reason: `generate:${config.ref}`,
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task: null,
    kind: "text",
    resultNodeIds: [resultNode.id],
    configNodeId: config.id,
    prompt: input.prompt,
    referenceCount: 0,
    modelAlias: conversation.brainModel,
  };
}
