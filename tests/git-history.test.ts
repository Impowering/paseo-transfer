import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTransferClient,
  type ConnectedPlan,
} from "../client/connected-transfer";
import { waitForSshPreview } from "../client/ssh-preview";
import {
  parseGitHistoryScope,
  requireGitHistoryScope,
} from "../shared/git-history";
import type { HostRpc } from "../client/federation";

const input = {
  sourceId: "source",
  targetId: "target",
  workspaceId: "workspace",
  destination: "/copy",
  mode: "copy" as const,
};
const row = {
  workspaceId: "workspace",
  name: "fixture",
  cwd: "/source",
  isolation: "local",
  project: "fixture",
};
function client(caps: Record<string, string[] | undefined>, legacy = false) {
  const calls: Array<{ serverId: string; method: string; input: any }> = [];
  const tasks = new Map<string, any>();
  let sequence = 0;
  const getRpc = (serverId: string) =>
    (async (contract: { name: string }, value: any) => {
      calls.push({ serverId, method: contract.name, input: value });
      if (contract.name === "transfer.identity")
        return {
          serverId,
          protocol: 2,
          taskTimeoutSeconds: 60,
          gitHistoryScopes: caps[serverId],
        };
      if (contract.name === "transfer.task.start") {
        const id = String(++sequence);
        tasks.set(id, value.task);
        return { id };
      }
      if (contract.name === "transfer.task.status") {
        const task = tasks.get(value.id);
        if (task.action === "check")
          return { state: "done", message: "Checked", destination: "/copy" };
        return {
          state: "done",
          message: "Ready",
          manifest: {
            workspace: row,
            fingerprint: "bound-source",
            sourceId: serverId,
            files: 1,
            bytes: 1,
            branch: "leaf",
            sessions: [],
            hasIgnored: false,
            wireBytes: 1,
            chunks: 1,
            checksum: "a".repeat(64),
            ...(legacy ? {} : { gitHistoryScope: task.gitHistoryScope }),
          },
        };
      }
      if (contract.name === "transfer.release") return { released: true };
      throw new Error("Unexpected RPC");
    }) as HostRpc;
  return { service: createTransferClient(getRpc), calls };
}
test("history scope defaults to repository and refuses invalid requests", () => {
  assert.equal(parseGitHistoryScope(undefined), "repository");
  assert.equal(parseGitHistoryScope("workspace"), "workspace");
  for (const value of [null, "head-only", "", false])
    assert.throws(() => parseGitHistoryScope(value));
});
test("workspace scope refuses either legacy connected endpoint before starting a task", async () => {
  for (const missing of ["source", "target"]) {
    const fixture = client({
      source: ["repository", "workspace"],
      target: ["repository", "workspace"],
      [missing]: undefined,
    });
    await assert.rejects(
      fixture.service.preview({ ...input, gitHistoryScope: "workspace" }),
      /does not support workspace/,
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "transfer.task.start")
        .length,
      0,
    );
  }
});
test("legacy endpoints retain default repository behavior", async () => {
  const fixture = client({ source: undefined, target: undefined }, true);
  const plan = await fixture.service.preview(input);
  assert.equal(plan.gitHistoryScope, "repository");
});
test("changing a connected preview's selected scope holds start", async () => {
  const fixture = client({
    source: ["repository", "workspace"],
    target: ["repository", "workspace"],
  });
  const plan: ConnectedPlan = await fixture.service.preview({
    ...input,
    gitHistoryScope: "workspace",
  });
  const before = fixture.calls.length;
  plan.gitHistoryScope = "repository";
  assert.throws(
    () => fixture.service.start(plan),
    /scope changed since preview/,
  );
  assert.equal(fixture.calls.length, before);
});
test("SSH workspace preview refuses an old controlling plugin before starting", async () => {
  let started = false;
  await assert.rejects(
    waitForSshPreview(
      {
        source: { target: "source" },
        target: { target: "target" },
        workspaceId: "workspace",
        destination: "/copy",
        mode: "copy",
        gitHistoryScope: "workspace",
      },
      async () => {
        started = true;
        return { previewId: "task", timeoutSeconds: 60 };
      },
      async () => ({ state: "running", message: "busy", plan: null }),
      undefined,
      undefined,
      async () => ({}),
    ),
    /does not support workspace/,
  );
  assert.equal(started, false);
});

test("malformed capability metadata cannot advertise workspace scope", () => {
  for (const supported of [undefined, null, "workspace", {}, ["repository"]])
    assert.throws(
      () => requireGitHistoryScope("workspace", supported as string[]),
      /does not support workspace/,
    );
});
