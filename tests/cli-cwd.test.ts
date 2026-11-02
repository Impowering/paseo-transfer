import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { normalizeCliCwd } from "../server/cli-cwd";
const require = createRequire(import.meta.url);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "transfer-cli-cwd-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function modules(
  root: string,
  cliPath = "/never-invoke-this-fixture-cli",
) {
  const output = await build({
    stdin: {
      contents:
        'export {assertIdleCheckout} from "./server/archive"; export {list,snapshot} from "./server/worker";',
      resolveDir: process.cwd(),
      sourcefile: "cwd-fixture.ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "host-local-cli-fixture",
        setup(build) {
          build.onResolve({ filter: /^node:os$/ }, () => ({
            path: "fixture:os",
            external: true,
          }));
          build.onResolve({ filter: /^\.\/paseo-cli$/ }, () => ({
            path: "fixture:cli",
            external: true,
          }));
        },
      },
    ],
  });
  const module = {
    exports: {} as {
      assertIdleCheckout: typeof import("../server/archive").assertIdleCheckout;
      list: typeof import("../server/worker").list;
      snapshot: typeof import("../server/worker").snapshot;
    },
  };
  new Function("require", "module", "exports", output.outputFiles[0].text)(
    (id: string) =>
      id === "fixture:os"
        ? { ...require("node:os"), homedir: () => root }
        : id === "fixture:cli"
          ? { resolvePaseoCli: async () => cliPath }
          : require(id),
    module,
    module.exports,
  );
  return module.exports;
}
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
async function cli(root: string, cwd: unknown) {
  const file = path.join(root, "fixture-cli");
  const row = {
    workspaceId: "native-workspace",
    name: "fixture",
    cwd,
    isolation: "local",
    project: "native-project",
  };
  await fs.writeFile(
    file,
    `#!/bin/sh
case "$*" in
  --version) printf '0.13.0-beta.11\\n' ;;
  *"workspace ls"*) printf '%s\\n' ${quote(JSON.stringify([row]))} ;;
  *) printf '[]\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  return file;
}

test("own-home CLI cwd expands without guessing users or collapsing filesystem suffixes", () => {
  const home = path.join(tmpdir(), "fixture-home");
  assert.equal(normalizeCliCwd("~", home), home);
  assert.equal(
    normalizeCliCwd("~/.paseo/worktrees/source", home),
    home + "/.paseo/worktrees/source",
  );
  assert.equal(
    normalizeCliCwd("~/link/../source", home),
    home + "/link/../source",
  );
  const absolute = home + "/absolute path/link/../source";
  assert.equal(normalizeCliCwd(absolute, home), absolute);
  for (const value of [
    undefined,
    null,
    1,
    {},
    "",
    ".",
    "../source",
    "relative/source",
    "~other/source",
    "~other",
    "~/bad\0cwd",
  ])
    assert.throws(() => normalizeCliCwd(value, home), /Unverified CLI cwd/);
  assert.throws(
    () => normalizeCliCwd("~/source", "relative-home"),
    /not absolute/,
  );
});

test("compact running and initializing sibling cwd are allowed while all overlaps hold", async () =>
  fixture(async (root) => {
    const source = path.join(root, ".paseo", "worktrees", "source");
    const sibling = path.join(root, ".paseo", "worktrees", "sibling");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await fs.symlink(source, path.join(root, "alias"));
    const { assertIdleCheckout } = await modules(root);
    for (const status of ["running", "initializing"]) {
      await assertIdleCheckout(undefined, source, async () => [
        { status, cwd: "~/.paseo/worktrees/sibling" },
      ]);
      await assertIdleCheckout(
        undefined,
        "~/.paseo/worktrees/source",
        async () => [{ status, cwd: sibling }],
      );
      for (const cwd of [
        "~/.paseo/worktrees/source",
        "~/.paseo/worktrees/source/nested",
        "~/.paseo/worktrees",
        "~",
        "~/alias",
      ])
        await assert.rejects(
          assertIdleCheckout(undefined, source, async () => [{ status, cwd }]),
          /sharing this checkout/,
        );
    }
  }));

test("compact paths retain realpath symlink-parent identity for overlap checks", async () =>
  fixture(async (root) => {
    await fs.mkdir(path.join(root, "source"));
    const actual = path.join(root, "other", "source");
    await fs.mkdir(actual, { recursive: true });
    await fs.mkdir(path.join(root, "other", "nested"));
    await fs.symlink(
      path.join(root, "other", "nested"),
      path.join(root, "link"),
    );
    const { assertIdleCheckout } = await modules(root);
    await assert.rejects(
      assertIdleCheckout(undefined, actual, async () => [
        { status: "running", cwd: "~/link/../source" },
      ]),
      /sharing this checkout/,
    );
  }));

test("unknown, missing and invalid running cwd still hold rather than being skipped", async () =>
  fixture(async (root) => {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(root, "file"), "not a directory");
    const { assertIdleCheckout } = await modules(root);
    for (const status of ["running", "initializing"])
      for (const cwd of [
        undefined,
        null,
        "",
        "relative/source",
        "~other/source",
        "~/deleted",
        path.join(root, "missing"),
        "~/file",
        "~/bad\0cwd",
      ])
        await assert.rejects(
          assertIdleCheckout(undefined, source, async () => [
            { status, cwd: cwd as string },
          ]),
        );
  }));

test("legacy workspace list and snapshot normalize compact cwd without changing native IDs", async () =>
  fixture(async (root) => {
    const source = path.join(root, ".paseo", "worktrees", "source");
    const home = path.join(root, "fixture-daemon");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(path.join(source, "note"), "saved work");
    await fs.writeFile(path.join(home, "server-id"), "native-server");
    const worker = await modules(
      root,
      await cli(root, "~/.paseo/worktrees/source"),
    );
    const rows = await worker.list(home);
    assert.equal(rows[0].cwd, source);
    assert.equal(rows[0].workspaceId, "native-workspace");
    assert.equal(rows[0].project, "native-project");
    const snapshot = await worker.snapshot(home, "native-workspace");
    assert.equal(snapshot.workspace.cwd, source);
    assert.equal(snapshot.workspace.workspaceId, "native-workspace");
    assert.equal(snapshot.sourceId, "native-server");
    assert.equal(
      Buffer.from(snapshot.files[0].data, "base64").toString(),
      "saved work",
    );
  }));

test("workspace inventory refuses unsupported cwd formats without inventing process-relative locations", async () =>
  fixture(async (root) => {
    for (const value of ["relative/source", "~other/source", null, ""]) {
      const worker = await modules(root, await cli(root, value));
      await assert.rejects(
        worker.list(path.join(root, "fixture-daemon")),
        /Unverified CLI cwd/,
      );
    }
  }));
