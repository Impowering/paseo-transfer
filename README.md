# paseo-transfer

[![Upstream npm version](https://img.shields.io/npm/v/paseo-transfer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-transfer)
[![Upstream npm downloads](https://img.shields.io/npm/dm/paseo-transfer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-transfer)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.14.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/Impowering/paseo-transfer?style=for-the-badge&color=2563eb)](LICENSE)

Copy or move a workspace to another host, with Git history, local changes, and Claude/Codex conversations.

This Impower fork adds disk-spooled connected transfers for large repositories. It defaults to 100,000 files and 16 GiB per archive, with configurable host limits and incremental verification. Install the same reviewed commit on both hosts:

```sh
paseo plugin install git:Impowering/paseo-transfer --ref <immutable-commit>
```

The runtime plugin ID remains `transfer`. Connected protocol 2 requires this fork on both ends; it does not silently interoperate with upstream protocol 1. Paseo 0.14.0+ is still required. Original author: [Tom Gringauz](https://github.com/tomgrin10/paseo-transfer); MIT attribution is preserved.

![Transfer popup with the current workspace selected and a verified copy preview](docs/screenshots/transfer.png)

Example using fixture workspace and host data.

## Install

Enable plugins in **Settings → Plugins**, then run on both hosts:

```sh
paseo plugin install git:Impowering/paseo-transfer --ref <immutable-commit>
```

Use the same reviewed full commit SHA on every host. The upstream command `paseo plugin install paseo-transfer` installs Tom’s original npm release.

Both hosts need Paseo **0.14.0+**, Node **22+**, Git, and Linux/macOS or WSL. Connect both hosts in Paseo and keep their daemons running. The receiving host needs its own provider CLIs and credentials.

## Use

1. Stop running agents, open a workspace, and press **Transfer** at the top right.
2. Choose a connected **Paseo host** and a **new directory**. No extra pairing, passwords, or SSH setup.
3. Choose **Copy** or **Move**, press **Preview transfer**, review the details, and start.

**Copy** keeps the source. **Move** archives it after verification; a managed source worktree may be removed. Git-ignored files stay behind, so Move refuses worktrees containing them.

Close and reopen the popup to check progress. Keep Paseo open and both hosts connected until the transfer finishes. The sidebar is hidden by default; enable it in **Settings → Plugins → Transfer → Display**. **⌘K / Ctrl+K → Transfer a workspace** opens the full screen, including incoming transfers.

## Data and recovery

Transfers use your existing authenticated Paseo connections. **Use SSH** is available for hosts without the plugin; it uses SSH aliases, keys, and normal host-key verification. Transfer project workspaces rather than your entire home directory. Provider credentials, MCP settings, Git-ignored files, and launch settings stay on their original hosts. Copies are independent checkouts; registered partial transfers are kept for recovery.

See the [transfer details](docs/behavior.md) for supported content, limits, and failure handling.

## Development

```sh
npm ci
npm run verify
```

Reload with `paseo plugin reload transfer`. Provider checks: `npm run test:live`. UI preview: `npx tsx scripts/ui-preview.tsx`.

## License

[MIT](LICENSE). Rebuilt from [itsjustanks/paseo-plugin-sync](https://github.com/itsjustanks/paseo-plugin-sync); its original attribution is preserved.

## Navigation and display

Open this plugin from Command-K or its sidebar entry. **Overview** and **Display settings** link the main view and settings directly, without opening the Plugins settings page. Hiding a sidebar entry keeps Command-K available.

Display settings can also hide this plugin's workspace header or composer buttons independently. Hidden buttons stay hidden for newly opened workspaces; restoring them retains the latest button status.

## Paseo 0.14 agent integration

`transfer_list_hosts` discovers configured SSH and Tailscale destinations; `transfer_run_status` reads an existing transfer’s progress. Transfers still use the preview and confirmation flow in the Transfer screen.

Requires Paseo **0.14.0 or newer**. Agent tools are scoped to interactive Claude
and Codex sessions; history-only opens receive none. They become available on
the next idle session open after install or reload. The agent label
`plugin-tools/enabled: "false"` opts a session out. Existing plugin data and
settings are retained.

## Other plugins

- [Defer](https://github.com/tomgrin10/paseo-defer) — Schedule messages for later delivery.
- [Graphite](https://github.com/tomgrin10/paseo-graphite) — Graphite stacks and PR status.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, agent, and Docker health.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Dispatch](https://github.com/tomgrin10/paseo-dispatch) — Route tasks to existing workspaces (development preview).

- [Follow-up](https://github.com/tomgrin10/paseo-follow-up) — Track workspace PRs, remaining tasks and completion.
