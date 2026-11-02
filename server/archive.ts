import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session, Workspace, TransferResult } from "../shared/types";
import {
  defaultLimits,
  enforceLimit,
  type TransferLimits,
} from "../shared/limits";
import {
  assertWorkspaceDirectory,
  check,
  claudeHome,
  claudeProjectDir,
  cli,
  codexHome,
  command,
  commandEnvironment,
  exists,
  filesBelow,
  inside,
  list,
  paseoHome,
  safeRelative,
  sessionRoot,
} from "./worker";
import {
  archiveWriter,
  hashFile,
  unpackArchive,
  type BlobRef,
} from "./archive-format";

interface ArchiveFile {
  path: string;
  mode: number;
  link?: string;
  blob?: BlobRef;
}
interface ArchiveSession extends Omit<Session, "files"> {
  files: ArchiveFile[];
}
interface Manifest {
  version: 2;
  sourceId: string;
  workspace: Workspace;
  head: string | null;
  branch: string | null;
  bundle: BlobRef | null;
  indexPatch: BlobRef | null;
  files: ArchiveFile[];
  deleted: string[];
  sessions: ArchiveSession[];
  hasIgnored: boolean;
}

export async function privateDirectory(prefix: string) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  await fs.chmod(dir, 0o700);
  return dir;
}
async function outputFile(
  bin: string,
  args: string[],
  cwd: string,
  file: string,
  limits: TransferLimits,
) {
  const child = spawn(bin, args, {
    cwd,
    env: commandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    if (stderr.length < 65536) stderr += String(data);
  });
  const timer = setTimeout(
    () => child.kill("SIGTERM"),
    limits.commandTimeoutSeconds * 1000,
  );
  try {
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(stderr || `${bin} failed (${code})`)),
      );
    });
    await Promise.all([
      pipeline(
        child.stdout,
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      ),
      done,
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

/** Native workspace IDs can share a checkout; check every live agent's actual cwd. */
export async function assertIdleCheckout(
  home: string | undefined,
  cwd: string,
  readAgents = async (): Promise<Array<{ status: string; cwd?: string }>> =>
    cli(home, "ls", "-g", "-a"),
) {
  const canonical = await fs.realpath(cwd);
  const agents = await readAgents();
  for (const agent of agents) {
    if (!["running", "initializing"].includes(agent.status)) continue;
    if (!agent.cwd)
      throw new Error(
        "A running agent has no verified checkout; transfer held.",
      );
    if ((await fs.realpath(agent.cwd)) === canonical)
      throw new Error(
        "Stop every running agent sharing this checkout before transferring it.",
      );
  }
}

async function sessionSources(
  home: string | undefined,
  workspace: Workspace,
  limits: TransferLimits,
) {
  const records = await filesBelow(
    path.join(paseoHome(home), "agents"),
    (name) => !name.startsWith("."),
    limits.maxFiles,
  );
  const result: Array<{
    session: Omit<Session, "files">;
    root: string;
    names: string[];
  }> = [];
  const seen = new Set<string>();
  for (const file of records.filter((name) => name.endsWith(".json"))) {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (record.workspaceId !== workspace.workspaceId) continue;
    const id = record.persistence?.sessionId,
      provider = record.provider;
    if (!id || !["claude", "codex"].includes(provider))
      throw new Error(
        `Transfer cannot include every conversation: ${record.title ?? record.id}`,
      );
    if (!/^[a-f0-9-]{36}$/i.test(id))
      throw new Error("Invalid provider session ID.");
    if (seen.has(id)) continue;
    seen.add(id);
    const root =
      provider === "claude"
        ? path.join(claudeHome(), "projects", claudeProjectDir(workspace.cwd))
        : codexHome();
    const names =
      provider === "claude"
        ? [
            `${id}.jsonl`,
            ...(
              await filesBelow(path.join(root, id), undefined, limits.maxFiles)
            ).map((file) => path.relative(root, file)),
          ]
        : [
            ...(await filesBelow(
              path.join(root, "sessions"),
              undefined,
              limits.maxFiles,
            )),
            ...(await filesBelow(
              path.join(root, "archived_sessions"),
              undefined,
              limits.maxFiles,
            )),
          ]
            .filter((file) => path.basename(file).endsWith(`-${id}.jsonl`))
            .map((file) => path.relative(root, file));
    if (!names.length || !(await exists(path.join(root, names[0]))))
      throw new Error(
        `Cannot find ${provider} transcript for ${record.title ?? id}`,
      );
    result.push({
      session: {
        id,
        provider,
        title: record.title ?? "",
        labels: record.labels ?? {},
        archived: !!record.archivedAt,
      },
      root,
      names,
    });
  }
  return result;
}

export async function createArchive(
  home: string | undefined,
  workspaceId: string,
  limits = defaultLimits,
) {
  const workspace = (await list(home)).find(
    (entry) => entry.workspaceId === workspaceId,
  );
  if (!workspace)
    throw new Error(
      "Workspace is missing or archived. Refresh the workspace list.",
    );
  const cwd = workspace.cwd;
  await assertWorkspaceDirectory(cwd);
  await assertIdleCheckout(home, cwd);
  if ((await fs.lstat(cwd)).isSymbolicLink())
    throw new Error("Workspace root must not be a symlink.");
  const dir = await privateDirectory("paseo-transfer-export-");
  const file = path.join(dir, "archive.bin");
  const writer = await archiveWriter(file, limits).catch(async (error) => {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  });
  let count = 0;
  async function entry(root: string, relative: string): Promise<ArchiveFile> {
    enforceLimit(++count, limits.maxFiles, "File count");
    safeRelative(relative);
    const full = path.join(root, relative);
    if (!inside(await fs.realpath(root), await fs.realpath(path.dirname(full))))
      throw new Error(`File leaves the workspace: ${relative}`);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(full);
      if (
        path.isAbsolute(link) ||
        !inside(root, path.resolve(path.dirname(full), link))
      )
        throw new Error(`Symlink leaves the workspace: ${relative}`);
      return { path: relative, mode: stat.mode & 0o777, link };
    }
    if (!stat.isFile()) throw new Error(`Unsupported file: ${relative}`);
    return {
      path: relative,
      mode: stat.mode & 0o777,
      blob: await writer.add(full),
    };
  }
  try {
    const manifest: Manifest = {
      version: 2,
      sourceId: (
        await fs.readFile(path.join(paseoHome(home), "server-id"), "utf8")
      ).trim(),
      workspace,
      head: null,
      branch: null,
      bundle: null,
      indexPatch: null,
      files: [],
      deleted: [],
      sessions: [],
      hasIgnored: false,
    };
    let gitRoot: string | null = null;
    try {
      gitRoot = (
        await command("git", ["rev-parse", "--show-toplevel"], cwd)
      ).trim();
    } catch {
      /* directory workspace */
    }
    let names: string[];
    if (gitRoot) {
      if ((await fs.realpath(gitRoot)) !== (await fs.realpath(cwd)))
        throw new Error(
          "Select the repository root workspace; transferring a Git subdirectory is not supported.",
        );
      if (await exists(path.join(cwd, ".gitmodules")))
        throw new Error("Submodule workspaces are not supported yet.");
      if ((await command("git", ["ls-files", "-u"], cwd)).trim())
        throw new Error(
          "Resolve Git conflicts before transferring this workspace.",
        );
      manifest.hasIgnored = !!(await command(
        "git",
        [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "-z",
        ],
        cwd,
      ));
      manifest.head = (await command("git", ["rev-parse", "HEAD"], cwd)).trim();
      try {
        manifest.branch = (
          await command("git", ["symbolic-ref", "--short", "HEAD"], cwd)
        ).trim();
      } catch {
        /* detached HEAD */
      }
      const bundle = path.join(dir, "repo.bundle"),
        patch = path.join(dir, "index.patch");
      await outputFile(
        "git",
        ["bundle", "create", bundle, "--all", "HEAD"],
        cwd,
        path.join(dir, "bundle.log"),
        limits,
      );
      manifest.bundle = await writer.add(bundle);
      await fs.rm(bundle);
      await outputFile(
        "git",
        ["diff", "--cached", "--binary", "HEAD"],
        cwd,
        patch,
        limits,
      );
      manifest.indexPatch = await writer.add(patch);
      await fs.rm(patch);
      names = [
        ...new Set(
          (
            await command(
              "git",
              ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
              cwd,
            )
          )
            .split("\0")
            .filter(Boolean),
        ),
      ].sort();
    } else
      names = (
        await filesBelow(
          cwd,
          (name) =>
            ![".git", "node_modules", ".venv", "__pycache__"].includes(name),
          limits.maxFiles,
        )
      ).map((name) => path.relative(cwd, name));
    enforceLimit(names.length, limits.maxFiles, "File count");
    for (const name of names) {
      if (!(await exists(path.join(cwd, name)))) manifest.deleted.push(name);
      else manifest.files.push(await entry(cwd, name));
    }
    for (const source of await sessionSources(home, workspace, limits)) {
      const files = [];
      for (const name of source.names)
        files.push(await entry(source.root, name));
      manifest.sessions.push({ ...source.session, files });
    }
    await assertIdleCheckout(home, cwd);
    const result = await writer.finish(manifest);
    return { dir, file, manifest, ...result };
  } catch (error) {
    await writer.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function summarySessions(sessions: ArchiveSession[]): Session[] {
  return sessions.map((session) => ({
    ...session,
    files: session.files.map((file) => ({ ...file, data: "" })),
  }));
}
export const archiveSessions = summarySessions;

function validateManifest(manifest: Manifest) {
  if (
    !manifest ||
    manifest.version !== 2 ||
    typeof manifest.sourceId !== "string" ||
    !manifest.workspace ||
    typeof manifest.workspace.name !== "string" ||
    typeof manifest.workspace.cwd !== "string" ||
    !path.isAbsolute(manifest.workspace.cwd) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.sessions) ||
    !Array.isArray(manifest.deleted)
  )
    throw new Error("Invalid transfer manifest.");
  if (
    manifest.bundle
      ? !/^[a-f0-9]{40,64}$/.test(manifest.head ?? "") ||
        (manifest.branch !== null && typeof manifest.branch !== "string")
      : manifest.head !== null ||
        manifest.branch !== null ||
        manifest.indexPatch !== null
  )
    throw new Error("Invalid archive Git metadata.");
  const ids = new Set<string>();
  for (const session of manifest.sessions) {
    if (
      !session ||
      !/^[a-f0-9-]{36}$/i.test(session.id) ||
      ids.has(session.id) ||
      !["claude", "codex"].includes(session.provider) ||
      typeof session.title !== "string" ||
      typeof session.archived !== "boolean" ||
      !session.labels ||
      Array.isArray(session.labels) ||
      Object.values(session.labels).some(
        (value) => typeof value !== "string",
      ) ||
      !Array.isArray(session.files)
    )
      throw new Error("Invalid archive provider session.");
    ids.add(session.id);
  }
  for (const name of manifest.deleted) safeRelative(name);
}

/** Rewrite structural cwd fields one JSONL row at a time; preserve conversation prose. */
async function transcript(
  source: string,
  destination: string,
  before: string,
  after: string,
  created: () => void,
) {
  const output = await fs.open(destination, "wx", 0o600);
  created();
  const expected = createHash("sha256");
  let pending = Buffer.alloc(0);
  const maxRowBytes = 16 * 1024 * 1024;
  async function row(line: Buffer, ending: string) {
    if (line.length > maxRowBytes)
      throw new Error(
        "Provider transcript row exceeds the bounded JSON row size.",
      );
    const text = line.toString();
    const value = text.trim() ? JSON.parse(text) : null;
    function walk(node: any) {
      if (!node || typeof node !== "object") return;
      for (const [key, content] of Object.entries(node)) {
        if (
          key === "cwd" &&
          typeof content === "string" &&
          (content === before || content.startsWith(before + "/"))
        )
          node[key] = after + content.slice(before.length);
        else walk(content);
      }
    }
    walk(value);
    const data = Buffer.from(
      (value === null ? text : JSON.stringify(value)) + ending,
    );
    expected.update(data);
    let offset = 0;
    while (offset < data.length)
      offset += (await output.write(data, offset)).bytesWritten;
  }
  try {
    for await (const chunk of createReadStream(source, {
      highWaterMark: 256 * 1024,
    })) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        await row(pending.subarray(0, newline), "\n");
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > maxRowBytes)
        throw new Error(
          "Provider transcript row exceeds the bounded JSON row size.",
        );
    }
    if (pending.length) await row(pending, "");
  } finally {
    await output.close();
  }
  if ((await hashFile(destination)) !== expected.digest("hex"))
    throw new Error("Transcript verification failed.");
}

export async function receiveArchive(
  home: string | undefined,
  destination: string,
  file: string,
  limits = defaultLimits,
): Promise<TransferResult> {
  const dir = await privateDirectory("paseo-transfer-receive-");
  const nativeCreated: string[] = [];
  let registered = false,
    reserved = false,
    target = "";
  try {
    enforceLimit((await fs.stat(file)).size, limits.maxBytes, "Archive bytes");
    const unpacked = await unpackArchive(file, dir, limits);
    const manifest = unpacked.manifest as Manifest;
    validateManifest(manifest);
    enforceLimit(
      manifest.files.length +
        manifest.deleted.length +
        manifest.sessions.reduce(
          (sum, session) => sum + session.files.length,
          0,
        ),
      limits.maxFiles,
      "File count",
    );
    const used = new Set<number>();
    function blob(ref: BlobRef) {
      const value = unpacked.blobs.get(ref?.id);
      if (
        !value ||
        used.has(ref.id) ||
        value.ref.id !== ref.id ||
        value.ref.bytes !== ref.bytes ||
        value.ref.sha256 !== ref.sha256
      )
        throw new Error("Invalid or reused transfer blob reference.");
      used.add(ref.id);
      return value.file;
    }
    const bundle = manifest.bundle ? blob(manifest.bundle) : null;
    const patch = manifest.indexPatch ? blob(manifest.indexPatch) : null;
    const paths = new Map<ArchiveFile, string>();
    for (const files of [
      manifest.files,
      ...manifest.sessions.map((session) => session.files),
    ]) {
      const seen = new Set<string>();
      for (const entry of files) {
        safeRelative(entry.path);
        if (
          seen.has(entry.path) ||
          !Number.isInteger(entry.mode) ||
          entry.mode < 0 ||
          entry.mode > 0o777 ||
          (entry.link !== undefined && typeof entry.link !== "string") ||
          !!entry.blob === (entry.link !== undefined)
        )
          throw new Error("Invalid archive file entry.");
        seen.add(entry.path);
        if (entry.blob) paths.set(entry, blob(entry.blob));
      }
    }
    if (used.size !== unpacked.blobs.size)
      throw new Error("Archive contains unreferenced data.");
    target = (
      await check(
        home,
        destination,
        summarySessions(manifest.sessions),
        limits.maxFiles,
      )
    ).destination;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(target);
    reserved = true;
    if (bundle) {
      await command("git", ["init", target]);
      await command(
        "git",
        [
          "fetch",
          "--update-head-ok",
          bundle,
          "refs/heads/*:refs/heads/*",
          "refs/tags/*:refs/tags/*",
        ],
        target,
        limits.commandTimeoutSeconds * 1000,
      );
      await command(
        "git",
        ["fetch", bundle, "HEAD"],
        target,
        limits.commandTimeoutSeconds * 1000,
      );
      await command(
        "git",
        [
          "checkout",
          ...(manifest.branch ? ["-B", manifest.branch] : ["--detach"]),
          manifest.head!,
        ],
        target,
        limits.commandTimeoutSeconds * 1000,
      );
      if (patch && manifest.indexPatch!.bytes)
        await command(
          "git",
          ["apply", "--cached", "--binary", patch],
          target,
          limits.commandTimeoutSeconds * 1000,
        );
      const tracked = [
        ...new Set(
          (await command("git", ["ls-files", "-z"], target))
            .split("\0")
            .concat(
              (
                await command(
                  "git",
                  ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
                  target,
                )
              ).split("\0"),
            )
            .filter(Boolean),
        ),
      ];
      for (const name of tracked)
        await fs.rm(path.join(target, safeRelative(name)), { force: true });
    }
    for (const entry of manifest.files) {
      const full = path.join(target, entry.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      if (
        !inside(
          await fs.realpath(target),
          await fs.realpath(path.dirname(full)),
        )
      )
        throw new Error("Destination path leaves workspace.");
      if (entry.link !== undefined) {
        if (
          path.isAbsolute(entry.link) ||
          !inside(target, path.resolve(path.dirname(full), entry.link))
        )
          throw new Error("Unsafe symlink.");
        await fs.symlink(entry.link, full);
        if ((await fs.readlink(full)) !== entry.link)
          throw new Error("Symlink verification failed.");
      } else {
        await fs.copyFile(paths.get(entry)!, full, 1);
        await fs.chmod(full, entry.mode);
        if (
          (await hashFile(full)) !== entry.blob!.sha256 ||
          ((await fs.stat(full)).mode & 0o777) !== entry.mode
        )
          throw new Error(`File verification failed: ${entry.path}`);
      }
    }
    if (
      manifest.head &&
      (await command("git", ["rev-parse", "HEAD"], target)).trim() !==
        manifest.head
    )
      throw new Error("Git HEAD verification failed.");
    if (patch) {
      const verify = path.join(dir, "verify.patch");
      await outputFile(
        "git",
        ["diff", "--cached", "--binary", "HEAD"],
        target,
        verify,
        limits,
      );
      if ((await hashFile(verify)) !== manifest.indexPatch!.sha256)
        throw new Error("Staged changes verification failed.");
    }
    for (const session of manifest.sessions) {
      const root = await sessionRoot(session, target);
      await fs.mkdir(root, { recursive: true });
      for (const entry of session.files) {
        if (!entry.blob) throw new Error("Provider transcript must be a file.");
        const full = path.join(root, entry.path);
        await fs.mkdir(path.dirname(full), { recursive: true });
        if (
          !inside(
            await fs.realpath(root),
            await fs.realpath(path.dirname(full)),
          )
        )
          throw new Error("Transcript path leaves provider directory.");
        await transcript(
          paths.get(entry)!,
          full,
          manifest.workspace.cwd,
          target,
          () => nativeCreated.push(full),
        );
      }
    }
    const workspace = await cli(
      home,
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      target,
      "--title",
      manifest.workspace.name,
    );
    registered = true;
    const agents: string[] = [];
    for (const session of manifest.sessions) {
      const args = [
        "import",
        session.id,
        "--provider",
        session.provider,
        "--cwd",
        target,
      ];
      for (const [key, value] of Object.entries(session.labels))
        args.push("--label", `${key}=${value}`);
      const imported = await cli(home, ...args);
      const id = imported.agentId;
      if (!id)
        throw new Error(`Paseo did not return an agent ID for ${session.id}`);
      if (session.title)
        await cli(home, "agent", "update", id, "--name", session.title);
      const inspected = await cli(home, "inspect", id);
      if (inspected.Cwd !== target || inspected.Provider !== session.provider)
        throw new Error("Imported agent verification failed.");
      if (session.archived) await cli(home, "archive", id);
      agents.push(id);
    }
    if (
      !(await list(home)).some(
        (entry) =>
          entry.workspaceId === workspace.workspaceId && entry.cwd === target,
      )
    )
      throw new Error("Workspace registration verification failed.");
    return {
      workspaceId: workspace.workspaceId,
      cwd: target,
      agents,
      verified: true,
      sourceArchived: false,
    };
  } catch (error) {
    if (!registered) {
      if (reserved) await fs.rm(target, { recursive: true, force: true });
      for (const file of nativeCreated) await fs.rm(file, { force: true });
    }
    throw new Error(
      `${(error as Error).message}${registered ? ` Destination preserved at ${target}; source has not been archived.` : ""}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function archiveSource(
  home: string | undefined,
  workspaceId: string,
  fingerprint: string,
  limits = defaultLimits,
) {
  const current = await createArchive(home, workspaceId, limits);
  try {
    if (
      current.manifest.workspace.isolation === "worktree" &&
      current.manifest.hasIgnored
    )
      throw new Error(
        "Source worktree has Git-ignored files. Use Copy to keep those files on the source.",
      );
    if (current.fingerprint !== fingerprint)
      throw new Error(
        "Source changed during transfer; destination is verified but source was kept open.",
      );
    await assertIdleCheckout(home, current.manifest.workspace.cwd);
    await cli(home, "workspace", "archive", workspaceId);
    if ((await list(home)).some((entry) => entry.workspaceId === workspaceId))
      throw new Error("Source archive verification failed.");
  } finally {
    await fs.rm(current.dir, { recursive: true, force: true });
  }
}
