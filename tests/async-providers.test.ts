import { describe, expect, it } from "vitest";
import {
  ASYNC_FAILURE_STATUSES,
  ASYNC_SUCCESS_STATUSES,
  asyncProviderSpec,
  extractAsyncTaskId,
  extractProviderStatus,
} from "../src/server/async-providers.js";

describe("远端任务 id", () => {
  it("认得四家现有的提交响应形状", () => {
    expect(extractAsyncTaskId({ task_id: "wan-1" })).toBe("wan-1");
    expect(extractAsyncTaskId({ output: { task_id: "wan-2" } })).toBe("wan-2");
    expect(extractAsyncTaskId({ request_id: "grok-1" })).toBe("grok-1");
    expect(extractAsyncTaskId({ id: "seedance-1" })).toBe("seedance-1");
  });

  it("Suno 的 data 是任务 id 数组，取第一条当主任务", () => {
    expect(extractAsyncTaskId({ code: 200, data: [148787578, 148787581] })).toBe("148787578");
    expect(extractAsyncTaskId({ data: "single-task" })).toBe("single-task");
    expect(extractAsyncTaskId({ data: { task_id: "nested" } })).toBe("nested");
  });

  it("认不出来就返回 null，交给同步图片路径", () => {
    expect(extractAsyncTaskId({})).toBeNull();
    expect(extractAsyncTaskId({ data: [] })).toBeNull();
  });
});

describe("状态解析", () => {
  it("顶层与嵌套状态都认，统一小写", () => {
    expect(extractProviderStatus({ status: "SUCCEEDED" }).status).toBe("succeeded");
    expect(extractProviderStatus({ output: { task_status: "RUNNING", progress: 42 } })).toMatchObject({
      status: "running",
      progress: 42,
    });
    expect(extractProviderStatus({ data: { status: "FAILED" } }).status).toBe("failed");
  });

  it("失败原因从常见字段里抠出来", () => {
    expect(extractProviderStatus({ error: { message: "quota" } }).error).toBe("quota");
    expect(extractProviderStatus({ output: { code: "BadRequest", message: "bad prompt" } }).error)
      .toBe("BadRequest: bad prompt");
  });

  it("进度封顶 99，成功时由任务层写 100", () => {
    expect(extractProviderStatus({ progress: 100 }).progress).toBe(99);
    expect(extractProviderStatus({ progress: -5 }).progress).toBe(0);
  });
});

describe("厂商描述表", () => {
  it("三个现有视频渠道都有轮询路径", () => {
    expect(asyncProviderSpec("wan-video")?.pollPath("abc")).toBe("/api/v1/tasks/abc");
    expect(asyncProviderSpec("grok-video")?.pollPath("abc")).toBe("/v1/videos/abc");
    expect(asyncProviderSpec("seedance-video")?.pollPath("abc")).toBe("/api/v3/contents/generations/tasks/abc");
    expect(asyncProviderSpec("kling-video")?.pollPath("abc")).toBe("/tasks?task_ids=abc");
    expect(asyncProviderSpec("openai-images")).toBeNull();
  });

  it("视频结果按强候选排序，和原来的行为一致", () => {
    const spec = asyncProviderSpec("grok-video")!;
    const results = spec.extractResults({
      status: "succeeded",
      thumbnail: { url: "https://x/cover.jpg" },
      video: { url: "https://x/out.mp4", duration: 5 },
    });
    expect(results[0]).toMatchObject({ kind: "video", url: "https://x/out.mp4", duration: 5, strong: true });
  });

  it("成功/失败词表包含 Suno 的写法", () => {
    expect(ASYNC_SUCCESS_STATUSES).toContain("success");
    expect(ASYNC_FAILURE_STATUSES).toContain("fail");
    expect(ASYNC_FAILURE_STATUSES).toContain("failure");
    expect(ASYNC_FAILURE_STATUSES).not.toContain("unknown");
  });
});
