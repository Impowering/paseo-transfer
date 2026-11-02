import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface CliContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  execPath?: string;
  resourcesPath?: string;
  home?: string;
  applicationsDirectory?: string;
}
async function executable(file: string) {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
}

/** Select an existing CLI once per call; execution errors never select a different CLI. */
export async function resolvePaseoCli(context: CliContext = {}) {
  const env = context.env ?? process.env;
  if (env.PASEO_SYNC_CLI !== undefined) return env.PASEO_SYNC_CLI;
  const platform = context.platform ?? process.platform;
  // Native Windows retains execFile's existing lookup behavior; WSL uses the POSIX path below.
  if (platform === "win32") return "paseo";
  const cwd = context.cwd ?? process.cwd();
  for (const directory of new Set(
    (env.PATH ?? "/usr/bin:/bin").split(path.delimiter),
  )) {
    const file = path.resolve(cwd, directory, "paseo");
    if (await executable(file)) return file;
  }
  if (platform === "darwin") {
    const resources =
      context.resourcesPath ??
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = new Set<string>();
    if (resources && path.isAbsolute(resources))
      candidates.add(path.join(resources, "bin", "paseo"));
    // Helpers can be nested inside the main .app; inspect only the executable's ancestors.
    let directory = path.dirname(context.execPath ?? process.execPath);
    for (let depth = 0; depth < 64; depth++) {
      if (path.basename(directory).toLowerCase().endsWith(".app"))
        candidates.add(
          path.join(directory, "Contents", "Resources", "bin", "paseo"),
        );
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const app of [
      path.join(context.applicationsDirectory ?? "/Applications", "Paseo.app"),
      path.join(context.home ?? homedir(), "Applications", "Paseo.app"),
    ])
      candidates.add(path.join(app, "Contents", "Resources", "bin", "paseo"));
    for (const file of candidates) if (await executable(file)) return file;
  }
  throw new Error(
    `Cannot find an executable Paseo CLI on PATH${platform === "darwin" ? " or in the current/standard Paseo app bundles" : ""}. Use an existing CLI through PASEO_SYNC_CLI for a custom installation.`,
  );
}
