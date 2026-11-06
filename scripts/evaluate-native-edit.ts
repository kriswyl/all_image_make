/** One paid native edit of a synthetic geometric fixture, using the real confirmation and task paths. */
import fs from "node:fs/promises";
import path from "node:path";
import { Jimp } from "jimp";
import { createApp } from "../src/server/app.js";
import { KeyStore } from "../src/server/key-store.js";
import { loadEnvFiles } from "../src/server/security.js";
import type { DbChannel } from "../src/server/db.js";
loadEnvFiles();
const bootstrap=await(await fetch("http://127.0.0.1:17892/api/bootstrap")).json();
const brains:DbChannel[]=bootstrap.data.channels;
const brain=brains.find(c=>c.enabled&&c.adapterType==="openai-chat"&&c.models.includes("deepseek-v4.1-flash-1017"));
const image=brains.find(c=>c.enabled&&c.adapterType==="gemini-content"&&c.models.includes("gemini-3.1-flash-image"));
if(!brain||!image)throw new Error("缺少原生改图验收渠道");
const keys=new KeyStore(path.dirname(bootstrap.data.service.dataPath));
const dir=path.resolve("artifacts","native-edit-eval",new Date().toISOString().replace(/[:.]/g,"-"));
await fs.mkdir(dir,{recursive:true});
const{app,context}=createApp({dataDir:path.join(dir,"runtime")});
const configured=[brain,image].map((channel,index)=>{
  const env=`CHATCANVAS_SYNTHETIC_EVAL_KEY_${index}`;
  process.env[env]=keys.get(channel.id)||process.env[channel.secretEnv]||"";
  if(!process.env[env]&&channel.authType!=="none")throw new Error("验收渠道没有可用密钥");
  return context.db.saveChannel({...channel,secretEnv:env,models:index===0?["deepseek-v4.1-flash-1017"]:["gemini-3.1-flash-image"]});
});
const server=app.listen(0,"127.0.0.1");
await new Promise<void>(resolve=>server.once("listening",resolve));
const address=server.address();if(!address||typeof address==="string")throw new Error("验收服务失败");
const api=`http://127.0.0.1:${address.port}`;
const c=context.db.createConversation({title:"虚构几何图改图验收",brainChannelId:configured[0]!.id,brainModel:"deepseek-v4.1-flash-1017",videoConfirmPolicy:"auto_only",visionEnabled:false,verbatimPrompt:false});
context.db.updateConversation(c.id,{chatMode:"chat",toolScope:"all",chatModelCallLimit:8,chatTokenLimit:24000});
const post=async(route:string,body:unknown)=>{
  const r=await fetch(`${api}${route}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const json=await r.json();if(!r.ok)throw new Error(json.error?.message??`HTTP ${r.status}`);return json.data;
};
const wait=async(test:()=>boolean)=>{
  const until=Date.now()+240000;
  while(!test()){if(Date.now()>until)throw new Error("原生改图验收超时");await new Promise(resolve=>setTimeout(resolve,400));}
};
try{
  const fixture=new Jimp({width:256,height:256,color:0xf0f0f0ff});
  for(let x=80;x<176;x++)for(let y=80;y<176;y++)fixture.setPixelColor(0xe02020ff,x,y);
  const bytes=await fixture.getBuffer("image/png");
  await fs.writeFile(path.join(dir,"fixture.png"),bytes);
  const form=new FormData();form.append("images",new Blob([new Uint8Array(bytes)],{type:"image/png"}),"synthetic-red-square.png");
  const uploaded=await(await fetch(`${api}/api/conversations/${c.id}/uploads`,{method:"POST",body:form})).json();
  if(!uploaded.ok)throw new Error("上传虚构底图失败");
  const assetId=uploaded.data.sessionImages[0].asset.id;
  await post(`/api/conversations/${c.id}/messages`,{text:"请修改我上传的这张几何图，将浅灰背景改为浅蓝色，保持中央红色方块的位置、形状和颜色不变。只生成一张修改图，不需要另外生图或看图，使用改图工具。",assetRefs:[assetId]});
  await wait(()=>["awaiting_confirmation","idle"].includes(context.db.getConversation(c.id)!.status));
  const card=context.db.listPendingMessages(c.id).find(m=>m.confirm);
  if(!card||card.toolName!=="edit_image")throw new Error("模型没有选择原生改图确认工具");
  if(context.db.listTaskViews(10).some(task=>task.origin==="generate"))throw new Error("确认之前提交了付费任务");
  await post(`/api/conversations/${c.id}/confirm`,{messageId:card.id,decision:"approve"});
  const repeated=await fetch(`${api}/api/conversations/${c.id}/confirm`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messageId:card.id,decision:"approve"})});
  if(repeated.status!==409)throw new Error("重复确认未被阻止");
  await wait(()=>context.db.getConversation(c.id)!.status==="idle");
  const tasks=context.db.listTaskViews(10).filter(task=>task.origin==="generate");
  if(tasks.length!==1||tasks[0]?.status!=="succeeded"||!tasks[0].assets.length)throw new Error("未得到唯一成功的改图任务");
  const result=tasks[0].assets[0]!,stored=context.db.getAsset(result.id)!;
  const edited=await fs.readFile(path.join(stored.baseDir,stored.relativePath));
  if(edited.equals(bytes))throw new Error("改图接口返回了未修改的原始文件");
  await fs.writeFile(path.join(dir,"result.png"),edited);
  const history=await(await fetch(`${api}/api/library?limit=20&includeChatImages=1`)).json();
  if(!JSON.stringify(history.data).includes(result.id))throw new Error("聊天改图未进入生成历史");
  const report={passed:true,source:"synthetic-only",tasks:tasks.length,repeatedConfirmationStatus:repeated.status,historyVisible:true,executions:context.db.executions.list(c.id),output:dir};
  await fs.writeFile(path.join(dir,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({passed:false,error:error instanceof Error?error.message:"验收失败",output:dir}));process.exitCode=1;}
finally{
  context.agent.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));context.db.close();
  for(let index=0;index<2;index++)delete process.env[`CHATCANVAS_SYNTHETIC_EVAL_KEY_${index}`];
}
