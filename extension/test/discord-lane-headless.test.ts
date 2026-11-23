import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { openDiscordLaneInbox } from "../../skills/cataly-mode/scripts/src/messenger/discord-lane-inbox.ts";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { withState } from "../../skills/cataly-mode/scripts/test/fakes.ts";
import { HeadlessRuntime } from "../../src/runtime/headless.ts";
import { DiscordLane } from "../discord-lane.ts";
import { fakePi, until } from "./fake-pi.ts";

test.skipIf(process.platform === "win32")(
  "native Discord intake holds for approval and accepts only a newly persisted input in its original thread",
  async () => {
    const state = withState();
    let dialog = true;
    let observedDialog = false;
    const native = new DiscordLane(async (_root, _lane, forDispatch) => {
      expect(forDispatch).toBe(true);
      observedDialog = true;
      return !dialog;
    });
    const inbox = openDiscordLaneInbox(state.dir);
    const db = new Database(join(state.dir, "discord-lanes", "inbox.sqlite"), { readonly: true });
    const before = process.env.CATALY_HEADLESS_ID;
    try {
      const session = "native-discord-session";
      const channel = "900000000000000101";
      const other = "900000000000000102";
      const message = "900000000000000103";
      const file = join(state.dir, "transcript.jsonl");
      const pi = fakePi({ mode: "rpc", hasUI: true, session: { id: session, file, entries: [] } });
      const cwd = realpathSync(pi.ctx().cwd);
      const ref = await new HeadlessRuntime(state.dir).create({
        name: "discord-lane",
        cwd,
        env: {},
        role: "lane",
        container: "tab",
      });
      process.env.CATALY_HEADLESS_ID = ref.id;
      await new Registry(state.dir).create({
        key: "discord-lane",
        title: "Discord lane",
        thread: `discord:${channel}`,
        sessionRef: ref,
        session,
        sessionFile: file,
        cwd,
        brief: "",
        done: "",
        openedAt: new Date().toISOString(),
      });
      for (const target of [channel, other])
        inbox.add(session, {
          channel: target,
          message,
          reference: null,
          text: "same body",
          replyTo: null,
          attachments: [],
        });
      let approval = true;
      let checked = false;
      pi.api.sendUserMessage = async (content) => {
        pi.userMessages.push(content);
        await native.beforeAgentStart?.({ reason: "prompt", prompt: content }, pi.ctx());
        pi.session.entries.push({ id: "input", type: "message", message: { role: "user", content, timestamp: 1 } });
      };
      native.start(
        pi.api,
        state.dir,
        pi.ctx(),
        undefined,
        false,
        {
          idle: () => {
            checked = true;
            return !approval;
          },
          approvalFree: () => !approval,
          goalAllows: () => true,
          consumePause: () => {},
        },
        ref,
      );
      await until(() => checked);
      expect(pi.userMessages).toEqual([]);
      expect(inbox.next(session, channel)?.id).toBe(message);
      approval = false;
      await until(() => observedDialog);
      expect(pi.userMessages).toEqual([]);
      expect(inbox.next(session, channel)?.id).toBe(message);
      dialog = false;
      const delivered = db.query<{ settled: number }, [string]>(
        "SELECT text IS NULL AS settled FROM inbox WHERE channel = ?",
      );
      await until(() => delivered.get(channel)?.settled === 1);
      expect(pi.userMessages).toHaveLength(1);
      expect(pi.userMessages[0]).toContain(`INBOUND discord ${channel} ${message}`);
      expect(inbox.next(session, other)?.id).toBe(message);
      expect(inbox.nextReply(session, channel)).toBeNull();
    } finally {
      native.stop();
      db.close();
      inbox.close();
      if (before === undefined) delete process.env.CATALY_HEADLESS_ID;
      else process.env.CATALY_HEADLESS_ID = before;
      await Bun.sleep(0);
      state.done();
    }
  },
  11_000,
);
