// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ImageSkillCard } from "../src/client/chat/ImageSkillCard";
import { api } from "../src/client/api";
import { imageSkillInvocation, SAMPLE_IMAGE_SKILL, type ImageSkillRun } from "../src/shared/skills";
import type { Task } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("reviews and submits from the thread and saves the reusable skill after reviewing results", async () => {
  const run: ImageSkillRun = {
    id: "run", skillId: SAMPLE_IMAGE_SKILL.id, subjectId: "product.png", confirmed: false, submitting: false,
    target: { channelId: "channel", model: "gpt-image-2" }, requirements: "原色优先", reusableRules: "去除背景文字",
    items: ["sample2.png", "sample10.png"].map((name) => ({
      sample: { id: name, taskId: "initial", fileName: name, mimeType: "image/png", byteSize: 10, url: "/sample.png", createdAt: "" },
      name, fields: ["lighting", "colors"], analysis: { composition: "居中", colors: "浅色", lighting: "侧光", background: "无纹理", texture: "哑光" },
      task: null, error: null,
    })),
  };
  vi.spyOn(api, "skillRun").mockResolvedValue(run);
  const generated = { ...run, confirmed: true, items: run.items.map((item) => ({
    ...item, task: { status: "succeeded", assets: [{ ...item.sample, id: "output-" + item.sample.id }] } as Task,
  })) };
  const confirm = vi.spyOn(api, "confirmImageSkill").mockResolvedValue(generated);
  const save = vi.spyOn(api, "saveImageSkill").mockResolvedValue({ ...SAMPLE_IMAGE_SKILL, id: "saved", fields: ["lighting"], rules: "去除背景文字" });
  const onPreview = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  try {
    await act(async () => root.render(<ImageSkillCard conversationId="chat" runId="run" canConfirm
      onConfirmed={() => {}} onCompleted={() => {}} onSaved={() => {}} onPreview={onPreview} />));
    expect(confirm).not.toHaveBeenCalled();
    expect(button("认可流程")).toBeUndefined();
    const first = container.querySelector(".image-skill-rows > li")!;
    const colors = [...first.querySelectorAll("label")].find((element) => element.textContent?.includes("配色"))!;
    await act(async () => colors.querySelector("input")!.click());
    await act(async () => button("确认生成 2 张")!.click());
    expect(confirm).toHaveBeenCalledExactlyOnceWith("chat", "run", [["lighting"], ["lighting", "colors"]]);
    await act(async () => (container.querySelector('[aria-label="查看成品 sample2.png"]') as HTMLButtonElement).click());
    expect(onPreview.mock.lastCall?.[0].id).toBe("output-sample2.png");
    await act(async () => button("认可流程")!.click());
    const name = container.querySelector<HTMLInputElement>(".image-skill-save input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "商品摄影");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("保存 Skill")!.click());
    expect(save).toHaveBeenCalledExactlyOnceWith("chat", "run", "商品摄影", "去除背景文字");
    expect(button("下载 SKILL.md")).toBeDefined();
    expect(imageSkillInvocation("用样片批量改图：保持原色")).toBe("保持原色");
    expect(imageSkillInvocation("怎么用样片批量改图？")).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});
