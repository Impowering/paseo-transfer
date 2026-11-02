import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { build } from "esbuild";
import * as worker from "../server/worker";
import { defaultLimits } from "../shared/limits";
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

test("packed promisor workspace history retains session bytes, native imports and stale-session guards", async () => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), "transfer-scope-sessions-"),
  );
  const source = path.join(root, "source"),
    destination = path.join(root, "target"),
    sourceHome = path.join(root, "source-home");
  const sourceProvider = path.join(root, "source-codex"),
    targetProvider = path.join(root, "target-codex");
  let providerRoot = sourceProvider,
    registered = false,
    archives = 0;
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const workspace = {
    workspaceId: "source-workspace",
    cwd: source,
    name: "Scoped sessions",
    isolation: "local",
    project: "source-project",
  };
  const imports: string[][] = [];
  const cli = async (_home: string | undefined, ...args: string[]) => {
    if (args[0] === "ls") return [];
    if (args[0] === "workspace" && args[1] === "create") {
      registered = true;
      return { workspaceId: "new-workspace" };
    }
    if (args[0] === "import") {
      imports.push(args);
      return { agentId: "new-agent" };
    }
    if (args[0] === "agent" && args[1] === "update") return {};
    if (args[0] === "inspect") return { Cwd: destination, Provider: "codex" };
    if (args[0] === "workspace" && args[1] === "archive") {
      archives++;
      return {};
    }
    throw new Error("Unexpected native CLI call: " + args.join(" "));
  };
  const list = async (home?: string) =>
    home === sourceHome
      ? [workspace]
      : registered
        ? [{ ...workspace, workspaceId: "new-workspace", cwd: destination }]
        : [];
  try {
    await fs.mkdir(source);
    await fs.mkdir(path.join(sourceHome, "agents"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "server-id"), "fixture-server");
    await exec("git", ["init", "-b", "leaf"], { cwd: source });
    await exec("git", ["config", "user.email", "transfer@example.test"], {
      cwd: source,
    });
    await exec("git", ["config", "user.name", "Transfer Test"], {
      cwd: source,
    });
    await fs.writeFile(path.join(source, "file"), "workspace file");
    await exec("git", ["add", "."], { cwd: source });
    await exec("git", ["commit", "-qm", "leaf history"], { cwd: source });
    // Fixture preparation only: keep selected history in a real promisor-marked pack.
    await exec("git", ["repack", "-ad"], { cwd: source });
    const packDirectory = path.join(source, ".git", "objects", "pack");
    const pack = (await fs.readdir(packDirectory)).find((name) =>
      name.endsWith(".pack"),
    )!;
    await fs.writeFile(
      path.join(packDirectory, pack.replace(/\.pack$/, ".promisor")),
      "",
    );
    await exec("git", ["config", "remote.origin.promisor", "true"], {
      cwd: source,
    });
    await exec(
      "git",
      ["config", "remote.origin.partialclonefilter", "blob:none"],
      { cwd: source },
    );
    await exec(
      "git",
      ["config", "remote.origin.url", "file:///fixture-network-must-not-run"],
      { cwd: source },
    );
    const packedBytes = await fs.readFile(path.join(packDirectory, pack));
    const relative = path.join(
      "sessions",
      "2026",
      `rollout-${sessionId}.jsonl`,
    );
    const transcript = path.join(sourceProvider, relative);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    const prose = `Keep this literal text: ${source}`;
    await fs.writeFile(
      transcript,
      JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: source, message: prose },
      }) + "\n",
    );
    await fs.writeFile(
      path.join(sourceHome, "agents", "source-agent.json"),
      JSON.stringify({
        id: "source-agent",
        workspaceId: workspace.workspaceId,
        provider: "codex",
        title: "Saved conversation",
        labels: { owner: "fixture" },
        persistence: { sessionId },
      }),
    );
    const bundle = await build({
      entryPoints: ["server/archive.ts"],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      packages: "external",
      plugins: [
        {
          name: "isolated-native-provider",
          setup(build) {
            build.onResolve({ filter: /^\.\/worker$/ }, () => ({
              path: "fixture:worker",
              external: true,
            }));
          },
        },
      ],
    });
    const module = { exports: {} as typeof import("../server/archive") };
    new Function("require", "module", "exports", bundle.outputFiles[0].text)(
      (id: string) =>
        id === "fixture:worker"
          ? {
              ...worker,
              cli,
              list,
              codexHome: () => providerRoot,
              claudeHome: () => path.join(root, "unused-claude"),
              sessionRoot: async () => providerRoot,
              check: async (_home: string | undefined, target: string) => ({
                destination: target,
              }),
            }
          : require(id),
      module,
      module.exports,
    );
    const archive = await module.exports.createArchive(
      sourceHome,
      workspace.workspaceId,
      defaultLimits,
      { gitHistoryScope: "workspace" },
    );
    try {
      assert.equal(archive.manifest.sessions[0].id, sessionId);
      assert.equal(archive.manifest.sessions[0].title, "Saved conversation");
      providerRoot = targetProvider;
      const result = await module.exports.receiveArchive(
        path.join(root, "target-home"),
        destination,
        archive.file,
        defaultLimits,
        undefined,
        "workspace",
      );
      assert.equal(result.verified, true);
      assert.deepEqual(result.agents, ["new-agent"]);
      assert.equal(imports[0][1], sessionId);
      assert.ok(imports[0].includes("owner=fixture"));
      const received = JSON.parse(
        (await fs.readFile(path.join(targetProvider, relative), "utf8")).trim(),
      );
      assert.equal(received.payload.cwd, destination);
      assert.equal(received.payload.message, prose);
      assert.equal(
        JSON.parse((await fs.readFile(transcript, "utf8")).trim()).payload.cwd,
        source,
      );
      providerRoot = sourceProvider;
      await fs.appendFile(
        transcript,
        JSON.stringify({
          type: "event_msg",
          payload: { message: "New source conversation" },
        }) + "\n",
      );
      await assert.rejects(
        module.exports.archiveSource(
          sourceHome,
          workspace.workspaceId,
          archive.fingerprint,
          defaultLimits,
          undefined,
          "workspace",
        ),
        /Source changed/,
      );
      assert.equal(archives, 0);
      assert.deepEqual(
        await fs.readFile(path.join(packDirectory, pack)),
        packedBytes,
      );
    } finally {
      await fs.rm(archive.dir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
