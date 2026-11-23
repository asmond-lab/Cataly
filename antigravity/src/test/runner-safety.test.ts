import assert from "node:assert/strict";
import { it } from "node:test";
import { checkDone, defaultRunner, requiresWindowsShell } from "../core/signals.js";

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

it("reports the published signal boundary on Windows without invoking npm", async () => {
  let calls = 0;
  const runner = async (argv: readonly string[]) => {
    calls++;
    assert.deepEqual(argv, ["npm", "view", "example@1.2.3", "version", "--json"]);
    return { code: 0, out: JSON.stringify("1.2.3"), err: "" };
  };
  const windows = await checkDone("published example@1.2.3", runner, { platform: "win32" });
  assert.equal(windows[0]?.ok, false);
  assert.match(windows[0]?.detail ?? "", /published signals are unsupported on Windows/);
  assert.equal(calls, 0);
  const posix = await checkDone("published example@1.2.3", runner, { platform: "linux" });
  assert.equal(posix[0]?.ok, true);
  assert.equal(calls, 1);
});
