import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type CatalyConfig, fill } from "./config.ts";
import type { Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";
import {
  parseUsage,
  type SupervisedLane,
  type SupervisionOptions,
  type Usage,
  type UsageSnapshot,
} from "./supervision-observe.ts";
import { collectOmpUsage } from "./usage-omp.ts";

type CostDeps = {
  readonly run: Runner;
  readonly clock: Pick<Clock, "now">;
  readonly reports: Reports;
  readonly config?: Pick<CatalyConfig, "stateDir" | "sessionsDir" | "defaultCwd">;
};

export class SupervisionCost {
  constructor(
    private readonly deps: CostDeps,
    private readonly options: SupervisionOptions,
  ) {}

  async usage(lane: SupervisedLane, now: number): Promise<UsageSnapshot> {
    if (this.options.usage === "omp" && this.deps.config) {
      const observation = await collectOmpUsage(this.deps.config, lane, now);
      return {
        key: lane.key,
        openedAt: lane.openedAt,
        at: observation.at,
        ...observation.total,
        costBasis: observation.costBasis,
        issues: observation.issues,
      };
    }
    let usage: Usage = { tokens: null, costUsd: null };
    if (this.options.usageArgv?.length) {
      const result = await this.deps.run(
        fill(this.options.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code === 0) usage = parseUsage(result.out);
    }
    return { key: lane.key, openedAt: lane.openedAt, at: new Date(now).toISOString(), ...usage };
  }

  private costPath(key: string): string {
    return join(dirname(this.deps.reports.path(key)), "cost.jsonl");
  }

  record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot> {
    // Record each openedAt generation once; retries reuse the final reading and stable {closeKey}.
    const path = this.costPath(lane.key);
    const recorded = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as UsageSnapshot)
          .findLast(
            (entry) =>
              entry.final === true &&
              (entry.openedAt === lane.openedAt ||
                (entry.openedAt === undefined && Date.parse(entry.at) >= Date.parse(lane.openedAt))),
          )
      : undefined;
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now());
    if (this.options.recordCostArgv?.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(
        fill(this.options.recordCostArgv, {
          key: lane.key,
          session: lane.session ?? "",
          tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
          costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd),
          at: snapshot.at,
          closeKey: `${lane.key}@${lane.openedAt}`,
        }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}
