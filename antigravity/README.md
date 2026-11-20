# Cataly for Google Antigravity

A native Google Antigravity plugin port of [Cataly](https://github.com/vntrevx/Cataly) (derived from [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)), replacing Linux terminal multiplexers (`herdr`/`hc`) and OMP-specific host hooks with Antigravity's native primitives: **Plugins**, **MCP Servers**, **Lifecycle Hooks**, **Subagents**, **Skills**, and **Rules**.

Works cross-platform on Windows, macOS, and Linux with Node.js 22+ (tested on Node.js 24).

## Architecture

```text
antigravity/
├── src/
│   ├── core/            # config (mtime-cached), Done = signal verifier, lanes, worklog, decisions, lessons, checkpoints, reports, backlog, locks, PR verify/watch, boot
│   ├── discord/         # v10 REST client, code-fence splitter, Gateway v10 online WebSocket waiter, channel purposes/cache, attachment downloader, owner-only inbound poller
│   ├── mcp-server.ts    # Stdio MCP server (`cataly-core`, 40 tools)
│   ├── hooks.ts         # Antigravity SessionStart & Stop lifecycle hooks
│   ├── cli.ts           # Standalone CLI (`boot`, `sweep`, `check-done`, `report`, `checkpoint`, `claim-done`, `pr-watch`, `discord`)
│   └── test/            # Unit, hook, Gateway WebSocket, and MCP stdio handshake tests
├── plugin/              # Antigravity plugin bundle (`plugin.json`, `hooks.json`, `rules/`, `agents/`, `skills/`, `assets/`)
└── scripts/
    └── install-plugin.mjs  # Builds and installs a stripped production bundle to ~/.gemini/config/plugins/cataly
```

## Key Capabilities

- **Verifiable `Done =` Signals**: Live-verifies `merged`, `closed`, `published`, `command`, `file` (SHA-256 + JSON field match), and `url` (status + body regex), plus single-call `git status --porcelain=v2 --branch` clean/pushed verification.
- **Tracked Subagent Lanes**: Creates scoped briefs injected with global + repo lessons (`cataly_lane_create`), binds Antigravity `conversationId` (`cataly_lane_attach`), enforces claim/objection/grace-window verification (`cataly_lane_verify_close`, `cataly_lane_sweep`), and includes dedicated `cataly-lane` and `cataly-reviewer` subagent definitions.
- **Compaction-Safe State (`~/.cataly/`)**: Append-only JSONL + rendered Markdown for `worklog`, `decisions`, `lessons`, `checkpoints`, `reports`, prioritized `backlog`, `locks`, and `tracked-prs.json`.
- **Antigravity Lifecycle Hooks**: `SessionStart` injects a concise boot recovery summary only when active state or unanswered obligations exist; `Stop` guards bound `working` lanes once without looping.
- **Native Discord v10 Integration**: Owner-only intake, Gateway v10 WebSocket online presence with <100ms delivery and automatic REST fallback, code-fence-aware 2000-char message splitting, 👀 read-receipt and reply obligation tracking, decision reply auto-matching, safe CDN attachment staging with magic-byte detection, and thread lifecycle (`[working]` / `[waiting]` / `[done]`).

## Installation & Verification

```bash
cd antigravity
npm install
npm test
npm run install:plugin
```

`npm run install:plugin` deploys a self-contained production bundle (excluding devDependencies, source maps, type declarations, and docs) to `~/.gemini/config/plugins/cataly/` (override with `CATALY_PLUGIN_DIR`). Antigravity discovers the plugin automatically without restarting.

### Optional Discord Setup

1. Store your bot token in `~/.cataly/secrets/discord.token` (or set `CATALY_DISCORD_TOKEN`). Never paste tokens into chat or commit them.
2. Configure your Discord owner ID, guild ID, and watched channel IDs via `cataly_config_set` or:
   ```bash
   node ~/.gemini/config/plugins/cataly/dist/cli.js discord setup --owner <USER_ID> --channels <CHANNEL_ID> --guild <GUILD_ID>
   ```
3. See [plugin/skills/cataly-mode/references/discord-setup.md](./plugin/skills/cataly-mode/references/discord-setup.md) for full permissions and Gateway reactive intake details.

## Licensing & Attribution

This directory is part of [vntrevx/Cataly](https://github.com/vntrevx/Cataly) and retains the repository's applicable license and provenance terms documented in [../LICENSE](../LICENSE), [../LICENSING.md](../LICENSING.md), and [../NOTICE](../NOTICE).
