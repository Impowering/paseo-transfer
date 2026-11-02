import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

async function handlers(checkFails: boolean) {
  const calls: string[] = [];
  const bundle = await build({
    entryPoints: ["server/handlers.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "fault-transport",
        setup(build) {
          build.onResolve({ filter: /^\.\/transport$/ }, () => ({
            path: "fixture:transport",
            external: true,
          }));
        },
      },
    ],
  });
  const module = { exports: {} as typeof import("../server/handlers") };
  const invoke = async (_endpoint: unknown, request: { action: string }) => {
    calls.push(request.action);
    if (request.action === "archive-export")
      return {
        file: "/tmp/paseo-transfer-export-ABC123/archive.bin",
        fingerprint: "fingerprint",
        checksum: "f".repeat(64),
        wireBytes: 1024,
        bytes: 1024,
        workspace: {
          workspaceId: "w1",
          name: "fixture",
          cwd: "/fixture",
          isolation: "local",
          project: "fixture",
        },
        sourceId: "source",
        files: 1,
        branch: null,
        sessions: [],
        hasIgnored: false,
      };
    if (request.action === "check") {
      if (checkFails) throw new Error("target check disconnected");
      return { destination: "/new-target" };
    }
    if (request.action === "archive-release")
      throw new Error("source disconnected during cleanup");
    throw new Error("unexpected operation");
  };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    (id: string) =>
      id === "fixture:transport"
        ? {
            invoke,
            copyArchive() {
              throw new Error("must not copy");
            },
            disposeTransport() {},
          }
        : id === "node:crypto"
          ? { randomUUID: () => "prepared-plan" }
          : require(id),
    module,
    module.exports,
  );
  return { service: module.exports, calls };
}

const input = {
  source: { target: "studio", port: 2222, home: "/private/source-home" },
  target: { target: "mini" },
  workspaceId: "w1",
  destination: "/new-target",
  mode: "copy" as const,
};
test("preview retains the original failure and exact source spool when cleanup loses its host", async () => {
  const { service, calls } = await handlers(true);
  await assert.rejects(service.preview(input), (error) => {
    const message = (error as Error).message;
    assert.match(message, /target check disconnected/);
    assert.match(message, /source disconnected during cleanup/);
    assert.match(message, /studio/);
    assert.match(message, /2222/);
    assert.match(message, /\/private\/source-home/);
    assert.match(message, /\/tmp\/paseo-transfer-export-ABC123\/archive.bin/);
    return true;
  });
  assert.deepEqual(calls, ["archive-export", "check", "archive-release"]);
});
test("a preview whose cleanup failed cannot leave a startable cached plan", async () => {
  const { service } = await handlers(false);
  await assert.rejects(service.preview(input), /private spool retained/);
  assert.throws(
    () => service.start({ planId: "prepared-plan" }),
    /Preview expired/,
  );
});
