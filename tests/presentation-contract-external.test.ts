import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import JSZip from "jszip";
import { AppDatabase } from "../src/server/db";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { packPresentationProject, readPresentationProject } from "../src/server/presentation-project";
import { checkPresentationContract } from "../src/server/presentation-contract-check";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import type { PresentationSpec } from "../src/shared/presentation-spec";
import { FIXTURE_ASSET_ID, FIXTURE_IMAGE } from "./fixtures/presentation-contract/sources";

const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-external-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  return db;
}
afterEach(() => {
  while (databases.length) {
    const db = databases.pop()!;
    try { db.close(); } catch { /* 已关闭 */ }
  }
});

function deckWithImage(withImage: boolean): AiPresentation {
  const elements: NonNullable<AiPresentation["slides"][number]["elements"]> = [
    { id: "title", type: "text", x: 0.7, y: 0.5, w: 12, h: 0.8, text: "页面主张", style: { fontSize: 28, bold: true } },
  ];
  if (withImage) elements.push({ id: "picture", type: "image", x: 7, y: 1.6, w: 5, h: 3, imageIndex: 0 });
  return {
    title: "虚构验收", theme: "blue",
    slides: [{ layout: "content", title: "页面主张", subtitle: "", lines: [], notes: "来源原文：事实", sourceIds: ["s1"], elements }],
  };
}

function simplePlan(pages: number): AiPresentation {
  return {
    title: "虚构验收", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "", lines: ["示例事实"], notes: "",
    })),
  };
}

function makeConversation(db: AppDatabase): string {
  return db.createConversation({
    title: "外部改动验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}

async function makeSpec(db: AppDatabase, conversationId: string, requiredAssets: boolean): Promise<PresentationSpec> {
  let spec = db.specs.create({ conversationId });
  spec = db.specs.update(spec.specId, {
    ...(requiredAssets ? { requiredAssets: [{
      assetId: FIXTURE_ASSET_ID, sha256: "fixture-image-hash",
      evidence: { sourceMessageId: "m1", text: "必须使用原图" },
    }] } : {}),
  }, "指定素材", "m1");
  return spec;
}

it("A09：外部软件改动 ppt 部件后，源方案读取被拒绝，旧契约补丁也不能继续发布", async () => {
  const db = await makeDb();
  const deck = deckWithImage(true);
  const bytes = await renderAiPresentation(deck, [FIXTURE_IMAGE]);
  const packed = await packPresentationProject(bytes, deck, [FIXTURE_IMAGE]);
  expect(await readPresentationProject(packed)).not.toBeNull();

  const zip = await JSZip.loadAsync(packed);
  zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">外部软件改动</p:sld>");
  const modified = await zip.generateAsync({ type: "nodebuffer" });
  await expect(readPresentationProject(modified)).rejects.toThrow(/已在外部修改/);

  const spec = await makeSpec(db, "c1", true);
  const stale = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deck, bytes: modified,
    expectedSpecId: spec.specId, expectedSpecRevision: spec.revision - 1,
  });
  expect(stale.blocking.some(item => item.code === "SPEC_REVISION")).toBe(true);
});

it("A09：并发的不同操作不串写版本；归属不符的契约补丁被阻断", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const spec = await makeSpec(db, conversationId, false);
  db.specs.setLifecycle(spec.specId, "active");

  const first = saveWorkspaceDocument(db, conversationId, "甲", "pptx", Buffer.from("a"), "op-a", undefined, undefined, { plan: simplePlan(10) });
  const second = saveWorkspaceDocument(db, conversationId, "乙", "pptx", Buffer.from("b"), "op-b", undefined, undefined, { plan: simplePlan(10) });
  expect(first.id).not.toBe(second.id);
  expect(db.listWorkspaceDocuments(conversationId)).toHaveLength(2);

  const wrongOwner = checkPresentationContract(db.specs, {
    conversationId, spec, plan: simplePlan(10), bytes: Buffer.from("c"), expectedSpecId: "another-spec",
  });
  expect(wrongOwner.blocking.some(item => item.code === "SPEC_OWNERSHIP")).toBe(true);
});

it("指定图片必须按素材身份真正落位，图片数量不能冒充", async () => {
  const db = await makeDb();
  const spec = await makeSpec(db, "c1", true);
  const assetId = spec.requiredAssets[0]!.assetId;
  const bindings = [{ assetId, imageIndex: 0, sha256: "fixture-image-hash" }];

  const placed = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deckWithImage(true), bytes: Buffer.from("placed"), assetBindings: bindings,
  });
  expect(placed.validation?.ok).toBe(true);
  expect(placed.validation?.visibleCoverage.satisfied).toBe(1);

  const missing = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deckWithImage(false), bytes: Buffer.from("missing"), assetBindings: bindings,
  });
  expect(missing.validation?.ok).toBe(false);
  expect(missing.validation?.failures.some(item => item.code === "REQUIRED_ASSET")).toBe(true);

  // 页面上有图，但那不是用户指定的那张：不能算满足。
  const wrongAsset = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deckWithImage(true), bytes: Buffer.from("wrong-asset"),
    assetBindings: [{ assetId: "asset-other", imageIndex: 0, sha256: "fixture-image-hash" }],
  });
  expect(wrongAsset.validation?.ok).toBe(false);
  expect(wrongAsset.validation?.failures.some(item => item.code.startsWith("REQUIRED_ASSET"))).toBe(true);

  // 素材 ID 对上了但图片内容哈希不同，也不能冒充原图。
  const wrongHash = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deckWithImage(true), bytes: Buffer.from("wrong-hash"),
    assetBindings: [{ assetId, imageIndex: 0, sha256: "another-image" }],
  });
  expect(wrongHash.validation?.failures.some(item => item.code === "REQUIRED_ASSET_IDENTITY")).toBe(true);

  // 完全没有绑定记录时不猜，也不放行。
  const unbound = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deckWithImage(true), bytes: Buffer.from("unbound"),
  });
  expect(unbound.validation?.ok).toBe(false);
  expect(unbound.validation?.failures.some(item => item.code === "REQUIRED_ASSET_UNVERIFIED")).toBe(true);

  const unplaced = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: deckWithImage(true), bytes: Buffer.from("unplaced"), assetBindings: bindings,
    report: {
      draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
      sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 1,
      planningFallback: false, audit: "unavailable", issues: [],
    },
  });
  expect(unplaced.validation?.failures.some(item => item.code === "UNPLACED_IMAGES")).toBe(true);
});
