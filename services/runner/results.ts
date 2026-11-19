import { z } from "zod";
import { redactValue } from "./redaction.mjs";
import {typeSafeEvaluationSchema} from '../../packages/domain/typesafe-assessment.ts';
import type { ExecutionResult } from "../../packages/domain/contracts.ts";
const shape = z.object({
  assessmentEvaluation: typeSafeEvaluationSchema.optional(),
  summary: z.string().max(32000),
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        content: z.string().max(256000),
      }),
    )
    .max(8),
  checksPassed: z.boolean(),
  nativeSession: z
    .object({ threadId: z.string().max(200), turnId: z.string().max(200) })
    .optional(),
});
export function redactText(text: string) {
  return String(redactValue(text))
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]");
}
export function normalizeResult(input: unknown): ExecutionResult {
  const result = shape.parse(input);
  if (Buffer.byteLength(JSON.stringify(result)) > 512000)
    throw new Error("执行成果超过本地分享限制");
  return {
    ...result,
    summary: redactText(result.summary),
    artifacts: result.artifacts.map((a) => ({
      name: a.name.replace(/[\r\n/\\]/g, "_"),
      content: redactText(a.content),
    })),
  };
}
