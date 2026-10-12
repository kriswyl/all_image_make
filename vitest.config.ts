import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // 视频轮询默认 8 秒一次，测试里压到 20ms 才能跑完整个提交流程
    env: { VIDEO_POLL_INTERVAL_MS: "20" },
  },
});
