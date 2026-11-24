# Cataly for Google Antigravity

A native Google Antigravity plugin port of [Cataly](https://github.com/vntrevx/Cataly) (derived from [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)), replacing Linux terminal multiplexers (`herdr`/`hc`) and OMP-specific host hooks with Antigravity's native primitives: **Plugins**, **MCP Servers**, **Lifecycle Hooks**, **Subagents**, **Skills**, and **Rules**.

Works cross-platform on Windows, macOS, and Linux with Node.js 22+ (tested on Node.js 24).

## Architecture

```text
antigravity/
├── src/
│   ├── core/            # config (mtime-cached), Done = signal verifier, lanes, shared board, worklog, decisions, lessons, checkpoints, reports, backlog, locks, PR verify/watch, boot
│   ├── discord/         # v10 REST client, code-fence splitter, Gateway v10 online WebSocket waiter (burst coalescing, autoAck, local commands), channel purposes/cache, attachment downloader, owner-only inbound poller
│   ├── mcp-server.ts    # Stdio MCP server (`cataly-core`, 51 tools)
│   ├── hooks.ts         # Antigravity SessionStart & Stop lifecycle hooks
│   ├── cli.ts           # Standalone CLI (`boot`, `sweep`, `check-done`, `report`, `checkpoint`, `claim-done`, `board`, `pr-watch`, `discord`)
│   └── test/            # Unit, hook, installer/rollback, board/commands, Gateway WebSocket, and MCP stdio handshake tests
├── plugin/              # Antigravity plugin bundle (`plugin.json`, `hooks.json`, `rules/`, `agents/`, `skills/`, `assets/`)
└── scripts/
    └── install-plugin.mjs  # Stages, validates, and atomically installs a standalone bundle (with attribution/license files and rollback) to ~/.gemini/config/plugins/cataly
```

## Key Capabilities

- **Verifiable `Done =` Signals**: Live-verifies `merged`, `closed`, `published`, `command`, `file` (SHA-256 + JSON field match), and `url` (status + body regex), plus single-call `git status --porcelain=v2 --branch` clean/pushed verification.
- **Tracked Subagent Lanes & Shared Board**: Creates scoped briefs injected with global + repo lessons (`cataly_lane_create`), binds Antigravity `conversationId` (`cataly_lane_attach`), enforces version-guarded claim/objection/grace-window verification (`cataly_lane_verify_close`, `cataly_lane_sweep`), shares informational cross-lane notes (`cataly_board_post`, `cataly_board_read`), and includes dedicated `cataly-lane`, `cataly-responder`, and `cataly-reviewer` subagent definitions.
- **Compaction-Safe State (`~/.cataly/`)**: Append-only JSONL + rendered Markdown for `worklog`, `decisions`, `lessons`, `board`, `checkpoints`, `reports`, prioritized `backlog`, `locks`, and `tracked-prs.json`.
- **Antigravity Lifecycle Hooks**: `SessionStart` injects a concise boot recovery summary only when active state or unanswered obligations exist; `Stop` guards bound `working` lanes once without looping.
- **Native Discord v10 Integration**: Owner-only intake, Gateway v10 WebSocket online presence with <100ms delivery, burst coalescing, instant `autoAck` (👀 + typing), zero-token local shortcut commands (`/help`, `/status`, `/board`, `/stop`, `/resume`) plus session-routed `/usage` and `/model`, automatic REST fallback, code-fence-aware 2000-char message splitting, per-message reply obligation tracking, decision reply auto-matching, safe CDN attachment staging with magic-byte detection, and thread lifecycle (`[working]` / `[waiting]` / `[done]`).

## Installation & Verification

```bash
cd antigravity
npm install
npm test
npm run install:plugin
```

`npm run install:plugin` stages, validates, and atomically publishes a self-contained production bundle (preserving upstream `LICENSE`, `LICENSE.integration`, `LICENSING.md`, `NOTICE`, and dependency license/notice files while excluding devDependencies, source maps, type declarations, and tests, with automatic rollback on failed upgrades) to `~/.gemini/config/plugins/cataly/` (override with `CATALY_PLUGIN_DIR`). Antigravity discovers the plugin automatically without restarting.

### Optional Discord Setup

1. Store your bot token in `~/.cataly/secrets/discord.token` (or set `CATALY_DISCORD_TOKEN`). Never paste tokens into chat or commit them.
2. Configure your Discord owner ID, guild ID, and watched channel IDs via `cataly_config_set` or:
   ```bash
   node ~/.gemini/config/plugins/cataly/dist/cli.js discord setup --owner <USER_ID> --channels <CHANNEL_ID> --guild <GUILD_ID>
   ```
3. See [plugin/skills/cataly-mode/references/discord-setup.md](./plugin/skills/cataly-mode/references/discord-setup.md) for full permissions and Gateway reactive intake details.

## Sync & Maintenance Strategy vs. skills/cataly-mode

`antigravity/` deliberately remains a self-contained **Node.js 22+ ESM** plugin bundle (`@modelcontextprotocol/sdk` and `zod` as the only runtime dependencies) rather than importing `skills/cataly-mode/scripts/` directly.

### Why `antigravity/` Is Kept Self-Contained

- **Runtime & dependency boundary**: `skills/cataly-mode/scripts/` targets **Bun >= 1.4.4** (using `bun:sqlite`, `bun:ffi`, and TypeScript imports into root `src/native-observation.ts`), OMP extensions, `herdr`/`hc` terminal panes, systemd timers, and Telegram/Slack/Voice integrations.
- **Standalone Antigravity installation**: `npm run install:plugin` copies a self-contained bundle to `~/.gemini/config/plugins/cataly/` so Windows, macOS, and Linux users can run the plugin directly inside Antigravity without installing Bun, OMP, `herdr`, or `hc`.

### Contract Parity vs. Host-Specific Divergence

| Surface | Policy | Details |
| --- | --- | --- |
| Standing rules & authority model | **Kept in parity** | Owner-only intake, evidence-before-claims, secret hygiene, one-shot external/destructive actions, and compaction persistence (`plugin/rules/AGENTS.md`). |
| `Done =` signal grammar & lane verification | **Kept in parity (contract)** | Same signal types (`merged`, `closed`, `published` on POSIX, `command`, `file`, `url`) and version-guarded claim -> grace window -> live verify -> objection -> close lifecycle. |
| Security & input boundaries | **Kept in parity** | `0600` token file storage, token redaction, loopback-only custom Discord API override, owner-only admission, CDN/size/magic-byte attachment validation, path-key validation, and shell-free native execution. |
| Naming & repository attribution | **Kept in parity** | Checked automatically by `src/test/naming.test.ts` and `src/test/install.test.ts` (`LICENSE`, `LICENSE.integration`, `LICENSING.md`, `NOTICE`). |
| Lane execution & orchestration | **Host-specific** | `skills/cataly-mode` drives `herdr`/`hc` panes and OMP hooks; `antigravity/` drives native Antigravity subagents (`conversationId`), MCP tools, and `SessionStart`/`Stop` hooks. |
| Shared board (`board`) | **Host-specific** | `skills/cataly-mode` posts and edits pinned Discord/Telegram board messages; `antigravity/` keeps a local append-only informational `board.jsonl` feed read/posted via MCP/CLI. |
| Non-Discord channels & scheduling | **Host-specific** | Telegram/Slack/Voice live in `skills/cataly-mode`; scheduled sweeps use systemd in `skills/cataly-mode` and Antigravity's native `schedule` tool in `antigravity/`. |
| State directory (`CATALY_HOME`) | **Isolate when co-installed** | Both default to `~/.cataly/` for config/worklogs/logs, but internal `lanes`/`board` file schemas differ. Override `CATALY_HOME` if running both OMP and Antigravity concurrently on the same machine. |

### Ongoing Sync Policy & Extraction Threshold

1. **Isolated cross-platform CI**: `.github/workflows/antigravity.yml` runs `npm ci`, `npm run typecheck`, and `npm test` on Ubuntu, Windows, and macOS (Node 22 and 24) for changes under `antigravity/**` without adding Node/plugin coupling to root Bun CI.
2. **Contract-change parity rule**: Whenever `skills/cataly-mode` changes `Done =` verification semantics, security/admission boundaries, or Cataly attribution/naming rules, update `antigravity/` in the same PR (or file an explicit follow-up issue if deferred).
3. **Future shared-package extraction threshold**: If pure TypeScript runtime-agnostic modules (such as the `Done =` signal parser or Discord 2000-char code-fence splitter) begin requiring repeated dual edits across both trees, extract them into a zero-dependency Node + Bun ESM workspace package. Until that churn occurs, keeping `antigravity/` standalone avoids coupling Antigravity plugin installs to Bun/OMP.

## Licensing & Attribution

This directory is part of [vntrevx/Cataly](https://github.com/vntrevx/Cataly) and retains the repository's applicable license and provenance terms documented in [../LICENSE](../LICENSE), [../LICENSE.integration](../LICENSE.integration), [../LICENSING.md](../LICENSING.md), and [../NOTICE](../NOTICE).

### Windows command signals

Command signals run native executables without a shell. Windows `.cmd`/`.bat` files and bare `npm`/`npx` commands are rejected rather than passing argv through cmd.exe. Use `node` with an absolute path to the CLI JavaScript entry point instead, The built-in `published` signal is therefore unsupported on Windows and returns a signal-specific error. For an equivalent check, use a command signal such as `command ["node","C:/absolute/path/to/npm-cli.js","view","your-package@1.2.3","version","--json"] stdout~"1\\.2\\.3"`, replacing the CLI path and package/version with your installation and target.
