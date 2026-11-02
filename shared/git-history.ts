export const gitHistoryScopes = ["repository", "workspace"] as const;
export type GitHistoryScope = (typeof gitHistoryScopes)[number];
export function parseGitHistoryScope(value: unknown): GitHistoryScope {
  if (value === undefined || value === "repository") return "repository";
  if (value === "workspace") return "workspace";
  throw new Error("Unsupported Git history scope.");
}
export function requireGitHistoryScope(
  scope: GitHistoryScope,
  supported: readonly string[] | undefined,
) {
  if (
    scope === "workspace" &&
    (!Array.isArray(supported) || !supported.includes(scope))
  )
    throw new Error(
      "This endpoint does not support workspace Git history. Update Transfer on both endpoints before selecting it.",
    );
}
export function gitHistoryDescription(value: unknown) {
  return parseGitHistoryScope(value) === "workspace"
    ? "Current branch and HEAD with complete ancestor history. Other branches and all tags stay on the source; detached HEAD has no branch. Non-Git folders are unchanged."
    : "All local branches, tags and HEAD with their history. Non-Git folders are unchanged.";
}
