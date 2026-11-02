export { streamArchive } from "./archive-stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { resolvePaseoCli } from "./paseo-cli";
import { defaultLimits, limitsSchema, enforceLimit } from "../shared/limits";
import type {
  FileEntry,
  Session,
  Snapshot,
  WorkerRequest,
  Workspace,
  TransferResult,
} from "../shared/types";

const exec = promisify(execFile);
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = defaultLimits.maxFiles;
const UUID = /^[a-f0-9-]{36}$/i;
export function paseoHome(home?: string) {
  const value =
    home ?? process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  return path.resolve(
    value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value,
  );
}
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}
export function codexHome() {
  return process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
}
export function commandEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Calls use the chosen daemon's local credential, never an originating agent's scope or password.
  for (const key of [
    "PASEO_AGENT_ID",
    "PASEO_AGENT_CWD",
    "PASEO_PASSWORD",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  return env;
}
export async function command(
  bin: string,
  args: string[],
  cwd?: string,
  timeout = 120_000,
) {
  return (
    await exec(bin, args, {
      cwd,
      timeout,
      maxBuffer: MAX_BYTES,
      env: commandEnvironment(),
    })
  ).stdout;
}
export async function cli(
  home: string | undefined,
  ...args: string[]
): Promise<any> {
  const text = await command(await resolvePaseoCli(), [
    "--home",
    paseoHome(home),
    "--json",
    ...args,
  ]);
  const data = JSON.parse(text);
  if (data?.error)
    throw new Error(data.error.message ?? "Paseo command failed");
  return data;
}
export async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export function safeRelative(file: string) {
  if (
    !file ||
    file.includes("\0") ||
    file.includes("\\") ||
    path.posix.isAbsolute(file) ||
    file.split("/").some((p) => p === ".." || p === "." || p === ".git")
  )
    throw new Error(`Unsafe snapshot path: ${file}`);
  return file;
}
export function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  return (
    !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)
  );
}
export async function filesBelow(
  root: string,
  filter: (name: string) => boolean = () => true,
  maxFiles = MAX_FILES,
): Promise<string[]> {
  if (!(await exists(root))) return [];
  const result: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (
        ["EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw new Error(
          `Cannot read ${dir}. Select a project workspace you can access; no files were skipped. On macOS, check the app's Files and Folders permissions.`,
        );
      throw error;
    }
    for (const entry of entries) {
      if (!filter(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result.push(full);
      if (maxFiles && result.length > maxFiles)
        throw new Error(`Workspace exceeds ${maxFiles} files`);
    }
  }
  await walk(root);
  return result.sort();
}
async function readEntry(root: string, relative: string): Promise<FileEntry> {
  safeRelative(relative);
  const full = path.join(root, relative);
  // A tracked path through a symlink must not read files outside this workspace.
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
    return { path: relative, data: "", mode: stat.mode & 0o777, link };
  }
  if (!stat.isFile()) throw new Error(`Unsupported file: ${relative}`);
  if (stat.size > MAX_BYTES)
    throw new Error(`File exceeds 128 MiB: ${relative}`);
  return {
    path: relative,
    data: (await fs.readFile(full)).toString("base64"),
    mode: stat.mode & 0o777,
  };
}
function byteSize(files: FileEntry[]) {
  return files.reduce(
    (sum, f) =>
      sum +
      Buffer.byteLength(f.data, "base64") +
      Buffer.byteLength(f.link ?? ""),
    0,
  );
}
function fingerprint(snapshot: Omit<Snapshot, "fingerprint" | "bytes">) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
async function nativeSessions(
  home: string | undefined,
  workspace: Workspace,
): Promise<{ sessions: Session[]; skipped: string[] }> {
  const sessions: Session[] = [];
  const skipped: string[] = [];
  const records = await filesBelow(
    path.join(paseoHome(home), "agents"),
    (name) => !name.startsWith("."),
  );
  const live: any[] = await cli(home, "ls", "-a");
  const status = new Map(live.map((a) => [a.id, a.status]));
  const seen = new Set<string>();
  for (const file of records.filter((f) => f.endsWith(".json"))) {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (record.workspaceId !== workspace.workspaceId) continue;
    if (["running", "initializing"].includes(status.get(record.id) ?? ""))
      throw new Error(
        "Stop the workspace’s running agents before transferring it.",
      );
    const provider = record.provider;
    const id = record.persistence?.sessionId;
    if (!id) {
      skipped.push(`${record.title ?? record.id}: no saved provider session`);
      continue;
    }
    if (provider !== "claude" && provider !== "codex") {
      skipped.push(
        `${record.title ?? record.id}: ${provider} sessions are not supported`,
      );
      continue;
    }
    if (!UUID.test(id)) throw new Error(`Invalid ${provider} session ID`);
    if (seen.has(id)) continue;
    seen.add(id);
    let root: string;
    let names: string[];
    if (provider === "claude") {
      root = path.join(
        claudeHome(),
        "projects",
        claudeProjectDir(workspace.cwd),
      );
      names = [`${id}.jsonl`];
      for (const sub of await filesBelow(path.join(root, id)))
        names.push(path.relative(root, sub));
    } else {
      root = codexHome();
      names = (await filesBelow(path.join(root, "sessions")))
        .concat(await filesBelow(path.join(root, "archived_sessions")))
        .filter((f) => path.basename(f).endsWith(`-${id}.jsonl`))
        .map((f) => path.relative(root, f));
    }
    if (!names.length || !(await exists(path.join(root, names[0]))))
      throw new Error(
        `Cannot find ${provider} transcript for ${record.title ?? id}`,
      );
    const entries = [];
    for (const name of names) {
      entries.push(await readEntry(root, name));
      if (
        byteSize(entries) +
          sessions.reduce((n, s) => n + byteSize(s.files), 0) >
        MAX_BYTES
      )
        throw new Error("Conversations exceed the 128 MiB transfer limit.");
    }
    sessions.push({
      id,
      provider,
      title: record.title ?? "",
      labels: record.labels ?? {},
      archived: !!record.archivedAt,
      files: entries,
    });
  }
  return { sessions, skipped };
}
export function claudeProjectDir(cwd: string) {
  const replaced = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= 200) return replaced;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++)
    hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${replaced.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
async function version() {
  const value = (await command(await resolvePaseoCli(), ["--version"])).trim();
  const parts = value.split(".").map(Number);
  if ((parts[0] === 0 && parts[1] < 11) || !Number.isFinite(parts[0]))
    throw new Error(`Paseo 0.11.0 or newer is required (found ${value})`);
  return value;
}
export async function list(home?: string): Promise<Workspace[]> {
  await version();
  return cli(home, "workspace", "ls");
}
export async function snapshot(
  home: string | undefined,
  workspaceId: string,
): Promise<Snapshot> {
  const workspace = (await list(home)).find(
    (w) => w.workspaceId === workspaceId,
  );
  if (!workspace)
    throw new Error(
      "Workspace is missing or archived. Refresh the workspace list.",
    );
  const cwd = workspace.cwd;
  await assertWorkspaceDirectory(cwd);
  const native = await nativeSessions(home, workspace);
  if ((await fs.lstat(cwd)).isSymbolicLink())
    throw new Error("Workspace root must not be a symlink.");
  let gitRoot: string | null = null;
  try {
    gitRoot = (
      await command("git", ["rev-parse", "--show-toplevel"], cwd)
    ).trim();
  } catch {
    /* directory workspace */
  }
  let head: string | null = null,
    branch: string | null = null,
    bundle: string | null = null,
    indexPatch = "";
  let names: string[] = [];
  const deleted: string[] = [];
  let hasIgnored = false;
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
    hasIgnored = !!(await command(
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
    head = (await command("git", ["rev-parse", "HEAD"], cwd)).trim();
    try {
      branch = (
        await command("git", ["symbolic-ref", "--short", "HEAD"], cwd)
      ).trim();
    } catch {
      /* detached HEAD */
    }
    indexPatch = await command(
      "git",
      ["diff", "--cached", "--binary", "HEAD"],
      cwd,
    );
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "paseo-sync-bundle-"));
    try {
      const file = path.join(tmp, "repo.bundle");
      await command("git", ["bundle", "create", file, "--all", "HEAD"], cwd);
      if ((await fs.stat(file)).size > MAX_BYTES)
        throw new Error("Git history exceeds the 128 MiB transfer limit.");
      bundle = (await fs.readFile(file)).toString("base64");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
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
  } else {
    names = (
      await filesBelow(
        cwd,
        (name) =>
          ![".git", "node_modules", ".venv", "__pycache__"].includes(name),
      )
    ).map((f) => path.relative(cwd, f));
  }
  if (names.length > MAX_FILES)
    throw new Error(`Workspace exceeds ${MAX_FILES} files`);
  const files: FileEntry[] = [];
  let bytes =
    Buffer.byteLength(bundle ?? "", "base64") +
    Buffer.byteLength(indexPatch) +
    native.sessions.reduce((n, s) => n + byteSize(s.files), 0);
  if (bytes > MAX_BYTES)
    throw new Error(
      "Workspace and conversations exceed the 128 MiB transfer limit.",
    );
  for (const name of names) {
    if (!(await exists(path.join(cwd, name)))) {
      deleted.push(name);
      continue;
    }
    const file = await readEntry(cwd, name);
    bytes += byteSize([file]);
    if (bytes > MAX_BYTES)
      throw new Error(
        "Workspace and conversations exceed the 128 MiB transfer limit.",
      );
    files.push(file);
  }
  const sourceId = (
    await fs.readFile(path.join(paseoHome(home), "server-id"), "utf8")
  ).trim();
  const base = {
    version: 1 as const,
    sourceId,
    workspace,
    head,
    branch,
    bundle,
    indexPatch,
    files,
    deleted,
    sessions: native.sessions,
    skipped: native.skipped,
    hasIgnored,
  };
  return { ...base, fingerprint: fingerprint(base), bytes };
}
export async function assertWorkspaceDirectory(cwd: string) {
  const resolved = await fs.realpath(cwd);
  const userHome = await fs.realpath(homedir());
  if (
    resolved === path.parse(resolved).root ||
    resolved === userHome ||
    inside(resolved, userHome)
  )
    throw new Error(
      "This workspace points to your home or a system directory. Open the specific project folder as a Paseo workspace and transfer that instead.",
    );
}
export function resolveDestination(destination: string) {
  const expanded =
    destination === "~"
      ? homedir()
      : destination.startsWith("~/")
        ? path.join(homedir(), destination.slice(2))
        : destination;
  if (!path.isAbsolute(expanded) || expanded.includes("\0"))
    throw new Error("Destination must be an absolute path or start with ~/.");
  return path.resolve(expanded);
}
export async function sessionRoot(
  session: Pick<Session, "provider">,
  destination: string,
) {
  return session.provider === "claude"
    ? path.join(claudeHome(), "projects", claudeProjectDir(destination))
    : codexHome();
}
export async function check(
  home: string | undefined,
  destination: string,
  sessions: Session[],
  maxFiles = MAX_FILES,
) {
  await version();
  await cli(home, "workspace", "ls");
  const target = resolveDestination(destination);
  if (await exists(target))
    throw new Error(
      `Destination already exists: ${target}. Choose a new directory.`,
    );
  for (const session of sessions) {
    await command(session.provider === "claude" ? "claude" : "codex", [
      "--version",
    ]);
    const root = await sessionRoot(session, target);
    // Sessions are global IDs. A copy on another path must never shadow one already here.
    const global =
      session.provider === "claude"
        ? path.join(claudeHome(), "projects")
        : codexHome();
    for (const file of await filesBelow(
      global,
      (name) =>
        session.provider === "claude" ||
        ["sessions", "archived_sessions"].includes(name) ||
        /^\d/.test(name) ||
        name.endsWith(".jsonl"),
      maxFiles,
    )) {
      if (
        path.basename(file) === `${session.id}.jsonl` ||
        path.basename(file).endsWith(`-${session.id}.jsonl`)
      )
        throw new Error(
          `Session ${session.id} already exists on the target host.`,
        );
    }
    for (const file of session.files)
      if (await exists(path.join(root, safeRelative(file.path))))
        throw new Error(`Target transcript already exists: ${file.path}`);
  }
  return { destination: target };
}
export function rewriteTranscript(
  file: FileEntry,
  source: string,
  target: string,
): Buffer {
  const text = Buffer.from(file.data, "base64").toString("utf8");
  return Buffer.from(
    text
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const row = JSON.parse(line);
        function walk(node: any): void {
          if (!node || typeof node !== "object") return;
          for (const [key, value] of Object.entries(node)) {
            // Preserve conversation prose. Only structural working-directory fields move.
            if (
              key === "cwd" &&
              typeof value === "string" &&
              (value === source || value.startsWith(source + "/"))
            )
              node[key] = target + value.slice(source.length);
            else if (value && typeof value === "object") walk(value);
          }
        }
        walk(row);
        return JSON.stringify(row);
      })
      .join("\n"),
  );
}
async function writeEntry(root: string, file: FileEntry) {
  const name = safeRelative(file.path);
  const full = path.join(root, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (!inside(await fs.realpath(root), await fs.realpath(path.dirname(full))))
    throw new Error(`Destination path leaves workspace: ${name}`);
  if (file.link) {
    if (
      path.isAbsolute(file.link) ||
      !inside(root, path.resolve(path.dirname(full), file.link))
    )
      throw new Error(`Unsafe symlink: ${name}`);
    await fs.symlink(file.link, full);
  } else {
    await fs.writeFile(full, Buffer.from(file.data, "base64"), {
      flag: "wx",
      mode: file.mode,
    });
  }
}
export async function receive(
  home: string | undefined,
  destination: string,
  snap: Snapshot,
): Promise<TransferResult> {
  const { fingerprint: expected, bytes: ignored, ...base } = snap;
  if (snap.version !== 1 || fingerprint(base) !== expected)
    throw new Error("Transfer snapshot checksum mismatch.");
  if (snap.skipped.length)
    throw new Error(
      "A workspace with skipped conversations cannot be transferred.",
    );
  const target = (await check(home, destination, snap.sessions)).destination;
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "paseo-sync-receive-"));
  const nativeCreated: string[] = [];
  let registered = false,
    reserved = false;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(target);
    reserved = true;
    if (snap.bundle) {
      const bundleFile = path.join(tmp, "repo.bundle");
      await fs.writeFile(bundleFile, Buffer.from(snap.bundle, "base64"));
      await command("git", ["init", target]);
      await command(
        "git",
        [
          "fetch",
          "--update-head-ok",
          bundleFile,
          "refs/heads/*:refs/heads/*",
          "refs/tags/*:refs/tags/*",
        ],
        target,
      );
      await command("git", ["fetch", bundleFile, "HEAD"], target);
      await command(
        "git",
        [
          "checkout",
          ...(snap.branch ? ["-B", snap.branch] : ["--detach"]),
          snap.head!,
        ],
        target,
      );
      // Rebuild the index independently from the final working tree.
      if (snap.indexPatch) {
        const patchFile = path.join(tmp, "index.patch");
        await fs.writeFile(patchFile, snap.indexPatch);
        await command(
          "git",
          ["apply", "--cached", "--binary", patchFile],
          target,
        );
      }
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
      for (const f of tracked)
        await fs.rm(path.join(target, safeRelative(f)), { force: true });
    }
    for (const file of snap.files) await writeEntry(target, file);
    for (const file of snap.files) {
      const read = await readEntry(target, file.path);
      if (
        read.data !== file.data ||
        read.link !== file.link ||
        read.mode !== file.mode
      )
        throw new Error(`File verification failed: ${file.path}`);
    }
    if (
      snap.head &&
      (await command("git", ["rev-parse", "HEAD"], target)).trim() !== snap.head
    )
      throw new Error("Git HEAD verification failed.");
    if (
      snap.bundle &&
      (await command(
        "git",
        ["diff", "--cached", "--binary", "HEAD"],
        target,
      )) !== snap.indexPatch
    )
      throw new Error("Staged changes verification failed.");
    for (const session of snap.sessions) {
      const root = await sessionRoot(session, target);
      await fs.mkdir(root, { recursive: true });
      for (const file of session.files) {
        const full = path.join(root, safeRelative(file.path));
        await fs.mkdir(path.dirname(full), { recursive: true });
        if (
          !inside(
            await fs.realpath(root),
            await fs.realpath(path.dirname(full)),
          )
        )
          throw new Error("Transcript path leaves provider directory.");
        const data = rewriteTranscript(file, snap.workspace.cwd, target);
        await fs.writeFile(full, data, { flag: "wx", mode: 0o600 });
        nativeCreated.push(full);
        if (!data.equals(await fs.readFile(full)))
          throw new Error("Transcript verification failed.");
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
      snap.workspace.name,
    );
    registered = true;
    const agents: string[] = [];
    for (const session of snap.sessions) {
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
    const workspaceId = workspace.workspaceId;
    if (
      !(await list(home)).some(
        (w) => w.workspaceId === workspaceId && w.cwd === target,
      )
    )
      throw new Error("Workspace registration verification failed.");
    return {
      workspaceId,
      cwd: target,
      agents,
      verified: true,
      sourceArchived: false,
    };
  } catch (e) {
    if (!registered) {
      if (reserved) await fs.rm(target, { recursive: true, force: true });
      for (const file of nativeCreated) await fs.rm(file, { force: true });
    }
    // Once registered, preserve an incomplete destination so its imported agents remain usable.
    throw new Error(
      `${(e as Error).message}${registered ? ` Destination preserved at ${target}; source has not been archived.` : ""}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
export async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.action) {
    case "archive-export": {
      const { createArchive, archiveSessions } = await import("./archive");
      const exported = await createArchive(
        request.home,
        request.workspaceId,
        limitsSchema.parse(request.limits ?? {}),
      );
      return {
        file: exported.file,
        fingerprint: exported.fingerprint,
        checksum: exported.checksum,
        wireBytes: exported.wireBytes,
        bytes: exported.bytes,
        workspace: exported.manifest.workspace,
        sourceId: exported.manifest.sourceId,
        files: exported.manifest.files.length,
        branch: exported.manifest.branch,
        sessions: archiveSessions(exported.manifest.sessions),
        hasIgnored: exported.manifest.hasIgnored,
      };
    }
    case "archive-receive": {
      const { receiveArchive } = await import("./archive");
      const { hashFile } = await import("./archive-format");
      const limits = limitsSchema.parse(request.limits ?? {});
      enforceLimit(
        (await fs.stat(request.file)).size,
        limits.maxBytes,
        "Archive bytes",
      );
      if (
        !/^[a-f0-9]{64}$/.test(request.checksum) ||
        (await hashFile(request.file)) !== request.checksum
      )
        throw new Error("Transfer upload checksum mismatch.");
      return receiveArchive(
        request.home,
        request.destination,
        request.file,
        limits,
      );
    }
    case "archive-source": {
      const { archiveSource } = await import("./archive");
      await archiveSource(
        request.home,
        request.workspaceId,
        request.fingerprint,
        limitsSchema.parse(request.limits ?? {}),
      );
      return { archived: true };
    }
    case "archive-upload": {
      const { allocateUpload } = await import("./archive-stream");
      return allocateUpload(
        request.wireBytes,
        limitsSchema.parse(request.limits ?? {}),
      );
    }
    case "archive-release": {
      const { releaseArchive } = await import("./archive-stream");
      return releaseArchive(request.file);
    }
    case "info":
      return {
        version: await version(),
        hostname: hostname(),
        home: paseoHome(request.home),
      };
    case "list":
      return { workspaces: await list(request.home) };
    case "snapshot":
      return snapshot(request.home, request.workspaceId);
    case "check":
      return check(
        request.home,
        request.destination,
        request.sessions,
        limitsSchema.parse(request.limits ?? {}).maxFiles,
      );
    case "receive":
      return receive(request.home, request.destination, request.snapshot);
    case "archive": {
      const current = await snapshot(request.home, request.workspaceId);
      if (current.workspace.isolation === "worktree" && current.hasIgnored)
        throw new Error(
          "Source worktree has Git-ignored files. Use Copy to keep those files on the source.",
        );
      if (current.fingerprint !== request.fingerprint)
        throw new Error(
          "Source changed during transfer; destination is verified but source was kept open.",
        );
      await cli(request.home, "workspace", "archive", request.workspaceId);
      if (
        (await list(request.home)).some(
          (w) => w.workspaceId === request.workspaceId,
        )
      )
        throw new Error("Source archive verification failed.");
      return { archived: true };
    }
  }
}
