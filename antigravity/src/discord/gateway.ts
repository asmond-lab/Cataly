import { loadConfig } from "../core/config.js";
import { Decisions } from "../core/decisions.js";
import { downloadDiscordAttachment } from "./attachments.js";
import { DiscordChannels, resolveInboundContext } from "./channels.js";
import type { DcAttachment, DcMessage, DiscordClient } from "./client.js";
import { DiscordInboundState, type InboundMessageRecord, pollDiscordInbound } from "./inbound.js";

// GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)
export const CATALY_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export type MinimalWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export type GatewayWaitOptions = {
  readonly botToken: string;
  readonly client: DiscordClient;
  readonly stateDir: string;
  readonly catalyHome?: string;
  readonly timeoutMs?: number; // 0 = unlimited
  readonly includeContext?: boolean;
  readonly downloadAttachments?: boolean;
  readonly activityName?: string;
  readonly wsFactory?: WebSocketFactory;
  readonly onStatus?: (status: string) => void;
};

export type GatewayWaitResult =
  { readonly kind: "messages"; readonly messages: readonly InboundMessageRecord[] } | { readonly kind: "timeout" };

type GatewayPayload = {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
};

const defaultWsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as MinimalWebSocket;

/**
 * Connect to Discord Gateway v10 WebSocket with online presence, backfill any missed messages via REST on READY,
 * and resolve immediately (<100ms) when an owner message arrives in a watched channel or its threads.
 */
export async function waitForDiscordGateway(opts: GatewayWaitOptions): Promise<GatewayWaitResult> {
  const cfg = loadConfig(opts.catalyHome).discord;
  const ownerId = cfg.ownerId;
  if (!ownerId) throw new Error("Discord ownerId is not configured");
  const watchedParents = new Set(cfg.channelIds ?? []);
  if (watchedParents.size === 0) throw new Error("No Discord channelIds configured");
  const followThreads = cfg.followThreads ?? true;

  // 1. Immediate REST backfill before opening socket so messages sent while offline arrive instantly
  const backfill = await pollDiscordInbound(opts.client, opts.stateDir, {
    includeContext: opts.includeContext ?? true,
    catalyHome: opts.catalyHome,
  });
  if (backfill.messages.length > 0) {
    return { kind: "messages", messages: await maybeAttachDownloads(backfill.messages, opts) };
  }

  let gatewayUrl = "wss://gateway.discord.gg/?v=10&encoding=json";
  try {
    const gw = await opts.client.gatewayBot();
    if (gw.url) {
      gatewayUrl = gw.url.includes("?") ? `${gw.url}&v=10&encoding=json` : `${gw.url}/?v=10&encoding=json`;
    }
  } catch {
    // use default gateway URL
  }

  const state = new DiscordInboundState(opts.stateDir);
  const channelsStore = new DiscordChannels(opts.stateDir);
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const timeoutMs = opts.timeoutMs ?? 0;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const activityName = opts.activityName ?? "Antigravity Cataly";

  return new Promise<GatewayWaitResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let ws: MinimalWebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let seq: number | null = null;
    let consecutiveFailures = 0;

    const cleanup = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      heartbeatTimer = null;
      timeoutTimer = null;
      reconnectTimer = null;
      if (ws) {
        try {
          ws.close(1000, "done");
        } catch {
          // ignore
        }
        ws = null;
      }
    };

    const finish = (result: GatewayWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    }

    const isWatchedChannel = async (channelId: string): Promise<boolean> => {
      if (watchedParents.has(channelId)) return true;
      if (!followThreads) return false;
      try {
        const ch = await opts.client.channel(channelId);
        if (ch.parent_id && watchedParents.has(ch.parent_id)) {
          return true;
        }
      } catch {
        // ignore lookup errors
      }
      return false;
    };

    const connect = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish({ kind: "timeout" });
        return;
      }
      ws = wsFactory(gatewayUrl);

      ws.addEventListener("message", (rawEvent: unknown) => {
        if (settled) return;
        const data =
          typeof rawEvent === "object" && rawEvent !== null && "data" in rawEvent
            ? String((rawEvent as { data: unknown }).data)
            : String(rawEvent);
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(data) as GatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") seq = payload.s;

        // op 10: HELLO -> start heartbeat & IDENTIFY with online presence
        if (payload.op === 10) {
          const interval = Number((payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ op: 1, d: seq }));
            }
          }, interval);
          heartbeatTimer.unref?.();

          ws?.send(
            JSON.stringify({
              op: 2,
              d: {
                token: opts.botToken,
                intents: CATALY_GATEWAY_INTENTS,
                properties: { os: process.platform, browser: "cataly-antigravity", device: "cataly-antigravity" },
                presence: {
                  since: null,
                  activities: [{ name: activityName, type: 3 }],
                  status: "online",
                  afk: false,
                },
              },
            }),
          );
          return;
        }

        // op 1: server requests immediate heartbeat
        if (payload.op === 1 && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ op: 1, d: seq }));
          return;
        }

        // op 7 RECONNECT or op 9 INVALID_SESSION -> close & reconnect cleanly
        if (payload.op === 7 || payload.op === 9) {
          try {
            ws?.close(4000, "reconnect");
          } catch {
            // ignore
          }
          return;
        }

        // op 0 DISPATCH
        if (payload.op === 0 && payload.t === "READY") {
          consecutiveFailures = 0;
          opts.onStatus?.("GATEWAY_ONLINE");
          return;
        }

        if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
          const msg = payload.d as DcMessage;
          if (!msg?.author || msg.author.id !== ownerId || msg.author.bot) return;

          void (async () => {
            if (!(await isWatchedChannel(msg.channel_id))) return;
            const cursors = state.readCursors();
            const prev = cursors[msg.channel_id];
            if (prev && BigInt(msg.id) <= BigInt(prev)) return;
            cursors[msg.channel_id] = msg.id;
            state.saveCursors(cursors);
            state.recordObligation(msg.channel_id, msg.id);

            const context =
              (opts.includeContext ?? true)
                ? await resolveInboundContext(opts.client, channelsStore, msg.channel_id)
                : undefined;
            const decisions = new Decisions(opts.stateDir);
            const replyId = msg.message_reference?.message_id;
            const matched = replyId
              ? (decisions.match(replyId) ?? decisions.match(`discord:${msg.channel_id}/${replyId}`))
              : null;

            const attachments = (msg.attachments ?? []).map((a: DcAttachment) => ({
              filename: a.filename,
              size: a.size,
              ...(a.content_type ? { contentType: a.content_type } : {}),
              url: a.url,
            }));

            const record: InboundMessageRecord = {
              channelId: msg.channel_id,
              messageId: msg.id,
              authorId: msg.author.id,
              authorName: msg.author.global_name || msg.author.username,
              timestamp: msg.timestamp,
              content: msg.content,
              ...(replyId ? { replyToMessageId: replyId } : {}),
              ...(msg.referenced_message?.content ? { replyToContent: msg.referenced_message.content } : {}),
              ...(matched ? { matchedDecisionId: matched.id } : {}),
              attachments,
              ...(context ? { context } : {}),
            };
            finish({ kind: "messages", messages: await maybeAttachDownloads([record], opts) });
          })();
        }
      });

      ws.addEventListener("error", () => {
        // close event will handle reconnect / fallback
      });

      ws.addEventListener("close", (ev: unknown) => {
        if (settled) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const closeCode =
          typeof ev === "object" && ev !== null && "code" in ev ? Number((ev as { code: unknown }).code) : 1006;
        // Fatal auth/intent codes: do not spin forever; let caller fall back to REST
        if (closeCode === 4004 || closeCode === 4013 || closeCode === 4014) {
          fail(new Error(`Discord Gateway fatal close code ${closeCode}`));
          return;
        }
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          fail(new Error(`Discord Gateway disconnected ${consecutiveFailures} times (last code ${closeCode})`));
          return;
        }
        const delayMs = Math.min(2000 * consecutiveFailures, 15_000);
        reconnectTimer = setTimeout(() => connect(), delayMs);
      });
    };

    connect();
  });
}

async function maybeAttachDownloads(
  messages: readonly InboundMessageRecord[],
  opts: GatewayWaitOptions,
): Promise<InboundMessageRecord[]> {
  if (!opts.downloadAttachments) return [...messages];
  const out: InboundMessageRecord[] = [];
  for (const m of messages) {
    if (m.attachments.length === 0) {
      out.push(m);
      continue;
    }
    const enriched = await Promise.all(
      m.attachments.map(async (att) => {
        try {
          const dl = await downloadDiscordAttachment(att.url, opts.stateDir, {
            messageId: m.messageId,
            filename: att.filename,
          });
          return { ...att, localPath: dl.savedPath };
        } catch {
          return att;
        }
      }),
    );
    out.push({ ...m, attachments: enriched });
  }
  return out;
}
