import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "../src/update/config.ts";
import { freezeSource, sourceManifest } from "../src/update/source.ts";
import { fixture, it } from "./update-setup.ts";

it("local native session data and Cargo output never enter a frozen source input", () => {
  const f = fixture();
  const before = sourceManifest(f.localSource);
  f.write(f.localSource, ".cataly-native/lane.sessions/transcript.jsonl", "private session fixture\n");
  f.write(f.localSource, "target/release/cataly", "build output fixture\n");
  const output = join(f.directory, "native-source-snapshot");

  const frozen = freezeSource(f.localSource, output, "local");

  expect(frozen.hash).toBe(before.hash);
  expect(existsSync(join(output, ".cataly-native"))).toBe(false);
  expect(existsSync(join(output, "target"))).toBe(false);
  expect(() => freezeSource(f.localSource, join(f.directory, "upstream-snapshot"), "upstream")).toThrow(UpdateError);
});
