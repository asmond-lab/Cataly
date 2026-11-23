import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultRunner, requiresWindowsShell } from "../core/signals.js";

it("refuses Windows batch shims instead of using a shell", () => {
  for (const cmd of ["npm", "npx", "NPM", "npm.cmd", "build.BAT", "C:/tools/build.cmd"]) {
    assert.equal(requiresWindowsShell(cmd, "win32"), true);
    assert.equal(requiresWindowsShell(cmd, "linux"), false);
  }
  assert.equal(requiresWindowsShell("node.exe", "win32"), false);
});

it("preserves literal argv metacharacters for native executables", async () => {
  const text = "literal & | > < ^ %PATH% test";
  const result = await defaultRunner([process.execPath, "-e", "process.stdout.write(process.argv[1])", text]);
  assert.equal(result.code, 0);
  assert.equal(result.out, text);
});
