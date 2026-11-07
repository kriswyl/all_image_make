import path from "node:path";
import { createApp } from "./app.js";
import { loadEnvFiles } from "./security.js";
import { getWpsPreviewJobs } from "./wps-preview.js";
import { cleanupExpiredCandidates, reconcileCandidates } from "./document-publish.js";

loadEnvFiles();

const port = Number(process.env.PORT || 17891);
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("data");
const { app, context } = createApp({ dataDir });

const server = app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") getWpsPreviewJobs(context.db).setOrigin(`http://127.0.0.1:${address.port}`);
  console.log(`ChatCanvas API: http://127.0.0.1:${port}`);
  // 已拿到上游 task id 的视频任务会在这里接着轮询，不阻塞启动
  void context.runner.resume();
  // 上一进程留下的 running 会话已经不存在了，收回 idle，否则界面永远转圈
  const recovered = context.agent.recoverStaleConversations();
  if (recovered) console.log(`收拾了 ${recovered} 条卡在「进行中」的会话`);
  // B：重启后核对候选登记与已有字节，补齐/清理未发布孤儿；不重新生成，也不重复增加版本。
  const publishRecovery = reconcileCandidates(context.db);
  const expired = cleanupExpiredCandidates(context.db);
  const cleaned = publishRecovery.removedOrphans.length + expired.length;
  if (cleaned) console.log(`清理了 ${cleaned} 份未发布的候选产物`);
  // 暂停保护引用是粗粒度开关（命中就整族不清理）；没有断点的残留会让磁盘永远清不下去。
  const orphanRefs = context.db.specs.releaseOrphanPausedRefs();
  if (orphanRefs) console.log(`释放了 ${orphanRefs} 条已无断点的家族保护引用`);
  // 低频清理跑在同一进程里，不引入独立常驻进程；unref 保证不阻止退出。
  const sweep = setInterval(() => cleanupExpiredCandidates(context.db), 6 * 60 * 60 * 1000);
  sweep.unref();
});

function shutdown() {
  server.close(() => {
    // 先让 Agent 解绑 TaskRunner 的订阅并中断在跑的那一轮，再关库
    context.agent.dispose();
    context.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * 被桌面端拉起时（EXIT_WITH_PARENT=1）看守父进程：父进程消失就退出。
 *
 * 否则强杀桌面端（任务管理器、崩溃、卸载覆盖安装）会留下一个仍在监听
 * 17892 的后端孤儿进程，下次启动的新后端连端口都抢不回来，界面会连到
 * 旧进程上，出现“渠道保存不了”这类莫名故障。
 */
if (process.env.EXIT_WITH_PARENT === "1") {
  const parentPid = process.ppid;
  const guard = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log("父进程已退出，后端随之退出");
      process.exit(0);
    }
  }, 5000);
  guard.unref();
}
