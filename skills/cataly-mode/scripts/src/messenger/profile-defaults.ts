import type { Telegram } from "./telegram.ts";

const avatar = new URL("../../../assets/cataly-avatar.jpg", import.meta.url);
const timeoutMs = 5_000;

export const messengerProfileDefaultsEnabled = (): boolean =>
  process.env["CATALY_MESSENGER_PROFILE_DEFAULTS"]?.trim().toLowerCase() !== "off";

export async function applyTelegramProfileDefaults(tg: Telegram, botId: number, name: string): Promise<void> {
  try {
    if (name === "") await tg.call("setMyName", { name: "Cataly" }, AbortSignal.timeout(timeoutMs));
    const photos = await tg.call<{ total_count?: unknown; photos?: unknown }>(
      "getUserProfilePhotos",
      { user_id: botId, limit: 1 },
      AbortSignal.timeout(timeoutMs),
    );
    if (photos?.total_count !== 0 || !Array.isArray(photos.photos) || photos.photos.length !== 0) return;
    const form = new FormData();
    form.set("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
    const bytes = await Bun.file(avatar).arrayBuffer();
    form.set("avatar", new File([bytes], "cataly-avatar.jpg", { type: "image/jpeg" }));
    await tg.call("setMyProfilePhoto", form, AbortSignal.timeout(timeoutMs));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error("Telegram bot profile defaults could not be set; inbound will continue.");
  }
}
