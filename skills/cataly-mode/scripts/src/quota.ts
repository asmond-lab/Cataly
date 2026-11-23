import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalyConfig } from "./config.ts";
import type { Runner } from "./run.ts";
import { readUsageCache } from "./usage-file.ts";
import { isQuotaCommand, usageOptionsError } from "./usage-options.ts";

export type QuotaOptions = {
  readonly command?: readonly string[];
  readonly cacheMinutes?: number;
  readonly warnUsedPercent?: number;
};
export type QuotaLimit = {
  readonly label: string;
  readonly durationMs: number | null;
  readonly windowId: string | null;
  readonly usedFraction: number | null;
  readonly resetsAt: number | null;
  readonly status: string;
};
export type QuotaAccount = {
  readonly provider: string;
  readonly account: string;
  readonly fetchedAt: number | null;
  readonly state: "reported" | "unavailable" | "disabled";
  readonly limits: readonly QuotaLimit[];
};
export type QuotaSnapshot = {
  readonly observedAt: number;
  readonly generatedAt: number | null;
  readonly accounts: readonly QuotaAccount[];
  readonly stale: boolean;
  readonly errors: readonly string[];
  readonly warnUsedPercent: number | null;
};
export class QuotaError extends Error {}

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && n <= 8_640_000_000_000_000 ? n : null;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const MAX_BYTES = 1_048_576;
const MAX_ACCOUNTS = 64;
const MAX_LIMITS = 64;
const displayWord = (value: unknown, words: readonly string[]): string | undefined =>
  typeof value === "string" ? words.find((word) => word === value) : undefined;
const providerLabel = (value: unknown): string => displayWord(value, ["anthropic", "openai-codex"]) ?? "unknown";
const displayLimit = (label: unknown, windowId: unknown, status: unknown) => ({
  label: displayWord(label, ["5h", "5 hours", "weekly", "primary", "secondary"]) ?? "unknown window",
  windowId: displayWord(windowId, ["5h", "5H", "7d", "7D"])?.toLowerCase() ?? null,
  status: displayWord(status, ["ok", "warning", "exhausted", "unavailable"]) ?? "unknown",
});
type QuotaData = { generatedAt: number; accounts: QuotaAccount[] };

const parseCachedQuota = (value: unknown): QuotaData | null => {
  const data = record(value);
  const generatedAt = timestamp(data["generatedAt"]);
  const raw = data["accounts"];
  if (generatedAt === null || !Array.isArray(raw) || raw.length > MAX_ACCOUNTS) return null;
  const accounts: QuotaAccount[] = [];
  for (const item of raw) {
    const account = record(item);
    const state = account["state"];
    const limits = account["limits"];
    if (
      (state !== "reported" && state !== "unavailable" && state !== "disabled") ||
      !Array.isArray(limits) ||
      limits.length > MAX_LIMITS ||
      (state !== "reported" && limits.length > 0)
    )
      return null;
    accounts.push({
      state,
      provider: providerLabel(account["provider"]),
      account: `account-${accounts.length + 1}`,
      fetchedAt: timestamp(account["fetchedAt"]),
      limits: limits.map((item: unknown) => {
        const limit = record(item);
        return {
          ...displayLimit(limit["label"], limit["windowId"], limit["status"]),
          durationMs: number(limit["durationMs"]),
          usedFraction: number(limit["usedFraction"]),
          resetsAt: timestamp(limit["resetsAt"]),
        };
      }),
    });
  }
  return { generatedAt, accounts };
};

/** Pinned OMP usage JSON, excluding raw payloads, credentials and reset-credit data. No policy mutation. */
export const parseQuota = (value: unknown): QuotaData => {
  const data = record(value),
    generatedAt = timestamp(data["generatedAt"]);
  if (generatedAt === null || !Array.isArray(data["reports"]) || data["reports"].length > MAX_ACCOUNTS)
    throw new QuotaError("invalid OMP usage JSON");
  const accounts: QuotaAccount[] = [];
  for (const item of data["reports"]) {
    const report = record(item);
    if (
      typeof report["provider"] !== "string" ||
      !Array.isArray(report["limits"]) ||
      report["limits"].length > MAX_LIMITS
    )
      throw new QuotaError("invalid OMP account report");
    const limits = report["limits"].map((item): QuotaLimit => {
      const limit = record(item),
        amount = record(limit["amount"]),
        window = record(limit["window"]),
        scope = record(limit["scope"]);
      const explicit = number(amount["usedFraction"]),
        used = number(amount["used"]),
        maximum = number(amount["limit"]),
        remaining = number(amount["remainingFraction"]);
      const fraction =
        explicit ??
        (used !== null && maximum !== null && maximum > 0
          ? used / maximum
          : amount["unit"] === "percent" && used !== null
            ? used / 100
            : remaining === null
              ? null
              : Math.max(0, 1 - remaining));
      return {
        ...displayLimit(limit["label"], scope["windowId"], limit["status"]),
        durationMs: number(window["durationMs"]),
        usedFraction: number(fraction),
        resetsAt: timestamp(window["resetsAt"]),
      };
    });
    accounts.push({
      provider: providerLabel(report["provider"]),
      account: `account-${accounts.length + 1}`,
      fetchedAt: timestamp(report["fetchedAt"]),
      state: "reported",
      limits,
    });
  }
  for (const [field, state] of [
    ["accountsWithoutUsage", "unavailable"],
    ["disabledCredentials", "disabled"],
  ] as const) {
    if (data[field] === undefined) continue;
    if (!Array.isArray(data[field]) || data[field].length > MAX_ACCOUNTS - accounts.length)
      throw new QuotaError("invalid OMP unreported accounts");
    for (const item of data[field]) {
      const account = record(item);
      accounts.push({
        provider: providerLabel(account["provider"]),
        account: `account-${accounts.length + 1}`,
        fetchedAt: null,
        state,
        limits: [],
      });
    }
  }
  return { generatedAt, accounts };
};

export const readQuota = async (
  config: CatalyConfig,
  run: Runner,
  now: number,
  refresh = false,
): Promise<QuotaSnapshot> => {
  const options = config.quota;
  const configError = usageOptionsError(undefined, undefined, options);
  if (configError) throw new QuotaError(configError);
  const command = options && Object.hasOwn(options, "command") ? options.command : undefined;
  if (!options || !isQuotaCommand(command)) throw new QuotaError("quota requires an explicitly configured launcher");
  const ttl = (options.cacheMinutes ?? 5) * 60_000;
  const key = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const path = join(config.stateDir, "quota-cache.json");
  let previous: { fetchedAt: number; data: QuotaData } | null = null;
  try {
    const stored = record(JSON.parse(readUsageCache(path, MAX_BYTES)));
    const fetchedAt = timestamp(stored["fetchedAt"]);
    const data = parseCachedQuota(stored["data"]);
    if (stored["key"] === key && fetchedAt !== null && data) previous = { fetchedAt, data };
  } catch {
    /* A missing or corrupt display cache is not provider data. */
  }
  const snapshot = (data: QuotaData | null, errors: readonly string[]): QuotaSnapshot => ({
    observedAt: now,
    generatedAt: data?.generatedAt ?? null,
    accounts: data?.accounts ?? [],
    stale:
      errors.length > 0 ||
      !data ||
      now < data.generatedAt ||
      now - data.generatedAt > ttl ||
      data.accounts.some(
        (a) => a.state === "reported" && (a.fetchedAt === null || now < a.fetchedAt || now - a.fetchedAt > ttl),
      ),
    errors,
    warnUsedPercent: options.warnUsedPercent ?? null,
  });
  if (!refresh && previous && now >= previous.fetchedAt && now - previous.fetchedAt <= ttl)
    return snapshot(previous.data, []);
  const response = await run([...command, "usage", "--json"], { timeoutMs: 15_000, captureMaxBytes: MAX_BYTES });
  if (response.code !== 0)
    return snapshot(previous?.data ?? null, [
      `OMP usage query failed (exit ${response.code}); no account switch or retry`,
    ]);
  let data: QuotaData;
  try {
    if (Buffer.byteLength(response.out) > MAX_BYTES) throw new QuotaError("OMP usage response too large");
    data = parseQuota(JSON.parse(response.out));
  } catch {
    return snapshot(previous?.data ?? null, ["OMP usage response unavailable or malformed"]);
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ key, fetchedAt: now, data }), { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  return snapshot(data, []);
};

export const renderQuota = (snapshot: QuotaSnapshot): string => {
  const lines = [
    `QUOTA ${snapshot.stale ? "stale/unknown" : "observed"} at=${snapshot.generatedAt === null ? "unknown" : new Date(snapshot.generatedAt).toISOString()} (display only)`,
  ];
  for (const account of snapshot.accounts) {
    const windows = account.limits.map(
      (limit) =>
        `${limit.label} ${limit.usedFraction === null ? "unknown" : `${(limit.usedFraction * 100).toFixed(1)}%`} reset=${limit.resetsAt === null ? "unknown" : new Date(limit.resetsAt).toISOString()} ${limit.status}${snapshot.warnUsedPercent !== null && limit.usedFraction !== null ? ` display-headroom=${(snapshot.warnUsedPercent - limit.usedFraction * 100).toFixed(1)}pp` : ""}`,
    );
    if (!account.limits.some((l) => l.windowId === "5h" || Math.abs((l.durationMs ?? 0) - 18_000_000) <= 60_000))
      windows.push("5h missing");
    if (!account.limits.some((l) => l.windowId === "7d" || l.durationMs === 604_800_000))
      windows.push("weekly missing");
    lines.push(
      `${account.provider} ${account.account} ${account.state} observed=${account.fetchedAt === null ? "unknown" : new Date(account.fetchedAt).toISOString()} | ${windows.join(" | ")}`,
    );
  }
  if (!snapshot.accounts.length) lines.push("accounts unknown or none reported (not zero usage)");
  for (const error of snapshot.errors) lines.push(`WARN ${error}`);
  return lines.join("\n");
};
