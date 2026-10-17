import path from "node:path";
import { createApp } from "./app.js";
import { loadEnvFiles } from "./security.js";

loadEnvFiles();

const port = Number(process.env.PORT || 17891);
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("data");
const { app, context } = createApp({ dataDir });

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`ChatCanvas API: http://127.0.0.1:${port}`);
  // 已拿到上游 task id 的视频任务会在这里接着轮询，不阻塞启动
  void context.runner.resume();
  // 上一进程留下的 running 会话已经不存在了，收回 idle，否则界面永远转圈
  const recovered = context.agent.recoverStaleConversations();
  if (recovered) console.log(`收拾了 ${recovered} 条卡在「进行中」的会话`);
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
