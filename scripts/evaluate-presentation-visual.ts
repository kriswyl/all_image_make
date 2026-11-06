/** Real multimodal smoke test on generated synthetic fixtures, bounded to three pages and 12 calls. */
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { getWpsPreviewJobs } from "../src/server/wps-preview.js";
import { renderWithLocalWps } from "../src/server/wps-auto-render.js";
import { readPresentationProject,packPresentationProject } from "../src/server/presentation-project.js";
import { reviewRenderedPresentation } from "../src/server/presentation-visual-review.js";
import { renderAiPresentation } from "../src/server/mind-document.js";
import { callBrain } from "../src/server/brain.js";
import { KeyStore } from "../src/server/key-store.js";
import { loadEnvFiles } from "../src/server/security.js";
import { PresentationPaused } from "../src/server/presentation-execution.js";
import type { DbChannel } from "../src/server/db.js";
loadEnvFiles();
const args=process.argv.slice(2),flag=args.indexOf("--file"),file=path.resolve(args[flag+1]??"");
const fixtureRoot=path.resolve("artifacts","presentation-eval")+path.sep;
if(flag<0||!file.toLowerCase().startsWith(fixtureRoot.toLowerCase()))throw new Error("仅接受固定评测脚本生成的虚构资料文件");
const modelFlag=args.indexOf("--model"),model=modelFlag>=0?args[modelFlag+1]!:"gpt-6.1-sol";
const bootstrap=await(await fetch("http://127.0.0.1:17892/api/bootstrap")).json();
const channel:DbChannel=bootstrap.data.channels.find((c:DbChannel)=>c.enabled&&c.adapterType==="openai-chat"&&c.models.includes(model));
if(!channel)throw new Error("没有可用的视觉验收渠道");
const key=new KeyStore(path.dirname(bootstrap.data.service.dataPath)).get(channel.id)||process.env[channel.secretEnv]||"";
if(!key&&channel.authType!=="none")throw new Error("未配置渠道密钥");
const dir=path.resolve("artifacts","visual-evaluation",new Date().toISOString().replace(/[:.]/g,"-"));
await fs.mkdir(dir,{recursive:true});
const{app,context}=createApp({dataDir:path.join(dir,"runtime")});
const server=app.listen(0,"127.0.0.1");
await new Promise<void>(resolve=>server.once("listening",resolve));
const address=server.address();if(!address||typeof address==="string")throw new Error("本地服务失败");
getWpsPreviewJobs(context.db).setOrigin(`http://127.0.0.1:${address.port}`);
let calls=0,tokens=0;
const controller=new AbortController();
try{
  const source=await fs.readFile(file),project=await readPresentationProject(source);
  if(!project)throw new Error("缺少本应用可编辑来源");
  const subset={...project.plan,slides:project.plan.slides.slice(0,3)};
  const reviewed=await reviewRenderedPresentation(subset,project.images,async bytes=>{
    const pages=await renderWithLocalWps(context.db,bytes,AbortSignal.timeout(100000));
    for(const[index,page]of pages.entries())await fs.writeFile(path.join(dir,`page-${index+1}.png`),page);
    return pages;
  },async messages=>{
    if(calls>=12||tokens>=40000)throw new PresentationPaused("视觉验收预算已达上限");
    calls++;
    const result=await callBrain({channel,key,model,messages,maxTokens:8192,timeoutMs:180000,signal:controller.signal});
    if(!result.usage?.complete)throw new PresentationPaused("渠道未提供完整用量");
    tokens+=result.usage.promptTokens+result.usage.completionTokens;
    return result;
  },text=>console.log(text));
  const plan={...project.plan,slides:[...reviewed.plan.slides,...project.plan.slides.slice(3)]};
  if(reviewed.complete)await fs.writeFile(path.join(dir,"reviewed.pptx"),await packPresentationProject(await renderAiPresentation(plan,project.images),plan,project.images));
  if(!(await fs.readFile(file)).equals(source))throw new Error("验收不能覆盖原件");
  const report={complete:reviewed.complete,summary:reviewed.summary,issues:reviewed.issues,calls,tokens,model,source:"synthetic-only",checkedPages:subset.slides.length,output:dir};
  await fs.writeFile(path.join(dir,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  if(!reviewed.complete||reviewed.issues.length)process.exitCode=1;
}catch(error){console.log(JSON.stringify({error:error instanceof Error?error.message:"视觉验收失败",calls,tokens,output:dir}));process.exitCode=1;}
finally{context.agent.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));context.db.close();}
