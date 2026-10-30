import type { StoryboardProjectData } from "../shared/storyboard-project.js";
import { AppError } from "./tasks.js";

type Setting = StoryboardProjectData["characters"][number];
/** 按镜头展开所选版本，保持分镜原顺序，不改变已保存的项目。 */
export function resolveStoryboardSelection(data: StoryboardProjectData, ids: Set<string>) {
  type SelectedSetting = { name: string; prompt: string; assetId: string | null };
  const characters = new Map<string, SelectedSetting>();
  const scenes = new Map<string, SelectedSetting>();
  const props = new Map<string, SelectedSetting>();
  function resolve(items: Setting[], used: Map<string, SelectedSetting>, name: string, variantId: string): string {
    const setting = items.find((item) => item.name === name);
    if (!setting) return name; // 未匹配设定已有前端提示，保留用户文本
    const variant = variantId ? setting.variants.find((item) => item.id === variantId) : null;
    if (variantId && !variant) throw new AppError("STORYBOARD_VARIANT_MISSING", `「${name}」选用的版本已不存在，请重新选择。`, 409);
    const label = variant ? `${setting.name} · ${variant.name}` : setting.name;
    // 模板节点标题最多 80 字，确保截断后不会把不同版本错误地绑定到同一节点。
    const key = label.slice(0, 75);
    const value = { name: key, prompt: variant ? [setting.prompt, variant.prompt].filter(Boolean).join("；") : setting.prompt, assetId: variant ? variant.assetId : setting.assetId };
    const existing = used.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new AppError("STORYBOARD_VARIANT_CONFLICT", `设定名称过长或重复，无法区分「${label}」，请缩短名称。`, 400);
    used.set(key, value);
    return key;
  }
  const shots = data.shots.flatMap((shot, index) => {
    if (!ids.has(shot.id)) return [];
    const names = shot.character.split(/[、,，]/).map((name) => name.trim()).filter(Boolean);
    const character = names.map((name) => resolve(data.characters, characters, name, shot.characterVersions[name] ?? "")).join("、");
    const scene = shot.scene.trim() ? resolve(data.scenes, scenes, shot.scene.trim(), shot.sceneVersionId) : "";
    const propNames = shot.props.split(/[、,，]/).map((name) => name.trim()).filter(Boolean);
    const propsUsed = propNames.map((name) => resolve(data.props, props, name, shot.propVersions[name] ?? ""));
    return [{ ...shot, index: index + 1, kind: "image" as const, character, scene, props: propsUsed }];
  });
  return { shots, characters: [...characters.values()], scenes: [...scenes.values()], props: [...props.values()] };
}
