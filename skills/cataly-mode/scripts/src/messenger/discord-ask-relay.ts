import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { nativeRouting } from "./native-routing.ts";

export const ASK_RELAY_PROTOCOL = "cataly-ask-routing-v1";
export const ASK_RELAY_STATE = "CATALY_ASK_ROUTING_STATE";

/** Supervisor side: answer a monitor's ASK routing request on its IPC channel (the Rust monitor sends these). */
export function routeAskRelay(
  raw: object,
  state: string | undefined,
  isCurrent: () => boolean,
  send: (reply: { readonly protocol: string; readonly request: string; readonly routed?: boolean }) => void,
): void {
  if (!("request" in raw) || typeof raw.request !== "string" || !/^[0-9a-f-]{36}$/.test(raw.request)) return;
  const reply = { protocol: ASK_RELAY_PROTOCOL, request: raw.request };
  const route = async () => {
    if (
      !state ||
      !isCurrent() ||
      !("channel" in raw) ||
      !isDiscordSnowflake(raw.channel) ||
      !("message" in raw) ||
      !isDiscordSnowflake(raw.message) ||
      !("owner" in raw) ||
      !isDiscordSnowflake(raw.owner) ||
      !("reference" in raw) ||
      (raw.reference !== null && !isDiscordSnowflake(raw.reference)) ||
      !("text" in raw) ||
      typeof raw.text !== "string" ||
      Buffer.byteLength(raw.text) > 16_384 ||
      !("plain" in raw) ||
      typeof raw.plain !== "boolean"
    )
      return undefined;
    const result = await nativeRouting({
      route: "ask",
      state,
      channel: raw.channel,
      message: raw.message,
      reference: raw.reference,
      owner: raw.owner,
      text: raw.text,
      plain: raw.plain,
    });
    return typeof result === "boolean" && isCurrent() ? result : undefined;
  };
  const answer = (routed: boolean | undefined) => send(routed === undefined ? reply : { ...reply, routed });
  void route().then(answer, () => answer(undefined));
}
