/**
 * 画布从「一根指针」迁到「一组图」的迁移测试。
 *
 * 这个项目**不是 git 仓库**，真实用户的库里躺着真实的会话，所以这段迁移只有一次机会：
 * 跑错了没有 `git checkout` 可以回。因此这里不测「函数对不对」，而是测三件在实际事故里
 * 会致命的事：老指针有没有搬过来、跑第二遍会不会炸、用户清空画布后重启会不会复活。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-migrate-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 打开一个库，并在用例结束时兜底关掉。
 *
 * 用例中间会显式 `close()` 再重开（要的就是"重启一次"），所以兜底那次不能是裸的
 * `db.close()`——重复关同一个句柄会抛 `database is not open`，把成功的用例染红。
 */
function newDb(dir: string) {
  const db = new AppDatabase(dir);
  const realClose = db.close.bind(db);
  let closed = false;
  db.close = () => { if (closed) return; closed = true; realClose(); };
  cleanups.push(() => db.close());
  return db;
}

it("为旧词元流墟视频渠道迁移上传配置且不覆盖用户清空的设置", async () => {
  const dir = await tempDir();
  const db = newDb(dir);
  const channel = db.saveChannel({ name: "wan", baseUrl: "https://api.tiantoken.com", adapterType: "wan-video", authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "", models: ["wan"], allowPrivateNetwork: false, enabled: true });
  db.close();
  const raw = new DatabaseSync(path.join(dir, "app.db"));
  raw.exec("ALTER TABLE channels DROP COLUMN upload_endpoint; ALTER TABLE channels DROP COLUMN upload_headers_json");
  raw.close();
  const migrated = newDb(dir);
  expect(migrated.getChannel(channel.id)).toMatchObject({ uploadEndpoint: "https://imageproxy.zhongzhuan.chat/api/upload", uploadHeaders: { "New-Api-User": "1" } });
  migrated.saveChannel({ ...migrated.getChannel(channel.id)!, uploadEndpoint: "", uploadHeaders: {} }, channel.id);
  migrated.close();
  expect(newDb(dir).getChannel(channel.id)?.uploadEndpoint).toBe("");
});

/**
 * 把库改回「加列之前」的样子：丢掉 `canvas_asset_ids`、给 `current_asset_id` 写上老值。
 *
 * 用 `DROP COLUMN` 而不是自己重写建表语句——手抄一份 schema 会随着源文件漂移，
 * 而漂移之后就再也测不出真实的旧库长什么样了。
 */
function rewindToLegacy(dbPath: string, legacy: Record<string, string | null>) {
  const raw = new DatabaseSync(dbPath);
  raw.exec("ALTER TABLE conversations DROP COLUMN canvas_asset_ids");
  const write = raw.prepare("UPDATE conversations SET current_asset_id = ? WHERE id = ?");
  for (const [id, value] of Object.entries(legacy)) write.run(value, id);
  raw.close();
}

describe("conversations.current_asset_id → canvas_asset_ids 迁移", () => {
  it("把老指针搬成单元素数组，没有指针的会话迁成空数组", async () => {
    const dir = await tempDir();
    const boot = newDb(dir);
    const withCanvas = boot.createConversation({
      title: "有画布", brainChannelId: "ch", brainModel: "m", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const withoutCanvas = boot.createConversation({
      title: "没画布", brainChannelId: "ch", brainModel: "m", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    // 「还没迁移过」在库里就是 NULL，得手写——createConversation 建出来的已经是 '[]' 了
    rewindToLegacy(path.join(dir, "app.db"), {
      [withCanvas.id]: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      [withoutCanvas.id]: null,
    });
    boot.close();

    const migrated = newDb(dir);
    expect(migrated.getConversation(withCanvas.id)!.canvasAssetIds).toEqual(["0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"]);
    expect(migrated.getConversation(withoutCanvas.id)!.canvasAssetIds).toEqual([]);
    // 别的字段一个都不能在搬迁路上丢
    expect(migrated.getConversation(withCanvas.id)!.title).toBe("有画布");
  });

  it("跑第二遍不炸也不丢：迁移是幂等的", async () => {
    const dir = await tempDir();
    const boot = newDb(dir);
    const conversation = boot.createConversation({
      title: "会话", brainChannelId: "ch", brainModel: "m", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    rewindToLegacy(path.join(dir, "app.db"), { [conversation.id]: "11111111-1111-4111-8111-111111111111" });
    boot.close();

    newDb(dir).close();   // 第一遍：加列 + 回填
    const again = newDb(dir); // 第二遍：列已存在，回填查不到 IS NULL 的行
    expect(again.getConversation(conversation.id)!.canvasAssetIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("用户清空画布之后重启，老指针不会把画布复活", async () => {
    // 回填键在 `canvas_asset_ids IS NULL` 上而不是「刚加完列」上，就是为了这一条：
    // 写成 `[]` 之后那次回填再也不会选中它，否则用户每次重启都会看见自己删掉的图回来
    const dir = await tempDir();
    const boot = newDb(dir);
    const conversation = boot.createConversation({
      title: "会话", brainChannelId: "ch", brainModel: "m", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    rewindToLegacy(path.join(dir, "app.db"), { [conversation.id]: "22222222-2222-4222-8222-222222222222" });
    boot.close();

    const migrated = newDb(dir);
    expect(migrated.getConversation(conversation.id)!.canvasAssetIds).toHaveLength(1);
    // 清空画布。注意老列 `current_asset_id` 保留着原值——新代码根本不碰它
    migrated.updateConversation(conversation.id, { canvasAssetIds: [] });
    migrated.close();

    const restarted = newDb(dir);
    expect(restarted.getConversation(conversation.id)!.canvasAssetIds).toEqual([]);
    const raw = new DatabaseSync(path.join(dir, "app.db"), { readOnly: true });
    const legacy = raw.prepare("SELECT current_asset_id FROM conversations WHERE id = ?").get(conversation.id) as { current_asset_id: string };
    // 老列确实还在、还带着值——所以上面那条空数组断言才真的测到了「不回填」
    expect(legacy.current_asset_id).toBe("22222222-2222-4222-8222-222222222222");
    raw.close();
  });

  it("列里存了坏值时退化成空画布，不让一次手改把会话读崩", async () => {
    const dir = await tempDir();
    const boot = newDb(dir);
    const conversation = boot.createConversation({
      title: "会话", brainChannelId: "ch", brainModel: "m", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    boot.close();
    const raw = new DatabaseSync(path.join(dir, "app.db"));
    raw.prepare("UPDATE conversations SET canvas_asset_ids = ? WHERE id = ?").run("这不是 JSON", conversation.id);
    raw.close();

    const db = newDb(dir);
    expect(db.getConversation(conversation.id)!.canvasAssetIds).toEqual([]);
  });
});

describe("db.canvasImages", () => {
  it("按画布顺序返回，并丢掉已删除的产物和非图片", async () => {
    const dir = await tempDir();
    const db = newDb(dir);
    const conversation = db.createConversation({
      title: "会话", brainChannelId: "ch", brainModel: "m", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const insert = (id: string, mimeType: string) => {
      db.createTask({ id: `task-${id}`, channelId: "", model: "", prompt: "p", input: {}, origin: "upload", status: "succeeded" });
      db.insertAsset({
        id, taskId: `task-${id}`, fileName: `${id}.bin`, mimeType, byteSize: 1,
        relativePath: `${id}.bin`, baseDir: db.assetsDir, sha256: id, thumbPath: "",
      });
    };
    insert("img-a", "image/png");
    insert("img-b", "image/jpeg");
    insert("vid", "video/mp4");

    // 顺序是给进来的顺序，不是按时间——`[0]` 是主图，重排就等于换了主图
    db.updateConversation(conversation.id, { canvasAssetIds: ["img-b", "img-a"] });
    const fresh = db.getConversation(conversation.id)!;
    expect(db.canvasImages(fresh).map((asset) => asset.id)).toEqual(["img-b", "img-a"]);

    // 视频混进画布（老库里可能有人手写过）：过滤掉而不是让上层自己判 mime
    db.updateConversation(conversation.id, { canvasAssetIds: ["img-a", "vid"] });
    expect(db.canvasImages(db.getConversation(conversation.id)!).map((asset) => asset.id)).toEqual(["img-a"]);
  });
});
