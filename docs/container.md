# Maintainer source-container recipe

This maintainer recipe packages **the local source checkout**, including the complete upstream harness, skill, shared runtime adapters and retained OMP extension. It does not clone a separate Cataly release. Public consumers should follow the [verified release installer and support guide](releases.md). This recipe's build and session checks are separate evidence, not a published or independently validated consumer image. The first public preview supports Linux x64/herdr/Discord; the retained hc/other-architecture recipe does not expand that live support scope.

The primary `cataly` command runs `skills/cataly-mode/scripts/src/cli.ts`. `cataly harness <args>` dispatches to the complete root CLI; `cataly-harness <args>` and `bun /opt/omp-cataly/src/cli.ts <args>` also reach it. The image never assigns the root CLI the primary `cataly` name.

## Files and build inputs

- `examples/container/Dockerfile`: Ubuntu 24.04, gh, Node, Bun, agent-messenger, OMP and the local candidate at `/opt/omp-cataly`. A terminal backend is optional.
- `examples/container/compose.yaml`: one service named `cataly`, default project `omp-cataly-candidate`, project-scoped named volumes and no fixed container name, published ports or host credential mounts. It idles with `sleep infinity`; no runtime server, OMP session, harness, messenger receiver or watcher starts automatically.
- `.dockerignore`: a source allowlist followed by exclusions for dependencies, nested Git metadata, env/auth files and operator state. Keep credentials and private data outside the source directories even when preparing a local build context.

Compose's build context is the candidate root (`../..` relative to the compose file), with `examples/container/Dockerfile` as its recipe. `COPY . /opt/omp-cataly` therefore includes the edited candidate, notices, prompts, tests, extension and full sibling layout. Root, skill and extension dependencies are installed with `--frozen-lockfile`; no host `node_modules` is copied. The source checkout's current bytes, including uncommitted port edits, are the image's Cataly input. There is no `CATALY_REF` clone or build argument.

| Input | Pinned value | Source of the pin |
|---|---|---|
| Base | `ubuntu:24.04` | Retained upstream recipe; glibc is required |
| Node | `24.21.0` | Retained per-architecture sha256 values in the Dockerfile |
| Bun | `1.4.4` | Candidate `package.json` and OMP package engine require at least 1.4.4; [public release asset digests](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4) |
| herdr (optional) | `0.9.5` | Retained upstream version and per-architecture sha256 values |
| hc (optional) | `0.1.18` | Retained upstream version and per-architecture sha256 values; release [manifest](https://releases.herdr.dev/core/0.1.18/manifest.json) |
| gh | `2.100.0` | Retained upstream version and per-architecture sha256 values |
| agent-messenger | `2.40.0` | [Published npm metadata](https://registry.npmjs.org/agent-messenger/2.40.0), Node >=22.13.0 |
| OMP | f40f3358 / 19.0.1 + `native-omp.patch` | Exact `native-omp.lock` upstream/result identity; frozen official `@oh-my-pi/pi-natives@19.0.1` addon, no Cargo |
| omp-ulw | `omp-ulw.lock` + `omp-ulw.patch` | Exact base plus `omp-ulw.overlay.lock` result; upstream Git tree/gitlinks retained |

Bun's new asset sha256 values are `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c` for `bun-linux-x64.zip` and `baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e` for `bun-linux-aarch64.zip`. These were read from the release metadata, not guessed or calculated from a substituted package. The other binary hashes are retained from upstream `97d807b`'s recipe; this port has not downloaded those assets or revalidated their bytes.

The current recipe does not install a stock OMP package globally. It prepares both source bundles as the non-root `cataly` user under `/home/cataly/.cache/omp-cataly` and links `omp` to the guarded source wrapper. The role-gated ULW import uses `/home/cataly/.cataly/omp-ulw`, which points to the bound cache. Rebuilding an image does not silently repair a custom or stale persistent-volume link; preserve that state and explicitly prepare/select the intended dependency. These are source contracts, not an observed image build or runtime pass.

The native source and official addon use their frozen dependency locks; agent-messenger still has an exact top-level npm version with transitive ranges. The Ubuntu tag and apt packages are not a complete reproducibility lock, so this is not a bit-for-bit reproducible-image claim. ULW remains separately fetched source with its own upstream notices, verified against the exact base and reviewed overlay identities rather than a clean-stock checkout alone.

## Build

From the candidate root, after the source verification/review gate:

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml build
```

The recipe selects `linux/amd64` or `linux/arm64` binary assets through `TARGETARCH`; actual builds on both architectures are still unrun. A native builder or configured cross-architecture builder/emulation is required. Change binary versions only together with their matching architecture hashes. Change OMP or messenger to actual published package versions and review their engine constraints. Rebuild to package new candidate bytes; no remote Cataly ref is involved.

### Optional terminal tooling

The default image has neither hc nor herdr. To build a terminal adapter variant for QA, replace `hc` with `herdr` if desired:

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml build --build-arg TERMINAL_BACKEND=hc
```

The hc release tarball is checked against `HC_SHA256_AMD64`/`HC_SHA256_ARM64`, installed as `herdr-core` with `hc` beside it, and configured with `notes = false` under `~/.config/herdr-core/config.toml`. Installing either binary does not change the execution default. For terminal sessions, set `sessionRuntime` to `hc` or `herdr` in Cataly's config, or set `CATALY_RUNTIME` for the command. An existing `runtime` key is only a preferred backend for terminal-specific operations.

For optional terminal QA, start the selected server yourself inside the container:

```sh
# hc image
hc server start
# herdr image (run these instead)
herdr integration install omp
nohup herdr server >/dev/null 2>&1 </dev/null &
```

The retained extension emits native OSC 7501 `app=omp` in hc role sessions: idle/working from agent lifecycle, blocked during approvals, and unknown when its owned role record is removed. HC unknown remains held and conditional `--if` gates remain intact. OMP 18.18.8 also has a [general OSC reporter](https://github.com/can1357/oh-my-pi/blob/v18.18.8/packages/coding-agent/src/utils/run-status.ts) for interactive TTY output when `terminal.programStatus` is enabled. A file record alone never replaces native status. See [runtime.md](runtime.md) for both adapters and delivery holds.

## First run

Use a fresh compose project and empty named volumes for candidate QA. Reusing a Cataly session and its `.omp`/`.cataly` volumes can restore that session's previously recorded monitors when the session is deliberately resumed.

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml up -d
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml exec cataly bash
```

Inside the container, credentials are supplied only through deliberate interactive setup and persist in volumes:

```sh
gh auth login
# When configuring a separate messenger identity for isolated intake/reply QA:
agent-messenger auth telegram
# Start omp interactively and use /login for the chosen model provider, then exit.
```

No token, provider credential or owner config is built into the image. Do not import production chat/session history for candidate smoke checks. Messenger auth and receiver/presence activation are separate: neither the image nor the installer starts a receiver or presence writer.

For fresh configuration, copy the example only when config is missing:

```sh
test -e ~/.cataly/config.json || cp /opt/omp-cataly/skills/cataly-mode/references/config.example.json ~/.cataly/config.json
```

Edit `defaultCwd`, model settings and hooks for this container. Only set `leadPane` or `laneWorkspace` for an applicable terminal workflow. Set messenger hooks only to the isolated QA destination when that QA stage starts. The image links the skill at `~/.agents/skills/cataly-mode`, the extension at `~/.omp/agent/extensions/omp-cataly`, and pinned omp-ulw at `~/.cataly/omp-ulw`. The extension's default `ompUlwPath` resolves through that link; an explicit config override remains the operator's choice.

This source-container layout keeps configured dependency paths unchanged. Verified consumer releases resolve their managed `~/.cataly/releases/consumer-dependencies/omp-ulw-<commit>` paths against the loaded source's own lock; explicit external paths remain user-owned. See [consumer installation layout](releases.md#installation-layout-and-preserved-data).

Clone work repositories into `~/projects`. From the desired project
directory, explicitly start the harness and check its runtime:

```sh
cataly harness up
cataly harness status
```

Follow skill onboarding in the lead before enabling messenger intake. For an
interactive lead on an explicitly selected terminal backend, use the guarded
`omp` wrapper with `--cataly-role cataly` rather than starting another lead
against the same state.

Expected source behavior: headless starts the lead, duty and loops without a terminal server. With an explicitly selected terminal backend, herdr opens lead/duty and two loop panes; hc opens four labelled terminals. Lead/duty run OMP role `cataly`; lanes and the built-in reviewer use `lane`. Skill lanes retain `defaultModel` and explicit `--model`/`agentCommand` overrides; the harness preserves `CATALY_AGENT_CMD` and OMP's model config. `up` itself starts real loops, so it is an isolated runtime QA step, not an image-start behavior.

For explicit terminal variants, attach through the selected runtime:

```sh
# herdr image
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml exec cataly herdr
# hc image: list labels, then pick a terminal (ctrl+\ detaches)
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml exec cataly hc ls
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml exec cataly hc
```

## State and restart

Named volumes are prefixed by the compose project, so a second `-p` value gets separate state. The former `.omo`/`omo-state` layout is replaced by OMP's own `.omp` volume; no old volume is removed or imported.

- `~/.cataly` (`cataly-state`): config, harness lanes/inbox/receipts/backlog/loops, skill state, process-bound session records, monitor mirrors and the link to immutable omp-ulw.
- `~/.omp` (`omp-state`): OMP config, provider auth, sessions and the extension link.
- `~/.config/gh` (`gh-auth`): GitHub auth.
- `~/.config/agent-messenger` (`messenger-auth`): messenger auth.
- `~/projects` (`projects`): repository checkouts and build artifacts.

The source, global packages and `.agents` skill link live in the image. Fresh named volumes inherit the prepared `cataly` ownership and extension/omp-ulw links; existing volumes keep their content on rebuild. Runtime processes and live approvals are not durable evidence of resumed work. After a restart inspect the selected runtime and run `cataly boot`; only recreate missing harness sessions with `cataly harness up`. Saved OMP sessions can be restored deliberately, retaining roles and recorded monitors. For a native goal restored paused, wait until the user explicitly directs resumption before using `/goal resume`, and confirm the resulting state.

`docker compose restart`, or `down` followed by `up -d` without volume removal, retains named data. Backup and recovery must include all five volumes and the exact candidate/image input. This source port has not exercised recovery or modified the existing source archives.

## Resources and limits

The compose default is 4 CPUs and 8 GB RAM. OMP lanes and their builds need developer-machine resources; size for lane concurrency. Give the Docker data root tens of gigabytes for projects, package caches and build artifacts. The recipe exposes no network ports and shares no host runtime socket. A VM with the same tools and isolated homes can use the same command/state layout without the container layer.

## Maintainer acceptance

Before any build or runtime activation, inspect the compose configuration:

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml config
```

Expected: the context resolves to this candidate, the Dockerfile is `examples/container/Dockerfile`, all five volumes are project-scoped, and there is no fixed `container_name`/host auth mount.

Build the default image and any terminal variants separately so they remain addressable:

```sh
docker build --platform linux/amd64 -f examples/container/Dockerfile -t omp-cataly-candidate:headless .
docker build --platform linux/amd64 -f examples/container/Dockerfile --build-arg TERMINAL_BACKEND=herdr -t omp-cataly-candidate:herdr .
docker build --platform linux/amd64 -f examples/container/Dockerfile --build-arg TERMINAL_BACKEND=hc -t omp-cataly-candidate:hc .
```

Use `--platform linux/arm64` and distinct image tags on an arm64-capable builder to exercise that architecture. A successful build must show verified binary checksums, frozen source-lock installs and the locked omp-ulw checkout. Build success alone does not prove OMP/runtime interaction.

For a network-disabled source/CLI smoke, run the following against the default
image. It starts no runtime server and leaves the stopped container available
for inspection.

```sh
docker run --name omp-cataly-source-smoke-headless --network none omp-cataly-candidate:headless /bin/sh -eu -c '
  cd /opt/omp-cataly
  if command -v hc || command -v herdr; then exit 1; fi
  bun --version
  omp --version
  cataly
  cataly harness --help
  cataly-harness --help
  bun src/cli.ts --help
  test -L /home/cataly/.omp/agent/extensions/omp-cataly
  test -L /home/cataly/.agents/skills/cataly-mode
  test "$(git -C /home/cataly/.cataly/omp-ulw rev-parse HEAD)" = "$(cat omp-ulw.lock)"
'
```

Expected for the current recipe: Bun 1.4.4+, OMP 19.0.1 from the bound source launcher, skill help including `harness`, complete root help through all three root entrypoints, existing extension/skill links and the lock-matching ULW base with its exact staged overlay. When checking an optional terminal variant, verify that only its selected binary is present instead. No assertion here is an observed pass or a binary-equivalence claim.

Session QA follows first-run setup with synthetic work, an isolated provider
identity and a separate messenger thread/session: inspect role/session records,
active/paused goal readback, approval-held delivery, monitor restoration, the
two harness roles and their two loops, a restart and volume persistence.
Observe an actual intake and reply before claiming messenger compatibility.
These checks do not authorize a production cutover or watcher activation.
