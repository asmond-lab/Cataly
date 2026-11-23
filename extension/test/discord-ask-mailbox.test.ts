import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDiscordAskMailbox,
  type AskReply,
} from "../../skills/cataly-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { routeDiscordAsk } from "../../skills/cataly-mode/scripts/src/messenger/discord-ask-routing.ts";

const owner = "109867692300000001";
const channel = "109867692300000002";
const question = "109867692300000003";
const message = "109867692300000004";

const posix = test.skipIf(process.platform === "win32");

const routePlain = (state: string, input: Omit<AskReply, "reference">, author: string) =>
  routeDiscordAsk(state, { ...input, reference: null, unreferencedText: true }, author);

posix("only an owner reply to the exact question and channel leaves a durable answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  const input = { channel, reference: question, message, text: "the answer" };
  try {
    expect(await routeDiscordAsk(root, input, owner)).toBe(false);
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    try {
      expect(await routeDiscordAsk(root, { ...input, reference: null }, owner)).toBe(false);
      expect(await routeDiscordAsk(root, { ...input, reference: channel }, owner)).toBe(false);
      expect(await routeDiscordAsk(root, { ...input, channel: owner }, owner)).toBe(false);
      expect(await routeDiscordAsk(root, input, channel)).toBe(false);
      expect(mailbox.replies(new Set())).toEqual([]);
      expect(await routeDiscordAsk(root, input, owner)).toBe(true);
      expect(await routeDiscordAsk(root, { ...input, text: "replayed under the same ID" }, owner)).toBe(true);
      expect(mailbox.replies(new Set())).toEqual([{ id: message, text: "the answer" }]);
      expect(mailbox.replies(new Set([message]))).toEqual([]);
    } finally {
      mailbox.close();
    }
    expect(await routeDiscordAsk(root, { ...input, message: "109867692300000005" }, owner)).toBe(true);
    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

const freshId = (offset = 10_000) => (BigInt(Date.now() + offset - 1420070400000) << 22n).toString();
const plainMessage = { channel, message: freshId(), text: "  a novel answer\nwith a second line  " };

posix("plain owner text is opt-in and delivers the original body once to the exact channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    const otherChannel = openDiscordAskMailbox(root, owner, question, owner);
    otherChannel.refreshTextIntake();

    expect(await routePlain(root, plainMessage, owner)).toBe(false);
    mailbox.refreshTextIntake();
    expect(await routeDiscordAsk(root, { ...plainMessage, reference: null }, owner)).toBe(false);
    expect(await routeDiscordAsk(root, { ...plainMessage, reference: channel }, owner)).toBe(false);
    // A fresh receiver process can claim it without sharing publisher state in memory.
    const source = join(import.meta.dir, "../../skills/cataly-mode/scripts/src/messenger/discord-ask-routing.ts");
    const result = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { routeDiscordAsk } from ${JSON.stringify(source)};
       const [root, input, owner] = process.argv.slice(-3);
       if (!await routeDiscordAsk(root, { ...JSON.parse(input), reference: null, unreferencedText: true }, owner)) process.exitCode = 1;`,
      root,
      JSON.stringify(plainMessage),
      owner,
    ]);
    expect(result.exitCode).toBe(0);
    expect(await routePlain(root, { ...plainMessage, text: "replay" }, owner)).toBe(true);

    expect(mailbox.replies(new Set())).toEqual([{ id: plainMessage.message, text: plainMessage.text, plain: true }]);
    expect(otherChannel.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix.each([
  ["a different owner", plainMessage, channel],
  ["a different channel", { ...plainMessage, channel: owner }, owner],
  ["an older message", { ...plainMessage, message: channel }, owner],
  ["the question itself", { ...plainMessage, message: question }, owner],
  ["a message after the placeholder, but before the prompt", { ...plainMessage, message: freshId(-10_000) }, owner],
  ["whitespace only", { ...plainMessage, text: " \n " }, owner],
] as const)("plain routing leaves %s unclaimed", async (_case, input, author) => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    mailbox.refreshTextIntake();

    expect(await routePlain(root, input, author)).toBe(false);

    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix("plain text is not claimed when two fresh questions could receive it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const first = openDiscordAskMailbox(root, channel, question, owner);
    const second = openDiscordAskMailbox(root, channel, message, owner);
    first.refreshTextIntake();
    second.refreshTextIntake();

    const input = { ...plainMessage, message: freshId() };
    expect(await routePlain(root, input, owner)).toBe(false);
    second.close();
    expect(await routePlain(root, input, owner)).toBe(false);

    expect(first.replies(new Set())).toEqual([]);
    expect(second.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix("plain text is not claimed after the publisher stops refreshing", async () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    mailbox.refreshTextIntake();
    const start = Date.now() - 60_000;
    writeFileSync(
      join(root, "discord-ask-replies", `${channel}-${question}`, "text-intake"),
      `${start}:${start + 15_000}`,
    );

    expect(await routePlain(root, plainMessage, owner)).toBe(false);

    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix("closing rejects novel text and keeps a claimed message from leaking to another question on replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    mailbox.refreshTextIntake();
    const input = { ...plainMessage, message: freshId() };
    expect(await routePlain(root, input, owner)).toBe(true);
    mailbox.close();
    expect(mailbox.replies(new Set())).toEqual([]);

    const novel = { ...input, message: freshId(20_000) };
    expect(await routePlain(root, novel, owner)).toBe(false);
    const next = openDiscordAskMailbox(root, channel, message, owner);
    next.refreshTextIntake();
    expect(await routePlain(root, input, owner)).toBe(true);

    expect(next.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
