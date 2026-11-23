import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, statSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CatalyUpdater } from "../src/update/controller.ts";
import type { DetectionReceipt } from "../src/update/detection-process.ts";
import { acknowledgeStopped, restoreUpdate, snapshotUpdate } from "../src/update/recovery.ts";
import { sourceManifest } from "../src/update/source.ts";
import { persistJob, persistState, readState, saveJson, transition } from "../src/update/state.ts";
import { fixture, git, posixSuite } from "./update-setup.ts";

// Report progress before the CI test deadline, without logging command arguments, paths or output.
async function observedCycle(updater: CatalyUpdater, phase: string, trigger?: "stage") {
  const detector = join(updater.context.config.root, "detector");
  const since = Date.now();
  const report = () => {
    try {
      const started = JSON.parse(readFileSync(join(detector, "detection-started.json"), "utf8")) as {
        readonly receiptPath: string;
      };
      const receipt = JSON.parse(readFileSync(started.receiptPath, "utf8")) as DetectionReceipt;
      if (Date.parse(receipt.startedAt) < since) {
        console.error("updater fixture", { phase, detection: "not started for this cycle" });
        return;
      }
      console.error("updater fixture", {
        phase,
        exitCode: receipt.exitCode,
        signal: receipt.signal,
        finished: receipt.finishedAt !== undefined,
        hadError: receipt.error !== undefined,
        stdoutBytes: statSync(receipt.stdout, { throwIfNoEntry: false })?.size,
        stderrBytes: statSync(receipt.stderr, { throwIfNoEntry: false })?.size,
        outputComplete: receipt.detector?.outputComplete,
        stopReason: receipt.detector?.reason,
      });
    } catch (error) {
      console.error("updater fixture", { phase, readErrorKind: error instanceof Error ? error.name : typeof error });
    }
  };
  const diagnostic = setTimeout(report, 15_000);
  diagnostic.unref();
  try {
    return await updater.once(trigger);
  } catch (error) {
    report();
    throw error;
  } finally {
    clearTimeout(diagnostic);
  }
}

posixSuite("Cataly staged updater", () => {
  test("automatic baseline observation does no port; manual current-head staging propagates failure and deduplicates across restart", async () => {
    const f = fixture();
    expect(await observedCycle(f.updater, "observe baseline")).toEqual({ outcome: "unchanged" });
    expect(Object.keys(readState(f.updater.context).jobs)).toHaveLength(0);
    f.write(f.localSource, "src/behavior.ts", "export const behavior = 'local OMP adaptation';\n");
    f.write(f.localSource, "src/new-adaptation.ts", "export const added = true;\n");
    f.write(f.localSource, "config.json", '{"token":"private fixture config"}');
    const result = await observedCycle(f.updater, "stage current head", "stage");
    const job = result.job!;
    expect(result.outcome).toBe("candidate");
    expect(job.phase).toBe("failed");
    expect(job.history.map((h) => h.phase)).toEqual(["prepared", "porting", "failed"]);
    expect(job.commands.at(-1)?.exitCode).toBe(1);
    expect(job.commands.some((r) => r.name === "types" || r.name === "review")).toBe(false);
    expect(job.inputs?.changedPaths).toContain("src/new-adaptation.ts");
    expect(readFileSync(join(job.directory, "inputs", "local", "src", "behavior.ts"), "utf8")).toContain(
      "local OMP adaptation",
    );
    expect(existsSync(join(job.directory, "inputs", "local", "config.json"))).toBe(false);
    const before = readFileSync(join(job.directory, "job.json"), "utf8");
    const restarted = new CatalyUpdater(f.config, (event) => f.events.push(event));
    expect((await observedCycle(restarted, "restart after staging", "stage")).outcome).toBe("duplicate");
    expect(readFileSync(join(job.directory, "job.json"), "utf8")).toBe(before);
    expect(readState(restarted.context).active).toBeUndefined();
    expect(JSON.parse(readFileSync(join(job.directory, "report.json"), "utf8")).phase).toBe("failed");
  });

  test("a real changed ref is pinned while local source and its Git metadata are untouched", async () => {
    const f = fixture();
    const before = sourceManifest(f.localSource).hash;
    f.write(f.remote, "src/behavior.ts", "export const behavior = 2;\n");
    git(f.remote, "add", ".");
    git(f.remote, "commit", "-m", "Cataly upstream behavior change");
    const head = git(f.remote, "rev-parse", "HEAD");
    const result = await f.updater.once();
    expect(result.job?.upstream).toBe(head);
    expect(git(result.job!.candidate, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(result.job!.candidate, ".git", "objects", "info", "alternates"))).toBe(false);
    expect(result.job?.inputs?.baseUpstream).toBe(f.config.baseUpstream);
    expect(result.job?.inputs?.incoming.hash).not.toBe(result.job?.inputs?.base.hash);
    expect(sourceManifest(f.localSource).hash).toBe(before);
    expect(existsSync(join(f.localSource, ".git"))).toBe(false);
    expect((await f.updater.once()).outcome).toBe("duplicate");
  });

  test("restart holds interrupted ownership until the exact stopped job is acknowledged; no automatic re-port", async () => {
    const f = fixture();
    const job = (await f.updater.once("stage")).job!;
    job.phase = "porting";
    persistJob(job);
    const state = readState(f.updater.context);
    state.active = job.id;
    persistState(f.updater.context, state);
    saveJson(join(f.config.root, "controller.lock"), {
      version: 1,
      pid: 2147483647,
      host: hostname(),
      nonce: "dead-controller",
      at: new Date().toISOString(),
    });
    await expect(f.updater.once()).rejects.toThrow("interrupted controller lock");
    expect(() => acknowledgeStopped(f.updater.context, "0".repeat(64))).toThrow("exact active job");
    const recovered = acknowledgeStopped(f.updater.context, job.id)!;
    expect(recovered.phase).toBe("interrupted");
    expect(readState(f.updater.context).active).toBeUndefined();
    expect((await f.updater.once("stage")).outcome).toBe("duplicate");
    expect(() => transition(f.updater.context, recovered, "ready")).toThrow("invalid updater transition");
  });

  test("an idle watcher crash requires explicit stopped-controller acknowledgement and spends no model run", async () => {
    const f = fixture();
    await f.updater.once();
    saveJson(join(f.config.root, "controller.lock"), {
      version: 1,
      pid: 2147483647,
      host: hostname(),
      nonce: "idle-controller",
      at: new Date().toISOString(),
    });
    await expect(f.updater.once()).rejects.toThrow("interrupted controller lock");
    expect(acknowledgeStopped(f.updater.context, "none")).toBeUndefined();
    expect((await f.updater.once()).outcome).toBe("unchanged");
    expect(Object.keys(readState(f.updater.context).jobs)).toHaveLength(0);
  });

  test("a failed reporter is retained once and never resent by a restarted updater", async () => {
    const f = fixture();
    const config = { ...f.config, reporter: { name: "notify", argv: ["false", "{text}"], timeoutMs: 10_000 } };
    const updater = new CatalyUpdater(config, (event) => f.events.push(event));
    const result = await observedCycle(updater, "stage with failing reporter", "stage");
    const job = result.job!;
    expect(result.outcome).toBe("candidate");
    expect(job.phase).toBe("failed");
    expect(job.notification).toEqual({ state: "failed", exitCode: 1 });
    expect(readState(updater.context).active).toBeUndefined();
    const restarted = new CatalyUpdater(config, (event) => f.events.push(event));
    expect((await observedCycle(restarted, "restart after reporting", "stage")).outcome).toBe("duplicate");
    expect(job.commands.filter((receipt) => receipt.name === "notify")).toHaveLength(1);
    expect(JSON.stringify(f.events)).not.toContain(f.directory);
  });

  test("a reporter killed after it started is ambiguous: retained, reported, never resent, verdict unaffected", async () => {
    const f = fixture();
    const reporter = { name: "notify", argv: ["sh", "-c", "exec sleep 30", "notify", "{text}"], timeoutMs: 100 };
    const config = { ...f.config, reporter };
    const updater = new CatalyUpdater(config, (event) => f.events.push(event));
    const job = (await updater.once("stage")).job!;
    expect(job.phase).toBe("failed");
    expect(job.notification?.state).toBe("ambiguous");
    expect(readState(updater.context).active).toBeUndefined();
    const restarted = new CatalyUpdater(config, (event) => f.events.push(event));
    const again = await restarted.once("stage");
    expect(again.outcome).toBe("duplicate");
    expect(again.job?.commands.filter((receipt) => receipt.name === "notify")).toHaveLength(1);
  });

  test("acknowledging a stopped controller keeps a complete verdict instead of rewriting it as interrupted", async () => {
    const f = fixture();
    const job = (await f.updater.once("stage")).job!;
    expect(job.phase).toBe("failed");
    const state = readState(f.updater.context);
    state.active = job.id;
    persistState(f.updater.context, state);
    job.notification = { state: "sending" };
    persistJob(job);
    const kept = acknowledgeStopped(f.updater.context, job.id)!;
    expect(kept.phase).toBe("failed");
    expect(kept.notification?.state).toBe("ambiguous");
    expect(readState(f.updater.context).active).toBeUndefined();
  });

  test("source and task-state recovery restores a fresh copy with no readiness or writes to the original", async () => {
    const f = fixture();
    const job = (await f.updater.once("stage")).job!;
    const before = sourceManifest(job.candidate).hash;
    const snapshot = snapshotUpdate(f.updater.context, job.id, join(f.directory, "snapshot"));
    f.write(job.candidate, "src/behavior.ts", "export const behavior = 'perturbed';\n");
    const restored = restoreUpdate(f.updater.context, snapshot, join(f.directory, "restored"));
    expect(sourceManifest(join(restored, "candidate")).hash).toBe(before);
    expect(sourceManifest(job.candidate).hash).not.toBe(before);
    expect(JSON.parse(readFileSync(join(restored, "job.json"), "utf8")).phase).toBe("interrupted");
    expect(JSON.parse(readFileSync(join(restored, "state.json"), "utf8")).candidateOnly).toBe(true);
    const originalLocal = sourceManifest(f.localSource).hash;
    expect(() => restoreUpdate(f.updater.context, snapshot, f.localSource)).toThrow();
    expect(sourceManifest(f.localSource).hash).toBe(originalLocal);
    f.write(snapshot, "task-state/job.json", "{}");
    const corruptOutput = join(f.directory, "corrupt-restored");
    expect(() => restoreUpdate(f.updater.context, snapshot, corruptOutput)).toThrow();
    expect(existsSync(corruptOutput)).toBe(false);
  });

  test("recovery protects the real live source behind a lexical source symlink before creating output", async () => {
    const f = fixture();
    const job = (await f.updater.once("stage")).job!;
    const release = join(f.directory, "live-release");
    renameSync(f.localSource, release);
    symlinkSync(release, f.localSource, "dir");
    const config = structuredClone(f.config);
    const source = join(release, "src/behavior.ts");
    const bytes = readFileSync(source);
    const before = sourceManifest(release).hash;
    const candidate = sourceManifest(job.candidate).hash;
    const snapshot = snapshotUpdate(f.updater.context, job.id, join(f.directory, "snapshot"));
    expect(sourceManifest(join(snapshot, "source")).hash).toBe(candidate);
    for (const operation of ["snapshot", "restore"] as const) {
      const output = join(release, `${operation}-output`);
      expect(() =>
        operation === "snapshot"
          ? snapshotUpdate(f.updater.context, job.id, output)
          : restoreUpdate(f.updater.context, snapshot, output),
      ).toThrow("recovery output must be a fresh directory separate");
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(source)).toEqual(bytes);
      expect(sourceManifest(release).hash).toBe(before);
      expect(f.updater.context.config).toEqual(config);
    }
    const restored = restoreUpdate(f.updater.context, snapshot, join(f.directory, "restored"));
    expect(sourceManifest(join(restored, "candidate")).hash).toBe(candidate);
    expect(readFileSync(source)).toEqual(bytes);
    expect(sourceManifest(release).hash).toBe(before);
    expect(f.updater.context.config.localSource).toBe(f.localSource);
  });
});
