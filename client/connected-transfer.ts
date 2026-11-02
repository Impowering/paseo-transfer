import {
  parseGitHistoryScope,
  requireGitHistoryScope,
  type GitHistoryScope,
} from "../shared/git-history";
import type { RpcInput } from "@getpaseo/plugin";
import {
  exportSchema,
  hostIdentity,
  taskStart,
  taskStatus,
  uploadStart,
  uploadChunk,
  readChunk,
  releaseData,
  type ExportManifest,
} from "../shared/connected";
import type { Plan, TransferResult } from "../shared/types";
import { rpcForHost, type HostRpc } from "./federation";

export interface ConnectedPlan extends Plan {
  connected: {
    sourceId: string;
    targetId: string;
    exportId: string;
    manifest: ExportManifest;
    expires: number;
  };
}
export interface ConnectedRun {
  state: "running" | "done" | "failed";
  message: string;
  result: TransferResult | null;
  targetId: string;
}
type Task = RpcInput<typeof taskStart>["task"];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mirrors Transcript Search's per-host RPC federation; no new address or credentials. */
export function createTransferClient(
  getRpc: (id: string) => HostRpc = rpcForHost,
  pause = delay,
  now = Date.now,
) {
  const runs = new Map<string, ConnectedRun>();
  let sequence = 0;
  async function task(serverId: string, value: Task) {
    const identity = await getRpc(serverId)(hostIdentity, {});
    if (identity.serverId !== serverId)
      throw new Error("The Paseo host changed. Preview again.");
    if ("gitHistoryScope" in value)
      requireGitHistoryScope(
        parseGitHistoryScope(value.gitHistoryScope),
        identity.gitHistoryScopes,
      );
    const { id } = await getRpc(serverId)(taskStart, { serverId, task: value });
    try {
      const deadline = now() + identity.taskTimeoutSeconds * 1000;
      while (now() < deadline) {
        const status = await getRpc(serverId)(taskStatus, { serverId, id });
        if (status.state === "failed") throw new Error(status.message);
        if (status.state === "done") return { id, ...status };
        await pause(500);
      }
      throw new Error(
        "The host is taking too long. Check the target workspace before retrying; the source has been kept open.",
      );
    } catch (error) {
      await release(serverId, id);
      throw error;
    }
  }
  async function release(serverId: string, id: string) {
    try {
      await getRpc(serverId)(releaseData, { serverId, id });
    } catch {
      /* Disconnected or reloaded installations expire their own temporary data. */
    }
  }
  return {
    async preview(input: {
      sourceId: string;
      targetId: string;
      workspaceId: string;
      destination: string;
      mode: "copy" | "move";
      gitHistoryScope?: GitHistoryScope;
    }): Promise<ConnectedPlan> {
      if (input.sourceId === input.targetId)
        throw new Error("Choose different source and target hosts.");
      const gitHistoryScope = parseGitHistoryScope(input.gitHistoryScope);
      if (gitHistoryScope === "workspace") {
        for (const serverId of [input.sourceId, input.targetId]) {
          const identity = await getRpc(serverId)(hostIdentity, {});
          if (identity.serverId !== serverId)
            throw new Error("The Paseo host changed. Preview again.");
          requireGitHistoryScope(gitHistoryScope, identity.gitHistoryScopes);
        }
      }
      const exported = await task(input.sourceId, {
        action: "export",
        workspaceId: input.workspaceId,
        mode: input.mode,
        gitHistoryScope,
      });
      try {
        const manifest = exportSchema.parse(exported.manifest);
        if (parseGitHistoryScope(manifest.gitHistoryScope) !== gitHistoryScope)
          throw new Error(
            "Source did not confirm the selected Git history scope.",
          );
        if (manifest.sourceId !== input.sourceId)
          throw new Error("Source host changed. Reopen Transfer.");
        const checked = await task(input.targetId, {
          action: "check",
          destination: input.destination,
          sessions: manifest.sessions,
        });
        await release(input.targetId, checked.id);
        return {
          gitHistoryScope,
          id: exported.id,
          workspace: manifest.workspace,
          destination: checked.destination!,
          files: manifest.files,
          sessions: manifest.sessions.length,
          bytes: manifest.bytes,
          branch: manifest.branch,
          skipped: [],
          mode: input.mode,
          connected: {
            sourceId: input.sourceId,
            targetId: input.targetId,
            exportId: exported.id,
            manifest,
            expires: now() + 10 * 60_000,
          },
        };
      } catch (error) {
        await release(input.sourceId, exported.id);
        throw error;
      }
    },
    discard(plan: ConnectedPlan) {
      return release(plan.connected.sourceId, plan.connected.exportId);
    },
    start(plan: ConnectedPlan) {
      const gitHistoryScope = parseGitHistoryScope(plan.gitHistoryScope);
      if (
        gitHistoryScope !==
        parseGitHistoryScope(plan.connected.manifest.gitHistoryScope)
      )
        throw new Error(
          "Git history scope changed since preview. Preview again.",
        );
      if (plan.connected.expires < now())
        throw new Error("Preview expired. Preview this transfer again.");
      if ([...runs.values()].some((run) => run.state === "running"))
        throw new Error(
          "A transfer is already running in this app. Wait for it to finish.",
        );
      for (const [id, run] of runs)
        if (runs.size >= 8 && run.state !== "running") runs.delete(id);
      const id = `connected-${now()}-${++sequence}`;
      const run: ConnectedRun = {
        state: "running",
        message: "Checking source…",
        result: null,
        targetId: plan.connected.targetId,
      };
      runs.set(id, run);
      void (async () => {
        const { sourceId, targetId } = plan.connected;
        let freshId = "",
          uploadId = "";
        try {
          if (gitHistoryScope === "workspace") {
            const identity = await getRpc(targetId)(hostIdentity, {});
            if (identity.serverId !== targetId)
              throw new Error("The Paseo host changed. Preview again.");
            requireGitHistoryScope(gitHistoryScope, identity.gitHistoryScopes);
          }
          const fresh = await task(sourceId, {
            action: "export",
            workspaceId: plan.workspace.workspaceId,
            mode: plan.mode,
            gitHistoryScope,
          });
          freshId = fresh.id;
          const manifest = exportSchema.parse(fresh.manifest);
          if (
            parseGitHistoryScope(manifest.gitHistoryScope) !==
              gitHistoryScope ||
            manifest.fingerprint !== plan.connected.manifest.fingerprint
          )
            throw new Error(
              "Source changed since preview. Preview again before transferring.",
            );
          const upload = await getRpc(targetId)(uploadStart, {
            serverId: targetId,
            wireBytes: manifest.wireBytes,
            checksum: manifest.checksum,
          });
          uploadId = upload.id;
          for (let index = 0; index < manifest.chunks; index++) {
            run.message = `Copying workspace… ${Math.floor((index / manifest.chunks) * 100)}%`;
            const { data } = await getRpc(sourceId)(readChunk, {
              serverId: sourceId,
              id: freshId,
              index,
            });
            await getRpc(targetId)(uploadChunk, {
              serverId: targetId,
              id: uploadId,
              index,
              data,
            });
          }
          run.message = "Verifying destination and importing conversations…";
          const received = await task(targetId, {
            action: "receive",
            uploadId,
            destination: plan.destination,
            gitHistoryScope,
          });
          await release(targetId, received.id);
          const result = received.result;
          if (!result?.verified)
            throw new Error(
              "Destination did not verify the transfer. Source has been kept open.",
            );
          run.result = result;
          if (plan.mode === "move") {
            run.message = "Destination verified. Archiving source…";
            const archived = await task(sourceId, {
              action: "archive",
              workspaceId: plan.workspace.workspaceId,
              fingerprint: manifest.fingerprint,
              gitHistoryScope,
            });
            await release(sourceId, archived.id);
            result.sourceArchived = true;
          }
          run.state = "done";
          run.message = `Workspace ${plan.mode === "move" ? "moved" : "copied"} and verified.`;
        } catch (error) {
          run.state = "failed";
          run.message = `${(error as Error).message}${run.result ? " The verified destination is available; check both hosts before retrying." : " Check the target before retrying. The source has not been removed by Transfer."}`;
        } finally {
          await release(sourceId, plan.connected.exportId);
          if (freshId) await release(sourceId, freshId);
          if (uploadId) await release(targetId, uploadId);
        }
      })();
      return { runId: id };
    },
    status(id: string) {
      const run = runs.get(id);
      if (!run)
        throw new Error(
          "Transfer status is unavailable after reloading the app. Check the target workspace before retrying.",
        );
      return run;
    },
  };
}
export const connectedTransfer = createTransferClient();
