import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shq } from "../../src/delivery.ts";

// The saved argv in the v0.1.3 release guide and Discord setup reference.
const load =
  'set -eu; base="${DORI_HOME:?Select this installation home}"; DORI_DISCORD_TOKEN="$(cat "$base/discord-token")"; export DORI_DISCORD_TOKEN; exec "$base/bin/dori"';
export const legacyDiscordRecipe = {
  inbound: ["bash", "-c", `${load} inbound discord`],
  presence: ["bash", "-c", `${load} presence discord`],
  threadReply: ["bash", "-c", `${load} send discord --thread "\${1#discord:}" --text "$2"`, "_", "{thread}", "{text}"],
  threadDone: ["bash", "-c", `${load} thread discord set "\${1#discord:}" --archive`, "_", "{thread}"],
} as const;

/** Only the test alias is substituted; it runs the actual CLI with the existing offline Discord transports. */
export function legacyDiscordFixture(home: string, configDir = home) {
  const skill = resolve(import.meta.dir, "../../skills/cataly-mode/scripts");
  const configFile = join(configDir, "owner-selected.json");
  const stateDir = join(home, "state");
  const fetchLog = join(home, "requests.jsonl");
  const routes = join(home, "fake-discord-routes.json");
  const bin = join(home, "bin");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, "discord-token"), "synthetic-inbound-token\n", { mode: 0o600 });
  writeFileSync(
    routes,
    JSON.stringify({
      "POST /channels/40/messages": { body: { id: "50" } },
      "PATCH /channels/40": { body: { id: "40" } },
    }),
  );
  writeFileSync(
    join(bin, "dori"),
    `#!/usr/bin/env bash
set -eu
[[ "$CATALY_CONFIG" == ${shq(configFile)} && "$DORI_CONFIG" == ${shq(configFile)} ]]
[[ "\${DORI_DISCORD_TOKEN:-}" == synthetic-inbound-token && ! "\${CATALY_DISCORD_TOKEN+x}" ]]
case "$1" in
  inbound)
    # Intake runs in the native monitor against the test's loopback Discord REST.
    export CATALY_DISCORD_NATIVE_BIN="\${CATALY_TEST_INBOUND_NATIVE_BIN:?}"
    export CATALY_DISCORD_API_BASE="\${CATALY_TEST_INBOUND_API:?}"
    exec ${shq(process.execPath)} --no-env-file ${shq(join(skill, "src/cli.ts"))} "$@" ;;
  presence) preload=${shq(join(skill, "test/record-gateway.ts"))} ;;
  *) preload=${shq(join(skill, "test/record-discord.ts"))} ;;
esac
exec ${shq(process.execPath)} --no-env-file --preload "$preload" ${shq(join(skill, "src/cli.ts"))} "$@"
`,
    { mode: 0o700 },
  );
  return {
    configFile,
    stateDir,
    fetchLog,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      DORI_HOME: join(home, "wrong-legacy-home"),
      DORI_CONFIG: join(home, "wrong-legacy-config.json"),
      CATALY_HOME: join(home, "wrong-current-home"),
      CATALY_CONFIG: join(home, "wrong-current-config.json"),
      CATALY_DISCORD_TOKEN: "wrong-canonical-fixture-token",
      DORI_DISCORD_TOKEN: "wrong-legacy-fixture-token",
      CATALY_DISCORD_OWNER_ID: "10",
      CATALY_DISCORD_CHANNEL_ID: "20",
      CATALY_TEST_FETCH_LOG: fetchLog,
      CATALY_TEST_DISCORD_ROUTES: routes,
      GATEWAY_CASE: "lifecycle",
    },
  };
}
