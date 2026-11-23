import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyDiscordFixture, legacyDiscordRecipe } from "../../test/fixtures/legacy-discord-recipe.ts";
import { discordLoopback } from "../../skills/cataly-mode/scripts/test/discord-loopback.ts";
import { load, until } from "./fake-pi.ts";

// Saved intake hands Discord to the native monitor; without its binary the recipe cannot reach readiness.
const nativeBinary = process.env["CATALY_DISCORD_NATIVE_BIN"];
test.skipIf(process.platform === "win32" || !nativeBinary || nativeBinary === "off")(
  "saved Discord intake and presence reach readiness from the selected config without changing legacy argv",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "cataly-legacy-monitor-"));
    const fixture = legacyDiscordFixture(home, join(home, "operator-settings"));
    const discord = discordLoopback([]);
    writeFileSync(fixture.configFile, JSON.stringify({ stateDir: fixture.stateDir, ompUlwPath: "" }));
    const env: Record<string, string | undefined> = {
      ...fixture.env,
      HOME: process.env["HOME"],
      PATH: process.env["PATH"],
      CATALY_HOME: home,
      CATALY_CONFIG: fixture.configFile,
      CATALY_STATE_DIR: undefined,
      CATALY_MANAGED_STARTUP: undefined,
      DORI_HOME: undefined, // The upgraded side wrapper explicitly unsets it.
      // Presence keeps its TS Gateway fixture; only the saved intake selects the native monitor.
      CATALY_DISCORD_NATIVE_BIN: undefined,
      CATALY_TEST_INBOUND_NATIVE_BIN: nativeBinary,
      CATALY_TEST_INBOUND_API: discord.base,
      CATALY_MESSENGER_PROFILE_DEFAULTS: "off",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const records = [
        { name: "intake", argv: legacyDiscordRecipe.inbound, filter: "^INBOUND_READY", cwd: tmpdir() },
        { name: "presence", argv: legacyDiscordRecipe.presence, filter: "^PRESENCE_READY", cwd: tmpdir() },
      ].map((spec) => ({ type: "custom", customType: "omp-dori:monitor", data: { op: "start", ...spec } }));
      const saved = JSON.stringify(records);
      const pi = await load({
        session: {
          id: "legacy-discord-lead",
          entries: [{ type: "custom", customType: "omp-dori:role", data: "dori" }, ...records],
        },
      });
      try {
        await pi.emit("session_start");
        const delivered = () => pi.messages.flatMap(({ content }) => content.split("\n"));
        await until(() =>
          ["[intake] INBOUND_READY discord", "[presence] PRESENCE_READY discord event=READY"].every((prefix) =>
            delivered().some((line) => line.startsWith(prefix)),
          ),
        );
        expect(JSON.stringify(pi.session.entries.slice(1, 3))).toBe(saved);
        expect(process.env["DORI_HOME"]).toBeUndefined();
      } finally {
        await pi.emit("session_shutdown");
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      discord.stop();
      rmSync(home, { force: true, recursive: true });
    }
  },
  10_000,
);
