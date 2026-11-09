import type { AppDatabase } from "./db.js";
import { AppError } from "./app-error.js";
import type { PresentationSpec } from "../shared/presentation-spec.js";
import type { TemplateReport } from "../shared/presentation-report.js";

/** 文件绑定的契约版本。所有保存入口都只传这一个结构，不再各写一套 expectedSpec*。 */
export type SpecBinding = { specId: string; specRevision: number };

export type ContractResolution = {
  spec: PresentationSpec | null;
  /** bound = 显式绑定；active = 旧文件兼容路径；none = 本会话确实没有任务契约 */
  source: "bound" | "active" | "none";
  binding?: SpecBinding;
};

export type BindingInput = {
  specRef?: SpecBinding;
  /** 兼容旧调用：这两个字段同样视为显式绑定，不能只当成「检查时的交叉校验」。 */
  expectedSpecId?: string;
  expectedSpecRevision?: number;
};

const invalid = () => new AppError(
  "SPEC_BINDING_INVALID",
  "文件绑定的任务契约不存在、不属于当前会话或版本已失效，拒绝发布", 409,
);

/**
 * 必经的契约解析入口。
 *
 * - 有显式绑定（specRef 或 expectedSpecId）时，必须解析到「本会话拥有的那个 revision」；
 *   解析不到一律报错，绝不降级成「无契约」或悄悄改用会话当前 active。
 * - 只有真正没有绑定的旧文件，才允许沿用 findActive 的兼容路径；
 *   连 active 都没有时才是真正的无契约文档（Word / Excel / 普通文本 / 普通 PPT）。
 */
export function resolveContractSpec(
  db: AppDatabase, conversationId: string, input: BindingInput = {},
): ContractResolution {
  const { specRef, expectedSpecId, expectedSpecRevision } = input;
  if (specRef && expectedSpecId && (expectedSpecId !== specRef.specId
    || (expectedSpecRevision !== undefined && expectedSpecRevision !== specRef.specRevision))) {
    throw invalid();
  }
  const explicit: SpecBinding | undefined = specRef
    ?? (expectedSpecId
      ? { specId: expectedSpecId, specRevision: expectedSpecRevision ?? 0 }
      : undefined);
  if (explicit) {
    // 没写 revision 时按「当前 revision」解析；仍然要经过归属校验。
    const revision = explicit.specRevision > 0
      ? explicit.specRevision
      : (db.specs.get(explicit.specId)?.revision ?? 0);
    if (!revision) throw invalid();
    const spec = db.specs.ownedRevision(conversationId, explicit.specId, revision);
    if (!spec) throw invalid();
    return { spec, source: "bound", binding: { specId: spec.specId, specRevision: spec.revision } };
  }
  const active = db.specs.findActive(conversationId);
  return active
    ? { spec: active, source: "active" }
    : { spec: null, source: "none" };
}

/**
 * 补做 / 视觉修复 / 编辑类入口：文件卡里存的是当初发布时绑定的契约版本。
 * 绑定失效必须在这里就拒绝，而不是把文件当成「无契约」重新发布。
 */
export function boundSpecRefFromReport(
  db: AppDatabase, conversationId: string, report?: TemplateReport | null,
): SpecBinding | undefined {
  if (!report?.specRef) return undefined;
  return resolveContractSpec(db, conversationId, { specRef: report.specRef }).binding;
}
