import { MessengerError } from "./messenger/http.ts";
import { slackScope } from "./messenger/thread-ledger.ts";
import { ScheduleError } from "./schedule-error.ts";

type ScheduleDestination =
  | { readonly platform: "discord"; readonly to: string }
  | { readonly platform: "telegram"; readonly to: string; readonly thread?: string }
  | { readonly platform: "slack"; readonly to: string; readonly channel: string; readonly thread?: string };

export function scheduleDestination(value: string): ScheduleDestination | null {
  if (value === "wake" || value === "log") return null;
  const match = /^post:(discord|slack|telegram):([^/]+)(?:\/(.+))?$/.exec(value);
  const [, platform, to, thread] = match ?? [];
  if (!to) throw new ScheduleError("--deliver must be wake, log or post:<discord|slack|telegram>:<target>[/thread]");
  const suffix = thread === undefined ? {} : { thread };
  switch (platform) {
    case "discord":
      if (!/^[1-9]\d{5,29}$/.test(to) || thread !== undefined)
        throw new ScheduleError("Discord post target must be a channel or thread ID without /thread");
      return { platform, to };
    case "telegram":
      if (
        !/^-?[1-9]\d*$/.test(to) ||
        (thread !== undefined && (!/^[1-9]\d*$/.test(thread) || !Number.isSafeInteger(Number(thread))))
      )
        throw new ScheduleError("Telegram post target must be a chat ID with an optional positive /topic ID");
      return { platform, to, ...suffix };
    case "slack": {
      const [teamId, userId, channel, extra] = to.split(":");
      if (
        !channel ||
        extra !== undefined ||
        !/^[CGD][A-Za-z0-9_-]+$/.test(channel) ||
        (thread !== undefined && !/^\d+\.\d+$/.test(thread))
      )
        throw new ScheduleError("Slack post target must be post:slack:WORKSPACE:ACCOUNT:CHANNEL[/THREAD_TS]");
      try {
        slackScope(teamId, userId);
      } catch (error) {
        if (error instanceof MessengerError) throw new ScheduleError(error.message);
        throw error;
      }
      return { platform, to: `slack:${to}`, channel, ...suffix };
    }
    default:
      throw new ScheduleError("--deliver has an unknown post platform");
  }
}
