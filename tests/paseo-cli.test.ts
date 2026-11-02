import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePaseoCli } from "../server/paseo-cli";
import { workerSource } from "../shared/worker-source";

async function fixture(
  run: (context: {
    root: string;
    env: NodeJS.ProcessEnv;
    platform: "darwin";
    cwd: string;
    execPath: string;
    resourcesPath: string;
    home: string;
    applicationsDirectory: string;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "transfer-cli-"));
  const context = {
    root,
    env: { PATH: path.join(root, "empty-bin") },
    platform: "darwin" as const,
    cwd: root,
    execPath: path.join(root, "node"),
    resourcesPath: "",
    home: path.join(root, "home"),
    applicationsDirectory: path.join(root, "Applications"),
  };
  try {
    await run(context);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function script(
  file: string,
  mode = 0o755,
  failure?: "version" | "workspace",
) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  ${failure === "version" ? "printf 'selected version failure\\n' >&2; exit 71" : "printf '0.14.0\\n'"}
else
  ${failure === "workspace" ? "printf 'selected workspace failure\\n' >&2; exit 72" : "printf '[]\\n'"}
fi
`,
    { mode },
  );
  return file;
}
const bundled = (app: string) =>
  path.join(app, "Contents", "Resources", "bin", "paseo");

test("explicit CLI override is returned unchanged without discovery", async () =>
  fixture(async (context) => {
    await script(
      bundled(path.join(context.applicationsDirectory, "Paseo.app")),
    );
    for (const override of [
      "/missing/custom CLI",
      "~/custom/paseo",
      "relative-cli",
      "paseo --flag",
      "",
    ])
      assert.equal(
        await resolvePaseoCli({
          ...context,
          env: { ...context.env, PASEO_SYNC_CLI: override },
        }),
        override,
      );
  }));

test("PATH order takes precedence over app bundles and preserves the environment", async () =>
  fixture(async (context) => {
    const first = await script(path.join(context.root, "first bin", "paseo"));
    const second = await script(path.join(context.root, "second", "paseo"));
    await script(
      bundled(path.join(context.applicationsDirectory, "Paseo.app")),
    );
    const env = {
      PATH: [path.dirname(first), path.dirname(second)].join(path.delimiter),
    };
    const before = { ...env };
    assert.equal(await resolvePaseoCli({ ...context, env }), first);
    assert.deepEqual(env, before);
  }));

test("POSIX PATH handles empty and relative entries and skips non-executable files", async () =>
  fixture(async (context) => {
    const cwdCli = await script(path.join(context.cwd, "paseo"));
    assert.equal(
      await resolvePaseoCli({ ...context, env: { PATH: "" } }),
      cwdCli,
    );
    const relative = await script(path.join(context.cwd, "relative", "paseo"));
    assert.equal(
      await resolvePaseoCli({ ...context, env: { PATH: "relative" } }),
      relative,
    );
    const unavailable = await script(
      path.join(context.cwd, "blocked", "paseo"),
      0o644,
    );
    assert.equal(
      await resolvePaseoCli({
        ...context,
        env: {
          PATH: [path.dirname(unavailable), path.dirname(relative)].join(
            path.delimiter,
          ),
        },
      }),
      relative,
    );
  }));

test("GUI daemon uses current resources before other app locations", async () =>
  fixture(async (context) => {
    const resourcesPath = path.join(
      context.root,
      "current app",
      "Contents",
      "Resources",
    );
    const cli = await script(path.join(resourcesPath, "bin", "paseo"));
    await script(
      bundled(path.join(context.applicationsDirectory, "Paseo.app")),
    );
    assert.equal(await resolvePaseoCli({ ...context, resourcesPath }), cli);
  }));

test("nested Helper executable discovers its enclosing main app", async () =>
  fixture(async (context) => {
    const app = path.join(context.root, "Paseo Beta.app");
    const execPath = path.join(
      app,
      "Contents",
      "Frameworks",
      "Paseo Helper.app",
      "Contents",
      "MacOS",
      "Paseo Helper",
    );
    const cli = await script(bundled(app));
    assert.equal(await resolvePaseoCli({ ...context, execPath }), cli);
  }));

test("standard system and user app roots are bounded fallbacks", async () =>
  fixture(async (context) => {
    const user = await script(
      bundled(path.join(context.home, "Applications", "Paseo.app")),
    );
    assert.equal(await resolvePaseoCli(context), user);
    const system = await script(
      bundled(path.join(context.applicationsDirectory, "Paseo.app")),
    );
    assert.equal(await resolvePaseoCli(context), system);
  }));

test("missing, directory, dangling and unexecutable candidates are refused", async () =>
  fixture(async (context) => {
    const resourcesPath = path.join(context.root, "missing-resources");
    await fs.mkdir(path.join(resourcesPath, "bin", "paseo"), {
      recursive: true,
    });
    const system = await script(
      bundled(path.join(context.applicationsDirectory, "Paseo.app")),
      0o644,
    );
    const user = bundled(path.join(context.home, "Applications", "Paseo.app"));
    await fs.mkdir(path.dirname(user), { recursive: true });
    await fs.symlink(path.join(context.root, "missing-cli"), user);
    await assert.rejects(
      resolvePaseoCli({ ...context, resourcesPath }),
      /Cannot find an executable Paseo CLI.*PATH.*app bundles/,
    );
    assert.equal((await fs.stat(system)).mode & 0o777, 0o644);
  }));

test("Linux and WSL use only POSIX PATH and never discover macOS bundles", async () =>
  fixture(async (context) => {
    const appCli = await script(
      bundled(path.join(context.applicationsDirectory, "Paseo.app")),
    );
    await assert.rejects(
      resolvePaseoCli({
        ...context,
        platform: "linux",
        resourcesPath: path.dirname(path.dirname(appCli)),
      }),
      /Cannot find an executable Paseo CLI on PATH/,
    );
    const pathCli = await script(path.join(context.root, "linux-bin", "paseo"));
    assert.equal(
      await resolvePaseoCli({
        ...context,
        platform: "linux",
        env: { PATH: path.dirname(pathCli) },
      }),
      pathCli,
    );
  }));

// Exercise the committed worker, including both version() and cli(), in an isolated GUI-like process.
const BOOTSTRAP = `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',async()=>{try{const p=JSON.parse(data);Object.defineProperty(process,'platform',{value:'darwin'});Object.defineProperty(process,'resourcesPath',{value:p.resourcesPath});const m={exports:{}};new Function('require','module','exports',p.source)(require,m,m.exports);process.stdout.write(JSON.stringify(await m.exports.dispatch({action:'list',home:p.home})));}catch(e){process.stderr.write(e.message);process.exitCode=1;}});`;
async function worker(
  context: { env: NodeJS.ProcessEnv; home: string },
  resourcesPath: string,
) {
  return new Promise<string>((resolve, reject) => {
    const env = { ...process.env, ...context.env };
    delete env.PASEO_SYNC_CLI;
    if (context.env.PASEO_SYNC_CLI !== undefined)
      env.PASEO_SYNC_CLI = context.env.PASEO_SYNC_CLI;
    const child = execFile(
      process.execPath,
      ["-e", BOOTSTRAP],
      { env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      },
    );
    child.stdin!.end(
      JSON.stringify({
        resourcesPath,
        home: context.home,
        source: workerSource,
      }),
    );
  });
}
test(
  "generated GUI worker finds bundled CLI for version and workspace calls",
  { skip: process.platform === "win32" },
  async () =>
    fixture(async (context) => {
      const resourcesPath = path.join(
        context.root,
        "GUI app",
        "Contents",
        "Resources",
      );
      await script(path.join(resourcesPath, "bin", "paseo"));
      assert.deepEqual(JSON.parse(await worker(context, resourcesPath)), {
        workspaces: [],
      });
    }),
);

test(
  "selected CLI execution failures never switch to a healthy bundled installation",
  { skip: process.platform === "win32" },
  async () =>
    fixture(async (context) => {
      const resourcesPath = path.join(
        context.root,
        "GUI app",
        "Contents",
        "Resources",
      );
      await script(path.join(resourcesPath, "bin", "paseo"));
      const failedVersion = await script(
        path.join(context.root, "preferred", "paseo"),
        0o755,
        "version",
      );
      await assert.rejects(
        worker(
          { ...context, env: { PATH: path.dirname(failedVersion) } },
          resourcesPath,
        ),
        /selected version failure/,
      );
      const failedWorkspace = await script(
        path.join(context.root, "explicit-cli"),
        0o755,
        "workspace",
      );
      await assert.rejects(
        worker(
          {
            ...context,
            env: { ...context.env, PASEO_SYNC_CLI: failedWorkspace },
          },
          resourcesPath,
        ),
        /selected workspace failure/,
      );
      await assert.rejects(
        worker(
          {
            ...context,
            env: {
              ...context.env,
              PASEO_SYNC_CLI: path.join(context.root, "missing-override"),
            },
          },
          resourcesPath,
        ),
        /ENOENT/,
      );
    }),
);
