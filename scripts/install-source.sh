#!/usr/bin/env bash
# Installs a Cataly source checkout: skill CLI, harness sources, extension, and source-selected omp-ulw.
# CATALY_NO_PULL=1 (or true, yes) installs an existing checkout without updating it.
# --preview shows only configuration changes, without updating checkouts, dependencies or references.
# CATALY_INSTALL_MODE=primary installs into ~/.cataly; CATALY_INSTALL_MODE=side installs next to another Cataly, in
# OMP_CATALY_HOME (default ~/.omp-cataly), without changing ~/.cataly, the cataly command or the cataly-mode skill.
# Without CATALY_INSTALL_MODE, a ~/.cataly owned by another Cataly is never changed: a terminal is asked, anything else stops.
# Consumer-managed ~/.cataly homes use cataly update; primary source installation always holds there.
# Source omp-ulw uses the bound lock+overlay by default; OMP_ULW_REF explicitly selects an unpatched branch/tag/commit.
# Primary mode discovers it globally; side mode loads it only through the isolated omp-cataly omp wrapper.
# Optional paths: CATALY_SRC, OMP_ULW_SRC, OMP_ULW_REPO, SKILLS_DIR, OMP_EXTENSIONS_DIR, OMP_CATALY_HOME, OMP_CATALY_BIN_DIR.
# For optional side-mode terminal operations, OMP_CATALY_HC_SESSION names the hc namespace (default omp-cataly)
# and OMP_CATALY_HC_SPACE names a Herdr app space. Neither selects the session runtime.
set -euo pipefail

# Translate only source-installer inputs. An explicitly set Cataly spelling, even empty, wins.
for selector in CATALY_INSTALL_MODE:DORI_INSTALL_MODE CATALY_SRC:DORI_SRC CATALY_NO_PULL:DORI_NO_PULL \
  CATALY_OMP:DORI_OMP OMP_CATALY_HOME:OMP_DORI_HOME OMP_CATALY_BIN_DIR:OMP_DORI_BIN_DIR \
  OMP_CATALY_HC_SESSION:OMP_DORI_HC_SESSION OMP_CATALY_HC_SPACE:OMP_DORI_HC_SPACE; do
  canonical_selector="${selector%:*}"
  legacy_selector="${selector#*:}"
  if [ -z "${!canonical_selector+x}" ] && [ -n "${!legacy_selector+x}" ]; then
    export "$canonical_selector=${!legacy_selector}"
  fi
done

fail() { echo "$1" >&2; exit 1; }
preview=0
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 1 ] && [ "$1" = --preview ] || fail "Usage: scripts/install-source.sh [--preview]"
  preview=1
  export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
fi
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
at_least() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | { read -r first; printf '%s\n' "$first"; })" = "$1" ]; }

repo="https://github.com/vntrevx/Cataly.git"
ulw_repo="${OMP_ULW_REPO:-https://github.com/dbc-hbin/omp-ulw.git}"
ulw_ref="${OMP_ULW_REF:-lock}"
current_primary="$HOME/.cataly"
current_side="$HOME/.omp-cataly"
legacy_primary="$HOME/.dori"
legacy_side="$HOME/.omp-dori"
primary_home="$current_primary"
side_home="$(absolute "${OMP_CATALY_HOME:-$current_side}")"
skills="$(absolute "${SKILLS_DIR:-$HOME/.agents/skills}")"
extensions="$(absolute "${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}")"
bin_dir="$(absolute "${OMP_CATALY_BIN_DIR:-${BUN_INSTALL:-$HOME/.bun}/bin}")"
min_bun="1.4.4"
min_omp="18.18.8"

command -v git >/dev/null || fail "git is required"
bun_bin="$(command -v bun)" || fail "bun $min_bun+ is required: https://bun.sh"
bun_bin="$(absolute "$bun_bin")"
bun_version="$("$bun_bin" --version)"
at_least "$min_bun" "$bun_version" || fail "bun $bun_version is older than $min_bun"
# An explicit external OMP command is an advanced override, never evidence for the bundled source.
omp_bin="${CATALY_OMP:-}"
if [ "$preview" = 0 ] && [ -n "$omp_bin" ]; then
  omp_bin="$(command -v "$omp_bin")" || fail "CATALY_OMP does not name an executable"
  omp_bin="$(absolute "$omp_bin")"
fi

present() { [ -e "$1" ] || [ -L "$1" ]; }
owned_directory() { [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }
mode_marker() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ "$(cat "$1")" = "$2" ]
}
marked() {
  mode_marker "$1/.omp-cataly" "$2" || mode_marker "$1/.omp-dori" "$2"
}
source_checkout() {
  [ -e "$1/.git" ] && [ -f "$1/omp-ulw.lock" ] &&
    { [ -f "$1/skills/cataly-mode/scripts/src/cli.ts" ] || [ -f "$1/skills/dori-mode/scripts/src/cli.ts" ]; }
}
# These control paths and the active source pointer are owned by src/release/files.ts, not source installs.
consumer_home() {
  local result
  result="$("$bun_bin" -e '
    const { lstatSync, readlinkSync, realpathSync } = require("node:fs");
    const { dirname, join, resolve } = require("node:path");
    const base = resolve(process.argv[1]);
    const stat = lstatSync(base, { throwIfNoEntry: false });
    if (!stat?.isDirectory() && !stat?.isSymbolicLink()) process.exit(0);
    // Presence also holds interrupted or damaged control records; source installation never repairs them.
    const controls = ["consumer-owner.json", "consumer-installed.json", "consumer-journal.json"];
    let managed = controls.some(name => lstatSync(join(base, "releases", name), { throwIfNoEntry: false }));
    if (lstatSync(join(base, "src"), { throwIfNoEntry: false })?.isSymbolicLink()) {
      const physical = realpathSync(base);
      const target = resolve(physical, readlinkSync(join(base, "src")));
      managed ||= dirname(target) === join(physical, "releases/releases");
      if (!managed) {
        try {
          // Resolve only the parent; the release itself may be absent or unreadable.
          managed = realpathSync(dirname(target)) === join(physical, "releases/releases");
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
      }
    }
    if (managed) console.log("consumer");
  ' "$1")" || fail "Could not inspect consumer ownership at $1; nothing was changed."
  [ "$result" = consumer ]
}
consumer=""
consumer_command=cataly
if consumer_home "$current_primary"; then
  consumer="$current_primary"
elif consumer_home "$legacy_primary"; then
  consumer="$legacy_primary"
  # The pre-rename release may still expose only its original update entry point.
  [ -x "$consumer/bin/cataly" ] || consumer_command=dori
fi

# Markerless primary installs must have either the in-home checkout or both of their
# historical entry points; an arbitrary extension link is not evidence about a config home.
linked_primary_source() {
  local root="$1" link_name="$2" command_name="$3" skill_name="$4" checkout
  [ -L "$extensions/$link_name" ] && [ -L "$bin_dir/$command_name" ] || return 1
  checkout="$(cd -P "$extensions/$link_name" && cd .. && pwd -P)" || return 1
  source_checkout "$checkout" || return 1
  if [ "$bin_dir/$command_name" -ef "$checkout/skills/$skill_name/scripts/src/cli.ts" ] ||
    { [ "$command_name" = dori ] && mode_marker "$root/.omp-dori" primary &&
      [ "$(readlink "$bin_dir/dori")" = "$checkout/skills/dori-mode/scripts/src/cli.ts" ]; } ||
    { mode_marker "$root/.omp-cataly" primary && [ "$bin_dir/$command_name" -ef "$root/bin/cataly" ]; }; then
    printf '%s\n' "$checkout"
  else
    return 1
  fi
}
legacy_primary_source=""
if [ -z "$consumer" ] && owned_directory "$legacy_primary"; then
  legacy_primary_source="$(linked_primary_source "$legacy_primary" omp-dori dori dori-mode 2>/dev/null || true)"
  if marked "$legacy_primary" primary ||
    { owned_directory "$legacy_primary/src" && source_checkout "$legacy_primary/src"; } ||
    { [ -n "$legacy_primary_source" ] && [ -f "$legacy_primary/bin/omp" ] &&
      [ ! -L "$legacy_primary/bin/omp" ] && [ -O "$legacy_primary/bin/omp" ]; }; then
    if ! present "$current_primary"; then primary_home="$legacy_primary"; fi
  fi
fi
legacy_side_owned=""
if owned_directory "$legacy_side" && marked "$legacy_side" side && ! consumer_home "$legacy_side" &&
  { [ "$side_home" = "$legacy_side" ] ||
    { [ -z "${OMP_CATALY_HOME:-}" ] && ! present "$current_side"; }; }; then
  side_home="$legacy_side"
  legacy_side_owned=1
fi

consumer_hold="$consumer is managed by the consumer release installer; nothing was changed. Use $consumer/bin/$consumer_command update check|install|status|rollback for releases, or CATALY_INSTALL_MODE=side with scripts/install-source.sh from a separate ordinary checkout."
other_cataly() {
  [ -n "$consumer" ] && return 0
  [ "$primary_home" = "$legacy_primary" ] && return 1
  marked "$primary_home" primary && return 1
  owned_directory "$primary_home/src" && source_checkout "$primary_home/src" && return 1
  linked_primary_source "$primary_home" omp-cataly cataly cataly-mode >/dev/null 2>&1 && return 1
  present "$primary_home/config.json" && return 0
  present "$primary_home/src/.git" && return 0
  return 1
}
other=""
other_cataly && other=1

mode="${CATALY_INSTALL_MODE:-}"
case "$mode" in "" | primary | side) ;; *) fail "CATALY_INSTALL_MODE=$mode: use primary or side" ;; esac
if [ -z "$mode" ]; then
  if marked "$side_home" side; then
    mode=side
  elif [ -n "$consumer" ]; then
    fail "$consumer_hold"
  elif [ -z "$other" ]; then
    mode=primary
  elif [ -t 0 ]; then
    cat >&2 <<EOF
$primary_home belongs to another Cataly installation.
  1) primary  install omp-cataly into $primary_home. It takes over the cataly command, the cataly-mode skill link
              and $primary_home/config.json; copies of the previous ones are kept under $primary_home/backups.
  2) side     install omp-cataly into $side_home, next to it. $primary_home, the cataly command and the
              cataly-mode skill stay as they are; this installation is used through the omp-cataly command.
EOF
    read -r -p "Install as 1 or 2 [2]: " answer || fail "no answer; nothing was changed"
    case "${answer:-2}" in
      1 | primary) mode=primary ;;
      2 | side) mode=side ;;
      *) fail "unknown answer: $answer" ;;
    esac
  else
    fail "$primary_home belongs to another Cataly installation, so nothing was changed. Run scripts/install-source.sh in a terminal to choose, or set CATALY_INSTALL_MODE=side (install into $side_home next to it) or CATALY_INSTALL_MODE=primary (take over $primary_home)."
  fi
fi
if [ "$mode" = primary ] && [ -n "$consumer" ]; then fail "$consumer_hold"; fi

if [ "$mode" = side ]; then base="$side_home"; else base="$primary_home"; fi
legacy_install=""
if { [ "$mode" = primary ] && [ "$base" = "$legacy_primary" ]; } ||
  { [ "$mode" = side ] && [ -n "$legacy_side_owned" ]; } ||
  mode_marker "$base/.omp-dori" "$mode"; then
  legacy_install=1
fi
source_default="$base/src"
legacy_side_source=""
if [ "$mode" = side ] && [ -n "$legacy_install" ]; then
  for reference in "$base/skills/omp-dori-mode/scripts" "$base/skills/omp-cataly-mode/scripts"; do
    [ -L "$reference" ] || continue
    discovered="$(cd -P "$reference" 2>/dev/null && cd ../../.. && pwd -P)" || continue
    if source_checkout "$discovered"; then legacy_side_source="$discovered"; break; fi
  done
fi
if [ -z "${CATALY_SRC:-}" ] && ! present "$source_default"; then
  if [ "$mode" = primary ]; then
    discovered="$(linked_primary_source "$base" omp-cataly cataly cataly-mode 2>/dev/null || true)"
    if [ "$base" = "$legacy_primary" ]; then discovered="${discovered:-$legacy_primary_source}"; fi
    if [ -n "$discovered" ]; then source_default="$discovered"; fi
  elif [ -n "$legacy_side_source" ]; then
    source_default="$legacy_side_source"
  fi
fi
src="$(absolute "${CATALY_SRC:-$source_default}")"
ulw="$(absolute "${OMP_ULW_SRC:-$base/omp-ulw}")"
config="$base/config.json"
primary_cli="$src/skills/cataly-mode/scripts/src/cli.ts"
legacy_primary_cli=""
if [ "$mode" = primary ] && [ "$base" = "$legacy_primary" ]; then
  legacy_primary_cli="$base/bin/cataly"
  primary_cli="$legacy_primary_cli"
fi
configuration_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/source-configuration.ts"
source_legacy() {
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$bun_bin" "$configuration_helper" historical "$@"
}
configuration() {
  CATALY_SOURCE_LEGACY="$legacy_install" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    "$bun_bin" "$configuration_helper" "$1" "$base" "$src" "$mode"
}
# Capture before toolchain/checkout/dependency preparation; the receipt contains metadata, never file content.
if [ "$preview" = 0 ]; then setup_snapshot="$(configuration capture)"; fi

# Resolve the install mode before checking every wrapper it writes. File identity follows symlinks,
# including aliased parents, and catches hard links without trusting an existing wrapper's source.
check_omp_wrapper_collision() {
  local name command_link traverses
  local wrappers=(omp) command_links
  if [ "$mode" = side ]; then
    wrappers+=(cataly omp-cataly)
    [ -z "$legacy_side_cli" ] || wrappers+=(dori)
    command_links=("$bin_dir/omp-cataly")
  else
    [ -z "$legacy_primary_cli" ] || wrappers+=(cataly)
    command_links=("$bin_dir/cataly")
    [ -z "$legacy_home_link" ] || command_links+=("$base/bin/dori")
    [ -z "$legacy_global_link" ] || command_links+=("$bin_dir/dori")
  fi
  for name in "${wrappers[@]}"; do
    if [ "$omp_bin" -ef "$base/bin/$name" ]; then
      fail "Selected OMP executable $omp_bin aliases generated wrapper $base/bin/$name; choose an independent executable with CATALY_OMP."
    fi
  done
  for command_link in "${command_links[@]}"; do
    [ -L "$command_link" ] || continue
    # Relinking changes a pathname, not its target inode. Preserve independent paths to that same target.
    traverses="$("$bun_bin" -e '
      const { lstatSync, readlinkSync, realpathSync } = require("node:fs");
      const { basename, dirname, isAbsolute, join } = require("node:path");
      const target = join(realpathSync(dirname(process.argv[2])), basename(process.argv[2]));
      const pending = process.argv[1].split("/");
      let current = "/", links = 0;
      while (pending.length) {
        const part = pending.shift();
        if (!part || part === ".") continue;
        if (part === "..") { current = dirname(current); continue; }
        const next = join(current, part);
        if (next === target) { console.log("yes"); break; }
        if (lstatSync(next).isSymbolicLink()) {
          if (++links > 40) throw new Error("Too many native executable symbolic links");
          const destination = readlinkSync(next);
          if (isAbsolute(destination)) current = "/";
          pending.unshift(...destination.split("/"));
        } else {
          current = next;
        }
      }
    ' "$omp_bin" "$command_link")" || fail "Could not inspect selected OMP path $omp_bin before command publication."
    [ "$traverses" != yes ] || fail "Selected OMP executable $omp_bin traverses installation command link $command_link; choose an independent executable with CATALY_OMP."
  done
}

# Checkouts of every supported revision have these files; older revisions have no package.json.
is_ulw() { [ -f "$1/index.ts" ] && [ -f "$1/presets.ts" ]; }
ulw_explicit="${OMP_ULW_SRC:+1}"
standalone_ulw=""
# Dependency selection can consult owner config and requires a real checkout only for installation.
if [ "$preview" = 0 ]; then
  if [ -z "$ulw_explicit" ] && [ -f "$base/config.json" ]; then
    custom_ulw="$(CONFIG="$base/config.json" ULW_DIR="$ulw" "$bun_bin" -e '
      const { dirname, resolve } = require("node:path");
      const config = await Bun.file(process.env.CONFIG).json();
      const path = typeof config.ompUlwPath === "string" ? config.ompUlwPath.replace(/^~(?=\/|$)/, process.env.HOME) : "";
      const dir = path ? resolve(dirname(path)) : "";
      const primaryDefaults = [".cataly", ".dori"].map(name => resolve(process.env.HOME, name, "omp-ulw/index.ts"));
      if (path && !primaryDefaults.includes(resolve(path)) && dir !== resolve(process.env.ULW_DIR)) console.log(dir);')"
    if [ -n "$custom_ulw" ]; then
      ulw="$custom_ulw"
      ulw_explicit=1
      echo "omp-ulw: config.json points at $custom_ulw; installing that checkout as the extension." >&2
    fi
  fi
  # The older side installer persisted an explicit checkout outside of config.json.
  if [ "$mode" = side ] && [ -z "$ulw_explicit" ]; then
    retained="$base/.omp-cataly-ulw"
    if [ ! -L "$retained" ] && [ -n "$legacy_install" ] && ! mode_marker "$base/.omp-cataly" side; then
      retained="$base/.omp-dori-ulw"
    fi
    if [ -L "$retained" ]; then
      ulw="$(readlink "$retained")"
      case "$ulw" in /*) ;; *) ulw="$base/$ulw" ;; esac
      ulw_explicit=1
    fi
  fi
  if [ -n "$ulw_explicit" ]; then
    is_ulw "$ulw" || fail "$ulw is not an omp-ulw checkout (no index.ts and presets.ts); nothing was changed."
  fi
  if [ "$mode" = primary ]; then
    for entry in "$extensions"/*; do
      [ "$entry" != "$extensions/omp-cataly" ] || continue
      # Only a marked source home's own default link may be replaced by a later standalone extension.
      if { marked "$base" primary || [ -n "$legacy_install" ]; } && [ "$entry" = "$extensions/omp-ulw" ]; then
        owned_ulw="$(readlink "$entry" 2>/dev/null || true)"
        case "$owned_ulw" in "$base/omp-ulw"|"$base/omp-ulw-custom") continue ;; esac
      fi
      if is_ulw "$entry"; then
        [ -z "$standalone_ulw" ] || fail "Multiple standalone omp-ulw extensions exist; keep one before source installation; nothing was changed."
        if [ -n "$ulw_explicit" ] && ! [ "$entry" -ef "$ulw" ]; then
          fail "The standalone omp-ulw at $entry differs from $ulw; select one checkout before primary source installation; nothing was changed."
        fi
        standalone_ulw="$entry"
      fi
    done
  fi
fi

consumer_home "$base" && fail "$base is a consumer-managed home; choose a separate OMP_CATALY_HOME."
if [ "$mode" = side ]; then
  if [ "$base" = "$legacy_side" ] && [ -z "$legacy_side_owned" ]; then
    fail "$base is not a recognized Cataly source home; choose a separate OMP_CATALY_HOME."
  fi
  if [ "$preview" = 0 ] && [ -e "$base/.omp-cataly-ulw" ] && [ ! -L "$base/.omp-cataly-ulw" ]; then
    fail "$base/.omp-cataly-ulw exists and is not a link; nothing was changed."
  fi
  protected=("$current_primary" "$legacy_primary")
  if [ -z "$legacy_install" ]; then protected+=("$legacy_side"); fi
  destinations=("$base" "$src" "$src/skills/cataly-mode/scripts" "$src/extension" "$ulw" "$bin_dir"
    "$base/config.json" "$base/.omp-cataly" "$base/.omp-cataly-ulw" "$base/env.sh" "$base/omp.yml"
    "$base/skills" "$base/skills/omp-cataly-mode" "$base/state" "$base/bin"
    "$base/bin/cataly" "$base/bin/cataly-native" "$base/bin/omp" "$base/bin/omp-cataly")
else
  protected=("$current_side" "$legacy_side")
  if [ "$base" != "$legacy_primary" ]; then protected+=("$legacy_primary"); fi
  destinations=("$base" "$src" "$src/skills/cataly-mode/scripts" "$src/extension" "$ulw" "$bin_dir"
    "$base/bin" "$base/bin/cataly-native" "$base/bin/omp" "$skills" "$extensions")
  [ -z "$legacy_primary_cli" ] || destinations+=("$legacy_primary_cli")
fi
if [ -n "$omp_bin" ]; then destinations+=("$omp_bin"); fi
# Resolve existing links and missing suffixes before any checkout, dependency or config mutation.
CATALY_PROTECTED_COUNT="${#protected[@]}" "$bun_bin" -e '
    const { lstatSync, readlinkSync } = require("node:fs");
    const { dirname, join, relative, resolve } = require("node:path");
    const physical = (value) => {
      const parts = value.split("/");
      let path = "/", links = 0;
      while (parts.length) {
        const part = parts.shift();
        if (!part || part === ".") continue;
        if (part === "..") { path = dirname(path); continue; }
        const next = join(path, part);
        if (lstatSync(next, { throwIfNoEntry: false })?.isSymbolicLink()) {
          if (++links > 40) throw new Error(`Too many links in installation path: ${value}`);
          const target = readlinkSync(next);
          if (target.startsWith("/")) path = "/";
          parts.unshift(...target.split("/"));
        } else {
          path = next;
        }
      }
      return path;
    };
    const paths = process.argv.slice(1), separator = Number(process.env.CATALY_PROTECTED_COUNT);
    const protectedRoots = paths.slice(0, separator).map(root => [root, physical(root)]);
    for (const value of paths.slice(separator)) {
      const resolved = physical(value);
      if (resolved !== physical(resolve(value))) {
        console.error(`${value} uses a directory link followed by ".."; select its absolute path instead; nothing was changed.`);
        process.exit(1);
      }
      for (const [root, protectedPath] of protectedRoots) {
        const entry = relative(protectedPath, resolved);
        if (entry === "" || (entry !== ".." && !entry.startsWith("../"))) {
          console.error(`${value} belongs to ${root}; choose separate installation paths (CATALY_SRC, OMP_ULW_SRC, OMP_CATALY_HOME and OMP_CATALY_BIN_DIR); nothing was changed.`);
          process.exit(1);
        }
      }
    }
  ' "${protected[@]}" "${destinations[@]}"

generated_directories=("$base/bin" "$base/backups")
if [ "$mode" = side ]; then
  generated_directories+=("$base/skills" "$base/skills/omp-cataly-mode" "$base/state")
fi
for directory in "${generated_directories[@]}"; do
  if present "$directory" && ! owned_directory "$directory"; then
    fail "$directory is not an owned directory; nothing was changed."
  fi
done

# A linked worktree has a .git file rather than a directory.
if [ -z "${CATALY_SRC:-}" ] && [ "$src" = "$base/src" ] && [ -L "$src" ]; then
  fail "$src is a source link; select an ordinary checkout explicitly with CATALY_SRC."
fi
if [ -e "$src/.git" ] && ! source_checkout "$src"; then
  fail "$src is a checkout of $(git -C "$src" remote get-url origin 2>/dev/null || echo 'another repository'), not Cataly; nothing was changed. Move it aside, set CATALY_SRC, or install with CATALY_INSTALL_MODE=side."
fi

if [ "$preview" = 1 ]; then
  configuration preview
  exit 0
fi

legacy_side_cli=""
legacy_home_link=""
legacy_global_link=""
hc_session="${OMP_CATALY_HC_SESSION:-}"
if [ "$mode" = side ]; then
  if [ -z "$hc_session" ] && owned_directory "$base" && marked "$base" side; then
    hc_session="$(source_legacy namespace "$base")"
    hc_session="${hc_session%.}"
  fi
  if [ -n "$legacy_install" ]; then
    hc_session="${hc_session:-omp-dori}"
    legacy_side_sources=("$src" "$base/src")
    [ -z "$legacy_side_source" ] || legacy_side_sources+=("$legacy_side_source")
    legacy_side_cli="$(source_legacy side-cli "$base" "${legacy_side_sources[@]}")"
  fi
  hc_session="${hc_session:-omp-cataly}"
elif [ -n "$legacy_primary_cli" ]; then
  legacy_primary_sources=("$src" "$base/src")
  [ -z "$legacy_primary_source" ] || legacy_primary_sources+=("$legacy_primary_source")
  legacy_home_link="$(source_legacy primary-link "$base/bin/dori" "${legacy_primary_sources[@]}")"
  if ! [ "$bin_dir" -ef "$base/bin" ]; then
    legacy_global_link="$(source_legacy primary-link "$bin_dir/dori" "${legacy_primary_sources[@]}")"
  fi
fi

if [ -n "$omp_bin" ]; then
  check_omp_wrapper_collision
  omp_version="$("$omp_bin" --version)"
  [[ "$omp_version" =~ ([0-9]+(\.[0-9]+){2}) ]] || fail "could not read CATALY_OMP version"
  at_least "$min_omp" "${BASH_REMATCH[1]}" || fail "CATALY_OMP must be $min_omp or newer"
fi
(umask 077; mkdir -p "$base")
if [ ! -e "$src/.git" ]; then
  (umask 077; git clone --quiet --depth 1 "$repo" "$src")
elif [[ "${CATALY_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "CATALY_NO_PULL=$CATALY_NO_PULL: installing $src as it is, without pulling" >&2
elif ! (umask 077; git -C "$src" fetch --quiet); then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
elif ! (umask 077; git -C "$src" merge --ff-only --quiet '@{u}'); then
  if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null &&
    [ -n "$(git -C "$src" status --porcelain)$(git -C "$src" rev-list '@{u}..HEAD')" ]; then
    echo "Could not update $src. Local work in that checkout:" >&2
    git -C "$src" status --short --branch >&2
    git -C "$src" log --oneline '@{u}..HEAD' >&2
    echo "To keep it and install the checkout as it is, run scripts/install-source.sh again with CATALY_NO_PULL=1." >&2
  else
    echo "Could not update $src; git's message above says why." >&2
  fi
  exit 1
fi
[ -f "$src/skills/cataly-mode/scripts/src/cli.ts" ] ||
  fail "$src still has a pre-Cataly source layout; select an updated checkout with CATALY_SRC."
if [ -z "$omp_bin" ]; then
  # The installer holds the native cache lease until it has written the wrapper below that names the identity.
  native="$(CATALY_NATIVE_LEASE_PID=$$ "$bun_bin" "$src/scripts/source-dependencies.ts" native "$src" "$HOME")"
  omp_bin="$native/bin/omp"
  check_omp_wrapper_collision
else
  # An explicit executable inside the native cache is leased by the installer too before a wrapper names it.
  CATALY_NATIVE_LEASE_PID=$$ "$bun_bin" "$src/scripts/source-dependencies.ts" lease-path "$src" "$HOME" "$omp_bin"
fi

if [ "$mode" = primary ] && { [ -n "$other" ] ||
  { [ -L "$bin_dir/cataly" ] && [ ! "$bin_dir/cataly" -ef "$primary_cli" ]; }; }; then
  backup="$primary_home/backups/omp-cataly-install-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  [ -f "$primary_home/config.json" ] && cp -p "$primary_home/config.json" "$backup/config.json"
  for path in "$skills/cataly-mode" "$bin_dir/cataly" "$(command -v cataly || echo "$bin_dir/cataly")"; do
    printf '%s -> %s\n' "$path" "$(readlink "$path" 2>/dev/null || echo '(not a link)')"
  done | sort -u > "$backup/links.txt"
  echo "The previous config.json and link targets are kept in $backup" >&2
fi

# Move an obsolete installer-owned link out of discovery without deleting the previous reference.
retire_link() {
  local path="$1" previous
  [ -L "$path" ] || fail "$path is not an installation link; nothing was moved."
  (umask 077; mkdir -p "$base/backups")
  previous="$(mktemp -d "$base/backups/cataly-source-links.XXXXXX")"
  mv "$path" "$previous/"
}

ulw_bound=""
if [ -n "$standalone_ulw" ]; then
  echo "omp-ulw: using the standalone extension at $standalone_ulw; omp-cataly does not load a second copy." >&2
  if marked "$base" primary || [ -n "$legacy_install" ]; then
    owned_ulw="$(readlink "$extensions/omp-ulw" 2>/dev/null || true)"
    case "$owned_ulw" in
      "$base/omp-ulw"|"$base/omp-ulw-custom") retire_link "$extensions/omp-ulw" ;;
    esac
  fi
elif [ -z "$ulw_explicit" ]; then
  if [ "$ulw_ref" = lock ]; then
    selected="$("$bun_bin" "$src/scripts/source-dependencies.ts" ulw "$src" "$HOME")"
    [ ! -e "$ulw" ] || [ -L "$ulw" ] || fail "$ulw is an existing checkout; preserve it and move it aside before selecting the bound overlay."
    ln -sfn "$selected" "$ulw"
    ulw_bound=1
  else
    # Explicit branch/tag/commit overrides have their own checkout; never mutate a bound cache.
    ulw="$base/omp-ulw-custom"
    [ -e "$ulw/.git" ] || git clone --quiet "$ulw_repo" "$ulw"
    if [ -n "${OMP_ULW_REPO:-}" ]; then git -C "$ulw" remote set-url origin "$ulw_repo"; fi
    git -C "$ulw" fetch --quiet origin
    if git -C "$ulw" rev-parse --verify --quiet "origin/$ulw_ref^{commit}" >/dev/null; then target="origin/$ulw_ref"; else target="$ulw_ref"; fi
    [ -z "$(git -C "$ulw" status --porcelain)" ] || fail "Explicit omp-ulw checkout changed; preserve local work before reinstalling."
    git -C "$ulw" -c advice.detachedHead=false checkout --quiet "$target"
    is_ulw "$ulw" || fail "$ulw is not an omp-ulw checkout"
  fi
fi
if [ "$mode" = side ]; then
  ulw_extension="$ulw"
elif [ -n "$standalone_ulw" ]; then
  ulw_extension="$standalone_ulw"
else
  ulw_extension="$extensions/omp-ulw"
fi

link() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "$2 exists and is not a link; leaving it alone" >&2
    return 1
  fi
  ln -sfn "$1" "$2"
}

# Publish generated files independently of any existing hard links. Never traverse a destination link.
write_generated() (
  local path="$1" permission="$2" scratch
  if present "$path" && { [ ! -f "$path" ] || [ -L "$path" ] || [ ! -O "$path" ]; }; then
    fail "$path is not an owned regular file; nothing was written there."
  fi
  scratch="$(mktemp "${path}.XXXXXX")"
  trap 'rm -f "$scratch"' EXIT
  cat > "$scratch"
  chmod "$permission" "$scratch"
  mv -f "$scratch" "$path"
)

install_native_controller() (
  local binary="" host candidate rust_host build_dir
  if [ -d "$src/native-bin" ]; then
    host="$("$bun_bin" -e 'console.log(`${process.platform}-${process.arch}`)')"
    candidate="$src/native-bin/$host/cataly"
    if present "$candidate"; then
      [ ! -L "$src/native-bin" ] && [ ! -L "$src/native-bin/$host" ] ||
        fail "Native Cataly package must not traverse a directory link: $candidate"
      binary="$candidate"
    fi
  fi
  if [ -z "$binary" ]; then
    # Older source trees have no Rust crate; keep their install and Bun CLI unchanged.
    [ -f "$src/Cargo.toml" ] && [ -f "$src/Cargo.lock" ] && [ -f "$src/native/src/main.rs" ] || return 0
    if ! command -v cargo >/dev/null || ! rust_host="$(rustc -vV | awk '$1 == "host:" { print $2 }')" ||
      [[ ! "$rust_host" =~ ^[a-zA-Z0-9_-]+$ ]]; then
      echo "Native Cataly needs a Rust toolchain; keeping the existing CLI." >&2
      return 0
    fi
    build_dir="$(mktemp -d "${TMPDIR:-/tmp}/cataly-native-build.XXXXXX")"
    trap 'rm -rf "$build_dir"' EXIT
    if ! (cd "$src" && cargo build --locked --release --bin cataly --target "$rust_host" --target-dir "$build_dir"); then
      echo "Native Cataly build failed; keeping the existing CLI." >&2
      return 0
    fi
    binary="$build_dir/$rust_host/release/cataly"
  fi
  [ -f "$binary" ] && [ -x "$binary" ] && [ ! -L "$binary" ] ||
    fail "Native Cataly is not an executable regular file: $binary"
  (umask 077; mkdir -p "$base/bin")
  write_generated "$base/bin/cataly-native" 700 < "$binary"
)

if [ "$mode" = primary ]; then
  mkdir -p "$skills" "$extensions"
  link "$src/skills/cataly-mode" "$skills/cataly-mode" || true
  link "$src/extension" "$extensions/omp-cataly" || fail "extension link was not installed"
  # The old extension name still points at the renamed checkout. Save the owned link
  # outside OMP discovery so native OMP cannot load the same extension twice.
  legacy_extension="$extensions/omp-dori"
  if [ -n "$legacy_install" ] && [ -L "$legacy_extension" ] &&
    { [ "$legacy_extension" -ef "$src/extension" ] ||
      { [ -n "$legacy_primary_source" ] && [ "$legacy_extension" -ef "$legacy_primary_source/extension" ]; }; }; then
    retire_link "$legacy_extension"
  fi
  if [ -z "$standalone_ulw" ]; then
    link "$ulw" "$extensions/omp-ulw" || fail "omp-ulw extension link was not installed"
  fi
fi

# In primary mode the skill owns the installed cataly name; a side install never links a global cataly.
(cd "$src" && "$bun_bin" install --frozen-lockfile --silent)
(cd "$src/skills/cataly-mode/scripts" && "$bun_bin" install --frozen-lockfile --silent)
(cd "$src/extension" && "$bun_bin" install --frozen-lockfile --silent)
if [ "$mode" = primary ] && [ "$bin_dir/cataly" != "$primary_cli" ]; then
  if [ -e "$bin_dir/cataly" ] && [ ! -L "$bin_dir/cataly" ]; then
    fail "$bin_dir/cataly exists and is not a link; leaving it alone. Choose another OMP_CATALY_BIN_DIR."
  fi
fi
install_native_controller

if [ "$mode" = side ] && [ -n "$ulw_explicit" ]; then
  if [ "$ulw" -ef "$base/omp-ulw" ]; then
    [ ! -L "$base/.omp-cataly-ulw" ] || retire_link "$base/.omp-cataly-ulw"
  else
    link "$ulw" "$base/.omp-cataly-ulw" || fail "omp-ulw checkout choice was not saved"
  fi
fi
setup_snapshot="$(CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration publish-json)"
printf '%s\n' "$mode" | write_generated "$base/.omp-cataly" 600

agent_argv="$("$bun_bin" -e 'console.log(JSON.stringify([process.argv[1]]))' "$base/bin/omp")"
ulw_guard() {
  [ -n "$ulw_bound" ] || return 0
  printf '%s\n' 'guard=$(mktemp -d)' 'trap '\''rmdir "$guard"'\'' EXIT'
  printf '(cd "$guard" && %q %q assert-ulw %q %q %q)\n' "$bun_bin" "$src/scripts/source-dependencies.ts" "$src" "$HOME" "$ulw"
  printf '%s\n' 'rmdir "$guard"' 'trap - EXIT'
}
if [ "$mode" = primary ]; then
  mkdir -p "$base/bin"
  primary_env() {
    printf 'if [ "${CATALY_HOME+x}${DORI_HOME+x}" = "" ]; then export CATALY_HOME=%q; fi\n' "$base"
    printf '%s\n' 'if [ "${CATALY_CONFIG+x}${DORI_CONFIG+x}" = "" ]; then export CATALY_CONFIG="${CATALY_HOME-${DORI_HOME-}}/config.json"; fi'
    if [ -n "$legacy_primary_cli" ]; then
      printf 'if [ "${CATALY_AGENT_ARGV+x}${DORI_AGENT_ARGV+x}${CATALY_AGENT_CMD+x}${DORI_AGENT_CMD+x}" = "" ]; then export CATALY_AGENT_ARGV=%q; fi\n' "$agent_argv"
    fi
  }
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    primary_env
    ulw_guard
    printf 'exec %q "$@"\n' "$omp_bin"
  } | write_generated "$base/bin/omp" 755
  if [ -n "$legacy_primary_cli" ]; then
    {
      printf '#!/usr/bin/env bash\nset -euo pipefail\n'
      primary_env
      printf 'exec %q %q "$@"\n' "$bun_bin" "$src/skills/cataly-mode/scripts/src/cli.ts"
    } | write_generated "$legacy_primary_cli" 755
  fi
  if [ "$bin_dir/cataly" != "$primary_cli" ]; then
    mkdir -p "$bin_dir"
    link "$primary_cli" "$bin_dir/cataly" ||
      fail "cataly command was not installed; choose another OMP_CATALY_BIN_DIR."
  fi
  if [ -n "$legacy_primary_cli" ]; then
    # Preserve an installer-owned old entry point that saved hook argv may still name.
    for entry in home global; do
      if [ "$entry" = home ]; then
        [ -n "$legacy_home_link" ] || continue
        old_command="$base/bin/dori"
      else
        [ -n "$legacy_global_link" ] || continue
        old_command="$bin_dir/dori"
      fi
      owns_command="$(source_legacy primary-link "$old_command" "${legacy_primary_sources[@]}")"
      [ "$owns_command" = owned ] || continue
      link "$primary_cli" "$old_command"
    done
  fi
  CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration readback
  cat <<EOF
Installed.
  Skill:     $skills/cataly-mode
  Extension: $extensions/omp-cataly
  omp-ulw:   $ulw_extension (OMP extension; active in every globally discovering OMP session)
  CLI:       cataly (messenger/lane CLI), cataly harness (upstream harness)
  Config:    $config
Next: configure your model, project and messenger hooks in $config.
New sessions default to headless; set sessionRuntime to hc or herdr only to opt into terminal execution.
Run cataly harness up from your project to start the harness, or open the lead with
$base/bin/omp --cataly-role cataly. Installation does not start a messenger or watcher.
EOF
  exit 0
fi

skill="$base/skills/omp-cataly-mode"
mkdir -p "$base/bin" "$base/state" "$base/skills"
mkdir -p "$skill"
# omp lists one of two skills with the same description, so the copy changes its description as well as its name.
awk 'NR == 1 { print; next }
  !done && /^name: cataly-mode$/ { print "name: omp-cataly-mode"; next }
  !done && /^description: / { sub(/^description: /, "description: For the omp-cataly installation next to another Cataly (omp-cataly command). "); print; next }
  !done && /^---$/ { done = 1 }
  { print }' "$src/skills/cataly-mode/SKILL.md" | write_generated "$skill/SKILL.md" 644
for part in references scripts assets; do
  if [ -e "$src/skills/cataly-mode/$part" ]; then
    link "$src/skills/cataly-mode/$part" "$skill/$part"
  fi
done
# Only the generated skills keys and update.auto below belong to this installer; other keys belong to the owner.
if ! setup_snapshot="$(CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration publish-yaml)"; then
  fail "Configuration setup held for $base/omp.yml; inspect the file and rerun --preview before retrying."
fi
{
  printf 'export CATALY_HOME=%q\n' "$base"
  printf 'export CATALY_CONFIG=%q\n' "$config"
  printf 'export CATALY_STATE_DIR=%q\n' "$base/state"
  printf '%s\n' 'unset CATALY_AGENT_CMD CATALY_AGENT_EXECUTABLE CATALY_OMP_ULW_PATH'
  # Clear inherited legacy aliases as well so a side session never uses primary dependencies.
  printf '%s\n' 'unset DORI_AGENT_CMD DORI_AGENT_EXECUTABLE DORI_OMP_ULW_PATH'
  printf 'export CATALY_AGENT_ARGV=%q\n' "$agent_argv"
  # Keep optional hc operations isolated without selecting a terminal runtime.
  printf 'export HC_SESSION=%q\n' "$hc_session"
  # A Herdr app space id shows the side Cataly's terminals in that space; without one, hc keeps them hidden.
  [ -z "${OMP_CATALY_HC_SPACE:-}" ] || printf 'export CATALY_HC_SPACE=%q\n' "$OMP_CATALY_HC_SPACE"
  printf 'case ":$PATH:" in *:%q:*) ;; *) export PATH=%q:"$PATH" ;; esac\n' "$base/bin" "$base/bin"
} | write_generated "$base/env.sh" 644
wrapper() {
  { printf '#!/usr/bin/env bash\nset -euo pipefail\n. %q\n' "$base/env.sh"; cat; } | write_generated "$base/bin/$1" 755
}
printf 'exec %q %q "$@"\n' "$bun_bin" "$src/skills/cataly-mode/scripts/src/cli.ts" | wrapper cataly
if [ -n "$legacy_side_cli" ]; then
  owns_command="$(source_legacy side-cli "$base" "${legacy_side_sources[@]}")"
  if [ "$owns_command" = owned ]; then
    # The old omp-dori dispatcher (including its existing global link) calls bin/dori.
    { printf '#!/usr/bin/env bash\n'; printf 'exec %q "$@"\n' "$base/bin/cataly"; } |
      write_generated "$base/bin/dori" 755
  fi
fi
{ ulw_guard; printf 'exec %q --no-extensions -e %q -e %q --config %q "$@"\n' "$omp_bin" "$src/extension" "$ulw" "$base/omp.yml"; } | wrapper omp
printf 'case "${1:-}" in\n  omp) shift; exec %q "$@" ;;\n  hc) shift; exec hc "$@" ;;\n  *) exec %q "$@" ;;\nesac\n' \
  "$base/bin/omp" "$base/bin/cataly" | wrapper omp-cataly
mkdir -p "$bin_dir"
if [ "$bin_dir/omp-cataly" != "$base/bin/omp-cataly" ]; then
  link "$base/bin/omp-cataly" "$bin_dir/omp-cataly" || echo "Run $base/bin/omp-cataly directly." >&2
fi

CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration readback
cat <<EOF
Installed next to the Cataly in $primary_home, which was not changed.
  Home:       $base (config.json, state, generated skill, omp.yml and wrappers)
  Command:    $bin_dir/omp-cataly  (omp-cataly <cataly command> | omp-cataly omp ... | omp-cataly hc ...)
  Skill:      omp-cataly-mode; cataly-mode is hidden in omp-cataly omp sessions
  Extensions: $src/extension and $ulw, loaded only by omp-cataly omp, which discovers no other OMP extension
  omp-ulw:    $ulw
  Config:     $config
Next: configure your model and project in $config and use separate messenger credentials and hooks for this home.
New sessions default to headless; set sessionRuntime to hc or herdr only to opt into terminal execution.
Run omp-cataly harness up from your project to start the harness, or open the lead with
omp-cataly omp --cataly-role cataly. Installation does not start a messenger, watcher or terminal server.
EOF
