import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForSshPreview } from "../client/ssh-preview";
const input = {
  source: { target: "studio" },
  target: { target: "mini" },
  workspaceId: "w1",
  destination: "/copy",
  mode: "copy" as const,
};
const plan = {
  id: "plan",
  workspace: {
    workspaceId: "w1",
    name: "workspace",
    cwd: "/source",
    isolation: "local",
    project: "project",
  },
  destination: "/copy",
  files: 1,
  sessions: 0,
  bytes: 1,
  branch: null,
  skipped: [],
  mode: "copy" as const,
};
test("SSH preview polling continues past the daemon client's sixty-second request budget", async () => {
  let time = 0,
    calls = 0;
  const output = await waitForSshPreview(
    input,
    async () => ({ previewId: "task", timeoutSeconds: 180 }),
    async ({ previewId }) => {
      assert.equal(previewId, "task");
      calls++;
      return {
        state: time > 60_000 ? "done" : "running",
        plan: time > 60_000 ? plan : null,
        message: "Preparing",
      };
    },
    async () => {
      time += 61_000;
    },
    () => time,
  );
  assert.equal(output, plan);
  assert.equal(calls, 2);
});
test("polled SSH preview reports worker failure and the configured timeout", async () => {
  await assert.rejects(
    waitForSshPreview(
      input,
      async () => ({ previewId: "task", timeoutSeconds: 180 }),
      async () => ({
        state: "failed",
        plan: null,
        message: "Source changed; kept open",
      }),
    ),
    /Source changed/,
  );
  let time = 0;
  await assert.rejects(
    waitForSshPreview(
      input,
      async () => ({ previewId: "expired-task", timeoutSeconds: 2 }),
      async () => ({ state: "running", plan: null, message: "Preparing" }),
      async () => {
        time += 3000;
      },
      () => time,
    ),
    /expired-task.*Check its status/,
  );
});
