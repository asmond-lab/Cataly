const PREFIX = "discord-wake-pending:";

/** A lane whose Discord wake is still awaiting startup attestation; the native monitor writes the same prefix. */
export const isDiscordWakePending = (epoch: string | undefined): boolean => epoch?.startsWith(PREFIX) === true;

export const discordWakePendingEpoch = (epoch: string): string => PREFIX + epoch;
