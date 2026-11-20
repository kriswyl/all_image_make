import { z } from "zod";
import type { SeedreamTaskMeta } from "../shared/seedream.js";

const amount = z.number().int().nonnegative().optional().catch(undefined);
const responseSchema = z.object({
  model: z.string().trim().max(200).optional().catch(undefined),
  usage: z.object({ input_images: amount, generated_images: amount, output_tokens: amount }).optional().catch(undefined),
});

export function seedreamResultMeta(payload: unknown, requestedReferences: number): SeedreamTaskMeta {
  const result = responseSchema.safeParse(payload).data;
  const acceptedReferences = result?.usage?.input_images;
  let warning: string | undefined;
  if (requestedReferences > 0) {
    if (acceptedReferences === undefined) warning = "上游未提供参考图用量";
    else if (acceptedReferences === 0) warning = `上游报告未使用参考图（提交 ${requestedReferences} 张）`;
    else if (acceptedReferences < requestedReferences) warning = `上游报告使用 ${acceptedReferences}/${requestedReferences} 张参考图`;
  }
  return {
    returnedModel: result?.model, requestedReferences, acceptedReferences,
    generatedImages: result?.usage?.generated_images, outputTokens: result?.usage?.output_tokens, warning,
  };
}
