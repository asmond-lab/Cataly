import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrate.ts";
import { refText } from "../src/refs.ts";
import { Refusal } from "../src/refusal.ts";
import { readJournal, writeJournal } from "../src/store-journal.ts";
import { controllerTerminals } from "./controller-migration-setup.ts";
import { href } from "./fake.ts";
import { migrateWorld, OLD, rolesWorld } from "./migrate-setup.ts";

describe("cataly migrate: roles and loops", () => {
  test("bulk migration holds before opening a replacement when a headless role is registered", async () => {
    const { w, d, opts } = rolesWorld();
    const native = { runtime: "headless", id: "9fb0af3f-aad9-4384-b052-e5953b40d960" } as const;
    d.store.setRole("hourly-loop", native);
    expect(d.store.roles()["hourly-loop"]).toEqual(native);

    await expect(migrate(d, { all: true }, opts())).rejects.toThrow(/headless role hourly-loop/);

    expect(d.store.roles()["hourly-loop"]).toEqual(native);
    expect(d.store.lane("k")?.sessionRef).toEqual(OLD);
    expect(w.calls).toEqual([]);
    expect(w.hc.terminals.size).toBe(0);
    expect(readJournal(d.store.root, "hourly-loop")).toBeUndefined();
  });

  test("a terminal migration preview uses the legacy runtime when --to is omitted", () => {
    const { d } = rolesWorld();
    const config = join(d.store.root, "config.json");
    writeFileSync(config, JSON.stringify({ runtime: "hc" }));
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "migrate", "--role", "hourly-loop", "--dry-run"],
      { env: { PATH: process.env["PATH"], CATALY_HOME: d.store.root, CATALY_CONFIG: config } },
    );

    expect({ code: child.exitCode, message: child.stdout.toString().trim() }).toEqual({
      code: 0,
      message: "PLAN hourly-loop w1:p5 -> hc (inbox entries: 0)",
    });
    expect(d.store.roles()["hourly-loop"]).toEqual(href("w1:p5"));
  });

  test("lead: handoff from its prompt file, roles.json switched, its inbox moved", async () => {
    const { w, d, lines, opts } = rolesWorld();
    const observation = "- (2026-11-19) Local profile migration marker.";
    writeFileSync(join(d.store.root, "owner.md"), `${observation}\n`);
    d.store.saveInbox(href("w1:p1"), [{ at: 1, from: "k", text: "[REPORT k] hi" }]);
    expect(await migrate(d, { role: "lead" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED lead w1:p1 -> hc:t1"]);
    expect(refText(d.store.roles().lead!)).toBe("hc:t1");
    const start = w.hc.sent[0]!.text;
    expect(start).toStartWith("omo --append-system-prompt ");
    const brief = start.split(" ").at(-1)!.replaceAll("'", "");
    const handoff = readFileSync(brief, "utf8");
    expect(handoff).toContain("## Handoff");
    expect(handoff).toContain("cataly owner show");
    expect(handoff).not.toContain(observation);
    expect(d.store.queued({ runtime: "hc", id: "t1" }).map((m) => m.text)).toEqual(["[REPORT k] hi"]);
  });

  test("--all: lanes first, then lead and duty, the loops last", async () => {
    const { w, d, lines, opts } = rolesWorld();
    const f = controllerTerminals(w, d);
    try {
      await Promise.all([f.source("duty-loop", href("w1:p4")), f.source("hourly-loop", href("w1:p5"))]);
      const sleep = opts().sleep;
      expect(
        await migrate(
          d,
          { all: true },
          opts({
            sleep: async (ms) => {
              await f.sleep(ms);
              await sleep(ms);
            },
          }),
        ),
      ).toBe(0);
      expect(lines.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
        "MIGRATED k",
        "MIGRATED lead",
        "MIGRATED duty",
        "MIGRATED duty-loop",
        "MIGRATED hourly-loop",
      ]);
    } finally {
      await f.closeActors();
    }
  });
});

describe("cataly migrate --resume and refusals", () => {
  test("--resume is refused when no session path is recorded", async () => {
    const { w, d, opts } = migrateWorld();
    await expect(migrate(d, { lane: "k" }, opts({ resume: true }))).rejects.toThrow(/no recorded session path/);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(w.hc.terminals.size).toBe(0);
  });

  test("--resume is refused on a working source, never retried as a resume", async () => {
    const { w, d, opts } = migrateWorld("working");
    d.store.saveLane({ ...d.store.lane("k")!, sessionPath: "/s/k.jsonl" });
    await expect(migrate(d, { lane: "k" }, opts({ resume: true }))).rejects.toThrow(/is working/);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(w.hc.terminals.size).toBe(0);
  });

  test("--resume on an idle source opens the agent on its recorded session, no checkpoint ask", async () => {
    const { w, d, lines, opts } = migrateWorld();
    d.store.saveLane({ ...d.store.lane("k")!, sessionPath: "/s/k.jsonl" });
    expect(await migrate(d, { lane: "k" }, opts({ resume: true }))).toBe(0);
    expect(w.hc.sent[0]!.text).toBe("omo --session '/s/k.jsonl'");
    expect(w.panes.get("w1:p3")).toBeUndefined();
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
  });

  test("OMP resumes the live extension session file with its lane role and configured model", async () => {
    const { w, d, opts } = migrateWorld();
    const rt = d.runtimes.for(OLD);
    const probe = rt.probe.bind(rt);
    rt.probe = async (ref) => ({ ...(await probe(ref)), sessionFile: "/synthetic/current.jsonl" });
    d.store.saveLane({ ...d.store.lane("k")!, sessionPath: "/synthetic/old.jsonl" });
    expect(await migrate({ ...d, agentCmd: "omp --model selected/model" }, { lane: "k" }, opts({ resume: true }))).toBe(
      0,
    );
    expect(w.hc.sent[0]!.text).toBe(
      "omp --model selected/model --cataly-role lane --resume='/synthetic/current.jsonl'",
    );
  });

  test("OMP lead replacements select the Cataly role", async () => {
    const { w, d, opts } = rolesWorld();
    expect(await migrate({ ...d, agentCmd: "omp" }, { role: "lead" }, opts())).toBe(0);
    expect(w.hc.sent[0]!.text).toStartWith("omp --cataly-role cataly --append-system-prompt ");
  });

  test("a migration already running for the name is refused", async () => {
    const { d, opts } = migrateWorld();
    mkdirSync(join(d.store.root, "migrate"), { recursive: true });
    writeFileSync(
      join(d.store.root, "migrate", "k.lock"),
      JSON.stringify({ pid: process.pid, host: hostname(), at: 1 }),
    );
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(Refusal);
  });

  test("a journal toward another runtime is refused, not overwritten", async () => {
    const { d, opts } = migrateWorld();
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "herdr", at: 1 });
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(/in progress toward herdr/);
    expect(readJournal(d.store.root, "k")!.to).toBe("herdr");
  });
});
