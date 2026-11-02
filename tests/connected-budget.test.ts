import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransferClient } from "../client/connected-transfer";
import type { HostRpc } from "../client/federation";

test("connected polling uses the selected host's advertised task budget and releases expired work", async () => {
  let clock = 0,
    polls = 0;
  const calls: string[] = [];
  const rpc = (async (contract: { name: string }) => {
    calls.push(contract.name);
    if (contract.name === "transfer.identity")
      return { serverId: "source", protocol: 2, taskTimeoutSeconds: 3 };
    if (contract.name === "transfer.task.start") return { id: "export" };
    if (contract.name === "transfer.task.status") {
      polls++;
      return { state: "running", message: "busy" };
    }
    if (contract.name === "transfer.release") return { released: true };
    throw new Error("unexpected call");
  }) as HostRpc;
  const client = createTransferClient(
    () => rpc,
    async () => {
      clock += 1000;
    },
    () => clock,
  );
  await assert.rejects(
    client.preview({
      sourceId: "source",
      targetId: "target",
      workspaceId: "workspace",
      destination: "/new",
      mode: "copy",
    }),
    /taking too long/,
  );
  assert.equal(polls, 3);
  assert.equal(calls.at(-1), "transfer.release");
});

test("a selected host identity mismatch stops before any transfer task", async () => {
  const rpc = (async (contract: { name: string }) => {
    assert.equal(contract.name, "transfer.identity");
    return { serverId: "unexpected", protocol: 2, taskTimeoutSeconds: 3 };
  }) as HostRpc;
  const client = createTransferClient(() => rpc);
  await assert.rejects(
    client.preview({
      sourceId: "source",
      targetId: "target",
      workspaceId: "workspace",
      destination: "/new",
      mode: "copy",
    }),
    /host changed/,
  );
});
