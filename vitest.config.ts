import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20000,
    // 缩短异步任务的查询间隔，测试仍会走完整提交流程。
    env: { VIDEO_POLL_INTERVAL_MS: "20" },
  },
});
