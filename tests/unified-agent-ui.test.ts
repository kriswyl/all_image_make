// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {api} from "../src/client/api";
import {WorkflowProgress} from "../src/client/chat/WorkflowProgress";
import {ToolProtocolPanel} from "../src/client/channels/ToolProtocolPanel";
import type {WorkflowRun} from "../src/shared/workflow";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("工作流续做使用原运行ID，工具关闭时禁止续做",async()=>{
  const run:WorkflowRun={id:"original-run",conversationId:"c",capability:"doc_convert",version:1,inputFingerprint:"source",status:"paused",reason:"预算耗尽",calls:8,tokens:30000,usageMissing:false,artifactId:null,createdAt:"",updatedAt:""};
  const read=vi.spyOn(api,"workflow").mockResolvedValue({...run,steps:[]});
  const action=vi.spyOn(api,"workflowAction").mockResolvedValue({...run,status:"running"});
  const host=document.createElement("div"),root=createRoot(host);
  try{
    await act(async()=>root.render(React.createElement(WorkflowProgress,{conversationId:"c",runId:run.id,enabled:false})));
    const resume=()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="继续原任务")!;
    expect(resume().disabled).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await act(async()=>root.render(React.createElement(WorkflowProgress,{conversationId:"c",runId:run.id,enabled:true})));
    await act(async()=>resume().click());
    expect(action).toHaveBeenCalledWith("c","original-run","resume");
  }finally{act(()=>root.unmount());read.mockRestore();action.mockRestore();}
});

it("展开渠道只读能力记录，用户点击后才发送付费探测",async()=>{
  const read=vi.spyOn(api,"toolProtocol").mockResolvedValue({});
  const probe=vi.spyOn(api,"probeToolProtocol").mockResolvedValue({protocol:{tools:{supported:true,source:"probe",at:"now"}},results:[{scenario:"single",status:"passed",tokens:100,durationMs:10}]});
  const host=document.createElement("div"),root=createRoot(host);
  try{
    await act(async()=>root.render(React.createElement(ToolProtocolPanel,{channelId:"channel",model:"model"})));
    expect(probe).not.toHaveBeenCalled();
    expect(host.textContent).toContain("最多 3 次模型请求");
    await act(async()=>host.querySelector("button")!.click());
    expect(probe).toHaveBeenCalledWith("channel","model");
    expect(host.textContent).toContain("原生工具 · 已验证");
  }finally{act(()=>root.unmount());read.mockRestore();probe.mockRestore();}
});
