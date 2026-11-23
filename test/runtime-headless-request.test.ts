import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runContext } from "../skills/cataly-mode/scripts/src/lane-run.ts";
import { launchLane } from "../skills/cataly-mode/scripts/src/launch.ts";
import { parkLane } from "../skills/cataly-mode/scripts/src/park.ts";
import { Reports } from "../skills/cataly-mode/scripts/src/reports.ts";
import { reopenLane } from "../skills/cataly-mode/scripts/src/reopen.ts";
import { HeadlessRuntime } from "../src/runtime/headless.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { headlessFixture, noExternal } from "./fixtures/runtime-headless.ts";

test.skipIf(process.platform === "win32")(
  "sourced headless launch and reopen bind two distinct runs to the same transcript",
  async () => {
    const f = headlessFixture();
    const runtime = new HeadlessRuntime(f.stateDir, f.env);
    const refs: SessionRef[] = [];
    const requestId = "discord:111111111111111111:222222222222222222";
    try {
      const launched = await launchLane(f.deps, { ...f.input, requestId });
      const initial = launched.lane;
      if (initial.sessionRef) refs.push(initial.sessionRef);
      expect(launched.startup).toStartWith("STARTUP_OK");
      expect(initial.sessionRef?.runtime).toBe("headless");
      if (!initial.runId) throw new Error("missing original run ID");
      const reports = new Reports(f.stateDir);
      expect(runContext(reports, initial, initial.runId)).toMatchObject({
        generation: initial.lifecycleEpoch,
        provenance: {
          requestId,
          runId: initial.runId,
          nativeRef: { sessionId: initial.session, ref: initial.sessionRef },
        },
      });
      const parked = await parkLane(f.deps, initial, "fixture park");
      expect(parked.code).toBe(0);
      const opened = await reopenLane(
        {
          ...f.deps,
          run: (argv) =>
            argv[0] === "hc" ? Promise.resolve({ code: 0, out: '{"terminals":[]}', err: "" }) : noExternal(argv),
        },
        parked.lane,
      );
      const next = opened.lane;
      if (next.sessionRef) refs.push(next.sessionRef);
      expect(opened.code).toBe(0);
      expect(next.session).toBe(initial.session);
      expect(next.sessionRef?.runtime).toBe("headless");
      expect(next.sessionRef?.id).not.toBe(initial.sessionRef?.id);
      if (!next.runId) throw new Error("missing resumed run ID");
      expect(next.runId).not.toBe(initial.runId);
      expect(runContext(reports, next, next.runId)).toMatchObject({
        generation: next.lifecycleEpoch,
        provenance: { requestId, runId: next.runId, nativeRef: { sessionId: next.session, ref: next.sessionRef } },
      });
      expect(
        reports
          .events(next.key)
          .filter((event) => event.type === "execution")
          .map(({ phase, runId }) => [phase, runId]),
      ).toEqual([
        ["started", initial.runId],
        ["bound", initial.runId],
        ["started", next.runId],
        ["bound", next.runId],
      ]);
    } finally {
      for (const ref of refs) await runtime.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);
