import { unlinkSync } from "node:fs";
import { join } from "node:path";

// Slack only: Discord intake, and its activity writer, run in the native binary.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://slack.com") throw new Error("unexpected intake test origin");
  const replies: Record<string, unknown> = {
    "/api/auth.test": { ok: true, team_id: "T_QA", user_id: "U_SELF" },
    "/api/subscriptions.thread.getView": { ok: true, threads: [] },
    "/api/client.counts": { ok: true, channels: [], ims: [], mpims: [] },
  };
  if (!Object.hasOwn(replies, url.pathname)) throw new Error("unexpected intake endpoint");
  return new Response(JSON.stringify(replies[url.pathname]));
}) as typeof fetch;
const log = console.log;
console.log = (...args: unknown[]) => {
  if (String(args[0]).startsWith("INBOUND_READY "))
    unlinkSync(join(`${process.env["CATALY_TEST_ACTIVITY"]!}.lock`, "owner.json"));
  log(...args);
};
