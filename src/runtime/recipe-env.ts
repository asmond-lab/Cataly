import { dirname, isAbsolute, sep } from "node:path";

export type RecipeContext = {
  readonly configFile: string;
  readonly installationHome?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** Keep the OS's interpretation of a relative path containing symlinks and `..`. */
const absolutePath = (path: string): string => (isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`);

export function recipePaths(configFile: string, installationHome?: string) {
  const file = absolutePath(configFile);
  return { configFile: file, installationHome: installationHome ? absolutePath(installationHome) : dirname(file) };
}

/** Saved shell recipes choose their own token file; only the selected installation or config supplies its home. */
export function legacyRecipeEnv(
  argv: readonly string[],
  { configFile, installationHome, env }: RecipeContext,
): Record<string, string | undefined> | undefined {
  const recipe = argv.find((part) => /\$\{?DORI_HOME\b/.test(part));
  if (recipe === undefined) return undefined;
  const { configFile: file, installationHome: home } = recipePaths(configFile, installationHome);
  const child: Record<string, string | undefined> = {
    ...env,
    CATALY_CONFIG: file,
    CATALY_HOME: home,
    DORI_CONFIG: file,
    DORI_HOME: home,
  };
  for (const token of ["DISCORD_TOKEN", "TELEGRAM_TOKEN"] as const) {
    // The saved script explicitly assigns the old token. An inherited canonical value (even an empty lane override)
    // would otherwise mask the script's own assignment when its CLI translates the legacy environment.
    const old = `DORI_${token}`;
    if (recipe.includes(`${old}=`)) {
      delete child[`CATALY_${token}`];
      delete child[old];
    }
  }
  return child;
}
