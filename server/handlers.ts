import { randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import {
  listRpc,
  previewRpc,
  previewStartRpc,
  previewStatusRpc,
  runRpc,
  statusRpc,
} from "../shared/rpc";
import type { Plan, ExportedArchive, TransferResult } from "../shared/types";
import { discover } from "./discovery";
import { invoke, copyArchive, disposeTransport } from "./transport";
import {
  defaultLimits,
  limitsSchema,
  type TransferLimits,
} from "../shared/limits";
let getLimits: () => Promise<TransferLimits> = async () => defaultLimits;
export function configureLimits(read: () => Promise<TransferLimits>) {
  getLimits = read;
}
function endpointLabel(endpoint: RpcInput<typeof previewRpc>["source"]) {
  return JSON.stringify({
    target: endpoint.target || "local",
    port: endpoint.port,
    home: endpoint.home,
  });
}
async function release(
  endpoint: RpcInput<typeof previewRpc>["source"],
  file: string,
  limits: TransferLimits,
) {
  await invoke(endpoint, { action: "archive-release", file }, limits);
}

export const hosts = async () => ({ hosts: await discover() });
export const list = async (input: RpcInput<typeof listRpc>) =>
  invoke<{ workspaces: Plan["workspace"][] }>(input.endpoint, {
    action: "list",
  });
type Cached = {
  plan: Plan;
  input: RpcInput<typeof previewRpc>;
  fingerprint: string;
  expires: number;
};
const plans = new Map<string, Cached>();
const runs = new Map<
  string,
  {
    state: "running" | "done" | "failed";
    message: string;
    result: TransferResult | null;
  }
>();
const previews = new Map<
  string,
  {
    state: "running" | "done" | "failed";
    message: string;
    plan: Plan | null;
    expires: number;
  }
>();
export async function startPreview(input: RpcInput<typeof previewStartRpc>) {
  if (disposed) throw new Error("Transfer is shutting down.");
  for (const [id, task] of previews)
    if (task.state !== "running" && task.expires < Date.now())
      previews.delete(id);
  const limits = limitsSchema.parse(await getLimits());
  if (disposed) throw new Error("Transfer is shutting down.");
  if (
    [...previews.values()].filter((task) => task.state === "running").length >=
    4
  )
    throw new Error("Too many previews are running. Wait for one to finish.");
  for (const [id, previous] of previews) {
    if (previews.size < 24) break;
    if (previous.state !== "running") previews.delete(id);
  }
  const previewId = randomUUID();
  const task = {
    state: "running" as "running" | "done" | "failed",
    message: "Preparing transfer preview…",
    plan: null as Plan | null,
    expires: 0,
  };
  previews.set(previewId, task);
  void preparePreview(input, limits).then(
    (plan) => {
      task.expires = Date.now() + 10 * 60_000;
      task.plan = plan;
      task.message = "Preview ready.";
      task.state = "done";
    },
    (error) => {
      task.expires = Date.now() + 10 * 60_000;
      task.message = (error as Error).message;
      task.state = "failed";
    },
  );
  // Export, destination check and cleanup each have the configured worker bound.
  return { previewId, timeoutSeconds: limits.taskTimeoutSeconds * 3 + 30 };
}
export function previewStatus({
  previewId,
}: RpcInput<typeof previewStatusRpc>) {
  const task = previews.get(previewId);
  if (!task)
    throw new Error(
      "Preview status is unavailable after reload or expiry. Preview again.",
    );
  return { state: task.state, message: task.message, plan: task.plan };
}
let disposed = false;
let busy = false;
export async function preview(input: RpcInput<typeof previewRpc>) {
  return preparePreview(input, limitsSchema.parse(await getLimits()));
}
async function preparePreview(
  input: RpcInput<typeof previewRpc>,
  limits: TransferLimits,
) {
  if (
    input.source.target === input.target.target &&
    input.source.home === input.target.home
  )
    throw new Error("Choose different source and target hosts.");
  if (disposed) throw new Error("Transfer is shutting down.");
  const snap = await invoke<ExportedArchive>(
    input.source,
    {
      action: "archive-export",
      workspaceId: input.workspaceId,
      limits,
    },
    limits,
  );
  let prepared: Plan | undefined, failure: unknown;
  try {
    if (
      input.mode === "move" &&
      snap.workspace.isolation === "worktree" &&
      snap.hasIgnored
    )
      throw new Error(
        "This worktree contains Git-ignored files that will not be copied. Choose Copy to keep those files on the source.",
      );
    const checked = await invoke<{ destination: string }>(
      input.target,
      {
        action: "check",
        destination: input.destination,
        sessions: snap.sessions,
        limits,
      },
      limits,
    );
    for (const [id, p] of plans) if (p.expires < Date.now()) plans.delete(id);
    if (plans.size >= 4) plans.delete(plans.keys().next().value!);
    if (disposed) throw new Error("Transfer is shutting down.");
    const plan: Plan = {
      id: randomUUID(),
      workspace: snap.workspace,
      destination: checked.destination,
      files: snap.files,
      sessions: snap.sessions.length,
      bytes: snap.bytes,
      branch: snap.branch,
      skipped: [],
      mode: input.mode,
    };
    prepared = plan;
    plans.set(plan.id, {
      plan,
      input,
      fingerprint: snap.fingerprint,
      expires: Date.now() + 10 * 60_000,
    });
    return plan;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await release(input.source, snap.file, limits);
    } catch (error) {
      if (prepared) plans.delete(prepared.id);
      throw new Error(
        `${failure ? `${(failure as Error).message} ` : ""}Preview cleanup failed on ${endpointLabel(input.source)}; private spool retained at ${snap.file}: ${(error as Error).message}`,
      );
    }
  }
}
export function start({ planId }: RpcInput<typeof runRpc>) {
  if (disposed) throw new Error("Transfer is shutting down.");
  if (busy)
    throw new Error("A transfer is already running. Wait for it to finish.");
  const cached = plans.get(planId);
  if (!cached || cached.expires < Date.now())
    throw new Error("Preview expired. Preview this transfer again.");
  plans.delete(planId);
  busy = true;
  const runId = randomUUID();
  const run: {
    state: "running" | "done" | "failed";
    message: string;
    result: TransferResult | null;
  } = { state: "running", message: "Checking source…", result: null };
  runs.set(runId, run);
  for (const [id, old] of runs)
    if (runs.size > 8 && old.state !== "running") runs.delete(id);
  void (async () => {
    let limits = defaultLimits;
    let completed = false,
      nativeAttempted = false;
    let fresh: ExportedArchive | undefined, upload: string | undefined;
    let cleanup = "";
    try {
      limits = limitsSchema.parse(await getLimits());
      fresh = await invoke<ExportedArchive>(
        cached.input.source,
        {
          action: "archive-export",
          workspaceId: cached.input.workspaceId,
          limits,
        },
        limits,
      );
      if (fresh.fingerprint !== cached.fingerprint)
        throw new Error(
          "Source changed since preview. Preview it again before transferring.",
        );
      if (disposed) throw new Error("Transfer is shutting down.");
      run.message = "Copying and verifying workspace…";
      ({ file: upload } = await invoke<{ file: string }>(
        cached.input.target,
        {
          action: "archive-upload",
          wireBytes: fresh.wireBytes,
          limits,
        },
        limits,
      ));
      await copyArchive(
        cached.input.source,
        cached.input.target,
        fresh,
        upload,
        limits,
      );
      if (disposed)
        throw new Error("Transfer was reloaded; source has been kept open.");
      nativeAttempted = true;
      const result = await invoke<TransferResult>(
        cached.input.target,
        {
          action: "archive-receive",
          destination: cached.plan.destination,
          file: upload,
          checksum: fresh.checksum,
          limits,
        },
        limits,
      );
      if (!result.verified)
        throw new Error(
          "Target did not verify the transfer; source has been kept open.",
        );
      run.result = result;
      if (cached.plan.mode === "move") {
        if (disposed)
          throw new Error(
            "Transfer was reloaded; target is copied but source was kept open.",
          );
        run.message = "Destination verified. Archiving source…";
        await invoke(
          cached.input.source,
          {
            action: "archive-source",
            workspaceId: cached.input.workspaceId,
            fingerprint: fresh.fingerprint,
            limits,
          },
          limits,
        );
        result.sourceArchived = true;
      }
      completed = true;
      run.message =
        cached.plan.mode === "move"
          ? "Workspace moved and verified."
          : "Workspace copied and verified.";
    } catch (error) {
      run.message = (error as Error).message;
      if (nativeAttempted)
        run.message += ` Check destination ${cached.plan.destination} and the original source before retrying; a native operation may have committed before its reply was lost.`;
    } finally {
      for (const [endpoint, file] of [
        [cached.input.source, fresh?.file],
        [cached.input.target, upload],
      ] as const) {
        if (!file) continue;
        try {
          await release(endpoint, file, limits);
        } catch (error) {
          cleanup += ` Private spool retained on ${endpointLabel(endpoint)} at ${file}: ${(error as Error).message}`;
        }
      }
      if (cleanup) run.message += cleanup;
      busy = false;
      run.state = completed ? "done" : "failed";
    }
  })();
  return { runId };
}
export function status({ runId }: RpcInput<typeof statusRpc>) {
  const run = runs.get(runId);
  if (!run)
    throw new Error(
      "Transfer status is unavailable after a plugin reload. Check the target workspace.",
    );
  return run;
}
export function dispose() {
  disposed = true;
  plans.clear();
  previews.clear();
  disposeTransport();
}
