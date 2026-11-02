import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CHUNK_BYTES = 192 * 1024;
// Workload limits are host settings; this is only JavaScript's exact integer boundary.
export const MAX_WIRE_BYTES = Number.MAX_SAFE_INTEGER;
export const workspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  cwd: z.string(),
  isolation: z.string(),
  project: z.string(),
});
const fileSchema = z.object({
  path: z.string(),
  data: z.string(),
  mode: z.number(),
  link: z.string().optional(),
});
const sessionSchema = z.object({
  id: z.string(),
  provider: z.enum(["claude", "codex"]),
  title: z.string(),
  labels: z.record(z.string(), z.string()),
  archived: z.boolean(),
  files: z.array(fileSchema),
});
export const exportSchema = z.object({
  workspace: workspaceSchema,
  fingerprint: z.string(),
  sourceId: z.string(),
  files: z.number(),
  bytes: z.number(),
  branch: z.string().nullable(),
  sessions: z.array(sessionSchema),
  hasIgnored: z.boolean(),
  wireBytes: z.number(),
  chunks: z.number(),
  checksum: z.string(),
});
export type ExportManifest = z.infer<typeof exportSchema>;
export const resultSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string(),
  agents: z.array(z.string()),
  verified: z.boolean(),
  sourceArchived: z.boolean(),
});
const serverId = z.string().min(1);
const id = z.string().uuid();
export const hostIdentity = defineRpc({
  name: "transfer.identity",
  input: z.object({}),
  output: z.object({
    serverId,
    protocol: z.literal(2),
    taskTimeoutSeconds: z.number().int().min(1).max(86400).default(3600),
  }),
});
export const taskStart = defineRpc({
  name: "transfer.task.start",
  input: z.object({
    serverId,
    task: z.discriminatedUnion("action", [
      z.object({
        action: z.literal("export"),
        workspaceId: z.string(),
        mode: z.enum(["copy", "move"]),
      }),
      z.object({
        action: z.literal("check"),
        destination: z.string().min(1),
        sessions: z.array(sessionSchema),
      }),
      z.object({
        action: z.literal("receive"),
        uploadId: id,
        destination: z.string().min(1),
      }),
      z.object({
        action: z.literal("archive"),
        workspaceId: z.string(),
        fingerprint: z.string(),
      }),
    ]),
  }),
  output: z.object({ id }),
});
export const taskStatus = defineRpc({
  name: "transfer.task.status",
  input: z.object({ serverId, id }),
  output: z.object({
    state: z.enum(["running", "done", "failed"]),
    message: z.string(),
    manifest: exportSchema.optional(),
    destination: z.string().optional(),
    result: resultSchema.optional(),
  }),
});
export const readChunk = defineRpc({
  name: "transfer.chunk.read",
  input: z.object({ serverId, id, index: z.number().int().min(0) }),
  output: z.object({ data: z.string().max((CHUNK_BYTES * 4) / 3) }),
});
export const uploadStart = defineRpc({
  name: "transfer.upload.start",
  input: z.object({
    serverId,
    wireBytes: z.number().int().min(1).max(MAX_WIRE_BYTES),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  output: z.object({ id }),
});
export const uploadChunk = defineRpc({
  name: "transfer.chunk.write",
  input: z.object({
    serverId,
    id,
    index: z.number().int().min(0),
    data: z
      .string()
      .min(1)
      .max((CHUNK_BYTES * 4) / 3),
  }),
  output: z.object({ next: z.number() }),
});
export const releaseData = defineRpc({
  name: "transfer.release",
  input: z.object({ serverId, id }),
  output: z.object({ released: z.boolean() }),
});
