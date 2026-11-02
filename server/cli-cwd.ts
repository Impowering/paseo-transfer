import { homedir } from "node:os";
import path from "node:path";

/** CLI presentation may shorten only the calling user's home; never guess relative/user paths. */
export function normalizeCliCwd(value: unknown, ownHome = homedir()): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(
      "Unverified CLI cwd; expected an absolute or own-home ~/ path.",
    );
  if (value === "~" || value.startsWith("~/")) {
    if (!path.isAbsolute(ownHome))
      throw new Error("CLI user home is not absolute.");
    if (value === "~") return ownHome;
    // Preserve suffix spelling for realpath: lexical collapse of symlink/.. can change identity.
    return (
      ownHome + (ownHome.endsWith(path.sep) ? "" : path.sep) + value.slice(2)
    );
  }
  if (!path.isAbsolute(value))
    throw new Error(
      "Unverified CLI cwd; named-user and relative paths are unsupported.",
    );
  return value;
}
