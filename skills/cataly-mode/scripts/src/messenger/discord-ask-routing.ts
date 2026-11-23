import { type AskReply, routeDiscordAskReply, routeUnreferencedDiscordAskText } from "./discord-ask-mailbox.ts";
import { nativeRouting } from "./native-routing.ts";

/** Both managed receivers use one routing operation; the publisher and file ABI are unchanged. */
export async function routeDiscordAsk(
  state: string,
  message: AskReply & { readonly unreferencedText?: true },
  owner: string,
): Promise<boolean> {
  const plain = message.unreferencedText === true;
  if (message.reference === null && !plain) return false;
  const source = {
    channel: message.channel,
    message: message.message,
    reference: message.reference,
    text: message.text,
    owner,
    plain,
  };
  const pending = nativeRouting({ route: "ask", state, ...source });
  if (!pending)
    return (
      routeDiscordAskReply(state, message, owner) || (plain && routeUnreferencedDiscordAskText(state, message, owner))
    );
  const result = await pending;
  if (typeof result !== "boolean") throw new Error("Invalid native ASK routing response");
  return result;
}
