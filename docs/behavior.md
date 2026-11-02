# Transfer details

See the [README](../README.md) for installation and usage.

## What transfers

| Content              | Behavior                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Git history          | Local branches, tags, and the selected HEAD, including unpushed commits.                                         |
| Working tree         | Tracked files, staged and unstaged changes, non-ignored untracked files, executable bits, and internal symlinks. |
| Claude conversations | Native transcripts and saved subagent transcripts; the destination imports them through Paseo.                   |
| Codex conversations  | Native rollout files; the destination imports them through Paseo.                                                |
| Names and labels     | Workspace name and agent titles, labels, and archived state.                                                     |
| Directory workspaces | Plain files; `.git`, `node_modules`, `.venv`, and `__pycache__` directories are excluded.                        |

Git-ignored files such as `.env`, dependencies, provider credentials, daemon credentials, repository config/hooks, terminals, schedules, workspace pins, and provider-specific launch settings stay on the source. Imported agents use the target host's provider configuration. Conversation text stays intact; only structural `cwd` fields are translated.

Unsupported providers or missing saved conversations block the transfer rather than silently dropping history. Submodules, repositories without a commit, Git subdirectory workspaces, unmerged Git indexes, and escaping symlinks are not supported.

## Large connected transfers in the Impower fork

Connected transfers use protocol 2: a private disk-spooled archive with length-delimited binary blobs, per-blob SHA-256 digests, a bounded metadata manifest, and a full wire checksum. Files, Git bundles, index patches and native transcripts never become one large JSON/base64 string. The existing ordered 192 KiB RPC chunks relay the archive; receiver extraction reads at most 256 KiB of file data at a time. Both hosts must run the same protocol; upstream protocol 1 is refused.

The host-scoped `limits` settings are registered through Paseo's settings API. Defaults are `maxFiles: 100000`, `maxBytes: 17179869184` (16 GiB including archive framing), `maxFileBytes: 4294967296` (4 GiB), `commandTimeoutSeconds: 900`, and `taskTimeoutSeconds: 3600`. Zero removes a file/byte policy limit. Integer validation, bounded framing, path checks, destination ownership and digest verification remain mandatory. The receiver applies its own limits and requires temporary free space for the upload, extracted verification data and destination. Source and destination settings can differ; a stricter destination refuses the upload or extraction.

`transfer.identity` advertises `protocol: 2` and the host's task timeout. Connected task polling uses that advertised bound. Large Git bundle creation, fetch, checkout and binary-index operations use the configured command bound. The transfer's chunk-relay loop is not constrained by the former fifteen-minute task constant. The compact manifest is bounded to 64 MiB and each native transcript JSONL row to 16 MiB; malformed or oversized metadata is refused without source archival.

The advanced SSH route retains its bounded legacy JSON snapshot transport and 128 MiB decoded snapshot limit. Use connected protocol 2 for large repositories. Legacy source discovery no longer assumes a 20,000-file maximum, but SSH is not an unbounded streaming transport.

Automation can use `client/connected-transfer.ts`'s exported `createTransferClient(getRpc)` with an authenticated per-server RPC function. `preview({sourceId,targetId,workspaceId,destination,mode})` returns a fingerprint-bound plan; `start(plan)` returns a run ID; `status(runId)` reports completion and the exact new workspace/agent IDs. The injected RPC calls `DaemonClient.invokePluginRpc("transfer", contract.name, input)` and validates `contract.output`. This is the same preview/re-export/ordered upload/receive/final source-check flow used by the UI, not a bypass. Native agent tools remain read-only discovery/status tools.

Copied provider session IDs stay the same, while Paseo workspace and agent IDs are new. Pins, hierarchy, workspace Info fields, remote Git configuration and owner-tracker relations require separate verified reconciliation. No provider turn is started by an archive transfer. The fork checks all running agents' real checkout paths, including distinct workspace IDs sharing one directory; external ownership and do-not-archive holds still belong to the operator's preflight.

## Verification and recovery

Transfer refuses an occupied destination or an existing native session ID. It verifies file bytes, modes, symlinks, Git HEAD, staged changes, transcript bytes, agent imports, and workspace registration. It never overwrites an existing checkout or edits Paseo's workspace/agent registry files.

A failure before workspace registration removes the new destination. A failure after registration preserves the partial destination for recovery and reports its path. The source stays open. If archiving fails or the source changes during a move, the verified destination remains available and the source stays open. Plugin reloads clear preview/status state; check both hosts before retrying a transfer interrupted by reload.

Connected transfers reuse Paseo's configured hosts and authenticated plugin RPCs, following Transcript Search's host federation. Each host operates on its own filesystem; the client relays bounded chunks with an end-to-end checksum. Hosts are matched by server ID, never by label or address, and a disconnected or missing installation never falls back to another host. Both hosts need Transfer 1.2.0 or newer. Keep the app open and both hosts connected; closing only the popup is safe. Once the destination starts receiving, it finishes on that host even if the app disconnects. A lost connection before confirmation leaves the source open; check the target before retrying.

Connected previews hold a snapshot in a private temporary directory on the source. Starting rechecks the source checksum before uploading a fresh snapshot. Temporary data is released after use, when a preview is dismissed, on plugin cleanup, or lazily after 30 minutes of inactivity when another request arrives. A killed process can leave temporary files in the operating system's temporary directory. No credentials or new connection tokens are sent to the client.

**Use SSH** retains the single-plugin workflow with normal host-key verification. Git bundles travel over that connection, so the receiving host does not need reverse SSH access. SSH previews retain only metadata and a checksum.

Home directories, filesystem roots and ancestors of the home directory are refused before scanning. This avoids walking protected folders such as macOS Trash. Permission failures in project directories are reported with the failing path and recovery guidance; unreadable files are never silently skipped.
