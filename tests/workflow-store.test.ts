import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect,it } from "vitest";
import request from "supertest";
import { AppDatabase } from "../src/server/db";
import { WorkflowStore } from "../src/server/workflow-store";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/server/app";

it("工作流按版本领取，取消后旧执行器不能写入，重启保留步骤与用量", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-ledger-"));
  let db=new AppDatabase(dir);
  let sql:DatabaseSync|undefined;
  try {
    const c=db.createConversation({ title:"虚构验收",brainChannelId:"mock",brainModel:"mock",videoConfirmPolicy:"auto_only",visionEnabled:false,verbatimPrompt:false });
    const input={ id:"run-a",conversationId:c.id,capability:"example",version:1,inputFingerprint:"source-v1" };
    db.workflows.begin(input);
    db.workflows.checkpoint(c.id,input.id,{ calls:2,tokens:400,usageMissing:false });
    db.workflows.step(c.id,input.id,"page-1","verified-content");
    sql=new DatabaseSync(db.filePath);
    const rival=new WorkflowStore(sql);
    expect(()=>rival.begin(input)).toThrow("另一个执行器");
    expect(()=>db.workflows.begin({ ...input,version:2 })).toThrow("版本");
    expect(db.workflows.get("another-chat",input.id)).toBeNull();
    db.close(); db=new AppDatabase(dir);
    db.workflows.recoverInterrupted();
    expect(db.workflows.get(c.id,input.id)).toMatchObject({ status:"paused",calls:2,tokens:400 });
    expect(db.workflows.steps(c.id,input.id)).toHaveLength(1);
    db.workflows.begin(input);
    expect(db.workflows.cancel(c.id,input.id)).toBe(true);
    expect(db.workflows.cancel(c.id,input.id)).toBe(false);
    expect(()=>db.workflows.checkpoint(c.id,input.id,{ calls:3,tokens:500,usageMissing:false })).toThrow("已停止");
    db.workflows.step(c.id,input.id,"page-2","late-result");
    expect(db.workflows.steps(c.id,input.id)).toHaveLength(1);
    expect(db.workflows.finish(c.id,input.id,"completed")).toBe(false);
    expect(()=>db.workflows.begin(input)).toThrow("已经结束");
  } finally { sql?.close(); db.close(); fs.rmSync(dir,{ recursive:true,force:true }); }
});

it("工作流接口隔离会话，重复取消幂等，已取消任务不能续做", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"workflow-api-"));
  const {app,context}=createApp({ dataDir:dir });
  try {
    const create=()=>context.db.createConversation({ title:"虚构",brainChannelId:"mock",brainModel:"mock",videoConfirmPolicy:"auto_only",visionEnabled:false,verbatimPrompt:false });
    const c=create(), other=create();
    context.db.workflows.begin({ id:"run",conversationId:c.id,capability:"doc_convert",version:1,inputFingerprint:"source" });
    const route=(id:string)=>`/api/conversations/${id}/workflows/run`;
    await request(app).get(route(other.id)).expect(404);
    await request(app).post(route(other.id)).send({ action:"cancel" }).expect(404);
    for (let n=0;n<2;n++) expect((await request(app).post(route(c.id)).send({ action:"cancel" }).expect(200)).body.data.status).toBe("cancelled");
    await request(app).post(route(c.id)).send({ action:"resume" }).expect(409);
  } finally { context.agent.dispose();context.db.close();fs.rmSync(dir,{ recursive:true,force:true }); }
});
