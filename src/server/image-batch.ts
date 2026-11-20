import type { GenerationInput } from "../shared/types.js";
import type { ReferenceImageUpload, TaskRunner } from "./tasks.js";

/** Each result has its own task ID, retry input, and diagnostic history. */
export async function submitImageTasks(
  runner: Pick<TaskRunner, "create">,
  input: GenerationInput,
  references: ReferenceImageUpload[],
  count: number,
) {
  const results = await Promise.allSettled(Array.from({ length: count }, () =>
    runner.create({ ...input, count: 1 }, references)));
  if (results.every(result => result.status === "rejected")) {
    throw results[0]?.reason ?? new Error("没有提交图片生成任务");
  }
  return results;
}
