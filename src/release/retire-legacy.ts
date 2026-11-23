import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { retireHistoricalRegistrations, type LegacySessionSelection } from "../harness-legacy.ts";
import { withHarnessLock } from "../harness-native.ts";
import { assertSetupFile, captureSetupFile, readSetupFile } from "../setup-files.ts";
import { object } from "../update/config.ts";
import {
  acquireConsumerLock,
  type ConsumerPaths,
  consumerPaths,
  isPrimaryConsumer,
  owned,
  readJson,
  regularFile,
} from "./files.ts";
import { assertNoConsumerLaunches, waitLaunchGate } from "./launch-leases.ts";
import { assertStoppedRuntime } from "./live.ts";
import { assertInstalledPointer, loadInstalled, verifyRelease } from "./state.ts";

async function retireOwnedLegacyRoles(paths: ConsumerPaths, sessions: LegacySessionSelection): Promise<number> {
  if (regularFile(paths.journal))
    throw new Error(
      "An interrupted activation journal holds historical retirement; preserve the installation for inspection",
    );
  const state = loadInstalled(paths);
  if (
    paths.layout !== "legacy" ||
    state?.current.tag !== "v0.1.3" ||
    state.current.source.files.some((file) => file.path === "release-headless.json")
  )
    throw new Error("Historical retirement requires the installed v0.1.3 consumer and its original home");
  assertInstalledPointer(paths, state);
  verifyRelease(paths, state.current);
  const config = captureSetupFile(paths.config);
  const bytes = readSetupFile(config);
  const value: unknown = bytes && JSON.parse(bytes.toString("utf8"));
  const runtime = object(value) ? value["runtime"] : undefined;
  if (runtime !== "hc" && runtime !== "herdr")
    throw new Error("Historical config must identify its original terminal runtime; no registrations were changed");
  const lock = join(paths.cataly, "harness.lock");
  if (regularFile(lock)) {
    const holder = readJson(lock);
    if (
      !object(holder) ||
      typeof holder["pid"] !== "number" ||
      !Number.isSafeInteger(holder["pid"]) ||
      holder["pid"] <= 0 ||
      typeof holder["nonce"] !== "string" ||
      !holder["nonce"]
    )
      throw new Error("Uncertain harness lock holds historical retirement; preserve the installation for inspection");
  }
  const d = { store: { root: paths.cataly, lockPath: () => lock }, now: Date.now };
  return withHarnessLock(d, async () => {
    const gate = await waitLaunchGate(paths);
    try {
      const stopped = () => {
        assertNoConsumerLaunches(paths);
        assertInstalledPointer(paths, state);
        assertSetupFile(config);
        assertStoppedRuntime(paths);
      };
      stopped();
      return await retireHistoricalRegistrations(
        {
          home: paths.home,
          root: paths.cataly,
          primary: isPrimaryConsumer(paths),
          runtime,
          sessions,
        },
        stopped,
      );
    } finally {
      gate();
    }
  });
}

/** Explicit maintenance only; install, rollback and automatic activation never retire registrations. */
export async function runRetireLegacyCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      home: { type: "string" },
      "legacy-session": { type: "string" },
      "legacy-migrated-session": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "cataly update retire-legacy-roles --home PATH [--legacy-session NAME] [--legacy-migrated-session NAME]",
    );
    return 0;
  }
  if (!values.home || !isAbsolute(values.home))
    throw new Error("retire-legacy-roles requires the absolute --home of the stopped v0.1.3 installation");
  const paths = consumerPaths(homedir(), values.home);
  const owner = readJson(join(paths.root, "consumer-owner.json"));
  if (JSON.stringify(owner) !== JSON.stringify({ version: 1, home: paths.home, liveSource: paths.live }))
    throw new Error("Historical consumer ownership differs; no registrations were changed");
  owned(paths.cataly);
  owned(paths.root);
  const unlock = acquireConsumerLock(paths);
  try {
    const retired = await retireOwnedLegacyRoles(paths, {
      configured: values["legacy-session"],
      migrated: values["legacy-migrated-session"],
    });
    console.log(JSON.stringify({ retiredLegacyRoles: retired, home: paths.cataly }));
    return 0;
  } finally {
    unlock();
  }
}
