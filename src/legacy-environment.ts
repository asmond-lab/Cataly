/** Import a v0.1.3 operator environment once, at a Cataly process boundary. An explicit empty value still wins. */
export function importLegacyEnvironment(env: Record<string, string | undefined> = process.env): void {
  for (const name of Object.keys(env)) {
    const prefix = name.startsWith("DORI_") ? "DORI_" : name.startsWith("OMP_DORI_") ? "OMP_DORI_" : undefined;
    if (!prefix) continue;
    const current = `${prefix === "DORI_" ? "CATALY_" : "OMP_CATALY_"}${name.slice(prefix.length)}`;
    if (env[current] === undefined && env[name] !== undefined) env[current] = env[name];
    // Old secrets must not survive under a second spelling when lanes or subprocesses strip the current key.
    delete env[name];
  }
}
