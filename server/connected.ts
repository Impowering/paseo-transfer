import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  CHUNK_BYTES,
  hostIdentity,
  taskStart,
  taskStatus,
  readChunk,
  uploadStart,
  uploadChunk,
  releaseData,
} from "../shared/connected";
import { check } from "./worker";
import {
  archiveSessions,
  archiveSource,
  createArchive,
  receiveArchive,
} from "./archive";
import { hashFile } from "./archive-format";
import {
  defaultLimits,
  enforceLimit,
  limitsSchema,
  transferLimits,
  type TransferLimits,
} from "../shared/limits";

type Status = RpcOutput<typeof taskStatus>;
type Entry = {
  status: Status;
  expires: number;
  dir?: string;
  wireBytes?: number;
  checksum?: string;
  written: number;
  next: number;
  busy: boolean;
};
const TTL = 30 * 60_000;

/** Each host operates only on its own files, reached through Paseo's authenticated RPC. */
export function createConnectedService(
  home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"),
  getLimits: () => Promise<TransferLimits> = async () => defaultLimits,
) {
  const entries = new Map<string, Entry>();
  let disposed = false;
  const ownServerId = async () =>
    (await fs.readFile(path.join(home, "server-id"), "utf8")).trim();
  const identity = async () => ({
    serverId: await ownServerId(),
    protocol: 2 as const,
    taskTimeoutSeconds: (await getLimits()).taskTimeoutSeconds,
  });
  async function guard(serverId: string) {
    if (disposed)
      throw new Error("Transfer was reloaded. Reopen it and preview again.");
    if (serverId !== (await ownServerId()))
      throw new Error(
        "The Paseo host changed. Reopen Transfer on the intended host.",
      );
    for (const [id, entry] of entries)
      if (!entry.busy && entry.expires < Date.now()) await release(id);
  }
  async function release(id: string) {
    const entry = entries.get(id);
    if (!entry || entry.busy) return false;
    entries.delete(id);
    if (entry.dir) await fs.rm(entry.dir, { recursive: true, force: true });
    return true;
  }
  function get(id: string) {
    const entry = entries.get(id);
    if (!entry)
      throw new Error(
        "Transfer data expired or the plugin was reloaded. Preview again; check the target before retrying a started transfer.",
      );
    entry.expires = Date.now() + TTL;
    return entry;
  }
  function allocate(busy = false) {
    if (
      [...entries.values()].filter((e) => e.busy || e.dir).length >= 4 ||
      entries.size >= 24
    )
      throw new Error(
        "Too many transfers are pending on this host. Finish them or reopen Transfer after they expire.",
      );
    const id = randomUUID();
    const entry: Entry = {
      status: { state: "running", message: "Preparing transfer…" },
      expires: Date.now() + TTL,
      written: 0,
      next: 0,
      busy,
    };
    entries.set(id, entry);
    return { id, entry };
  }
  const file = (entry: Entry) => path.join(entry.dir!, "archive.bin");
  async function start(input: RpcInput<typeof taskStart>) {
    await guard(input.serverId);
    const limits = await getLimits();
    // Acquire an upload synchronously before another receive/release can consume it.
    const task = input.task;
    const upload = task.action === "receive" ? get(task.uploadId) : undefined;
    if (
      upload &&
      (upload.busy || !upload.dir || upload.written !== upload.wireBytes)
    )
      throw new Error(
        "Transfer upload is incomplete or already being received. Preview again.",
      );
    if (
      [...entries.values()].some(
        (e) =>
          e.busy && e.status.message === "Copying and verifying workspace…",
      ) &&
      task.action === "receive"
    )
      throw new Error(
        "This host is already receiving a workspace. Wait for it to finish.",
      );
    const { id, entry } = allocate(true);
    if (upload) upload.busy = true;
    entry.status.message =
      task.action === "receive"
        ? "Copying and verifying workspace…"
        : "Checking workspace…";
    void (async () => {
      try {
        switch (task.action) {
          case "export": {
            const exported = await createArchive(
              home,
              task.workspaceId,
              limits,
            );
            entry.dir = exported.dir;
            const snap = exported.manifest;
            if (
              task.mode === "move" &&
              snap.workspace.isolation === "worktree" &&
              snap.hasIgnored
            )
              throw new Error(
                "This worktree has Git-ignored files. Choose Copy to keep those files on the source.",
              );
            entry.status.manifest = {
              workspace: snap.workspace,
              fingerprint: exported.fingerprint,
              sourceId: snap.sourceId,
              files: snap.files.length,
              bytes: exported.bytes,
              branch: snap.branch,
              hasIgnored: snap.hasIgnored,
              sessions: archiveSessions(snap.sessions),
              wireBytes: exported.wireBytes,
              chunks: Math.ceil(exported.wireBytes / CHUNK_BYTES),
              checksum: exported.checksum,
            };
            break;
          }
          case "check": {
            const checked = await check(
              home,
              task.destination,
              task.sessions,
              limits.maxFiles,
            );
            entry.status.destination = checked.destination;
            break;
          }
          case "receive": {
            if ((await hashFile(file(upload!))) !== upload!.checksum)
              throw new Error(
                "Transfer upload checksum mismatch. Preview again.",
              );
            entry.status.result = await receiveArchive(
              home,
              task.destination,
              file(upload!),
              limits,
            );
            break;
          }
          case "archive":
            await archiveSource(
              home,
              task.workspaceId,
              task.fingerprint,
              limits,
            );
            break;
        }
        entry.status.state = "done";
        entry.status.message = "Verified.";
      } catch (error) {
        entry.status.state = "failed";
        entry.status.message = (error as Error).message;
      } finally {
        entry.busy = false;
        if (upload && task.action === "receive") {
          upload.busy = false;
          await release(task.uploadId);
        }
        if (disposed || entry.status.state === "failed") {
          if (entry.dir) {
            await fs.rm(entry.dir, { recursive: true, force: true });
            entry.dir = undefined;
          }
        }
      }
    })();
    return { id };
  }
  return {
    identity,
    start,
    async status(input: RpcInput<typeof taskStatus>) {
      await guard(input.serverId);
      return get(input.id).status;
    },
    async read(input: RpcInput<typeof readChunk>) {
      await guard(input.serverId);
      const entry = get(input.id),
        manifest = entry.status.manifest;
      if (
        entry.status.state !== "done" ||
        !manifest ||
        input.index >= manifest.chunks
      )
        throw new Error("Transfer chunk is unavailable. Preview again.");
      const handle = await fs.open(file(entry), "r");
      try {
        const buffer = Buffer.alloc(CHUNK_BYTES);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          CHUNK_BYTES,
          input.index * CHUNK_BYTES,
        );
        return { data: buffer.subarray(0, bytesRead).toString("base64") };
      } finally {
        await handle.close();
      }
    },
    async upload(input: RpcInput<typeof uploadStart>) {
      await guard(input.serverId);
      const limits = await getLimits();
      enforceLimit(input.wireBytes, limits.maxBytes, "Archive bytes");
      const disk = await fs.statfs(tmpdir());
      if (disk.bavail * disk.bsize < input.wireBytes * 3)
        throw new Error(
          "Not enough temporary disk space for archive, verification and destination.",
        );
      const { id, entry } = allocate(true);
      try {
        entry.dir = await fs.mkdtemp(path.join(tmpdir(), "paseo-transfer-"));
        await fs.chmod(entry.dir, 0o700);
        await fs.writeFile(file(entry), "", { mode: 0o600 });
        entry.wireBytes = input.wireBytes;
        entry.checksum = input.checksum;
        return { id };
      } catch (error) {
        entry.busy = false;
        await release(id);
        throw error;
      } finally {
        entry.busy = false;
      }
    },
    async write(input: RpcInput<typeof uploadChunk>) {
      await guard(input.serverId);
      const entry = get(input.id);
      if (!entry.wireBytes || entry.busy || input.index !== entry.next)
        throw new Error("Transfer chunks arrived out of order. Preview again.");
      const data = Buffer.from(input.data, "base64");
      if (
        data.toString("base64") !== input.data ||
        data.length !== Math.min(CHUNK_BYTES, entry.wireBytes - entry.written)
      )
        throw new Error("Transfer chunk has an invalid size or encoding.");
      entry.busy = true;
      try {
        await fs.appendFile(file(entry), data);
        entry.written += data.length;
        return { next: ++entry.next };
      } finally {
        entry.busy = false;
      }
    },
    async release(input: RpcInput<typeof releaseData>) {
      await guard(input.serverId);
      return { released: await release(input.id) };
    },
    async dispose() {
      disposed = true;
      for (const [id, entry] of entries) if (!entry.busy) await release(id);
    },
  };
}

export function contributeConnected(server: PluginServerContext) {
  const settings = server.registerSettings(transferLimits);
  const service = createConnectedService(undefined, async () => {
    const state = await settings.read();
    if (state.status !== "ready")
      throw new Error("Transfer limits settings are invalid.");
    return limitsSchema.parse(state.values);
  });
  server.handle(hostIdentity, service.identity);
  server.handle(taskStart, service.start);
  server.handle(taskStatus, service.status);
  server.handle(readChunk, service.read);
  server.handle(uploadStart, service.upload);
  server.handle(uploadChunk, service.write);
  server.handle(releaseData, service.release);
  return () => service.dispose();
}
