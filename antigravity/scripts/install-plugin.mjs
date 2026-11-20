import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const pluginSourceDir = join(projectRoot, "plugin");
const distSourceDir = join(projectRoot, "dist");
const targetDir = process.env["CATALY_PLUGIN_DIR"]
  ? resolve(process.env["CATALY_PLUGIN_DIR"])
  : join(homedir(), ".gemini", "config", "plugins", "cataly");

if (!existsSync(join(distSourceDir, "mcp-server.js"))) {
  console.error("dist/mcp-server.js not found. Run `npm run build` first.");
  process.exit(1);
}

/**
 * Resolve only transitive production dependencies from node_modules without copying devDependencies
 * (such as typescript and @types/node) and without requiring network access.
 */
function collectProdPackages(rootDir) {
  const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const queue = Object.keys(rootPkg.dependencies ?? {});
  const visited = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || visited.has(name)) continue;
    const pkgDir = join(rootDir, "node_modules", name);
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    visited.add(name);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return [...visited].sort();
}

function measureDir(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measureDir(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += statSync(full).size;
      files++;
    }
  }
  return { bytes, files };
}

console.log(`Installing Cataly plugin to ${targetDir} ...`);
mkdirSync(targetDir, { recursive: true });

// 1. Copy static plugin manifest, skills, agents, rules, hooks, assets, README
for (const entry of ["plugin.json", "hooks.json", "README.md", "assets", "rules", "agents", "skills"]) {
  const src = join(pluginSourceDir, entry);
  const dst = join(targetDir, entry);
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
}

// 2. Copy compiled dist/ (excluding test files)
const targetDist = join(targetDir, "dist");
if (existsSync(targetDist)) rmSync(targetDist, { recursive: true, force: true });
cpSync(distSourceDir, targetDist, {
  recursive: true,
  filter: (src) => !src.includes(`${join("dist", "test")}`),
});

// 3. Copy package.json and ONLY production dependencies
cpSync(join(projectRoot, "package.json"), join(targetDir, "package.json"));
const targetNodeModules = join(targetDir, "node_modules");
if (existsSync(targetNodeModules)) rmSync(targetNodeModules, { recursive: true, force: true });
mkdirSync(targetNodeModules, { recursive: true });

const SKIP_NM_DIRS = new Set(["test", "tests", "__tests__", "docs", "doc", "examples", "example", ".github"]);
const SKIP_NM_EXT = /\.(?:map|d\.ts|d\.mts|d\.cts|tsbuildinfo|md|markdown)$/i;

function keepRuntimeNodeModuleEntry(src) {
  const normalized = src.replace(/\\/g, "/");
  const segs = normalized.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (SKIP_NM_DIRS.has(base.toLowerCase())) return false;
  if (SKIP_NM_EXT.test(base)) return false;
  if (/^(?:LICENSE|LICENCE|NOTICE|CHANGELOG|HISTORY|AUTHORS|CONTRIBUTORS)(?:\..+)?$/i.test(base)) return false;
  return true;
}

const prodPackages = collectProdPackages(projectRoot);
for (const pkgName of prodPackages) {
  const src = join(projectRoot, "node_modules", pkgName);
  const dst = join(targetNodeModules, pkgName);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, filter: keepRuntimeNodeModuleEntry });
}

// 4. Write mcp_config.json with absolute entry path & cwd so Windows/Antigravity resolves it reliably
const mcpServerEntry = join(targetDist, "mcp-server.js");
const mcpConfig = {
  mcpServers: {
    "cataly-core": {
      command: process.execPath,
      args: [mcpServerEntry],
      cwd: targetDir,
    },
  },
};
writeFileSync(join(targetDir, "mcp_config.json"), `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");

const stats = measureDir(targetDir);
console.log("Installed Cataly plugin successfully.");
console.log(`  Plugin dir  : ${targetDir}`);
console.log(`  MCP server  : ${mcpServerEntry}`);
console.log(`  Prod deps   : ${prodPackages.length} packages`);
console.log(`  Bundle size : ${(stats.bytes / (1024 * 1024)).toFixed(2)} MB (${stats.files} files)`);
