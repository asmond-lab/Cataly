#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectBootSummary, formatBootMarkdown } from "./core/boot.js";
import { Checkpoints } from "./core/checkpoints.js";
import { loadConfig, loadDiscordBotToken, resolveCatalyHome, resolveStateDir, updateConfig } from "./core/config.js";
import { LaneRegistry } from "./core/lanes.js";
import { PrTracker } from "./core/pr.js";
import { formatReportLine, isReportKind, Reports } from "./core/reports.js";
import { checkDone } from "./core/signals.js";
import { downloadDiscordAttachment } from "./discord/attachments.js";
import { DiscordClient } from "./discord/client.js";
import { waitForDiscordGateway } from "./discord/gateway.js";
import { pollDiscordInbound } from "./discord/inbound.js";

const catalyHome = resolveCatalyHome();
const stateDir = resolveStateDir(catalyHome);

function usage(): void {
  process.stdout.write(
    [
      "Cataly for Antigravity CLI",
      "",
      "Usage:",
      "  cataly boot                                Show active worklog, decisions, lanes, backlog, PRs, obligations",
      "  cataly sweep [--skip-git]                  Auto-verify expired done-claims & report stale lanes",
      "  cataly check-done <done-line>              Live-verify a Done = signal line",
      "  cataly report <key> <kind> <text...>       Record a lane report (milestone|blocker|question|halted|done)",
      "  cataly checkpoint <key> --step S --result R [--evidence E] [--effect F]",
      "  cataly claim-done <key> --evidence TEXT    Claim a lane done with concrete evidence",
      "  cataly pr-watch                            Poll tracked GitHub PRs for updates",
      "  cataly discord setup --owner ID --channels ID1,ID2 [--guild ID] [--token-file PATH]",
      "  cataly discord save-token                  Save Discord bot token from stdin to ~/.cataly/secrets/discord.token",
      "  cataly discord poll [--history]            Poll owner-only Discord messages once",
      "  cataly discord wait [--rest] [--interval 3] [--timeout 0] [--no-download]  Wait reactively via Gateway (online presence, <100ms, auto REST fallback)",
      "  cataly discord watch [--interval 5]        Continuously poll Discord and print INBOUND JSON lines",
      "  cataly discord send --to CHANNEL --text TEXT [--reply MSG_ID]",
      "",
    ].join("\n"),
  );
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function getAllFlags(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) {
      values.push(args[i + 1]!);
      i++;
    }
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  if (cmd === "boot" || cmd === "status") {
    const summary = collectBootSummary(catalyHome);
    process.stdout.write(`${formatBootMarkdown(summary)}\n`);
    return;
  }

  if (cmd === "sweep") {
    const registry = new LaneRegistry(stateDir, catalyHome);
    const res = await registry.sweep({ skipGitCheck: args.includes("--skip-git") });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === "check-done") {
    const line = args.slice(1).join(" ");
    if (!line.trim()) {
      process.stderr.write("Missing Done = signal line\n");
      process.exit(1);
    }
    const checks = await checkDone(line);
    process.stdout.write(`${JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2)}\n`);
    if (!checks.every((c) => c.ok)) process.exit(1);
    return;
  }

  if (cmd === "report") {
    const key = args[1];
    const kind = args[2];
    const text = args.slice(3).join(" ").trim();
    if (!key || !isReportKind(kind) || !text) {
      process.stderr.write("Usage: cataly report <key> <milestone|blocker|question|halted|done> <text...>\n");
      process.exit(1);
    }
    const reports = new Reports(stateDir);
    const entry = reports.report(key, kind, text);
    process.stdout.write(`${formatReportLine(entry)}\n`);
    return;
  }

  if (cmd === "checkpoint") {
    const key = args[1];
    const step = getFlag(args, "--step");
    const result = getFlag(args, "--result");
    const evidence = getAllFlags(args, "--evidence");
    const remoteEffects = getAllFlags(args, "--effect");
    if (!key || !step || !result) {
      process.stderr.write("Usage: cataly checkpoint <key> --step STEP --result RESULT [--evidence E] [--effect F]\n");
      process.exit(1);
    }
    const checkpoints = new Checkpoints(stateDir);
    const written = checkpoints.write(key, { step, result, evidence, remoteEffects });
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    return;
  }

  if (cmd === "claim-done") {
    const key = args[1];
    const evidence = getFlag(args, "--evidence");
    if (!key || !evidence) {
      process.stderr.write("Usage: cataly claim-done <key> --evidence TEXT\n");
      process.exit(1);
    }
    const registry = new LaneRegistry(stateDir, catalyHome);
    const reports = new Reports(stateDir);
    const updated = registry.claimDone(key, evidence);
    reports.report(key, "done", `Claimed done: ${evidence}`);
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }

  if (cmd === "pr-watch") {
    const tracker = new PrTracker(stateDir);
    const res = await tracker.checkUpdates();
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === "discord") {
    const sub = args[1];
    if (sub === "setup") {
      const ownerId = getFlag(args, "--owner");
      const channelsRaw = getFlag(args, "--channels");
      const guildId = getFlag(args, "--guild");
      const tokenFile = getFlag(args, "--token-file");
      const updated = updateConfig(
        {
          discord: {
            ...(ownerId ? { ownerId } : {}),
            ...(channelsRaw
              ? {
                  channelIds: channelsRaw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(guildId ? { guildId } : {}),
            ...(tokenFile ? { tokenFile } : {}),
          },
        },
        catalyHome,
      );
      process.stdout.write(`${JSON.stringify({ discord: updated.discord }, null, 2)}\n`);
      return;
    }

    if (sub === "save-token") {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      const token = Buffer.concat(chunks).toString("utf8").trim();
      if (!token) {
        process.stderr.write("No token received on stdin\n");
        process.exit(1);
      }
      const target = join(catalyHome, "secrets", "discord.token");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(target, 0o600);
      } catch {
        // ignore on Windows
      }
      updateConfig({ discord: { tokenFile: target } }, catalyHome);
      process.stdout.write(`Saved Discord token to ${target}\n`);
      return;
    }

    const token = loadDiscordBotToken(catalyHome);
    if (!token) {
      process.stderr.write(
        "Discord bot token not configured. Run `cataly discord save-token` or set CATALY_DISCORD_TOKEN.\n",
      );
      process.exit(1);
    }
    const client = new DiscordClient(token, { apiBase: loadConfig(catalyHome).discord.apiBase });

    if (sub === "poll") {
      const res = await pollDiscordInbound(client, stateDir, {
        includeContext: true,
        includeHistoryOnFirstPoll: args.includes("--history"),
        catalyHome,
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }

    if (sub === "wait") {
      const forceRest = args.includes("--rest");
      const downloadAttachments = !args.includes("--no-download");
      const intervalSec = Number(getFlag(args, "--interval") ?? "3");
      const timeoutRaw = getFlag(args, "--timeout");
      const timeoutSec = timeoutRaw === undefined ? 0 : Number(timeoutRaw);
      const intervalMs = Number.isFinite(intervalSec) && intervalSec >= 1 ? Math.round(intervalSec * 1000) : 3000;
      const unlimited = timeoutSec === 0;
      const timeoutMs = unlimited ? 0 : Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 600_000;

      if (!forceRest) {
        try {
          const gwRes = await waitForDiscordGateway({
            botToken: token,
            client,
            stateDir,
            catalyHome,
            timeoutMs,
            includeContext: true,
            downloadAttachments,
            onStatus: (s) => process.stderr.write(`${s}\n`),
          });
          if (gwRes.kind === "messages") {
            process.stdout.write(`INBOUND_MESSAGES=${JSON.stringify(gwRes.messages)}\n`);
          } else {
            process.stdout.write("INBOUND_TIMEOUT\n");
          }
          return;
        } catch (err) {
          process.stderr.write(`GATEWAY_FALLBACK_TO_REST ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      const deadline = unlimited ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await pollDiscordInbound(client, stateDir, { includeContext: true, catalyHome });
          if (res.messages.length > 0) {
            const enriched = downloadAttachments
              ? await Promise.all(
                  res.messages.map(async (m) => ({
                    ...m,
                    attachments: await Promise.all(
                      m.attachments.map(async (att) => {
                        try {
                          const dl = await downloadDiscordAttachment(att.url, stateDir, {
                            messageId: m.messageId,
                            filename: att.filename,
                          });
                          return { ...att, localPath: dl.savedPath };
                        } catch {
                          return att;
                        }
                      }),
                    ),
                  })),
                )
              : res.messages;
            process.stdout.write(`INBOUND_MESSAGES=${JSON.stringify(enriched)}\n`);
            return;
          }
          for (const w of res.warnings) {
            process.stderr.write(`WARN ${w}\n`);
          }
        } catch (err) {
          process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
        }
        const waitMs = unlimited ? intervalMs : Math.min(intervalMs, deadline - Date.now());
        if (waitMs <= 0) break;
        await new Promise((r) => setTimeout(r, waitMs));
      }
      process.stdout.write("INBOUND_TIMEOUT\n");
      return;
    }

    if (sub === "watch") {
      const intervalSec = Number(getFlag(args, "--interval") ?? "5");
      const ms = Number.isFinite(intervalSec) && intervalSec >= 2 ? intervalSec * 1000 : 5000;
      process.stderr.write(`Cataly Discord watcher started (interval=${ms / 1000}s)\n`);
      for (;;) {
        try {
          const res = await pollDiscordInbound(client, stateDir, { includeContext: true, catalyHome });
          for (const msg of res.messages) {
            process.stdout.write(`INBOUND ${JSON.stringify(msg)}\n`);
          }
          for (const w of res.warnings) {
            process.stderr.write(`WARN ${w}\n`);
          }
        } catch (err) {
          process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
        }
        await new Promise((r) => setTimeout(r, ms));
      }
    }

    if (sub === "send") {
      const to = getFlag(args, "--to");
      const text = getFlag(args, "--text");
      const replyTo = getFlag(args, "--reply");
      if (!to || !text) {
        process.stderr.write("Usage: cataly discord send --to CHANNEL_ID --text TEXT [--reply MSG_ID]\n");
        process.exit(1);
      }
      const ids = await client.send(to, text, { replyTo });
      process.stdout.write(`${JSON.stringify({ channelId: to, messageIds: ids })}\n`);
      return;
    }
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
