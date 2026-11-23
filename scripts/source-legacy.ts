import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonical } from "../src/update/config.ts";

const oldCli = "skills/dori-mode/scripts/src/cli.ts";
// The two forms Bash printf %q emits for a nonempty value: a backslash-escaped
// word, or an ANSI-C quoted word. Neither is passed to a shell for evaluation.
const word = String.raw`(?:[^\x00-\x20\\'"$\x60|&;()<>*?\[\]{}#!~]|\\[^\r\n])+|\$'(?:[^\\'\r\n]|\\.)*'`;
const sessionLine = new RegExp(`^export HC_SESSION=(${word})$`, "u");
const wrapperEnv = new RegExp(`^\\. (${word})$`, "u");
const wrapperExec = new RegExp(`^exec (${word}) (${word}) "\\$@"$`, "u");
const ansiEscape = String.raw`\\(?:[abEefnrtv\\'"]|[0-7]{1,3}|x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8})`;
const ansiPart = new RegExp(`(?:[^\\\\']+|${ansiEscape})`, "uy");
const controls: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  E: "\x1b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function decodeWord(value: string): string | undefined {
  if (!value.startsWith("$'")) return value.replace(/\\(.)/gu, "$1");

  const body = value.slice(2, -1);
  const bytes: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    ansiPart.lastIndex = offset;
    const part = ansiPart.exec(body)?.[0];
    if (!part) return undefined;
    offset += part.length;
    if (!part.startsWith("\\")) {
      bytes.push(Buffer.from(part));
      continue;
    }
    const escape = part.slice(1);
    const kind = escape[0];
    if (kind === "x") {
      bytes.push(Buffer.from([Number.parseInt(escape.slice(1), 16)]));
    } else if (kind === "u" || kind === "U") {
      const code = Number.parseInt(escape.slice(1), 16);
      if (code > 0x10ffff) return undefined;
      bytes.push(Buffer.from(String.fromCodePoint(code)));
    } else if (/^[0-7]/.test(escape)) {
      bytes.push(Buffer.from([Number.parseInt(escape, 8)]));
    } else {
      bytes.push(Buffer.from(controls[escape] ?? escape));
    }
  }
  const decoded = Buffer.concat(bytes);
  const text = decoded.toString("utf8");
  return !decoded.includes(0) && Buffer.from(text).equals(decoded) ? text : undefined;
}

function ownedText(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.uid !== process.getuid?.()) return undefined;
  return readFileSync(path, "utf8");
}

function savedNamespace(base: string): string {
  const assignments = ownedText(join(base, "env.sh"))
    ?.split("\n")
    .filter((line) => line.startsWith("export HC_SESSION="));
  if (assignments?.length !== 1) return "";
  const value = sessionLine.exec(assignments[0] ?? "")?.[1];
  return (value && decodeWord(value)) || "";
}

function matchesHistoricalSource(path: string, sources: readonly string[]): boolean {
  const suffix = `/${oldCli}`;
  if (!isAbsolute(path) || !path.endsWith(suffix)) return false;
  const checkout = canonical(path.slice(0, -suffix.length));
  return sources.some((source) => checkout === canonical(source));
}

function oldSideCli(base: string, sources: readonly string[]): boolean {
  const lines = ownedText(join(base, "bin/dori"))?.split("\n");
  if (lines?.length !== 5 || lines[0] !== "#!/usr/bin/env bash" || lines[1] !== "set -euo pipefail" || lines[4] !== "")
    return false;
  const envWord = wrapperEnv.exec(lines[2] ?? "")?.[1];
  const [, bunWord, cliWord] = wrapperExec.exec(lines[3] ?? "") ?? [];
  const envPath = envWord && decodeWord(envWord);
  const bunPath = bunWord && decodeWord(bunWord);
  const cliPath = cliWord && decodeWord(cliWord);
  return (
    !!envPath &&
    isAbsolute(envPath) &&
    basename(envPath) === "env.sh" &&
    canonical(dirname(envPath)) === canonical(base) &&
    !!bunPath &&
    isAbsolute(bunPath) &&
    !!cliPath &&
    matchesHistoricalSource(cliPath, sources)
  );
}

function oldPrimaryLink(path: string, sources: readonly string[]): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink() || stat.uid !== process.getuid?.()) return false;
  const target = resolve(dirname(path), readlinkSync(path));
  return matchesHistoricalSource(target, sources);
}

export function inspectHistoricalSource([action, path, ...sources]: readonly string[]): void {
  if (!path) throw new TypeError("Expected an installation path");
  switch (action) {
    case "namespace":
      // A final sentinel keeps command substitution from trimming literal trailing newlines.
      process.stdout.write(`${savedNamespace(path)}.`);
      break;
    case "side-cli":
      if (oldSideCli(path, sources)) console.log("owned");
      break;
    case "primary-link":
      if (oldPrimaryLink(path, sources)) console.log("owned");
      break;
    default:
      throw new TypeError("Unknown source compatibility operation");
  }
}
