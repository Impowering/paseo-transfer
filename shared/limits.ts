import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const limitsSchema = z.object({
  // Zero removes the policy limit; framing and checksum validation always remain bounded.
  maxFiles: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(100_000),
  maxBytes: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(16 * 1024 ** 3),
  maxFileBytes: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(4 * 1024 ** 3),
  commandTimeoutSeconds: z.number().int().min(1).max(86400).default(900),
  taskTimeoutSeconds: z.number().int().min(1).max(86400).default(3600),
});
export type TransferLimits = z.infer<typeof limitsSchema>;
export const defaultLimits = limitsSchema.parse({});
export const transferLimits = defineSettings({
  id: "limits",
  scope: "host",
  version: 1,
  schema: limitsSchema,
});
export function enforceLimit(value: number, limit: number, label: string) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (limit !== 0 && value > limit)
  )
    throw new Error(
      `${label} exceeds this host's configured transfer limit (${limit}).`,
    );
}
