import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect,it,vi } from "vitest";
import { AppDatabase } from "../src/server/db";
import { renderContentSlide } from "../src/server/presentation-templates";
import { renderAiPresentation } from "../src/server/mind-document";
import { packPresentationProject,readPresentationProject } from "../src/server/presentation-project";
import { readWorkspaceFile,saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { revisePresentation } from "../src/server/presentation-revision";
import type { TemplateReport } from "../src/shared/presentation-report";
const {render}=vi.hoisted(()=>({render:vi.fn(async()=>[Buffer.from("synthetic-page")])}));
vi.mock("../src/server/wps-auto-render",()=>({renderWithLocalWps:render}));

it("模板截图审校修复另存新版本，复查通过才发布，重复请求复用文件",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"visual-version-")),db=new AppDatabase(dir);
  try {
    const c=db.createConversation({title:"虚构验收",brainChannelId:"mock",brainModel:"mock",videoConfirmPolicy:"auto_only",visionEnabled:true,verbatimPrompt:false});
    const slide=renderContentSlide({page:1,title:"虚构运营",layout:"bullets",bullets:["保留原始事实"]},{},["s1"],"来源原文\n保留原始事实").slide;
    const plan={title:"虚构",theme:"blue" as const,slides:[slide]};
    const bytes=await packPresentationProject(await renderAiPresentation(plan),plan,[]);
    const report:TemplateReport={draft:false,resume:false,fallbackPages:[],pendingPages:[],overflowPages:[],sourceLimitedPages:[],notesLimitedPages:[],unplacedImages:0,planningFallback:false,audit:"complete",issues:[]};
    const original=saveWorkspaceDocument(db,c.id,"虚构","pptx",bytes,"create",report);
    const sha=db.getPresentationVersion(c.id,original.id)!.sha256;
    let calls=0;
    const call=vi.fn(async()=>({content:JSON.stringify(++calls===1 ? {issues:["标题需要微调"],patches:[{op:"move",id:"title",dx:0,dy:0.1}]}:{issues:[]}),truncated:false}));
    const changed=await revisePresentation(db,c.id,original.id,sha,{kind:"review"},call,new AbortController().signal);
    expect(changed?.id).not.toBe(original.id);
    expect(calls).toBe(2);
    const updated=(await readPresentationProject(readWorkspaceFile(db,c.id,changed!.id).bytes))!;
    expect(updated.plan.slides[0]?.elements?.find(item=>item.id==="title")).toMatchObject({y:0.72});
    expect(readWorkspaceFile(db,c.id,original.id).bytes).toEqual(bytes);
    expect(db.getPresentationVersion(c.id,original.id)?.report.visualReview).toMatchObject({status:"complete",revisedFileId:changed?.id});
    expect((await revisePresentation(db,c.id,original.id,sha,{kind:"review"},call,new AbortController().signal))?.id).toBe(changed?.id);
    expect(calls).toBe(2);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it("WPS 不可用时标记未检查，不导出未经复查的补丁版本",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"visual-unavailable-")),db=new AppDatabase(dir);
  render.mockRejectedValueOnce(new Error("加载项未启用"));
  try{
    const c=db.createConversation({title:"虚构",brainChannelId:"mock",brainModel:"mock",videoConfirmPolicy:"auto_only",visionEnabled:true,verbatimPrompt:false});
    const plan={title:"虚构",theme:"blue" as const,slides:[renderContentSlide({page:1,title:"测试",layout:"bullets",bullets:["正文"]},{},[],"").slide]};
    const bytes=await packPresentationProject(await renderAiPresentation(plan),plan,[]);
    const report:TemplateReport={draft:false,resume:false,fallbackPages:[],pendingPages:[],overflowPages:[],sourceLimitedPages:[],notesLimitedPages:[],unplacedImages:0,planningFallback:false,audit:"unavailable",issues:[]};
    const saved=saveWorkspaceDocument(db,c.id,"虚构","pptx",bytes,"create",report),sha=db.getPresentationVersion(c.id,saved.id)!.sha256;
    const call=vi.fn(async()=>({content:'{"issues":[]}',truncated:false}));
    expect(await revisePresentation(db,c.id,saved.id,sha,{kind:"review"},call,new AbortController().signal)).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(db.listWorkspaceDocuments(c.id)).toHaveLength(1);
    expect(db.getPresentationVersion(c.id,saved.id)?.report.visualReview?.status).toBe("unavailable");
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
