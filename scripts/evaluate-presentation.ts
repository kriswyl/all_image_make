/** Reproducible synthetic-only evaluation. --real opts into configured provider billing.
 * --chapters N 控制资料规模；--pages P（默认 N+1）单独指定目标页数。
 * P < N+1 时验收「多章压缩到少页」：不再要求每章独立成页或标题逐一出现，
 * 改为逐条核对每章关键事实编号与示例数值是否在页面正文可见，备注不计入。 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { callBrain, type BrainMessage } from "../src/server/brain.js";
import type { DbChannel } from "../src/server/db.js";
import { KeyStore } from "../src/server/key-store.js";
import { loadEnvFiles } from "../src/server/security.js";
import { markdownToMind } from "../src/server/chat-tools/markdown.js";
import { runTemplatePresentation } from "../src/server/presentation-workflow.js";
import { planPresentationWithAi } from "../src/server/ai-presentation.js";
import { PresentationPaused, readPresentationSubmission } from "../src/server/presentation-execution.js";
import { checkPresentation, paginatePresentation } from "../src/server/presentation-check.js";
import { renderAiPresentation } from "../src/server/mind-document.js";
import { packPresentationProject } from "../src/server/presentation-project.js";
import { elementTexts, layoutIssues } from "../src/server/presentation-elements.js";
import { protocolErrorFeature } from "../src/server/tool-protocol.js";
import type { StructuredWorkflowCall } from "../src/server/structured-workflow.js";

loadEnvFiles();
const args=process.argv.slice(2),real=args.includes("--real");
const option=(name:string,fallback:string)=>args.includes(name)?args[args.indexOf(name)+1]??fallback:fallback;
const engine=option("--engine","template"),api=option("--api","http://127.0.0.1:17892");
if (!["template","legacy","both"].includes(engine)) throw new Error("engine 必须是 template/legacy/both");
const maxCalls=Number(option("--max-calls","20")),maxTokens=Number(option("--max-tokens","80000"));
const repeats=Number(option("--repeat","1")),chapters=Number(option("--chapters","10"));
// 目标页数与资料章节数解耦：默认仍是「一章一页 + 封面」的历史基线，
// 显式 --pages N（N < chapters+1）用于验收「多章压缩到少页」这一真实场景。
const expectedPages=Number(option("--pages",String(chapters+1)));
if (![maxCalls,maxTokens,repeats,chapters,expectedPages].every(n=>Number.isSafeInteger(n)&&n>0) || repeats>3 || chapters>18 || expectedPages>chapters+1 || expectedPages<2 || maxCalls>80 || maxTokens>200000) throw new Error("验收预算、资料规模或目标页数超出上限（2 <= pages <= chapters+1）");
const compressed=expectedPages<chapters+1;
const output=path.resolve("artifacts","presentation-eval",new Date().toISOString().replace(/[:.]/g,"-"));
await fs.mkdir(output,{recursive:true});
const fixtures=Array.from({length:chapters},(_,i)=>({
  title:`模块${i+1}：虚构运营环节`,
  text:`培训样例指标 F${String(i+1).padStart(2,"0")}：示例订单量为 ${100+i*13}，仅为虚构演示数据。该模块由岗位 ${i+1} 负责，先核对输入完整性，再执行并记录结果。异常时保留原始记录，不能把建议描述为已经完成的事实。复盘周期为 ${i%3+1} 周，应结合退货率及履约成本综合判断。`,
}));
const markdown=["# 虚构运营培训资料","全部数值与岗位均为虚构验收资料，不代表真实经营数据。",...fixtures.flatMap(x=>[`## ${x.title}`,x.text])].join("\n");
const mind=markdownToMind(markdown,"虚构运营培训");
const request=compressed
  ? `把这份 ${chapters} 章虚构资料压缩整理为严格 ${expectedPages} 页培训 PPT，封面计入总页数。合并相关模块，不得按章节数逐章拆页；每个模块的关键数值（示例订单量）与限定条件必须保留在页面正文，不能只写进备注。`
  : `把这份虚构资料整理为 ${expectedPages} 页培训 PPT，封面计入总页数。每个模块独立一页，保留示例数值及限定条件，正文要能直接讲解。`;
let channel:DbChannel|undefined,key="",model=option("--model","deepseek-v4.1-flash-1017");
if (real) {
  const response=await fetch(`${api}/api/bootstrap`),bootstrap=await response.json();
  if (!bootstrap.ok) throw new Error("无法读取本机渠道配置");
  channel=bootstrap.data.channels.find((c:DbChannel)=>c.enabled&&c.adapterType==="openai-chat"&&c.models.includes(model));
  if (!channel) throw new Error("找不到指定模型的已启用渠道");
  key=new KeyStore(path.dirname(bootstrap.data.service.dataPath)).get(channel!.id) || process.env[channel!.secretEnv] || "";
  if (!key&&channel.authType!=="none") throw new Error("验收渠道未配置可用密钥");
} else if (engine!=="template") throw new Error("离线固定评测只支持 template，真实 A/B 请使用 --real --engine both");

const summaries:Array<Record<string,unknown>>=[];
for (const selected of engine==="both"?["legacy","template"]:[engine]) for(let repeat=0;repeat<repeats;repeat++) {
  let calls=0,tokens=0,missing=false,textFallback=false;
  const started=Date.now(),cache=new Map<string,string>(),trace:Array<Record<string,unknown>>=[];
  const structured:StructuredWorkflowCall=async(messages,schema,options)=>{
    if(calls>=maxCalls||tokens>=maxTokens||missing&&real) throw new PresentationPaused("验收预算已达上限或渠道缺少用量");
    calls++;
    if(!real) {
      const instruction=String(messages[0]?.content),input=JSON.parse(String(messages[1]?.content));
      let value:unknown;
      if(instruction.includes("总策划")) {
        const catalog=input.catalog as Array<{id:number}>;
        // 压缩场景下规划单元数少于章节数：离线固定返回也必须把多个章节并入同一单元，
        // 否则 validOutline 判无效并触发 planningFallback，测不到页数约束本身。
        const units=Math.min(catalog.length,Math.max(1,Number(input.planningUnits)||catalog.length));
        value={title:"虚构运营培训",audience:"培训学员",objective:"了解各模块的操作、指标和限制",
          pages:Array.from({length:units},(_,unit)=>{
            const ids=catalog.map(row=>row.id).slice(Math.floor(unit*catalog.length/units),Math.floor((unit+1)*catalog.length/units));
            return {title:fixtures[ids[0]!-1]?.title??`主题${unit+1}`,goal:"核验本组模块数据与限制",batchIds:ids};
          })};
      }
      else if(instruction.includes("审校员")) value={issues:[]};
      else value={pages:input.pages.map((row:{page:number;title:string;source:Array<{text:string}>})=>({page:row.page,title:row.title,layout:"bullets",bullets:row.source.map(x=>x.text.slice(0,155)).filter(x=>x!==row.title).slice(0,4)}))};
      return {content:JSON.stringify(value),truncated:false};
    }
    const cap=Math.min(options?.maxTokens??(selected==="legacy"?32000:16384),Math.max(1024,maxTokens-tokens));
    const result=await callBrain({channel:channel!,key,model,messages,maxTokens:cap,timeoutMs:180000,
      ...(!textFallback&&schema?{tools:[{type:"function",function:{name:"submit_presentation_result",description:"提交当前阶段结构化结果",parameters:schema}}],toolChoice:{type:"function",function:{name:"submit_presentation_result"}} as const}:{})
    }).catch(error=>{
      if(protocolErrorFeature(error)){textFallback=true;return null;}
      throw error;
    });
    if(!result) return {content:"",truncated:false};
    if(result.usage?.complete) tokens+=result.usage.promptTokens+result.usage.completionTokens;else missing=true;
    trace.push({call:calls,inputHash:createHash("sha256").update(JSON.stringify(messages)).digest("hex"),input:messages,response:readPresentationSubmission(result.toolCalls)??result.content,toolNames:result.toolCalls.map(c=>c.name),tokens:result.usage,ms:result.durationMs,truncated:result.truncated});
    return {...result,content:readPresentationSubmission(result.toolCalls)??result.content};
  };
  let report:Record<string,unknown>={mode:real?"real":"offline",engine:selected,model:real?model:"fixture",repeat:repeat+1,source:"synthetic-only"};
  try {
    const cacheOptions={scope:"synthetic-eval-v1",get:(key:string)=>cache.get(key)??null,set:(key:string,value:string)=>{cache.set(key,value);}};
    const outputPlan=selected==="template"?await runTemplatePresentation(mind,structured,{request,currentRequest:request,images:[],hasCover:false,...cacheOptions}):null;
    const plan=outputPlan?.plan??(selected==="legacy"?paginatePresentation(await planPresentationWithAi(mind,request,structured,undefined,cacheOptions,structured,{pagewise:true,globalPlan:true,deepRead:true,images:[]})):null);
    if(!plan) throw new Error("没有可交付页面");
    const bytes=await renderAiPresentation(plan);
    await checkPresentation(bytes,plan);
    const name=`${selected}-${repeat+1}.pptx`;
    await fs.writeFile(path.join(output,name),await packPresentationProject(bytes,plan,[]));
    const visible=plan.slides.map(slide=>elementTexts(slide.elements??[]).join("\n")+slide.title+slide.lines.join("\n"));
    const notes=plan.slides.map(slide=>slide.notes).join("\n");
    // A：备注只算来源留存，不能冒充正文可见覆盖；两者分别记录。
    const covered=fixtures.filter(f=>visible.some(v=>v.includes(f.title))).length;
    const notesCovered=fixtures.filter(f=>notes.includes(f.title)).length;
    const missingFacts=fixtures.map((_,i)=>i+1).filter(n=>!visible.some(v=>v.includes(`F${String(n).padStart(2,"0")}`)));
    const visibleFacts=chapters-missingFacts.length;
    // 逐条核对必需数值：章节标题可因合并而不再逐一出现，但每章的关键数字必须在正文可见。
    const missingNumbers=fixtures.map((_,i)=>i+1).filter(n=>!visible.some(v=>v.includes(`示例订单量为 ${100+(n-1)*13}`)));
    const visibleNumbers=chapters-missingNumbers.length;
    const issues=plan.slides.flatMap((slide,index)=>layoutIssues(slide.elements??[]).map(detail=>({page:index+1,detail})));
    const coveragePassed=compressed
      ? visibleFacts===chapters&&visibleNumbers===chapters
      : covered===chapters&&visibleFacts===chapters;
    const structuralPassed=plan.slides.length===expectedPages&&coveragePassed&&!issues.length&&(!outputPlan||!outputPlan.template.draft);
    const contentPassed=outputPlan ? outputPlan.template.audit!=="unavailable"&&!outputPlan.template.issues.length : true;
    report={...report,file:name,pages:plan.slides.length,expectedPages,compressed,coveredChapters:covered,notesCovered,totalChapters:chapters,visibleFacts,visibleNumbers,missingFacts,missingNumbers,coveragePassed,layoutIssues:issues,
      templateReport:outputPlan?.template,structuralPassed,contentPassed,passed:structuralPassed&&contentPassed,
      visualStatus:"not-checked",humanReview:"pending"};
  }catch(error){report={...report,passed:false,error:error instanceof Error?error.message:"验收失败"};}
  report={...report,calls,tokens,usageMissing:missing,durationMs:Date.now()-started};
  summaries.push(report);
  await fs.writeFile(path.join(output,`${selected}-${repeat+1}-trace.json`),JSON.stringify(trace,null,2));
  await fs.writeFile(path.join(output,"report.json"),JSON.stringify(summaries,null,2));
  console.log(JSON.stringify(report));
}
console.log(`验收产物 ${output}`);
if(summaries.some(item=>item.passed!==true))process.exitCode=1;
