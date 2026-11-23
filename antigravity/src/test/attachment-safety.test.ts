import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { downloadDiscordAttachment } from "../discord/attachments.js";

const url = "https://cdn.discordapp.com/attachments/file.txt";
it("disables redirects before fetching an allowed attachment", async () => {
  let called = false;
  await assert.rejects(downloadDiscordAttachment(url, tmpdir(), { fetchImpl: (async (_url, init) => {
    called = true;
    assert.equal(init?.redirect, "error");
    throw new TypeError("redirect refused");
  }) as typeof fetch }), /redirect refused/);
  assert.equal(called, true);
});

it("cancels oversized chunked bodies without writing a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cataly-attachment-"));
  let cancelled = false;
  try {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(downloadDiscordAttachment(url, dir, { maxBytes: 4,
      fetchImpl: (async () => new Response(body)) as typeof fetch }), /byte limit/);
    assert.equal(cancelled, true);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("accepts an exact-limit stream and rejects an oversized content-length", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cataly-attachment-"));
  try {
    const saved = await downloadDiscordAttachment(url, dir, { maxBytes: 4,
      fetchImpl: (async () => new Response("test")) as typeof fetch });
    assert.equal(readFileSync(saved.savedPath, "utf8"), "test");
    await assert.rejects(downloadDiscordAttachment(url, dir, { maxBytes: 4,
      fetchImpl: (async () => new Response("large", { headers: { "content-length": "5" } })) as typeof fetch }), /byte limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
