import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownerPaths, TEMPLATE } from "../src/owner.ts";
import { href } from "./fake.ts";
import { setup } from "./loop-setup.ts";

const at = (day: number, hour: number): number => new Date(2026, 10, day, hour, 0).getTime();

function distillWorld(opts: { lead?: boolean } = {}) {
  const s = setup(opts);
  s.w.clock = at(20, 22);
  const root = s.d.store.root;
  const config = (value: unknown) => writeFileSync(join(root, "config.json"), JSON.stringify(value));
  const profile = () => writeFileSync(ownerPaths(root).profile, TEMPLATE);
  const requests = () => s.lead.received.filter((m) => m.includes("[OWNER-DISTILL"));
  return { ...s, root, config, profile, requests };
}

describe("owner distill from the hourly loop", () => {
  test("off unless both the profile and ownerDistillHour exist, and never without a lead", async () => {
    const a = distillWorld();
    a.profile();
    expect((await a.tick()).distill).toBeUndefined();
    const b = distillWorld();
    b.config({ ownerDistillHour: 21 });
    expect((await b.tick()).distill).toBeUndefined();
    const c = distillWorld({ lead: false });
    c.config({ ownerDistillHour: 21 });
    c.profile();
    expect((await c.tick()).distill).toBeUndefined();
    for (const s of [a, b, c]) expect(s.requests()).toEqual([]);
  });

  test("asks the lead once a day from the configured local hour, with the rendered procedure", async () => {
    const { w, root, config, profile, tick, requests } = distillWorld();
    config({ ownerDistillHour: 23 });
    profile();
    expect((await tick()).distill).toBeUndefined();
    w.clock = at(20, 23);
    const run = await tick();
    const procedure = join(root, "prompts", "owner-distill-2026-11-20.md");
    expect(run.distill).toBe(
      `[OWNER-DISTILL 2026-11-20] Update the owner profile once for today: read ${procedure} and follow it.`,
    );
    expect(requests()).toHaveLength(1);
    const text = readFileSync(procedure, "utf8");
    expect(text).toContain("Run `cataly owner snapshot`.");
    expect(text).toContain(join(root, "owner-history", "2026-11-20.md"));
    expect(text).toContain("`(replaces: <the old entry text, verbatim>)`");
    expect(text).not.toMatch(/\{\{\w+\}\}/);
    w.clock = at(20, 23) + 30 * 60_000;
    expect((await tick()).distill).toBeUndefined();
    w.clock = at(21, 23);
    expect((await tick()).distill).toStartWith("[OWNER-DISTILL 2026-11-21]");
    expect(requests()).toHaveLength(2);
    expect(readFileSync(procedure, "utf8")).toBe(text);
  });

  test("does not consume the day until the current lead inbox admits the distill request", async () => {
    const { w, d, config, profile, tick, requests } = distillWorld();
    config({ ownerDistillHour: 21 });
    profile();
    const leadRef = href("w1:p1");
    const release = d.store.lockInbox(leadRef, w.clock);
    if (release === undefined) throw new Error("fixture could not hold lead inbox");
    try {
      expect((await tick()).distill).toBeUndefined();
      expect(d.store.queued(leadRef).some((message) => message.text.includes("[OWNER-DISTILL"))).toBe(false);
    } finally {
      release();
    }
    expect((await tick()).distill).toStartWith("[OWNER-DISTILL 2026-11-20]");
    expect(requests()).toHaveLength(1);
    expect((await tick()).distill).toBeUndefined();
    expect(requests()).toHaveLength(1);
  });

  test("a bad ownerDistillHour is a finding and the run goes on", async () => {
    const { config, profile, tick } = distillWorld();
    config({ ownerDistillHour: "night" });
    profile();
    const run = await tick();
    expect(run.distill).toBeUndefined();
    expect(run.findings).toEqual([
      'owner distill: config.json: ownerDistillHour must be a whole hour from 0 to 23, got "night"',
    ]);
  });
});
