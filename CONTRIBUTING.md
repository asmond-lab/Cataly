# Contributing to Cataly

Help Cataly understand the goal, notice the context, and carry the work through.
A good contribution improves the outcome without making the user manage more
steps or guess what actually happened.

This guide applies to [vntrevx/Cataly](https://github.com/vntrevx/Cataly), maintained
by [vntrevx](https://github.com/vntrevx).

## Propose a change

1. Read the relevant code, documentation, and
   [existing issues](https://github.com/vntrevx/Cataly/issues) or
   [pull requests](https://github.com/vntrevx/Cataly/pulls).
2. Explain the intended outcome, the current behavior, and the evidence behind the
   change. Give a reproduction when reporting a bug.
3. Make the smallest complete change that fits the existing system. Preserve
   established behavior, isolation boundaries, and the reason earlier fixes exist.
4. Verify the result on the surface that changed. Report actual commands,
   failures, skips, and limits; do not replace evidence with confidence.
5. Update user-facing documentation and preserve the license and attribution
   applicable to the material.

Keep credentials, private conversations, account data, installed release state,
and private QA artifacts out of contributions. Work around unrelated changes in
a shared checkout rather than reverting them.

## Project credit

Cataly builds on [dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi), and
[omp-ulw](https://github.com/dbc-hbin/omp-ulw). The pre-existing OMP integration
retains the YeonGyu Kim and betive37 notices; vntrevx maintains this integration.
[NOTICE](NOTICE) records imported revisions and modified-copy provenance.
A new name does not replace the original authors' credit.

## Contribution terms

Submit only work you have the right to contribute. Changes retain the license
applicable to the affected material: Sustainable Use License 1.0 for
dori-superagent-derived code, and MIT for the pre-existing OMP integration covered
by [LICENSE.integration](LICENSE.integration). [LICENSE](LICENSE) explains the scope.

For copied or adapted third-party code or prompt text, record provenance in the
PR's [Provenance section](.github/pull_request_template.md#provenance): upstream
URL, file paths and immutable revision; the applicable file/component license;
destination paths and modifications; and retained notice paths. For concept-only
references, cite the source/revision and identify the independently written work.
A project's root license is not blanket permission for differently licensed
files, prompts, SDKs or ULW components; follow [LICENSING.md](LICENSING.md).
Keep required copyright, permission, license and modified-copy notices with copied
material. Dependency/SDK/ULW changes must preserve their component-specific license
and notice files in redistributed material.

Cataly does not require a CLA signature or a CLA comment. The retained [CLA](CLA.md)
and its workflow belong to upstream `sisyphuslabs/dori-superagent`, not a new
agreement for this repository.

## Source development and public releases

Develop in an ordinary source checkout, never inside a frozen installed release.
Use `cataly` for the primary CLI, `cataly-harness` for the standalone harness,
and `omp-cataly` for isolated operation. `omp` remains the OMP command.
Historical release names are kept only where the compatibility protocol needs
them; see [the release guide](docs/releases.md#upgrade-a-v013-installation).

To install a selected checkout alongside a primary installation without pulling:

```bash
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" bash scripts/install-source.sh
```

Side mode defaults to `~/.omp-cataly`. `OMP_CATALY_HOME` selects its home,
`OMP_CATALY_BIN_DIR` selects the command destination, and `OMP_CATALY_HC_SESSION`
overrides its default `omp-cataly` hc namespace. Keep the generated `stateDir`,
`agentCommand`, wrappers, and skill together. Consumer-managed homes, including
aliases, are protected from source installation in both primary and side modes.
See [source installation](docs/releases.md#source-checkouts-for-maintainers).

Current source prepares `native-omp.lock` / `native-omp.patch` and
`omp-ulw.overlay.lock` / `omp-ulw.patch`. Use the generated primary
`~/.cataly/bin/omp` or side `omp-cataly omp`, not stock OMP on `PATH`. The official
addon has its own frozen `native-addon/bun.lock`; no Cargo build is required.
Changing these defaults requires real isolated installation evidence as well as
source checks. See [bound source identities](docs/releases.md#current-source-bundle).

Consumers use the [verified release guide](docs/releases.md) and
`cataly update check|install|status|rollback`. Maintainer porting and recovery use
`cataly upstream ... --config FILE`; that separate interface may use configured
models and publication permissions. Consumer release management uses neither.
Build fixed assets with `bun scripts/release.ts build --out DIST --prerelease`.
The [exact-commit release procedure](docs/releases.md#building-and-publishing-releases)
describes the publication gates. The tag/scheduled workflow guards, ULW publisher,
and exact-commit release checks require the canonical identity `vntrevx/Cataly`;
forks and the former repository name are not admitted as publication identities.
The rename does not weaken the existing tag, commit, workflow, or check bindings.

ULW preparation uses `bun scripts/update-ulw.ts --out /absolute/new-directory`.
The daily workflow checks at 03:00 UTC (12:00 KST, with possible GitHub scheduling
delay) and can propose a separate metadata-only draft and exact-head CI. It does not approve compatibility, merge
itself, publish a release, or update a user installation. Review conflicts and
preserve notices and existing settings.

## Run the gates

Prepare the real fixtures before the full local gate:

```sh
bun install --frozen-lockfile
(cd skills/cataly-mode/scripts && bun install --frozen-lockfile)
(cd extension && bun install --frozen-lockfile)
(cd test/fixtures/omp-native-host && bun install --frozen-lockfile)
export CATALY_TEST_OMP_ROOT="$PWD/test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent"
fixture_home="$(mktemp -d)"
bun scripts/source-dependencies.ts ulw "$PWD" "$fixture_home" "$PWD/ref/omp-ulw"
compat_pin=cbfe5ee72e5b2783af01616e7f4d3da5e3f9180d
compat="$(mktemp -d /tmp/omp-cataly-compat-ulw.XXXXXX)"
git clone --quiet --no-checkout --shared "$PWD/ref/omp-ulw" "$compat"
git -C "$compat" fetch --quiet --no-tags https://github.com/dbc-hbin/omp-ulw.git "$compat_pin"
git -C "$compat" -c advice.detachedHead=false checkout --quiet "$compat_pin"
test "$(git -C "$compat" rev-parse HEAD)" = "$compat_pin"
export CATALY_TEST_COMPAT_ULW_ENTRY="$compat/index.ts"
rollback_pin=e6b60c9f5efd45925645672e1841a8a9e20e5592
git cat-file -e "$rollback_pin^{commit}" ||
  git fetch --no-tags --depth=1 https://github.com/vntrevx/Cataly.git "$rollback_pin"
(umask 022 && bun run ci)
```

Fixture preparation needs network access unless the exact packages are already
available. The compatibility checkout is test-only, outside the repository, and
does not select a production dependency or change model/auth settings.
The rollback fixture reads the historical Cataly commit from the local Git
object store so the old controller runs with its own dependencies.
On POSIX, the subshell's `umask 022` keeps test installation fixtures from
inheriting group write permissions on developer machines. It does not change
your shell's umask or the installer's ownership and mode checks.

Match CI: do not install an additional native peer in `extension`. Extension public types resolve through the pinned-host fixture and the existing TypeScript path aliases; an extra peer can hide a CI-only missing-type failure.

`check:fixtures` prints the resolved interpreter and native package entry, the expected source revision, and explicit public CLI/API probe results. The package fixture does not attest its upstream source revision, so its observed revision remains `unknown`. A missing public export or CLI flag fails with the exact selected path and reason; no alternate binary is selected. These probes do not establish live messenger compatibility. CI also runs `scripts/check-native-doctor.ts` after preparing the bound native source: it exercises both managed entry points through the real doctor CLI, checks the observed revision and unchanged config/state, and rejects an altered consumer wrapper without using a cached executable as a fallback.

The full chain is:

| Command | What it checks |
| --- | --- |
| `check:fixtures` | Real ULW, compatibility entry, exact native host, and public CLI/API prerequisites |
| `lint` | oxlint, warnings are errors (`--deny-warnings`) |
| `format:check` | Prettier formatting check; `format` rewrites |
| `check` | `lint` then `format:check` |
| `typecheck` | Harness, skill, and extension TypeScript projects |
| `knip` | Unused files, exports, and dependencies |
| `lint:loc` | The 250-line limit per capped TypeScript file |
| `test:ci` | Harness tests in an isolated Bun file worker, one file at a time |
| `test:skill` | The skill's script suite |
| `test:extension` | Native OMP extension integration |

`bun run test` remains the direct harness command for debugging. CI uses one
isolated file worker because the installer, release, and runtime fixtures
already launch real subprocesses. Concurrent file workers can exhaust those
fixtures' wall-clock budgets. Run only one full CI invocation per checkout.
Do not change discovery, skips, assertions, worker limits, or timeouts to hide a
failure. `.bun-test-timings.json` is an ordering hint, not a coverage gate; files
missing from it still run. Its effect on total runtime has not been established.
Regenerate measured hints with:

```sh
bun test --parallel=1 --timings=.bun-test-timings.json --update-timings ./test/
```

Automatic CI runs in two workflows. `ci.yml` holds the release gate and requires
exactly **`check`, `e2e-herdr`, and `e2e-hc`** on Linux; all three must pass on the
reviewed head and actual combined target content. The herdr job verifies a pinned
asset checksum, limits download attempts, and fails immediately on a checksum
mismatch. A missing hc E2E file is a failure, not a skip.

`cross-os.yml` runs **`test-macos`** (`macos-15`, arm64: the root, skill and
extension suites with prepared fixtures, a 30-second per-test timeout on the root
suite because the runner is slower, and the genuine Darwin arm64 consumer
transition from the historical hc profile to headless on pushes to `main` and
manual runs, never on pull requests) and
**`test-windows`** (`windows-2025`: `check`, `typecheck`, `knip`, `lint:loc` and
the three suites with the native OMP host fixture). Both run on every pull request
and push to `main`, and a manual run can select one OS with `-f os=macos|windows`.
These jobs are outside the release gate. Current headless consumer profiles
cover Linux x64 and macOS arm64; Windows CI finds portability regressions
rather than promising a Windows consumer build.

OS-dependent behaviour belongs in the platform adapter, `src/platform/adapter.ts`
with its per-OS implementations beside it in `src/platform/`, never in a caller
that tests `process.platform`; [docs/platform-adapter.md](docs/platform-adapter.md)
describes the contract.

Tests that exercise POSIX-only behaviour are gated per test, or per `describe`
suite when every case in it needs the POSIX runtime (`posix`, `it` and `posixSuite`
in `test/update-setup.ts`, `test/install-setup.ts` and
`test/release-consumer-setup.ts`), with `skipIf(process.platform === "win32")` and
a `// POSIX-only:` reason. Gated categories: permission bits and uid ownership
`0600`/`0700` checks, symlinks and `link(2)` identity, shebang fake executables on
`PATH`, `/bin/sh` and process groups, `ps`, signals, FIFOs and file names Windows
cannot create, the Discord inbound cursor store, and atomic replace of an open
worklog file. Never exclude a file from the suite, use another condition, or relax
a product security check to make a test pass. A test that fails only on path
separators, temp directories or the `PATH` delimiter is fixed with
`node:path`, `os.tmpdir()` or `path.delimiter` instead.

### Native and provider boundaries

The root and extension suites require the genuine OMP 19.0.1 host fixture,
including its published declarations. A same-version foreign host, raw checkout
without `dist/types`, or stock-version stamp is not a substitute. The guarded
`with the real omp-ulw` tests must execute, not be skipped in the full gate.

Prompt-composition checks use OMP's real extension loader and combined
`ExtensionRunner.emitBeforeAgentStart` result, including both standalone extension
orders and a later declining handler. Preserve the base prompt, existing winner,
one model preset and bookkeeping block, downstream context, and role/model gates.
The separate pinned compatibility factory establishes an opaque legacy baseline;
it is not the current default overlay.

`native-prompt-matrix.test.ts` runs 30 scenario/load-order cases, plus native
parent setup and an orphan-role control, using the pinned `buildSystemPrompt`,
canonical loader, and `ExtensionRunner` in an isolated Bun child. It covers
ordinary, ULW, specialized, parent, child, Cataly, non-Sol, profile-excluded, and
user-profile behavior with embedded ULW and both standalone load orders. It
compares the combined prompt across repeated turns and an ordinary follow-up
after the native `SessionManager` compaction-entry and `session_compact` hook
boundary. The child starts with an explicitly selected `monitor` and its
parent's rendered ULW policy; both must be removed without losing its permitted
tool or assignment. Cataly's main session still advertises `monitor`. A profile
opt-out preserves the native profile byte-for-byte; Cataly's independent Sol lane
bookkeeping remains applicable.

The matrix verifies the local ULW checkout against the locked base and overlay
before importing ULW. It blocks `fetch` and `fetch.preconnect` before native
imports, rejects model-registry access through a fixture proxy, and attaches no
provider transport. It checks prompt rendering and extension lifecycle
composition, not an interactive OMP CLI, provider-generated compaction, model
task completion, or messenger ingress/recovery. Those surfaces need separate
evidence.

Linux `check` also executes the bound ULW code-mode and task-host checks against
the guarded bound native source. Keep the upstream assertions, including the
documented 18.20.2 accounting behavior: a failure on the selected 19.0.1 host
holds the pin or release rather than relaxing the test.

Required-source regressions exercise genuine SDK print/RPC initialization against
synthetic loopback providers. Missing managed overlays must send no request for
Cataly or lane roles, including direct dispatch, while ordinary sessions still
reach the local provider. These tests neither use real provider credentials nor
establish live TUI, messenger, provider, or external-user behavior.

Manager-only extension tools need both default-inactive presentation and an
execution guard based on the selected role and native `ctx.agent.kind`. Inherited
roles or copied role flags alone do not grant manager access. For each such tool,
cover authorized main-session access, child/grandchild visibility with explicit
tool selection, direct child-call rejection, and preservation of ordinary main
and child tools. See the [manager-tool boundary](docs/runtime.md#manager-tool-boundary).

## Ready for review

Use the [PR template](.github/pull_request_template.md). Keep one clear concern per
PR; explain what changed and why, related PRs, and unmerged dependencies (or none).
Record the exact head, target, commands, and content each evidence run covers.

- Reproduce bugs before fixing them and retain regressions that can actually fail.
- For CLI, runtime, or native changes, exercise that real surface with isolated
  state. Identify stand-ins and capabilities that were not exercised.
- Performance claims need matched, pinned baseline/candidate measurements and
  correctness checks. Distinguish observed counts from inferred syscall counts.
- Once code is stable, complete one full local `bun run ci` with real fixtures.
  Do not present partial reruns or summed historical results as a new full run.
- Prose-only changes need accurate content, commands, and links, not artificial
  runtime or word-count tests. The three required remote jobs still apply.
- Public issues, PRs, commits, and review comments are English. Exclude private
  transcripts, configuration, account data, and QA workspace contents.

Mark ready only when applicable local requirements are met. Explain items that
do not apply. Remote checks may still be pending on a ready PR; it is merge-ready
only after all required jobs pass on the final reviewed combined content.

## Integrate without repeating work

Freeze an actual PR set and declare dependencies. Change the scope explicitly;
do not silently turn it into every new arrival or a numeric range of closed PRs.
Keep at most two source implementation units active, one integration owner, and
serialized shared-file edits and merges. Read-only review and CI can overlap
independent source work.

Resolve contracts and regressions before the expensive gate. Reuse evidence only
for unchanged content, dependencies, and environment. A moving target requires a
new integration check; commit metadata alone neither justifies repeating identical
checks nor permits bypassing the final required remote gates.

## Licences and notices

The [licensing guide](LICENSING.md) explains the source boundaries. The
[Sustainable Use License](LICENSE), separate [MIT notice](LICENSE.integration),
and [modified-copy attribution](NOTICE) follow the source they cover. Contributions
retain those applicable terms; a rename does not convert upstream code to MIT.
Keep third-party notices and the retained upstream CLA intact.
