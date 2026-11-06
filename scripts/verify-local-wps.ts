import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { getWpsPreviewJobs } from "../src/server/wps-preview.js";
import { renderWithLocalWps } from "../src/server/wps-auto-render.js";
import { renderContentSlide } from "../src/server/presentation-templates.js";
import { renderAiPresentation } from "../src/server/mind-document.js";
const dir=path.resolve("artifacts","wps-verification",new Date().toISOString().replace(/[:.]/g,"-"));
await fs.mkdir(dir,{recursive:true});
const {app,context}=createApp({dataDir:path.join(dir,"runtime")});
const server=app.listen(0,"127.0.0.1");
await new Promise<void>(resolve=>server.once("listening",resolve));
const address=server.address();
if(!address||typeof address==="string")throw new Error("本地验收服务未启动");
getWpsPreviewJobs(context.db).setOrigin(`http://127.0.0.1:${address.port}`);
try{
  const plan={title:"WPS虚构验收",theme:"blue" as const,slides:[1,2,3].map(page=>renderContentSlide({page,title:`虚构验收第${page}页`,layout:"bullets",bullets:["仅验证本机渲染，不包含用户文件",`示例序号 ${page}`]},{},[],"").slide)};
  const fileFlag=process.argv.indexOf("--file"),target=fileFlag>=0?path.resolve(process.argv[fileFlag+1]??""):null;
  const fixtureRoot=path.resolve("artifacts","presentation-eval")+path.sep;
  if(target&&!target.toLowerCase().startsWith(fixtureRoot.toLowerCase()))throw new Error("仅允许渲染固定评测脚本输出的虚构资料文件");
  const bytes=target?await fs.readFile(target):await renderAiPresentation(plan);
  await fs.writeFile(path.join(dir,"synthetic.pptx"),bytes);
  const pages=await renderWithLocalWps(context.db,bytes,AbortSignal.timeout(100000));
  for(const [index,page]of pages.entries())await fs.writeFile(path.join(dir,`page-${index+1}.png`),page);
  const report={passed:target?pages.length>0:pages.length===3,pages:pages.length,source:"synthetic-only",output:dir};
  await fs.writeFile(path.join(dir,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){
  const report={passed:false,error:error instanceof Error?error.message:"WPS失败",output:dir};
  await fs.writeFile(path.join(dir,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));process.exitCode=1;
}finally{
  context.agent.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));context.db.close();
}
