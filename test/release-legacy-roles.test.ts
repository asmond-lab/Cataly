import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import { installBundle } from "../src/release/install.ts";
import { archive, fixture, posix, withArchive } from "./release-consumer-setup.ts";

const cli = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");

async function historical(runtime: "hc" | "herdr") {
  const f = fixture(runtime === "hc");
  const old = f.release("v0.1.3 fixture");
  const archiveRoot = "omp-dori-0.1.3";
  const bytes = archive(
    old.entries.map((entry) => ({ ...entry, name: `${archiveRoot}/${entry.name.split("/").slice(1).join("/")}` })),
  );
  const manifest = withArchive(
    {
      ...old.bundle.manifest,
      tag: "v0.1.3",
      releaseVersion: "0.1.3",
      archive: { ...old.bundle.manifest.archive, name: "omp-dori-v0.1.3.tar.gz", root: archiveRoot },
    },
    bytes,
  );
  writeFileSync(f.paths.config, JSON.stringify({ runtime, stateDir: join(f.paths.cataly, "state"), keep: "owner" }));
  const installed = await installBundle(f.paths, { manifest, files: readArchive(bytes, manifest) }, undefined);
  const roles = join(f.paths.cataly, "roles.json");
  const original = runtime === "hc" ? '{"lead":"hc:t1","duty-loop":"hc:t2"}\n' : '{"lead":"w1:p1","duty":"w1:p2"}\n';
  writeFileSync(roles, original);
  return { ...f, installed, roles, original };
}

async function retire(home: string, env: Record<string, string>, ...flags: string[]) {
  const p = Bun.spawn([process.execPath, cli, "update", "retire-legacy-roles", "--home", home, ...flags], {
    // No ambient terminal identity, native OMP, provider credentials or binaries.
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, error] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, out, error };
}

async function listen(path: string, reply: (request: Record<string, unknown>) => unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const result = reply(JSON.parse(input));
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  await new Promise<void>((ready, fail) => {
    server.once("error", fail);
    server.listen(path, ready);
  });
  chmodSync(path, 0o700);
  return () => new Promise<void>((done) => server.close(() => done()));
}

posix("side retirement holds foreign, missing, unknown, and live endpoints before enabling install", async () => {
  const f = await historical("hc");
  const temp = mkdtempSync("/tmp/cly-");
  const env = { HOME: f.paths.home, XDG_RUNTIME_DIR: temp, HC_SESSION: "foreign" };
  const session = `omp-dori-${createHash("sha256").update(f.paths.cataly).digest("hex").slice(0, 12)}`;
  const socket = join(temp, `herdr-core/${session}.sock`);
  const pointer = readlinkSync(f.paths.live);
  const config = readFileSync(f.paths.config);
  const receipt = readFileSync(f.paths.state);
  const next = f.release("post-retirement");
  let stop: (() => Promise<void>) | undefined;
  try {
    await expect(installBundle(f.paths, next.bundle, f.installed)).rejects.toThrow("--retire-legacy-roles");
    let requests = 0;
    stop = await listen(join(temp, "herdr-core/foreign.sock"), () => {
      requests++;
      return {};
    });
    const missing = await retire(f.paths.cataly, env);
    expect(missing.code).toBe(2);
    expect(missing.error).toContain("No existing authoritative endpoint");
    expect(missing.error).toContain("new, empty home");
    expect(requests).toBe(0);
    expect(readFileSync(f.roles, "utf8")).toBe(f.original);
    await stop();
    stop = undefined;

    const calls: unknown[] = [];
    const lockSnapshots: boolean[] = [];
    let state = "live";
    let replacement: string | undefined;
    stop = await listen(socket, (request) => {
      calls.push(request);
      const params = request["params"];
      if (!params || typeof params !== "object" || !("terminal" in params)) return {};
      const terminal = params.terminal;
      lockSnapshots.push(
        [
          join(f.paths.cataly, "harness.lock"),
          join(f.paths.root, "consumer.lock"),
          join(f.paths.root, "consumer-launch.lock"),
        ].every((path) => existsSync(path)),
      );
      if (terminal === "t2" && replacement !== undefined) writeFileSync(f.roles, replacement);
      const envelope = { jsonrpc: "2.0", id: request["id"] };
      return terminal === "t1"
        ? { ...envelope, error: { code: -32000, message: "no terminal t1", data: { kind: "not_found" } } }
        : { ...envelope, result: { address: "t2", state } };
    });
    const wrong = await retire(f.paths.cataly, env, "--legacy-session", "foreign");
    expect(wrong.code).toBe(2);
    expect(wrong.error).toContain("fixes its own historical namespace");
    for (const observed of ["live", "unknown"]) {
      state = observed;
      const held = await retire(f.paths.cataly, env);
      expect(held.code).toBe(2);
      expect(held.error).toContain("still present or its exit is not proven");
      expect(readFileSync(f.roles, "utf8")).toBe(f.original);
    }
    state = "finished";
    replacement = '{"lead":"hc:t9"}\n';
    expect((await retire(f.paths.cataly, env)).error).toContain("Configuration changed during setup");
    expect(readFileSync(f.roles, "utf8")).toBe(replacement);
    replacement = undefined;
    writeFileSync(f.roles, f.original);
    const retirement = await retire(f.paths.cataly, env);
    expect(retirement.code, retirement.error).toBe(0);
    expect(JSON.parse(retirement.out)).toEqual({ retiredLegacyRoles: 2, home: f.paths.cataly });
    expect(calls).toEqual(
      Array.from({ length: 4 }, () =>
        ["t1", "t2"].map((terminal) => ({ jsonrpc: "2.0", id: 1, method: "terminal.get", params: { terminal } })),
      ).flat(),
    );
    expect(lockSnapshots).toEqual(Array(8).fill(true));
    expect(readFileSync(f.roles, "utf8")).toBe("{}\n");
    expect(readFileSync(f.paths.state)).toEqual(receipt);
    expect(readFileSync(f.paths.config)).toEqual(config);
    expect(readlinkSync(f.paths.live)).toBe(pointer);
    const updated = await installBundle(f.paths, next.bundle, f.installed);
    expect(updated.previous?.tag).toBe("v0.1.3");
    expect(updated.current.tag).toBe(next.bundle.manifest.tag);
  } finally {
    await stop?.();
    rmSync(temp, { recursive: true, force: true });
  }
});

posix("public primary retirement proves default and migrated roles together and holds live legacy state", async () => {
  const f = await historical("herdr");
  const temp = mkdtempSync("/tmp/cly-");
  const env = {
    HOME: f.paths.home,
    XDG_CONFIG_HOME: temp,
    XDG_RUNTIME_DIR: temp,
    DORI_STATE_DIR: join(f.paths.cataly, "historical-custom-state"),
    CATALY_STATE_DIR: join(f.paths.cataly, "different-ambient-state"),
  };
  let calls = 0;
  let gone = false;
  const stops: (() => Promise<void>)[] = [];
  try {
    stops.push(
      await listen(join(temp, "herdr/herdr.sock"), (request) => {
        calls++;
        if (request["method"] !== "pane.list") return {};
        return {
          id: request["id"],
          result: { type: "pane_list", panes: gone ? [{ pane_id: "w2:p1" }] : [{ pane_id: "w1:p2" }] },
        };
      }),
    );
    expect((await retire(f.paths.cataly, env)).error).toContain("did not record the herdr server name");
    expect(calls).toBe(0);
    const configured = ["--legacy-session", "default"];
    const flags = [...configured, "--legacy-migrated-session", "migration"];
    const state = join(env.DORI_STATE_DIR, "runtime");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "active.json"), JSON.stringify({ role: "dori", pid: process.pid }));
    expect((await retire(f.paths.cataly, env, ...flags)).error).toContain(`Live Cataly PID ${process.pid}`);
    expect(calls).toBe(0);
    rmSync(join(state, "active.json"));
    for (const kind of ["duty", "loop"]) {
      const lock = join(f.paths.cataly, kind, "lock");
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "legacy-holder" }));
      const held = await retire(f.paths.cataly, env, ...flags);
      expect(held.code).toBe(2);
      expect(held.error).toContain(`Live Cataly PID ${process.pid} holds ${kind}/lock`);
      expect(calls).toBe(0);
      expect(readFileSync(f.roles, "utf8")).toBe(f.original);
      rmSync(lock);
    }
    const foreign = '{"lead":"w1:p1","duty":"hc:remote/t2"}\n';
    writeFileSync(f.roles, foreign);
    expect((await retire(f.paths.cataly, env, ...flags)).error).toContain("foreign role registration");
    expect(calls).toBe(0);
    expect(readFileSync(f.roles, "utf8")).toBe(foreign);
    const mixed = '{"duty":"w1:p2","lead":"hc:t7"}\n';
    writeFileSync(f.roles, mixed);
    expect((await retire(f.paths.cataly, env, ...configured)).error).toContain("--legacy-migrated-session");
    expect(calls).toBe(0);
    expect((await retire(f.paths.cataly, env, ...flags)).error).toContain("w1:p2 is still present");
    expect(readFileSync(f.roles, "utf8")).toBe(mixed);
    gone = true;
    expect((await retire(f.paths.cataly, env, ...flags)).error).toContain("No existing authoritative endpoint");
    expect(readFileSync(f.roles, "utf8")).toBe(mixed);
    let migrated = "live";
    stops.push(
      await listen(join(temp, "herdr-core/migration.sock"), (request) => ({
        jsonrpc: "2.0",
        id: request["id"],
        result: { address: "t7", state: migrated },
      })),
    );
    expect((await retire(f.paths.cataly, env, ...flags)).error).toContain("hc:t7 is still present");
    expect(readFileSync(f.roles, "utf8")).toBe(mixed);
    migrated = "finished";
    const result = await retire(f.paths.cataly, env, ...flags);
    expect(result.code, result.error).toBe(0);
    expect(JSON.parse(result.out).retiredLegacyRoles).toBe(2);
    expect(readFileSync(f.roles, "utf8")).toBe("{}\n");
  } finally {
    for (const stop of stops) await stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
