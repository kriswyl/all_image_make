import { expect,it } from "vitest";
import { probeToolProtocol, protocolErrorFeature, readToolProtocol, recordToolProtocol, projectToolSpecs } from "../src/server/tool-protocol";
import { RemoteApiError } from "../src/server/adapters";
import type { DbChannel } from "../src/server/db";
import type { BrainResult } from "../src/server/brain";

const result=(calls:BrainResult["toolCalls"]):BrainResult=>({ content:"",reasoning:"",finishReason:"tool_calls",toolCalls:calls,durationMs:10,truncated:false,usedFallback:false,usage:{ promptTokens:10,completionTokens:10,reasoningTokens:0,complete:true } });
it("合成探测只校验三次返回，重复 ID 和无调用均不能认证能力", async () => {
  let calls=0;
  const report=await probeToolProtocol(async options=>{
    calls++;
    expect(JSON.stringify(options)).not.toContain("用户文档");
    return result(calls===1 ? [{ id:"a",name:"protocol_echo",arguments:'{"value":"synthetic-a"}' }]
      : calls===2 ? [{ id:"a",name:"protocol_echo",arguments:'{"value":"synthetic-a"}' },{ id:"a",name:"protocol_echo",arguments:'{"value":"synthetic-b"}' }]:[]);
  });
  expect(calls).toBe(3);
  expect(report.features).toEqual({ tools:true,streaming:true });
  expect(report.results.map(row=>row.status)).toEqual(["passed","unverified","unverified"]);
});
it("协议拒绝按特性记录，配置更新或换模型不继承旧限制", () => {
  expect(protocolErrorFeature(new RemoteApiError(400,{},"tool_choice is not supported"))).toBe("toolChoice");
  expect(protocolErrorFeature(new RemoteApiError(500,{},"tools not supported"))).toBeUndefined();
  expect(protocolErrorFeature(new RemoteApiError(400,{},"invalid schema: required value missing"))).toBeUndefined();
  const map=new Map<string,string>(),settings={ getSetting:(key:string)=>map.get(key)??null,setSetting:(key:string,value:string)=>{map.set(key,value);} };
  const channel={id:"c",updatedAt:"v1"} as DbChannel;
  recordToolProtocol(settings,channel,"model-a",{ toolChoice:false });
  expect(readToolProtocol(settings,channel,"model-a").toolChoice?.supported).toBe(false);
  expect(readToolProtocol(settings,{...channel,updatedAt:"v2"},"model-a")).toEqual({});
  expect(readToolProtocol(settings,channel,"model-b")).toEqual({});
  const projected=projectToolSpecs([{ type:"function",function:{ name:"test",description:"",parameters:{ $schema:"x",type:"object",properties:{ value:{type:"integer",default:1,minimum:0} },required:["value"] } } }]);
  expect(projected[0]?.function.parameters).toEqual({type:"object",properties:{value:{type:"integer",minimum:0}},required:["value"]});
});
