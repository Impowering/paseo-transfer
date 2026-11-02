import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTransferClient } from "../client/connected-transfer";
import type { HostRpc } from "../client/federation";
import {
  taskStart,
  taskStatus,
  uploadStart,
  uploadChunk,
  readChunk,
  releaseData,
  hostIdentity,
  CHUNK_BYTES,
} from "../shared/connected";
import {
  dispatch,
  snapshot,
  receive,
  claudeProjectDir,
  assertWorkspaceDirectory,
} from "../server/worker";
import { invoke, sshArgs, shellQuote } from "../server/transport";
import { sshHosts, tailscaleHosts } from "../server/discovery";
import { sshFixture } from "../scripts/ssh-fixture";
import { preview, start, status } from "../server/handlers";
import { createArchive, receiveArchive } from "../server/archive";
import { defaultLimits } from "../shared/limits";
const exec = promisify(execFile);
let root: string, sourceHome: string, targetHome: string, repo: string;
const daemons: ReturnType<typeof spawn>[] = [];
const clients = new Map<string, DaemonClient>();
const ids = new Map<string, string>();
const getRpc =
  (id: string): HostRpc =>
  async (contract, input) => {
    const client = clients.get(id);
    if (!client) throw new Error("Host disconnected");
    return contract.output.parse(
      await client.invokePluginRpc("transfer", contract.name, input),
    );
  };
const connected = createTransferClient(
  getRpc,
  () => new Promise((resolve) => setTimeout(resolve, 20)),
);
async function waitConnected(runId: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (connected.status(runId).state === "running" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return connected.status(runId);
}
async function cli(home: string, ...args: string[]) {
  return JSON.parse(
    (
      await exec("paseo", ["--home", home, "--json", ...args], {
        timeout: 120000,
      })
    ).stdout,
  );
}
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout;
}
before(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "transfer-test-"));
  sourceHome = path.join(root, "source-home");
  targetHome = path.join(root, "target-home");
  repo = path.join(root, "repo");
  for (const home of [sourceHome, targetHome]) {
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        pluginsEnabled: true,
        daemon: {
          listen: "127.0.0.1:0",
          relay: { enabled: false },
          mcp: { enabled: false },
          browserTools: { enabled: false },
        },
      }),
    );
    const child = spawn("paseo", ["daemon", "run", "--home", home], {
      env: { ...process.env, PASEO_HOME: home, PASEO_RELAY_ENABLED: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr?.on("data", (s) => (log += s));
    daemons.push(child);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await cli(home, "workspace", "ls");
        ready = true;
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(log);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(ready, "test daemon ready");
    await cli(home, "plugin", "install", process.cwd());
    const { listen } = await cli(home, "status");
    const client = new DaemonClient({
      url: `ws://${listen}/ws`,
      localCredential: () => credential,
      clientId: `transfer-test-${daemons.length}`,
      clientType: "cli",
      appVersion: "0.11.1",
      reconnect: { enabled: false },
    });
    const credential = (
      await fs.readFile(path.join(home, "local-credential"), "utf8")
    ).trim();
    await client.connect();
    const identity = hostIdentity.output.parse(
      await client.invokePluginRpc("transfer", hostIdentity.name, {}),
    );
    clients.set(identity.serverId, client);
    ids.set(home, identity.serverId);
  }
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "transfer@example.test");
  await git(repo, "config", "user.name", "Transfer Test");
  await fs.writeFile(path.join(repo, "tracked.txt"), "original\n");
  await fs.writeFile(path.join(repo, "deleted.txt"), "delete me\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "branch", "unpushed");
  await fs.writeFile(path.join(repo, "tracked.txt"), "staged\n");
  await git(repo, "add", "tracked.txt");
  await fs.writeFile(path.join(repo, "tracked.txt"), "unstaged\n");
  await git(repo, "rm", "deleted.txt");
  await fs.writeFile(path.join(repo, "untracked.txt"), "unsaved\n");
  await fs.writeFile(path.join(repo, ".env"), "private\n");
  await fs.writeFile(path.join(repo, "executable"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await fs.symlink("tracked.txt", path.join(repo, "link"));
});
after(async () => {
  for (const client of clients.values()) await client.close();
  for (const d of daemons) {
    d.kill("SIGTERM");
    await new Promise<void>((r) => {
      if (d.exitCode !== null) r();
      else {
        d.once("exit", () => r());
        setTimeout(() => {
          d.kill("SIGKILL");
          r();
        }, 3000);
      }
    });
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("home and system workspaces are rejected before protected folders can be scanned", async () => {
  await assert.rejects(
    assertWorkspaceDirectory(homedir()),
    /specific project folder/,
  );
  await assert.rejects(
    assertWorkspaceDirectory("/"),
    /specific project folder/,
  );
  const alias = path.join(root, "home-alias");
  await fs.symlink(homedir(), alias);
  await assert.rejects(
    assertWorkspaceDirectory(alias),
    /specific project folder/,
  );
  await assertWorkspaceDirectory(repo);
});

test("connected plugins copy and pull multiple chunks through real authenticated Paseo RPC", async () => {
  const dir = path.join(root, "connected-source");
  await fs.mkdir(dir);
  const data = Buffer.alloc(CHUNK_BYTES * 2 + 17, "x");
  await fs.writeFile(path.join(dir, "note"), data);
  const workspace = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    dir,
  );
  const sourceId = ids.get(sourceHome)!,
    targetId = ids.get(targetHome)!;
  const target = path.join(root, "connected-copy");
  const plan = await connected.preview({
    sourceId,
    targetId,
    workspaceId: workspace.workspaceId,
    destination: target,
    mode: "copy",
  });
  assert.ok(plan.connected.manifest.chunks >= 3);
  const result = await waitConnected(connected.start(plan).runId);
  assert.equal(result.state, "done", result.message);
  assert.equal(result.result?.verified, true);
  assert.deepEqual(await fs.readFile(path.join(target, "note")), data);
  const reverse = await connected.preview({
    sourceId: targetId,
    targetId: sourceId,
    workspaceId: result.result!.workspaceId,
    destination: path.join(root, "connected-pull"),
    mode: "move",
  });
  const moved = await waitConnected(connected.start(reverse).runId);
  assert.equal(moved.state, "done", moved.message);
  assert.equal(moved.result?.sourceArchived, true);
  assert.ok(
    !(await cli(targetHome, "workspace", "ls")).some(
      (w: any) => w.workspaceId === result.result!.workspaceId,
    ),
  );
});

test("connected previews preserve the source on edits and disconnected targets", async () => {
  const dir = path.join(root, "connected-stale");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "note"), "original");
  const workspace = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    dir,
  );
  const sourceId = ids.get(sourceHome)!,
    targetId = ids.get(targetHome)!;
  const destination = path.join(root, "connected-stale-target");
  const plan = await connected.preview({
    sourceId,
    targetId,
    workspaceId: workspace.workspaceId,
    destination,
    mode: "move",
  });
  await fs.writeFile(path.join(dir, "note"), "changed");
  const stale = await waitConnected(connected.start(plan).runId);
  assert.equal(stale.state, "failed");
  assert.match(stale.message, /changed since preview/);
  await assert.rejects(fs.access(destination));
  const next = await connected.preview({
    sourceId,
    targetId,
    workspaceId: workspace.workspaceId,
    destination,
    mode: "move",
  });
  const targetClient = clients.get(targetId)!;
  clients.delete(targetId);
  try {
    const offline = await waitConnected(connected.start(next).runId);
    assert.equal(offline.state, "failed");
    assert.match(offline.message, /disconnected/);
    assert.ok(
      (await cli(sourceHome, "workspace", "ls")).some(
        (w: any) => w.workspaceId === workspace.workspaceId,
      ),
    );
  } finally {
    clients.set(targetId, targetClient);
  }
});

test("connected RPC refuses wrong hosts, out-of-order chunks and corrupted uploads", async () => {
  const serverId = ids.get(targetHome)!,
    rpc = getRpc(serverId);
  await assert.rejects(
    rpc(taskStart, {
      serverId: ids.get(sourceHome)!,
      task: { action: "export", workspaceId: "missing", mode: "copy" },
    }),
    /host changed/,
  );
  const upload = await rpc(uploadStart, {
    serverId,
    wireBytes: 2,
    checksum: "a".repeat(64),
  });
  await assert.rejects(
    rpc(uploadChunk, { serverId, id: upload.id, index: 1, data: "e30=" }),
    /out of order/,
  );
  await assert.rejects(
    rpc(uploadChunk, { serverId, id: upload.id, index: 0, data: "eA==" }),
    /invalid size/,
  );
  await rpc(uploadChunk, { serverId, id: upload.id, index: 0, data: "e30=" });
  const receive = await rpc(taskStart, {
    serverId,
    task: {
      action: "receive",
      uploadId: upload.id,
      destination: path.join(root, "corrupt-upload"),
    },
  });
  let status;
  do {
    status = await rpc(taskStatus, { serverId, id: receive.id });
  } while (status.state === "running");
  assert.equal(status.state, "failed");
  assert.match(status.message, /checksum mismatch/);
  await assert.rejects(fs.access(path.join(root, "corrupt-upload")));
  await rpc(releaseData, { serverId, id: receive.id });
  await assert.rejects(
    rpc(readChunk, { serverId, id: upload.id, index: 0 }),
    /expired/,
  );
});

test("discovery respects SSH patterns and online Tailscale peers", () => {
  assert.deepEqual(
    sshHosts(
      "Host laptop work\n Host *.invalid !blocked\nHost final # note",
    ).map((h) => h.target),
    ["laptop", "work", "final"],
  );
  assert.equal(
    tailscaleHosts({
      Peer: {
        a: { DNSName: "laptop.tail.test.", HostName: "Laptop", Online: true },
        b: { DNSName: "offline.test", Online: false },
      },
    })[0].target,
    "laptop.tail.test",
  );
});
test("SSH argv blocks option injection and quotes shell values", () => {
  assert.throws(() => sshArgs({ target: "-oProxyCommand=bad" }));
  assert.throws(() => sshArgs({ target: "host; touch nope" }));
  assert.deepEqual(sshArgs({ target: "work" }).slice(-2), ["--", "work"]);
  assert.ok(shellQuote("a'b").includes("'\\''"));
  assert.ok(
    sshArgs({ target: "work", identityFile: "/tmp/key" }).includes(
      "IdentitiesOnly=yes",
    ),
  );
});
test("copies a repository with all branches, staged and unstaged changes, modes, symlinks and untracked files", async () => {
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    repo,
    "--title",
    "Transfer fixture",
  );
  const original = await git(repo, "status", "--porcelain");
  const snap = await snapshot(sourceHome, w.workspaceId);
  assert.equal(snap.sessions.length, 0);
  const target = path.join(root, "copied");
  const result = await receive(targetHome, target, snap);
  assert.equal(result.verified, true);
  assert.equal(result.sourceArchived, false);
  assert.equal(await git(target, "status", "--porcelain"), original);
  assert.equal(
    await git(target, "rev-parse", "unpushed"),
    await git(repo, "rev-parse", "unpushed"),
  );
  assert.equal(
    await fs.readFile(path.join(target, "tracked.txt"), "utf8"),
    "unstaged\n",
  );
  assert.equal(await fs.readlink(path.join(target, "link")), "tracked.txt");
  await assert.rejects(fs.access(path.join(target, ".env")));
  await assert.rejects(fs.access(path.join(target, "deleted.txt")));
  assert.equal(await git(repo, "status", "--porcelain"), original);
  await assert.rejects(receive(targetHome, target, snap), /already exists/);
  assert.equal(
    (await snapshot(sourceHome, w.workspaceId)).fingerprint,
    snap.fingerprint,
  );
});
test("worktree copy becomes an independent checkout without copying the source .git pointer", async () => {
  const worktree = path.join(root, "worktree");
  await git(repo, "worktree", "add", "-b", "feature", worktree, "HEAD");
  await fs.writeFile(path.join(worktree, "local.txt"), "worktree data");
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    worktree,
    "--title",
    "Worktree fixture",
  );
  const snap = await snapshot(sourceHome, w.workspaceId);
  const target = path.join(root, "copied-worktree");
  await receive(targetHome, target, snap);
  assert.ok((await fs.stat(path.join(target, ".git"))).isDirectory());
  assert.equal(await git(target, "branch", "--show-current"), "feature\n");
  assert.equal(
    await fs.readFile(path.join(target, "local.txt"), "utf8"),
    "worktree data",
  );
});
test("directory workspace copies plain files and skips dependency directories", async () => {
  const dir = path.join(root, "plain");
  await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(dir, "note"), "hello");
  await fs.writeFile(path.join(dir, "node_modules", "dep"), "skip");
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    dir,
  );
  const snap = await snapshot(sourceHome, w.workspaceId);
  assert.equal(snap.bundle, null);
  assert.equal(snap.files.length, 1);
  await receive(targetHome, path.join(root, "plain-copy"), snap);
});
test("source change invalidates a preview and move never archives it", async () => {
  const w = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === repo,
  );
  const p = await preview({
    source: { target: "", home: sourceHome },
    target: { target: "", home: targetHome },
    workspaceId: w.workspaceId,
    destination: path.join(root, "stale"),
    mode: "move",
  });
  await fs.writeFile(path.join(repo, "untracked.txt"), "changed after preview");
  const { runId } = start({ planId: p.id });
  while (status({ runId }).state === "running")
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(status({ runId }).state, "failed");
  assert.match(status({ runId }).message, /changed since preview/);
  assert.ok(
    (await cli(sourceHome, "workspace", "ls")).some(
      (x: any) => x.workspaceId === w.workspaceId,
    ),
  );
  await assert.rejects(fs.access(path.join(root, "stale")));
});
test("move verifies target and archives source through Paseo", async () => {
  const w = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === repo,
  );
  const p = await preview({
    source: { target: "", home: sourceHome },
    target: { target: "", home: targetHome },
    workspaceId: w.workspaceId,
    destination: path.join(root, "moved"),
    mode: "move",
  });
  const { runId } = start({ planId: p.id });
  while (status({ runId }).state === "running")
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(status({ runId }).state, "done", status({ runId }).message);
  assert.equal(status({ runId }).result?.sourceArchived, true);
  assert.ok(
    !(await cli(sourceHome, "workspace", "ls")).some(
      (x: any) => x.workspaceId === w.workspaceId,
    ),
  );
  assert.ok(await fs.stat(repo));
});
test("path traversal, symlink escape and altered snapshots are refused", async () => {
  const dir = path.join(root, "bad");
  await fs.mkdir(dir);
  await fs.symlink("/etc/passwd", path.join(dir, "escape"));
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    dir,
  );
  await assert.rejects(snapshot(sourceHome, w.workspaceId), /Symlink leaves/);
  const plain = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === path.join(root, "plain"),
  );
  const snap = await snapshot(sourceHome, plain.workspaceId);
  snap.files[0].path = "../escape";
  await assert.rejects(
    receive(targetHome, path.join(root, "tampered"), snap),
    /checksum/,
  );
  await assert.rejects(
    dispatch({
      action: "check",
      home: targetHome,
      destination: "relative",
      sessions: [],
    }),
    /absolute path/,
  );
});
test("moving a managed worktree with ignored files is refused before copy", async () => {
  const w = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "worktree",
    "--path",
    repo,
    "--new-branch",
    "managed-transfer",
    "--worktree-slug",
    "transfer-managed",
  );
  await fs.writeFile(path.join(w.cwd, ".env"), "keep local");
  await assert.rejects(
    preview({
      source: { target: "", home: sourceHome },
      target: { target: "", home: targetHome },
      workspaceId: w.workspaceId,
      destination: path.join(root, "ignored-move"),
      mode: "move",
    }),
    /Git-ignored/,
  );
  assert.equal(
    await fs.readFile(path.join(w.cwd, ".env"), "utf8"),
    "keep local",
  );
});

test("failed pre-registration writes roll back a reserved destination", async () => {
  const plain = (await cli(sourceHome, "workspace", "ls")).find(
    (w: any) => w.cwd === path.join(root, "plain"),
  );
  const snap = await snapshot(sourceHome, plain.workspaceId);
  snap.files[0].path = "../outside";
  const { fingerprint: old, bytes, ...base } = snap;
  snap.fingerprint = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex");
  const destination = path.join(root, "rollback");
  await assert.rejects(
    receive(targetHome, destination, snap),
    /Unsafe snapshot path/,
  );
  await assert.rejects(fs.access(destination));
  await assert.rejects(fs.access(path.join(root, "outside")));
});

test("Claude long directory names use the provider encoder", () => {
  assert.equal(claudeProjectDir("/tmp/a.b"), "-tmp-a-b");
  assert.ok(claudeProjectDir("/tmp/" + "long".repeat(100)).length > 200);
});

test("encrypted SSH transports push and pull between separate daemon homes", async () => {
  const fixture = await sshFixture(root, { ...process.env });
  const remote = {
    target: "127.0.0.1",
    port: fixture.port,
    identityFile: fixture.key,
    knownHostsFile: fixture.known,
    home: targetHome,
  };
  try {
    const info = await invoke<{ version: string }>(remote, { action: "info" });
    assert.equal(
      info.version,
      (await exec("paseo", ["--version"])).stdout.trim(),
    );
    const sshSource = path.join(root, "ssh-source");
    await fs.mkdir(sshSource);
    await fs.writeFile(path.join(sshSource, "note"), "hello");
    const plain = await cli(
      sourceHome,
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      sshSource,
    );
    const snap = await snapshot(sourceHome, plain.workspaceId);
    const target = path.join(root, "ssh-push");
    const pushed = await invoke<{ verified: boolean }>(remote, {
      action: "receive",
      destination: target,
      snapshot: snap,
    });
    assert.equal(pushed.verified, true);
    const remoteWorkspaces = await invoke<{ workspaces: any[] }>(remote, {
      action: "list",
    });
    const row = remoteWorkspaces.workspaces.find((w) => w.cwd === target);
    const pulled = await invoke<any>(remote, {
      action: "snapshot",
      workspaceId: row.workspaceId,
    });
    const result = await receive(
      sourceHome,
      path.join(root, "ssh-pull"),
      pulled,
    );
    assert.equal(result.verified, true);
    assert.equal(
      await fs.readFile(path.join(root, "ssh-pull", "note"), "utf8"),
      "hello",
    );
  } finally {
    await fixture.close();
  }
});

test("connected archive transfers over 20,000 files and 256 MiB wire with full Git and index verification", async () => {
  const source = path.join(root, "large-monorepo");
  await fs.mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.email", "transfer@example.test");
  await git(source, "config", "user.name", "Transfer Test");
  const count = 20_005;
  for (let start = 0; start < count; start += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, count - start) }, (_, offset) =>
        fs.writeFile(
          path.join(source, `file-${start + offset}.txt`),
          `content ${start + offset}\n`,
        ),
      ),
    );
  const large = await fs.open(path.join(source, "large.bin"), "wx");
  try {
    for (let index = 0; index < 129; index++) {
      const data = randomBytes(1024 * 1024);
      let offset = 0;
      while (offset < data.length)
        offset += (await large.write(data, offset)).bytesWritten;
    }
  } finally {
    await large.close();
  }
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "large monorepo fixture");
  await git(source, "branch", "unpublished");
  await fs.writeFile(path.join(source, "file-0.txt"), "staged\n");
  await git(source, "add", "file-0.txt");
  await fs.writeFile(path.join(source, "file-0.txt"), "unstaged\n");
  const workspace = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    source,
  );
  const target = path.join(root, "large-monorepo-copy");
  const plan = await connected.preview({
    sourceId: ids.get(sourceHome)!,
    targetId: ids.get(targetHome)!,
    workspaceId: workspace.workspaceId,
    destination: target,
    mode: "copy",
  });
  assert.ok(plan.files > 20_000);
  assert.ok(plan.connected.manifest.wireBytes > 256 * 1024 * 1024);
  const copied = await waitConnected(connected.start(plan).runId, 300_000);
  assert.equal(copied.state, "done", copied.message);
  assert.equal(copied.result?.verified, true);
  assert.equal(copied.result?.sourceArchived, false);
  assert.equal(
    await git(target, "rev-parse", "HEAD"),
    await git(source, "rev-parse", "HEAD"),
  );
  assert.equal(
    await git(target, "rev-parse", "unpublished"),
    await git(source, "rev-parse", "unpublished"),
  );
  assert.equal(
    await git(target, "diff", "--cached", "--binary", "HEAD"),
    await git(source, "diff", "--cached", "--binary", "HEAD"),
  );
  assert.equal(
    await git(target, "status", "--porcelain"),
    await git(source, "status", "--porcelain"),
  );
  assert.deepEqual(
    await fs.readFile(path.join(target, "file-20004.txt")),
    await fs.readFile(path.join(source, "file-20004.txt")),
  );
  assert.equal(
    (await fs.stat(path.join(target, "large.bin"))).size,
    129 * 1024 * 1024,
  );
});

test("archive receive rejects malformed data without retaining a destination or private spool", async () => {
  const source = path.join(root, "malformed-source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "file"), "original");
  const workspace = await cli(
    sourceHome,
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    source,
  );
  const exported = await createArchive(sourceHome, workspace.workspaceId);
  try {
    const before = (await fs.readdir(tmpdir()))
      .filter((name) => name.startsWith("paseo-transfer-receive-"))
      .sort();
    const corrupt = path.join(root, "malformed-archive.bin");
    const bytes = await fs.readFile(exported.file);
    await fs.writeFile(corrupt, bytes.subarray(0, bytes.length - 9));
    const target = path.join(root, "malformed-copy");
    await assert.rejects(
      receiveArchive(targetHome, target, corrupt),
      /Truncated/,
    );
    await assert.rejects(fs.access(target));
    assert.deepEqual(
      (await fs.readdir(tmpdir()))
        .filter((name) => name.startsWith("paseo-transfer-receive-"))
        .sort(),
      before,
    );
    assert.equal(
      await fs.readFile(path.join(source, "file"), "utf8"),
      "original",
    );
    await assert.rejects(
      createArchive(sourceHome, workspace.workspaceId, {
        ...defaultLimits,
        maxBytes: 1,
      }),
      /configured transfer limit/,
    );
  } finally {
    await fs.rm(exported.dir, { recursive: true, force: true });
  }
});

test("standalone SSH workers return a large archive handle, verify receive and preserve a changed source", async () => {
  const fixtureDir = path.join(root, "standalone-ssh");
  await fs.mkdir(fixtureDir);
  const fixture = await sshFixture(fixtureDir, { ...process.env });
  const endpoint = {
    target: "127.0.0.1",
    port: fixture.port,
    identityFile: fixture.key,
    knownHostsFile: fixture.known,
    home: sourceHome,
  };
  const source = path.join(root, "large-monorepo");
  const workspace = (await cli(sourceHome, "workspace", "ls")).find(
    (entry: any) => entry.cwd === source,
  );
  let exported: any;
  try {
    exported = await invoke<any>(endpoint, {
      action: "archive-export",
      workspaceId: workspace.workspaceId,
    });
    assert.ok(exported.wireBytes > 256 * 1024 * 1024);
    assert.ok(
      JSON.stringify(exported).length < 10_000,
      "the worker response contains metadata, never the payload",
    );
    const upload = path.join(root, "standalone-upload.bin");
    await fs.copyFile(exported.file, upload);
    const target = path.join(root, "standalone-copy");
    const targetEndpoint = { ...endpoint, home: targetHome };
    await assert.rejects(
      invoke(targetEndpoint, {
        action: "archive-receive",
        file: upload,
        checksum: "0".repeat(64),
        destination: target,
      }),
      /checksum mismatch/,
    );
    await assert.rejects(fs.access(target));
    const result = await invoke<any>(targetEndpoint, {
      action: "archive-receive",
      file: upload,
      checksum: exported.checksum,
      destination: target,
    });
    assert.equal(result.verified, true);
    assert.equal(result.sourceArchived, false);
    assert.equal(
      await git(target, "rev-parse", "HEAD"),
      await git(source, "rev-parse", "HEAD"),
    );
    assert.equal(
      await git(target, "status", "--porcelain"),
      await git(source, "status", "--porcelain"),
    );
    await fs.appendFile(path.join(source, "file-0.txt"), "new source edit\n");
    await assert.rejects(
      invoke(endpoint, {
        action: "archive-source",
        workspaceId: workspace.workspaceId,
        fingerprint: exported.fingerprint,
      }),
      /Source changed/,
    );
    assert.ok(
      (await cli(sourceHome, "workspace", "ls")).some(
        (entry: any) => entry.workspaceId === workspace.workspaceId,
      ),
    );
    await assert.rejects(
      invoke(endpoint, {
        action: "archive-release",
        file: path.join(root, "outside", "archive.bin"),
      }),
      /private export archive/,
    );
  } finally {
    if (exported) {
      await invoke(endpoint, {
        action: "archive-release",
        file: exported.file,
      });
      await assert.rejects(fs.access(exported.file));
    }
    await fixture.close();
  }
});
