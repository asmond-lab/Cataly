export const isQuotaCommand = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((part) => typeof part === "string" && !!part.trim() && !["usage", "reset", "invalidate"].includes(part));

export const usageOptionsError = (usage: unknown, usageArgv: unknown, quota: unknown): string | null => {
  if (usage !== undefined && usage !== "omp") return "supervision usage must be omp when enabled";
  if (usage === "omp" && Array.isArray(usageArgv) && usageArgv.length)
    return "choose supervision usage or usageArgv, not both";
  if (quota === undefined) return null;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return "quota must be an object";
  const value = quota as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!["command", "cacheMinutes", "warnUsedPercent"].includes(key)) return "unknown quota setting";
  const command = value["command"];
  if (command !== undefined && !isQuotaCommand(command))
    return "quota.command must be an OMP launcher argv, without a usage action";
  const ttl = value["cacheMinutes"];
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 1))
    return "quota.cacheMinutes must be at least 1";
  const reserve = value["warnUsedPercent"];
  if (
    reserve !== undefined &&
    (typeof reserve !== "number" || !Number.isFinite(reserve) || reserve < 0 || reserve > 100)
  )
    return "quota.warnUsedPercent must be between 0 and 100";
  return null;
};
