/** A loopback Discord REST stand-in for the native monitor; no request leaves this host and no real token is used. */
export const LOOPBACK_TOKEN = "synthetic-inbound-token";

/** Tests that drive real intake need the Rust binary; without it they are skipped, never faked. */
export const nativeDiscordBinary = (): string | undefined => {
  const binary = process.env["CATALY_DISCORD_NATIVE_BIN"];
  return binary && binary !== "off" ? binary : undefined;
};

type Message = Record<string, unknown> & { id: string; channel_id: string };
const message = (id: string, author: string, content: string, channel = "20"): Message => ({
  id,
  channel_id: channel,
  type: 0,
  author: { id: author },
  content,
});

/** History already holds the new owner input; callers seed each cursor at 100 so intake starts behind it. */
export const ownerHistory = (scenario: "plain" | "shared-routing"): Message[] =>
  scenario === "shared-routing"
    ? [
        message("100", "10", "baseline history"),
        { ...message("101", "10", "answer to the pending ASK"), type: 19, message_reference: { message_id: "95" } },
        message("102", "10", "regular head request"),
      ]
    : [
        message("100", "10", "baseline history"),
        message("101", "10", "first owner text"),
        message("102", "11", "private other user"),
      ];

export function discordLoopback(history: Message[], channels: Record<string, Record<string, unknown>> = {}) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v10/, "");
      requests.push(`${request.method} ${path}`);
      if (request.headers.get("authorization") !== `Bot ${LOOPBACK_TOKEN}`) return new Response("{}", { status: 401 });
      if (request.method === "PUT" && /^\/channels\/\d+\/messages\/\d+\/reactions\//.test(path))
        return new Response(null, { status: 204 });
      if (path === "/users/@me") return Response.json({ id: "99", bot: true, avatar: "custom-image" });
      if (path === "/applications/@me") return Response.json({ flags: 1 << 19 });
      const listed = path.match(/^\/channels\/(\d+)\/messages$/);
      if (listed) {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const before = url.searchParams.get("before");
        return Response.json(
          history
            .filter((item) => item.channel_id === listed[1])
            .filter((item) => before === null || BigInt(item.id) < BigInt(before))
            .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
            .slice(0, limit),
        );
      }
      const channel = path.match(/^\/channels\/(\d+)$/);
      if (channel?.[1]) return Response.json(channels[channel[1]] ?? { id: channel[1], type: 0 });
      return new Response("{}", { status: 404 });
    },
  });
  return { base: `http://127.0.0.1:${server.port}/api/v10`, requests, stop: () => server.stop(true) };
}
