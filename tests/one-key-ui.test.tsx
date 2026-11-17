// @vitest-environment jsdom
/**
 * 一 Key 模式在界面上的两个入口：
 * ① 「添加渠道」首屏顶部的主卡片，点了之后第二步**只出现一个**密钥框；
 * ② 新手引导欢迎页的「一 Key 模式」，点了直接进一页填 Key + 勾模型。
 *
 * 这两个地方是这条路径唯一的存在感，坏掉就等于功能没了，所以钉住。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddChannelWizard } from "../src/client/channels/AddChannelWizard";
import { ImmersiveOnboarding } from "../src/client/onboarding/ImmersiveOnboarding";
import { ONE_KEY_PRESET, ONE_KEY_SECRET_ENV } from "../src/shared/provider-presets";
import { MODEL_GROUPS } from "../src/shared/model-catalog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function mount(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function buttonWith(text: string) {
  const found = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`没有找到按钮：${text}`);
  return found as HTMLButtonElement;
}

/** 底部主按钮：卡片里也可能写着「下一步填 Key」，按文字找会撞上 */
function footerPrimary() {
  const found = document.querySelector<HTMLButtonElement>(".modal-footer .primary-button");
  if (!found) throw new Error("没有找到底部主按钮");
  return found;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("添加渠道：一 Key 全开", () => {
  it("首屏有主卡片，第二步只问一个密钥", () => {
    mount(<AddChannelWizard
      channels={[]}
      onClose={() => {}}
      onSaved={() => {}}
      onRemoved={() => {}}
      onCustom={() => {}}
      onToast={() => {}}
    />);

    const hero = buttonWith("一 Key 全开");
    expect(hero.textContent).toContain(`${ONE_KEY_PRESET.units.length} 个渠道`);
    act(() => hero.click());

    act(() => footerPrimary().click());
    const keys = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(keys).toHaveLength(1);
    expect(document.body.textContent).toContain(`${ONE_KEY_PRESET.units.length} 个渠道共用`);
    // 一 key 模式下不再出现「环境变量」逐单元输入
    expect(document.querySelectorAll(".key-fields")).toHaveLength(0);

    type(keys[0]!, "sk-one-key");
    act(() => footerPrimary().click());
    const rows = document.querySelectorAll(".review-table tbody tr");
    expect(rows).toHaveLength(ONE_KEY_PRESET.units.length);
    expect(document.querySelectorAll(".mono-cell")).toHaveLength(ONE_KEY_PRESET.units.length);
    expect([...document.querySelectorAll(".mono-cell")].every((cell) => cell.textContent === ONE_KEY_SECRET_ENV)).toBe(true);
    expect(footerPrimary().textContent).toContain("开始保存");
  });

  it("单站点模板仍然逐单元填密钥（没被一 key 模式带跑）", () => {
    mount(<AddChannelWizard
      channels={[]}
      onClose={() => {}}
      onSaved={() => {}}
      onRemoved={() => {}}
      onCustom={() => {}}
      onToast={() => {}}
    />);
    act(() => buttonWith("词元流墟-gpt生图").click());
    act(() => footerPrimary().click());
    expect(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).toHaveLength(1);
    expect(document.querySelectorAll(".key-fields")).toHaveLength(1);
  });
});

describe("新手引导：一 Key 模式", () => {
  it("欢迎页入口直达一页填 Key + 勾全部模型", () => {
    vi.useFakeTimers();
    mount(<ImmersiveOnboarding
      channels={[]}
      onSaved={() => {}}
      onToast={() => {}}
      onClose={() => {}}
    />);

    const entry = buttonWith("一 Key 模式");
    expect(entry.textContent).toContain(`${MODEL_GROUPS.length} 个渠道`);

    act(() => entry.click());
    act(() => { vi.advanceTimersByTime(420); });

    expect(document.body.textContent).toContain("一 Key，全部点亮");
    const checks = document.querySelectorAll<HTMLInputElement>('.ink-onekey-row input[type="checkbox"]');
    expect(checks).toHaveLength(MODEL_GROUPS.length);
    expect([...checks].every((input) => input.checked)).toBe(true);

    const key = document.querySelector<HTMLInputElement>(".ink-onekey-field input")!;
    const submit = buttonWith("一键配置") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    type(key, "sk-one-key");
    const after = buttonWith("一键配置") as HTMLButtonElement;
    expect(after.disabled).toBe(false);
    expect(after.textContent).toContain(`${MODEL_GROUPS.length} 个渠道`);
  });
});
